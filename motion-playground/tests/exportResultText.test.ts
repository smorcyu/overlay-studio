import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportAudioLine,
  exportDoneText,
  exportFailText,
  exportNotification,
  exportPngOnlyText,
} from "../src/app/exportResult.ts";

test("exportAudioLine: each loudness status and the bgm note", () => {
  assert.equal(exportAudioLine({ loudness: -20, loudnessStatus: "adjusted", gainDb: 6, bgm: false }), "🔊 人声响度 -20.0 LUFS → 提高 6.0 dB");
  assert.equal(exportAudioLine({ loudness: -10, loudnessStatus: "adjusted", gainDb: -4, bgm: true }), "🔊 人声响度 -10.0 LUFS → 降低 4.0 dB;已混入背景音乐");
  assert.equal(exportAudioLine({ loudness: -14.02, loudnessStatus: "ok", gainDb: 0, bgm: false }), "🔊 人声响度 -14.0 LUFS,已经合适,没调");
  assert.equal(exportAudioLine({ loudness: -14, gainDb: 0.05, bgm: false }), "🔊 人声响度 -14.0 LUFS,已经合适,没调");
  assert.match(exportAudioLine({ loudness: -60, loudnessStatus: "silent", gainDb: 0, bgm: false }), /静音或底噪/);
  assert.equal(
    exportAudioLine({ loudness: -40, loudnessStatus: "capped", gainDb: 20, bgm: false }),
    "🔊 人声响度 -40.0 LUFS → 提高 20.0 dB(已到调整上限,成片约 -20.0 LUFS,没到 -14)",
  );
  assert.equal(exportAudioLine({ loudness: null, gainDb: 0, bgm: true }), "🔊 已混入背景音乐");
  assert.equal(exportAudioLine({ loudness: null, gainDb: 0, bgm: false }), "");
});

test("exportNotification: MOV wins, then the final MP4, then PNG only", () => {
  assert.deepEqual(exportNotification({ mov: "/x/out/a.mov", final: "/x/out/a.mp4" }), {
    title: "✅ 动效层导出完成",
    body: "MOV 已就绪:a.mov",
  });
  assert.deepEqual(exportNotification({ mov: null, final: "/x/out/a-final.mp4" }), {
    title: "✅ 成片导出完成",
    body: "成片 MP4 已就绪:a-final.mp4",
  });
  assert.deepEqual(exportNotification({}), { title: "✅ 导出完成", body: "PNG 序列已就绪" });
});

test("exportPngOnlyText points at the PNG folder and how to install ffmpeg", () => {
  const t = exportPngOnlyText({ dir: "/x/frames" });
  assert.match(t, /brew install ffmpeg/);
  assert.ok(t.endsWith("PNG 序列已经在这儿了:\n/x/frames"));
});

test("exportDoneText: normal export lists MP4, MOV, WebM and the PNG folder in order", () => {
  const t = exportDoneText({
    ok: true,
    final: "/o/a.mp4",
    mov: "/o/a.mov",
    webm: "/o/a.webm",
    dir: "/o/frames",
    frames: 300,
    fps: 29.97,
    outputDir: "/o",
    finalAudio: { loudness: -20, loudnessStatus: "adjusted", gainDb: 6, bgm: false },
  });
  assert.equal(
    t,
    "✅ 导出完成!\n\n" +
      "🎬 成片 MP4(原片 + 动效 + 音效,直接能发):\n/o/a.mp4\n\n" +
      "🔊 人声响度 -20.0 LUFS → 提高 6.0 dB\n\n" +
      "🎞 透明 MOV(剪映直接拖):\n/o/a.mov\n\n" +
      "🌐 透明 WebM(小体积):\n/o/a.webm\n\n" +
      "🖼 PNG 序列 300 帧 @ 29.97fps:\n/o/frames\n\n" +
      "文件夹:\n/o",
  );
});

test("exportDoneText: final-only mode names the skipped frames and the cleaned PNGs", () => {
  const t = exportDoneText({ ok: true, final: "/o/a.mp4", finalOnly: true, dir: null, frames: 120, fps: 29.97, cutFrames: 60, tailFrames: 15, outputDir: "/o" });
  assert.match(t, /⚡ 只导了成片.*点「⬇ 透明 MOV」再导一次/);
  assert.ok(t.endsWith("🖼 截了 120 帧 @ 29.97fps(剪切段里的 60 帧、口播视频结束之后的 15 帧没截;PNG 中间文件已清理)\n\n文件夹:\n/o"), t);
  // 没跳过任何帧时不说「0 帧」
  const t2 = exportDoneText({ ok: true, final: "/o/a.mp4", finalOnly: true, dir: "/o/f", frames: 10, fps: 30, outputDir: "/o" });
  assert.match(t2, /🖼 截了 10 帧 @ 30fps:\n\/o\/f/);
});

test("exportDoneText: a failed final compose shows the recompose command, or says compose.json is missing", () => {
  const withCmd = exportDoneText({ ok: true, mov: "/o/a.mov", finalError: "ffmpeg died", dir: "/o/f", recomposeCmd: "node scripts/compose-final.mjs X", frames: 1, fps: 30 });
  assert.ok(withCmd.includes("⚠️ 成片没合成(透明 MOV 不受影响):ffmpeg died\nPNG 序列已保留") && withCmd.includes("重合:\nnode scripts/compose-final.mjs X"), withCmd);
  assert.ok(withCmd.endsWith("文件夹:\n/o/f"), "no outputDir → falls back to the PNG folder");
  const noCmd = exportDoneText({ ok: true, mov: "/o/a.mov", finalError: "x", dir: "/o/f", frames: 1, fps: 30 });
  assert.match(noCmd, /node scripts\/compose-final\.mjs "<口播原片>" "\/o\/f" "<输出\.mp4>"/);
  const missing = exportDoneText({ ok: true, mov: "/o/a.mov", finalError: "x", composeMissing: true, dir: "/o/f", frames: 1, fps: 30 });
  assert.ok(missing.includes("compose.json") && missing.includes("也没写进去"));
  assert.doesNotMatch(missing, /compose-final\.mjs/);
});

test("exportDoneText: audio line only when there is a final MP4", () => {
  const audio = { loudness: -14, loudnessStatus: "ok" as const, gainDb: 0, bgm: false };
  assert.doesNotMatch(exportDoneText({ ok: true, mov: "/o/a.mov", finalAudio: audio, frames: 1, fps: 30 }), /🔊/);
});

test("exportFailText keeps only the last 失败原因 section", () => {
  assert.equal(exportFailText("log...\n【导出失败原因】a\nmore\n【导出失败原因】磁盘满了"), "❌ 导出失败\n\n【导出失败原因】磁盘满了");
  assert.equal(exportFailText("boom"), "❌ 导出失败\n\nboom");
  assert.equal(exportFailText(undefined), "❌ 导出失败\n\n未知错误");
});
