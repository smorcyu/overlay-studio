/**
 * 成片合成:口播原片 + 透明动效层 + 音效 → 一条可直接发布的 MP4
 *
 * 导出脚本在 PNG 序列和音效混音都做好之后调用它。用 PNG 序列而不是 MOV 当动效层:
 * MOV 是给剪映的**预乘** alpha,ffmpeg overlay 默认按直通 alpha 合成,拿 MOV 叠会让
 * 半透明边缘发暗;PNG 本来就是直通 alpha,直接叠就对。
 *
 * 有剪切段(doc.cuts)时,原片、动效层、音效一起剪掉这些段 —— 只剪成片;透明 MOV/WebM 仍是完整时长。
 * 「只导成片」模式下动效层 PNG 导出时就没截剪切段里的帧(overlayPreCut):这时只剪原片和音频,剪完再叠。
 *
 * 用法(导出脚本内部): await composeFinal({ footage, seq, fpsArg, sfxMix, camSegs, cuts, out, stage, audio, overlayPreCut, workDir, onProgress })
 * 也可单独跑:node scripts/compose-final.mjs <footage> <PNG 序列目录> <out.mp4> [sfx.m4a]
 *   PNG 目录里有导出时写下的 compose.json(帧率、画布、剪切段、烤入人物的时段、成片音频、
 *   动效层是否已剪过)就照它合,和导出时合出来的是同一条片子。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ebur128Args, LOUDNESS_TARGET, loudnessGain, loudnessStatus, parseLoudness } from "./loudness.mjs";

/** 音效相对人声的音量:约 -14dB(合成说明里一直建议剪映里调到 -12~-18dB) */
const SFX_GAIN = 0.2;
/** 背景音乐默认音量(dB,相对原曲) */
export const BGM_DEFAULT_DB = -20;
/** 说话时压低背景音乐的压缩器参数(侧链已经调到 -14 LUFS;为什么是这组数见 buildArgs 里的说明) */
const DUCK = "threshold=0.02:ratio=20:attack=20:release=400:level_sc=4";
/** 剪切时音频切成多细的格子(秒)。1ms:够细,aselect 逐格判断也不慢 */
const AUDIO_UNIT = 0.001;
/** 剪切前把音频统一重采样到这个采样率,1ms 正好 48 个样本 */
const AUDIO_RATE = 48000;
/** 滤镜图超过这么长就写进文件(Windows 命令行上限 32767 字符,留足余量给其余参数和路径) */
const FILTER_INLINE_MAX = 16000;
/** HDR 的两种传输特性(iPhone 默认录的 HLG,以及 PQ) */
const HDR_TRC = new Set(["arib-std-b67", "smpte2084"]);

/** 读原片:有没有声音、时长、色彩信息。读不到的字段给 null */
export function probeFootage(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,color_transfer,color_space,color_primaries:format=duration", "-of", "json", file],
    { encoding: "utf8" },
  );
  let j = {};
  try {
    j = JSON.parse(r.stdout || "{}");
  } catch {
    /* 读不出就按「什么都不知道」处理 */
  }
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const v = streams.find((s) => s.codec_type === "video") ?? {};
  return {
    hasVideo: streams.some((s) => s.codec_type === "video"),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    duration: Number(j.format?.duration) || null,
    transfer: v.color_transfer ?? null,
    hdr: HDR_TRC.has(v.color_transfer),
  };
}

/**
 * 量原片第一条音轨的整体响度(EBU R128 积分响度,LUFS)。只解码音频,一小时的片子也就十几秒。
 * 量不出来(没声音、ffmpeg 报错)返回 null,调用方就不调增益。
 */
