import { useEffect, useState } from "react";

/** 波形数据:peaks[i] 是第 i / rate 秒那一小格的峰值(0–255) */
export interface Waveform {
  rate: number;
  peaks: number[];
}

/**
 * 取口播视频的波形(服务端 ffmpeg 算,见 vite.config.ts 的 /api/waveform)。
 * 只认存进 public/_media/ 的素材;线上试玩版、没装 ffmpeg、素材没音轨时返回 null,时间轴照常用。
 */
export function useWaveform(videoUrl: string | null): Waveform | null {
  const [wave, setWave] = useState<Waveform | null>(null);
  useEffect(() => {
    setWave(null);
    if (!videoUrl?.startsWith("/_media/")) return;
    let alive = true;
    fetch(`/api/waveform?src=${encodeURIComponent(videoUrl)}`)
      .then((r) => ((r.headers.get("content-type") ?? "").includes("json") ? r.json() : null))
      .then((d) => {
        if (alive && d?.ok && Array.isArray(d.peaks)) setWave({ rate: d.rate, peaks: d.peaks });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [videoUrl]);
  return wave;
}
