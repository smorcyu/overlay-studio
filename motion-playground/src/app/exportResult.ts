/**
 * 导出接口(/api/export)返回结果 → 给用户看的文字:完成弹窗、失败弹窗、系统通知。
 * 纯函数,单独放这里方便测(tests/exportResult.test.ts)。字段含义见 scripts/export-frames.mjs 里的 result
 */

/** 成片音频实际做了什么(量到的响度、调了多少、音乐用上没有) */
export interface FinalAudioReport {
  loudness: number | null;
  loudnessStatus?: "adjusted" | "ok" | "silent" | "capped" | null;
  gainDb: number;
  bgm: boolean;
}

/** 导出脚本最后一行 JSON(用到的字段) */
export interface ExportResult {
  ok?: boolean;
  error?: string;
  dir?: string | null;
  outputDir?: string;
  frames?: number;
  fps?: number;
  mov?: string | null;
  webm?: string | null;
  final?: string;
  finalOnly?: boolean;
  finalError?: string;
  finalSkipped?: string;
  finalAudio?: FinalAudioReport;
  audioNote?: string;
  sfxNote?: string;
  sfxSheetError?: string;
  composeMissing?: boolean;
  recomposeCmd?: string;
  cutFrames?: number;
  tailFrames?: number;
}

/** 导出完成弹窗里的一行:成片音频实际做了什么 */
export function exportAudioLine(a: FinalAudioReport): string {
  const parts: string[] = [];
  if (a.loudness !== null) {
    const l = `人声响度 ${a.loudness.toFixed(1)} LUFS`;
    const by = `${a.gainDb > 0 ? "提高" : "降低"} ${Math.abs(a.gainDb).toFixed(1)} dB`;
    const after = (a.loudness + a.gainDb).toFixed(1);
    parts.push(
      a.loudnessStatus === "silent"
        ? `${l},基本是静音或底噪,没调(提上去只会放大噪声)`
        : a.loudnessStatus === "capped"
          ? `${l} → ${by}(已到调整上限,成片约 ${after} LUFS,没到 -14)`
          : a.loudnessStatus === "ok" || Math.abs(a.gainDb) < 0.1
            ? `${l},已经合适,没调`
            : `${l} → ${by}`,
    );
  }
  if (a.bgm) parts.push("已混入背景音乐");
  return parts.length ? `🔊 ${parts.join(";")}` : "";
}

/** 导出完成时的系统通知(切去别的应用也能收到) */
export function exportNotification(data: ExportResult): { title: string; body: string } {
  return {
    title: data.mov ? "✅ 动效层导出完成" : data.final ? "✅ 成片导出完成" : "✅ 导出完成",
    body: data.mov
      ? `MOV 已就绪:${String(data.mov).split("/").pop()}`
      : data.final
        ? `成片 MP4 已就绪:${String(data.final).split("/").pop()}`
        : "PNG 序列已就绪",
  };
}

/** 导出成功但既没有 MOV 也没有成片:本机没装 ffmpeg,只拿到 PNG 序列 */
export function exportPngOnlyText(data: ExportResult): string {
  return (
    "⚠️ 只导出了 PNG 序列,没有生成 MOV。\n\n" +
    "原因:本机没有装 ffmpeg(合成透明视频要用它)。\n\n" +
    "装好之后重新导出即可:\n" +
    "  macOS:   brew install ffmpeg\n" +
    "  Windows: winget install --id Gyan.FFmpeg -e\n\n" +
    `PNG 序列已经在这儿了:\n${data.dir}`
  );
}

/** 导出完成弹窗的全文 */
export function exportDoneText(data: ExportResult): string {
  const files = [
    data.final ? `🎬 成片 MP4(原片 + 动效 + 音效,直接能发):\n${data.final}` : null,
    data.finalOnly ? "⚡ 只导成片模式:没有生成透明 MOV/WebM(要进剪映叠的话,在「⚙ 全局设置 → 导出」里关掉再导)" : null,
    data.finalError
      ? `⚠️ 成片没合成(透明 MOV 不受影响):${data.finalError}\n` +
        // 合成参数(compose.json)没写进去时没法单独重合(会按默认值合:不剪切、没有成片音频设置)
        (data.composeMissing
          ? "合成参数(compose.json)也没写进去(多半是磁盘满了),没法单独重合:腾出空间后重新导出"
          : `PNG 序列已保留,修好后可以不重新渲染,在 motion-playground 目录里用同一条口播原片重合:\n` +
            (data.recomposeCmd ?? `node scripts/compose-final.mjs "<口播原片>" "${data.dir ?? "<PNG 目录>"}" "<输出.mp4>"`))
      : null,
    data.finalSkipped ? `ℹ️ ${data.finalSkipped}` : null,
    data.final && data.finalAudio ? exportAudioLine(data.finalAudio) : null,
    data.audioNote ? `⚠️ ${data.audioNote}` : null,
    data.sfxNote ? `⚠️ ${data.sfxNote}` : null,
    data.sfxSheetError ? `⚠️ ${data.sfxSheetError}` : null,
    data.mov ? `🎞 透明 MOV(剪映直接拖):\n${data.mov}` : null,
    data.webm ? `🌐 透明 WebM(小体积):\n${data.webm}` : null,
    data.finalOnly
      ? (() => {
          // 只列真的跳过了的:没剪切时不说「剪切段里的 0 帧」
          const skipped = [
            data.cutFrames ? `剪切段里的 ${data.cutFrames} 帧` : "",
            data.tailFrames ? `口播视频结束之后的 ${data.tailFrames} 帧` : "",
          ].filter(Boolean);
          const notes = [skipped.length ? `${skipped.join("、")}没截` : "", data.dir ? "" : "PNG 中间文件已清理"]
            .filter(Boolean)
            .join(";");
          return `🖼 截了 ${data.frames} 帧 @ ${data.fps}fps${notes ? `(${notes})` : ""}${data.dir ? `:\n${data.dir}` : ""}`;
        })()
      : data.dir
        ? `🖼 PNG 序列 ${data.frames} 帧 @ ${data.fps}fps:\n${data.dir}`
        : `🖼 共 ${data.frames} 帧 @ ${data.fps}fps(PNG 中间文件已清理)`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // 成片到手后 PNG 目录会被清理(dir 为 null),这里给成品目录
  return `✅ 导出完成!\n\n${files}\n\n文件夹:\n${data.outputDir ?? data.dir}`;
}

/** 导出失败弹窗:只显示最后一段【导出失败原因】(前面是一大堆日志) */
export function exportFailText(error: unknown): string {
  const raw = String(error ?? "未知错误");
  const i = raw.lastIndexOf("【导出失败原因】");
  return `❌ 导出失败\n\n${i === -1 ? raw : raw.slice(i)}`;
}
