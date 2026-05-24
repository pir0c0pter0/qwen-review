import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-review-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  execSync("git add .gitkeep", { cwd: dir });
  execSync('git -c commit.gpgsign=false commit -q -m "init"', { cwd: dir });
  return dir;
}

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwen-review-test-"));
}

export function cleanup(dir) {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
