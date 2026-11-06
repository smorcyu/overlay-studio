/**
 * 让浏览器把一段文字存成文件(导出 JSON / 导出 SRT 共用)。
 * 对象地址晚一点再收回:点完立刻 revoke 的话,Safari 有时候下载还没开始地址就没了,存不下来
 */
export function downloadText(text: string, filename: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  const href = a.href;
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/**
 * 按视频名起文件名:/_media/口播-第3期.mp4 → 口播-第3期.srt。
 * 没有视频、或地址解不开(blob: 之类)时用 fallback
 */
export function nameFromVideo(videoUrl: string | null | undefined, ext: string, fallback: string): string {
  if (!videoUrl || !videoUrl.startsWith("/_media/")) return fallback;
  let base: string;
  try {
    base = decodeURIComponent(videoUrl.split("?")[0].split("/").pop() ?? "");
  } catch {
    return fallback;
  }
  const stem = base.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  return stem ? `${stem}.${ext}` : fallback;
}
