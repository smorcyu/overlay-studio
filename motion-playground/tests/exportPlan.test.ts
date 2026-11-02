import { test } from "node:test";
import assert from "node:assert/strict";
import { captureSchedule, cutTimelineTime, estimateEta, sfxSheetLines } from "../scripts/export-plan.mjs";
import { fmtTime } from "../scripts/fmt-time.mjs";

test("capture schedule: consecutive PNG numbers, 0 for frames inside cuts or after the footage ends", () => {
  assert.deepEqual(captureSchedule(8, [[2, 4], [6, 7]]), [1, 2, 0, 0, 3, 4, 0, 5]);
  assert.deepEqual(captureSchedule(4, []), [1, 2, 3, 4]); // 普通导出:全截
  assert.deepEqual(captureSchedule(3, [[0, 10]]), [0, 0, 0]); // 整条都在剪切段里(导出脚本会补一张透明帧)
  assert.deepEqual(captureSchedule(8, [[2, 4]], 6), [1, 2, 0, 0, 3, 4, 0, 0]); // 原片在第 6 帧结束
});

test("cutTimelineTime maps a timeline time onto the cut final MP4 (sfx sheet)", () => {
  const fps = 30;
  const ranges = [[60, 120], [210, 225]]; // 2–4s、7–7.5s
  assert.deepEqual(cutTimelineTime(1, ranges, fps), { t: 1, inCut: false, cutUntil: null });
  assert.deepEqual(cutTimelineTime(3, ranges, fps), { t: 2, inCut: true, cutUntil: 4 }); // 剪切段里:落在那一刀的位置
  assert.deepEqual(cutTimelineTime(4, ranges, fps), { t: 2, inCut: false, cutUntil: null }); // 正好在剪切段终点
  assert.deepEqual(cutTimelineTime(2, ranges, fps), { t: 2, inCut: true, cutUntil: 4 }); // 正好在剪切段起点
  assert.deepEqual(cutTimelineTime(9, ranges, fps), { t: 6.5, inCut: false, cutUntil: null }); // 两刀之后
  // 起点落在两帧之间:卡出现的第一帧是后面那一帧。29.97 下 10.0s = 第 299.7 帧 → 第 300 帧,被剪了
  const c = cutTimelineTime(10, [[300, 330]], 30000 / 1001);
  assert.equal(c.inCut, true);
  assert.ok(Math.abs(c.t - 10) < 1e-9);
  assert.equal(cutTimelineTime(9.95, [[300, 330]], 30000 / 1001).inCut, false); // 第 298.2 帧 → 299,没剪
});

test("estimateEta: captured and clock-only frames are timed separately", () => {
  const shot = { ms: 1000, n: 10 }; // 每张 100ms
  const step = { ms: 200, n: 10 }; // 每帧 20ms
  assert.equal(estimateEta({ leftShot: 100, leftStep: 50, shot, step }), 11); // 10s + 1s
  // 还没遇到过剪切段:只推时钟的帧先按截图的耗时估
  assert.equal(estimateEta({ leftShot: 10, leftStep: 10, shot, step: { ms: 0, n: 0 } }), 2);
  // 一开头就是剪切段、还没截过图:截图的帧先按只推时钟的耗时估
  assert.equal(estimateEta({ leftShot: 50, leftStep: 0, shot: { ms: 0, n: 0 }, step }), 1);
  // 什么都还没量到 / 都做完了
  assert.equal(estimateEta({ leftShot: 50, leftStep: 50, shot: { ms: 0, n: 0 }, step: { ms: 0, n: 0 } }), 0);
  assert.equal(estimateEta({ leftShot: 0, leftStep: 0, shot, step }), 0);
});

test("sfx sheet lines: cut-timeline times, cut starts and points past the end of the final MP4 are marked", () => {
  const pts = [
    { t: 1, kind: "punch-pill", sfx: "pop-light" },
    { t: 3, kind: "stat-proof", sfx: "rise" },
    { t: 9, kind: "chapter-bar", sfx: "chime" },
    { t: 20, kind: "checklist", sfx: "ding" },
  ];
  const lines = sfxSheetLines(pts, [[60, 120]], 30, 10); // 剪掉 2–4s,成片 10s
  assert.deepEqual(lines, [
    "0:01.0  punch-pill      pop-light",
    "0:02.0  stat-proof      rise  (起点在剪切段里:开头被剪掉了)",
    "0:07.0  chapter-bar     chime",
    "0:18.0  checklist       ding  (在成片结束之后:没混进去)",
  ]);
  // 剪切段一直剪到音效最长能响到的地方之后:整段听不到
  assert.deepEqual(sfxSheetLines([{ t: 12, kind: "punch-pill", sfx: "pop-light" }], [[300, 600]], 30), [
    "0:10.0  punch-pill      pop-light  (整段在剪切段里:成片里听不到)",
  ]);
  // 没有剪切(只导成片、编排里没剪):时间原样,不标注
  assert.deepEqual(sfxSheetLines(pts.slice(0, 2), [], 30, 10).map((l) => l.slice(0, 6)), ["0:01.0", "0:03.0"]);
  // 完整时间轴(MOV):原样列时间,不标注
  assert.deepEqual(sfxSheetLines(pts.slice(0, 2), null, 30).map((l) => l.slice(0, 6)), ["0:01.0", "0:03.0"]);
});

test("fmtTime rounds before splitting minutes", () => {
  assert.equal(fmtTime(59.96), "1:00.0");
  assert.equal(fmtTime(119.95), "2:00.0");
  assert.equal(fmtTime(61.24), "1:01.2");
  assert.equal(fmtTime(0), "0:00.0");
  assert.equal(fmtTime(-0.01), "0:00.0");
});
