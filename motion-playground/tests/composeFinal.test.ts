import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildArgs, planCuts, fpsValue, loudnessGain, loudnessStatus, parseLoudness, LOUDNESS_TARGET, BGM_DEFAULT_DB,
} from "../scripts/compose-final.mjs";
import { normalizeAudio, BGM_VOLUME_DEFAULT } from "../src/overlay/types.ts";

test("loudnessGain: brings speech to the target, clamped, and leaves near-silence alone", () => {
  assert.equal(LOUDNESS_TARGET, -14);
  assert.equal(loudnessGain(-23), 9);
  assert.equal(loudnessGain(-10), -4);
  assert.equal(loudnessGain(-45), 20); // 最多提 20dB
  assert.equal(loudnessGain(-70), 0); // 基本是静音:不提,免得放大底噪
  assert.equal(loudnessGain(NaN), 0);
});

test("loudnessStatus tells adjusted / ok / silent / capped apart (the export dialog shows it)", () => {
  assert.equal(loudnessStatus(-23), "adjusted");
  assert.equal(loudnessStatus(-14.05), "ok");
  assert.equal(loudnessStatus(-45), "capped");
  assert.equal(loudnessStatus(-70), "silent");
  assert.equal(loudnessStatus(NaN), null);
});

test("parseLoudness reads the ebur128 summary, not a per-frame reading", () => {
  const stderr = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M: -40.1 S:-120.7     I: -40.1 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] t: 0.2  TARGET:-23 LUFS    M: -30.0 S:-120.7     I: -33.2 LUFS       LRA:   0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] Summary:",
    "",
    "  Integrated loudness:",
    "    I:         -23.4 LUFS",
    "    Threshold: -33.4 LUFS",
    "",
    "  Loudness range:",
    "    LRA:         5.1 LU",
  ].join("\n");
  assert.equal(parseLoudness(stderr), -23.4);
  assert.equal(parseLoudness("    I:         -inf LUFS"), null);
  assert.equal(parseLoudness("Error opening input"), null);
  assert.equal(parseLoudness(undefined), null);
});

test("normalizeAudio: keeps only valid, non-default settings", () => {
  assert.equal(normalizeAudio(undefined), undefined);
  assert.equal(normalizeAudio({ normalize: true, duck: true, bgmVolume: -20 }), undefined); // 全是默认值:不写进 JSON
  assert.deepEqual(normalizeAudio({ normalize: false, bgm: "/_media/a.mp3?v=1", bgmVolume: -55.4, duck: false }), {
    normalize: false, bgm: "/_media/a.mp3?v=1", bgmVolume: -40, duck: false,
  });
  assert.deepEqual(normalizeAudio({ bgm: "/etc/passwd", bgmVolume: 7 }), { bgmVolume: 0 }); // 只认 _media 里的音乐
  assert.equal(normalizeAudio({ bgm: "/_media/../sfx/x.mp3" }), undefined); // 不许用 .. 跳出 _media
  assert.equal(normalizeAudio({ bgm: "/_media/%2e%2e/x.mp3" }), undefined);
  assert.equal(normalizeAudio({ bgm: "/_media/50%off.mp3" }), undefined); // 不合法的 %:界面解码会崩
});

test("the editor and the exporter agree on the default music volume", () => {
  assert.equal(BGM_VOLUME_DEFAULT, BGM_DEFAULT_DB);
});

const base = {
  footage: "foot.mp4",
  seq: "frames/frame_%06d.png",
  fpsArg: "30000/1001",
  stage: { w: 1920, h: 1080 },
  out: "out.mp4",
};
const argsOf = (o: Record<string, unknown>) => buildArgs({ ...base, ...o }).args as string[];
const filterOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];
const mapsOf = (args: string[]) => args.slice(args.indexOf("-map"), args.indexOf("-r"));

const LIMIT = "alimiter=limit=0.891:level=0:latency=1[a]";

test("voice + sfx: sfx turned down, mixed under the first voice track, limited without auto-gain or delay", () => {
  const a = argsOf({ sfxMix: "sfx.m4a", footageHasAudio: true });
  const f = filterOf(a);
  assert.ok(f.includes("[2:a]volume=0.2[sx]"));
  assert.ok(f.includes("[0:a:0]anull[vo];[vo][sx]amix=inputs=2:duration=first:normalize=0[am]"));
  assert.ok(f.endsWith(`[am]${LIMIT}`), "the limiter is the last audio step");
  assert.deepEqual(mapsOf(a), ["-map", "[v]", "-map", "[a]"]);
});

