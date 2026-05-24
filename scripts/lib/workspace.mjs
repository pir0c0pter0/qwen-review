import { execSync } from "node:child_process";
import path from "node:path";

export function resolveWorkspaceRoot(cwd) {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (root) return root;
  } catch {
    // not a git repo
  }
  return path.resolve(cwd);
}
