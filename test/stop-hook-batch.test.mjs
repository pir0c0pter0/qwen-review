import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";
import { runHook, ALLOW_RESPONSE, ROOT_DIR } from "./helpers/run-hook.mjs";

// --- Multi-batch (map-reduce) scenarios ---

function makeMultiBatchRepo(repo) {
  // Two untracked files big enough that both never fit in a 4000-char call
  // budget, forcing exactly 2 batches (maxCalls default 3).
  const filler = "// filler filler filler\n".repeat(100);
  fs.writeFileSync(path.join(repo, "a.js"), filler);
  fs.writeFileSync(path.join(repo, "b.js"), filler);
}

test("multi-batch: BLOCK in any chunk wins (ALLOW then BLOCK)", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    makeMultiBatchRepo(repo);
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        QWEN_REVIEW_CALL_BUDGET_CHARS: "4000",
        CAPTURE_FILE: captureFile
      },
      input: { cwd: repo, last_assistant_message: "added a.js and b.js", session_id: "s" },
      mockResponses: [
        ALLOW_RESPONSE,
        { status: 200, body: { choices: [{ message: { content: "BLOCK: bug grave em b.js:1" } }] } }
      ]
    });
    assert.equal(r.status, 0);
    const decision = JSON.parse(r.stdout.trim());
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /bug grave em b\.js:1/);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(captured.length, 2, "should make exactly 2 sequential calls");
    const firstPrompt = JSON.parse(captured[0].opts.body).messages[0].content;
    const secondPrompt = JSON.parse(captured[1].opts.body).messages[0].content;
    assert.match(firstPrompt, /Parte 1\/2 deste review/);
    assert.match(firstPrompt, /a\.js/);
    assert.match(secondPrompt, /Parte 2\/2 deste review/);
    assert.match(secondPrompt, /b\.js/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});

test("multi-batch: all chunks ALLOW → no block, N calls made", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    makeMultiBatchRepo(repo);
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        QWEN_REVIEW_CALL_BUDGET_CHARS: "4000",
        CAPTURE_FILE: captureFile
      },
      input: { cwd: repo, last_assistant_message: "added a.js and b.js", session_id: "s" },
      mockResponses: [ALLOW_RESPONSE, ALLOW_RESPONSE]
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(captured.length, 2, "should make exactly 2 sequential calls");
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});

test("multi-batch: API error on a chunk fails open and aborts remaining calls", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    makeMultiBatchRepo(repo);
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        QWEN_REVIEW_CALL_BUDGET_CHARS: "4000",
        CAPTURE_FILE: captureFile
      },
      input: { cwd: repo, last_assistant_message: "added a.js and b.js", session_id: "s" },
      mockResponses: [{ status: 503, body: "upstream down" }]
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /503/);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.equal(captured.length, 1, "should abort after the failing chunk");
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});
