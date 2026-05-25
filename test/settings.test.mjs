import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadSettings, writeSettingsAtomic } from "../scripts/lib/settings.mjs";
import { makeTempDir, cleanup } from "./helpers/tempdir.mjs";

test("writeSettingsAtomic preserves existing 0o600 perms (does not widen)", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ env: { OLD: "x" } }), { mode: 0o600 });
    fs.chmodSync(file, 0o600); // explicit, in case umask interfered
    writeSettingsAtomic(file, { env: { NEW: "y" } });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(data.env.NEW, "y");
  } finally {
    cleanup(dir);
  }
});

test("writeSettingsAtomic preserves existing 0o644 perms (does not narrow either)", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  try {
    fs.writeFileSync(file, "{}");
    fs.chmodSync(file, 0o644);
    writeSettingsAtomic(file, { env: { K: "v" } });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o644, `expected 0o644, got 0o${mode.toString(8)}`);
  } finally {
    cleanup(dir);
  }
});

test("writeSettingsAtomic uses safe 0o600 default when file does not exist", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "new-settings.json");
  try {
    assert.equal(fs.existsSync(file), false);
    writeSettingsAtomic(file, { env: { K: "v" } });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600 for new file, got 0o${mode.toString(8)}`);
  } finally {
    cleanup(dir);
  }
});

test("writeSettingsAtomic does not leave behind .qwen-tmp on success", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  try {
    writeSettingsAtomic(file, { k: 1 });
    assert.equal(fs.existsSync(`${file}.qwen-tmp`), false);
  } finally {
    cleanup(dir);
  }
});

test("loadSettings returns empty data when file missing", () => {
  const dir = makeTempDir();
  try {
    const r = loadSettings(path.join(dir, "no-such.json"));
    assert.deepEqual(r.data, {});
  } finally {
    cleanup(dir);
  }
});

test("loadSettings throws descriptive error on invalid JSON", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  try {
    fs.writeFileSync(file, "{not json");
    assert.throws(() => loadSettings(file), /cannot parse/);
  } finally {
    cleanup(dir);
  }
});

test("writeSettingsAtomic never creates a world-readable tmp even with umask 0o000", () => {
  // Regression: previously writeFileSync(tmp) without explicit mode would
  // let umask choose, so umask=0 → tmp mode 0o644 with credentials inside,
  // for the window before chmod ran.
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  const originalUmask = process.umask(0o000);
  try {
    writeSettingsAtomic(file, { env: { QWEN_API_KEY: "sk-secret-that-must-not-leak" } });
    const mode = fs.statSync(file).mode & 0o777;
    // For a NEW file, we default to 0o600. Even with umask=0 (would allow
    // 0o666 by default), the explicit SAFE_DEFAULT_MODE wins.
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
    // And no stale tmp left behind
    assert.equal(fs.existsSync(`${file}.qwen-tmp`), false);
  } finally {
    process.umask(originalUmask);
    cleanup(dir);
  }
});

test("writeSettingsAtomic still preserves 0o644 of an existing file even with restrictive umask 0o077", () => {
  // Inverse case: user had a 0o644 file (their explicit choice), the
  // wizard must not silently TIGHTEN to 0o600 just because umask is paranoid.
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o644);
  const originalUmask = process.umask(0o077);
  try {
    writeSettingsAtomic(file, { env: { K: "v" } });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o644, `expected 0o644 preserved, got 0o${mode.toString(8)}`);
  } finally {
    process.umask(originalUmask);
    cleanup(dir);
  }
});

test("writeSettingsAtomic cleans up a stale .qwen-tmp from a previous crash", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  const tmp = `${file}.qwen-tmp`;
  // Simulate a stale tmp left over from a previous interrupted run
  fs.writeFileSync(tmp, "stale partial json{{{", { mode: 0o644 });
  try {
    writeSettingsAtomic(file, { env: { K: "v" } });
    assert.equal(fs.existsSync(tmp), false, "stale tmp should be unlinked before new write");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(data.env.K, "v");
  } finally {
    cleanup(dir);
  }
});
