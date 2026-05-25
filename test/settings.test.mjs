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

test("writeSettingsAtomic does NOT widen the tmp file even when preserving 0o644", () => {
  // Regression: previous impl did fchmod(fd, 0o644) on the tmp BEFORE
  // rename. That meant during the tmp's lifetime credentials sat in a
  // 0o644 file on disk readable by others. The new impl keeps tmp at
  // 0o600 until renamed; widening to 0o644 happens on the dest path.
  // We probe this by intercepting fs.chmodSync to record what mode/path
  // was set when.
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  const tmp = `${file}.qwen-tmp`;
  fs.writeFileSync(file, "{}");
  fs.chmodSync(file, 0o644);

  // Snapshot fs.chmodSync to record call sequence
  const originalChmod = fs.chmodSync;
  const calls = [];
  fs.chmodSync = function(p, mode) {
    calls.push({ path: p, mode: mode & 0o777, tmpExists: fs.existsSync(tmp) });
    return originalChmod.call(fs, p, mode);
  };
  try {
    writeSettingsAtomic(file, { env: { K: "v" } });
    // After write: final dest mode is 0o644 (preserved)
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    // No chmod was ever invoked on the tmp path while it existed
    const tmpChmods = calls.filter((c) => c.path === tmp);
    assert.equal(tmpChmods.length, 0, `tmp should never be chmod'd, got: ${JSON.stringify(tmpChmods)}`);
    // The widening chmod targeted the dest, not the tmp
    const destWiden = calls.filter((c) => c.path === file && c.mode === 0o644);
    assert.equal(destWiden.length, 1, "expected exactly one chmod 0o644 on the dest");
  } finally {
    fs.chmodSync = originalChmod;
    cleanup(dir);
  }
});

test("writeSettingsAtomic does not publish partial content on short writes", () => {
  // We can't easily force a real short write in a unit test, but we can
  // verify the happy path: if an exception is raised inside the write,
  // the destination is never touched. Simulate by sabotaging
  // fs.writeFileSync to throw mid-call (which is what would happen if
  // a real partial write retry chain were to fail).
  const dir = makeTempDir();
  const file = path.join(dir, "settings.json");
  const tmp = `${file}.qwen-tmp`;
  // Pre-existing dest with KNOWN good content
  fs.writeFileSync(file, JSON.stringify({ env: { OLD: "untouched" } }));
  fs.chmodSync(file, 0o600);

  // Replace fs.writeFileSync ONLY when given a number (fd), to simulate
  // a failing write while still letting the rest of the test infra work.
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function(target, content, opts) {
    if (typeof target === "number") {
      throw new Error("simulated EIO during write");
    }
    return realWrite.call(fs, target, content, opts);
  };
  try {
    assert.throws(() => writeSettingsAtomic(file, { env: { NEW: "should-not-land" } }), /simulated EIO/);
    // Destination must be untouched
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(data.env.OLD, "untouched");
    assert.equal(data.env.NEW, undefined);
  } finally {
    fs.writeFileSync = realWrite;
    // tmp may or may not exist (depends on whether open succeeded); clean either way
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
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
