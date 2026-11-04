import { test } from "node:test";
import assert from "node:assert/strict";
import { exportProgressView } from "../src/app/exportProgress.ts";

const p = (stage: string, extra: Record<string, unknown> = {}) => ({ stage, frame: 0, total: 0, ...extra });

test("exportProgressView: before the first status and while extracting", () => {
  assert.deepEqual(exportProgressView(null), { pct: 2, text: "准备中(启动渲染器)…" });
  assert.equal(exportProgressView(p("extract")).pct, 2);
  assert.match(exportProgressView(p("extract")).text, /预处理素材/);
});

test("exportProgressView: frames fill 0–80% and format the ETA", () => {
  assert.deepEqual(exportProgressView(p("frames", { frame: 50, total: 100 })), { pct: 40, text: "渲染帧 50/100 · 预计还需 估算中" });
  assert.equal(exportProgressView(p("frames", { frame: 1, total: 1000 })).pct, 2, "never below 2%");
  assert.equal(exportProgressView(p("frames", { frame: 10, total: 100, etaSec: 45 })).text, "渲染帧 10/100 · 预计还需 45 秒");
  assert.equal(exportProgressView(p("frames", { frame: 10, total: 100, etaSec: 125 })).text, "渲染帧 10/100 · 预计还需 2 分 5 秒");
  // total 还没报上来时当作准备中
  assert.equal(exportProgressView(p("frames")).text, "准备中(启动渲染器)…");
});

test("exportProgressView: compose stages, normal vs final-only", () => {
  assert.equal(exportProgressView(p("mov")).pct, 84);
  assert.equal(exportProgressView(p("webm")).pct, 93);
  assert.deepEqual(exportProgressView(p("sfx")), { pct: 98, text: "把音效混进 MOV…" });
  assert.deepEqual(exportProgressView(p("sfx", { finalOnly: true })), { pct: 80, text: "混音效…" });
  assert.equal(exportProgressView(p("final")).pct, 99);
  assert.match(exportProgressView(p("final")).text, /长视频这步要几分钟/);
  assert.deepEqual(exportProgressView(p("final", { finalOnly: true, finalPct: 50 })), {
    pct: 90,
    text: "合成成片 MP4 50%(原片 + 动效层 + 音效)…",
  });
  assert.equal(exportProgressView(p("final", { finalOnly: true, finalPct: 100 })).pct, 99);
});
