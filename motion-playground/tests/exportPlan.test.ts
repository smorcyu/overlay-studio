import { test } from "node:test";
import assert from "node:assert/strict";
import {
  camNoteText, captureSchedule, cutSeconds, cutTimelineTime, emptyFrameMask, estimateEta, estimateNeedBytes, preCutPlan, sfxMissingNote,
  sfxSheetLines, sfxSheetText,
} from "../scripts/export-plan.mjs";
import { fmtTime } from "../scripts/fmt-time.mjs";

test("estimateNeedBytes: normal export counts PNG + ProRes (+ final MP4); final-only counts captured PNGs + MP4", () => {
  const MB = 1024 * 1024;
  const G2 = 2 * 1024 ** 3;
  const base = { duration: 10, normalFinalSec: 0, capturedFrames: 0, fps: 30, finalSec: 0 };
  assert.equal(estimateNeedBytes({ ...base, finalOnly: false }), 10 * 43 * MB + G2);
  assert.equal(estimateNeedBytes({ ...base, finalOnly: false, normalFinalSec: 60 }), 10 * 43 * MB + 60 * 3 * MB + G2);
  assert.equal(estimateNeedBytes({ ...base, finalOnly: true, capturedFrames: 150, finalSec: 40 }), 5 * 14 * MB + 40 * 3 * MB + G2);
});

test("camNoteText lists each baked-in segment with its time", () => {
  const t = camNoteText("timeline-1", [{ start: 8.5, end: 11, kind: "focus-card" }, { start: 59.96, end: 62, kind: "focus-card" }]);
  assert.match(t, /^合成说明 · timeline-1\n/);
  assert.match(t, /有 2 段把口播人物烤了进去/);
  assert.ok(t.includes("  0:08.5 — 0:11.0   focus-card"));
  assert.ok(t.includes("  1:00.0 — 1:02.0   focus-card"));
});

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

test("estimateEta: empty frames get their own timing, falling back to clock-only frames", () => {
  const shot = { ms: 1000, n: 10 }; // 每张 100ms
  const step = { ms: 200, n: 10 }; // 每帧 20ms
  const empty = { ms: 50, n: 10 }; // 每帧 5ms
  assert.equal(estimateEta({ leftShot: 10, leftStep: 0, leftEmpty: 200, shot, step, empty }), 2); // 1s + 1s
  // 还没遇到过空帧:按只推时钟的帧估;连那个也没有就按截图的
  assert.equal(estimateEta({ leftShot: 0, leftStep: 0, leftEmpty: 100, shot, step }), 2);
  assert.equal(estimateEta({ leftShot: 0, leftStep: 0, leftEmpty: 10, shot, step: { ms: 0, n: 0 } }), 1);
  // 一开头就是空帧:截图的帧先按空帧的耗时估
  assert.equal(estimateEta({ leftShot: 400, leftStep: 0, leftEmpty: 0, shot: { ms: 0, n: 0 }, step: { ms: 0, n: 0 }, empty }), 2);
});

test("emptyFrameMask: a frame is empty when no card is mounted (start − 0.05 ≤ t < end)", () => {
  const cards = [{ start: 1, end: 2 }, { start: 1.5, end: 3 }];
  // 10fps:第 k 帧 t = k/10
  const m = emptyFrameMask(cards, 40, 10);
  const nonEmpty = m.flatMap((e, k) => (e ? [] : [k]));
  // 0.95 就挂上(第 10 帧 t=1.0 之前的第 9 帧 t=0.9 还空着);end=3 那一帧已经卸掉
  assert.deepEqual(nonEmpty, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assert.equal(m[9], true);
  assert.equal(m[30], true);
  // 提前 0.05s 挂载:start=1.04 时 t=1.0 已经挂上
  assert.equal(emptyFrameMask([{ start: 1.04, end: 2 }], 20, 10)[10], false);
  assert.equal(emptyFrameMask([{ start: 1.06, end: 2 }], 20, 10)[10], true);
  assert.deepEqual(emptyFrameMask([], 3, 30), [true, true, true]);
  assert.deepEqual(emptyFrameMask(undefined, 2, 30), [true, true]);
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
    "0:18.0  checklist       ding  (在成片结束之后:成片里没有)",
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
  // 原片比时间轴短、卡在原片结束之后:MOV 里有,成片里没有 —— 标注要说清是成片
  const late = sfxSheetText({ title: "t", points: [{ t: 25, kind: "stat-proof", sfx: "rise" }], fps: 30, mov: true, final: { ranges: [], finalSec: 20 } });
  assert.equal(late.split("\n").at(-1), "0:25.0  stat-proof      rise  (在成片结束之后:成片里没有)");
});

test("cutSeconds sums the removed frames", () => {
  assert.equal(cutSeconds([[60, 120], [210, 225]], 30), 2.5);
  assert.equal(cutSeconds([], 30), 0);
});

test("sfxMissingNote says which outputs lack sound effects, based on what was actually produced", () => {
  const n = (o: Partial<{ count: number; mixOk: boolean; mov: boolean; movBaked: boolean; final: boolean }>) =>
    sfxMissingNote({ count: 3, mixOk: true, mov: true, movBaked: true, final: true, ...o });
  assert.equal(n({}), null); // 都好好的
  assert.equal(n({ count: 0, mixOk: false }), null); // 没有音效点
  assert.equal(n({ mixOk: false, movBaked: false }), "3 个音效没混成(多半是 public/sfx/ 里有音效文件读不了),MOV 和成片里都没有音效");
  assert.equal(n({ mixOk: false, mov: false, movBaked: false }), "3 个音效没混成(多半是 public/sfx/ 里有音效文件读不了),成片里没有音效"); // 只导成片
  assert.equal(n({ movBaked: false }), "音效没封进 MOV(多半是磁盘满了),MOV 里没有音效;成片里照常有");
  // 成片没合出来:不提成片
  assert.equal(n({ mixOk: false, movBaked: false, final: false }), "3 个音效没混成(多半是 public/sfx/ 里有音效文件读不了),MOV 里没有音效");
  assert.equal(n({ movBaked: false, final: false }), "音效没封进 MOV(多半是磁盘满了),MOV 里没有音效");
});

test("preCutPlan with an unreadable footage length: cuts unlimited, capture the whole timeline", () => {
  const p = preCutPlan({ cuts: [{ start: 2, end: 4 }, { start: 9, end: 30 }], fpsArg: "30", footageDuration: null, timelineFrames: 360 });
  assert.deepEqual(p.skipFrames, [[60, 120], [270, 900]]); // 不按原片长度截:第二刀照写到 30s
  assert.equal(p.captureEnd, 360);
  assert.equal(p.schedule.filter(Boolean).length, 360 - 60 - 90);
  // 读得到时长:越过结尾的那一刀截到原片结尾,截到原片结束(含 1 帧余量)
  const q = preCutPlan({ cuts: [{ start: 9, end: 30 }], fpsArg: "30", footageDuration: 10, timelineFrames: 360 });
  assert.deepEqual(q.skipFrames, [[270, 300]]);
  assert.equal(q.captureEnd, 301);
});
