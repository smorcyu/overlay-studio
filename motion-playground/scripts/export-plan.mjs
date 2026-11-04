/**
 * 导出脚本(export-frames.mjs)里不碰浏览器、不碰文件的那部分计算:截哪几帧、还要多久、
 * 音效清单的时间怎么换算。拆出来是为了能单测 —— 导出脚本本身一跑就起无头 Chrome。
 */
import { captureEndFor, cutFrameRanges, inFrameRanges } from "./compose-final.mjs";
import { fmtTime } from "./fmt-time.mjs";

/** 每个音效最多截多长(秒):导出脚本混音时 atrim 到这么长,音效清单按它判断是不是整段被剪掉了 */
export const SFX_MAX_SEC = 3.2;

/**
 * 逐帧截图的安排:第 k 帧(从 0 数)写成第几张 PNG,0 = 不截。
 * 「只导成片」时剪切段里的帧不截(导出脚本照样推时钟),captureEnd(原片结束)之后的帧不截
 * (导出脚本连渲染都不做);普通导出全截。
 * PNG 序号连续编(ffmpeg 读 frame_%06d.png 遇到断号就停)
 */
export function captureSchedule(totalFrames, ranges, captureEnd = totalFrames) {
  let n = 0;
  return Array.from({ length: totalFrames }, (_, k) => (k >= captureEnd || inFrameRanges(ranges, k) ? 0 : ++n));
}

/**
 * 「只导成片」的截图计划:跳过哪些剪切帧(和成片合成剪原片用同一个 cutFrameRanges、同一个原片时长)、
 * 截到第几帧为止、每一帧写成第几张 PNG。导出脚本按它渲染,测试按它造 compose.json —— 两边一份逻辑
 */
export function preCutPlan({ cuts, fpsArg, footageDuration, timelineFrames }) {
  const known = Number.isFinite(footageDuration);
  const skipFrames = cutFrameRanges(cuts ?? [], fpsArg, known ? footageDuration : Infinity);
  const captureEnd = captureEndFor(known ? footageDuration : NaN, fpsArg, timelineFrames);
  return { skipFrames, captureEnd, schedule: captureSchedule(timelineFrames, skipFrames, captureEnd) };
}

/** 「只导成片」写进 compose.json 的核对字段(单独重合时 checkPreCutMeta 用)。frames = 实际写了几张 PNG */
export function preCutMeta(plan, timelineFrames, frames) {
  return { overlayPreCut: true, skipFrames: plan.skipFrames, timelineFrames, captureEnd: plan.captureEnd, frames };
}

/**
 * 渲染帧还要多少秒。截图的帧和只推时钟的帧耗时差好几倍,分别量平均耗时、乘各自还剩的张数;
 * 还没量到的那种帧先按另一种的耗时估:只推时钟的帧按截图帧估会偏多(还没遇到剪切段时),
 * 截图帧按只推时钟的帧估会偏少(一开头就是剪切段时),量到之后就准了。两种都没量到就是 0
 */
export function estimateEta({ leftShot, leftStep, shot, step }) {
  const avg = (c, fallback) => (c.n ? c.ms / c.n : fallback);
  const shotMs = avg(shot, avg(step, 0));
  const stepMs = avg(step, shotMs);
  return Math.max(0, Math.round((leftShot * shotMs + leftStep * stepMs) / 1000));
}

/**
 * 时间轴上的 t 秒在剪切后的成片里是第几秒。inCut:这张卡出现的第一帧(t 当时或之后的第一帧,k/fps ≥ t)
 * 被剪掉了 —— 它的音效开头也就跟着剪掉了(t 落在剪切段里时换算成那一刀的位置)。
 * cutUntil:那一刀剪到第几秒(没剪时为 null),用来判断音效是不是整段都在剪切段里
 */
export function cutTimelineTime(t, ranges, fps) {
  const f = t * fps;
  const removed = ranges.reduce((n, [s, e]) => n + Math.max(0, Math.min(e, f) - s), 0);
  const first = Math.ceil(f - 1e-9);
  const hit = ranges.find(([s, e]) => first >= s && first < e);
  return { t: t - removed / fps, inCut: !!hit, cutUntil: hit ? hit[1] / fps : null };
}

/**
 * 成品里少了音效时给用户的一句话(没少就是 null)。按实际出了什么来说:
 * mixOk = 音效混音成了;mov / movBaked = 有 MOV / 音效封进了 MOV;final = 成片合出来了
 */
export function sfxMissingNote({ count, mixOk, mov, movBaked, final }) {
  if (!count) return null;
  const without = [];
  if (mov && !movBaked) without.push("MOV");
  if (final && !mixOk) without.push("成片");
  if (!without.length) return null;
  const why = mixOk ? "音效没封进 MOV(多半是磁盘满了)" : `${count} 个音效没混成(多半是 public/sfx/ 里有音效文件读不了)`;
  const where = without.length > 1 ? "MOV 和成片里都" : without[0] === "MOV" ? "MOV 里" : "成片里";
  return `${why},${where}没有音效${mixOk && final ? ";成片里照常有" : ""}`;
}

