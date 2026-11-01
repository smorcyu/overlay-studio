import { useEffect, useState } from "react";

/** 波形数据:peaks[i] 是第 i / rate 秒那一小格的峰值(0–255) */
export interface Waveform {
  rate: number;
  peaks: number[];
}

/**
 * 服务端同时只算两个文件的波形,忙的时候回 429:隔一会儿再要,间隔逐次加长(2、4、8…最长 30 秒),
 * 一共等大约 4 分钟 —— 别的长视频算一个波形可能要几十秒,只等十来秒很容易白放弃
 */
const BUSY_RETRIES = 12;
const busyWaitMs = (attempt: number) => Math.min(30_000, 2000 * 2 ** attempt);

/**
 * 取口播视频的波形(服务端 ffmpeg 算,见 vite.config.ts 的 /api/waveform)。
 * 只认存进 public/_media/ 的素材(服务端也只放行这个目录);线上试玩版、没装 ffmpeg、
 * 素材没音轨时返回 null,时间轴照常用。换视频或卸载时中断请求,服务端那边的 ffmpeg 也随之停掉。
 */
export function useWaveform(videoUrl: string | null): Waveform | null {
  const [wave, setWave] = useState<Waveform | null>(null);
  useEffect(() => {
    setWave(null);
    if (!videoUrl?.startsWith("/_media/")) return;
    const ctrl = new AbortController();
    let timer = 0;
    const load = (attempt: number) => {
      fetch(`/api/waveform?src=${encodeURIComponent(videoUrl)}`, { signal: ctrl.signal })
        .then(async (r) => {
          if (r.status === 429 && attempt < BUSY_RETRIES) {
            timer = window.setTimeout(() => load(attempt + 1), busyWaitMs(attempt));
            return;
          }
          const d = (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : null;
          if (d?.ok && Array.isArray(d.peaks)) setWave({ rate: d.rate, peaks: d.peaks });
        })
        .catch(() => {});
    };
    load(0);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [videoUrl]);
  return wave;
}
