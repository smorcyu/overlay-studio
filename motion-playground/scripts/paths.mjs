/**
 * 路径守卫:编排里写的素材地址(doc.cam、camSrc、/api/waveform?src=)最终都会变成磁盘路径,
 * 只许落在指定目录里面。开发服务器(vite.config.ts)和导出脚本共用这一份。
 *
 * 跳出目录有两种样子:
 *   - 相对路径是「..」或以「../」开头(Windows 是「..\」);
 *   - 相对路径干脆是一条绝对路径 —— Windows 上换了盘符(C:\proj\public 对 D:\x.mp4)时
 *     path.relative 给回的就是 D:\x.mp4,只查「..」会被绕过去。
 * 只查前缀「..」不够细:文件名本身以两个点开头(「..intro.mp4」)是合法的,不能误伤。
 *
 * p 参数给测试用:传 path.win32 就能在任何系统上验 Windows 的行为。
 */
import path from "node:path";

/** target 是否落在 base 目录里面(不含 base 本身) */
export function isInside(base, target, p = path) {
  const rel = p.relative(base, target);
  if (!rel || p.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + p.sep);
}

/**
 * 把编排里的站内地址(/_media/a.mp4?v=123)解析成 public/ 下的磁盘路径;
 * 解码失败或跳出 public/ 返回 null。
 */
export function resolvePublic(publicDir, src) {
  let rel;
  try {
    rel = decodeURIComponent(String(src ?? "").split("?")[0]).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!rel) return null;
  const file = path.resolve(publicDir, rel);
  return isInside(publicDir, file) ? file : null;
}
