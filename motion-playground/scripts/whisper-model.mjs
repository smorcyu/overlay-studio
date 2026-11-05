#!/usr/bin/env node
/**
 * 下载语音识别模型到 motion-playground/models/(只要一次):
 *   npm run whisper:model            → turbo(最准,中文推荐,1.6GB)
 *   npm run whisper:model -- small   → 490MB
 *   npm run whisper:model -- base    → 150MB(最小,中文错字多)
 * 从 Hugging Face 上 whisper.cpp 官方的仓库下;下完按公布的 sha256 校验,对不上就删掉、不用。
 * 先写 .part,校验过了才改名:下到一半断了不会留下一个「看着在、其实是坏的」模型
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MODELS, MODEL_DIR } from "./whisper.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2] ?? "turbo";
const m = MODELS[name];
if (!m) {
  console.error(`不认识的模型「${name}」。可选:${Object.keys(MODELS).join(" / ")}`);
  process.exit(1);
}
const dir = path.join(ROOT, MODEL_DIR);
const dest = path.join(dir, m.file);
fs.mkdirSync(dir, { recursive: true });

const sha256Of = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

if (fs.existsSync(dest)) {
  process.stdout.write(`${m.file} 已经在了,校验中…`);
  if ((await sha256Of(dest)) === m.sha256) {
    console.log(" 没问题,不用再下");
    process.exit(0);
  }
  console.log(" 文件坏了,重新下载");
  fs.rmSync(dest);
}

const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`;
console.log(`下载 ${m.file}(${(m.size / 1024 ** 3).toFixed(2)}GB,${m.note})\n  ${url}`);
const part = `${dest}.part`;
const res = await fetch(url);
if (!res.ok || !res.body) {
  console.error(`下载失败:HTTP ${res.status}。网络不通的话,可以手动下载上面这个地址,放到 ${dir}`);
  process.exit(1);
}
const out = fs.createWriteStream(part);
// 写盘出错(多半是盘满了):不挂监听的话 Node 直接崩、留下一个半截的 .part;
// 正在等 drain 的话那个等待永远不结束。记下来,下面的循环一看到就停
let writeErr = null;
out.on("error", (e) => (writeErr = e));
const hash = crypto.createHash("sha256");
let got = 0;
let lastPct = -1;
try {
  for await (const chunk of res.body) {
    if (writeErr) throw writeErr;
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk))
      await new Promise((resolve, reject) => {
        out.once("drain", resolve);
        out.once("error", reject);
      });
    const pct = Math.floor((got / m.size) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      process.stdout.write(`\r  ${pct}%  ${(got / 1024 ** 2).toFixed(0)}MB`);
    }
  }
  await new Promise((resolve, reject) => {
    out.once("error", reject);
    out.end(resolve);
  });
  if (writeErr) throw writeErr;
} catch (e) {
  out.destroy();
  fs.rmSync(part, { force: true });
  console.error(`\n下载中断:${e}。重新运行这条命令即可`);
  process.exit(1);
}
const digest = hash.digest("hex");
if (digest !== m.sha256) {
  fs.rmSync(part, { force: true });
  console.error(`\n校验失败(sha256 对不上),已删除。重新运行这条命令;一直这样的话,网络可能被劫持了`);
  process.exit(1);
}
fs.renameSync(part, dest);
console.log(`\n✓ 已下载并校验:${dest}\n  重启 npm run dev 后,左栏「字幕稿」里的「🎙 自动识别」就能用了`);
