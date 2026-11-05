/** 别的网站发来的请求 → 拒绝原因;Studio 自己发的(或非浏览器)→ null。见 local-api.mjs */
export function crossSiteReason(headers: Record<string, string | string[] | undefined>): string | null;
/** 「在文件夹中显示」能显示的路径:只认 exports/ 里已经存在的(按真实路径);不行返回 null */
export function revealTarget(root: string, p: unknown): { path: string; isDir: boolean } | null;
/** 各系统「在文件夹中显示」的命令(不经过 shell) */
export function revealCommand(platform: string, target: string, isDir: boolean): { cmd: string; args: string[] };