/**
 * 开工前估这次导出要多少磁盘(字节),再留 2GB 余量。
 * 中途写满会得到一个"没有 moov 索引"的半截 MOV —— 剪映只会说"文件损坏",查不出原因。
 * 普通导出:PNG 序列(约 14MB/s)+ ProRes(约 29MB/s),设了口播视频时再加成片 MP4(normalFinalSec 秒)。
 * 只导成片:PNG 只截剪剩下的帧(capturedFrames 张),成片 MP4 按 3MB/s、finalSec 秒算
 * (原片常比最后一张卡长得多;只导成片时已经减掉剪掉的)
 */
export function estimateNeedBytes({ finalOnly, capturedFrames, fps, finalSec, duration, normalFinalSec }) {
  const MB = 1024 * 1024;
  return finalOnly
    ? (capturedFrames / fps) * 14 * MB + finalSec * 3 * MB + 2 * 1024 ** 3
    : duration * (14 + 29) * MB + normalFinalSec * 3 * MB + 2 * 1024 ** 3;
}

/**
 * 「合成说明」的文字:这几段的透明层里已经有一份人物画面,剪映里必须把原始口播轨盖住,
 * 否则会看到两层人。说明放在成品旁边,而不是 README —— 用户打开
 * exports/output/ 拿 MOV 的那一刻,正好是他要去剪映的前一秒。
 */
export function camNoteText(title, camSegs) {
  return [
    `合成说明 · ${title}`,
    "",
    "这条动效层里有 " + camSegs.length + " 段把口播人物烤了进去(运镜/取景类卡片)。",
    "剪映里这几段要把【原始口播轨盖住】,否则会看到两层人:",
    "",
    ...camSegs.map((s) => `  ${fmtTime(s.start)} — ${fmtTime(s.end)}   ${s.kind}`),
    "",
    "做法:把 MOV 放在最上层轨道,上面这几个时间段把下面的原始口播轨切开、静音或删除画面",
    "(声音要留)。其余时间段照常,MOV 盖在原片上即可。",
  ].join("\n");
}

/** 剪切帧段一共剪掉多少秒 */
export function cutSeconds(ranges, fps) {
  return ranges.reduce((n, [s, e]) => n + (e - s), 0) / fps;
}

/**
 * 整份音效清单的文字。mov:MOV 里封了一份(完整时间轴);final = { ranges, finalSec }:成片 MP4 里也有
 * (剪切后的时间)。两份都有、又有剪切时列两列时间(左 MOV、右成片),不然在成片里找音效会对不上
 */
export function sfxSheetText({ title, points, mov, final, fps }) {
  const both = !!(mov && final && final.ranges.length > 0);
  const lines = final
    ? sfxSheetLines(points, final.ranges, fps, final.finalSec, { withTimeline: both })
    : sfxSheetLines(points, null, fps);
  const into = mov && final ? " MOV 和成片 MP4" : mov ? " MOV" : "成片 MP4";
  const timeNote = both
    ? "左列是 MOV(完整时间轴)的时间,右列是成片 MP4(剪切后)的时间。"
    : final?.ranges.length
      ? "时间是剪切后的成片时间。"
      : "";
  return [
    `音效清单 · ${title}(已直接混入${into},无需手动加)`,
    "想调整:回 Studio 选中卡片 → 节奏组「音效」下拉换一个(选中即试听)或选「无音效」,重新导出。",
    ...(mov ? ["整条音效轨的音量在剪映里对 MOV 轨道统一调(建议比人声低,约 -12~-18dB)。"] : []),
    ...(final ? [`${timeNote}成片里音效按固定音量混入(约 -16dB);「人声响度统一」只调人声,不调音效。`] : []),
    "",
    ...lines,
  ].join("\n");
}

/**
 * 音效清单的每一行。ranges 为 null:按完整时间轴(MOV 是完整时长);
 * 给了剪切帧段:换成剪切后的成片时间,开头被剪掉的、在成片结束(finalSec)之后的标出来。
 * withTimeline:前面再加一列完整时间轴的时间(MOV 和成片都有、又有剪切时)
 */
export function sfxSheetLines(points, ranges, fps, finalSec = null, { withTimeline = false } = {}) {
  return points.map((p) => {
    const c = ranges ? cutTimelineTime(p.t, ranges, fps) : { t: p.t, inCut: false, cutUntil: null };
    const past = ranges && Number.isFinite(finalSec) && c.t >= finalSec;
    // 这一刀一直剪到音效最长能响到的地方之后:整段都听不到(短音效可能更早就整段剪掉了,这里按最长算)
    const whole = c.inCut && c.cutUntil !== null && c.cutUntil >= p.t + SFX_MAX_SEC;
    const note = past
      ? "  (在成片结束之后:成片里没有)"
      : whole
        ? "  (整段在剪切段里:成片里听不到)"
        : c.inCut
          ? "  (起点在剪切段里:成片里开头被剪掉了)"
          : "";
    return `${withTimeline ? `${fmtTime(p.t)}  ` : ""}${fmtTime(c.t)}  ${p.kind.padEnd(14)}  ${p.sfx}${note}`;
  });
}
