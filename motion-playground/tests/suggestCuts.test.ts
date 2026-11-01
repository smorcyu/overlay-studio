import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SUGGEST,
  findPauses,
  isFillerLine,
  isRetake,
  suggestCuts,
} from "../src/overlay/suggestCuts.ts";

/** 50 格/秒的波形:按 [秒数, 峰值] 一段段拼 */
function wave(...segs: [number, number][]) {
  const peaks: number[] = [];
  for (const [sec, v] of segs) for (let i = 0; i < Math.round(sec * 50); i++) peaks.push(v);
  return { rate: 50, peaks };
}

test("isFillerLine: whole line must be filler", () => {
  for (const s of ["嗯", "嗯嗯啊", "那个，那个...", "Um, uh.", "然后"]) assert.equal(isFillerLine(s), true, s);
  for (const s of ["嗯我们开始", "那个东西很好", "", "   ", "okay let's go"]) assert.equal(isFillerLine(s), false, s);
});

test("isRetake: repeats and broken-off starts, not short or unrelated lines", () => {
  assert.equal(isRetake("今天我们来讲", "今天我们来讲一下剪辑"), true);
  assert.equal(isRetake("这个工具非常好用", "这个工具非常好用。"), true);
  assert.equal(isRetake("我们先打开软件然后导入", "我们先打开这个软件然后导入"), true);
  assert.equal(isRetake("这个工具非常好用", "下面我们看第二个功能"), false);
  assert.equal(isRetake("对", "对的"), false);
});

test("findPauses: keeps padding inside, skips short gaps, includes start and end silence", () => {
  const w = wave([1, 0], [2, 200], [1.2, 5], [0.8, 180], [0.5, 0], [0.5, 150], [1, 3]);
  const got = findPauses(w, DEFAULT_SUGGEST).map((p) => [p.start, p.end]);
  assert.deepEqual(got, [
    [0, 0.85], // 片头:起点不留余量
    [3.15, 4.05], // 中间:两头各留 0.15
    [6.15, 7], // 片尾:终点不留余量
  ]);
});

test("suggestCuts: text wins over overlapping pauses; existing and dismissed cuts are hidden", () => {
  const w = wave([1, 0], [2, 200], [1.2, 5], [0.8, 180], [0.5, 0], [0.5, 150], [1, 3]);
  const subs = [
    { start: 1, end: 2, text: "今天我们来讲" },
    { start: 2.2, end: 3, text: "今天我们来讲一下剪辑" },
    { start: 4.2, end: 4.6, text: "嗯" },
    { start: 5.5, end: 6, text: "好，开始" },
  ];
  const all = suggestCuts({ wave: w, subs, cuts: [{ start: 6.5, end: 6.9 }] });
  assert.deepEqual(
    all.map((s) => [s.kind, s.start, s.end]),
    [
      ["pause", 0, 0.85],
      ["retake", 1, 2.2],
      ["pause", 3.15, 4.05],
      ["filler", 4.2, 4.6],
    ],
  );
  const afterDismiss = suggestCuts({ wave: w, subs, dismissed: [{ start: 1, end: 2.2 }] });
  assert.ok(!afterDismiss.some((s) => s.kind === "retake"));
  assert.deepEqual(suggestCuts({}), []);
});

test("overlapping subtitle lines: never cut into the line that is kept", () => {
  // 自动字幕常见:前一句的结束晚于后一句的开始
  const subs = [
    { start: 1.0, end: 2.5, text: "今天我们来讲" },
    { start: 2.3, end: 4.0, text: "今天我们来讲一下剪辑" },
    { start: 5.0, end: 5.8, text: "嗯" },
    { start: 5.6, end: 7.0, text: "先打开软件" },
  ];
  const got = suggestCuts({ subs }).map((s) => [s.kind, s.start, s.end]);
  assert.deepEqual(got, [
    ["retake", 1, 2.3], // 剪到后一句开头,不是 2.5
    ["filler", 5, 5.6], // 剪到下一句开头,不是 5.8
  ]);
});

test("overlapping subtitle lines: never cut into the line before either", () => {
  const subs = [
    { start: 10.0, end: 12.4, text: "这一句要留着" },
    { start: 12.2, end: 12.8, text: "嗯" }, // 开头和上一句重叠 0.2 秒
    { start: 13.0, end: 15.0, text: "下一句" },
  ];
  const got = suggestCuts({ subs }).map((s) => [s.kind, s.start, s.end]);
  assert.deepEqual(got, [["filler", 12.4, 12.8]]); // 从上一句结束处开始,不是 12.2
});
