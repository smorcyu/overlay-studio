/**
 * PNG 序列 → 透明视频(导出脚本用):剪映用的 ProRes 4444 MOV、小体积的 VP9 WebM,
 * 以及「一张都没截」时补的那张全透明帧。都要本机 ffmpeg
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** 剪映友好:ProRes 4444 透明 MOV(编码快,文件较大)。成功返回 true;失败时删掉半截文件 */
export function encodeMov(seq, out, fpsArg) {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-framerate", fpsArg, "-i", seq,
      // 预乘 alpha(定案,勿再删)。剪映按**预乘**合成 ProRes 4444:
      // 它算的是 dst*(1-a) + c,而不是 dst*(1-a) + c*a。所以必须先把 RGB 乘上 alpha。
      //
      // 曾以"预乘会把半透明压暗一倍"为由去掉这行 —— 那次测法是错的:
      // 拿 MOV 的 RGB 通道直接叠黑底比亮度(120 vs 58),那测的是文件里的裸颜色,
      // 不是剪映合出来的画面;预乘后 RGB 本来就该变暗,合成时 alpha 不再乘第二遍才对得上。
      //
      // 用真成片回归验证(45s 整帧、按 alpha 分档比对预测值与实际像素):
      //   alpha 档     直通模型误差 / 预乘模型误差
      //   ≈全透明        16.58 / 1.78
      //   很淡           78.11 / 2.28
      //   半透明(玻璃)     8.08 / 0.90
      //   较实            4.93 / 2.97
      // 每一档都是预乘模型胜。不预乘的后果:全透明区的 RGB 是近白垃圾值,
      // 会被直接加进画面 —— 半透明羽化区因此会在成片里烧成一圈白边。
      "-vf", "premultiply=inplace=1",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0",
      // 色彩空间标记:不写的话 ffprobe 三项都是 unknown,剪映只能猜,
      // 猜错就整条偏色(导进剪映后整条颜色不对)。原片是 bt709,对齐它。
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", out],
    { stdio: "ignore" },
  );
  if (r.status === 0 && fs.existsSync(out)) return true;
  // 失败多半是写到一半磁盘满了:半截 MOV 没有 moov 索引,留着只会被误当成成片
  fs.rmSync(out, { force: true });
  return false;
}

/** 小体积:VP9 透明 WebM(编码稍慢;剪映不认 WebM 透明,给网页/达芬奇用)。成功返回 true */
export function encodeWebm(seq, out, fpsArg) {
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-framerate", fpsArg, "-i", seq,
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
      "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0", out],
    { stdio: "ignore" },
  );
  if (r.status === 0 && fs.existsSync(out)) return true;
  fs.rmSync(out, { force: true });
  return false;
}

/** 一张全透明的 PNG(stage 大小)。成功返回 true */
export function writeBlankFrame(file, stage) {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black@0:s=${stage.w}x${stage.h},format=rgba`,
      "-frames:v", "1", file],
    { stdio: "ignore" },
  );
  return r.status === 0;
}
