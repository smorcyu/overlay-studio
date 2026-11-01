import { useEffect, useState } from "react";

/** 波形数据:peaks[i] 是第 i / rate 秒那一小格的峰值(0–255) */
export interface Waveform {
  rate: number;
  peaks: number[];
}

/**
 * 服务端同时只跑两个文件的 ffmpeg 任务(波形、响度各自算),忙的时候回 429:隔一会儿再要,
 * 间隔逐次加长(2、4、8…最长 30 秒),一共等大约 4 分钟 —— 别的长视频算一次可能要几十秒,
 * 只等十来秒很容易白放弃
 */
const BUSY_RETRIES = 12;
const busyWaitMs = (attempt: number) => Math.min(30_000, 2000 * 2 ** attempt);

/**
 * 请求一个 _media 文件的 ffmpeg 任务结果(/api/waveform、/api/loudness),忙就退避重试。
 * onResult 收到解析好的 JSON(不是 JSON 的响应 —— 比如线上试玩版 —— 给 null)。
 * 返回取消函数:换视频或卸载时调用,请求中断,服务端那边的 ffmpeg 也随之停掉。
 */
export function fetchMediaJob(url: string, onResult: (d: Record<string, unknown> | null) => void): () => void {
  const ctrl = new AbortController();
  let timer = 0;
  const load = (attempt: number) => {
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 429 && attempt < BUSY_RETRIES) {
          timer = window.setTimeout(() => load(attempt + 1), busyWaitMs(attempt));
          return;
        }
        onResult((r.headers.get("content-type") ?? "").includes("json") ? await r.json() : null);
      })
      .catch(() => {});
  };
  load(0);
  return () => {
    ctrl.abort();
    window.clearTimeout(timer);
  };
}

/**
 * 取口播视频的波形(服务端 ffmpeg 算,见 vite.config.ts 的 /api/waveform)。
 * 只认存进 public/_media/ 的素材(服务端也只放行这个目录);线上试玩版、没装 ffmpeg、
 * 素材没音轨时返回 null,时间轴照常用。
 */
export function useWaveform(videoUrl: string | null): Waveform | null {
  const [wave, setWave] = useState<Waveform | null>(null);
  useEffect(() => {
    setWave(null);
    if (!videoUrl?.startsWith("/_media/")) return;
    return fetchMediaJob(`/api/waveform?src=${encodeURIComponent(videoUrl)}`, (d) => {
      if (d?.ok && Array.isArray(d.peaks)) setWave({ rate: d.rate as number, peaks: d.peaks as number[] });
    });
  }, [videoUrl]);
  return wave;
}
