import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  loadState,
  saveState,
  getConfig,
  setConfig,
  saveLastReview,
  resolveStateDir,
  resolveStateFile
} from "../scripts/lib/config.mjs";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";

function withPluginData(fn) {
  const data = makeTempDir();
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  try {
    return fn(data);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    cleanup(data);
  }
}

test("loadState returns defaults when no state file exists", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      const state = loadState(repo);
      assert.equal(state.version, 1);
      assert.equal(state.config.stopReviewGate, false);
      assert.equal(state.lastReview, null);
    } finally {
      cleanup(repo);
    }
  });
});

test("setConfig + getConfig round-trip", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      setConfig(repo, "stopReviewGate", true);
      assert.equal(getConfig(repo).stopReviewGate, true);
    } finally {
      cleanup(repo);
    }
  });
});

test("saveLastReview persists metadata", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      saveLastReview(repo, {
        ts: "2026-05-23T00:00:00Z",
        decision: "block",
        reason: "test",
        model: "qwen3-max",
        latencyMs: 1234
      });
      const state = loadState(repo);
      assert.equal(state.lastReview.decision, "block");
      assert.equal(state.lastReview.latencyMs, 1234);
    } finally {
      cleanup(repo);
    }
  });
});

test("state files for different workspaces do not collide", () => {
  withPluginData(() => {
    const a = makeTempGitRepo();
    const b = makeTempGitRepo();
    try {
      setConfig(a, "stopReviewGate", true);
      setConfig(b, "stopReviewGate", false);
      assert.equal(getConfig(a).stopReviewGate, true);
      assert.equal(getConfig(b).stopReviewGate, false);
      assert.notEqual(resolveStateDir(a), resolveStateDir(b));
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });
});

test("state file is created with 0o600 perms", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      setConfig(repo, "stopReviewGate", true);
      const file = resolveStateFile(repo);
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      cleanup(repo);
    }
  });
});

test("corrupted state file falls back to defaults", () => {
  withPluginData(() => {
    const repo = makeTempGitRepo();
    try {
      const file = resolveStateFile(repo);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "not json{{{", { mode: 0o600 });
      const state = loadState(repo);
      assert.equal(state.config.stopReviewGate, false);
    } finally {
      cleanup(repo);
    }
  });
});
