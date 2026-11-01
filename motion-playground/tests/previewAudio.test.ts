import { test } from "node:test";
import assert from "node:assert/strict";
import { removedBefore, speakingAt } from "../src/components/usePreviewAudio.ts";
import { lintOverlay } from "../src/overlay/lint.ts";
import type { OverlayDoc } from "../src/overlay/types.ts";

test("removedBefore: how much has been cut before t (the music runs on the cut timeline)", () => {
  const cuts = [{ start: 2, end: 4 }, { start: 6, end: 7 }];
  assert.equal(removedBefore(1, cuts), 0);
  assert.equal(removedBefore(3, cuts), 1); // 在剪切段里:剪掉的只算到 t
  assert.equal(removedBefore(5, cuts), 2);
  assert.equal(removedBefore(10, cuts), 3);
  assert.equal(removedBefore(5, []), 0);
});

test("speakingAt: looks ±50ms around t in the waveform", () => {
  const peaks = new Array(500).fill(0);
  for (let i = 100; i < 150; i++) peaks[i] = 200; // 2.0–3.0s 在说话(50 格/秒)
  const wave = { rate: 50, peaks };
  assert.equal(speakingAt(wave, 2.5), true);
  assert.equal(speakingAt(wave, 1.96), true); // 离说话开始不到 50ms:提前一点压下去
  assert.equal(speakingAt(wave, 1.5), false);
  assert.equal(speakingAt(wave, 4), false);
  assert.equal(speakingAt(null, 2.5), false);
  peaks.fill(30); // 低于判断线的底噪
  assert.equal(speakingAt(wave, 2.5), false);
});

const card = (id: string, kind: string, start: number, end: number) => ({ id, kind, start, end, params: {} });

test("lint cut-overlap: cards inside or straddling a cut are warned, full-length layers are not", () => {
  const doc: OverlayDoc = {
    version: 1,
    cuts: [{ start: 10, end: 14 }],
    cards: [
      card("inside", "punch-pill", 11, 13),
      card("straddle", "punch-pill", 8, 12),
      card("clear", "punch-pill", 15, 18),
      card("bar", "chapter-bar", 0, 30), // 常驻层:铺满全片,跨剪切是常态
    ],
  };
  const issues = lintOverlay(doc).filter((i) => i.rule === "cut-overlap");
  assert.deepEqual(issues.map((i) => i.cardId).sort(), ["inside", "straddle"]);
  assert.match(issues.find((i) => i.cardId === "inside")!.message, /看不到/);
  assert.match(issues.find((i) => i.cardId === "straddle")!.message, /剪掉一截/);
});

test("lint cut-overlap respects lintOff and does nothing without cuts", () => {
  const off = { ...card("off", "punch-pill", 11, 13), lintOff: ["cut-overlap"] };
  const doc: OverlayDoc = { version: 1, cuts: [{ start: 10, end: 14 }], cards: [off] };
  assert.equal(lintOverlay(doc).filter((i) => i.rule === "cut-overlap").length, 0);
  const noCuts: OverlayDoc = { version: 1, cards: [card("x", "punch-pill", 11, 13)] };
  assert.equal(lintOverlay(noCuts).filter((i) => i.rule === "cut-overlap").length, 0);
});
