/**
 * 本机语音识别(whisper.cpp)→ SRT 字幕稿。给开发服务器的 /api/transcribe 用(vite.config.ts),
 * 单测见 tests/whisper.test.ts。什么都在本机跑,口播音频不出这台电脑。
 *
 * 要两样东西:
 *   - whisper.cpp 的命令行 whisper-cli(macOS: brew install whisper-cpp;Windows: 从 whisper.cpp 的 Releases 下载)。
 *     不在 PATH 里的话用环境变量 OVS_WHISPER_BIN 指过去;
 *   - 模型文件:npm run whisper:model 下到 motion-playground/models/(见 whisper-model.mjs),
 *     或者用 OVS_WHISPER_MODEL 指向自己下好的 ggml-*.bin。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * 能用的模型(Hugging Face 上 whisper.cpp 官方转好的 ggml 文件)。sha256 / size 是那边公布的
 * (x-linked-etag / x-linked-size),下载完按它校验。越往前越准、越大越慢;找模型时按这个顺序挑第一个有的
 */
export const MODELS = {
  turbo: {
    file: "ggml-large-v3-turbo.bin",
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    size: 1624555275,
    note: "最准(中文推荐),1.6GB;Apple 芯片的 Mac 上很快",
  },
  small: {
    file: "ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    size: 487601967,
    note: "折中,490MB",
  },
  base: {
    file: "ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    size: 147951465,
    note: "最小最快,150MB;中文错字多,试用可以",
  },
};

export const MODEL_DIR = "models";

/** 在 PATH 里找一个命令(Windows 加 .exe)。找不到返回 null。不执行它 */
export function whichBin(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const d of dirs)
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* 没有 */
      }
    }
  return null;
}

/** whisper.cpp 的命令行在哪:OVS_WHISPER_BIN 优先,然后 PATH 里的 whisper-cli(新名字)/ whisper-cpp(Homebrew 旧名字) */
export function findWhisperBin(env = process.env, platform = process.platform) {
  if (env.OVS_WHISPER_BIN) return fs.existsSync(env.OVS_WHISPER_BIN) ? env.OVS_WHISPER_BIN : null;
  return whichBin("whisper-cli", env, platform) ?? whichBin("whisper-cpp", env, platform);
}

/** 用哪个模型:OVS_WHISPER_MODEL 优先,然后 models/ 里按 MODELS 的顺序挑第一个有的 */
export function findModel(root, env = process.env) {
  if (env.OVS_WHISPER_MODEL) return fs.existsSync(env.OVS_WHISPER_MODEL) ? env.OVS_WHISPER_MODEL : null;
  for (const m of Object.values(MODELS)) {
    const p = path.join(root, MODEL_DIR, m.file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 识别语言:界面上的三个选项。zh 时加一句简体提示词 —— 不加的话 whisper 常常给出繁体字 */
export const LANGS = ["zh", "en", "auto"];
const ZH_PROMPT = "以下是普通话的句子。";

/**
 * whisper-cli 的参数。-ml 1:每个词(中文常常是一两个字)一条、各带精确时间,再由 regroupPieces
 * 按标点拼成字幕条。不直接用 -ml 20:它只按字数硬切,会把「视频」切成「视 / 频」;
 * 加 -sow(只在空格处切)的话中文没有空格,一整段几十秒都不切
 */
export function whisperArgs({ model, wav, outBase, lang = "zh", threads = 4 }) {
  const l = LANGS.includes(lang) ? lang : "zh";
  return [
    "-m", model, "-f", wav, "-l", l, "-t", String(threads),
    "-osrt", "-of", outBase, "-pp", "-ml", "1",
    ...(l === "zh" ? ["--prompt", ZH_PROMPT] : []),
  ];
}

const srtTime = (s) => {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0").slice(0, 3)) / 1000 : NaN;
};

/** 读 whisper 的 SRT:每条 { start, end, text }(秒)。text 保留原样(英文词前面的空格要留着拼) */
export function parseSrtPieces(srt) {
  const out = [];
  for (const block of String(srt).replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = srtTime(a);
    const end = srtTime(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ start, end, text: lines.slice(i + 1).join("\n").replace(/\n+$/, "") });
  }
  return out;
}

const STRONG = /[。!?!?…]$/;
const WEAK = /[,,、;;::]$/;
const PUNCT_ONLY = /^[\s\p{P}]+$/u;

/**
 * 把一个个词拼成字幕条:句号问号处一定断;逗号处够长了(中文 6 字、英文 16 个字母)才断;
 * 逗号前面只有语气词(「嗯,」「那个,」,isFiller 判断,和剪切建议同一套)也断 —— 单独一条,
 * 剪切建议才能把它找出来;太长(中文 18 字、英文 42)就在词和词之间硬断(英文只在空格处断,不拆单词)。
 * 中文还是英文看整段里有没有汉字/假名(「自动」识别时也对)
 */
export function regroupPieces(pieces, { isFiller = () => false } = {}) {
  const cjk = /[぀-ヿ一-鿿]/.test(pieces.map((p) => p.text).join(""));
  const MAX = cjk ? 18 : 42;
  const MIN = cjk ? 6 : 16;
  const len = (s) => (cjk ? s.replace(/\s/g, "").length : s.trim().length);
  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) lines.push({ start: cur.start, end: cur.end, text: cur.text.trim() });
    cur = null;
  };
  for (const p of pieces) {
    if (!p.text.trim()) continue;
    // 一行开头的标点(上一行刚断开)挂回上一行末尾
    if (!cur && PUNCT_ONLY.test(p.text) && lines.length) {
      const last = lines[lines.length - 1];
      last.text += p.text.trim();
      last.end = p.end;
      continue;
    }
    // 标点永远不当一行的开头(句号会紧跟在上一行后面,哪怕超出一个字)
    const boundary = (cjk || /^\s/.test(p.text)) && !PUNCT_ONLY.test(p.text);
    if (cur && boundary && len(cur.text + p.text) > MAX) flush();
    if (!cur) cur = { start: p.start, end: p.end, text: "" };
    cur.text += p.text;
    cur.end = p.end;
    const t = cur.text.trim();
    if (STRONG.test(t) || (WEAK.test(t) && (len(t) >= MIN || isFiller(t)))) flush();
  }
  flush();
  return lines;
}

const fmtSrtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** 字幕条 → SRT 文字 */
export function toSrt(lines) {
  return lines.map((l, i) => `${i + 1}\n${fmtSrtTime(l.start)} --> ${fmtSrtTime(l.end)}\n${l.text}\n`).join("\n");
}

/** 从 whisper-cli 的输出里读最新的进度(-pp 打的「progress = 37%」)。没有就是 null */
export function parseProgress(text) {
  const all = [...String(text).matchAll(/progress\s*=\s*(\d+)%/g)];
  return all.length ? Math.min(100, Number(all[all.length - 1][1])) : null;
}

/** 缺东西时给用户看的话(界面直接显示) */
export function setupHint({ bin, model, platform = process.platform }) {
  if (!bin)
    return platform === "darwin"
      ? "本机没装 whisper.cpp:在终端运行 brew install whisper-cpp,装好后重启 npm run dev"
      : "本机没装 whisper.cpp:从 https://github.com/ggml-org/whisper.cpp/releases 下载 whisper-cli,放进 PATH(或用 OVS_WHISPER_BIN 指过去),然后重启 npm run dev";
  if (!model) return "还没有识别模型:在 motion-playground 目录里运行 npm run whisper:model(下载约 1.6GB,只要一次)";
  return null;
}

/**
 * 跑一次识别:ffmpeg 抽 16kHz 单声道 WAV → whisper-cli → 读 SRT。临时文件放系统临时目录,跑完删掉。
 * 返回 { done: Promise<{ok, srt} | {ok:false, error}>, kill() }。onProgress(0–100) 边跑边报;
 * isFiller:判断一段是不是只有语气词(剪切建议的 isFillerLine),拼字幕条时让它单独成一条
 */
export function transcribe({
  file, bin, model, lang, onProgress = () => {}, isFiller, threads = Math.max(1, Math.min(8, os.cpus().length)),
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ovs-whisper-"));
  const wav = path.join(tmp, "audio.wav");
  const outBase = path.join(tmp, "out");
  let child = null;
  let killed = false;
  const run = (cmd, args, onErr) =>
    new Promise((resolve) => {
      let tail = "";
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (d) => {
        tail = (tail + d).slice(-4000);
        onErr?.(tail);
      });
      child.on("error", (e) => resolve({ code: -1, tail: String(e) }));
      child.on("close", (code) => resolve({ code, tail }));
    });
  const done = (async () => {
    try {
      const a = await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
      if (killed) return { ok: false, error: "已取消" };
      if (a.code !== 0) return { ok: false, error: a.code === -1 ? "本机没装 ffmpeg" : "读不到音轨(这段素材可能没有声音)" };
      onProgress(0);
      let last = -1;
      const w = await run(bin, whisperArgs({ model, wav, outBase, lang, threads }), (t) => {
        const p = parseProgress(t);
        if (p !== null && p !== last) onProgress((last = p));
      });
      if (killed) return { ok: false, error: "已取消" };
      if (w.code !== 0)
        return { ok: false, error: `识别失败:${w.tail.trim().split("\n").filter(Boolean).pop() ?? `退出码 ${w.code}`}` };
      const pieces = parseSrtPieces(fs.readFileSync(`${outBase}.srt`, "utf8"));
      return { ok: true, srt: toSrt(regroupPieces(pieces, { isFiller })) };
    } catch (e) {
      return { ok: false, error: `识别失败:${e}` };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  return {
    done,
    kill: () => {
      killed = true;
      child?.kill("SIGKILL");
    },
  };
}
