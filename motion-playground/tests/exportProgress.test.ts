import { test } from "node:test";
import assert from "node:assert/strict";
import { applyExportOutput } from "../scripts/export-progress.mjs";

const fresh = () => ({ stage: "prep", frame: 0, total: 0 }) as {
  stage: string; frame: number; total: number; etaSec?: number; finalPct?: number;
};

test("export progress: frame count and ETA come from the same line", () => {
  const p = applyExportOutput(fresh(), "rendering frames: 360\nprogress 30/360 eta 27\nprogress 60/360 eta 25\n");
  assert.deepEqual(p, { stage: "frames", frame: 60, total: 360, etaSec: 25 });
});

test("export progress: the total is known as soon as rendering starts (no fallback to the start-up text)", () => {
  assert.deepEqual(applyExportOutput(fresh(), "rendering frames: 361\n"), { stage: "frames", frame: 0, total: 361 });
  // 抽帧之后开跑:从 extract 进 frames
  const p = applyExportOutput(fresh(), "extracting video frames: a.mp4\n");
  assert.equal(p.stage, "extract");
  assert.equal(applyExportOutput(p, "extracting video frames: a.mp4\nrendering frames: 90\n").stage, "frames");
});

test("export progress: a half-received line is ignored until it is complete", () => {
  const p = applyExportOutput(fresh(), "rendering frames: 900\nprogress 270/900 eta 130\nprogress 300/900 eta 1");
  assert.equal(p.frame, 270);
  assert.equal(p.etaSec, 130); // 不是半行里的 1
  applyExportOutput(p, "rendering frames: 900\nprogress 270/900 eta 130\nprogress 300/900 eta 125\n");
  assert.equal(p.frame, 300);
  assert.equal(p.etaSec, 125);
});

test("export progress: final-progress is not read as a frame count; stages follow the log", () => {
  const log = [
    "rendering frames: 360", "progress 360/360 eta 0", "final-only: skip MOV/WebM",
    "baking 3 sfx into the final MP4 mix...", "composing final MP4 (footage + overlay)...",
    "final-progress 7/100", "final-progress 42/100", "",
  ].join("\n");
  const p = applyExportOutput(fresh(), log);
  assert.equal(p.stage, "final");
  assert.equal(p.frame, 360);
  assert.equal(p.total, 360);
  assert.equal(p.finalPct, 42);
  // 读不到原片时长时是「final-progress ?/100」:不更新百分比
  assert.equal(applyExportOutput(fresh(), "composing final MP4\nfinal-progress ?/100\n").finalPct, undefined);
  // 普通导出的阶段
  assert.equal(applyExportOutput(fresh(), "progress 360/360 eta 0\ncomposing MOV (ProRes 4444 alpha)...\n").stage, "mov");
  assert.equal(applyExportOutput(fresh(), "composing MOV\ncomposing WebM (VP9 alpha)...\n").stage, "webm");
});

test("export progress: the exporter's actual progress line format is what the parser expects", async () => {
  // 导出脚本里打进度的那一行:改了格式这里要跟着改,不然界面会一直「估算中」
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../scripts/export-frames.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("console.log(`progress ${i}/${renderFrames} eta ${eta}`);"));
  assert.ok(src.includes("console.log(`rendering frames: ${renderFrames}`);"));
});
