#!/usr/bin/env node
/**
 * 导出:透明动效层(PNG 序列 → ProRes MOV + VP9 WebM)+ 有口播视频时的成片 MP4
 * 原理:无头 Chrome + CDP 虚拟时间(Emulation.setVirtualTimePolicy),
 * 时钟完全由脚本控制,每帧精确推进 1000/fps 毫秒再截图(omitBackground → 透明)。
 * 「只导成片」(finalOnly):不做 MOV/WebM,剪切段里的帧只推时钟不截图,口播视频结束之后的帧不渲染,
 * 成片按「先剪原片再叠」合成。
 * 用法: node scripts/export-frames.mjs <job.json>
 * job: { doc, fps, duration, base, scale, speed, keepFrames, finalMp4, finalOnly }(各项含义见下面的默认值)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import {
  captureEndFor, composeFinal, cutFrameRanges, hasBin, hasZscale, hdrError, probeFootage, stopComposing,
} from "./compose-final.mjs";
import { captureSchedule, estimateEta, SFX_MAX_SEC, sfxSheetLines } from "./export-plan.mjs";
import { fmtTime } from "./fmt-time.mjs";
import { resolvePublic } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const jobFile = process.argv[2];
if (!jobFile) {
  console.error("usage: node export-frames.mjs <job.json>");
  process.exit(1);
}
const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
const {
  doc = null, // 整份 overlay JSON
  scale = 1,
  speed = 1, // 动画速度倍率(与 Studio「动画速度」滑杆一致)
  fps = 30,
  duration = 6,
  base = "http://localhost:5177",
  keepFrames = false, // true = 保留 PNG 中间目录
  finalMp4 = true, // 有全局口播视频(doc.cam)时,顺手合一条带原片的成片 MP4
  // 只导成片 MP4:不做透明 MOV/WebM,剪切段里和口播视频结束之后的帧也不截图 —— 要直接发片、不进剪映时用,快很多
  finalOnly = false,
} = job;

const STAGE = { w: 1920, h: 1080 };

// NTSC 29.97 的真身是 30000/1001(=29.970029970…),写成小数会有微小误差:
// 帧号/时钟用精确值算,传给 ffmpeg 的帧率用分数字符串,避免它按 2997/100 编码
const isNTSC = Math.abs(fps - 29.97) < 0.01;
const FPS = isNTSC ? 30000 / 1001 : fps;
const FPS_ARG = isNTSC ? "30000/1001" : String(fps);

const totalFrames = Math.max(1, Math.round(duration * FPS));
const intervalMs = 1000 / FPS;

// fs.statfsSync 三平台通用(旧实现用 df,Windows 上没这命令,静默返回 Infinity
// 等于保护失效)。查不到就放行,不为了一个预检卡住导出。
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}
const gb = (n) => (n / 1024 ** 3).toFixed(1);

// ---- 只导成片:开工前就确认合得出来 ----
// 这个模式只交付成片 MP4,合不出来就什么都没有:成片合成会失败的情况(缺口播视频、文件不在了、
// 缺 ffmpeg、HDR 原片但 ffmpeg 不带 zscale)都要在渲染前说,别白渲染几分钟。
// 跳过哪几帧和成片合成剪掉哪几帧走同一个 cutFrameRanges(同一个原片时长):一一对上
let skipRanges = [];
let footageInfo = null;
if (finalOnly) {
  const footage = doc?.cam ? resolvePublic(path.join(ROOT, "public"), doc.cam) : null;
  let why = !doc?.cam
    ? "「只导成片 MP4」要先导入口播视频(成片 = 口播原片 + 动效层)"
    : !hasBin("ffmpeg") || !hasBin("ffprobe")
      ? "「只导成片 MP4」要用 ffmpeg 和 ffprobe 合成成片,本机没装或不在 PATH 里(macOS: brew install ffmpeg;Windows: winget install --id Gyan.FFmpeg -e)"
      : !footage
        ? `口播视频路径不在 public/ 里:${doc.cam}`
        : !fs.existsSync(footage)
          ? `找不到口播视频文件:${doc.cam}(重新导入一次视频)`
          : null;
  if (!why) {
    footageInfo = probeFootage(footage);
    // 没传完的上传(没有 moov 索引)、改了扩展名的非视频文件:读不出视频流,成片注定合不出来
    if (!footageInfo.hasVideo)
      why = `口播视频读不出画面:${doc.cam}(文件可能没传完,或者不是视频)。重新导入一次视频`;
    else if (footageInfo.hdr && !hasZscale())
      why = hdrError(footageInfo.transfer);
  }
  if (why) {
    console.error(`\n【导出失败原因】${why}`);
    process.exit(1);
  }
  skipRanges = cutFrameRanges(doc.cuts ?? [], FPS_ARG, footageInfo.duration ?? Infinity);
}
// 只导成片时原片结束之后的帧也不截(成片跟着原片结束,截了也用不上)
const captureEnd = finalOnly ? captureEndFor(footageInfo.duration ?? NaN, FPS_ARG, totalFrames) : totalFrames;
/**
 * 第 k 帧(从 0 数,t = k/FPS)写成第几张 PNG;0 = 不截:剪切段里的只推时钟,原片结束之后的连渲染都不做
 * (普通导出全都截)
 */
