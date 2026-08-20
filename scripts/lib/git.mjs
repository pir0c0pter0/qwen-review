import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { redactSecrets, shouldSkipFile, isBinary } from "./redactor.mjs";

// Helpers git compartilhados entre o hook e o CLI (extraídos na v0.2,
// antes duplicados em stop-review-hook.mjs e qwen-review.mjs).

export function untrackedFiles(cwd) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function trackedChangedFiles(cwd) {
  try {
    return execFileSync("git", ["diff", "HEAD", "--name-only", "--diff-filter=ACMRT"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function trackedDiffForFile(cwd, file) {
  try {
    return execFileSync("git", ["diff", "HEAD", "--no-color", "--", file], {
      cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch { return ""; }
}

export function syntheticDiffForUntracked(cwd, file) {
  try {
    return execFileSync("git", ["diff", "--no-index", "--no-color", "/dev/null", file], {
      cwd, encoding: "utf8", maxBuffer: 4_000_000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (err) {
    return typeof err.stdout === "string" ? err.stdout : "";
  }
}

export function unsafeFileNote(file, stat) {
  if (stat.isSymbolicLink()) return "symlink target may be outside repo";
  if (!stat.isFile()) return "not a regular file";
  if (stat.nlink > 1) return "hardlink may point outside repo";
  return null;
}

// Marcador curto usado nos blocos de conteúdo ([file excluded: <note>]).
function shortNote(reason) {
  if (reason.startsWith("symlink")) return "symlink";
  if (reason.startsWith("hardlink")) return "hardlink";
  return "not a regular file";
}

// Itens por arquivo, na mesma ordem de sempre: tracked changed primeiro,
// depois untracked. Shape: { file, diffText, note } — note === null quando o
// arquivo pode ser lido; senão carrega o marcador de exclusão de hoje
// ("sensitive path" | "symlink" | "hardlink" | "not a regular file").
export function collectChangedItems(cwd, extraGlobs = []) {
  const items = [];
  const collect = (file, untracked) => {
    if (shouldSkipFile(file, extraGlobs)) {
      items.push({
        file,
        diffText: `diff --git a/${file} b/${file}\n${untracked ? "new file\n" : ""}[diff excluded: sensitive path]`,
        note: "sensitive path"
      });
      return;
    }
    let stat;
    try { stat = fs.lstatSync(path.join(cwd, file)); } catch { return; }
    const reason = unsafeFileNote(file, stat);
    if (reason) {
      items.push({
        file,
        diffText: `diff --git a/${file} b/${file}\n[diff excluded: ${reason}]`,
        note: shortNote(reason)
      });
      return;
    }
    const d = untracked ? syntheticDiffForUntracked(cwd, file) : trackedDiffForFile(cwd, file);
    items.push({ file, diffText: d, note: null });
  };
  for (const file of trackedChangedFiles(cwd)) collect(file, false);
  for (const file of untrackedFiles(cwd)) collect(file, true);
  return items;
}

// Bloco "=== file ===\n<conteúdo>" para um item de collectChangedItems.
// Retorna null quando o arquivo não pôde ser lido (paridade com o
// comportamento antigo de pular o bloco). Sem cap aqui — packBatches aplica.
export function contentBlockForItem(cwd, item, { redactEnabled = true } = {}) {
  if (item.note) return `=== ${item.file} ===\n[file excluded: ${item.note}]`;
  let buf;
  try { buf = fs.readFileSync(path.join(cwd, item.file)); } catch { return null; }
  if (isBinary(buf)) return `=== ${item.file} ===\n[file excluded: binary]`;
  let content = buf.toString("utf8");
  if (redactEnabled) content = redactSecrets(content);
  return `=== ${item.file} ===\n${content}`;
}
