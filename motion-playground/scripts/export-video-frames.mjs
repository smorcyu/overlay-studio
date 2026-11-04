/**
 * 卡内视频预抽帧(导出脚本用)。
 * 虚拟时钟下 Chrome 媒体管线完全冻结:<video> 的加载和 seek 永远不完成,
 * 每帧干等超时(导出极慢)且画面为空。先用 ffmpeg 把用到的视频按导出帧率
 * 抽成 JPEG 序列放进 public/_fxframes/,页面在导出模式用 <img> 逐帧换图。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hasBin } from "./compose-final.mjs";
import { resolvePublic } from "./paths.mjs";

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

/** 抽帧缓存目录(public/_fxframes/) */
export function frameCacheDir(root) {
  return path.join(root, "public", "_fxframes");
}

/**
 * { src → 需要抽的秒数 }:口播视频(camSrc / 全局 doc.cam)从时间轴 0 起播,
 * 所以要抽到卡片结束的绝对秒;全局口播抽到整条时长
 */
export function collectVideoUses(doc, duration) {
  const need = new Map();
  const add = (src, sec) => {
    if (typeof src === "string" && VIDEO_RE.test(src))
      need.set(src, Math.max(need.get(src) ?? 0, sec));
  };
  if (doc?.cards) {
    for (const c of doc.cards) add(c.params?.camSrc, c.end ?? duration);
    if (doc?.cam) add(doc.cam, duration);
  }
  return need;
}

/**
 * 按 collectVideoUses 的清单抽帧,返回页面用的清单 { src → { dir, fps, count, dur } }。
 * fps = 导出帧率(job 里传进来的数,缓存键用它);FPS = 精确帧率;FPS_ARG = 传给 ffmpeg 的写法
 */
export function extractVideoFrames(need, { root, fps, FPS, FPS_ARG }) {
  const manifest = {};
  if (!need.size) return manifest;
  // 抽帧要 ffmpeg 和 ffprobe 两个命令,**分别探**。
  // 以前只探 ffmpeg:装法不同的机器(Windows 上分开装、或只装了其中一个)ffprobe 会缺,
  // 于是每张卡都走到下面「读不到时长」那条 continue,导出照跑,成片里视频窗全是空的
  // —— 而且没有任何一句是红色的,用户拿到坏成片多半不会来问,只会觉得这软件不行。
  //
  // 编排里根本没有视频卡时这段不会执行(上面 need.size 为 0 就返回了),
  // 所以纯图文的片子不装 ffmpeg 照样导得出来,这里不会误伤。
  for (const [bin, what] of [["ffmpeg", "抽帧"], ["ffprobe", "读视频时长"]]) {
    if (!hasBin(bin)) {
      console.error(
        `\n【导出失败原因】这条编排里有卡要放视频,需要 ${bin}(用来${what}),但本机没装或不在 PATH 里。\n` +
          `装好之后重新导出即可:\n` +
          `  macOS:   brew install ffmpeg\n` +
          `  Windows: winget install --id Gyan.FFmpeg -e\n` +
          `(ffmpeg 和 ffprobe 通常一起装上;只装了一个的话把另一个补齐。装完要重开终端。)`,
      );
      process.exit(1);
    }
  }
  const cacheRoot = frameCacheDir(root);
  // 清理 7 天前的旧缓存
  if (fs.existsSync(cacheRoot)) {
    for (const d of fs.readdirSync(cacheRoot)) {
      const p = path.join(cacheRoot, d);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5)
        fs.rmSync(p, { recursive: true, force: true });
    }
  }
  for (const [src, needSec] of need) {
    const rel = src.split("?")[0];
    // 编排里的地址只许指向 public/ 里的文件(和成片、波形用同一个守卫)
    const file = resolvePublic(path.join(root, "public"), src);
    if (!file) {
      console.log(`vid-frames: ${rel} 不在 public/ 里,该视频窗将为空`);
      continue;
    }
    if (!fs.existsSync(file)) {
      console.log(`vid-frames: 找不到 ${rel},该视频窗将为空`);
      continue;
    }
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file],
      { encoding: "utf8" },
    );
    const dur = parseFloat(probe.stdout) || 0;
    if (!dur) {
      console.log(`vid-frames: 读不到时长 ${rel},该视频窗将为空`);
      continue;
    }
    const useSec = Math.min(dur, needSec + 0.5);
    const mtime = Math.floor(fs.statSync(file).mtimeMs / 1000);
    const key = `${path.basename(file).replace(/[^\w.-]+/g, "_")}-${fps}fps-${mtime}-${Math.ceil(useSec)}s`;
    const dir = path.join(cacheRoot, key);
    const manifestFile = path.join(dir, "manifest.json");
    let count = 0;
    if (fs.existsSync(manifestFile)) {
      count = JSON.parse(fs.readFileSync(manifestFile, "utf8")).count; // 命中缓存,免重抽
    } else {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`extracting video frames: ${rel} (${useSec.toFixed(1)}s @ ${fps}fps)...`);
      const r = spawnSync(
        "ffmpeg",
        ["-y", "-i", file, "-t", String(useSec), "-vf", `fps=${FPS_ARG}`, "-q:v", "4",
          path.join(dir, "f_%05d.jpg")],
        { stdio: "ignore" },
      );
      count = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length
        : 0;
      if (r.status !== 0 || !count) {
        console.log(`vid-frames: 抽帧失败 ${rel},该视频窗将为空`);
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      fs.writeFileSync(manifestFile, JSON.stringify({ count, fps: FPS, dur }));
    }
    manifest[src] = { dir: `/_fxframes/${key}`, fps: FPS, count, dur };
  }
  return manifest;
}

/**
 * 抽帧缓存只留这次用到的,返回删了几个目录。
 * 缓存键带着视频的 mtime,同一段口播换一版原片就再抽一份,旧的没人清(7 天那条只在
 * 下次导出时才跑)。用户盘满时翻不到这个目录 —— 它在 public/ 下面,名字还带下划线。
 * 换视频重导要多等一次抽帧(几分钟),换来的是磁盘不会悄悄长几个 G;对用户,盘更稀缺。
 */
export function cleanUnusedFrameCaches(root, manifest) {
  const cacheRoot = frameCacheDir(root);
  const used = new Set(Object.values(manifest).map((m) => path.basename(m.dir)));
  let n = 0;
  if (fs.existsSync(cacheRoot))
    for (const d of fs.readdirSync(cacheRoot))
      if (!used.has(d)) {
        fs.rmSync(path.join(cacheRoot, d), { recursive: true, force: true });
        n++;
      }
  return n;
}
