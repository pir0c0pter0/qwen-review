#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { loadState, getConfig, setConfig } from "./lib/config.mjs";
import { callQwen } from "./lib/qwen-client.mjs";
import { loadTemplate, interpolate, truncate } from "./lib/prompt.mjs";
import { redactSecrets, shouldSkipFile, isBinary } from "./lib/redactor.mjs";
import { loadSettings, writeSettingsAtomic } from "./lib/settings.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

// --- Git helpers (mirror of stop-review-hook.mjs; v0.2 should extract to lib/git.mjs) ---

function untrackedFiles(cwd) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function trackedChangedFiles(cwd) {
  try {
    return execFileSync("git", ["diff", "HEAD", "--name-only", "--diff-filter=ACMRT"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function trackedDiffForFile(cwd, file) {
  try {
    return execFileSync("git", ["diff", "HEAD", "--no-color", "--", file], {
      cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch { return ""; }
}

function syntheticDiffForUntracked(cwd, file) {
  try {
    return execFileSync("git", ["diff", "--no-index", "--no-color", "/dev/null", file], {
      cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (err) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

function unsafeFileNote(file, stat) {
  if (stat.isSymbolicLink()) return "symlink target may be outside repo";
  if (!stat.isFile()) return "not a regular file";
  if (stat.nlink > 1) return "hardlink may point outside repo";
  return null;
}

function gitDiff(cwd, extraGlobs = []) {
  const parts = [];
  for (const file of trackedChangedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\n[diff excluded: sensitive path]`);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(path.join(cwd, file)); } catch { continue; }
    const reason = unsafeFileNote(file, stat);
    if (reason) {
      parts.push(`diff --git a/${file} b/${file}\n[diff excluded: ${reason}]`);
      continue;
    }
    const d = trackedDiffForFile(cwd, file);
    if (d) parts.push(d);
  }
  for (const file of untrackedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\nnew file\n[diff excluded: sensitive path]`);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(path.join(cwd, file)); } catch { continue; }
    const reason = unsafeFileNote(file, stat);
    if (reason) {
      parts.push(`diff --git a/${file} b/${file}\n[diff excluded: ${reason}]`);
      continue;
    }
    const d = syntheticDiffForUntracked(cwd, file);
    if (d) parts.push(d);
  }
  return parts.filter(Boolean).join("\n");
}

function changedFiles(cwd) {
  return [...trackedChangedFiles(cwd), ...untrackedFiles(cwd)];
}

// --- CLI helpers ---

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 6) return "•••";
  return `${key.slice(0, 3)}•••${key.slice(-3)}`;
}

function readEnv() {
  return {
    apiKey: process.env.QWEN_API_KEY || null,
    baseUrl:
      process.env.QWEN_BASE_URL ||
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL || "qwen3-max",
    mode: (() => {
      const m = (process.env.QWEN_REVIEW_MODE || "").toLowerCase();
      return (m === "thinking" || m === "deep") ? "thinking" : "fast";
    })()
  };
}

async function pingQwen(env) {
  const started = Date.now();
  try {
    await callQwen({
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      model: env.model,
      prompt: "ok",
      overrides: { maxTokens: 1, timeoutMs: 15_000 }
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err.message || String(err) };
  }
}

function parseModeArg(args) {
  // Accepts: --mode=fast | --mode=thinking | --mode=deep
  //          --fast | --thinking
  for (const a of args) {
    if (a === "--fast") return "fast";
    if (a === "--thinking" || a === "--deep") return "thinking";
    if (a.startsWith("--mode=")) {
      const v = a.slice("--mode=".length).toLowerCase();
      if (v === "fast") return "fast";
      if (v === "thinking" || v === "deep") return "thinking";
      return null; // invalid value
    }
  }
  return undefined; // not specified
}

async function cmdSetup(args) {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const env = readEnv();
  const actions = [];

  // ---- Validate ALL flags BEFORE any state mutation ----
  // (Previously: --enable wrote state before --mode=bogus rejected the call,
  // leaving the gate enabled despite the visible error and exit 2.)

  const wantsEnable = args.includes("--enable");
  const wantsDisable = args.includes("--disable");
  if (wantsEnable && wantsDisable) {
    process.stderr.write("qwen-review: --enable and --disable are mutually exclusive\n");
    process.exit(2);
  }

  const requestedMode = parseModeArg(args);
  if (requestedMode === null) {
    process.stderr.write("qwen-review: invalid --mode value (use fast or thinking)\n");
    process.exit(2);
  }

  // ---- All flags valid — now safe to mutate ----

  const currentConfig = getConfig(workspaceRoot);
  let nextGate = currentConfig.stopReviewGate;
  if (wantsEnable) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    nextGate = true;
    actions.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (wantsDisable) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    nextGate = false;
    actions.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (requestedMode) {
    setConfig(workspaceRoot, "mode", requestedMode);
    actions.push(`Set workspace mode to '${requestedMode}'.`);
  }

  // Reload config after possible setConfig so we resolve from current state
  const resolved = resolveEffectiveMode(
    requestedMode ? { ...currentConfig, mode: requestedMode } : currentConfig,
    env.mode
  );

  const envOk = !!env.apiKey;
  const ping = envOk ? await pingQwen(env) : { ok: false, error: "QWEN_API_KEY not set" };

  const output = {
    ready: envOk && ping.ok,
    envOk,
    apiKey: maskKey(env.apiKey),
    baseUrl: env.baseUrl,
    model: env.model,
    mode: resolved.mode,
    modeSource: resolved.source,
    reviewGateEnabled: nextGate,
    ping,
    actionsTaken: actions
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function resolveEffectiveMode(workspaceConfig, envMode) {
  // Workspace state.config.mode beats env QWEN_REVIEW_MODE.
  if (workspaceConfig.mode === "fast" || workspaceConfig.mode === "thinking") {
    return { mode: workspaceConfig.mode, source: "workspace" };
  }
  return { mode: envMode, source: "env" };
}

function cmdStatus() {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const env = readEnv();
  const state = loadState(workspaceRoot);
  const resolved = resolveEffectiveMode(state.config, env.mode);
  const output = {
    workspaceRoot,
    envOk: !!env.apiKey,
    apiKey: maskKey(env.apiKey),
    baseUrl: env.baseUrl,
    model: env.model,
    mode: resolved.mode,
    modeSource: resolved.source,
    reviewGateEnabled: state.config.stopReviewGate,
    lastReview: state.lastReview
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function buildCheckPrompt({ cwd, diffOnly, extraGlobs = [] }) {
  const diff = gitDiff(cwd, extraGlobs);
  const files = changedFiles(cwd);

  const blocks = [];
  for (const file of files.slice(0, 5)) {
    if (shouldSkipFile(file, extraGlobs)) { blocks.push(`=== ${file} ===\n[file excluded: sensitive path]`); continue; }
    const fullPath = path.join(cwd, file);
    let stat;
    try { stat = fs.lstatSync(fullPath); } catch { continue; }
    if (stat.isSymbolicLink()) { blocks.push(`=== ${file} ===\n[file excluded: symlink]`); continue; }
    if (!stat.isFile()) { blocks.push(`=== ${file} ===\n[file excluded: not a regular file]`); continue; }
    if (stat.nlink > 1) { blocks.push(`=== ${file} ===\n[file excluded: hardlink]`); continue; }
    let buf;
    try { buf = fs.readFileSync(fullPath); } catch { continue; }
    if (isBinary(buf)) { blocks.push(`=== ${file} ===\n[file excluded: binary]`); continue; }
    let c = buf.toString("utf8");
    c = redactSecrets(c);
    if (c.length > 4000) c = c.slice(0, 4000) + "\n[truncated]";
    blocks.push(`=== ${file} ===\n${c}`);
  }

  const vars = {
    LAST_ASSISTANT: diffOnly ? "" : "(manual /qwen-review:check invocation)",
    GIT_DIFF: redactSecrets(truncate(diff, 12000)),
    CHANGED_FILES_CONTENT: blocks.join("\n\n")
  };
  return interpolate(loadTemplate(ROOT_DIR, "stop-review"), vars);
}

async function cmdCheck(args) {
  const env = readEnv();
  if (!env.apiKey) {
    process.stderr.write("qwen-review: QWEN_API_KEY not set\n");
    process.exit(2);
  }
  const cwd = resolveWorkspaceRoot(process.cwd());
  const diffOnly = args.includes("--diff-only");
  const extraGlobs = (process.env.QWEN_REVIEW_EXCLUDE_GLOBS || "")
    .split(":")
    .filter(Boolean);
  const prompt = buildCheckPrompt({ cwd, diffOnly, extraGlobs });
  const result = await callQwen({
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.model,
    prompt,
    mode: env.mode
  });
  process.stdout.write(result.content + "\n");
}

// --- Wizard (interactive config) ---

const BASE_URL_PRESETS = [
  { label: "DashScope International", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { label: "DashScope China",         url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { label: "OpenRouter",              url: "https://openrouter.ai/api/v1" }
];

async function cmdWizard() {
  const settings = loadSettings();
  const currentEnv = settings.data.env ?? {};

  const rl = readline.createInterface({ input, output });
  const ask = async (label, def) => {
    const suffix = def !== undefined && def !== "" ? ` [${def}]` : "";
    const ans = (await rl.question(`${label}${suffix}: `)).trim();
    return ans || def || "";
  };

  output.write("\n");
  output.write("qwen-review setup wizard\n");
  output.write("────────────────────────\n");
  output.write(`Reading current config from ${settings.path}\n\n`);

  // 1. API key
  const currentKey = currentEnv.QWEN_API_KEY ?? "";
  output.write(`Current API key: ${currentKey ? maskKey(currentKey) : "(not set)"}\n`);
  const newKeyRaw = await ask("New API key (blank to keep current)", "");
  const newKey = newKeyRaw || currentKey;

  // 2. Base URL preset
  output.write("\nBase URL options:\n");
  BASE_URL_PRESETS.forEach((p, i) => output.write(`  ${i + 1}) ${p.label} — ${p.url}\n`));
  output.write(`  ${BASE_URL_PRESETS.length + 1}) Custom (enter manually)\n`);
  const defChoice = (() => {
    const idx = BASE_URL_PRESETS.findIndex((p) => p.url === currentEnv.QWEN_BASE_URL);
    return idx >= 0 ? String(idx + 1) : "1";
  })();
  const baseChoice = await ask(`Choose 1-${BASE_URL_PRESETS.length + 1}`, defChoice);
  let newBaseUrl;
  const idx = parseInt(baseChoice, 10) - 1;
  if (idx >= 0 && idx < BASE_URL_PRESETS.length) {
    newBaseUrl = BASE_URL_PRESETS[idx].url;
  } else {
    newBaseUrl = await ask("Custom base URL", currentEnv.QWEN_BASE_URL ?? "");
  }

  // 3. Model
  const newModel = await ask("\nModel", currentEnv.QWEN_MODEL ?? "qwen3-max");

  // 4. Mode
  output.write("\nReview mode:\n");
  output.write("  fast — 1024 tokens, ~3-15s, sem thinking (default — recomendado pro dia-a-dia)\n");
  output.write("  thinking — 8192 tokens, ~60-180s, enable_thinking=true (review profundo)\n");
  const currentMode = (() => {
    const m = (currentEnv.QWEN_REVIEW_MODE || "").toLowerCase();
    return (m === "thinking" || m === "deep") ? "thinking" : "fast";
  })();
  let newMode = (await ask("Mode (fast|thinking)", currentMode)).toLowerCase();
  if (newMode === "deep") newMode = "thinking";
  if (newMode !== "fast" && newMode !== "thinking") {
    output.write(`(invalid '${newMode}', defaulting to fast)\n`);
    newMode = "fast";
  }

  rl.close();

  // Summary
  output.write("\n────────────────────────\nWill write to env:\n");
  output.write(`  QWEN_API_KEY      = ${newKey ? maskKey(newKey) : "(empty)"}\n`);
  output.write(`  QWEN_BASE_URL     = ${newBaseUrl}\n`);
  output.write(`  QWEN_MODEL        = ${newModel}\n`);
  output.write(`  QWEN_REVIEW_MODE  = ${newMode}\n`);
  output.write(`Target: ${settings.path}\n\n`);

  const rl2 = readline.createInterface({ input, output });
  const confirm = (await rl2.question("Write these values? [y/N] ")).trim().toLowerCase();
  rl2.close();
  if (confirm !== "y" && confirm !== "yes") {
    output.write("Aborted, nothing written.\n");
    return;
  }

  // Atomic merge into settings.env, preserving everything else AND existing perms
  settings.data.env = {
    ...currentEnv,
    QWEN_API_KEY: newKey,
    QWEN_BASE_URL: newBaseUrl,
    QWEN_MODEL: newModel,
    QWEN_REVIEW_MODE: newMode
  };
  const written = writeSettingsAtomic(settings.path, settings.data);

  output.write(`\n✓ Saved (mode ${written.mode.toString(8)}).\n\n`);
  output.write("Next steps:\n");
  output.write("  1) /reload-plugins  (or restart Claude Code if marketplace was just added)\n");
  output.write("  2) /qwen-review:setup --enable  (per-workspace, ativa o stop gate)\n");
  output.write("  3) /qwen-review:status  (confirma config + ping API)\n");
}

function parseFlagValue(args, name) {
  // Accepts --name=VALUE or --name VALUE
  const eq = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(eq)) return a.slice(eq.length);
    if (a === `--${name}` && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function cmdApplyConfig(args) {
  // Non-interactive wizard target. Designed for Claude Code to invoke after
  // gathering values via AskUserQuestion — no readline, no TTY needed.
  // Required flags: --api-key, --base-url, --model, --mode
  // Optional: --keep-key  (preserves existing key when --api-key not passed)
  const apiKey = parseFlagValue(args, "api-key");
  const baseUrl = parseFlagValue(args, "base-url");
  const model = parseFlagValue(args, "model");
  let mode = parseFlagValue(args, "mode");
  const keepKey = args.includes("--keep-key");

  const missing = [];
  if (!baseUrl) missing.push("--base-url");
  if (!model) missing.push("--model");
  if (!mode) missing.push("--mode");
  if (!apiKey && !keepKey) missing.push("--api-key (or --keep-key to keep current)");
  if (missing.length) {
    process.stderr.write(
      `qwen-review apply-config: missing required ${missing.join(", ")}\n` +
      `usage: qwen-review apply-config --api-key=K --base-url=URL --model=NAME --mode=fast|thinking\n` +
      `       (use --keep-key instead of --api-key to keep the existing value)\n`
    );
    process.exit(2);
  }

  mode = mode.toLowerCase();
  if (mode === "deep") mode = "thinking";
  if (mode !== "fast" && mode !== "thinking") {
    process.stderr.write(`qwen-review apply-config: invalid --mode '${mode}' (use fast or thinking)\n`);
    process.exit(2);
  }

  const settings = loadSettings();
  const currentEnv = settings.data.env ?? {};
  const finalKey = apiKey || currentEnv.QWEN_API_KEY || "";
  if (!finalKey) {
    process.stderr.write(`qwen-review apply-config: --keep-key passed but no existing QWEN_API_KEY in ${settings.path}\n`);
    process.exit(2);
  }

  settings.data.env = {
    ...currentEnv,
    QWEN_API_KEY: finalKey,
    QWEN_BASE_URL: baseUrl,
    QWEN_MODEL: model,
    QWEN_REVIEW_MODE: mode
  };
  const written = writeSettingsAtomic(settings.path, settings.data);

  process.stdout.write(JSON.stringify({
    ok: true,
    written: written.path,
    mode: written.mode.toString(8),
    env: {
      QWEN_API_KEY: maskKey(finalKey),
      QWEN_BASE_URL: baseUrl,
      QWEN_MODEL: model,
      QWEN_REVIEW_MODE: mode
    },
    nextSteps: [
      "/reload-plugins",
      "/qwen-review:setup --enable",
      "/qwen-review:status"
    ]
  }, null, 2) + "\n");
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case "setup":
      await cmdSetup(rest);
      break;
    case "status":
      cmdStatus();
      break;
    case "check":
      await cmdCheck(rest);
      break;
    case "wizard":
      await cmdWizard();
      break;
    case "apply-config":
      cmdApplyConfig(rest);
      break;
    default:
      process.stderr.write(`usage: qwen-review <setup|status|check|wizard|apply-config> [args]\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`qwen-review: ${err.message || err}\n`);
  process.exit(1);
});
