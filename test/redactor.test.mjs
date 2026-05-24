import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, shouldSkipFile, isBinary } from "../scripts/lib/redactor.mjs";

test("redactSecrets masks AWS access key", () => {
  const input = "key = AKIAIOSFODNN7EXAMPLE end";
  assert.equal(redactSecrets(input), "key = [REDACTED:aws-access-key] end");
});

test("redactSecrets masks OpenAI / Qwen style sk- key", () => {
  const input = "Bearer sk-1234567890abcdefghij1234567890ABCD";
  assert.match(redactSecrets(input), /\[REDACTED:openai-or-qwen-key\]/);
});

test("redactSecrets masks GitHub token", () => {
  const input = "token=ghp_1234567890abcdefghijABCDEFGHIJ";
  assert.match(redactSecrets(input), /\[REDACTED:github-token\]/);
});

test("redactSecrets masks JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.match(redactSecrets(`auth: ${jwt}`), /\[REDACTED:jwt\]/);
});

test("redactSecrets masks PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactSecrets(pem), "[REDACTED:pem]");
});

test("redactSecrets masks Slack token", () => {
  const input = "xoxb-1234567890-abcdefghij";
  assert.match(redactSecrets(input), /\[REDACTED:slack-token\]/);
});

test("redactSecrets is a no-op on plain text", () => {
  assert.equal(redactSecrets("hello world\nplain text"), "hello world\nplain text");
});

test("redactSecrets handles empty / null inputs", () => {
  assert.equal(redactSecrets(""), "");
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
});

test("shouldSkipFile skips .env and friends", () => {
  assert.equal(shouldSkipFile(".env"), true);
  assert.equal(shouldSkipFile(".env.local"), true);
  assert.equal(shouldSkipFile(".env.production"), true);
  assert.equal(shouldSkipFile("src/.env"), true);
});

test("shouldSkipFile skips key/pem/crt files", () => {
  assert.equal(shouldSkipFile("certs/server.key"), true);
  assert.equal(shouldSkipFile("ca.pem"), true);
  assert.equal(shouldSkipFile("client.crt"), true);
  assert.equal(shouldSkipFile("store.p12"), true);
});

test("shouldSkipFile skips ssh private keys", () => {
  assert.equal(shouldSkipFile("home/user/.ssh/id_rsa"), true);
  assert.equal(shouldSkipFile(".ssh/id_ed25519"), true);
});

test("shouldSkipFile skips paths containing secret/credential/token", () => {
  assert.equal(shouldSkipFile("config/secrets.yaml"), true);
  assert.equal(shouldSkipFile("Credentials.json"), true);
  assert.equal(shouldSkipFile("auth/tokens.ts"), true);
});

test("shouldSkipFile does not skip normal source files", () => {
  assert.equal(shouldSkipFile("src/index.ts"), false);
  assert.equal(shouldSkipFile("README.md"), false);
  assert.equal(shouldSkipFile("package.json"), false);
});

test("shouldSkipFile respects user-provided extra globs", () => {
  assert.equal(shouldSkipFile("data/private.csv", ["data/*.csv"]), true);
  assert.equal(shouldSkipFile("src/index.ts", ["data/*.csv"]), false);
});

test("isBinary detects null byte in first 8KB", () => {
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  assert.equal(isBinary(bin), true);
});

test("isBinary returns false for utf8 text", () => {
  const txt = Buffer.from("hello\nworld\n", "utf8");
  assert.equal(isBinary(txt), false);
});
