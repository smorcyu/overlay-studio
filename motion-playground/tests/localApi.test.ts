import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crossSiteReason, revealCommand, revealTarget } from "../scripts/local-api.mjs";

test("crossSiteReason: Studio's own page and non-browser callers pass; other websites are refused", () => {
  const host = "localhost:5177";
  assert.equal(crossSiteReason({ host, "sec-fetch-site": "same-origin", origin: "http://localhost:5177" }), null);
  assert.equal(crossSiteReason({ host, "sec-fetch-site": "none" }), null); // 地址栏直接打开
  assert.equal(crossSiteReason({ host }), null); // curl
  assert.equal(crossSiteReason({ host: "127.0.0.1:5177", origin: "http://127.0.0.1:5177" }), null);
  assert.match(crossSiteReason({ host, "sec-fetch-site": "cross-site", origin: "https://evil.example" })!, /其他网站/);
  // localhost 别的端口上的页面:浏览器报 same-site,也拒
  assert.match(crossSiteReason({ host, "sec-fetch-site": "same-site", origin: "http://localhost:3000" })!, /same-site/);
  // 老浏览器没有 Sec-Fetch-Site:靠 Origin 兜
  assert.match(crossSiteReason({ host, origin: "https://evil.example" })!, /Origin/);
  assert.match(crossSiteReason({ host, origin: "http://localhost:3000" })!, /Origin/);
  assert.match(crossSiteReason({ host, origin: "null" })!, /null/); // 沙箱 iframe、file:// 页面
  assert.match(crossSiteReason({ host, origin: "not a url" })!, /不合法/);
});

test("revealTarget: only existing paths inside exports/, by real path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reveal-"));
  try {
    fs.mkdirSync(path.join(root, "exports", "output"), { recursive: true });
    const mp4 = path.join(root, "exports", "output", "a.mp4");
    fs.writeFileSync(mp4, "x");
    const outside = path.join(root, "secret.txt");
    fs.writeFileSync(outside, "x");
    fs.symlinkSync(outside, path.join(root, "exports", "link.txt"));

    assert.deepEqual(revealTarget(root, mp4), { path: fs.realpathSync(mp4), isDir: false });
    assert.equal(revealTarget(root, path.join(root, "exports", "output"))!.isDir, true);
    assert.equal(revealTarget(root, path.join(root, "exports"))!.isDir, true);
    assert.equal(revealTarget(root, outside), null);
    assert.equal(revealTarget(root, path.join(root, "exports", "..", "secret.txt")), null);
    assert.equal(revealTarget(root, path.join(root, "exports", "link.txt")), null, "symlink pointing outside");
    assert.equal(revealTarget(root, path.join(root, "exports", "output", "nope.mp4")), null);
    assert.equal(revealTarget(root, "exports/output/a.mp4"), null, "relative paths");
    assert.equal(revealTarget(root, 42), null);
    assert.equal(revealTarget(root, ""), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("revealCommand: per-platform command, path passed as its own argument", () => {
  assert.deepEqual(revealCommand("darwin", "/o/a b.mp4", false), { cmd: "open", args: ["-R", "/o/a b.mp4"] });
  // 「📂 打开文件夹」在 Mac 上要真的打开 exports/output,不是在上一级里选中它
  assert.deepEqual(revealCommand("darwin", "/o/exports/output", true), { cmd: "open", args: ["/o/exports/output"] });
  // 程序包样子的文件夹只选中,不打开(打开会启动它)
  assert.deepEqual(revealCommand("darwin", "/o/x.app", true), { cmd: "open", args: ["-R", "/o/x.app"] });
  assert.deepEqual(revealCommand("darwin", "/o/Y.Bundle", true), { cmd: "open", args: ["-R", "/o/Y.Bundle"] });
  assert.deepEqual(revealCommand("win32", "C:\\o\\a.mp4", false), { cmd: "explorer", args: ["/select,C:\\o\\a.mp4"] });
  assert.deepEqual(revealCommand("win32", "C:\\o", true), { cmd: "explorer", args: ["C:\\o"] });
  assert.deepEqual(revealCommand("linux", "/o/a.mp4", false), { cmd: "xdg-open", args: ["/o"] });
  assert.deepEqual(revealCommand("linux", "/o", true), { cmd: "xdg-open", args: ["/o"] });
});
