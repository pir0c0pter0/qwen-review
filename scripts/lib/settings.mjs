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
 * Atomically write settings.json. ALWAYS sets mode 0o600 — owner-only.
 *
 * Why we never preserve a wider mode (e.g. 0o644) the user may have had:
 *
 *   - The payload contains an API key. 0o600 is the only correct mode
 *     for a credentials file; 0o644 leaks the key to every local user.
 *   - Doing a chmod-after-rename to widen creates a TOCTOU window where
 *     a hostile process running as the same UID could unlink the dest
 *     and plant a symlink, then our chmod adjusts the symlink's target.
 *     The simplest fix is to never widen.
 *   - Strict guarantee: this function always produces a file at exactly
 *     mode 0o600. No exceptions, no best-effort widening.
 *
 * If a user genuinely needs 0o644 on settings.json (e.g. for a non-secret
 * shared config in a sandbox), they can chmod manually — outside this
 * function's contract.
 *
 * Atomicity / safety:
 *   1. Unlink stale tmp first (defensive — prior crash may have left
 *      a wider tmp).
 *   2. Open tmp with O_CREAT|O_EXCL and mode 0o600. Umask can only REMOVE
 *      bits, never add — 0o600 is a hard ceiling.
 *   3. fs.writeFileSync(fd, buffer) loops short writes internally — no
 *      partial publish.
 *   4. Close, then atomic rename onto the dest. Rename preserves the
 *      tmp's mode (0o600), so the dest is at 0o600 the instant it
 *      replaces the prior file.
 *   5. On any error mid-stream, the dest is never touched. Tmp is left
 *      orphan and cleaned up on the next run.
 */
export function writeSettingsAtomic(p, data) {
  const payload = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
  // Ensure parent dir exists — first wizard run on a brand-new user has no
  // ~/.claude/ yet. mkdir mode 0o700 so the dir is also owner-only (matches
  // the credential file's 0o600 inside it).
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
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
    // The mode arg to open() is masked by umask: effective = mode & ~umask.
    // Under restrictive umasks (e.g. 0o277) the file would be created at
    // 0o400 — owner can't even WRITE. Worse for the strict guarantee:
    // result is NOT exactly 0o600. fchmodSync on the fd defeats umask AND
    // is TOCTOU-safe (path can't be swapped between us and the inode the
    // fd holds). We do this BEFORE write so credentials never land in a
    // file with anything other than 0o600.
    fs.fchmodSync(fd, SAFE_DEFAULT_MODE);
    fs.writeFileSync(fd, payload);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  return { path: p, mode: SAFE_DEFAULT_MODE };
}
