import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";
import { getConfig } from "../scripts/lib/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "scripts", "qwen-review.mjs");

function runCli(args, { cwd, env = {} }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
}

test("setup with invalid --mode does NOT enable gate (atomic validation)", () => {
  // Regression: previously '--enable' wrote stopReviewGate=true to state
  // BEFORE parseModeArg ran. An invalid --mode then exited 2 — but the
  // gate had already been flipped on, so the user sees a visible error
  // yet the state silently changed.
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    const env = { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "" };
    assert.equal(getConfig(repo).stopReviewGate, false);

    const r = runCli(["setup", "--enable", "--mode=bogus"], { cwd: repo, env });
    assert.equal(r.status, 2, "expected exit 2 on invalid mode");
    assert.match(r.stderr, /invalid --mode/);

    // The gate must NOT have been enabled — validation failed first.
    assert.equal(
      getConfig(repo).stopReviewGate,
      false,
      "stopReviewGate must remain false after rejected setup invocation"
    );
    assert.equal(getConfig(repo).mode, undefined);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("setup with --enable and --disable both rejects with exit 2 and no mutation", () => {
  const data = makeTempDir();
  const repo = makeTempGitRepo();
  try {
    const env = { CLAUDE_PLUGIN_DATA: data, QWEN_API_KEY: "" };
    assert.equal(getConfig(repo).stopReviewGate, false);

    const r = runCli(["setup", "--enable", "--disable"], { cwd: repo, env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mutually exclusive/);
    assert.equal(getConfig(repo).stopReviewGate, false);
  } finally {
    cleanup(repo);
    cleanup(data);
  }
});

test("apply-config rejects --mode=bogus without writing settings", () => {
  // Sandboxed HOME so we don't touch the real ~/.claude/settings.json
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--api-key=sk-x", "--base-url=https://x", "--model=y", "--mode=bogus"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid --mode/);
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    assert.equal(
      fs.existsSync(settingsPath),
      false,
      "apply-config must not create settings.json on validation failure"
    );
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config rejects masked api-key value (LLM safety guard)", () => {
  // Regression: /qwen-review:status outputs apiKey: "sk-•••efd" (masked).
  // An LLM driving the wizard could mistakenly forward that display string
  // as --api-key, overwriting the REAL key with the mask. apply-config
  // must detect '•' (bullet) and refuse.
  const fakeHome = makeTempDir();
  try {
    // Plant a real key in settings.json first so we can verify it's not overwritten
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { QWEN_API_KEY: "sk-the-real-key-must-survive" } })
    );

    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config",
       "--api-key=sk-•••efd",  // the masked display value, not a real key
       "--base-url=https://x",
       "--model=y",
       "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /masked\/display value/);
    // The real key in settings.json MUST still be there, untouched.
    const after = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
    assert.equal(after.env.QWEN_API_KEY, "sk-the-real-key-must-survive");
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config rejects api-key containing REDACTED substring", () => {
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--api-key=[REDACTED:openai-or-qwen-key]",
       "--base-url=https://x", "--model=y", "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /masked\/display value/);
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config rejects suspiciously short api-key", () => {
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--api-key=sk-abc", "--base-url=https://x", "--model=y", "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /suspiciously short/);
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config --keep-key preserves the existing key (does not touch it)", () => {
  const fakeHome = makeTempDir();
  try {
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { QWEN_API_KEY: "sk-original-must-survive-2026", OUTRO: "preservado" } })
    );

    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--keep-key", "--base-url=https://newurl", "--model=newmodel", "--mode=thinking"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const after = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
    // Key untouched
    assert.equal(after.env.QWEN_API_KEY, "sk-original-must-survive-2026");
    // Other fields updated
    assert.equal(after.env.QWEN_BASE_URL, "https://newurl");
    assert.equal(after.env.QWEN_MODEL, "newmodel");
    assert.equal(after.env.QWEN_REVIEW_MODE, "thinking");
    // Pre-existing unrelated field preserved
    assert.equal(after.env.OUTRO, "preservado");
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config --skip-key on fresh user writes config WITHOUT QWEN_API_KEY", () => {
  // First-time wizard flow: user picks 'configure later' for the key
  // but wants to save base/model/mode. apply-config must not require
  // a key and must omit QWEN_API_KEY from the env block entirely.
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--skip-key", "--base-url=https://x", "--model=qwen3-max", "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.keyAction, "deferred");
    assert.equal(out.env.QWEN_API_KEY, null, "masked output should be null when key is absent");

    const after = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
    assert.equal(after.env.QWEN_API_KEY, undefined, "QWEN_API_KEY field must be ABSENT, not empty string");
    assert.equal(after.env.QWEN_BASE_URL, "https://x");
    assert.equal(after.env.QWEN_MODEL, "qwen3-max");
    assert.equal(after.env.QWEN_REVIEW_MODE, "fast");
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config --skip-key with existing key preserves it (does not erase)", () => {
  const fakeHome = makeTempDir();
  try {
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ env: { QWEN_API_KEY: "sk-pre-existing-survives-2026" } })
    );
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--skip-key", "--base-url=https://y", "--model=z", "--mode=thinking"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 0);
    const after = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
    // Key still there
    assert.equal(after.env.QWEN_API_KEY, "sk-pre-existing-survives-2026");
    // Other fields updated
    assert.equal(after.env.QWEN_BASE_URL, "https://y");
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config rejects --api-key + --keep-key combined (mutual exclusion)", () => {
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--api-key=sk-12345678901234567890", "--keep-key",
       "--base-url=https://x", "--model=y", "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mutually exclusive/);
    // No settings file should be written
    assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "settings.json")), false);
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config rejects --keep-key when no existing key (clear error directs to alternatives)", () => {
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--keep-key", "--base-url=https://x", "--model=y", "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no existing QWEN_API_KEY/);
    assert.match(r.stderr, /--api-key=<your-key>/);
    assert.match(r.stderr, /--skip-key/);
  } finally {
    cleanup(fakeHome);
  }
});

test("apply-config writes settings.json on valid args (full happy path)", () => {
  const fakeHome = makeTempDir();
  try {
    const env = { HOME: fakeHome };
    const r = runCli(
      ["apply-config", "--api-key=sk-test-key", "--base-url=https://example/v1", "--model=qwen3-max", "--mode=fast"],
      { cwd: fakeHome, env }
    );
    assert.equal(r.status, 0, `expected ok exit, stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.env.QWEN_BASE_URL, "https://example/v1");
    assert.equal(out.env.QWEN_REVIEW_MODE, "fast");

    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    assert.equal(fs.existsSync(settingsPath), true);
    const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(written.env.QWEN_API_KEY, "sk-test-key");
    assert.equal(written.env.QWEN_MODEL, "qwen3-max");
    // strict 0o600
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  } finally {
    cleanup(fakeHome);
  }
});
