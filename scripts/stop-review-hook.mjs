#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { getConfig, saveLastReview } from "./lib/config.mjs";
import { loadTemplate, interpolate, truncate } from "./lib/prompt.mjs";
import { redactSecrets, shouldSkipFile, isBinary } from "./lib/redactor.mjs";
import { callQwen } from "./lib/qwen-client.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

const TOTAL_FILES_CAP = 16_000;
const PER_FILE_CAP = 4_000;
const LAST_ASSISTANT_HEAD = 4_000;
const LAST_ASSISTANT_TAIL = 4_000;
const DIFF_HEAD = 12_000;

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function logNote(msg) {
  if (msg) process.stderr.write(`qwen-review: ${msg}\n`);
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

function untrackedFiles(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function trackedChangedFiles(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "HEAD", "--name-only", "--diff-filter=ACMRT"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function trackedDiffForFile(cwd, file) {
  try {
    return execFileSync(
      "git",
      ["diff", "HEAD", "--no-color", "--", file],
      { cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return "";
  }
}

function syntheticDiffForUntracked(cwd, file) {
  try {
    return execFileSync(
      "git",
      ["diff", "--no-index", "--no-color", "/dev/null", file],
      { cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"] }
    );
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
    const d = syntheticDiffForUntracked(cwd, file);
    if (d) parts.push(d);
  }
  return parts.filter(Boolean).join("\n");
}

function changedFiles(cwd) {
  return [...trackedChangedFiles(cwd), ...untrackedFiles(cwd)];
}

function buildChangedFilesContent(cwd, { redactEnabled, extraGlobs, maxFiles }) {
  const files = changedFiles(cwd);
  if (files.length === 0) return "";

  const blocks = [];
  let count = 0;
  let totalChars = 0;
  let omitted = 0;

  for (const file of files) {
    if (count >= maxFiles) { omitted = files.length - count; break; }

    if (shouldSkipFile(file, extraGlobs)) {
      blocks.push(`=== ${file} ===\n[file excluded: sensitive path]`);
      count++;
      continue;
    }

    let buf;
    try {
      buf = fs.readFileSync(path.join(cwd, file));
    } catch {
      continue;
    }

    if (isBinary(buf)) {
      blocks.push(`=== ${file} ===\n[file excluded: binary]`);
      count++;
      continue;
    }

    let content = buf.toString("utf8");
    if (redactEnabled) content = redactSecrets(content);
    if (content.length > PER_FILE_CAP) {
      content = content.slice(0, PER_FILE_CAP) + "\n[truncated]";
    }
    const block = `=== ${file} ===\n${content}`;
    if (totalChars + block.length > TOTAL_FILES_CAP) {
      omitted = files.length - count;
      break;
    }
    blocks.push(block);
    totalChars += block.length;
    count++;
  }

  let out = blocks.join("\n\n");
  if (omitted > 0) out += `\n\n[${omitted} arquivos adicionais omitidos]`;
  return out;
}

function parseDecision(text) {
  const first = String(text ?? "").split(/\r?\n/, 1)[0].trim();
  if (first.startsWith("ALLOW:")) {
    return { allow: true, reason: first.slice("ALLOW:".length).trim() };
  }
  if (first.startsWith("BLOCK:")) {
    return { allow: false, reason: first.slice("BLOCK:".length).trim() };
  }
  return null;
}

function readEnvConfig() {
  const overrides = {};
  if (process.env.QWEN_REVIEW_MAX_TOKENS) {
    overrides.maxTokens = Number(process.env.QWEN_REVIEW_MAX_TOKENS);
  }
  if (process.env.QWEN_REVIEW_TIMEOUT_MS) {
    overrides.timeoutMs = Number(process.env.QWEN_REVIEW_TIMEOUT_MS);
  }
  return {
    apiKey: process.env.QWEN_API_KEY,
    baseUrl:
      process.env.QWEN_BASE_URL ||
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: process.env.QWEN_MODEL || "qwen3-max",
    mode: process.env.QWEN_REVIEW_MODE === "deep" ? "deep" : "fast",
    maxFiles: Number(process.env.QWEN_REVIEW_MAX_FILES) || 5,
    redactEnabled: process.env.QWEN_REVIEW_REDACT_SECRETS !== "0",
    extraGlobs: (process.env.QWEN_REVIEW_EXCLUDE_GLOBS || "")
      .split(":")
      .filter(Boolean),
    overrides
  };
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const cfg = getConfig(workspaceRoot);

  if (!cfg.stopReviewGate) return;

  const env = readEnvConfig();
  if (!env.apiKey) {
    logNote("QWEN_API_KEY not set; gate skipped. Run /qwen-review:setup.");
    return;
  }

  const lastAssistant = String(input.last_assistant_message ?? "");
  const diff = gitDiff(workspaceRoot, env.extraGlobs);
  if (!lastAssistant.trim() && !diff.trim()) return;

  const truncatedLast = truncate(lastAssistant, LAST_ASSISTANT_HEAD, LAST_ASSISTANT_TAIL);
  const truncatedDiff = truncate(diff, DIFF_HEAD);
  const filesContent = buildChangedFilesContent(workspaceRoot, env);

  const vars = {
    LAST_ASSISTANT: env.redactEnabled ? redactSecrets(truncatedLast) : truncatedLast,
    GIT_DIFF: env.redactEnabled ? redactSecrets(truncatedDiff) : truncatedDiff,
    CHANGED_FILES_CONTENT: filesContent
  };

  const template = loadTemplate(ROOT_DIR, "stop-review");
  const prompt = interpolate(template, vars);

  let result;
  try {
    result = await callQwen({
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      model: env.model,
      prompt,
      mode: env.mode,
      overrides: env.overrides
    });
  } catch (err) {
    logNote(`API error: ${err.message || err}`);
    return;
  }

  if (process.env.QWEN_REVIEW_DEBUG === "1") {
    fs.writeFileSync(
      path.join(workspaceRoot, ".qwen-review-debug.log"),
      `=== prompt ===\n${prompt}\n\n=== response ===\n${result.content}\n`,
      "utf8"
    );
  }

  const decision = parseDecision(result.content);
  if (!decision) {
    logNote("unexpected response shape; gate skipped.");
    return;
  }

  try {
    saveLastReview(workspaceRoot, {
      ts: new Date().toISOString(),
      decision: decision.allow ? "allow" : "block",
      reason: decision.reason,
      model: env.model,
      mode: env.mode,
      latencyMs: result.latencyMs,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens
    });
  } catch (err) {
    logNote(`could not persist lastReview: ${err.message || err}`);
  }

  if (!decision.allow) {
    emitBlock(`Qwen review found issues: ${decision.reason}`);
  }
}

main().catch((err) => {
  process.stderr.write(`qwen-review: ${err.message || err}\n`);
  process.exit(0);
});
