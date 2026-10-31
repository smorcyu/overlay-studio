/**
 * 剪掉的时间段(非破坏性):卡片、字幕、口播视频都保持原始时间,
 * 只在「预览播放」和「导出成片 MP4」时跳过这些段。删掉一段剪切,一切原样回来。
 *
 * 导出脚本(scripts/compose-final.mjs)读的是同一份 doc.cuts,规整规则要和这里一致:
 * 丢掉非法段、按起点排序、重叠或相接的段合并。
 */
export interface Cut {
  start: number;
  end: number;
}

/** 剪切段最短时长(秒):比这还短的多半是误按 */
export const MIN_CUT = 0.05;

/** 规整:非法段丢掉,排序,重叠/相接的合并;保留两位小数,和卡片时间同一精度 */
export function normalizeCuts(raw: unknown): Cut[] {
  if (!Array.isArray(raw)) return [];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const list = raw
    .filter(
      (c): c is Cut =>
        !!c &&
        Number.isFinite((c as Cut).start) &&
        Number.isFinite((c as Cut).end) &&
        (c as Cut).end - (c as Cut).start >= MIN_CUT,
    )
    .map((c) => ({ start: r2(Math.max(0, c.start)), end: r2(c.end) }))
    .sort((a, b) => a.start - b.start);
  const out: Cut[] = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

/** t 落在某段剪切里 → 返回那段的终点(播放跳过去);不在 → 原样返回 */
export function skipCut(t: number, cuts: Cut[]): number {
  for (const c of cuts) if (t >= c.start && t < c.end) return c.end;
  return t;
}

/** 剪完之后的成片时长 */
export function keptDuration(duration: number, cuts: Cut[]): number {
  let removed = 0;
  for (const c of cuts) removed += Math.max(0, Math.min(c.end, duration) - Math.min(c.start, duration));
  return Math.max(0, duration - removed);
}
