import { test } from "node:test";
import assert from "node:assert/strict";
import { captureSchedule, cutSeconds, cutTimelineTime, estimateEta, sfxSheetLines, sfxSheetText } from "../scripts/export-plan.mjs";
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
    "0:02.0  stat-proof      rise  (起点在剪切段里:成片里开头被剪掉了)",
    "0:07.0  chapter-bar     chime",
    "0:18.0  checklist       ding  (在成片结束之后:没混进去)",
  ]);
  // 剪切段一直剪到音效最长能响到的地方之后:整段听不到
  assert.deepEqual(sfxSheetLines([{ t: 12, kind: "punch-pill", sfx: "pop-light" }], [[300, 600]], 30), [
    "0:10.0  punch-pill      pop-light  (整段在剪切段里:成片里听不到)",
  ]);
  // 没有剪切(只导成片、编排里没剪):时间原样,不标注
  assert.deepEqual(sfxSheetLines(pts.slice(0, 2), [], 30, 10).map((l) => l.slice(0, 6)), ["0:01.0", "0:03.0"]);
  // MOV 和成片都有、又有剪切:左列完整时间轴(MOV),右列成片时间
  assert.deepEqual(sfxSheetLines(pts.slice(1, 3), [[60, 120]], 30, 10, { withTimeline: true }), [
    "0:03.0  0:02.0  stat-proof      rise  (起点在剪切段里:成片里开头被剪掉了)",
    "0:09.0  0:07.0  chapter-bar     chime",
  ]);
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

test("sfx sheet text: one or two time columns and the right notes for MOV only, MP4 only and both", () => {
  const points = [{ t: 6, kind: "stat-proof", sfx: "rise" }];
  const cut = { ranges: [[60, 120]], finalSec: 10 }; // 剪掉 2–4s
  const nocut = { ranges: [], finalSec: 12 };
  const text = (o: { mov: boolean; final: { ranges: number[][]; finalSec: number } | null }) =>
    sfxSheetText({ title: "t", points, fps: 30, ...o }).split("\n");

  const movOnly = text({ mov: true, final: null });
  assert.match(movOnly[0], /已直接混入 MOV,/);
  assert.ok(movOnly.some((l) => l.includes("剪映里对 MOV 轨道")));
  assert.ok(!movOnly.some((l) => l.includes("成片里音效")));
  assert.equal(movOnly.at(-1), "0:06.0  stat-proof      rise");

  const mp4Cut = text({ mov: false, final: cut });
  assert.match(mp4Cut[0], /已直接混入成片 MP4,/);
  assert.ok(mp4Cut.some((l) => l.startsWith("时间是剪切后的成片时间。")));
  assert.equal(mp4Cut.at(-1), "0:04.0  stat-proof      rise");

  const mp4NoCut = text({ mov: false, final: nocut });
  assert.ok(mp4NoCut.some((l) => l.startsWith("成片里音效按固定音量")));
  assert.ok(!mp4NoCut.some((l) => l.includes("剪切后")));
  assert.equal(mp4NoCut.at(-1), "0:06.0  stat-proof      rise");

  const bothCut = text({ mov: true, final: cut });
  assert.match(bothCut[0], /已直接混入 MOV 和成片 MP4,/);
  assert.ok(bothCut.some((l) => l.startsWith("左列是 MOV")));
  assert.equal(bothCut.at(-1), "0:06.0  0:04.0  stat-proof      rise");

  const bothNoCut = text({ mov: true, final: nocut }); // 没剪切:两份时间一样,一列就够
  assert.ok(!bothNoCut.some((l) => l.startsWith("左列是 MOV")));
  assert.equal(bothNoCut.at(-1), "0:06.0  stat-proof      rise");
});

test("cutSeconds sums the removed frames", () => {
  assert.equal(cutSeconds([[60, 120], [210, 225]], 30), 2.5);
  assert.equal(cutSeconds([], 30), 0);
});
