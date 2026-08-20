// Empacotamento puro de itens por arquivo em lotes para chamadas sequenciais
// ao Qwen (map-reduce). Sem fs, sem git — só strings e aritmética.

const DIFF_MARKER = "[…truncated…]";
const CONTENT_MARKER = "[truncated]";

function cap(text, max, marker) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n" + marker;
}

function itemSize(it) {
  return it.diffText.length + it.contentBlock.length;
}

// Item maior que o budget vira lote próprio, truncado pra caber:
// diff primeiro, conteúdo fica com o que sobrar.
function fitToBudget(it, budget) {
  let diffText = it.diffText;
  let contentBlock = it.contentBlock;
  if (diffText.length >= budget) {
    diffText = cap(diffText, budget, DIFF_MARKER);
    contentBlock = contentBlock ? CONTENT_MARKER : "";
  } else {
    contentBlock = cap(contentBlock, budget - diffText.length, CONTENT_MARKER);
  }
  return { ...it, diffText, contentBlock };
}

// items: [{ file, diffText, contentBlock }] na ordem de review.
// Retorna { batches, omittedFiles } — batches é array de arrays de itens
// (já com caps por arquivo aplicados); omittedFiles são os que não couberam
// em maxCalls lotes.
export function packBatches(items, {
  callBudgetChars = 100_000,
  maxCalls = 3,
  perFileContentCap = 16_000,
  perFileDiffCap = 40_000
} = {}) {
  const capped = items.map((it) => ({
    ...it,
    diffText: cap(it.diffText, perFileDiffCap, DIFF_MARKER),
    contentBlock: cap(it.contentBlock, perFileContentCap, CONTENT_MARKER)
  }));

  const batches = [];
  const omittedFiles = [];
  let cur = [];
  let curChars = 0;

  for (const it of capped) {
    if (batches.length >= maxCalls) { omittedFiles.push(it.file); continue; }
    const size = itemSize(it);
    if (cur.length > 0 && curChars + size > callBudgetChars) {
      batches.push(cur);
      cur = [];
      curChars = 0;
      if (batches.length >= maxCalls) { omittedFiles.push(it.file); continue; }
    }
    if (cur.length === 0 && size > callBudgetChars) {
      batches.push([fitToBudget(it, callBudgetChars)]);
      continue;
    }
    cur.push(it);
    curChars += size;
  }
  if (cur.length > 0) {
    if (batches.length < maxCalls) batches.push(cur);
    else omittedFiles.push(...cur.map((it) => it.file));
  }

  return { batches, omittedFiles };
}