export function measureLoudness(file) {
  const r = spawnSync("ffmpeg", ebur128Args(file), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return parseLoudness(r.stderr);
}

// 响度的目标、增益算法、解析和编辑台预览共用,放在 loudness.mjs;这里转出去给测试和老调用方
export { LOUDNESS_TARGET, parseLoudness, loudnessGain, loudnessStatus };

/** 本机 ffmpeg 有没有 zscale(HDR 转 SDR 要用;Homebrew 和常见静态版都带,少数精简版没有) */
export function hasZscale() {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" });
  return /\szscale\s/.test(r.stdout ?? "");
}

/**
 * 剪切段规整:非法段丢掉、排序、重叠/相接的合并、保留两位小数。
 * 和编辑台 src/overlay/cuts.ts 的 normalizeCuts 同一套规则(那边是 TS,这里没法直接引用);
 * tests/cuts.test.ts 拿同一批输入比对两边的输出,改了一边忘了另一边测试会挂。
 */
export function normalizeCuts(raw) {
  if (!Array.isArray(raw)) return [];
  const r2 = (v) => Math.round(v * 100) / 100;
  const list = raw
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end))
    // 先把起点截到 0 再判断长度:否则 {-1, -0.5} 会变成 {0, -0.5} 留下来
    .map((c) => ({ start: r2(Math.max(0, c.start)), end: r2(c.end) }))
    .filter((c) => c.end - c.start >= 0.05)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

/** "30000/1001" → 29.97…;"30" → 30 */
export function fpsValue(fpsArg) {
  const [a, b] = String(fpsArg).split("/").map(Number);
  return b ? a / b : a;
}

/**
 * 剪切计划:把剪切段换成「视频剪掉哪几帧」和「音频剪掉哪几格(1ms)」,两边都是整数下标。
 *
 * 为什么不直接按秒剪:视频只能整帧(33.4ms)丢,音频只能整个音频帧丢,两边每剪一刀丢掉的
 * 长度都差一点,而且差值会一路累积 —— 剪上百刀(「全部采纳」停顿建议很常见)片尾口型能差
 * 一两百毫秒。这里先把每刀落到视频帧上,再给音频挑剪切点,让「到这一刀为止音频一共剪掉的
 * 时长」始终最接近「视频一共剪掉的时长」:每一刀之后两边累计剪掉的时长差不超过半格(0.5ms),
 * 不随刀数累积。前提是两条流都从 0 开始(buildArgs 里把起点对齐到 0),这里只管剪切本身。
 *
 * 两刀离得很近(落到帧上之后首尾相接)时先合成一刀,否则音频的两段会重叠、重叠的那 1ms
 * 被算两遍。maxSec = 原片时长:超出原片的剪切不算进「剪掉了多少」(进度条按它算总长)。
 */
export function planCuts(cuts, fps, unit = AUDIO_UNIT, maxSec = Infinity) {
  const frames = [];
  for (const c of normalizeCuts(cuts)) {
    if (c.start >= maxSec) break;
    const vs = Math.round(c.start * fps);
    const ve = Math.round(Math.min(c.end, maxSec) * fps);
    if (ve <= vs) continue;
    const last = frames[frames.length - 1];
    if (last && vs <= last[1]) last[1] = Math.max(last[1], ve);
    else frames.push([vs, ve]);
  }
  const audio = [];
  let removedV = 0; // 秒,视频累计剪掉
  let removedA = 0; // 格,音频累计剪掉
  for (const [vs, ve] of frames) {
    removedV += (ve - vs) / fps;
    // 起点不早于上一段音频的终点:不让两段重叠
    const as = Math.max(Math.round(vs / fps / unit), audio.length ? audio[audio.length - 1][1] : 0);
    const ae = Math.max(as + 1, as + Math.round(removedV / unit - removedA));
    audio.push([as, ae]);
    removedA += ae - as;
  }
  return { video: frames, audio, removedSec: removedV };
}

/**
 * 成片会从原片里剪掉哪些帧([起, 止),从 0 数)。「只导成片」导出时按它跳过截图,合成时按它剪原片:
 * 两边必须是同一份结果,所以都走这里(fps 用 fpsArg 换算,和 buildArgs 一致)
 */
export function cutFrameRanges(cuts, fpsArg, maxSec = Infinity) {
  return planCuts(cuts, fpsValue(fpsArg), AUDIO_UNIT, maxSec).video;
}

/** 第 k 帧(从 0 数)在不在这些剪切帧段里 */
export function inFrameRanges(ranges, k) {
  return ranges.some(([s, e]) => k >= s && k < e);
}

