import { useEffect, useState } from "react";
import type { TranscribeLang, Transcriber } from "../app/useTranscribe";

/**
 * 字幕稿上面的一条:「🎙 自动识别」口播视频出字幕稿(本机 whisper.cpp)。
 * 没装 / 没模型时按钮是灰的,下面一行说怎么装;识别中显示进度、能取消
 */
export function TranscribeBar({ t, hasVideo, hasSrt }: { t: Transcriber; hasVideo: boolean; hasSrt: boolean }) {
  const [lang, setLang] = useState<TranscribeLang>("zh");
  // 点开字幕稿时再问一次能不能用:刚装好 whisper.cpp / 下好模型的话,不用刷新页面
  const { refresh } = t;
  useEffect(() => {
    refresh();
  }, [refresh]);

  const why = !hasVideo
    ? "先「导入视频」:识别的是口播视频的声音"
    : t.status && !t.status.ready
      ? t.status.hint
      : null;
  const start = () => {
    if (hasSrt && !window.confirm("会替换现在的字幕稿(可以 ⌘Z 撤销)。继续识别?")) return;
    t.run(lang);
  };

  return (
    <div className="transcribe-bar">
      <div className="transcribe-row">
        {t.busy ? (
          <>
            <span className="transcribe-prog">
              🎙 识别中 {t.pct}%<i style={{ width: `${t.pct}%` }} />
            </span>
            <button className="tl-clear" onClick={t.cancel}>
              取消
            </button>
          </>
        ) : (
          <>
            <button
              className="video-btn transcribe-go"
              onClick={start}
              disabled={!t.canRun}
              title={why ?? `用本机的 whisper.cpp 识别口播视频,出字幕稿(模型:${t.status?.model ?? "?"});声音不出这台电脑`}
            >
              🎙 自动识别字幕
            </button>
            <select
              className="transcribe-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value as TranscribeLang)}
              aria-label="识别语言"
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
              <option value="auto">自动</option>
            </select>
          </>
        )}
      </div>
      {why && !t.busy && <div className="transcribe-hint">{why}</div>}
      {t.error && <div className="transcribe-hint transcribe-err">⚠️ {t.error}</div>}
    </div>
  );
}
