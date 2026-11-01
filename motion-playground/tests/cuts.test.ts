import { test } from "node:test";
import assert from "node:assert/strict";
import { keptDuration, normalizeCuts, skipCut } from "../src/overlay/cuts.ts";
import { normalizeCuts as normalizeCutsExport } from "../scripts/compose-final.mjs";

const MESSY = [
  { start: 6, end: 7 },
  { start: 2, end: 3 },
  { start: 2.5, end: 4 }, // 和上一段重叠 → 合并
  { start: 4, end: 4.5 }, // 和合并后的段相接 → 也合并
  { start: 5, end: 5.01 }, // 太短,丢
  { start: 9, end: 8 }, // 倒着的,丢
  { start: -1, end: 0.5 }, // 起点小于 0 → 截到 0
  { start: 1.234567, end: 1.8 }, // 两位小数
  { start: -1, end: -0.5 }, // 整段在 0 之前:截到 0 以后长度是负的,丢
  { start: "x", end: 1 },
  null,
];

test("normalizeCuts: drop invalid, sort, merge overlapping and touching, round", () => {
  assert.deepEqual(normalizeCuts(MESSY), [
    { start: 0, end: 0.5 },
    { start: 1.23, end: 1.8 },
    { start: 2, end: 4.5 },
    { start: 6, end: 7 },
  ]);
  assert.deepEqual(normalizeCuts(undefined), []);
  assert.deepEqual(normalizeCuts("nope"), []);
});

test("editor and exporter normalize cuts identically", () => {
  // 编辑台预览跳过的段和成片里删掉的段必须是同一批,否则「听到的」和「导出的」对不上
  assert.deepEqual(normalizeCutsExport(MESSY), normalizeCuts(MESSY));
  const random = Array.from({ length: 200 }, (_, i) => {
    const s = ((i * 7919) % 1000) / 37;
    return { start: s, end: s + ((i * 31) % 50) / 17 };
  });
  assert.deepEqual(normalizeCutsExport(random), normalizeCuts(random));
});

test("skipCut: half-open ranges, jumps to the end of the cut", () => {
  const cuts = normalizeCuts([{ start: 2, end: 4 }, { start: 6, end: 7 }]);
  assert.equal(skipCut(1.99, cuts), 1.99);
  assert.equal(skipCut(2, cuts), 4);
  assert.equal(skipCut(3.99, cuts), 4);
  assert.equal(skipCut(4, cuts), 4);
  assert.equal(skipCut(6.5, cuts), 7);
});

test("keptDuration: subtracts cuts, clamps cuts past the end", () => {
  const cuts = normalizeCuts([{ start: 2, end: 4 }, { start: 6, end: 7 }]);
  assert.equal(keptDuration(10, cuts), 7);
  assert.equal(keptDuration(6.5, cuts), 4);
  assert.equal(keptDuration(1, cuts), 1);
});
