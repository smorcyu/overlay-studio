/**
 * 右下角导出进度浮窗显示什么:/api/export-status 的进度 → 百分比 + 一行说明。纯函数,方便测
 */

/** /api/export-status 返回的进度(解析规则见 scripts/export-progress.mjs) */
export interface ExportProg {
  stage: string;
  frame: number;
  total: number;
  finalPct?: number;
  finalOnly?: boolean;
  etaSec?: number;
}

export function exportProgressView(prog: ExportProg | null): { pct: number; text: string } {
  // 只导成片时没有 MOV/WebM 两步,成片合成是渲染之后唯一的大头:进度条给它 80–99
  const fast = !!prog?.finalOnly;
  let pct = 2;
  let text = "准备中(启动渲染器)…";
  if (prog) {
    if (prog.stage === "extract") {
      text = "预处理素材:把卡片里的视频抽成帧(长录屏要几分钟)…";
    } else if (prog.stage === "frames" && prog.total > 0) {
      // 渲染帧占进度的前 80%,后面是合成/混音
      pct = Math.max(2, Math.round((prog.frame / prog.total) * 80));
      // 「预计还需」由导出脚本算好、和帧数同一行报:只量逐帧渲染循环里的耗时,
      // 不把前面抽帧/启浏览器那几分钟摊进去;截图帧和「只导成片」时只推时钟的帧分开计时,
      // 剪切段多也不忽快忽慢。渲染刚开始、还没报第一次进度(前 30 帧)时显示「估算中」
      const eta = prog.etaSec;
      const fmt =
        eta === undefined ? "估算中" : eta >= 60 ? `${Math.floor(eta / 60)} 分 ${eta % 60} 秒` : `${eta} 秒`;
      text = `渲染帧 ${prog.frame}/${prog.total} · 预计还需 ${fmt}`;
    } else if (prog.stage === "mov") {
      pct = 84;
      text = "合成透明 MOV(长视频这步要几分钟)…";
    } else if (prog.stage === "webm") {
      pct = 93;
      text = "合成 WebM 小体积版…";
    } else if (prog.stage === "sfx") {
      pct = fast ? 80 : 98;
      text = fast ? "混音效…" : "把音效混进 MOV…";
    } else if (prog.stage === "final") {
      pct = fast ? 80 + Math.round((prog.finalPct ?? 0) * 0.19) : 99;
      text =
        prog.finalPct !== undefined
          ? `合成成片 MP4 ${prog.finalPct}%(原片 + 动效层 + 音效)…`
          : "合成成片 MP4(原片 + 动效层,长视频这步要几分钟)…";
    }
  }
  return { pct, text };
}
