import { useRef, useState, type RefObject } from "react";
import type { OverlayDoc } from "../overlay/types";
import type { ExportProg } from "./exportProgress";
import { exportDoneText, exportFailText, exportNotification, exportPngOnlyText, type ExportResult } from "./exportResult";
import { maybeShowLearnTip } from "./learnTip";

// 导出帧率:相机/手机拍的素材是 NTSC 29.97fps(30000/1001),动效层按 30 导会
// 越走越快 —— 166s 累计漂移约 5 帧,片尾能看出动效和口型对不上
const EXPORT_FPS = 29.97;

/** 没设口播视频时「成片 MP4」按钮的提示(按钮 title 和兜底弹窗共用) */
export const NO_CAM_HINT =
  "成片 MP4 = 口播原片 + 动效层,要先有口播视频:点「导入视频」(会自动设成口播视频),或在左栏「口播视频」里设一条";

/** 导出什么:mov =透明 MOV + WebM(设了口播视频时顺手合一条成片 MP4);final = 只出成片 MP4(快) */
export type ExportMode = "mov" | "final";

/**
 * 导出透明动效层 / 成片:调 /api/export,每秒轮询 /api/export-status 驱动右下角进度浮窗,
 * 完了弹结果(文字见 exportResult.ts)。导出哪一种由点的按钮决定(handleExport 的 mode)
 */
export function useExport(opts: {
  overlay: OverlayDoc | null;
  /** 本次导入的「AI 初选」:导出时连同终选一起落 review-log */
  originRef: RefObject<OverlayDoc | null>;
  fxScale: number;
  animSpeed: number;
}) {
  // 正在跑的是哪一种(null = 没在导出):「导出中…」只显示在点的那个按钮上
  const [exportingMode, setExportingMode] = useState<ExportMode | null>(null);
  // 导出进度(每秒轮询 /api/export-status)
  const [exportProg, setExportProg] = useState<ExportProg | null>(null);
  // 防连点用 ref,不用 exporting:state 要等下一次渲染才变,连点两下时第二下读到的还是 false。
  // 服务端会拒掉第二个(429),但这边第二下照样走完:弹一个「❌ 导出失败:已有导出任务在进行中」,
  // finally 里把进度浮窗收掉、导出按钮放开 —— 第一个其实还在跑。review-log 也会多落一份
  const busyRef = useRef(false);

  const handleExport = async (mode: ExportMode) => {
    const { overlay, originRef, fxScale, animSpeed } = opts;
    const finalOnly = mode === "final";
    if (busyRef.current) return;
    if (!overlay || overlay.cards.length === 0) {
      alert("时间轴上还没有卡片:先 📥 导入 JSON,或去 ✨ 效果库 ➕ 加入卡片。");
      return;
    }
    // 成片 = 口播原片 + 动效层,没设口播视频(overlay.cam)合不出来。按钮这时是灰的,这里兜一下
    if (finalOnly && !overlay.cam) {
      alert(NO_CAM_HINT);
      return;
    }
    busyRef.current = true;
    setExportingMode(mode);
    // 完成时发系统通知(切去别的应用也能收到);先申请权限
    if ("Notification" in window && Notification.permission === "default")
      Notification.requestPermission().catch(() => {});
    // 每秒轮询导出进度,驱动右下角进度浮窗
    const poll = window.setInterval(async () => {
      try {
        const r = await fetch("/api/export-status");
        const p = await r.json();
        if (p.running) setExportProg(p);
      } catch {
        /* 服务器重启等瞬时失败,忽略 */
      }
    }, 1000);
    // 学习闭环:定稿导出时也落一份「初选 vs 终选」日志
    fetch("/api/review-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        savedAt: new Date().toISOString(),
        origin: originRef.current,
        final: overlay,
      }),
    }).catch(() => {});
    maybeShowLearnTip();
    try {
      // 导出整条 overlay(时长 = 最后一张卡结束 + 0.5s 尾巴)
      // 尾巴是留给末尾音效收干净的,别用 ceil 取整 —— 28.0s 的片子会被抬到 29s,
      // 白白多出整整一秒空帧(卡片走到 end 就卸掉了,尾巴里什么都没有)。
      const body = {
        doc: overlay,
        scale: fxScale,
        speed: animSpeed,
        fps: EXPORT_FPS,
        duration: Math.max(...overlay.cards.map((c) => c.end)) + 0.5,
        finalOnly,
      };
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // 线上试玩版没有导出后端(逐帧渲染要本地无头 Chrome + ffmpeg):给友好提示,不甩报错。
      // 判断依据只能是「返回的不是 JSON」—— 静态托管会回 HTML(404 或 SPA 回退)。
      // 不能用 !res.ok:本地导出失败时服务端返回的是 500 + JSON,里面带着真正的
      // 失败原因,当成"线上版"会把这条信息直接丢掉,用户和你都不知道到底为什么失败。
      if (!(res.headers.get("content-type") ?? "").includes("json")) {
        alert(
          "🌐 当前是线上试玩版,不支持导出。\n\n导出(透明 MOV / 成片 MP4)需要在本地运行:\n  git clone 仓库 → npm install → npm run dev\n\n完整步骤见 README「快速开始」。",
        );
        return;
      }
      const data: ExportResult = await res.json();
      if (data.ok) {
        if ("Notification" in window && Notification.permission === "granted") {
          const n = exportNotification(data);
          new Notification(n.title, { body: n.body });
        }
        if (!data.mov && !data.final) {
          alert(exportPngOnlyText(data));
          return;
        }
        alert(exportDoneText(data));
      } else {
        alert(exportFailText(data.error));
      }
    } catch (e) {
      alert(`❌ 导出失败:${e}`);
    } finally {
      window.clearInterval(poll);
      busyRef.current = false;
      setExportingMode(null);
      setExportProg(null);
    }
  };

  return { exporting: exportingMode !== null, exportingMode, exportProg, handleExport };
}