test("loudness gain is applied to the voice before mixing, then limited", () => {
  const f = filterOf(argsOf({ sfxMix: "sfx.m4a", footageHasAudio: true, voiceGainDb: 6.04 }));
  assert.ok(f.includes("[0:a:0]volume=6.0dB,anull[vo]"));
  const solo = filterOf(argsOf({ sfxMix: null, footageHasAudio: true, voiceGainDb: -3.5 }));
  assert.ok(solo.includes(`[0:a:0]volume=-3.5dB[am];[am]${LIMIT}`));
  // 增益小到可以忽略:原片音轨原样带过去,不加任何处理
  assert.deepEqual(mapsOf(argsOf({ sfxMix: null, footageHasAudio: true, voiceGainDb: 0.04 })), ["-map", "[v]", "-map", "0:a:0"]);
});

test("background music: looped input, mixed after cuts, trimmed to the cut length, faded, ducked under the voice", () => {
  const a = argsOf({
    sfxMix: null, footageHasAudio: true, maxSec: 60, bgm: "m.mp3", bgmVolumeDb: -18,
    cuts: [{ start: 10, end: 20 }],
  });
  const i = a.indexOf("m.mp3");
  assert.deepEqual(a.slice(i - 3, i + 1), ["-stream_loop", "-1", "-i", "m.mp3"]);
  const f = filterOf(a);
  // 成片长度 = 60 − 剪掉的时长(剪切落到帧上,约 9.98 秒);音乐截到这个长度,最后 2 秒淡出
  const kept = 60 - planCuts([{ start: 10, end: 20 }], fpsValue("30000/1001")).removedSec;
  assert.ok(
    f.includes(
      `[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=-18dB,` +
        `atrim=end=${kept.toFixed(3)},afade=t=out:st=${(kept - 2).toFixed(3)}:d=2[bg]`,
    ),
  );
  assert.ok(f.indexOf("aselect=") < f.indexOf("sidechaincompress"), "music is mixed after the cuts, so cuts don't jump the music");
  assert.ok(f.includes("[cst]asplit=2[mainA][sideRaw];[sideRaw]anull[side];[bg][side]sidechaincompress=threshold=0.02:ratio=20:attack=20:release=400:level_sc=4[bgd]"));
  assert.ok(f.includes("[mainA][bgd]amix=inputs=2:duration=first:normalize=0[mx];[mx]" + LIMIT));
  assert.deepEqual(mapsOf(a), ["-map", "[v]", "-map", "[a]"]);
});

test("ducking judges speech at the normalized level even when normalization is off (side signal only)", () => {
  const f = filterOf(argsOf({ sfxMix: null, footageHasAudio: true, maxSec: 30, bgm: "m.mp3", voiceGainDb: 0, sideGainDb: 9 }));
  assert.ok(f.includes("[cst]asplit=2[mainA][sideRaw];[sideRaw]anull,volume=9.0dB[side]"));
  assert.ok(f.includes("[mainA][bgd]amix"), "the audible voice is not boosted");
});

test("background music input index follows the sfx input; ducking can be turned off", () => {
  const a = argsOf({ sfxMix: "s.m4a", footageHasAudio: true, maxSec: 30, bgm: "m.mp3", duck: false });
  const f = filterOf(a);
  assert.ok(f.includes("[3:a]aresample=48000"));
  assert.ok(!f.includes("sidechaincompress"));
  assert.ok(f.includes("[cst][bg]amix=inputs=2:duration=first:normalize=0[mx]"));
});

test("with music, the voice is made stereo before mixing (a mono mic must not turn the music mono)", () => {
  for (const cuts of [[], [{ start: 2, end: 3 }]]) {
    const f = filterOf(argsOf({ sfxMix: null, footageHasAudio: true, maxSec: 30, bgm: "m.mp3", cuts }));
    assert.match(f, /aresample=48000,aformat=channel_layouts=stereo\[cst\];\[cst\]asplit=2/);
  }
});

test("silent footage + sfx + music: the length follows the music (trimmed to the video), not the shorter sfx track", () => {
  const known = argsOf({ sfxMix: "s.m4a", footageHasAudio: false, maxSec: 10, bgm: "m.mp3" });
  const f = filterOf(known);
  assert.ok(f.includes("[bg][cst]amix=inputs=2:duration=first:normalize=0[mx]"), "music first, so it decides the length");
  assert.ok(!known.includes("-shortest"));
  const unknown = argsOf({ sfxMix: "s.m4a", footageHasAudio: false, bgm: "m.mp3" });
  assert.ok(filterOf(unknown).includes("[cst][bg]amix=inputs=2:duration=longest:normalize=0[mx]"));
  assert.ok(unknown.includes("-shortest"), "unknown length: the looping music is cut at the end of the video");
});