const schedule = captureSchedule(totalFrames, skipRanges, captureEnd);
const capturedFrames = schedule.filter(Boolean).length;
const uncapturedFrames = totalFrames - capturedFrames; // 不截的帧:剪切段里的 + 原片结束之后的
const tailFrames = totalFrames - captureEnd; // 原片结束之后的(连渲染都不做)
const cutFrames = uncapturedFrames - tailFrames; // 剪切段里的(只推时钟)

// 开工前先看磁盘够不够,按成品体积估,再留 2GB 余量。
// 中途写满会得到一个"没有 moov 索引"的半截 MOV —— 剪映只会说"文件损坏",查不出原因。
// 普通导出:PNG 序列(约 14MB/s)+ ProRes(约 29MB/s)。只导成片:PNG 只截剪剩下的帧,
// 成片 MP4 按 3MB/s、以「原片长度 - 剪掉的」算(原片常比最后一张卡长得多)
const removedSec = skipRanges.reduce((n, [s, e]) => n + (e - s), 0) / FPS;
const finalSec = footageInfo?.duration ? Math.max(0, footageInfo.duration - removedSec) : duration;
const needBytes = finalOnly
  ? (capturedFrames / FPS) * 14 * 1024 * 1024 + finalSec * 3 * 1024 * 1024 + 2 * 1024 ** 3
  : duration * (14 + 29) * 1024 * 1024 + 2 * 1024 ** 3;

// 工作目录 exports/<名称>-<时间戳>/(PNG 序列等中间产物)
// 成品目录 exports/output/(给剪映用的 MOV/WebM 全部只放这里)
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const name = "timeline";
const outDir = path.join(ROOT, "exports", `${name}-${stamp}`);
const finalDir = path.join(ROOT, "exports", "output");


// ---- 卡内视频预抽帧 ----
// 虚拟时钟下 Chrome 媒体管线完全冻结:<video> 的加载和 seek 永远不完成,
// 每帧干等超时(导出极慢)且画面为空。先用 ffmpeg 把用到的视频按导出帧率
// 抽成 JPEG 序列放进 public/_fxframes/,页面在导出模式用 <img> 逐帧换图。
const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

