/**
 * 导出开工前的检查(导出脚本用):磁盘还剩多少、「只导成片」合不合得出来。
 */
import fs from "node:fs";
import path from "node:path";
import { hasBin, hasZscale, hdrError, probeFootage } from "./compose-final.mjs";
import { resolvePublic } from "./paths.mjs";

/**
 * 磁盘剩余字节数。fs.statfsSync 三平台通用(旧实现用 df,Windows 上没这命令,静默返回 Infinity
 * 等于保护失效)。查不到就放行,不为了一个预检卡住导出。
 */
export function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

export const gb = (n) => (n / 1024 ** 3).toFixed(1);

/**
 * 「只导成片」开工前就确认合得出来:这个模式只交付成片 MP4,合不出来就什么都没有。
 * 成片合成会失败的情况(缺口播视频、文件不在了、缺 ffmpeg、HDR 原片但 ffmpeg 不带 zscale)
 * 都要在渲染前说,别白渲染几分钟。返回 { why: 失败原因或 null, footageInfo }
 */
export function finalOnlyPrecheck(doc, root) {
  const footage = doc?.cam ? resolvePublic(path.join(root, "public"), doc.cam) : null;
  let why = !doc?.cam
    ? "「只导成片 MP4」要先导入口播视频(成片 = 口播原片 + 动效层)"
    : !hasBin("ffmpeg") || !hasBin("ffprobe")
      ? "「只导成片 MP4」要用 ffmpeg 和 ffprobe 合成成片,本机没装或不在 PATH 里(macOS: brew install ffmpeg;Windows: winget install --id Gyan.FFmpeg -e)"
      : !footage
        ? `口播视频路径不在 public/ 里:${doc.cam}`
        : !fs.existsSync(footage)
          ? `找不到口播视频文件:${doc.cam}(重新导入一次视频)`
          : null;
  let footageInfo = null;
  if (!why) {
    footageInfo = probeFootage(footage);
    // 没传完的上传(没有 moov 索引)、改了扩展名的非视频文件:读不出视频流,成片注定合不出来
    if (!footageInfo.hasVideo)
      why = `口播视频读不出画面:${doc.cam}(文件可能没传完,或者不是视频)。重新导入一次视频`;
    else if (footageInfo.hdr && !hasZscale())
      why = hdrError(footageInfo.transfer);
  }
  return { why, footageInfo };
}