/**
 * 「只导成片」截图截到第几帧为止(不含):原片结束之后的帧成片里用不上(overlay 跟着原片结束),
 * 不必截。多留 1 帧余量:ffmpeg 按帧率重采样时最后一帧落在哪一边说不准,宁可多截一张。
 * 读不到原片时长时截满整条时间轴
 */
export function captureEndFor(footageDuration, fpsArg, timelineFrames) {
  if (!Number.isFinite(footageDuration)) return timelineFrames;
  return Math.min(timelineFrames, Math.ceil(footageDuration * fpsValue(fpsArg)) + 1);
}

/**
 * 单独重合「只导成片」留下的 PNG 时先核对,对不上就返回原因,没问题返回 null。
 * 动效层导出时按「当时那条原片的长度」跳过了剪切帧、截到原片结束为止(captureEnd)。换一条原片
 * (比如重新编码过)时,真正要紧的只有一件事:新原片里每一帧要保留的画面,配上的还是不是导出时
 * 同一张 PNG。所以按新原片重算一遍剪切,逐帧对「保留的第几帧 → 第几张 PNG」:都对上就放行
 * (长度差几帧、剪切越过结尾那一刀长短不同都没关系),有一帧对不上叠出来就会错位或缺动效。
 * PNG 张数对不上也拦下
 */
export function checkPreCutMeta(meta, footageDuration, pngCount) {
  if (!meta?.overlayPreCut) return null;
  if (Array.isArray(meta.skipFrames) && Number.isFinite(meta.timelineFrames)) {
    const fpsArg = meta.fpsArg ?? "30000/1001";
    const timeline = meta.timelineFrames;
    const captureEnd = Number.isFinite(meta.captureEnd) ? meta.captureEnd : timeline;
    // 读不出原片长度:剪切按不限长算、原片当作至少和时间轴一样长(最严的假设)
    const known = Number.isFinite(footageDuration);
    const footageFrames = known ? Math.ceil(footageDuration * fpsValue(fpsArg)) : Infinity;
    const now = cutFrameRanges(meta.cuts ?? [], fpsArg, known ? footageDuration : Infinity);
    let oldPng = 0;
    let newPng = 0;
    // 时间轴之后的帧两边都没有动效层,不用比;原片结束之后的帧到不了成片,也不用比
    for (let k = 0; k < Math.min(timeline, footageFrames); k++) {
      const oldTaken = k < captureEnd && !inFrameRanges(meta.skipFrames, k);
      if (oldTaken) oldPng++;
      if (inFrameRanges(now, k)) continue; // 新原片这一帧剪掉了:用不到动效层
      newPng++;
      if (!oldTaken || oldPng !== newPng) {
        // captureEnd 是从 0 数「截到第几帧为止(不含)」,换成从 1 数正好是最后截了的那一帧
        if (k >= captureEnd && !known)
          return `读不出这条口播原片的长度,核对不了动效层够不够长(导出时只截到第 ${captureEnd} 帧,` +
            `后面没截)。用导出时那条原片,或者重新导出`;
        return k >= captureEnd
          ? `这条口播原片(${footageDuration.toFixed(2)}s)比导出时那条长:动效层只截到第 ${captureEnd} 帧,` +
              `后面的卡会缺。用导出时那条原片,或者重新导出`
          : `这条口播原片的长度(${known ? `${footageDuration.toFixed(2)}s` : "读不出"})和导出时不一样,` +
              `剪切段落到的帧变了:叠出来会错位。用导出时那条原片,或者重新导出`;
      }
    }
  }
  if (Number.isFinite(meta.frames) && pngCount !== meta.frames)
    return `PNG 应该有 ${meta.frames} 张,目录里是 ${pngCount} 张:重新导出`;
  return null;
}

/** HDR 原片、本机 ffmpeg 又不带 zscale 时的报错(导出前的检查和合成时共用一句) */
export function hdrError(transfer) {
  return `口播原片是 HDR(${transfer}),转成普通画面需要带 zscale 的 ffmpeg;本机这版没有。先把原片导出成 SDR(剪映/相册里关掉 HDR)再导`;
}

