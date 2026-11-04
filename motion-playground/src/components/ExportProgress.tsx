import { exportProgressView, type ExportProg } from "../app/exportProgress";

/** 导出进度浮窗(右下角):渲染帧数 + 预计剩余 + 合成阶段(显示什么见 exportProgressView) */
export function ExportProgress({ prog }: { prog: ExportProg | null }) {
  const { pct, text } = exportProgressView(prog);
  return (
    <div className="export-prog">
      <div className="export-prog-head">
        <span>🎞 导出中</span>
        <b>{pct}%</b>
      </div>
      <div className="export-prog-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="export-prog-sub">{text}</div>
    </div>
  );
}
