#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { getConfig, saveLastReview } from "./lib/config.mjs";
import { loadTemplate, interpolate, truncate } from "./lib/prompt.mjs";
import { redactSecrets } from "./lib/redactor.mjs";
import { callQwen } from "./lib/qwen-client.mjs";
import { collectChangedItems, contentBlockForItem } from "./lib/git.mjs";
import { packBatches } from "./lib/batch.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

const LAST_ASSISTANT_HEAD = 4_000;
const LAST_ASSISTANT_TAIL = 4_000;
const REASON_CAP = 500;

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

function joinReasons(reasons) {
  const joined = reasons.filter(Boolean).join("; ");
  return joined.length > REASON_CAP ? joined.slice(0, REASON_CAP) + "…" : joined;
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
    mode: (() => {
      const m = (process.env.QWEN_REVIEW_MODE || "").toLowerCase();
      return (m === "thinking" || m === "deep") ? "thinking" : "fast";
    })(),
    callBudgetChars: Number(process.env.QWEN_REVIEW_CALL_BUDGET_CHARS) || 100_000,
    maxCalls: Number(process.env.QWEN_REVIEW_MAX_CALLS) || 3,
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

  // Per-workspace mode override beats QWEN_REVIEW_MODE env
  if (cfg.mode === "fast" || cfg.mode === "thinking") {
    env.mode = cfg.mode;
  }

  const lastAssistant = String(input.last_assistant_message ?? "");

  // Itens por arquivo: diff + bloco de conteúdo, ambos redigidos quando
  // redactEnabled. Marcadores de exclusão (sensitive/symlink/hardlink/binary)
  // vêm prontos de lib/git.mjs.
  const items = collectChangedItems(workspaceRoot, env.extraGlobs).map((it) => ({
    file: it.file,
    diffText: env.redactEnabled ? redactSecrets(it.diffText) : it.diffText,
    contentBlock:
      contentBlockForItem(workspaceRoot, it, { redactEnabled: env.redactEnabled }) ?? ""
  }));

  const hasDiff = items.some((it) => it.diffText.trim());
  if (!lastAssistant.trim() && !hasDiff) return;

  const truncatedLast = truncate(lastAssistant, LAST_ASSISTANT_HEAD, LAST_ASSISTANT_TAIL);
  const lastVar = env.redactEnabled ? redactSecrets(truncatedLast) : truncatedLast;

  const { batches, omittedFiles } = packBatches(items, {
    callBudgetChars: env.callBudgetChars,
    maxCalls: env.maxCalls
  });

  // Sem mudanças → mantém uma chamada única com diff/conteúdo vazios (paridade).
  const effective = batches.length === 0 ? [[]] : batches;

  const template = loadTemplate(ROOT_DIR, "stop-review");
  const nBatches = effective.length;
  const totals = { latencyMs: 0, promptTokens: 0, completionTokens: 0 };
  const allowReasons = [];
  const blockReasons = [];
  let parsedAny = false;
  const debugChunks = [];

  for (let i = 0; i < nBatches; i++) {
    const batch = effective[i];
    let filesContent = batch.map((it) => it.contentBlock).filter(Boolean).join("\n\n");
    if (i === nBatches - 1 && omittedFiles.length > 0) {
      filesContent += `\n\n[${omittedFiles.length} arquivos adicionais omitidos]`;
    }
    const vars = {
      LAST_ASSISTANT: lastVar,
      GIT_DIFF: batch.map((it) => it.diffText).filter(Boolean).join("\n"),
      CHANGED_FILES_CONTENT: filesContent,
      PART_NOTE: nBatches === 1
        ? ""
        : `Parte ${i + 1}/${nBatches} deste review. Arquivos neste lote: ${batch.map((it) => it.file).join(", ")}`
    };
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
      // Fail-open em erro de infra: aborta as chamadas restantes, sem block.
      logNote(`API error: ${err.message || err}`);
      return;
    }

    debugChunks.push(`=== prompt (${i + 1}/${nBatches}) ===\n${prompt}\n\n=== response ===\n${result.content}\n`);
    totals.latencyMs += result.latencyMs;
    totals.promptTokens += result.usage.prompt_tokens ?? 0;
    totals.completionTokens += result.usage.completion_tokens ?? 0;

    const decision = parseDecision(result.content);
    if (!decision) {
      logNote(`unexpected response shape (parte ${i + 1}/${nBatches}); lote ignorado.`);
      continue;
    }
    parsedAny = true;
    (decision.allow ? allowReasons : blockReasons).push(decision.reason);
  }

  if (process.env.QWEN_REVIEW_DEBUG === "1") {
    fs.writeFileSync(
      path.join(workspaceRoot, ".qwen-review-debug.log"),
      debugChunks.join("\n"),
      "utf8"
    );
  }

  if (!parsedAny) {
    logNote("unexpected response shape; gate skipped.");
    return;
  }

  const blocked = blockReasons.length > 0;
  const reason = joinReasons(blocked ? blockReasons : allowReasons);

  try {
    saveLastReview(workspaceRoot, {
      ts: new Date().toISOString(),
      decision: blocked ? "block" : "allow",
      reason,
      model: env.model,
      mode: env.mode,
      calls: nBatches,
      latencyMs: totals.latencyMs,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens
    });
  } catch (err) {
    logNote(`could not persist lastReview: ${err.message || err}`);
  }

  if (blocked) {
    emitBlock(`Qwen review found issues: ${reason}`);
  }
}

main().catch((err) => {
  process.stderr.write(`qwen-review: ${err.message || err}\n`);
  process.exit(0);
});
