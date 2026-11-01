/**
 * 人声响度统一:目标值、增益怎么算、怎么从 ffmpeg 的 ebur128 输出里读响度。
 * 成片合成(compose-final.mjs)和编辑台预览(vite.config.ts 的 /api/loudness)共用这一份,
 * 预览里听到的增益和成片里用的是同一个数。
 */

/** 人声响度统一的目标:-14 LUFS(各大视频平台的常见目标) */
export const LOUDNESS_TARGET = -14;
/** 响度增益最多调这么多 dB:再多多半是测错了或者原片几乎没声音,硬提只会放大噪声 */
export const MAX_GAIN_DB = 20;
/** 低于这个响度基本就是静音或底噪,不提(提了只会把噪声放大) */
export const SILENT_LUFS = -60;

/**
 * 量 file 第一条音轨积分响度的 ffmpeg 参数。framelog=verbose 让每 100ms 一行的逐帧读数
 * 只在 verbose 日志级别打印,默认级别下只剩汇总,stderr 不会随片长涨到几十 MB
 */
export function ebur128Args(file) {
  return ["-nostats", "-hide_banner", "-i", file, "-map", "0:a:0", "-af", "ebur128=framelog=verbose", "-f", "null", "-"];
}

/**
 * 从 ebur128 的输出里取积分响度。汇总里是「Integrated loudness: … I: -23.4 LUFS」;
 * 万一逐帧行也打出来了(它们也带 I:),取最后一个 —— 汇总总在最后。
 */
export function parseLoudness(stderr) {
  const all = [...String(stderr ?? "").matchAll(/\bI:\s+(-?[\d.]+|-inf)\s+LUFS/g)];
  const v = all.length ? Number(all[all.length - 1][1]) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** 从量到的响度算增益(dB):拉到 LOUDNESS_TARGET,最多 ±MAX_GAIN_DB;太轻(静音/底噪)不提 */
export function loudnessGain(lufs) {
  if (!Number.isFinite(lufs) || lufs < SILENT_LUFS) return 0;
  return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, LOUDNESS_TARGET - lufs));
}

/** 响度调整的结果给人看:adjusted 调了 / ok 本来就合适 / silent 太轻没调 / capped 调到上限还没到目标 */
export function loudnessStatus(lufs) {
  if (!Number.isFinite(lufs)) return null;
  if (lufs < SILENT_LUFS) return "silent";
  const need = LOUDNESS_TARGET - lufs;
  if (Math.abs(need) > MAX_GAIN_DB) return "capped";
  return Math.abs(need) < 0.1 ? "ok" : "adjusted";
}