test("music only (silent footage): music alone, -shortest when the footage length is unknown", () => {
  const known = argsOf({ sfxMix: null, footageHasAudio: false, maxSec: 12, bgm: "m.mp3" });
  assert.ok(filterOf(known).includes(`[bg]${LIMIT}`));
  assert.ok(!known.includes("-shortest"));
  const unknown = argsOf({ sfxMix: null, footageHasAudio: false, bgm: "m.mp3" });
  assert.ok(unknown.includes("-shortest"));
  assert.ok(!filterOf(unknown).includes("atrim"));
});

test("silent footage + sfx: the sfx track is trimmed to the footage length", () => {
  // 音效混音按编排时长生成,可能比原片长;不截的话成片声音比画面长出几秒
  const f = filterOf(argsOf({ sfxMix: "s.m4a", footageHasAudio: false, maxSec: 20 }));
  assert.ok(f.includes("[2:a]volume=0.2,atrim=end=20[am]"));
  const unknown = filterOf(argsOf({ sfxMix: "s.m4a", footageHasAudio: false }));
  assert.ok(unknown.includes("[2:a]volume=0.2[am]")); // 读不到原片时长就不截
});

test("voice only / sfx only / silent footage map exactly one audio track", () => {
  assert.deepEqual(mapsOf(argsOf({ sfxMix: null, footageHasAudio: true })), ["-map", "[v]", "-map", "0:a:0"]);
  assert.deepEqual(mapsOf(argsOf({ sfxMix: "s.m4a", footageHasAudio: false })), ["-map", "[v]", "-map", "[a]"]);
  assert.deepEqual(mapsOf(argsOf({ sfxMix: null, footageHasAudio: false })), ["-map", "[v]"]);
});

test("progress goes to stdout so the export watchdog sees activity", () => {
  const a = argsOf({ footageHasAudio: false });
  assert.deepEqual(a.slice(0, 4), ["-y", "-nostats", "-progress", "pipe:1"]);
});

test("output frame rate is pinned (select + setpts would otherwise fall back to 25fps)", () => {
  for (const cuts of [[], [{ start: 2, end: 3 }]]) {
    const a = argsOf({ footageHasAudio: true, cuts });
    assert.equal(a[a.indexOf("-r") + 1], "30000/1001");
    assert.ok(a.indexOf("-r") < a.indexOf("out.mp4"), "-r must be an output option");
  }
});

test("both streams start at 0 before cutting by index (edit-list footage would shift A/V)", () => {
  const f = filterOf(argsOf({ footageHasAudio: true, cuts: [{ start: 2, end: 3 }] }));
  assert.ok(f.includes("fps=30000/1001:start_time=0,"));
  assert.ok(f.includes("aresample=48000:async=1:first_pts=0,"));
});

test("filter graph can go to a file (long cut lists exceed the Windows command-line limit)", () => {
  const many = Array.from({ length: 700 }, (_, i) => ({ start: i * 2 + 0.3, end: i * 2 + 0.8 }));
  const r = buildArgs({ ...base, footageHasAudio: true, cuts: many, filterFile: "g.txt" });
  const args = r.args as string[];
  assert.equal(r.useFile, true);
  assert.equal(args[args.indexOf("-filter_complex_script") + 1], "g.txt");
  assert.ok(!args.includes("-filter_complex"));
  assert.ok(args.join(" ").length < 32767, `command line is ${args.join(" ").length} chars`);
  assert.ok(r.filter.length > 32767, "the graph itself is long; that's why it goes to a file");
});

test("short graphs stay inline even when a filter file is offered (-filter_complex_script is deprecated in newer ffmpeg)", () => {
  const r = buildArgs({ ...base, footageHasAudio: true, cuts: [{ start: 2, end: 3 }], filterFile: "g.txt" });
  const args = r.args as string[];
  assert.equal(r.useFile, false);
  assert.ok(args.includes("-filter_complex"));
  assert.ok(!args.includes("-filter_complex_script"));
});

test("colors: overlay converted with the bt709 matrix; HDR footage is tone-mapped first", () => {
  const sdr = filterOf(argsOf({ footageHasAudio: false }));
  assert.ok(sdr.includes("[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[ov]"));
  assert.ok(!sdr.includes("tonemap"));
  const hdr = filterOf(argsOf({ footageHasAudio: false, hdr: true }));
  assert.ok(hdr.startsWith("[0:v]zscale=t=linear"));
  assert.ok(hdr.includes("tonemap=tonemap=hable"));
});

