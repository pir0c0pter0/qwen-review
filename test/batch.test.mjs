import { test } from "node:test";
import assert from "node:assert/strict";
import { packBatches } from "../scripts/lib/batch.mjs";

function item(file, diffLen, contentLen) {
  return {
    file,
    diffText: "d".repeat(diffLen),
    contentBlock: "c".repeat(contentLen)
  };
}

test("packBatches: everything fits in one batch", () => {
  const { batches, omittedFiles } = packBatches(
    [item("a.js", 100, 100), item("b.js", 100, 100)],
    { callBudgetChars: 1000 }
  );
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((it) => it.file), ["a.js", "b.js"]);
  assert.deepEqual(omittedFiles, []);
});

test("packBatches: splits at the call budget, preserving order", () => {
  const { batches, omittedFiles } = packBatches(
    [item("a.js", 300, 300), item("b.js", 300, 300), item("c.js", 300, 300)],
    { callBudgetChars: 1300 }
  );
  // a(600)+b(600)=1200 cabe; c estoura → segundo lote
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].map((it) => it.file), ["a.js", "b.js"]);
  assert.deepEqual(batches[1].map((it) => it.file), ["c.js"]);
  assert.deepEqual(omittedFiles, []);
});

test("packBatches: respects maxCalls and reports omittedFiles", () => {
  const { batches, omittedFiles } = packBatches(
    [item("a.js", 300, 300), item("b.js", 300, 300), item("c.js", 300, 300), item("d.js", 300, 300)],
    { callBudgetChars: 700, maxCalls: 2 }
  );
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].map((it) => it.file), ["a.js"]);
  assert.deepEqual(batches[1].map((it) => it.file), ["b.js"]);
  assert.deepEqual(omittedFiles, ["c.js", "d.js"]);
});

test("packBatches: applies per-file caps with the existing marker styles", () => {
  const { batches } = packBatches(
    [item("a.js", 500, 500)],
    { callBudgetChars: 100_000, perFileDiffCap: 100, perFileContentCap: 200 }
  );
  const it = batches[0][0];
  assert.match(it.diffText, /\[…truncated…\]$/);
  assert.match(it.contentBlock, /\[truncated\]$/);
  assert.ok(it.diffText.length <= 100 + "\n[…truncated…]".length);
  assert.ok(it.contentBlock.length <= 200 + "\n[truncated]".length);
});

test("packBatches: oversized single item gets its own batch, truncated to fit", () => {
  const { batches, omittedFiles } = packBatches(
    [item("small.js", 100, 100), item("huge.js", 3000, 3000), item("tail.js", 100, 100)],
    { callBudgetChars: 1000, perFileDiffCap: 40_000, perFileContentCap: 40_000 }
  );
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[1].map((it) => it.file), ["huge.js"]);
  const huge = batches[1][0];
  const size = huge.diffText.length + huge.contentBlock.length;
  assert.ok(size <= 1000 + "\n[…truncated…]".length + "[truncated]".length,
    `oversized item should be truncated to ~budget, got ${size}`);
  assert.match(huge.diffText, /\[…truncated…\]$/);
  assert.deepEqual(omittedFiles, []);
});

test("packBatches: empty input → no batches, no omitted", () => {
  const { batches, omittedFiles } = packBatches([], { callBudgetChars: 1000 });
  assert.deepEqual(batches, []);
  assert.deepEqual(omittedFiles, []);
});
