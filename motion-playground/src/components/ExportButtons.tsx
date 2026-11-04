import { NO_CAM_HINT, type ExportMode } from "../app/useExport";

/**
 * 导出的两个按钮:透明 MOV / 成片 MP4。导出哪种每次点的时候选,不藏在设置里 ——
 * 以前是「只导成片」开关 + 一个导出按钮,开关一开,同一个按钮悄悄就变了意思。
 * 顶栏和左栏共用,外观由 btnClass 决定
 */
export function ExportButtons({
  btnClass,
  exportingMode,
  canFinal,
  onExport,
}: {
  btnClass: string;
  exportingMode: ExportMode | null;
  /** 设了口播视频(overlay.cam):成片 MP4 要用它合 */
  canFinal: boolean;
  onExport: (mode: ExportMode) => void;
}) {
  const busy = exportingMode !== null;
  return (
    <>
      <button
        className={btnClass}
        onClick={() => onExport("mov")}
        disabled={busy}
        title={
          "透明 MOV + WebM:拖进剪映盖在原片上" +
          (canFinal ? "。设了口播视频,顺手也合一条成片 MP4" : "")
        }
      >
        {exportingMode === "mov" ? "导出中…" : "⬇ 透明 MOV"}
      </button>
      <button
        className={`${btnClass}${canFinal ? "" : " is-unavailable"}`}
        onClick={() => onExport("final")}
        disabled={busy || !canFinal}
        title={
          canFinal
            ? "只出成片 MP4(口播原片 + 动效 + 音效),直接能发:不做透明层,剪切段里和口播视频结束之后的帧也不截图,快不少"
            : NO_CAM_HINT
        }
      >
        {exportingMode === "final" ? "导出中…" : "⬇ 成片 MP4"}
      </button>
    </>
  );
}
