import fs from "node:fs";
import path from "node:path";

const DEFAULT_TRUNCATE_MARKER = "[…truncated…]";

export function loadTemplate(rootDir, name) {
  return fs.readFileSync(path.join(rootDir, "prompts", `${name}.md`), "utf8");
}

export function interpolate(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars?.[key];
    return val === undefined || val === null ? "" : String(val);
  });
}

export function truncate(text, head, tail = 0, marker = DEFAULT_TRUNCATE_MARKER) {
  if (text === null || text === undefined) return text;
  const str = String(text);
  if (str.length <= head + tail) return str;
  if (tail === 0) return str.slice(0, head) + "\n" + marker;
  return str.slice(0, head) + "\n" + marker + "\n" + str.slice(-tail);
}
