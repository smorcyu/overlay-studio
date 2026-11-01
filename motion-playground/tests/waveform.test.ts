import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePeaks } from "../vite.config.ts";

test("one loud spike does not flatten normal speech", () => {
  // 说话的峰值都在 8000 左右,中间一声拍手 32000
  const raw = [0, 0, ...Array(300).fill(8000), 32000, ...Array(300).fill(7000), 0, 0];
  const p = normalizePeaks(raw);
  assert.equal(p[0], 0); // 静音还是 0
  assert.equal(p[302], 255); // 拍手截到满格
  assert.ok(p[2] >= 250, `normal speech should stay near full scale, got ${p[2]}`);
  assert.ok(p[400] > 200, `quieter speech should stay well above the pause threshold, got ${p[400]}`);
});

test("all-silent input stays at zero", () => {
  assert.deepEqual(normalizePeaks([0, 3, 10]), [0, 0, 0]);
});
