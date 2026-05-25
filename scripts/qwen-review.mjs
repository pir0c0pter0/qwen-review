#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { loadState, getConfig, setConfig } from "./lib/config.mjs";
import { callQwen } from "./lib/qwen-client.mjs";
import { loadTemplate, interpolate, truncate } from "./lib/prompt.mjs";
import { redactSecrets, shouldSkipFile, isBinary } from "./lib/redactor.mjs";

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

function gitDiff(cwd, extraGlobs = []) {
  const parts = [];
  for (const file of trackedChangedFiles(cwd)) {
    if (shouldSkipFile(file, extraGlobs)) {
      parts.push(`diff --git a/${file} b/${file}\n[diff excluded: sensitive path]`);
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
    try {
      stat = fs.lstatSync(path.join(cwd, file));
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      parts.push(`diff --git a/${file} b/${file}\nnew symlink\n[diff excluded: symlink target may be outside repo]`);
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
    mode: process.env.QWEN_REVIEW_MODE === "deep" ? "deep" : "fast"
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

async function cmdSetup(args) {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const env = readEnv();
  const actions = [];

  let nextGate = getConfig(workspaceRoot).stopReviewGate;
  if (args.includes("--enable")) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    nextGate = true;
    actions.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (args.includes("--disable")) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    nextGate = false;
    actions.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const envOk = !!env.apiKey;
  const ping = envOk ? await pingQwen(env) : { ok: false, error: "QWEN_API_KEY not set" };

  const output = {
    ready: envOk && ping.ok,
    envOk,
    apiKey: maskKey(env.apiKey),
    baseUrl: env.baseUrl,
    model: env.model,
    mode: env.mode,
    reviewGateEnabled: nextGate,
    ping,
    actionsTaken: actions
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

function cmdStatus() {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  const env = readEnv();
  const state = loadState(workspaceRoot);
  const output = {
    workspaceRoot,
    envOk: !!env.apiKey,
    apiKey: maskKey(env.apiKey),
    baseUrl: env.baseUrl,
    model: env.model,
    mode: env.mode,
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
    default:
      process.stderr.write(`usage: qwen-review <setup|status|check> [args]\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`qwen-review: ${err.message || err}\n`);
  process.exit(1);
});