/** 本机有没有这个命令(ffmpeg / ffprobe) */
export function hasBin(bin) {
  return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
}

/** select/aselect 用的「保留」表达式:n 是帧(格)下标,剪掉 [起, 止) */
function keepExpr(ranges) {
  return `not(${ranges.map(([s, e]) => `between(n,${s},${e - 1})`).join("+")})`;
}

/**
 * 拼 ffmpeg 参数。单独拆出来是为了能不跑 ffmpeg 就检查滤镜链。
 * camSegs 那几段动效层里已经烤了一份人物,原片画面要在这几段涂黑,
 * 否则成片里会看到两层人(和「合成说明」让用户在剪映里手动做的是同一件事)。
 */
export function buildArgs({
  footage, seq, fpsArg, sfxMix, camSegs = [], cuts = [], stage, out, footageHasAudio, hdr = false,
  maxSec = Infinity, filterFile = null, overlayPreCut = false,
  voiceGainDb = 0, sideGainDb = 0, bgm = null, bgmVolumeDb = BGM_DEFAULT_DB, duck = true,
}) {
  const args = ["-y", "-nostats", "-progress", "pipe:1", "-i", footage, "-framerate", fpsArg, "-i", seq];
  const sfxIn = sfxMix ? 2 : -1;
  if (sfxMix) args.push("-i", sfxMix);
  const bgmIn = bgm ? (sfxMix ? 3 : 2) : -1;
  // 背景音乐无限循环读入,后面按成片长度截断(短曲子也能铺满整条)
  if (bgm) args.push("-stream_loop", "-1", "-i", bgm);

  const { w, h } = stage;
  // 涂黑区间左闭右开,和卡片「t < end 才显示」一致:卡消失的那一帧原片就回来
  const hide = camSegs
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => `,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,${s.start})*lt(t,${s.end})'`)
    .join("");
  const plan = planCuts(cuts, fpsValue(fpsArg), AUDIO_UNIT, maxSec);
  // 剪切按帧号丢帧,再把时间戳排紧。动效层 PNG 是完整时长时,叠完再剪(两层一起剪);
  // 「只导成片」模式下 PNG 导出时就跳过了剪切段里的帧(overlayPreCut),只剪原片、剪完再叠。
  // round():N/FRAME_RATE/TB 在 29.97 下是浮点运算,第 11 帧会算成 10.999… 被截成 10,和上一帧撞时间戳。
  // 剪切放在最后时 -r 会把它排回去,看不出来;先剪再叠时 overlay 按时间戳配对,这一帧就配上了上一张动效层
  const cutSel = plan.video.length ? `,select='${keepExpr(plan.video)}',setpts=round(N/FRAME_RATE/TB)` : "";

  // 色彩:成片按 bt709 标,所以原片和动效层都要真的转成 bt709,不能只贴标签。
  //   - HDR 原片(iPhone 默认的 HLG)先色调映射到 SDR,否则成片发灰发白;
  //   - 动效层 PNG 是 RGB,ffmpeg 自动转 YUV 时默认用 bt601 矩阵,颜色会偏一点,这里显式指定 bt709。
  const toSdr = hdr
    ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0," +
      "zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
    : "";
  const filters = [
    // 原片按导出帧率重采样、等比缩放进画布(不裁,留黑边)。
    // start_time=0:手机/OBS 的 MP4 常带编辑列表,视频比音频晚零点几秒开始。剪切按帧号/格号数,
    // 两条流都要从 0 起数,否则这点起始差会变成整条成片的固定口型偏移(音频那边见 first_pts=0)
    `[0:v]${toSdr}fps=${fpsArg}:start_time=0,scale=${w}:${h}:force_original_aspect_ratio=decrease:` +
      `out_color_matrix=bt709:out_range=tv,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p${hide}${overlayPreCut ? cutSel : ""}[base]`,
    `[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[ov]`,
    // eof_action=pass:动效层比原片短时,后面照常放原片
    // 标签各用各的名字:[base] 是原片画面,[bg] 只给背景音乐。ffmpeg 允许同名标签按出现顺序配对,
    // 但那样以后谁调整一下滤镜顺序就会接错流
    `[base][ov]overlay=0:0:format=yuv420:eof_action=pass${overlayPreCut ? "" : cutSel},format=yuv420p[v]`,
  ];
  const maps = ["-map", "[v]"];
  const keptSec = Number.isFinite(maxSec) ? Math.max(0.1, maxSec - plan.removedSec) : null;

  // 音频一条流水线,顺序有讲究:
  //   人声(只取原片第一条音轨 —— OBS 录屏常带麦克风 + 系统声两条)→ 响度增益
  //   → 混音效 → 剪切 → 混背景音乐(人声说话时自动压低)→ 限幅。
  // 背景音乐放在剪切之后混:先混再剪的话,每一刀都会把音乐剪出一个跳点。
  // 什么处理都不需要时,原片音轨不加任何滤镜直接映射过去(仍会转码成 AAC 192k)。
  const gain = Math.abs(voiceGainDb) >= 0.1 ? `volume=${voiceGainDb.toFixed(1)}dB,` : "";
  let main = null; // 人声 + 音效(剪切前)
  if (footageHasAudio && sfxMix) {
    filters.push(
      `[${sfxIn}:a]volume=${SFX_GAIN}[sx]`,
      `[0:a:0]${gain}anull[vo]`,
      `[vo][sx]amix=inputs=2:duration=first:normalize=0[am]`,
    );
    main = "[am]";
  } else if (footageHasAudio) {
    if (gain) {
      filters.push(`[0:a:0]${gain.slice(0, -1)}[am]`);
      main = "[am]";
    } else main = "[0:a:0]";
  } else if (sfxMix) {
    // 原片没声音时只剩音效轨。音效混音按编排时长生成,可能比原片长:截到原片结束,
    // 否则成片的声音比画面长出几秒(上面有原声时 amix duration=first 已经按原声截了)
    const trim = Number.isFinite(maxSec) ? `,atrim=end=${maxSec}` : "";
    filters.push(`[${sfxIn}:a]volume=${SFX_GAIN}${trim}[am]`);
    main = "[am]";
  }
  let cut = main;
  if (main && plan.audio.length) {
    // 剪切:统一到 48kHz、切成 1ms 一格,按 planCuts 算好的格号丢,和视频剪掉的总时长对齐
    filters.push(
      `${main}aresample=${AUDIO_RATE}:async=1:first_pts=0,asetnsamples=n=${Math.round(AUDIO_RATE * AUDIO_UNIT)}:p=0,` +
        // round():同上,别让浮点误差把时间戳截掉一个样本
        `aselect='${keepExpr(plan.audio)}',asetpts=round(N/SR/TB)[ac]`,
    );
    cut = "[ac]";
  }
  let mixed = cut;
  let shortest = false;
  if (bgm) {
    // 音乐截到成片长度、最后 2 秒淡出;读不到原片时长就靠 amix duration=first(有人声时)或 -shortest 截
    const tail = keptSec
      ? `,atrim=end=${keptSec.toFixed(3)},afade=t=out:st=${Math.max(0, keptSec - 2).toFixed(3)}:d=2`
      : "";
    filters.push(`[${bgmIn}:a]aresample=${AUDIO_RATE},aformat=channel_layouts=stereo,volume=${bgmVolumeDb}dB${tail}[bg]`);
    if (cut) {
      // 人声也转成立体声再和音乐混:单声道麦克风 + 立体声音乐交给 amix,ffmpeg 会把整路混成单声道,
      // 音乐就被压成单声道了(有剪切时又会是立体声 —— 声道数不该取决于剪没剪)
      filters.push(`${cut}aresample=${AUDIO_RATE},aformat=channel_layouts=stereo[cst]`);
      cut = "[cst]";
    }
    if (cut && footageHasAudio && duck) {
      // 压低:拿剪切后的人声(连同音效)当侧链,说话时音乐降下去,停下来又慢慢回来。
      // 侧链先按响度统一的增益调到 -14 LUFS 再判断(只调侧链,不动听到的人声):
      // 不管原片录得多轻、响度统一开没开,压低的力度都一样。
      // 参数是实测挑的(测试信号是持续的正弦音):响度 -14 LUFS 时音乐压低约 14dB,
      // -20dBFS 左右的声音压低 7–10dB;真人说话有起伏、比正弦音「虚」,实际压低会比这少一些。
      // -48dBFS 的底噪(信噪比 34dB 左右的录音)只压 3dB 以内,-58dBFS 以下不压。
      // 压缩比再大、阈值再低能压得更狠,但底噪也会在停顿时把音乐压下去。音效也会让音乐让一下,它们很短,听不出来
      const side = Math.abs(sideGainDb) >= 0.1 ? `,volume=${sideGainDb.toFixed(1)}dB` : "";
      filters.push(
        `${cut}asplit=2[mainA][sideRaw]`,
        `[sideRaw]anull${side}[side]`,
        `[bg][side]sidechaincompress=${DUCK}[bgd]`,
        `[mainA][bgd]amix=inputs=2:duration=first:normalize=0[mx]`,
      );
      mixed = "[mx]";
    } else if (cut && footageHasAudio) {
      filters.push(`${cut}[bg]amix=inputs=2:duration=first:normalize=0[mx]`);
      mixed = "[mx]";
    } else if (cut) {
      // 原片没声音、只有音效:音效轨只到最后一张卡结束,比原片短。长度要跟音乐(已经截到成片长度)走,
      // 不能跟音效走,否则音乐在音效结束处就断了、淡出也没了。读不到成片长度时用最长的那路,再靠 -shortest 截到画面
      filters.push(
        keptSec
          ? `[bg]${cut}amix=inputs=2:duration=first:normalize=0[mx]`
          : `${cut}[bg]amix=inputs=2:duration=longest:normalize=0[mx]`,
      );
      mixed = "[mx]";
      shortest = !keptSec;
    } else {
      mixed = "[bg]";
      shortest = !keptSec;
    }
  }
  if (mixed && mixed !== "[0:a:0]") {
    // 人声提了增益、叠了音效或音乐都可能削波:最后过一道 -1dBFS 限幅。
    // level=0:alimiter 默认会把整体音量自动拉回 0dBFS,那就不是「限幅」而是「提音量」了;
    // latency=1:补偿它的预读延迟(默认会让声音整体晚 5ms)
    filters.push(`${mixed}alimiter=limit=0.891:level=0:latency=1[a]`);
    maps.push("-map", "[a]");
  } else if (mixed) {
    maps.push("-map", "0:a:0");
  }
  if (shortest) maps.push("-shortest");

  // 滤镜图每一刀约 50 个字符:几百刀就超过 Windows 命令行 32767 字符的上限,spawn 直接失败。
  // 只有图长到放不进命令行时才写进 filterFile、用 -filter_complex_script 读:这个选项从
  // FFmpeg 7.1 起标为过时(新写法 -/filter_complex 老版本又不认),平常的导出不该依赖它
  const filter = filters.join(";");
  const useFile = !!filterFile && filter.length > FILTER_INLINE_MAX;
  args.push(
    ...(useFile ? ["-filter_complex_script", filterFile] : ["-filter_complex", filter]),
    ...maps,
    // 输出帧率写死:select + setpts 之后流会被当成可变帧率,
    // 不写的话 ffmpeg 按默认 25fps 输出,29.97 的片子每 6 帧丢 1 帧
    "-r", fpsArg,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "192k",
    // 成片以原片长度为准(主输入);moov 前置,网页/手机边下边播
    "-movflags", "+faststart",
    out,
  );
  return { args, filter, useFile, removedSec: plan.removedSec };
}

