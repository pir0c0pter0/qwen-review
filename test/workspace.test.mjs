import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspaceRoot } from "../scripts/lib/workspace.mjs";
import { makeTempGitRepo, makeTempDir, cleanup } from "./helpers/tempdir.mjs";

test("resolveWorkspaceRoot returns git toplevel when inside a repo", () => {
  const repo = makeTempGitRepo();
  try {
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    const root = resolveWorkspaceRoot(sub);
    assert.equal(fs.realpathSync(root), fs.realpathSync(repo));
  } finally {
    cleanup(repo);
  }
});

test("resolveWorkspaceRoot falls back to absolute cwd when outside a repo", () => {
  const tmp = makeTempDir();
  try {
    const root = resolveWorkspaceRoot(tmp);
    assert.equal(root, path.resolve(tmp));
  } finally {
    cleanup(tmp);
  }
});
