/**
 * 导出接口(/api/export)返回结果 → 给用户看的东西:结果面板(ExportResultPanel)、系统通知。
 * 纯函数,单独放这里方便测(tests/exportResultText.test.ts)。字段含义见 scripts/export-frames.mjs 里的 result
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
  sfxSheet?: string;
  sfxSheetError?: string;
  camNote?: string;
  composeMissing?: boolean;
  recomposeCmd?: string;
  cutFrames?: number;
  tailFrames?: number;
}

/** 面板里的一个产出:文件或文件夹,可以复制路径、在文件夹里显示 */
export interface ResultFile {
  icon: string;
  label: string;
  path: string;
}

/** 面板里的一条说明。cmd:可以复制的一条命令(装 ffmpeg、单独重合成片) */
export interface ResultNote {
  level: "info" | "warn";
  text: string;
  cmd?: string;
}

/** 结果面板显示什么 */
export interface ExportResultView {
  kind: "done" | "png-only" | "failed";
  title: string;
  files: ResultFile[];
  notes: ResultNote[];
  /** 截了多少帧之类的一行小字 */
  summary?: string;
  /** 「打开文件夹」打开哪个(成品目录;没有时为 null) */
  folder: string | null;
  /** 失败原因(只有 failed 有) */
  error?: string;
}

/** 导出完成面板里的一行:成片音频实际做了什么 */
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

/** 导出成功(ok)时面板显示什么:成品、提醒、帧数。既没有 MOV 也没有成片 = 本机没装 ffmpeg,只拿到 PNG 序列 */
export function exportResultView(data: ExportResult): ExportResultView {
  if (!data.mov && !data.final) {
    return {
      kind: "png-only",
      title: "⚠️ 只导出了 PNG 序列,没有生成 MOV",
      files: data.dir ? [{ icon: "🖼", label: `PNG 序列(${data.frames} 帧)`, path: data.dir }] : [],
      notes: [
        { level: "warn", text: "本机没有装 ffmpeg(合成透明视频要用它)。装好之后重新导出即可:" },
        { level: "info", text: "macOS", cmd: "brew install ffmpeg" },
        { level: "info", text: "Windows", cmd: "winget install --id Gyan.FFmpeg -e" },
      ],
      folder: data.dir ?? null,
    };
  }

  const files: ResultFile[] = [];
  if (data.final) files.push({ icon: "🎬", label: "成片 MP4(原片 + 动效 + 音效,直接能发)", path: data.final });
  if (data.mov) files.push({ icon: "🎞", label: "透明 MOV(剪映直接拖)", path: data.mov });
  if (data.webm) files.push({ icon: "🌐", label: "透明 WebM(小体积)", path: data.webm });
  if (data.sfxSheet) files.push({ icon: "📝", label: "音效清单", path: data.sfxSheet });
  if (data.camNote) files.push({ icon: "📝", label: "合成说明(剪映里哪几段要盖住原始口播轨)", path: data.camNote });
  // PNG 中间目录只在留着时才有(成片到手后会清理成 null)
  if (data.dir) files.push({ icon: "🖼", label: "PNG 序列", path: data.dir });

  const notes: ResultNote[] = [];
  if (data.finalOnly)
    notes.push({ level: "info", text: "⚡ 只导了成片:没有生成透明 MOV/WebM(要进剪映叠的话,点「⬇ 透明 MOV」再导一次)" });
  if (data.finalError) {
    notes.push({ level: "warn", text: `⚠️ 成片没合成(透明 MOV 不受影响):${data.finalError}` });
    // 合成参数(compose.json)没写进去时没法单独重合(会按默认值合:不剪切、没有成片音频设置)
    if (data.composeMissing)
      notes.push({
        level: "warn",
        text: "合成参数(compose.json)也没写进去(多半是磁盘满了),没法单独重合:腾出空间后重新导出",
      });
    else
      notes.push({
        level: "info",
        text: "PNG 序列已保留,修好后可以不重新渲染,在 motion-playground 目录里用同一条口播原片重合:",
        cmd:
          data.recomposeCmd ??
          `node scripts/compose-final.mjs "<口播原片>" "${data.dir ?? "<PNG 目录>"}" "<输出.mp4>"`,
      });
  }
  if (data.finalSkipped) notes.push({ level: "info", text: `ℹ️ ${data.finalSkipped}` });
  if (data.final && data.finalAudio) {
    const line = exportAudioLine(data.finalAudio);
    if (line) notes.push({ level: "info", text: line });
  }
  for (const w of [data.audioNote, data.sfxNote, data.sfxSheetError])
    if (w) notes.push({ level: "warn", text: `⚠️ ${w}` });

  let summary: string;
  if (data.finalOnly) {
    // 只列真的跳过了的:没剪切时不说「剪切段里的 0 帧」
    const skipped = [
      data.cutFrames ? `剪切段里的 ${data.cutFrames} 帧` : "",
      data.tailFrames ? `口播视频结束之后的 ${data.tailFrames} 帧` : "",
    ].filter(Boolean);
    const extra = [skipped.length ? `${skipped.join("、")}没截` : "", data.dir ? "" : "PNG 中间文件已清理"]
      .filter(Boolean)
      .join(";");
    summary = `截了 ${data.frames} 帧 @ ${data.fps}fps${extra ? `(${extra})` : ""}`;
  } else {
    summary = `共 ${data.frames} 帧 @ ${data.fps}fps${data.dir ? "" : "(PNG 中间文件已清理)"}`;
  }

  return {
    kind: "done",
    title: "✅ 导出完成",
    files,
    notes,
    summary,
    // 成片到手后 PNG 目录会被清理(dir 为 null),这里给成品目录
    folder: data.outputDir ?? data.dir ?? null,
  };
}

/** 导出失败时面板显示什么:只显示最后一段【导出失败原因】(前面是一大堆日志) */
export function exportFailView(error: unknown): ExportResultView {
  const raw = String(error ?? "未知错误");
  const i = raw.lastIndexOf("【导出失败原因】");
  return { kind: "failed", title: "❌ 导出失败", files: [], notes: [], folder: null, error: i === -1 ? raw : raw.slice(i) };
}