/**
 * 正在跑的合成:导出脚本被叫停时(看门狗发 SIGTERM)用 stopComposing 一起停掉,
 * 并且当场删掉半截的 MP4 和滤镜图临时文件 —— 进程马上就要退出,等不到 close 回调里的清理
 */
const running = new Map(); // child → 要删的文件
export function stopComposing() {
  for (const [c, files] of running) {
    c.kill("SIGKILL");
    for (const f of files) fs.rmSync(f, { force: true });
  }
  running.clear();
}

/**
 * 合成成片。失败不抛异常,返回原因,由调用方决定算不算导出失败:普通导出时透明层已经导好了,
 * 成片失败不该连累它;「只导成片」时成片是唯一的成品,导出脚本会把它当失败报。
 *
 * 异步跑 ffmpeg,边跑边回报进度:长片子编码要十几分钟,一声不吭的话
 * 开发服务器的「15 分钟没动静就杀掉」看门狗会把整个导出判成失败。
 * stderr 只留尾巴(报错原因在最后几行),不整段攒在内存里。
 */
export function composeFinal({
  footage, seq, fpsArg, sfxMix = null, camSegs = [], cuts = [], stage, out, onProgress, workDir = path.dirname(out),
  audio = {}, overlayPreCut = false,
}) {
  if (!fs.existsSync(footage)) return Promise.resolve({ ok: false, error: `找不到口播原片:${footage}` });
  const info = probeFootage(footage);
  if (info.hdr && !hasZscale())
    return Promise.resolve({
      ok: false,
      error: hdrError(info.transfer),
    });
  const mix = sfxMix && fs.existsSync(sfxMix) ? sfxMix : null;
  const bgm = audio.bgm && fs.existsSync(audio.bgm) ? audio.bgm : null;
  // 响度统一默认开:量一遍原声的整体响度,算出一个固定增益(不压动态、不改时间)。
  // 关了响度统一但要压低音乐时也要量:压低的侧链要按 -14 LUFS 判断(见 buildArgs)
  const normalize = audio.normalize !== false;
  const duck = audio.duck !== false;
  const loud = info.hasAudio && (normalize || (bgm && duck)) ? measureLoudness(footage) : null;
  const gain = loud === null ? 0 : loudnessGain(loud);
  const voiceGainDb = normalize ? gain : 0;
  const sideGainDb = normalize ? 0 : gain; // 人声已经调过就不用再调侧链
  // 滤镜图临时文件放工作目录(导出时是 PNG 目录),不放用户去拿成品的 exports/output/
  const filterFile = path.join(workDir, `${path.basename(out)}.filtergraph.txt`);
  const { args, filter, useFile, removedSec } = buildArgs({
    footage, seq, fpsArg, sfxMix: mix, camSegs, cuts, stage, out, footageHasAudio: info.hasAudio, hdr: info.hdr,
    maxSec: info.duration ?? Infinity, filterFile, overlayPreCut,
    voiceGainDb, sideGainDb, bgm, bgmVolumeDb: Number.isFinite(audio.bgmVolume) ? audio.bgmVolume : BGM_DEFAULT_DB, duck,
  });
  // 给调用方(导出结果 / 界面)看:实际量到的响度和用了多少增益,音乐有没有用上
  const audioReport = {
    // 关了响度统一时也可能量过(给压低用),但没调人声:不报,免得界面说「已经合适,没调」
    loudness: normalize ? loud : null,
    loudnessStatus: normalize ? loudnessStatus(loud) : null,
    gainDb: Math.round(voiceGainDb * 10) / 10,
    bgm: !!bgm,
    bgmMissing: !!audio.bgm && !bgm,
  };
  if (useFile) {
    try {
      fs.writeFileSync(filterFile, filter);
    } catch (e) {
      // 写不进去(多半是盘满)也只算成片失败,透明层照样交付
      return Promise.resolve({ ok: false, error: `成片合成失败:写不了滤镜图临时文件(${e})` });
    }
  }
  const total = info.duration ? Math.max(0.1, info.duration - removedSec) : null;

  return new Promise((resolve) => {
    let tail = "";
    let buf = "";
    let lastPct = -1;
    let settled = false;
    // 心跳:进度数字可能长时间不变(读不到原片时长、或卡在最后 1%),每 30 秒照报一次,
    // 看门狗才知道它还活着。但只在 ffmpeg 真的还在干活时报:它干活时每 0.5 秒左右会写一块
    // -progress 输出,30 秒一块都没有就是卡死了,这时不报,让看门狗照常把它停掉。
    // 读不到总时长时报 null(界面显示「合成中」而不是一直停在 0%)
    let lastBlockAt = Date.now();
    const beat = onProgress
      ? setInterval(() => {
          if (Date.now() - lastBlockAt < 30_000) onProgress(total ? Math.max(0, lastPct) : null);
        }, 30_000)
      : null;
    const settle = (r) => {
      if (settled) return; // 没装 ffmpeg 时 error 和 close 都会来
      settled = true;
      if (beat) clearInterval(beat);
      if (useFile) fs.rmSync(filterFile, { force: true });
      resolve(r);
    };
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    running.set(child, useFile ? [out, filterFile] : [out]);
    child.on("close", () => running.delete(child));
    child.stderr.on("data", (d) => {
      tail = (tail + d).slice(-4000);
    });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("progress=")) lastBlockAt = Date.now(); // 每块进度的最后一行
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && total && onProgress) {
          const pct = Math.min(100, Math.floor(Number(m[1]) / 1e6 / total * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            onProgress(pct);
          }
        }
      }
    });
    const fail = (why) => {
      if (settled) return;
      fs.rmSync(out, { force: true }); // 半截的 MP4 没有索引,留着只会被当成坏片
      settle({ ok: false, error: `成片合成失败:${why}` });
    };
    child.on("error", (e) => fail(String(e)));
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(out)) return settle({ ok: true, out, audio: audioReport });
      fail(tail.trim().split("\n").slice(-3).join(" / ") || `ffmpeg 退出码 ${code}`);
    });
  });
}

