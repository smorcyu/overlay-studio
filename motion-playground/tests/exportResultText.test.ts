import { test } from "node:test";
import assert from "node:assert/strict";
import { exportAudioLine, exportFailView, exportNotification, exportResultView } from "../src/app/exportResult.ts";

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

test("exportResultView: no MOV and no final MP4 → PNG-only view with copyable ffmpeg install commands", () => {
  const v = exportResultView({ ok: true, dir: "/x/frames", frames: 9 });
  assert.equal(v.kind, "png-only");
  assert.deepEqual(v.files, [{ icon: "🖼", label: "PNG 序列(9 帧)", path: "/x/frames" }]);
  assert.deepEqual(v.notes.map((n) => n.cmd).filter(Boolean), ["brew install ffmpeg", "winget install --id Gyan.FFmpeg -e"]);
  assert.equal(v.folder, "/x/frames");
});

test("exportResultView: normal export lists MP4, MOV, WebM, sheets and the PNG folder in order", () => {
  const v = exportResultView({
    ok: true,
    final: "/o/a.mp4",
    mov: "/o/a.mov",
    webm: "/o/a.webm",
    sfxSheet: "/o/a-音效清单.txt",
    camNote: "/o/a-合成说明.txt",
    dir: "/o/frames",
    frames: 300,
    fps: 29.97,
    outputDir: "/o",
    finalAudio: { loudness: -20, loudnessStatus: "adjusted", gainDb: 6, bgm: false },
  });
  assert.equal(v.kind, "done");
  assert.equal(v.title, "✅ 导出完成");
  assert.deepEqual(
    v.files.map((f) => [f.icon, f.path]),
    [["🎬", "/o/a.mp4"], ["🎞", "/o/a.mov"], ["🌐", "/o/a.webm"], ["📝", "/o/a-音效清单.txt"], ["📝", "/o/a-合成说明.txt"], ["🖼", "/o/frames"]],
  );
  assert.deepEqual(v.notes, [{ level: "info", text: "🔊 人声响度 -20.0 LUFS → 提高 6.0 dB" }]);
  assert.equal(v.summary, "共 300 帧 @ 29.97fps");
  assert.equal(v.folder, "/o");
});

test("exportResultView: final-only mode names the skipped frames and the cleaned PNGs", () => {
  const v = exportResultView({ ok: true, final: "/o/a.mp4", finalOnly: true, dir: null, frames: 120, fps: 29.97, cutFrames: 60, tailFrames: 15, outputDir: "/o" });
  assert.match(v.notes[0].text, /⚡ 只导了成片.*点「⬇ 透明 MOV」再导一次/);
  assert.equal(v.summary, "截了 120 帧 @ 29.97fps(剪切段里的 60 帧、口播视频结束之后的 15 帧没截;PNG 中间文件已清理)");
  assert.deepEqual(v.files.map((f) => f.path), ["/o/a.mp4"]);
  // 没跳过任何帧时不说「0 帧」;PNG 留着时列在成品里
  const v2 = exportResultView({ ok: true, final: "/o/a.mp4", finalOnly: true, dir: "/o/f", frames: 10, fps: 30, outputDir: "/o" });
  assert.equal(v2.summary, "截了 10 帧 @ 30fps");
  assert.ok(v2.files.some((f) => f.path === "/o/f"));
  // 普通导出 PNG 清理掉了
  assert.equal(exportResultView({ ok: true, mov: "/o/a.mov", dir: null, frames: 5, fps: 30 }).summary, "共 5 帧 @ 30fps(PNG 中间文件已清理)");
});

test("exportResultView: a failed final compose shows the recompose command, or says compose.json is missing", () => {
  const withCmd = exportResultView({ ok: true, mov: "/o/a.mov", finalError: "ffmpeg died", dir: "/o/f", recomposeCmd: "node scripts/compose-final.mjs X", frames: 1, fps: 30 });
  assert.equal(withCmd.notes[0].text, "⚠️ 成片没合成(透明 MOV 不受影响):ffmpeg died");
  assert.equal(withCmd.notes[0].level, "warn");
  assert.equal(withCmd.notes[1].cmd, "node scripts/compose-final.mjs X");
  assert.equal(withCmd.folder, "/o/f", "no outputDir → falls back to the PNG folder");
  const noCmd = exportResultView({ ok: true, mov: "/o/a.mov", finalError: "x", dir: "/o/f", frames: 1, fps: 30 });
  assert.equal(noCmd.notes[1].cmd, 'node scripts/compose-final.mjs "<口播原片>" "/o/f" "<输出.mp4>"');
  const missing = exportResultView({ ok: true, mov: "/o/a.mov", finalError: "x", composeMissing: true, dir: "/o/f", frames: 1, fps: 30 });
  assert.ok(missing.notes[1].text.includes("compose.json") && missing.notes[1].text.includes("也没写进去"));
  assert.ok(missing.notes.every((n) => !n.cmd));
});

test("exportResultView: audio line only with a final MP4; warnings come out as warn notes", () => {
  const audio = { loudness: -14, loudnessStatus: "ok" as const, gainDb: 0, bgm: false };
  assert.ok(exportResultView({ ok: true, mov: "/o/a.mov", finalAudio: audio, frames: 1, fps: 30 }).notes.every((n) => !n.text.startsWith("🔊")));
  const v = exportResultView({ ok: true, mov: "/o/a.mov", audioNote: "a", sfxNote: "b", sfxSheetError: "c", finalSkipped: "d", frames: 1, fps: 30 });
  assert.deepEqual(v.notes, [
    { level: "info", text: "ℹ️ d" },
    { level: "warn", text: "⚠️ a" },
    { level: "warn", text: "⚠️ b" },
    { level: "warn", text: "⚠️ c" },
  ]);
});

test("exportFailView keeps only the last 失败原因 section", () => {
  assert.equal(exportFailView("log...\n【导出失败原因】a\nmore\n【导出失败原因】磁盘满了").error, "【导出失败原因】磁盘满了");
  assert.equal(exportFailView("boom").error, "boom");
  const v = exportFailView(undefined);
  assert.equal(v.error, "未知错误");
  assert.equal(v.kind, "failed");
  assert.equal(v.folder, null);
});
