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
 * Security property: the credentials NEVER touch disk in a world-readable
 * file, even momentarily. To achieve this we:
 *   1. Unlink any stale tmp first (defensive — old tmp may have wider mode).
 *   2. Open the tmp with mode 0o600 BEFORE writing any bytes. Since umask
 *      can only REMOVE bits from a mode, a max of 0o600 guarantees the
 *      file is at most owner-readable from the moment it appears in the FS.
 *   3. Write the content via the fd.
 *   4. fchmod the fd to the preserved mode (may widen back to 0o644 if
 *      that was the original file's mode — user's choice, not our default).
 *   5. Close + rename.
 *
 * We use fchmod (not chmod by path) to avoid a TOCTOU race where another
 * process could swap the tmp path between chmod and rename.
 */
export function writeSettingsAtomic(p, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  let finalMode = SAFE_DEFAULT_MODE;
  if (fs.existsSync(p)) {
    try {
      finalMode = fs.statSync(p).mode & 0o777;
    } catch {
      finalMode = SAFE_DEFAULT_MODE;
    }
  }
  const tmp = `${p}.qwen-tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    SAFE_DEFAULT_MODE
  );
  try {
    fs.writeSync(fd, text);
    if (finalMode !== SAFE_DEFAULT_MODE) {
      try {
        fs.fchmodSync(fd, finalMode);
      } catch {
        // best-effort widen-to-preserved-mode; if it fails the file stays
        // at the safer 0o600. Better safe than over-permissioned.
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  return { path: p, mode: finalMode };
}
