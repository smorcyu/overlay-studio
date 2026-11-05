import { useEffect, useRef, useState } from "react";
import type { ExportResultView } from "../app/exportResult";

/** 复制到剪贴板。localhost 算安全上下文,clipboard API 一般都能用;用不了就退回老办法 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** 让开发服务器在 Finder / 资源管理器里打开(只认 exports/ 里的路径,见 vite.config.ts 的 /api/reveal) */
async function reveal(path: string): Promise<string | null> {
  try {
    const r = await fetch("/api/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const d = await r.json().catch(() => null);
    return d?.ok ? null : (d?.error ?? `HTTP ${r.status}`);
  } catch (e) {
    return String(e);
  }
}

/**
 * 导出结果面板:成品一行一个,能复制路径、在文件夹中显示;提醒和可复制的命令列在下面。
 * 以前是一个长 alert,路径没法点也没法复制,提醒混在一大段文字里。Esc 或点外面关掉
 */
export function ExportResultPanel({ view, onClose }: { view: ExportResultView; onClose: () => void }) {
  // 刚复制的是哪一项(按钮上显示「已复制」一会儿)
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Esc 关闭。监听只挂一次,onClose 从 ref 读:全局快捷键(useShortcuts)也听 Esc、先跑,它一改状态
  // 整个 App 当场重新渲染 —— 监听要是跟着 onClose 换,这一下 Esc 派发途中旧的被摘掉、新的不算数,面板就关不掉
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const copy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } else setErr("复制失败:浏览器不让写剪贴板,手动选中复制吧");
  };
  const open = async (path: string) => {
    setErr(await reveal(path));
  };

  // 点外面关掉 —— 只认「按下和松开都在外面」:在面板里拖选路径或报错、松手时滑到了外面,
  // 浏览器会把这一下 click 算到外面的背景上,不能因此把面板关了
  // 反过来也一样:在外面按下、拖进面板里松手,click 也会落到背景上 —— 所以按下和松开各记一次
  const downOnBackdrop = useRef(false);
  const upOnBackdrop = useRef(false);

  return (
    <div
      className="result-backdrop"
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onMouseUp={(e) => (upOnBackdrop.current = e.target === e.currentTarget)}
      onClick={() => {
        if (downOnBackdrop.current && upOnBackdrop.current) onClose();
        downOnBackdrop.current = upOnBackdrop.current = false;
      }}
    >
      <div
        className={`result-panel result-${view.kind}`}
        role="dialog"
        aria-label={view.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="result-head">
          <b>{view.title}</b>
          <button className="result-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {view.error && (
          <div className="result-error">
            <pre>{view.error}</pre>
            <button onClick={() => copy("error", view.error!)}>{copied === "error" ? "已复制" : "复制原因"}</button>
          </div>
        )}

        {view.files.length > 0 && (
          <ul className="result-files">
            {view.files.map((f) => (
              <li key={f.path}>
                <div className="result-file-label">
                  {f.icon} {f.label}
                </div>
                <div className="result-file-row">
                  {/* 外层从右往左排(太长时省略开头、留住文件名),路径本身包一层从左往右,不然斜杠会被挪到末尾 */}
                  <code className="result-path" title={f.path}>
                    <bdi dir="ltr">{f.path}</bdi>
                  </code>
                  <button onClick={() => copy(f.path, f.path)}>{copied === f.path ? "已复制" : "复制路径"}</button>
                  <button onClick={() => open(f.path)}>在文件夹中显示</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {view.notes.length > 0 && (
          <ul className="result-notes">
            {view.notes.map((n, i) => (
              <li key={i} className={`result-note result-note-${n.level}`}>
                <span>{n.text}</span>
                {n.cmd && (
                  <span className="result-cmd">
                    <code>{n.cmd}</code>
                    <button onClick={() => copy(`cmd${i}`, n.cmd!)}>{copied === `cmd${i}` ? "已复制" : "复制"}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {view.summary && <div className="result-summary">{view.summary}</div>}
        {err && <div className="result-note result-note-warn">⚠️ {err}</div>}

        <div className="result-foot">
          {view.folder && (
            <button className="result-primary" onClick={() => open(view.folder!)}>
              📂 打开文件夹
            </button>
          )}
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
