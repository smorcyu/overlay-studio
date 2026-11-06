/** SRT 字幕解析:给编辑台的字幕稿面板用 */
export interface SrtLine {
  start: number;
  end: number;
  text: string;
}

function toSec(t: string): number {
  const m = t.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!m) return NaN;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  );
}

/** 秒 → SRT 时间(00:01:02,345),四舍五入到毫秒 */
function fmtSrtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/**
 * 字幕稿 → SRT 文字(「导出 SRT」用:🎙 自动识别出来的字幕稿交给 AI 编排时要一份文件)。
 * 序号从 1 重新编;字幕里的换行压成一个空格(空行会让 SRT 断块)
 */
export function formatSrt(lines: SrtLine[]): string {
  return lines
    .map((l, i) => `${i + 1}\n${fmtSrtTime(l.start)} --> ${fmtSrtTime(l.end)}\n${l.text.replace(/\s*\n\s*/g, " ").trim()}\n`)
    .join("\n");
}

/** 宽松解析:跳过序号行,合并同条多行文本,忽略坏块 */
export function parseSrt(text: string): SrtLine[] {
  const lines: SrtLine[] = [];
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const rows = block.split("\n").filter((r) => r.trim());
    const ti = rows.findIndex((r) => r.includes("-->"));
    if (ti === -1) continue;
    const [a, b] = rows[ti].split("-->");
    const start = toSec(a);
    const end = toSec(b);
    const body = rows.slice(ti + 1).join(" ").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !body) continue;
    lines.push({ start, end, text: body });
  }
  return lines.sort((a, b) => a.start - b.start);
}