// 单独跑:手上已有 PNG 序列时,不用重新渲染就能合一条成片
// 比真实路径:通过软链接的路径调用时(比如 home 目录本身是个链接),两边字符串不一样,
// 以前会判成「不是直接运行」,什么都不做就退出 0
const realOrSelf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  const [footage, frameDir, out, sfxArg] = process.argv.slice(2);
  if (!footage || !frameDir || !out) {
    console.error("usage: node compose-final.mjs <footage> <PNG 序列目录> <out.mp4> [sfx.m4a]");
    process.exit(1);
  }
  // 导出时写下的合成参数;没有(老版本导出的 PNG 目录)就按默认值,并说清楚少了什么
  let meta = {};
  const metaFile = path.join(frameDir, "compose.json");
  if (fs.existsSync(metaFile)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    } catch (e) {
      console.error(`compose.json 读不出来(${e}),按默认值合成`);
    }
  } else console.error("没找到 compose.json:按 29.97fps / 1920×1080 合成,不剪切、不涂黑烤入人物的时段");
  const sfx = sfxArg ?? (fs.existsSync(path.join(frameDir, "sfx-mix.m4a")) ? path.join(frameDir, "sfx-mix.m4a") : null);
  if (!fs.existsSync(footage)) {
    console.error(`找不到口播原片:${footage}`);
    process.exit(1);
  }
  const pngCount = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /^frame_\d{6}\.png$/.test(f)).length : 0;
  const mismatch = checkPreCutMeta(meta, probeFootage(footage).duration, pngCount);
  if (mismatch) {
    console.error(mismatch);
    process.exit(1);
  }
  const r = await composeFinal({
    footage,
    seq: path.join(frameDir, "frame_%06d.png"),
    fpsArg: meta.fpsArg ?? "30000/1001",
    sfxMix: sfx,
    camSegs: meta.camSegs ?? [],
    cuts: meta.cuts ?? [],
    stage: meta.stage ?? { w: 1920, h: 1080 },
    audio: meta.audio ?? {},
    overlayPreCut: meta.overlayPreCut === true,
    out,
    // 滤镜图临时文件(刀数多时才有)放 PNG 目录:默认会放在输出文件旁边,也就是 exports/output/ 里
    workDir: frameDir,
    onProgress: (p) => process.stderr.write(p === null ? "." : `\r${p}%`),
  });
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
}
