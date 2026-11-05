import { useCallback, useEffect, useRef, useState } from "react";

/** 识别什么语言(和 scripts/whisper.mjs 的 LANGS 一致) */
export type TranscribeLang = "zh" | "en" | "auto";

/** /api/transcribe-status 的返回 */
interface Status {
  running: boolean;
  pct: number;
  /** 装了 whisper.cpp、也有模型 */
  ready: boolean;
  /** 缺东西时怎么补(不 ready 时有) */
  hint: string | null;
  model: string | null;
}

/**
 * 本机语音识别出字幕稿(whisper.cpp,见 vite.config.ts 的 /api/transcribe)。
 * src:要识别的口播视频(public/_media/ 里的);没有时按钮是灰的。onSrt 拿到 SRT 文字后交给 App 走「导入 SRT」那条路
 */
export function useTranscribe(src: string | null, onSrt: (text: string) => void) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onSrtRef = useRef(onSrt);
  onSrtRef.current = onSrt;

  /** 问一下能不能用(装没装、有没有模型)。装好之后用户不用刷新页面,点开字幕稿时再问一次就行 */
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/transcribe-status", { cache: "no-store" });
      if ((r.headers.get("content-type") ?? "").includes("json")) setStatus(await r.json());
      else setStatus({ running: false, pct: 0, ready: false, hint: "线上试玩版不支持识别,要在本地运行", model: null });
    } catch {
      /* 服务没起:界面上方已经有「服务已停止」的提示 */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (lang: TranscribeLang) => {
    if (!src || busy) return;
    setBusy(true);
    setError(null);
    setPct(0);
    const ac = new AbortController();
    abortRef.current = ac;
    const poll = window.setInterval(async () => {
      try {
        const s: Status = await (await fetch("/api/transcribe-status", { cache: "no-store" })).json();
        if (s.running) setPct(s.pct);
      } catch {
        /* 瞬时失败,忽略 */
      }
    }, 1000);
    try {
      const r = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src, lang }),
        signal: ac.signal,
      });
      const d = await r.json().catch(() => null);
      if (d?.ok && typeof d.srt === "string") onSrtRef.current(d.srt);
      else setError(d?.error ?? `识别失败(HTTP ${r.status})`);
    } catch (e) {
      // 自己点了「取消」:请求断开,服务端会停掉 whisper,不算出错
      if (!ac.signal.aborted) setError(`识别失败:${e}`);
    } finally {
      window.clearInterval(poll);
      abortRef.current = null;
      setBusy(false);
      refresh();
    }
  };

  return {
    /** 有能识别的口播视频 */
    canRun: !!src && !!status?.ready,
    status,
    busy,
    pct,
    error,
    run,
    cancel: () => abortRef.current?.abort(),
    refresh,
  };
}

export type Transcriber = ReturnType<typeof useTranscribe>;
