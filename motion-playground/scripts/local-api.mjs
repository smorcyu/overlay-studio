/**
 * 开发服务器上 /api/* 接口的公共守卫和「在文件夹中显示」。纯函数,单测见 tests/localApi.test.ts。
 *
 * 开发服务器只听本机(vite.config.ts 里 host: "localhost"),但「只听本机」挡不住你开着 Studio 时
 * 逛的别的网页:它们能从浏览器里往 localhost:5177 发 POST(起导出、往 public/ 里写文件、开文件夹)。
 * 浏览器会带上 Sec-Fetch-Site / Origin,见到不是 Studio 自己发的就拒。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 这个请求是不是别的网站发来的。是 → 返回拒绝原因;不是 → null。
 *   - Sec-Fetch-Site:只认 same-origin(Studio 自己的页面)和 none(地址栏直接打开)。
 *     same-site 也拒:localhost 别的端口上跑的页面算 same-site。
 *   - Origin(老浏览器没有 Sec-Fetch-Site 时兜底):有的话必须和 Host 是同一个。
 *   - 两个头都没有(curl 之类非浏览器)放行:能在本机跑命令的人本来就能直接动这些文件。
 */
export function crossSiteReason(headers) {
  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return `不接受其他网站的请求(Sec-Fetch-Site: ${site})`;
  const origin = headers.origin;
  if (origin && origin !== "null") {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return "不接受其他网站的请求(Origin 不合法)";
    }
    if (host !== headers.host) return `不接受其他网站的请求(Origin: ${origin})`;
  } else if (origin === "null") {
    return "不接受其他网站的请求(Origin: null)";
  }
  return null;
}

/** p 在不在 dir 里面(含 dir 本身)。两个都要是已经 realpath 过的绝对路径 */
function inside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 「在文件夹中显示」能显示哪个路径:只认 exports/ 里面已经存在的文件或文件夹(导出的成品和 PNG 目录都在那儿)。
 * 按真实路径(realpath)判断,符号链接指到外面的也拒。不行返回 null
 */
export function revealTarget(root, p) {
  if (typeof p !== "string" || !p || !path.isAbsolute(p)) return null;
  let exportsDir, real;
  try {
    exportsDir = fs.realpathSync(path.join(root, "exports"));
    real = fs.realpathSync(p);
  } catch {
    return null; // 不存在
  }
  if (!inside(exportsDir, real)) return null;
  return { path: real, isDir: fs.statSync(real).isDirectory() };
}

/**
 * 各系统「在文件夹中显示」的命令(不经过 shell,路径作为单独的参数传,不怕空格和引号):
 *   macOS:文件夹直接打开,文件在 Finder 里选中(open -R);
 *   Windows:文件夹直接打开,文件在资源管理器里选中(explorer /select,);
 *   其他(Linux):xdg-open 打开文件夹(文件就打开它所在的文件夹)。
 */
export function revealCommand(platform, target, isDir) {
  if (platform === "darwin") return { cmd: "open", args: isDir ? [target] : ["-R", target] };
  if (platform === "win32") return { cmd: "explorer", args: isDir ? [target] : [`/select,${target}`] };
  return { cmd: "xdg-open", args: [isDir ? target : path.dirname(target)] };
}
