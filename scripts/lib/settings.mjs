import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_DEFAULT_MODE = 0o600;

export function settingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function loadSettings(p = settingsPath()) {
  if (!fs.existsSync(p)) return { path: p, data: {} };
  try {
    return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (err) {
    throw new Error(
      `cannot parse ${p}: ${err.message} (fix or backup the file before running wizard)`
    );
  }
}

/**
 * Atomically write settings.json preserving the existing file's permissions.
 * If the file does not exist, uses SAFE_DEFAULT_MODE (0o600) since the
 * payload likely contains credentials.
 *
 * Important: we use writeFileSync + chmodSync + rename (not the `mode` option
 * on writeFileSync) because Node's underlying open() applies umask, which
 * would silently widen permissions on systems with permissive umasks.
 */
export function writeSettingsAtomic(p, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  let mode = SAFE_DEFAULT_MODE;
  if (fs.existsSync(p)) {
    try {
      mode = fs.statSync(p).mode & 0o777;
    } catch {
      mode = SAFE_DEFAULT_MODE;
    }
  }
  const tmp = `${p}.qwen-tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    // best-effort: if chmod fails (e.g. unusual FS), proceed with whatever
    // perms the OS assigned. The rename below is still atomic.
  }
  fs.renameSync(tmp, p);
  return { path: p, mode };
}
