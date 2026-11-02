/**
 * 导出脚本(export-frames.mjs)里不碰浏览器、不碰文件的那部分计算:截哪几帧、还要多久、
 * 音效清单的时间怎么换算。拆出来是为了能单测 —— 导出脚本本身一跑就起无头 Chrome。
 */
import { inFrameRanges } from "./compose-final.mjs";
import { fmtTime } from "./fmt-time.mjs";

/**
 * 逐帧截图的安排:第 k 帧(从 0 数)写成第几张 PNG,0 = 不截(只推时钟)。
 * 「只导成片」时剪切段里的帧、以及 captureEnd(原片结束)之后的帧不截;普通导出全截。
 * PNG 序号连续编(ffmpeg 读 frame_%06d.png 遇到断号就停)
 */
export function captureSchedule(totalFrames, ranges, captureEnd = totalFrames) {
  let n = 0;
  return Array.from({ length: totalFrames }, (_, k) => (k >= captureEnd || inFrameRanges(ranges, k) ? 0 : ++n));
}

/**
 * 渲染帧还要多少秒。截图的帧和只推时钟的帧耗时差好几倍,分别量平均耗时、乘各自还剩的张数;
 * 还没量到的那种帧先按另一种的耗时估(偏保守),两种都没量到就是 0
 */
export function estimateEta({ leftShot, leftStep, shot, step }) {
  const avg = (c, fallback) => (c.n ? c.ms / c.n : fallback);
  const shotMs = avg(shot, avg(step, 0));
  const stepMs = avg(step, shotMs);
  return Math.max(0, Math.round((leftShot * shotMs + leftStep * stepMs) / 1000));
}

/**
 * 时间轴上的 t 秒在剪切后的成片里是第几秒。inCut:这张卡出现的第一帧(t 之后最近的那一帧)
 * 被剪掉了 —— 它的音效开头也就跟着剪掉了(t 落在剪切段里时换算成那一刀的位置)
 */
export function cutTimelineTime(t, ranges, fps) {
  const f = t * fps;
  const removed = ranges.reduce((n, [s, e]) => n + Math.max(0, Math.min(e, f) - s), 0);
  return { t: t - removed / fps, inCut: inFrameRanges(ranges, Math.ceil(f - 1e-9)) };
}

/**
 * 音效清单的每一行。ranges 为 null:按完整时间轴(MOV 是完整时长);
 * 给了剪切帧段:换成剪切后的成片时间,开头被剪掉的、在成片结束(finalSec)之后的标出来
 */
export function sfxSheetLines(points, ranges, fps, finalSec = null) {
  return points.map((p) => {
    const c = ranges ? cutTimelineTime(p.t, ranges, fps) : { t: p.t, inCut: false };
    const past = ranges && Number.isFinite(finalSec) && c.t >= finalSec;
    const note = past ? "  (在成片结束之后:没混进去)" : c.inCut ? "  (起点在剪切段里:开头被剪掉了)" : "";
    return `${fmtTime(c.t)}  ${p.kind.padEnd(14)}  ${p.sfx}${note}`;
  });
}
