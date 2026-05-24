import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT_DIR, "scripts", "stop-review-hook.mjs");

function runHook({ cwd, input = {}, env = {}, mockResponse }) {
  const preload = path.join(ROOT_DIR, "test", "helpers", "mock-fetch-preload.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", preload, HOOK],
    {
      cwd,
      input: JSON.stringify(input),
      env: {
        ...process.env,
        ...env,
        MOCK_RESPONSE: mockResponse ? JSON.stringify(mockResponse) : ""
      },
      encoding: "utf8"
    }
  );
  return result;
}

test("hook is silent when gate is off", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "x" },
      input: { cwd: repo, last_assistant_message: "hi", session_id: "s" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook skips with stderr note when QWEN_API_KEY missing", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "" },
      input: { cwd: repo, last_assistant_message: "hi", session_id: "s" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /QWEN_API_KEY not set/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook emits block when Qwen returns BLOCK:", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "x.js"), "function f() { return undefiend; }\n");
    execSync("git add x.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: {
        cwd: repo,
        last_assistant_message: "added function f",
        session_id: "s"
      },
      mockResponse: {
        status: 200,
        body: {
          choices: [{ message: { content: "BLOCK: typo undefiend in x.js:1" } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 }
        }
      }
    });
    assert.equal(r.status, 0);
    const decision = JSON.parse(r.stdout.trim());
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /typo undefiend/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook is silent when Qwen returns ALLOW:", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "y.js"), "export const x = 1;\n");
    execSync("git add y.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "trivial change", session_id: "s" },
      mockResponse: {
        status: 200,
        body: { choices: [{ message: { content: "ALLOW: trivial" } }] }
      }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook fails open on HTTP 500", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "z.js"), "x\n");
    execSync("git add z.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "y", session_id: "s" },
      mockResponse: { status: 503, body: "upstream down" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /503/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook fails open on response with no ALLOW/BLOCK prefix", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "q.js"), "x\n");
    execSync("git add q.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "y", session_id: "s" },
      mockResponse: {
        status: 200,
        body: { choices: [{ message: { content: "I think this is fine" } }] }
      }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
    assert.match(r.stderr, /unexpected response shape/);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook skips API call when assistant message and diff are both empty", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    const r = runHook({
      cwd: repo,
      env: { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "sk-test" },
      input: { cwd: repo, last_assistant_message: "", session_id: "s" }
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("hook redacts sk- key in last_assistant_message before sending", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "f.js"), "x\n");
    execSync("git add f.js", { cwd: repo });
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        CAPTURE_FILE: captureFile
      },
      input: {
        cwd: repo,
        last_assistant_message: "I used sk-abcdefghij1234567890abcdefghij1234 for auth",
        session_id: "s"
      },
      mockResponse: {
        status: 200,
        body: { choices: [{ message: { content: "ALLOW: ok" } }] }
      }
    });
    assert.equal(r.status, 0);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const body = JSON.parse(captured.opts.body);
    const sent = body.messages[0].content;
    assert.match(sent, /\[REDACTED:openai-or-qwen-key\]/);
    assert.doesNotMatch(sent, /sk-abcdefghij/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});

test("hook reviews UNTRACKED new files (not shortcut-skipped, included in prompt)", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(
      path.join(repo, "broken.js"),
      "function broken() { return undefiend; }\n"
    );
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        CAPTURE_FILE: captureFile
      },
      input: {
        cwd: repo,
        last_assistant_message: "created broken.js",
        session_id: "s"
      },
      mockResponse: {
        status: 200,
        body: {
          choices: [{ message: { content: "BLOCK: typo undefiend in broken.js:1" } }]
        }
      }
    });
    assert.equal(r.status, 0);
    const decision = JSON.parse(r.stdout.trim());
    assert.equal(decision.decision, "block");
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const sent = JSON.parse(captured.opts.body).messages[0].content;
    assert.match(sent, /broken\.js/);
    assert.match(sent, /undefiend/);
    assert.match(sent, /new file mode|\+function broken/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});

test("hook excludes UNTRACKED .env from diff body (no secret leak)", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  const captureFile = path.join(makeTempDir(), "captured.json");
  try {
    execSync(`node -e "import('${ROOT_DIR}/scripts/lib/config.mjs').then(m => m.setConfig('${repo}', 'stopReviewGate', true))"`, {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data }
    });
    fs.writeFileSync(path.join(repo, "src.js"), "export const x = 1;\n");
    execSync("git add src.js", { cwd: repo });
    fs.writeFileSync(
      path.join(repo, ".env"),
      "DATABASE_URL=postgres://u:p@host/db\nINTERNAL_PASSWORD=hunter2-not-a-known-token-pattern\n"
    );
    const r = runHook({
      cwd: repo,
      env: {
        CLAUDE_PLUGIN_DATA: data,
        QWEN_API_KEY: "sk-test",
        CAPTURE_FILE: captureFile
      },
      input: { cwd: repo, last_assistant_message: "touched src.js and added .env", session_id: "s" },
      mockResponse: { status: 200, body: { choices: [{ message: { content: "ALLOW: ok" } }] } }
    });
    assert.equal(r.status, 0);
    const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    const sent = JSON.parse(captured.opts.body).messages[0].content;
    assert.match(sent, /\[diff excluded: sensitive path\]/);
    assert.match(sent, /\[file excluded: sensitive path\]/);
    assert.doesNotMatch(sent, /hunter2-not-a-known-token-pattern/);
    assert.doesNotMatch(sent, /DATABASE_URL=postgres/);
    assert.match(sent, /src\.js/);
  } finally {
    cleanup(repo);
    cleanup(data);
    cleanup(path.dirname(captureFile));
  }
});
