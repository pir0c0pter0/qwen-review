const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-access-key]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:openai-or-qwen-key]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    "[REDACTED:jwt]"
  ],
  [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    "[REDACTED:pem]"
  ],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"]
];

const DEFAULT_SKIP_PATTERNS = [
  /(^|\/)\.env($|\.[^/]+$)/,
  /\.(key|pem|crt|p12|pfx|jks)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(secret|credential|token)/i
];

function globToRegex(glob) {
  // Escape regex specials, then translate ** → .*, * → [^/]*
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp("^" + escaped + "$");
}

export function shouldSkipFile(filePath, extraGlobs = []) {
  const normalized = String(filePath).replace(/\\/g, "/");
  for (const re of DEFAULT_SKIP_PATTERNS) {
    if (re.test(normalized)) return true;
  }
  for (const glob of extraGlobs) {
    if (!glob) continue;
    if (globToRegex(glob).test(normalized)) return true;
  }
  return false;
}

export function isBinary(buffer, scanBytes = 8192) {
  if (!Buffer.isBuffer(buffer)) return false;
  const limit = Math.min(buffer.length, scanBytes);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function redactSecrets(text) {
  if (text === null || text === undefined || text === "") return text;
  let out = String(text);
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
