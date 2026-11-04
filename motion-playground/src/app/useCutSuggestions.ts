import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Waveform } from "../components/useWaveform";
import type { SrtLine } from "../overlay/srt";
import type { Cut } from "../overlay/cuts";
import { DEFAULT_SUGGEST, suggestCuts, type CutSuggestion } from "../overlay/suggestCuts";
import type { Dismissed } from "./autosave";

/** 共用的空列表(引用不变,依赖它的 memo 不会白算) */
const NONE: never[] = [];

/**
 * 剪切建议:停顿(波形)+ 语气词句 / 重说(字幕稿)。只建议,采纳了才变成剪切段(采纳在 App 里)。
 * 忽略过的段(dismissed)只对当时那条口播视频算数;它随自动存档保存,所以状态放在 App
 */
export function useCutSuggestions(opts: {
  wave: Waveform | null;
  srt: SrtLine[] | null;
  cuts: Cut[];
  videoUrl: string | null;
  dismissed: Dismissed;
  setDismissed: Dispatch<SetStateAction<Dismissed>>;
}) {
  const { wave, srt, cuts, videoUrl, dismissed, setDismissed } = opts;
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [minPause, setMinPause] = useState(DEFAULT_SUGGEST.minPause);
  const dismissedCuts = dismissed.video === videoUrl ? dismissed.cuts : NONE;
  const dismissCut = (c: Cut) =>
    setDismissed((d) => ({
      video: videoUrl,
      cuts: [...(d.video === videoUrl ? d.cuts : []), { start: c.start, end: c.end }],
    }));
  // 只在面板开着时算:一小时的片子要扫十几万个波形格,拖卡片的每一帧都重算太浪费
  const suggestions: CutSuggestion[] = useMemo(
    () =>
      suggestOpen ? suggestCuts({ wave, subs: srt, cuts, dismissed: dismissedCuts, options: { minPause } }) : NONE,
    [suggestOpen, wave, srt, cuts, dismissedCuts, minPause],
  );
  const suggestMissing = [
    !wave && "没有口播视频的波形,找不到停顿(先导入视频;要本机装了 ffmpeg)",
    !srt?.length && "没有字幕稿,找不到语气词和重说(先导入 SRT)",
  ].filter((x): x is string => !!x);

  return { suggestOpen, setSuggestOpen, minPause, setMinPause, dismissCut, suggestions, suggestMissing };
}
