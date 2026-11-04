import type { OverlayDoc } from "../overlay/types";

/** 编排体检:密度(张/分钟)+ 同屏峰值,顶栏一眼看节奏够不够紧。没有卡片时为 null */
export function overlayStats(overlay: OverlayDoc | null): { peak: number; perMin: number } | null {
  if (!overlay || overlay.cards.length === 0) return null;
  const evs = overlay.cards
    .flatMap((c) => [[c.start, 1], [c.end, -1]] as [number, number][])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of evs) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  const span = Math.max(...overlay.cards.map((c) => c.end));
  return { peak, perMin: overlay.cards.length / Math.max(span / 60, 0.1) };
}