test("cuts: video drops whole frames by index, audio by 1ms units after resampling", () => {
  const a = argsOf({ sfxMix: null, footageHasAudio: true, cuts: [{ start: 6, end: 7 }, { start: 2, end: 4 }] });
  const f = filterOf(a);
  // 2s→第 60 帧,4s→第 120 帧;6s→180,7s→210
  assert.ok(f.includes("select='not(between(n,60,119)+between(n,180,209))',setpts=N/FRAME_RATE/TB"));
  assert.ok(f.includes("[0:a:0]aresample=48000:async=1:first_pts=0,asetnsamples=n=48:p=0,aselect='not(between(n,"));
  assert.deepEqual(mapsOf(a), ["-map", "[v]", "-map", "[a]"]);
});

test("planCuts: audio removed stays within half a millisecond of video removed, no matter how many cuts", () => {
  const fps = fpsValue("30000/1001");
  // 300 刀,长短位置都不规整(「全部采纳」停顿建议的那种量)
  const cuts = Array.from({ length: 300 }, (_, i) => {
    const s = i * 4.137 + 0.31;
    return { start: s, end: s + 0.27 + ((i * 37) % 90) / 100 };
  });
  const plan = planCuts(cuts, fps);
  assert.equal(plan.video.length, 300);
  let v = 0;
  let a = 0;
  for (let i = 0; i < plan.video.length; i++) {
    v += (plan.video[i][1] - plan.video[i][0]) / fps;
    a += (plan.audio[i][1] - plan.audio[i][0]) * 0.001;
    // 每一刀之后(不只是片尾)两边累计剪掉的时长都对得上:这一刀之后的画面和声音是对齐的
    assert.ok(Math.abs(v - a) <= 0.0005 + 1e-9, `after cut ${i}: video ${v} vs audio ${a}`);
  }
  // 按秒直接剪(旧做法)会差多少,留个对照:同一批刀,视频按帧、音频按 21.3ms 音频帧取整
  let drift = 0;
  for (const c of cuts) {
    const dv = (Math.round(c.end * fps) - Math.round(c.start * fps)) / fps;
    const af = 1024 / 48000;
    const da = (Math.ceil(c.end / af) - Math.ceil(c.start / af)) * af;
    drift += dv - da;
  }
  assert.ok(Math.abs(drift) > 0.005, "the old per-second approach should drift noticeably on this input");
});

test("planCuts: nearly adjacent cuts merge instead of double-counting the overlap", () => {
  const fps = fpsValue("30000/1001");
  // 300 对相隔不到一帧的剪切:落到帧上以后首尾相接
  const cuts = Array.from({ length: 300 }, (_, i) => {
    const s = i * 3 + 1;
    return [{ start: s, end: s + 0.41 }, { start: s + 0.42, end: s + 0.8 }];
  }).flat();
  const plan = planCuts(cuts, fps);
  let v = 0;
  let a = 0;
  for (let i = 0; i < plan.video.length; i++) {
    if (i) assert.ok(plan.video[i][0] > plan.video[i - 1][1], "video ranges must not touch");
    if (i) assert.ok(plan.audio[i][0] >= plan.audio[i - 1][1], "audio ranges must not overlap");
    v += (plan.video[i][1] - plan.video[i][0]) / fps;
    a += (plan.audio[i][1] - plan.audio[i][0]) * 0.001;
    assert.ok(Math.abs(v - a) <= 0.0005 + 1e-9, `after cut ${i}: video ${v} vs audio ${a}`);
  }
});

test("planCuts: cuts past the end of the footage don't count as removed", () => {
  const fps = fpsValue("30000/1001");
  const plan = planCuts([{ start: 8, end: 12 }, { start: 15, end: 20 }], fps, 0.001, 10);
  assert.equal(plan.video.length, 1);
  assert.ok(Math.abs(plan.removedSec - 2) < 0.02, `removed ${plan.removedSec}`);
});

test("planCuts: audio cut positions sit next to the video cut positions", () => {
  const fps = fpsValue("30000/1001");
  const plan = planCuts([{ start: 2, end: 2.5 }, { start: 10.01, end: 10.4 }], fps);
  for (let i = 0; i < plan.video.length; i++) {
    const vStart = plan.video[i][0] / fps;
    const aStart = plan.audio[i][0] * 0.001;
    assert.ok(Math.abs(vStart - aStart) <= 0.0005 + 1e-9);
  }
});

test("cam segments black out the footage with a half-open range", () => {
  const f = filterOf(argsOf({ footageHasAudio: false, camSegs: [{ start: 1, end: 2.5 }, { start: 3, end: 3 }] }));
  assert.ok(f.includes("enable='gte(t,1)*lt(t,2.5)'"));
  assert.equal(f.match(/drawbox/g)?.length, 1); // 零长度段丢掉
});
