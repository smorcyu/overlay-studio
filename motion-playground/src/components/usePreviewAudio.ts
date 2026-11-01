import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AudioSettings } from "../overlay/types";
import { BGM_VOLUME_DEFAULT } from "../overlay/types";
import { keptDuration, type Cut } from "../overlay/cuts";
import { fetchMediaJob, type Waveform } from "./useWaveform";

/**
 * 编辑台预览里的成片音频:人声响度统一 + 背景音乐(循环、跳过剪切段、结尾淡出、说话时压低)。
 * 尽量和成片一样,但不是一模一样:
 *   - 响度增益和成片是同一个数(服务端 /api/loudness 用同一套 ebur128 量法);
 *   - 压低是近似的:成片用 ffmpeg 的侧链压缩器,浏览器没有现成的侧链,这里按波形判断
 *     「这一刻有没有在说话」,说话时把音乐压低固定的 PREVIEW_DUCK_DB;
 *   - 音效不参与(编辑台本来就不放音效轨)。
 * 不需要增益也没有背景音乐时,口播视频不经过 Web Audio,保持原来的播放方式。
 */

/** 预览里说话时音乐压低多少 dB(成片实测压低 10–15dB,取中间) */
const PREVIEW_DUCK_DB = -12;
/** 波形峰值高于这个(0–255,满格 = 正常说话)算「在说话」 */
const SPEAKING_PEAK = 40;
/** 压低起效 / 恢复的时间常数(秒),和成片的 attack 20ms / release 400ms 对齐 */
const DUCK_ATTACK = 0.02;
const DUCK_RELEASE = 0.4;
/** 音乐和播放头差多少秒以上就重新对位 */
const MUSIC_RESYNC = 0.3;
/** 结尾淡出时长(秒),和成片一致 */
const FADE_SEC = 2;

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** t(原始时间)之前一共剪掉了多少秒:音乐铺在剪完的成片上,按「剪后时间」走 */
export function removedBefore(t: number, cuts: Cut[]): number {
  let r = 0;
  for (const c of cuts) {
    if (c.start >= t) break;
    r += Math.min(c.end, t) - c.start;
  }
  return r;
}

/** 波形在 t 附近 ±50ms 里有没有在说话 */
export function speakingAt(wave: Waveform | null, t: number): boolean {
  if (!wave) return false;
  const i0 = Math.max(0, Math.floor((t - 0.05) * wave.rate));
  const i1 = Math.min(wave.peaks.length, Math.ceil((t + 0.05) * wave.rate));
  for (let i = i0; i < i1; i++) if (wave.peaks[i] > SPEAKING_PEAK) return true;
  return false;
}

/** 限幅器参数:阈值 -1dB、20:1、硬拐点(和成片的 -1dBFS 限幅同一个目的:人声提了增益、又叠了音乐,别削波) */
const LIMIT_DB = -1;
const LIMIT_RATIO = 20;
/**
 * DynamicsCompressorNode 会按规范自动加一份补偿增益(makeup):(1 / 满量程输出)^0.6。
 * 硬拐点时满量程输入的输出是 T·(1 − 1/ratio) dB(这里 -0.95dB),补偿约 +0.57dB ——
 * 不抵消的话预览会整体比成片响半个 dB。限幅器后面接一个固定增益把它抵消掉。
 * 注意它不是砖墙限幅:超过阈值的部分按 20:1 压,满量程输入出来约 -0.95dBFS
 */
export const MAKEUP_DB = 0.6 * -(LIMIT_DB * (1 - 1 / LIMIT_RATIO));

/**
 * 整个页面共用一个 AudioContext,从不关闭:一个 <video> 只能接一次 Web Audio
 * (createMediaElementSource 第二次调会抛错),而且接上以后它的声音就只从这个 context 出来。
 * 关掉 context 再新建(React 开发模式的 StrictMode 会把组件装两次、卸一次)会让接过的视频永远没声音。
 * 存在 globalThis 上而不是模块变量里:开发时改这个文件,Vite 热更新会重新执行模块,
 * 模块变量清零了但页面里的 <video> 还是接过的那个,再接一次就抛错
 */
type Graph = { ctx: AudioContext; out: DynamicsCompressorNode; voiceGains: WeakMap<HTMLMediaElement, GainNode> };
const G = globalThis as typeof globalThis & { __overlayPreviewAudio?: Graph };
function audioGraph(): Graph {
  if (!G.__overlayPreviewAudio) {
    const ctx = new AudioContext();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMIT_RATIO;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    const unMakeup = ctx.createGain();
    unMakeup.gain.value = dbToGain(-MAKEUP_DB);
    limiter.connect(unMakeup);
    unMakeup.connect(ctx.destination);
    G.__overlayPreviewAudio = { ctx, out: limiter, voiceGains: new WeakMap() };
  }
  return G.__overlayPreviewAudio;
}
/** 把口播视频接进 Web Audio,返回它的增益节点。接不上(已经被别处接过)就返回 null,视频照常自己出声 */
function routeVoice(v: HTMLMediaElement): GainNode | null {
  const { ctx, out, voiceGains } = audioGraph();
  let g = voiceGains.get(v);
  if (!g) {
    try {
      const src = ctx.createMediaElementSource(v);
      g = ctx.createGain();
      src.connect(g);
      g.connect(out);
      voiceGains.set(v, g);
    } catch {
      return null;
    }
  }
  return g;
}
const voiceGainOf = (v: HTMLMediaElement) => G.__overlayPreviewAudio?.voiceGains.get(v) ?? null;

