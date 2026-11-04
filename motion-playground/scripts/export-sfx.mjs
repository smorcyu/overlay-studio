/**
 * 音效烤入(导出脚本用):按每张卡的出现时刻把音效混成一条音轨,普通导出时再封进 MOV。
 * 每卡可用参数 sfx 覆盖:留空 = 按类型自动;"none" = 静音;其余 = public/sfx/<名>.mp3
 * public/sfx/ 里没放同名文件时,退回随仓库附带的 CC0 默认音效(public/sfx-default/)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SFX_MAX_SEC } from "./export-plan.mjs";

const KIND_SFX = {
  // 计数/数据 → 数字上升
  "stat-proof": "rise", odometer: "rise", "ring-metric": "rise", "rank-bars": "rise",
  "growth-curve": "rise",
  // 对撞 → 重击
  "versus-card": "impact",
  // 满屏运镜 → 嗖
  "focus-card": "whoosh",
  // 截图标注 → 快门
  "ui-callout": "shutter",
  // 打字/代码
  "terminal-3d": "type", "type-shift": "type",
  // 结构/步骤/清单/名牌
  "chapter-bar": "chime", checklist: "ding", "step-timeline": "click", "entity-chips": "click",
  // 常驻字幕层不配音效
  "caption-track": null,
};
const DEFAULT_SFX = "pop-light";

/** 编排里每张卡的音效点 { t, file, sfx, kind },按时间排好;找不到音效文件的卡跳过 */
export function sfxPointsFor(doc, root) {
  const SFX_DIR = path.join(root, "public", "sfx");
  const SFX_DEFAULT_DIR = path.join(root, "public", "sfx-default");
  return (doc?.cards ?? [])
    .map((c) => {
      const chosen = c.params?.sfx === "none"
        ? null
        : (c.params?.sfx || (c.kind in KIND_SFX ? KIND_SFX[c.kind] : DEFAULT_SFX));
      if (!chosen) return null;
      const own = path.join(SFX_DIR, `${chosen}.mp3`);
      const file = fs.existsSync(own) ? own : path.join(SFX_DEFAULT_DIR, `${chosen}.mp3`);
      if (!fs.existsSync(file)) return null;
      return { t: c.start, file, sfx: chosen, kind: c.kind };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

/**
 * 静音底轨(定全长)+ 每个音效裁到 SFX_MAX_SEC 秒、最后半秒渐出、延迟到卡片出现时刻,混成一条音轨。
 * 成功返回 true;失败时 ffmpeg 可能已经写了半截文件:删掉,别让成片合成(和单独重合)把它当音效轨用
 */
export function mixSfx(points, duration, mixFile) {
  const args = ["-y", "-f", "lavfi", "-t", String(duration), "-i", "anullsrc=r=44100:cl=stereo"];
  for (const p of points) args.push("-i", p.file);
  const ms = (t) => Math.max(0, Math.round(t * 1000));
  const chains = points.map(
    (p, i) =>
      `[${i + 1}]atrim=0:${SFX_MAX_SEC},afade=t=out:st=${(SFX_MAX_SEC - 0.5).toFixed(1)}:d=0.5,volume=0.8,adelay=${ms(p.t)}|${ms(p.t)}[s${i}]`,
  );
  const mixIn = points.map((_, i) => `[s${i}]`).join("");
  args.push(
    "-filter_complex",
    `${chains.join(";")};[0]${mixIn}amix=inputs=${points.length + 1}:duration=first:normalize=0[out]`,
    "-map", "[out]", "-c:a", "aac", "-b:a", "192k", mixFile,
  );
  const r = spawnSync("ffmpeg", args, { stdio: "ignore" });
  const ok = r.status === 0 && fs.existsSync(mixFile);
  if (!ok) fs.rmSync(mixFile, { force: true });
  return ok;
}

/** 音轨封进 MOV(视频流原样拷贝,不重编码)。成功返回 true;失败时不留半截的 -audio.mov */
export function muxSfxIntoMov(mov, mixFile) {
  const tmp = mov.replace(/\.mov$/, "-audio.mov");
  const r = spawnSync(
    "ffmpeg",
    ["-y", "-i", mov, "-i", mixFile,
      // 音轨转 PCM 再封进 MOV。剪映读 .mov 里的 AAC 不稳:有一次导出
      // 音轨齐全(40 个点、max 0dB)但剪映里就是没声音,转成 pcm_s16le 后立刻正常。
      // AAC 也不是每次都出问题,
      // 所以这不是必现问题 —— 但 PCM 是 MOV 的通用选择,只多约 30MB,直接默认给它。
      "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", tmp],
    { stdio: "ignore" },
  );
  if (r.status === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, mov);
    return true;
  }
  fs.rmSync(tmp, { force: true }); // 半截的 -audio.mov 没有索引,别留在成品目录里
  return false;
}
