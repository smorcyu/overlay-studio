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
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { composeFinal, cutFrameRanges, hasBin, probeFootage, stopComposing } from "./compose-final.mjs";
import {
  camNoteText, captureSchedule, cutSeconds, emptyFrameMask, estimateEta, estimateNeedBytes, preCutMeta, preCutPlan, sfxMissingNote, sfxSheetText,
} from "./export-plan.mjs";
import { encodeMov, encodeWebm, writeBlankFrame } from "./export-alpha.mjs";
import { finalOnlyPrecheck, freeBytes, gb } from "./export-checks.mjs";
import { mixSfx, muxSfxIntoMov, sfxPointsFor } from "./export-sfx.mjs";
import { cleanUnusedFrameCaches, collectVideoUses, extractVideoFrames } from "./export-video-frames.mjs";
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
  finalOnly: finalOnlyRaw = false,
} = job;
// 只认 true(和开发服务器报进度时的判断一致):别的调用方传个 1 / "true" 不会一半按只导成片、一半按普通导出
const finalOnly = finalOnlyRaw === true;

const STAGE = { w: 1920, h: 1080 };

// NTSC 29.97 的真身是 30000/1001(=29.970029970…),写成小数会有微小误差:
// 帧号/时钟用精确值算,传给 ffmpeg 的帧率用分数字符串,避免它按 2997/100 编码
const isNTSC = Math.abs(fps - 29.97) < 0.01;
const FPS = isNTSC ? 30000 / 1001 : fps;
const FPS_ARG = isNTSC ? "30000/1001" : String(fps);

const totalFrames = Math.max(1, Math.round(duration * FPS));
const intervalMs = 1000 / FPS;

// ---- 只导成片:开工前就确认合得出来(见 finalOnlyPrecheck) ----
// 跳过哪几帧和成片合成剪掉哪几帧走同一个 cutFrameRanges(同一个原片时长):一一对上(见 preCutPlan)
let footageInfo = null;
let plan = null;
if (finalOnly) {
  const check = finalOnlyPrecheck(doc, ROOT);
  if (check.why) {
    console.error(`\n【导出失败原因】${check.why}`);
    process.exit(1);
  }
  footageInfo = check.footageInfo;
  plan = preCutPlan({ cuts: doc.cuts, fpsArg: FPS_ARG, footageDuration: footageInfo.duration, timelineFrames: totalFrames });
}
const skipRanges = plan?.skipFrames ?? [];
// 只导成片时原片结束之后的帧也不截(成片跟着原片结束,截了也用不上)
const captureEnd = plan?.captureEnd ?? totalFrames;
/**
 * 第 k 帧(从 0 数,t = k/FPS)写成第几张 PNG;0 = 不截:剪切段里的只推时钟,原片结束之后的连渲染都不做
 * (普通导出全都截)
 */
const schedule = plan?.schedule ?? captureSchedule(totalFrames, [], totalFrames);
const capturedFrames = schedule.filter(Boolean).length;
// 画面上一张卡都没有的帧(口播里大段没动效的地方):不截图,复制第一次截到的那张空帧。
// 截图 + 写 PNG 是每帧最贵的部分,这种帧在真实口播里常常占一大半
const emptyMask = emptyFrameMask(doc?.cards, totalFrames, FPS);
// 估「还需」用:从第 k 帧(含)往后,还有几张要写的 PNG、其中几张按卡的时间算是空的。
// 按帧号查表,不拿「已经写了几张空帧」去减:页面那道检查没过的空帧会照常截图,减法会越差越多
const capturedFrom = new Array(totalFrames + 1).fill(0);
const emptyFrom = new Array(totalFrames + 1).fill(0);
for (let k = totalFrames - 1; k >= 0; k--) {
  capturedFrom[k] = capturedFrom[k + 1] + (schedule[k] ? 1 : 0);
  emptyFrom[k] = emptyFrom[k + 1] + (schedule[k] && emptyMask[k] ? 1 : 0);
}
const uncapturedFrames = totalFrames - capturedFrames; // 不截的帧:剪切段里的 + 原片结束之后的
const tailFrames = totalFrames - captureEnd; // 原片结束之后的(连渲染都不做)
const cutFrames = uncapturedFrames - tailFrames; // 剪切段里的(只推时钟)

