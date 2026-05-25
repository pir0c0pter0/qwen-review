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
 * Two security properties enforced:
 *
 * 1. Credentials never land on disk in a file wider than 0o600, even
 *    momentarily. The tmp file is opened with mode 0o600 (umask can only
 *    REMOVE bits, never add) and stays at 0o600 until renamed into place.
 *    Any widening to a preserved mode like 0o644 happens AFTER the rename,
 *    so the only "widened" file on disk has the user-chosen final name.
 *
 * 2. No partial publishes. We use fs.writeFileSync(fd, buffer), which
 *    internally loops over short writes until all bytes are flushed before
 *    returning. Then close, fsync-by-rename. If writeFileSync throws
 *    mid-stream the tmp is left orphan (cleaned up on next run via unlink)
 *    and the destination is never touched.
 */
export function writeSettingsAtomic(p, data) {
  const text = JSON.stringify(data, null, 2) + "\n";
  const payload = Buffer.from(text, "utf8");
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
    // writeFileSync(fd, buffer) loops over short writes internally
    fs.writeFileSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  // Widening happens AFTER rename — never on the tmp. The dest will be at
  // 0o600 for a microsecond between rename and chmod; that's safer than
  // having the tmp at the wider mode.
  if (finalMode !== SAFE_DEFAULT_MODE) {
    try {
      fs.chmodSync(p, finalMode);
    } catch {
      // best-effort widen-to-preserved-mode; if it fails the dest stays
      // at the safer 0o600. Better safe than over-permissioned.
    }
  }
  return { path: p, mode: finalMode };
}
