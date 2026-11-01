import type path from "node:path";

/** target 是否落在 base 目录里面(不含 base 本身);见 paths.mjs */
export function isInside(base: string, target: string, p?: typeof path): boolean;
/** 站内地址 → public/ 下的磁盘路径;跳出 public/ 或解码失败返回 null */
export function resolvePublic(publicDir: string, src: unknown): string | null;
