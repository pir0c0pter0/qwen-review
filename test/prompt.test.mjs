import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplate, interpolate, truncate } from "../scripts/lib/prompt.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

test("loadTemplate reads from <root>/prompts/<name>.md", () => {
  const text = loadTemplate(ROOT_DIR, "stop-review");
  assert.match(text, /<previous_assistant_message>/);
  assert.match(text, /\{\{LAST_ASSISTANT\}\}/);
  assert.match(text, /\{\{GIT_DIFF\}\}/);
  assert.match(text, /\{\{CHANGED_FILES_CONTENT\}\}/);
});

test("interpolate replaces {{VAR}} tokens", () => {
  const out = interpolate("hello {{NAME}}!", { NAME: "world" });
  assert.equal(out, "hello world!");
});

test("interpolate replaces missing vars with empty string", () => {
  const out = interpolate("a={{A}} b={{B}}", { A: "x" });
  assert.equal(out, "a=x b=");
});

test("interpolate handles multi-line values", () => {
  const out = interpolate("<x>{{X}}</x>", { X: "line1\nline2" });
  assert.equal(out, "<x>line1\nline2</x>");
});

test("truncate returns text unchanged when within budget", () => {
  assert.equal(truncate("short", 100, 100), "short");
});

test("truncate with head + tail keeps both ends", () => {
  const input = "a".repeat(10) + "MIDDLE" + "b".repeat(10);
  const out = truncate(input, 5, 5);
  assert.match(out, /^aaaaa/);
  assert.match(out, /bbbbb$/);
  assert.match(out, /\[…truncated…\]/);
});

test("truncate with tail=0 keeps only the head", () => {
  const input = "a".repeat(100);
  const out = truncate(input, 10);
  assert.equal(out.startsWith("a".repeat(10)), true);
  assert.match(out, /\[…truncated…\]$/);
});

test("truncate handles empty/null", () => {
  assert.equal(truncate("", 10, 10), "");
  assert.equal(truncate(null, 10, 10), null);
});
