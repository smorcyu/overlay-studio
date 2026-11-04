/**
 * 自动保存:编排随手存进浏览器(localStorage),下次打开自动恢复。
 * 这里只放存档格式的读写(纯函数,tests/autosave.test.ts),什么时候存/恢复在 App 里
 */
import { parseOverlay, type OverlayDoc } from "../overlay/types";
import type { SrtLine } from "../overlay/srt";
import { normalizeCuts, type Cut } from "../overlay/cuts";

export const AUTOSAVE_KEY = "overlayStudioAutosave";
/** 首次打开引导弹过没有(一次性标记) */
export const WELCOME_KEY = "overlayStudioWelcomed";

/** 剪切建议里点过「忽略」的段,跟着口播视频走 */
export type Dismissed = { video: string | null; cuts: Cut[] };

export interface AutosaveState {
  overlay: OverlayDoc;
  origin: OverlayDoc | null;
  srt: SrtLine[] | null;
  videoUrl: string | null;
  dismissed: Dismissed | null;
}

/** 存档 JSON 的内容 */
export function autosavePayload(s: {
  overlay: OverlayDoc;
  origin: OverlayDoc | null;
  srt: SrtLine[] | null;
  videoUrl: string | null;
  dismissed: Dismissed;
  now: Date;
}) {
  return {
    overlay: s.overlay,
    origin: s.origin,
    srt: s.srt,
    // 只存落盘过的真实路径;blob 地址刷新即失效,存了也是坏的
    videoUrl: s.videoUrl?.startsWith("/_media/") ? s.videoUrl : undefined,
    dismissed: s.dismissed.cuts.length ? s.dismissed : undefined,
    savedAt: s.now.toISOString(),
  };
}

/**
 * 读存档。没有卡片的存档不恢复编排(overlay 为 null),但落盘过的视频地址照样给出来。
 * 坏 JSON 直接抛,调用方忽略
 */
export function parseAutosave(raw: string): {
  state: Omit<AutosaveState, "overlay"> & { overlay: OverlayDoc | null; firstCardId: string | null };
  dropped: string[];
} {
  const saved = JSON.parse(raw);
  let overlay: OverlayDoc | null = null;
  let origin: OverlayDoc | null = null;
  let srt: SrtLine[] | null = null;
  let dismissed: Dismissed | null = null;
  let dropped: string[] = [];
  let firstCardId: string | null = null;
  if (saved.overlay?.cards?.length) {
    // 也走一遍 parseOverlay:导入 JSON 会做的补默认值和「认不出的卡跳过」,
    // 刷新恢复也得做同一套,不然旧草稿会绕过这些处理。
    const { doc: migrated, dropped: d } = parseOverlay(saved.overlay);
    dropped = (d ?? []).map((x) => `${x.kind}×${x.n}`);
    overlay = migrated ?? saved.overlay;
    origin = saved.origin ?? null;
    if (Array.isArray(saved.srt) && saved.srt.length) srt = saved.srt;
    if (saved.dismissed && Array.isArray(saved.dismissed.cuts))
      dismissed = {
        video: typeof saved.dismissed.video === "string" ? saved.dismissed.video : null,
        cuts: normalizeCuts(saved.dismissed.cuts),
      };
    // 选中恢复后的第一张卡。要从迁移后的编排里取:存档里的第一张可能是认不出、被跳过的卡,
    // 选中它的话右栏什么都不显示,Delete 也删不到东西
    firstCardId = overlay?.cards[0]?.id ?? null;
  }
  // 视频:落盘过的走 /_media/ 真实路径,刷新后直接恢复,不用重新导入
  const videoUrl = typeof saved.videoUrl === "string" && saved.videoUrl.startsWith("/_media/") ? saved.videoUrl : null;
  return { state: { overlay, origin, srt, videoUrl, dismissed, firstCardId }, dropped };
}