// 开工前先看磁盘够不够(估法见 estimateNeedBytes)
const removedSec = cutSeconds(skipRanges, FPS);
const finalSec = footageInfo?.duration ? Math.max(0, footageInfo.duration - removedSec) : duration;
// 普通导出也合成片时量一下原片长度(读不出、没装 ffprobe 就按时间轴长度估)
const normalFinalSec = !finalOnly && finalMp4 && doc?.cam
  ? (() => {
      const f = resolvePublic(path.join(ROOT, "public"), doc.cam);
      return f && fs.existsSync(f) && hasBin("ffprobe") ? probeFootage(f).duration ?? duration : duration;
    })()
  : 0;
const needBytes = estimateNeedBytes({ finalOnly, capturedFrames, fps: FPS, finalSec, duration, normalFinalSec });

// 工作目录 exports/<名称>-<时间戳>/(PNG 序列等中间产物)
// 成品目录 exports/output/(成品全部只放这里:透明 MOV/WebM、成片 MP4、音效清单、合成说明)
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const name = "timeline";
const outDir = path.join(ROOT, "exports", `${name}-${stamp}`);
const finalDir = path.join(ROOT, "exports", "output");

// ---- 磁盘预检:放在抽帧清单算出来之后 ----
// 卡内视频要先抽成 JPEG 序列(虚拟时钟下 <video> 不走,见 export-video-frames.mjs)。
// 以前只算 PNG 序列 + ProRes 成片,**卡内视频抽的 JPEG 不在账里** —— 全局口播是按整条时长抽的,
// 20 分钟的口播在 30fps 下就是三万多张 JPEG(几个 GB),预检说「够」,抽到一半盘满了。
// 按每帧 200KB 估(1080p、-q:v 4 的典型量级),宁可高估。
const videoUses = collectVideoUses(doc, duration);
const frameBytes = [...videoUses.values()].reduce((a, sec) => a + sec * FPS * 200 * 1024, 0);
const needTotal = needBytes + frameBytes;
const freeNow = freeBytes(ROOT);
if (freeNow < needTotal) {
  console.error(
    `\n【导出失败原因】磁盘空间不够:还剩 ${gb(freeNow)}GB,这次导出` +
      `大约需要 ${gb(needTotal)}GB(PNG 序列 + ${finalOnly ? "成片 MP4" : `ProRes 透明 MOV${normalFinalSec ? " + 成片 MP4" : ""}`}` +
      (frameBytes ? ` + 卡内视频抽帧 ${gb(frameBytes)}GB` : "") +
      ` + 余量)。\n` +
      `先腾地方再导 —— exports/ 里除 output 外的目录都是 PNG 中间产物,成片出来后可以整个删;` +
      `public/_fxframes/ 是视频抽帧缓存,也可以整个删。`,
  );
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(finalDir, { recursive: true });

const vidFrames = extractVideoFrames(videoUses, { root: ROOT, fps, FPS, FPS_ARG });

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
 * 音效清单(和成品放在一起)。mov:音效封进了 MOV(完整时间轴);
 * final = { ranges, finalSec } 或 null:成片 MP4 里也有(剪切后的时间)
 */
function writeSfxSheet(result, points, { mov, final }) {
  // 文字怎么排(一列还是两列时间、写哪几句说明)见 sfxSheetText
  const sheet = sfxSheetText({ title: `${name}-${stamp}`, points, mov, final, fps: FPS, sfxVolume: doc?.audio?.sfxVolume });
  const sheetPath = path.join(finalDir, `${name}-${stamp}-音效清单.txt`);
  // 成品都已经到手了:清单写不进去(多半是盘满)不该让整次导出报失败,说一声就行
  try {
    fs.writeFileSync(sheetPath, sheet, "utf8");
    result.sfxSheet = sheetPath;
  } catch (e) {
    fs.rmSync(sheetPath, { force: true });
    result.sfxSheetError = `音效清单没写进去(${String(e).split("\n")[0]}),成品不受影响`;
  }
}

// 被叫停(开发服务器的看门狗先发 SIGTERM):把自己起的 ffmpeg 和渲染器一起带走再退出,
// 不留孤儿进程接着写半截文件
// 渲染循环跑完才置 true(只导成片时还要等 compose.json 写好):catch 里靠它区分「渲染到一半崩了」
// (PNG 是半成品,删)和「渲染完了、合成失败」(PNG 是几分钟的成果,留着可手动重合成)。
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
  let written = 0; // 实际写了的 PNG 张数(只导成片时剪切段里的不写)
  // 空帧:第一次遇到时照常截一张,存下它的路径;之后的空帧直接复制这个文件(和截出来的一个字节都不差)
  let blankPng = null;
  let emptyCopied = 0; // 几张空帧是复制的(第一张是截的)
  // 「预计还需」由这里算好报给界面:截图的帧、只推时钟的帧、复制空帧的帧耗时差好几倍,
  // 按「平均每帧」算的话剪切段/空段多的地方会忽快忽慢。几种帧分别量平均耗时,乘各自还剩的张数
  const cost = { shot: { ms: 0, n: 0 }, step: { ms: 0, n: 0 }, empty: { ms: 0, n: 0 } };

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
    // 空帧:按卡的时间算是空的,还要页面上真的一张卡都没挂(stage 下没有子元素)才算 ——
    // 两边对不上(比如有张卡导出页认不出、没渲染)时宁可照常截图
    const empty =
      !skip &&
      emptyMask[i - 1] &&
      (await page
        .evaluate(() => document.querySelector(".stage.is-export")?.childElementCount === 0)
        .catch(() => false));
    let copied = false;
    if (!skip) {
      const file = path.join(outDir, `frame_${String(schedule[i - 1]).padStart(6, "0")}.png`);
      if (empty && blankPng) {
        fs.copyFileSync(blankPng, file);
        emptyCopied++;
        copied = true;
      } else {
        await page.screenshot({ path: file, omitBackground: true });
        if (empty) blankPng = file;
      }
      written++;
    }
    // 第一张空帧是真截的,按截图计时;后面复制的才算空帧的耗时
    const c = skip ? cost.step : copied ? cost.empty : cost.shot;
    c.ms += Date.now() - frameT0;
    c.n++;
    if (i % 30 === 0 || i === renderFrames) {
      // 进度条按推过的帧数走(剪切段里也照样往前走,不会停住);「预计还需」按几种帧各自的耗时算
      // 还剩的帧从第 i 帧(从 0 数)开始;三种加起来正好是 renderFrames - i,都不会是负数
      const leftEmpty = emptyFrom[i];
      const leftShot = capturedFrom[i] - leftEmpty;
      const leftStep = renderFrames - i - capturedFrom[i];
      // 和帧数打在同一行:分两行的话,界面轮询可能刚好读到只有帧数、没有「预计还需」的那一刻
      const eta = estimateEta({ leftShot, leftEmpty, leftStep, shot: cost.shot, step: cost.step, empty: cost.empty });
      console.log(`progress ${i}/${renderFrames} eta ${eta}`);
    }
  }
  if (emptyCopied) console.log(`empty frames: ${emptyCopied} frames with no card on screen copied from one blank screenshot`);

  // 一张都没截(原片里用得到的帧全在剪切段里):补一张全透明的,成片合成要有动效层输入
  // (普通导出这种编排照样合得出来,只导成片也不该失败)。frames 报的是真正截了的张数,不算这张
  const shotFrames = written;
  if (!written) {
    if (writeBlankFrame(path.join(outDir, "frame_000001.png"), STAGE)) written = 1;
    // 连这一张都补不上(ffmpeg 出错):目录里一张 PNG 都没有,没法合也没法重合 —— 当渲染失败处理
    else throw new Error("原片里用得到的帧全在剪切段里,要补一张透明帧给成片合成用,但 ffmpeg 生成失败了");
  }

  if (slowFrames > 3) console.log(`vid-frames: 一共 ${slowFrames} 帧的视频帧图没等到加载完(只列了前 3 帧)`);

  // 烤入人物的时间段(导出页按「卡有没有 camSrc 控件」算好挂在 window 上)。
  // 趁浏览器还开着取出来,后面写进「合成说明」。
  const camSegs = await page.evaluate(() => window.__CAM_SEGMENTS ?? []).catch(() => []);

  // 合成参数(compose.json)渲染一完就写进 PNG 目录,不等到合成那一步:导出在后面任何一步被叫停或崩掉,
  // PNG 都会留下,单独跑 compose-final.mjs 读它就能原样重合。尤其「只导成片」的 PNG 已经跳过了剪切帧,
  // 没有它的话会被当成老版本的完整时长 PNG,再剪一遍、整条错位。
  // 成片音频:响度统一(默认开)+ 可选背景音乐。音乐地址和口播视频一样只认 public/ 里的文件
  const audioPrefs = doc?.audio ?? {};
  const bgmPath = audioPrefs.bgm ? resolvePublic(path.join(ROOT, "public"), audioPrefs.bgm) : null;
  // overlayPreCut:只导成片时 PNG 已经跳过了剪切段里的帧,合成时只剪原片(重合时也要照这个来)
  // skipFrames / timelineFrames / captureEnd / frames:单独重合时核对(换的原片让剪切帧变了、PNG 不全,叠出来会错位)
  const compose = {
    fpsArg: FPS_ARG, stage: STAGE, camSegs, cuts: doc?.cuts ?? [],
    audio: {
      normalize: audioPrefs.normalize !== false, bgm: bgmPath, bgmVolume: audioPrefs.bgmVolume, duck: audioPrefs.duck !== false,
      sfxVolume: audioPrefs.sfxVolume,
    },
    overlayPreCut: false,
    ...(finalOnly ? preCutMeta(plan, totalFrames, written) : {}),
  };
  const writeCompose = () => fs.writeFileSync(path.join(outDir, "compose.json"), JSON.stringify(compose));
  let composeMissing = false; // 普通导出时 compose.json 没写成:PNG 留着也没法单独重合
  if (finalOnly) {
    // 只导成片:PNG 和 compose.json 都齐了才算「渲染完成」。之前崩掉(包括 compose.json 写不进去)的话,
    // 留下的 PNG 没法正确重合(会被当成完整时长再剪一遍),catch 和 SIGTERM 会把它清掉
    writeCompose();
    framesDone = true;
  } else {
    // 普通导出:PNG 是完整时长,渲染完就算完成;compose.json 只给之后单独重合成片用,写不进去不拦着出 MOV
    framesDone = true;
    if (finalMp4 && doc?.cam) {
      try {
        writeCompose();
      } catch (e) {
        composeMissing = true;
        console.error(`compose.json 写不进去(${e}):MOV 照常出,只是之后没法单独重合成片`);
      }
    }
  }

  // ---- PNG 序列 → 自动合成透明视频(需要本机 ffmpeg;没有则跳过,只留 PNG) ----
  // outputDir 是成品目录;dir 是 PNG 中间目录,成片到手后会被清理成 null
  const result = {
    ok: true, dir: outDir, outputDir: finalDir, frames: shotFrames, fps, mov: null, webm: null, finalOnly,
    ...(finalOnly ? { cutFrames, tailFrames } : {}),
    ...(composeMissing ? { composeMissing } : {}),
  };
  const hasFfmpeg = hasBin("ffmpeg");
  let sfxPoints = []; // 混进音轨的音效点(写清单用)
  let sfxMixOk = false;
  let finalSfx = null; // 成片里的剪切帧段和成片时长(写音效清单用)
  if (finalOnly) {
    console.log("final-only: skip MOV/WebM");
  } else if (hasFfmpeg) {
    const seq = path.join(outDir, "frame_%06d.png");
    // 1) 剪映友好:ProRes 4444 透明 MOV → 成品放 exports/output/
    console.log("composing MOV (ProRes 4444 alpha)...");
    const mov = path.join(finalDir, `${name}-${stamp}.mov`);
    if (encodeMov(seq, mov, FPS_ARG)) {
      result.mov = mov;
    } else {
      result.ok = false;
      result.error = `MOV 合成失败(磁盘还剩 ${gb(freeBytes(ROOT))}GB),半截文件已删除`;
      console.error(`\n【导出失败原因】${result.error}`);
    }
    // 2) 小体积:VP9 透明 WebM
    console.log("composing WebM (VP9 alpha)...");
    const webm = path.join(finalDir, `${name}-${stamp}.webm`);
    if (encodeWebm(seq, webm, FPS_ARG)) result.webm = webm;
  } else {
    console.log("ffmpeg not found — skip video composing, PNG sequence only");
  }

  // ---- 音效烤入:按每张卡的出现时刻把音效混成音轨,普通导出时封进 MOV(选哪个音效见 export-sfx.mjs)----
  // 只导成片时没有 MOV,音效混音照做:成片合成要用它
  if (doc?.cards?.length && (result.mov || finalOnly) && hasFfmpeg) {
    const points = sfxPointsFor(doc, ROOT);
    if (points.length) {
      console.log(`baking ${points.length} sfx into ${result.mov ? "MOV" : "the final MP4 mix"}...`);
      // 1) 混成一条音轨(见 mixSfx)
      const mixFile = path.join(outDir, "sfx-mix.m4a");
      sfxMixOk = mixSfx(points, duration, mixFile);
      sfxPoints = points;
      // 2) 音轨封进 MOV
      if (sfxMixOk && result.mov && muxSfxIntoMov(result.mov, mixFile)) {
        result.sfxBaked = points.length;
        console.log(`sfx baked: ${points.length} points`);
      }
      // 3) 清单(想换音效:选中卡片 → 「音效」下拉 → 重导)和「少了音效」的提示:
      // 两种模式都等成品都有了再写,见下面「音效清单」
    }
  }

  // ---- 合成说明:只在真的烤了人物时才生成(文字见 camNoteText) ----
  if (camSegs.length && result.mov) {
    const notePath = path.join(finalDir, `${name}-${stamp}-合成说明.txt`);
    fs.writeFileSync(notePath, camNoteText(`${name}-${stamp}`, camSegs), "utf8");
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
      // 合成参数在渲染完时已经写进 PNG 目录了(见上面 compose)
      if (audioPrefs.bgm && !bgmPath) result.audioNote = `背景音乐路径不在 public/ 里,没用上:${audioPrefs.bgm}`;
      if (compose.audio.normalize) console.log("measuring loudness...");
      console.log("composing final MP4 (footage + overlay)...");
      const r = await composeFinal({
        ...compose,
        footage,
        seq: path.join(outDir, "frame_%06d.png"),
        sfxMix: sfxMixOk ? path.join(outDir, "sfx-mix.m4a") : null,
        out: path.join(finalDir, `${name}-${stamp}-final.mp4`),
        workDir: outDir, // 滤镜图临时文件(刀数多时才有)放 PNG 目录,不放成品目录
        // 每涨 1% 打一行:看门狗(15 分钟没输出就杀)靠它知道还活着,界面也能显示进度。
        // 读不到原片时长时 pct 为 null:只打心跳,界面显示「合成中」不显示百分比
        onProgress: (pct) => console.log(`final-progress ${pct === null ? "?" : pct}/100`),
      });
      if (r.ok) {
        result.final = r.out;
        result.finalAudio = r.audio;
        if (r.audio?.bgmMissing) result.audioNote = `背景音乐文件找不到,没用上:${audioPrefs.bgm}`;
      } else result.finalError = r.error;
    }
    if (result.final && footage) {
      // 成片里实际剪掉的帧和成片时长(音效清单要给出成片里的时间)。只导成片时开工前已经算好了;
      // 普通导出这里再量一次原片
      if (finalOnly) finalSfx = { ranges: skipRanges, finalSec: footageInfo?.duration ? finalSec : null };
      else {
        const d = probeFootage(footage).duration;
        const ranges = cutFrameRanges(doc.cuts ?? [], FPS_ARG, d ?? Infinity);
        finalSfx = { ranges, finalSec: d ? Math.max(0, d - cutSeconds(ranges, FPS)) : null };
      }
    }
    // 只导成片时下面会报一条完整的失败原因,这里不重复(服务端只留 stderr 的最后 800 字)
    if (result.finalError && !finalOnly) console.error(`成片没合成:${result.finalError}`);
  } else if (finalMp4 && doc?.cuts?.length && result.mov && !doc?.cam) {
    // 剪切只作用在成片 MP4 上,没有成片就等于没剪 —— 说出来,别让人以为剪过了。
    // (没装 ffmpeg 时连 MOV 都没有,界面另有一条「先装 ffmpeg」的提示,这里不用管)
    result.finalSkipped = "编排里有剪切段,但没有设全局口播视频,所以没生成成片 MP4(透明 MOV 是完整时长,没有剪)";
  }
  // 成片没合出来时的重合命令(两种模式共用):路径都加引号、相对 motion-playground(目录名带空格也能直接复制)
  if (result.finalError && doc?.cam) {
    const rel = (p) => path.relative(ROOT, p);
    const footagePath = resolvePublic(path.join(ROOT, "public"), doc.cam);
    if (footagePath)
      result.recomposeCmd =
        `node scripts/compose-final.mjs "${rel(footagePath)}" "${rel(outDir)}" "${rel(path.join(finalDir, `${name}-${stamp}-final.mp4`))}"`;
  }
  // 只导成片时成片就是唯一的成品:没合出来就是导出失败(PNG 留着,修好后可以直接重合)
  if (finalOnly && !result.final) {
    result.ok = false;
    // 原因放最前、截短:服务端只留 stderr 最后 800 字,界面从最后一个【导出失败原因】起显示,整条要放得下
    const why = String(result.finalError ?? "成片 MP4 没合成");
    result.error =
      `【导出失败原因】${why.length > 300 ? `${why.slice(0, 300)}…` : why}\n` +
      `PNG 序列${skipRanges.length ? "(已跳过剪切段)" : ""}留着,修好后不用重新渲染,在 motion-playground 目录里用同一条口播原片重合:\n` +
      (result.recomposeCmd ?? "");
    // 退出码也要是失败:/api/export-status 按它报成败
    console.error(`\n${result.error}`);
    process.exitCode = 1;
  }

  // ---- 音效清单:成品都有了再写(写的是真的混进去了的:MOV 封好了音轨、成片合出来了)----
  // 混音或封进 MOV 失败时成品照出、但少了音效 —— 要说出来(只导成片时那条成片就是唯一的成品)。
  // 说「哪个文件里没有」要按实际出了什么来说
  {
    const note = sfxMissingNote({
      count: sfxPoints.length, mixOk: sfxMixOk, mov: !!result.mov, movBaked: !!result.sfxBaked, final: !!result.final,
    });
    if (note) result.sfxNote = note;
  }
  {
    const mov = !!result.sfxBaked;
    const final = sfxMixOk && result.final ? finalSfx : null;
    if (sfxPoints.length && (mov || final)) writeSfxSheet(result, sfxPoints, { mov, final });
  }

  // ---- 清理 PNG 中间目录:成片(MOV 或只导成片时的 MP4)到手后这几 GB 就没用了,默认删除 ----
  // 合成失败、成片 MP4 没合成、或没装 ffmpeg 时保留:PNG 是几分钟渲染的成果,
  // 留着可以单独跑 compose-final.mjs 重合成片,不用重新渲染。
  if ((result.mov || result.final) && !keepFrames && !result.finalError) {
    fs.rmSync(outDir, { recursive: true, force: true });
    result.dir = null;
    console.log("cleaned PNG frames dir");
  }

  // ---- 抽帧缓存:只留这次用到的(见 cleanUnusedFrameCaches) ----
  {
    const n = cleanUnusedFrameCaches(ROOT, vidFrames);
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
