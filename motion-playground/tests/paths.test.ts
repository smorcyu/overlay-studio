import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isInside, resolvePublic } from "../scripts/paths.mjs";

test("isInside on POSIX paths", () => {
  const base = "/proj/public";
  assert.equal(isInside(base, "/proj/public/_media/a.mp4"), true);
  assert.equal(isInside(base, "/proj/public/..intro.mp4"), true); // 文件名以两个点开头是合法的
  assert.equal(isInside(base, "/proj/public"), false); // 目录本身不算
  assert.equal(isInside(base, "/proj/package.json"), false);
  assert.equal(isInside(base, "/proj/public-other/a.mp4"), false);
  assert.equal(isInside(base, "/etc/passwd"), false);
});

test("isInside on Windows paths, including another drive", () => {
  const w = path.win32;
  const base = "C:\\proj\\public";
  assert.equal(isInside(base, "C:\\proj\\public\\_media\\a.mp4", w), true);
  assert.equal(isInside(base, "C:\\proj\\public\\..intro.mp4", w), true);
  assert.equal(isInside(base, "C:\\proj\\package.json", w), false);
  // 换盘符:path.relative 给回的是绝对路径 D:\x.mp4,不是「..」开头 —— 旧检查就是在这儿被绕过的
  assert.equal(w.relative(base, "D:\\x.mp4"), "D:\\x.mp4");
  assert.equal(isInside(base, "D:\\x.mp4", w), false);
});

test("resolvePublic: site paths map inside public/, escapes and bad encodings are refused", () => {
  const pub = path.resolve("/proj/public");
  assert.equal(resolvePublic(pub, "/_media/a.mp4?v=123"), path.join(pub, "_media", "a.mp4"));
  assert.equal(resolvePublic(pub, "/_media/%E4%B8%AD.mp4"), path.join(pub, "_media", "中.mp4"));
  assert.equal(resolvePublic(pub, "/../package.json"), null);
  assert.equal(resolvePublic(pub, "/_media/%2e%2e/%2e%2e/package.json"), null);
  assert.equal(resolvePublic(pub, "/_media/%E4"), null); // 解码失败
  assert.equal(resolvePublic(pub, ""), null);
  assert.equal(resolvePublic(pub, undefined), null);
});