function collectVideoUses() {
  // { src → 需要抽的秒数 }:口播视频(camSrc / 全局 doc.cam)从时间轴 0 起播,
  // 所以要抽到卡片结束的绝对秒;全局口播抽到整条时长
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

const cacheRoot = path.join(ROOT, "public", "_fxframes");

function extractVideoFrames(need = collectVideoUses()) {
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
    const file = resolvePublic(path.join(ROOT, "public"), src);
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

// ---- 磁盘预检:放在抽帧清单算出来之后 ----
// 以前只算 PNG 序列 + ProRes 成片,**卡内视频抽的 JPEG 不在账里** —— 全局口播是按整条时长抽的,
// 20 分钟的口播在 30fps 下就是三万多张 JPEG(几个 GB),预检说「够」,抽到一半盘满了。
// 按每帧 200KB 估(1080p、-q:v 4 的典型量级),宁可高估。
const videoUses = collectVideoUses();
const frameBytes = [...videoUses.values()].reduce((a, sec) => a + sec * FPS * 200 * 1024, 0);
const needTotal = needBytes + frameBytes;
const freeNow = freeBytes(ROOT);
if (freeNow < needTotal) {
  console.error(
    `\n【导出失败原因】磁盘空间不够:还剩 ${gb(freeNow)}GB,这条 ${Math.round(duration)}s 的片子` +
      `大约需要 ${gb(needTotal)}GB(PNG 序列 + ${finalOnly ? "成片 MP4" : "ProRes 成片"}` +
      (frameBytes ? ` + 卡内视频抽帧 ${gb(frameBytes)}GB` : "") +
      ` + 余量)。\n` +
      `先腾地方再导 —— exports/ 里除 output 外的目录都是 PNG 中间产物,成片出来后可以整个删;` +
      `public/_fxframes/ 是视频抽帧缓存,也可以整个删。`,
  );
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(finalDir, { recursive: true });

const vidFrames = extractVideoFrames(videoUses);

// 整份编排不放 URL:中文转码后网址会超过服务器 16KB 上限(HTTP 431),
// 改在 page.goto 前用 evaluateOnNewDocument 注入 window.__EXPORT_DOC
const url = `${base}/?export=1&fx=${scale}&spd=${speed}`;

// 等「虚拟时钟推进完毕」这个事件,**带超时**。以前是裸等:渲染器假死(没崩、只是不再响应)
// 事件永远不来,这个进程就永远挂着 —— 服务端的导出锁也就永远解不开,用户之后每次点导出
// 都是「已有导出任务在进行中」,只能重启 npm run dev。一帧的虚拟时间几十毫秒就该推完,
// 30 秒没动静一定是出事了,与其干等不如报错退出,让人重来。
function waitBudgetExpired(client, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `渲染器 ${ms / 1000} 秒没有推进(多半是假死了)。重新导出一次;还不行就重启 npm run dev`,
          ),
        ),
      ms,
    );
    client.once("Emulation.virtualTimeBudgetExpired", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const LAUNCH_OPTS = {
  // 用 chrome-headless-shell(纯无头内核),不用完整 Chrome 的 "new" 无头模式。
  // "new" 模式在没有显示器/GPU 的机器上(云主机、Linux 服务器)会随机卡死在截图上:
  // 第一张 captureScreenshot 永远不回 —— 与虚拟时钟无关,时钟正常走时的预热截图也一样卡,
  // 实测 4 次里只成 1 次;一旦第一张出来,后面每张稳定 ~80ms。
  // headless-shell 同一台机器 6/6 全过,逐帧像素对比与 "new" 一致(平均差 <0.25/255)。
  // npm install 时 puppeteer 默认两个内核都会下载,不需要额外装。
  headless: "shell",
  // 每一次 DevTools 协议调用(截图、页面求值、推虚拟时钟……)的超时。默认 180s:
  // 真卡死时用户要干等 3 分钟才看到报错。正常一次调用 <1s,60s 没回一定是卡死了。
  protocolTimeout: 60_000,
  args: [
    "--force-color-profile=srgb",
    "--disable-background-timer-throttling",
    "--run-all-compositor-stages-before-draw",
    "--disable-lcd-text",
  ],
};

// puppeteer 捆绑的 Chromium 没下载时(~/.cache/puppeteer 为空,npm 安装时跳过了
// 下载步骤),launch 会报「must specify executablePath」。
//
// 以前这里退回本机 Google Chrome 继续跑。**改成直接停下**,因为那条退路
// 产出的是坏成片:Chrome 151 在无头+虚拟时间下不推进 CSS 动画时间线,靠
// transition/animation 淡入的卡会整张停在 opacity:0(踩过,字幕和大半动效
// 全不见)。原来只 console.warn 一句 —— 它混在几百行导出日志里,界面上是绿色的
// 「导出完成」,用户拿到一条缺了一半动效的片子,还以为是自己编排没做好。
//
// 一条命令就能装好,报错停下比默默交坏片强得多。
let browser;

/**
 * 音效清单(和成品放在一起)。ranges 为 null:时间按完整时间轴(MOV 是完整时长);
 * 给了剪切帧段:时间换成剪切后的成片时间,起点落在剪切段里的标出来
 */
function writeSfxSheet(result, points, ranges) {
  // 原片比时间轴短时,原片结束之后的卡在成片里没有(音效随音轨一起截掉了):读得到原片时长才标
  const lines = sfxSheetLines(points, ranges, FPS, footageInfo?.duration ? finalSec : null);
  const sheet = [
    `音效清单 · ${name}-${stamp}(已直接混入${ranges ? "成片 MP4" : " MOV"},无需手动加)`,
    "想调整:回 Studio 选中卡片 → 节奏组「音效」下拉换一个(选中即试听)或选「无音效」,重新导出。",
    ranges
      ? `${ranges.length ? "时间是剪切后的成片时间。" : ""}音效按固定音量混入(约 -16dB);「人声响度统一」只调人声,不调音效。`
      : "整条音效轨的音量在剪映里对 MOV 轨道统一调(建议比人声低,约 -12~-18dB)。",
    "",
    ...lines,
  ].join("\n");
  const sheetPath = path.join(finalDir, `${name}-${stamp}-音效清单.txt`);
  fs.writeFileSync(sheetPath, sheet, "utf8");
  result.sfxSheet = sheetPath;
}

// 被叫停(开发服务器的看门狗先发 SIGTERM):把自己起的 ffmpeg 和渲染器一起带走再退出,
// 不留孤儿进程接着写半截文件
// 渲染循环跑完才置 true:catch 里靠它区分「渲染到一半崩了」(PNG 是半成品,删)
// 和「渲染完了、合成失败」(PNG 是几分钟的成果,留着可手动重合成)。
let framesDone = false;
process.on("SIGTERM", () => {
  stopComposing();
  try { browser?.process()?.kill("SIGKILL"); } catch { /* 已经退出了 */ }
  // 看门狗多半是因为渲染器假死才叫停的:渲染没做完的 PNG 是半成品,和崩溃时一样清掉
  if (!framesDone && !keepFrames) fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
});
try {
  browser = await puppeteer.launch(LAUNCH_OPTS);
} catch (err) {
  if (!/executablePath|Could not find/i.test(String(err?.message))) throw err;
  console.error(
    "\n【导出失败原因】渲染器(Chromium)没装好,导不了。\n" +
      "在项目文件夹里运行这一条,然后重新导出:\n" +
      "  npx puppeteer browsers install chrome-headless-shell\n" +
      "(以前这里会退回用你电脑上的 Chrome 硬跑,但那样导出的片子会缺掉大半动效,\n" +
      " 所以现在宁可停下来告诉你,也不给你一条坏片。)",
  );
  process.exit(1);
}

try {
  const page = await browser.newPage();

  // ⚠️ 钉死 CSS 动画钟校正系数(勿删)。
  // ExportView 会在开跑瞬间量一个 __fxClockRate,再每帧把所有动画的 playbackRate
  // 乘上它。这个值在不同运行里会落在 1~5.5 之间;一旦落到 5 附近,
  // 进场过渡就整个卡死在第一帧 —— 卡片挂上了、is-in 也加了,但内层 opacity 恒为 0,
  // 短卡(<2s)从头到尾看不见,长卡晚好几秒才出现。
  // 这就是"同一份编排、同一份代码,有的导出好有的丢卡"的真正原因。
  // 钉死为 1 之后,进场恢复正常。
  await page.evaluateOnNewDocument(() => {
    let _r = 1;
    Object.defineProperty(window, "__fxClockRate", {
      get: () => _r,
      set: () => {},           // 屏蔽页面量到的值写入
      configurable: true,
    });
    void _r;
  });
  await page.setViewport({ width: STAGE.w, height: STAGE.h, deviceScaleFactor: 1 });
  const client = await page.createCDPSession();

  // 记录页面里的 JS 报错,失败时给出人话原因
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).split("\n")[0]));

  // 页面底色透明(截图 omitBackground 的前提)
  await client.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  // 整份编排在页面脚本运行前注入(见上面 url 处注释)
  await page.evaluateOnNewDocument((s) => {
    window.__EXPORT_DOC = s;
  }, JSON.stringify(doc));
  // 视频帧序列清单:页面 __seekVideos 按它逐帧换 img.src
  await page.evaluateOnNewDocument((m) => {
    window.__VID_FRAMES = m;
  }, vidFrames);

  // 正常时间加载页面(动效被 __startExport 闸住,不会提前播)
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 }).catch((e) => {
    throw new Error(
      `导出页面加载超时(30s)。常见原因:某张卡引用的录屏/图片文件已被删除,或素材过大。原始错误:${String(e).split("\n")[0]}`,
    );
  });

  // 就绪检测:TimelineExport 挂载后才有 __startExport;
  // 没有 = 编排解析失败(页面上会显示红字原因)或页面 JS 崩溃
  await page
    .waitForFunction("typeof window.__startExport === 'function'", { timeout: 15000 })
    .catch(async () => {
      const hint = await page
        .evaluate(() => (document.body.innerText || "").trim().slice(0, 200))
        .catch(() => "");
      throw new Error(
        `导出页面未就绪:${hint || pageErrors[0] || "页面白屏(JS 报错)"}`,
      );
    });

  // 自定义字体加载完再开闸,避免前几帧渲染成回退字体
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  // 冻结时钟 → 开闸 → 从 t=0 逐帧推进
  await client.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
  await page.evaluate(() => window.__startExport());

  // 逐帧渲染从这里开跑。「预计还需」只量下面这个循环里每帧的耗时(见 estimateEta):
  // 把前面抽帧/启浏览器那几分钟摊进「每帧耗时」的话,开头能报出好几十分钟然后一路往下掉。
  // 只导成片时原片结束之后的帧连时钟都不用推:成片用不上它们,烤入人物的时段(__CAM_SEGMENTS)
  // 是页面按编排算好的、不靠逐帧渲染。渲染到 captureEnd 为止
  const renderFrames = finalOnly ? captureEnd : totalFrames;
  console.log(`rendering frames: ${renderFrames}`);
  // 只报不为 0 的(没剪切时不说「0 frames inside cuts」)
  const skipNotes = [
    cutFrames ? `${cutFrames} frames inside cuts are stepped through but not captured` : "",
    tailFrames ? `${tailFrames} frames after the footage ends are not rendered` : "",
  ].filter(Boolean);
  if (skipNotes.length) console.log(`final-only: ${skipNotes.join("; ")}`);
  let slowFrames = 0; // 视频帧图等满 2 秒还没加载完的帧数
  let written = 0; // 实际截下的帧数(只导成片时剪切段里的不截)
  // 「预计还需」由这里算好报给界面:截图的帧和只推时钟的帧耗时差好几倍,
  // 按「平均每帧」算的话剪切段多的地方会忽快忽慢。两种帧分别量平均耗时,乘各自还剩的张数
  const cost = { shot: { ms: 0, n: 0 }, step: { ms: 0, n: 0 } };

  for (let i = 1; i <= renderFrames; i++) {
    const frameT0 = Date.now();
    // 只导成片、这一帧在剪切段里:时钟和动画照常推一帧(否则剪切段之后的动画进度会错),
    // 但不换视频帧图、不截图 —— 截图和写 PNG 是每帧最贵的部分
    const skip = schedule[i - 1] === 0;
    // 先下发本帧精确时间(卡片挂载/节拍全跟它走)+ 换视频帧图,再推时钟:
    // 推进期间页面完成渲染与绘制,截图即为 t=(i-1)/fps 的画面。
    // 帧覆盖的是 [0, duration) 而不是 (0, duration]:以前从 1/fps 起步,开头丢了
    // t=0 那一帧、结尾多出 t=duration 那一帧 —— 而卡片可见区间是左闭右开
    // (t < end),末帧正好踩在 end 上,于是成片最后一帧是全空的。
    await page
      .evaluate((t, seek) => {
        if (window.__setExportT) window.__setExportT(t);
        if (seek && window.__seekVideos) window.__seekVideos(t);
      // 用精确帧率 FPS(29.97 → 30000/1001),和下面推时钟的 intervalMs 同一个值,长片不漂
      }, (i - 1) / FPS, !skip)
      .catch(() => {});
    // 换 src 后帧图在真实时间里加载(本地静态文件,通常几毫秒):就绪再推帧。
    // 最多等 2s(以前只等 200 毫秒:机器一忙 1080p 帧图就落不了地,视频窗静默截成空的/慢一帧)
    let pending = 0;
    for (let k = 0; k < (skip ? 0 : 200); k++) {
      pending = await page
        .evaluate(() => (window.__pendingVidFrames ? window.__pendingVidFrames() : 0))
        .catch(() => 0);
      if (!pending) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // 只报前几次,后面汇总:几万帧每帧一行会把日志淹掉
    if (pending && ++slowFrames <= 3)
      console.log(`vid-frames: 第 ${i} 帧还有 ${pending} 张视频帧图 2 秒没加载完,照常截图`);
    const p = waitBudgetExpired(client);
    await client.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget: intervalMs,
    });
    await p;
    // ⚠️ 确定性动画步进(勿删)。CSS 过渡/动画的钟在无头虚拟时间下
    // 快慢不定(同一台机器不同一次运行,偏差 1x~5.4x;偏差大时进场过渡
    // 整个卡死在第一帧,短卡全程隐形 —— 就是"同一编排有的导出好有的丢卡"的根源)。
    // 从本版起不再信任任何钟:每推进一帧虚拟时间,就把页面里所有动画显式
    // 暂停并手动 +intervalMs。动画进度与时间轴逐帧锁死,与机器负载无关。
    await page.evaluate((ms) => {
      for (const a of document.getAnimations()) {
        try {
          if (a.playState !== "paused") a.pause();
          a.currentTime = Number(a.currentTime ?? 0) + ms;
        } catch { /* 已结束/已移除的动画,跳过 */ }
      }
    }, intervalMs);
    // 序号按 schedule 连续编(跳过的帧不留空号):ffmpeg 读 frame_%06d.png 遇到断号就停
    if (!skip) {
      await page.screenshot({
        path: path.join(outDir, `frame_${String(schedule[i - 1]).padStart(6, "0")}.png`),
        omitBackground: true,
      });
      written++;
    }
    const c = skip ? cost.step : cost.shot;
    c.ms += Date.now() - frameT0;
    c.n++;
    if (i % 30 === 0 || i === renderFrames) {
      // 进度条按推过的帧数走(剪切段里也照样往前走,不会停住);「预计还需」按两种帧各自的耗时算
      const leftShot = capturedFrames - written;
      // 和帧数打在同一行:分两行的话,界面轮询可能刚好读到只有帧数、没有「预计还需」的那一刻
      const eta = estimateEta({ leftShot, leftStep: renderFrames - i - leftShot, shot: cost.shot, step: cost.step });
      console.log(`progress ${i}/${renderFrames} eta ${eta}`);
    }
  }

  // 整条时间轴都在剪切段里时一张都没截:补一张全透明的,成片合成要有动效层输入
  // (普通导出这种编排照样合得出来,只导成片也不该失败)。frames 报的是真正截了的张数,不算这张
  const shotFrames = written;
  if (!written) {
    const r = spawnSync(
      "ffmpeg",
      ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black@0:s=${STAGE.w}x${STAGE.h},format=rgba`,
        "-frames:v", "1", path.join(outDir, "frame_000001.png")],
      { stdio: "ignore" },
    );
    if (r.status === 0) written = 1;
  }

  framesDone = true;
  if (slowFrames > 3) console.log(`vid-frames: 一共 ${slowFrames} 帧的视频帧图没等到加载完(只列了前 3 帧)`);

  // 烤入人物的时间段(导出页按「卡有没有 camSrc 控件」算好挂在 window 上)。
  // 趁浏览器还开着取出来,后面写进「合成说明」。
  const camSegs = await page.evaluate(() => window.__CAM_SEGMENTS ?? []).catch(() => []);

  // ---- PNG 序列 → 自动合成透明视频(需要本机 ffmpeg;没有则跳过,只留 PNG) ----
  // outputDir 是成品目录;dir 是 PNG 中间目录,成片到手后会被清理成 null
  const result = {
    ok: true, dir: outDir, outputDir: finalDir, frames: shotFrames, fps, mov: null, webm: null, finalOnly,
    ...(finalOnly ? { cutFrames, tailFrames } : {}),
  };
  const hasFfmpeg = hasBin("ffmpeg");
  let sfxPoints = []; // 混进音轨的音效点(写清单用)
  let sfxMixOk = false;
  if (finalOnly) {
    console.log("final-only: skip MOV/WebM");
  } else if (hasFfmpeg) {
    const seq = path.join(outDir, "frame_%06d.png");
    // 1) 剪映友好:ProRes 4444 透明 MOV(编码快,文件较大)→ 成品放 exports/output/
    console.log("composing MOV (ProRes 4444 alpha)...");
    const mov = path.join(finalDir, `${name}-${stamp}.mov`);
    const r1 = spawnSync(
      "ffmpeg",
      ["-y", "-framerate", FPS_ARG, "-i", seq,
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
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", mov],
      { stdio: "ignore" },
    );
    if (r1.status === 0 && fs.existsSync(mov)) {
      result.mov = mov;
    } else {
      // 失败多半是写到一半磁盘满了:半截 MOV 没有 moov 索引,留着只会被误当成成片
      fs.rmSync(mov, { force: true });
      result.ok = false;
      result.error = `MOV 合成失败(磁盘还剩 ${gb(freeBytes(ROOT))}GB),半截文件已删除`;
      console.error(`\n【导出失败原因】${result.error}`);
    }
    // 2) 小体积:VP9 透明 WebM(编码稍慢;剪映不认 WebM 透明,给网页/达芬奇用)
    console.log("composing WebM (VP9 alpha)...");
    const webm = path.join(finalDir, `${name}-${stamp}.webm`);
    const r2 = spawnSync(
      "ffmpeg",
      ["-y", "-framerate", FPS_ARG, "-i", seq,
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "32",
        "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0", webm],
      { stdio: "ignore" },
    );
    if (r2.status === 0 && fs.existsSync(webm)) result.webm = webm;
    else fs.rmSync(webm, { force: true });
  } else {
    console.log("ffmpeg not found — skip video composing, PNG sequence only");
  }

  // ---- 音效烤入:按每张卡的出现时刻把音效混成音轨,直接封进 MOV ----
  // 每卡可用参数 sfx 覆盖:留空 = 按类型自动;"none" = 静音;其余 = public/sfx/<名>.mp3
  // public/sfx/ 里没放同名文件时,退回随仓库附带的 CC0 默认音效(public/sfx-default/)
  // 只导成片时没有 MOV,音效混音照做:成片合成要用它
  if (doc?.cards?.length && (result.mov || finalOnly) && hasFfmpeg) {
    const SFX_DIR = path.join(ROOT, "public", "sfx");
    const SFX_DEFAULT_DIR = path.join(ROOT, "public", "sfx-default");
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
    const points = doc.cards
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
    if (points.length) {
      console.log(`baking ${points.length} sfx into ${result.mov ? "MOV" : "the final MP4 mix"}...`);
      // 1) 静音底轨(定全长)+ 每个音效裁 3.2s 渐出、延迟到卡片出现时刻,混成一条音轨
      const mixFile = path.join(outDir, "sfx-mix.m4a");
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
      const rMix = spawnSync("ffmpeg", args, { stdio: "ignore" });
      // 2) 音轨封进 MOV(视频流原样拷贝,不重编码)
      if (rMix.status === 0 && fs.existsSync(mixFile) && result.mov) {
        const tmp = result.mov.replace(/\.mov$/, "-audio.mov");
        const rMux = spawnSync(
          "ffmpeg",
          ["-y", "-i", result.mov, "-i", mixFile,
            // 音轨转 PCM 再封进 MOV。剪映读 .mov 里的 AAC 不稳:有一次导出
            // 音轨齐全(40 个点、max 0dB)但剪映里就是没声音,转成 pcm_s16le 后立刻正常。
            // AAC 也不是每次都出问题,
            // 所以这不是必现问题 —— 但 PCM 是 MOV 的通用选择,只多约 30MB,直接默认给它。
            "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", tmp],
          { stdio: "ignore" },
        );
        if (rMux.status === 0 && fs.existsSync(tmp)) {
          fs.renameSync(tmp, result.mov);
          result.sfxBaked = points.length;
          console.log(`sfx baked: ${points.length} points`);
        }
      }
      // 3) 清单:记录烤了什么(想换音效:选中卡片 → 「音效」下拉 → 重导)。
      // 普通导出现在就写(MOV 已经到手);只导成片要等成片合出来、而且音效确实混进去了才写,
      // 时间也换成剪切后的成片时间 —— 那是用户手上唯一的那条片子
      sfxPoints = points;
      sfxMixOk = rMix.status === 0 && fs.existsSync(mixFile);
      if (result.sfxBaked) writeSfxSheet(result, points, null); // 真的封进 MOV 了才写「已混入」
    }
  }

  // ---- 合成说明:只在真的烤了人物时才生成 ----
  // 这几段的透明层里已经有一份人物画面,剪映里必须把原始口播轨盖住,
  // 否则会看到两层人。说明放在成品旁边,而不是 README —— 用户打开
  // exports/output/ 拿 MOV 的那一刻,正好是他要去剪映的前一秒。
  if (camSegs.length && result.mov) {
    const note = [
      `合成说明 · ${name}-${stamp}`,
      "",
      "这条动效层里有 " + camSegs.length + " 段把口播人物烤了进去(运镜/取景类卡片)。",
      "剪映里这几段要把【原始口播轨盖住】,否则会看到两层人:",
      "",
      ...camSegs.map((s) => `  ${fmtTime(s.start)} — ${fmtTime(s.end)}   ${s.kind}`),
      "",
      "做法:把 MOV 放在最上层轨道,上面这几个时间段把下面的原始口播轨切开、静音或删除画面",
      "(声音要留)。其余时间段照常,MOV 盖在原片上即可。",
    ].join("\n");
    const notePath = path.join(finalDir, `${name}-${stamp}-合成说明.txt`);
    fs.writeFileSync(notePath, note, "utf8");
    result.camNote = notePath;
  }

  // ---- 成片 MP4:口播原片 + 动效层 + 音效,一条直接能发 ----
  // 只在编排里有全局口播视频(doc.cam)时做。必须在清理 PNG 之前:合成用的是 PNG 序列。
  // 普通导出时失败只记原因不算导出失败 —— 透明 MOV 已经到手,用户照样能去剪映里叠;
  // 只导成片时成片是唯一的成品,失败就是导出失败(见下面)。
  if ((finalMp4 || finalOnly) && doc?.cam && (result.mov || finalOnly) && hasFfmpeg) {
    const footage = resolvePublic(path.join(ROOT, "public"), doc.cam);
    if (!footage) {
      result.finalError = `口播视频路径不在 public/ 里:${doc.cam}`;
    } else {
      // 合成参数写进 PNG 目录:成片合失败时 PNG 会留下,
      // 单独跑 compose-final.mjs 读它就能原样重合,不用重新渲染
      // 成片音频:响度统一(默认开)+ 可选背景音乐。音乐地址和口播视频一样只认 public/ 里的文件
      const a = doc.audio ?? {};
      const bgm = a.bgm ? resolvePublic(path.join(ROOT, "public"), a.bgm) : null;
      if (a.bgm && !bgm) result.audioNote = `背景音乐路径不在 public/ 里,没用上:${a.bgm}`;
      const audio = { normalize: a.normalize !== false, bgm, bgmVolume: a.bgmVolume, duck: a.duck !== false };
      // overlayPreCut:只导成片时 PNG 已经跳过了剪切段里的帧,合成时只剪原片(重合时也要照这个来)
      // skipFrames / timelineFrames / frames:单独重合时核对(换的原片让剪切帧变了、PNG 不全,叠出来会错位)
      const compose = {
        fpsArg: FPS_ARG, stage: STAGE, camSegs, cuts: doc.cuts ?? [], audio, overlayPreCut: finalOnly,
        ...(finalOnly ? { skipFrames: skipRanges, timelineFrames: totalFrames, captureEnd, frames: written } : {}),
      };
      fs.writeFileSync(path.join(outDir, "compose.json"), JSON.stringify(compose));
      if (audio.normalize) console.log("measuring loudness...");
      console.log("composing final MP4 (footage + overlay)...");
      const r = await composeFinal({
        ...compose,
        footage,
        seq: path.join(outDir, "frame_%06d.png"),
        sfxMix: path.join(outDir, "sfx-mix.m4a"),
        out: path.join(finalDir, `${name}-${stamp}-final.mp4`),
        workDir: outDir, // 滤镜图临时文件(刀数多时才有)放 PNG 目录,不放成品目录
        // 每涨 1% 打一行:看门狗(15 分钟没输出就杀)靠它知道还活着,界面也能显示进度。
        // 读不到原片时长时 pct 为 null:只打心跳,界面显示「合成中」不显示百分比
        onProgress: (pct) => console.log(`final-progress ${pct === null ? "?" : pct}/100`),
      });
      if (r.ok) {
        result.final = r.out;
        result.finalAudio = r.audio;
        if (finalOnly && sfxMixOk && sfxPoints.length) writeSfxSheet(result, sfxPoints, skipRanges);
        if (r.audio?.bgmMissing) result.audioNote = `背景音乐文件找不到,没用上:${a.bgm}`;
      } else result.finalError = r.error;
    }
    // 只导成片时下面会报一条完整的失败原因,这里不重复(服务端只留 stderr 的最后 800 字)
    if (result.finalError && !finalOnly) console.error(`成片没合成:${result.finalError}`);
  } else if (finalMp4 && doc?.cuts?.length && result.mov && !doc?.cam) {
    // 剪切只作用在成片 MP4 上,没有成片就等于没剪 —— 说出来,别让人以为剪过了。
    // (没装 ffmpeg 时连 MOV 都没有,界面另有一条「先装 ffmpeg」的提示,这里不用管)
    result.finalSkipped = "编排里有剪切段,但没有设全局口播视频,所以没生成成片 MP4(透明 MOV 是完整时长,没有剪)";
  }
  // 只导成片时成片就是唯一的成品:没合出来就是导出失败(PNG 留着,修好后可以直接重合)
  if (finalOnly && !result.final) {
    result.ok = false;
    // 原因放最前、截短,路径用相对 motion-playground 的:服务端只留 stderr 最后 800 字,
    // 界面从最后一个【导出失败原因】起显示,整条要放得下
    const why = String(result.finalError ?? "成片 MP4 没合成");
    const rel = (p) => path.relative(ROOT, p);
    result.error =
      `【导出失败原因】${why.length > 300 ? `${why.slice(0, 300)}…` : why}\n` +
      `PNG 序列${skipRanges.length ? "(已跳过剪切段)" : ""}留着,修好后不用重新渲染,在 motion-playground 目录里用同一条口播原片重合:\n` +
      `node scripts/compose-final.mjs "${rel(resolvePublic(path.join(ROOT, "public"), doc.cam))}" "${rel(outDir)}" exports/output/输出.mp4`;
    // 退出码也要是失败:/api/export-status 按它报成败
    console.error(`\n${result.error}`);
    process.exitCode = 1;
  }

  // ---- 清理 PNG 中间目录:成片(MOV 或只导成片时的 MP4)到手后这几 GB 就没用了,默认删除 ----
  // 合成失败、成片 MP4 没合成、或没装 ffmpeg 时保留:PNG 是几分钟渲染的成果,
  // 留着可以单独跑 compose-final.mjs 重合成片,不用重新渲染。
  if ((result.mov || result.final) && !keepFrames && !result.finalError) {
    fs.rmSync(outDir, { recursive: true, force: true });
    result.dir = null;
    console.log("cleaned PNG frames dir");
  }

  // ---- 抽帧缓存:只留这次用到的 ----
  // 缓存键带着视频的 mtime,同一段口播换一版原片就再抽一份,旧的没人清(7 天那条只在
  // 下次导出时才跑)。用户盘满时翻不到这个目录 —— 它在 public/ 下面,名字还带下划线。
  // 换视频重导要多等一次抽帧(几分钟),换来的是磁盘不会悄悄长几个 G;对用户,盘更稀缺。
  {
    const used = new Set(Object.values(vidFrames).map((m) => path.basename(m.dir)));
    let n = 0;
    if (fs.existsSync(cacheRoot))
      for (const d of fs.readdirSync(cacheRoot))
        if (!used.has(d)) {
          fs.rmSync(path.join(cacheRoot, d), { recursive: true, force: true });
          n++;
        }
    if (n) console.log(`cleaned ${n} unused video-frame cache dir(s)`);
  }

  console.log(JSON.stringify(result));
} catch (e) {
  // 渲染到一半崩了:半成品 PNG 没用,别留几个 G 在 exports/ 里(界面上只会说「导出失败」,
  // 用户不知道还有这么一堆)。渲染完了才崩(合成阶段)的 PNG 是完整的,照旧保留。
  if (!framesDone && !keepFrames && fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
    console.error("渲染没做完,已清掉半成品 PNG 目录");
  }
  // 人话原因放在 stderr 结尾(接口取尾部展示给用户)
  console.error(String(e?.stack ?? e));
  console.error(`\n【导出失败原因】${String(e?.message ?? e).split("\n")[0]}`);
  process.exitCode = 1;
} finally {
  // 假死的渲染器连 close 都可能不回:给 10 秒,不回就直接杀进程,别让「收尾」再挂一次。
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 10_000)),
  ]);
  try { browser.process()?.kill("SIGKILL"); } catch { /* 已经退出了 */ }
}