interface Opts {
  /** 编辑台在播放(效果库里不放音乐) */
  active: boolean;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  videoUrl: string | null;
  /** 播放头(原始时间),每帧读最新值 */
  curTRef: MutableRefObject<number>;
  cuts: Cut[];
  /** 口播视频时长(没有就是 0):成片长度按它算,淡出也按它 */
  footageDur: number;
  audio: AudioSettings | undefined;
  muted: boolean;
  wave: Waveform | null;
}

export function usePreviewAudio({ active, videoRef, videoUrl, curTRef, cuts, footageDur, audio, muted, wave }: Opts) {
  // 预览用的响度增益:和成片同一个数,服务端量。只认存进 public/_media/ 的口播视频
  const normalize = audio?.normalize !== false;
  const [gainDb, setGainDb] = useState(0);
  useEffect(() => {
    setGainDb(0);
    if (!normalize || !videoUrl?.startsWith("/_media/")) return;
    // 和波形同一套「服务端忙就退避重试」:不重试的话两个长视频同时在量时,预览会悄悄停在 0dB
    return fetchMediaJob(`/api/loudness?src=${encodeURIComponent(videoUrl)}`, (d) => {
      if (d?.ok && Number.isFinite(d.gainDb)) setGainDb(d.gainDb as number);
    });
  }, [normalize, videoUrl]);

  const bgm = audio?.bgm ?? null;
  const needVoice = Math.abs(gainDb) >= 0.1 || !!bgm;

  // 人声:要调增益、或者要和音乐一起过限幅时才接进 Web Audio。接过的视频之后一直走这条路
  // (接上就拆不回去),不需要时增益放回 1,听起来和原来一样
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const g = needVoice ? routeVoice(v) : voiceGainOf(v);
    if (g) g.gain.value = muted ? 0 : needVoice ? dbToGain(gainDb) : 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, needVoice, gainDb, muted]);

  // 播放开始时把 context 叫醒:浏览器要求有过用户操作才能出声,空格 / 点播放就是
  useEffect(() => {
    const ctx = G.__overlayPreviewAudio?.ctx;
    if (active && ctx?.state === "suspended") ctx.resume().catch(() => {});
  }, [active, needVoice]);

  // 背景音乐:换曲子就换一个元素,不用了就停掉
  const musicRef = useRef<{ el: HTMLAudioElement; gain: GainNode } | null>(null);
  useEffect(() => {
    if (!bgm) return;
    const { ctx, out } = audioGraph();
    const el = new Audio(bgm);
    el.loop = true;
    el.preload = "auto";
    const node = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    node.connect(gain);
    gain.connect(out);
    musicRef.current = { el, gain };
    return () => {
      el.pause();
      node.disconnect();
      gain.disconnect();
      el.removeAttribute("src");
      el.load();
      if (musicRef.current?.el === el) musicRef.current = null;
    };
  }, [bgm]);

  // 每帧:音乐跟着播放头(剪后时间)走、按淡出和压低算音量
  const latest = useRef({ cuts, footageDur, audio, muted, wave });
  latest.current = { cuts, footageDur, audio, muted, wave };
  useEffect(() => {
    const m = musicRef.current;
    if (!m) return;
    if (!active) {
      m.el.pause();
      return;
    }
    let raf = 0;
    let last = performance.now();
    let duckDb = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { cuts: cs, footageDur: fd, audio: a, muted: mu, wave: w } = latest.current;
      const t = curTRef.current;
      const outT = t - removedBefore(t, cs);
      const kept = fd > 0 ? keptDuration(fd, cs) : Infinity;
      // 位置:剪后时间对曲子长度取模(曲子太短就循环)
      const dur = m.el.duration;
      if (Number.isFinite(dur) && dur > 0) {
        const want = outT % dur;
        if (Math.abs(m.el.currentTime - want) > MUSIC_RESYNC) m.el.currentTime = want;
      }
      if (outT >= kept) m.el.pause();
      else if (m.el.paused) m.el.play().catch(() => {});
      // 压低:说话时往 PREVIEW_DUCK_DB 靠,停下来回 0,时间常数和成片一致
      const target = a?.duck !== false && speakingAt(w, t) ? PREVIEW_DUCK_DB : 0;
      const tau = target < duckDb ? DUCK_ATTACK : DUCK_RELEASE;
      duckDb += (target - duckDb) * (1 - Math.exp(-dt / tau));
      const fade = Math.max(0, Math.min(1, (kept - outT) / FADE_SEC));
      m.gain.gain.value = mu ? 0 : dbToGain((a?.bgmVolume ?? BGM_VOLUME_DEFAULT) + duckDb) * fade;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      m.el.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bgm]);
}
