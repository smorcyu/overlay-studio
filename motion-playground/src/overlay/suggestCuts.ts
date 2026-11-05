/**
 * 剪切建议:从波形和字幕稿里找「可能该剪掉」的段,交给用户逐条采纳 / 忽略。
 *
 * 三类,都是确定性规则(不调大模型),同一份输入永远给同一份建议:
 *   - 停顿:波形峰值连续低于阈值超过一定时长。两头各留一点余量,不剪到字头字尾。
 *   - 语气词:整句字幕只有「嗯 / 啊 / 那个」这类词。句中夹的语气词剪不了 ——
 *     SRT 只有整句的时间,没有逐字时间。(🎙 自动识别出来的字幕稿会把「嗯,」「那个,」单独拆成一条,见 scripts/whisper.mjs)
 *   - 重说:相邻两句几乎一样(口播说错重来),建议剪掉前一遍,留后一遍。
 *
 * 采纳后就是普通的剪切段(overlay/cuts.ts),预览跳过、成片里删掉,随时能恢复。
 */
import type { SrtLine } from "./srt";
import type { Waveform } from "../components/useWaveform";
import type { Cut } from "./cuts";
import { isFillerLine } from "./fillers";

export type SuggestKind = "pause" | "filler" | "retake";

export interface CutSuggestion extends Cut {
  kind: SuggestKind;
  /** 给用户看的一句说明 */
  note: string;
}

export interface SuggestOptions {
  /** 停顿最短多长才建议剪(秒) */
  minPause: number;
  /** 低于这个峰值(0–255;波形以有声部分的第 99 百分位为满格,见 vite.config.ts normalizePeaks)算「没声音」 */
  silenceLevel: number;
  /** 停顿两头各留多少不剪(秒),避免剪到字头字尾 */
  pad: number;
  /** 重说:两句开头间隔超过这个秒数就不算重说 */
  retakeWindow: number;
}

export const DEFAULT_SUGGEST: SuggestOptions = {
  minPause: 0.8,
  silenceLevel: 15, // ≈ 满格的 6%(约 -24dB),满格 = 正常说话的音量
  pad: 0.15,
  retakeWindow: 12,
};

// 语气词表和 isFillerLine 在 fillers.ts(自动识别字幕拼字幕条时也用同一套)
export { isFillerLine };

const r2 = (v: number) => Math.round(v * 100) / 100;

/** 去掉标点、空白、大小写,只留比对用的字 */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 两段文字的相似度(字二元组 Dice 系数,0–1);短于 2 个字的按整串比 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0);
  return (2 * hit) / (a.length - 1 + (b.length - 1));
}

/**
 * 是不是重说:后一句和前一句几乎一样,或者前一句是后一句说了一半就断掉的开头
 * (「今天我们来讲」→「今天我们来讲一下剪辑」)。前一句太短(<4 字)不判,误伤太多。
 */
export function isRetake(prev: string, next: string): boolean {
  const a = normText(prev);
  const b = normText(next);
  if (a.length < 4 || b.length < 4) return false;
  if (b.startsWith(a)) return true;
  return similarity(a, b) >= 0.7;
}

/** 波形里的长停顿 */
export function findPauses(wave: Waveform, opt: SuggestOptions): CutSuggestion[] {
  const out: CutSuggestion[] = [];
  const { peaks, rate } = wave;
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const s = runStart / rate;
    const e = endIdx / rate;
    runStart = -1;
    if (e - s < opt.minPause) return;
    // 片头片尾的静音也照样建议:开拍前和收尾的空白最常见
    const start = s === 0 ? 0 : s + opt.pad;
    const end = endIdx >= peaks.length ? e : e - opt.pad;
    if (end - start < 0.2) return;
    out.push({ kind: "pause", start: r2(start), end: r2(end), note: `停顿 ${(e - s).toFixed(1)} 秒` });
  };
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] <= opt.silenceLevel) {
      if (runStart < 0) runStart = i;
    } else flush(i);
  }
  flush(peaks.length);
  return out;
}

/** 字幕稿里的语气词句和重说 */
export function findTextCuts(subs: SrtLine[], opt: SuggestOptions): CutSuggestion[] {
  const out: CutSuggestion[] = [];
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const prev = subs[i - 1];
    const next = subs[i + 1];
    // 自动生成的字幕常常前后句时间重叠。剪切两头都要让开相邻的句子:
    // 起点不早于上一句结束,终点不晚于下一句开头 —— 别剪掉别人的字头字尾
    const start = prev ? Math.max(s.start, prev.end) : s.start;
    if (isFillerLine(s.text)) {
      const end = next ? Math.min(s.end, next.start) : s.end;
      if (end - start >= 0.1)
        out.push({ kind: "filler", start: r2(start), end: r2(end), note: `语气词「${s.text.trim()}」` });
      continue;
    }
    if (next && next.start - s.start <= opt.retakeWindow && isRetake(s.text, next.text)) {
      // 剪到下一句开头为止:中间的停顿一起剪掉,下一句(重说的那遍)从第一个字起完整保留
      if (next.start - start >= 0.1)
        out.push({
          kind: "retake",
          start: r2(start),
          end: r2(next.start),
          note: `重说:「${s.text.trim()}」→ 保留后一遍`,
        });
    }
  }
  return out;
}

/** 两段时间有重叠 */
const overlaps = (a: Cut, b: Cut) => a.start < b.end && b.start < a.end;

/**
 * 汇总:三类建议按时间排好。已经剪掉的、用户忽略过的不再出现;
 * 停顿和文字建议撞在一起时留文字那条(它说得出剪的是哪句话)。
 */
export function suggestCuts(input: {
  wave?: Waveform | null;
  subs?: SrtLine[] | null;
  cuts?: Cut[];
  dismissed?: Cut[];
  options?: Partial<SuggestOptions>;
}): CutSuggestion[] {
  const opt = { ...DEFAULT_SUGGEST, ...input.options };
  const text = input.subs?.length ? findTextCuts(input.subs, opt) : [];
  const pauses = input.wave ? findPauses(input.wave, opt).filter((p) => !text.some((t) => overlaps(p, t))) : [];
  const taken = [...(input.cuts ?? []), ...(input.dismissed ?? [])];
  return [...text, ...pauses]
    .filter((s) => !taken.some((c) => overlaps(s, c)))
    .sort((a, b) => a.start - b.start);
}
