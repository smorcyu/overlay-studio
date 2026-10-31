/**
 * 成片合成:口播原片 + 透明动效层 + 音效 → 一条可直接发布的 MP4
 *
 * 导出脚本在 PNG 序列和音效混音都做好之后调用它。用 PNG 序列而不是 MOV 当动效层:
 * MOV 是给剪映的**预乘** alpha,ffmpeg overlay 默认按直通 alpha 合成,拿 MOV 叠会让
 * 半透明边缘发暗;PNG 本来就是直通 alpha,直接叠就对。
 *
 * 有剪切段(doc.cuts)时,原片、动效层、音效一起剪掉这些段 —— 只剪成片;透明 MOV/WebM 仍是完整时长。
 *
 * 用法(导出脚本内部): composeFinal({ footage, seq, fpsArg, sfxMix, camSegs, cuts, out, stage })
 * 也可单独跑:node scripts/compose-final.mjs <footage> <frame_%06d.png 所在目录> <out.mp4> [sfx.m4a]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 音效相对人声的音量:约 -14dB(合成说明里一直建议剪映里调到 -12~-18dB) */
const SFX_GAIN = 0.2;

function hasAudio(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return r.status === 0 && r.stdout.trim() !== "";
}

/**
 * 拼 ffmpeg 参数。单独拆出来是为了能不跑 ffmpeg 就检查滤镜链。
 * camSegs 那几段动效层里已经烤了一份人物,原片画面要在这几段涂黑,
 * 否则成片里会看到两层人(和「合成说明」让用户在剪映里手动做的是同一件事)。
 */
/**
 * 剪切段规整:非法段丢掉、排序、重叠/相接的合并。
 * 和编辑台 src/overlay/cuts.ts 的 normalizeCuts 同一套规则(那边是 TS,这里没法直接引用)。
 */
export function normalizeCuts(raw) {
  if (!Array.isArray(raw)) return [];
  const list = raw
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start >= 0.05)
    .map((c) => ({ start: Math.max(0, c.start), end: c.end }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of list) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}

export function buildArgs({ footage, seq, fpsArg, sfxMix, camSegs = [], cuts = [], stage, out, footageHasAudio }) {
  const args = ["-y", "-i", footage, "-framerate", fpsArg, "-i", seq];
  if (sfxMix) args.push("-i", sfxMix);

  const { w, h } = stage;
  const hide = camSegs
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => `,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,${s.start},${s.end})'`)
    .join("");
  // 剪切:画面和声音用同一个「保留」表达式丢掉剪切段,再把时间戳重新排紧。
  // 区间左闭右开(gte/lt),和编辑台预览跳过的规则一致。放在叠完动效层、混完音之后做,
  // 所以原片、动效层、音效三者是一起剪的,不会错位。
  const cutList = normalizeCuts(cuts);
  const keep = cutList.length
    ? `not(${cutList.map((c) => `gte(t,${c.start})*lt(t,${c.end})`).join("+")})`
    : null;
  const vCut = keep ? `select='${keep}',setpts=N/FRAME_RATE/TB,` : "";
  // 原片按导出帧率重采样、等比缩放进画布(不裁,留黑边),再叠动效层。
  // eof_action=pass:动效层比原片短时,后面照常放原片。
  const filters = [
    `[0:v]fps=${fpsArg},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${hide}[bg]`,
    `[bg][1:v]overlay=0:0:format=auto:eof_action=pass,${vCut}format=yuv420p[v]`,
  ];
  const maps = ["-map", "[v]"];
  // 先拼出一路音频(原声 + 音效 / 只有原声 / 只有音效),有剪切再统一剪
  let audio = null;
  if (footageHasAudio && sfxMix) {
    filters.push(`[2:a]volume=${SFX_GAIN}[sx]`, `[0:a][sx]amix=inputs=2:duration=first:normalize=0[am]`);
    audio = "[am]";
  } else if (footageHasAudio) {
    audio = "[0:a]";
  } else if (sfxMix) {
    filters.push(`[2:a]volume=${SFX_GAIN}[am]`);
    audio = "[am]";
  }
  if (audio && keep) {
    filters.push(`${audio}aselect='${keep}',asetpts=N/SR/TB[a]`);
    maps.push("-map", "[a]");
  } else if (audio) {
    maps.push("-map", audio === "[0:a]" ? "0:a" : audio);
  }

  args.push(
    "-filter_complex", filters.join(";"),
    ...maps,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "192k",
    // 成片以原片长度为准(主输入);moov 前置,网页/手机边下边播
    "-movflags", "+faststart",
    out,
  );
  return args;
}

/** 合成成片。失败不抛异常,返回原因 —— 透明层已经导好了,成片失败不该连累它。 */
export function composeFinal({ footage, seq, fpsArg, sfxMix = null, camSegs = [], cuts = [], stage, out }) {
  if (!fs.existsSync(footage)) return { ok: false, error: `找不到口播原片:${footage}` };
  const mix = sfxMix && fs.existsSync(sfxMix) ? sfxMix : null;
  const args = buildArgs({ footage, seq, fpsArg, sfxMix: mix, camSegs, cuts, stage, out, footageHasAudio: hasAudio(footage) });
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status === 0 && fs.existsSync(out)) return { ok: true, out };
  fs.rmSync(out, { force: true });
  const tail = String(r.stderr ?? "").trim().split("\n").slice(-3).join(" / ");
  return { ok: false, error: `成片合成失败:${tail || `ffmpeg 退出码 ${r.status}`}` };
}

// 单独跑:手上已有 PNG 序列时,不用重新渲染就能合一条成片
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [footage, frameDir, out, sfxMix] = process.argv.slice(2);
  if (!footage || !frameDir || !out) {
    console.error("usage: node compose-final.mjs <footage> <png 序列目录> <out.mp4> [sfx.m4a]");
    process.exit(1);
  }
  const r = composeFinal({
    footage,
    seq: path.join(frameDir, "frame_%06d.png"),
    fpsArg: "30000/1001",
    sfxMix: sfxMix ?? null,
    stage: { w: 1920, h: 1080 },
    out,
  });
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
}
