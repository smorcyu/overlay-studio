import type { LintIssue } from "../overlay/lint";

/** 检查器浮窗(左下角):导入 JSON 自动体检的结果,只提醒不阻断 */
export function LintPanel({
  issues,
  collapsed,
  onToggle,
  onClose,
  onLocate,
  onIgnore,
}: {
  issues: LintIssue[];
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  onLocate: (i: LintIssue) => void;
  onIgnore: (i: LintIssue) => void;
}) {
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <div className="lint-panel">
      <div className="lint-head" onClick={onToggle}>
        <span>
          🔍 体检:{errors > 0 && <b className="lint-err-count">{errors} 个必修</b>}
          {errors > 0 && issues.length > errors && " · "}
          {issues.length > errors && `${issues.length - errors} 个建议`}
        </span>
        <span className="lint-head-btns">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {collapsed ? "展开" : "收起"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ✕
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="lint-list">
          {issues.map((i, idx) => (
            <div key={idx} className={`lint-item lint-${i.level}`}>
              <span className="lint-msg">
                {i.level === "error" ? "❌" : "⚠️"} {i.message}
              </span>
              <span className="lint-btns">
                {(i.cardId || i.at != null) && <button onClick={() => onLocate(i)}>定位</button>}
                <button title={i.cardId ? "写进这张卡,以后不再提醒" : "本次不再显示"} onClick={() => onIgnore(i)}>
                  忽略
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
