import type { CutSuggestion, SuggestKind } from "../overlay/suggestCuts";

const KIND_LABEL: Record<SuggestKind, string> = {
  pause: "停顿",
  filler: "语气词",
  retake: "重说",
};

function fmt(t: number) {
  // 先四舍五入到 0.1 秒再拆分钟:59.96 秒是 1:00.0 而不是 0:60.0
  const r = Math.round(t * 10) / 10;
  const m = Math.floor(r / 60);
  const s = (r % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

interface Props {
  items: CutSuggestion[];
  /** 停顿最短多长才建议(秒) */
  minPause: number;
  onMinPause: (v: number) => void;
  onAccept: (s: CutSuggestion) => void;
  onDismiss: (s: CutSuggestion) => void;
  onAcceptAll: () => void;
  /** 点一条:跳到它前面一点,方便先听再决定 */
  onPreview: (s: CutSuggestion) => void;
  onClose: () => void;
  /** 缺什么数据(没波形 / 没字幕)就提示一句,别让人以为「没建议 = 片子很干净」 */
  missing: string[];
}

/**
 * 剪切建议浮层:逐条看、逐条决定。采纳 = 变成普通剪切段(可恢复、可撤销);忽略 = 这条不再出现。
 * 不自动剪任何东西 —— 规则会误判(比如故意的停顿),最后拍板的永远是人。
 */
export function CutSuggestions({
  items,
  minPause,
  onMinPause,
  onAccept,
  onDismiss,
  onAcceptAll,
  onPreview,
  onClose,
  missing,
}: Props) {
  const total = items.reduce((n, s) => n + (s.end - s.start), 0);
  return (
    <div className="cutsg" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cutsg-head">
        <b>✂ 剪切建议</b>
        <span className="cutsg-sum">
          {items.length ? `${items.length} 条 · 共 ${total.toFixed(1)} 秒` : "没有建议"}
        </span>
        <label className="cutsg-opt" title="比这短的停顿不建议剪">
          停顿 ≥
          <select value={minPause} onChange={(e) => onMinPause(Number(e.target.value))}>
            {[0.5, 0.8, 1.2, 2].map((v) => (
              <option key={v} value={v}>
                {v} 秒
              </option>
            ))}
          </select>
        </label>
        <button className="cutsg-all" disabled={!items.length} onClick={onAcceptAll}>
          全部采纳
        </button>
        <button className="cutsg-close" onClick={onClose} title="关闭">
          ×
        </button>
      </div>
      {missing.length > 0 && <div className="cutsg-miss">{missing.join(" · ")}</div>}
      <ul className="cutsg-list">
        {items.map((s) => (
          <li key={`${s.kind}-${s.start}`} className={`cutsg-item is-${s.kind}`}>
            <button className="cutsg-main" onClick={() => onPreview(s)} title="跳过去听一下">
              <span className="cutsg-kind">{KIND_LABEL[s.kind]}</span>
              <span className="cutsg-time">
                {fmt(s.start)}–{fmt(s.end)}
              </span>
              <span className="cutsg-note">{s.note}</span>
            </button>
            <button className="cutsg-yes" onClick={() => onAccept(s)} title="剪掉这一段">
              剪掉
            </button>
            <button className="cutsg-no" onClick={() => onDismiss(s)} title="不剪,这条不再提示">
              忽略
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
