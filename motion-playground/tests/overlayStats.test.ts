import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayStats } from "../src/app/overlayStats.ts";

const c = (start: number, end: number) => ({ id: `${start}`, kind: "punch-pill", start, end, params: {} });
const doc = (cards: ReturnType<typeof c>[]) => ({ version: 1, cards }) as never;

test("overlayStats: null without cards; peak counts cards on screen together; back-to-back cards don't overlap", () => {
  assert.equal(overlayStats(null), null);
  assert.equal(overlayStats(doc([])), null);
  assert.deepEqual(overlayStats(doc([c(0, 30), c(10, 20), c(15, 60)])), { peak: 3, perMin: 3 });
  assert.equal(overlayStats(doc([c(0, 5), c(5, 10)]))!.peak, 1);
  // 极短的编排:分母至少按 6 秒算,不会除出天文数字
  assert.equal(overlayStats(doc([c(0, 1)]))!.perMin, 10);
});
