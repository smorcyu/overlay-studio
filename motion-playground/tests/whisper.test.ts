import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODELS, findModel, findWhisperBin, parseProgress, parseSrtPieces, regroupPieces, setupHint, toSrt, whichBin, whisperArgs,
} from "../scripts/whisper.mjs";
import { isFillerLine } from "../src/overlay/fillers.ts";

test("whisperArgs: SRT out, progress on, one word per entry; Chinese gets the simplified-Chinese prompt", () => {
  const zh = whisperArgs({ model: "m.bin", wav: "a.wav", outBase: "/t/out", lang: "zh", threads: 6 });
  assert.deepEqual(zh.slice(0, 8), ["-m", "m.bin", "-f", "a.wav", "-l", "zh", "-t", "6"]);
  assert.ok(zh.includes("-osrt") && zh.includes("-pp"));
  assert.ok(!zh.includes("-sow"), "-sow stops Chinese from splitting at all");
  assert.equal(zh[zh.indexOf("-of") + 1], "/t/out");
  assert.equal(zh[zh.indexOf("-ml") + 1], "1");
  assert.equal(zh[zh.indexOf("--prompt") + 1], "以下是普通话的句子。");
  const en = whisperArgs({ model: "m", wav: "a", outBase: "o", lang: "en" });
  assert.ok(!en.includes("--prompt"));
  assert.ok(!whisperArgs({ model: "m", wav: "a", outBase: "o", lang: "auto" }).includes("--prompt"));
  // 不认识的语言按中文(参数直接进命令行,不能原样透传)
  const bad = whisperArgs({ model: "m", wav: "a", outBase: "o", lang: "zh; rm -rf /" });
  assert.equal(bad[bad.indexOf("-l") + 1], "zh");
});

// whisper-cli -ml 1 的真实输出(base 模型,一段中文测试语音 / whisper.cpp 自带的 jfk.wav)
const ZH: [number, number, string][] = [[0,0.14,""],[0.14,1.6,"大家好"],[1.6,1.74,","],[1.74,2.2,"今天"],[2.2,2.68,"我们"],[2.68,2.89,"来"],[2.89,3.12,"讲"],[3.12,3.57,"一个"],[3.57,3.8,"东"],[3.8,4.29,"西"],[4.29,5.04,"。"],[5.04,5.12,"嗯"],[5.12,5.52,","],[5.52,6.25,"那个"],[6.25,6.48,","],[6.48,6.97,"就是"],[6.97,7.51,"怎么"],[7.51,7.68,"给"],[7.68,7.92,"口"],[7.92,8.16,"播"],[8.16,8.4,"视"],[8.4,8.64,"频"],[8.64,8.88,"加"],[8.88,9.12,"动"],[9.12,9.36,"效"],[9.36,10.33,"。"],[10.33,10.65,"第一"],[10.65,10.91,"步"],[10.91,11.65,","],[11.65,11.7,"先"],[11.7,11.96,"把"],[11.96,12.22,"视"],[12.22,12.48,"频"],[12.48,12.74,"倒"],[12.74,13,"进"],[13,13.26,"来"],[13.26,14.09,","],[14.09,14.32,"第二"],[14.32,14.59,"步"],[14.59,15.35,","],[15.35,15.37,"让"],[15.37,15.9,"AI"],[15.9,16.21,"排"],[16.21,16.47,"好"],[16.47,16.69,"卡"],[16.69,17.05,"片"],[17.05,17.88,"。"]];
const EN: [number, number, string][] = [[0,0.32,""],[0.32,0.37," And"],[0.37,0.69," so"],[0.69,0.86,","],[0.86,1.11," my"],[1.11,1.85," fellow"],[1.85,3.29," Americans"],[3.29,3.49,","],[3.49,4.24," ask"],[4.24,5.03," not"],[5.03,5.41," what"],[5.41,5.74," your"],[5.74,6.39," country"],[6.39,6.64," can"],[6.64,7.01," do"],[7.01,7.27," for"],[7.27,7.49," you"],[7.49,8,","],[8,8.34," ask"],[8.34,8.72," what"],[8.72,9.03," you"],[9.03,9.37," can"],[9.37,9.54," do"],[9.54,9.85," for"],[9.85,10.1," your"],[10.1,11," country"],[11,11,"."]];
const pieces = (a: [number, number, string][]) => a.map(([start, end, text]) => ({ start, end, text }));

test("regroupPieces (Chinese): break at 。, at a comma once long enough, and fillers get their own line", () => {
  const lines = regroupPieces(pieces(ZH), { isFiller: isFillerLine });
  assert.deepEqual(lines.map((l) => l.text), [
    "大家好,今天我们来讲一个东西。",
    "嗯,",
    "那个,",
    "就是怎么给口播视频加动效。",
    "第一步,先把视频倒进来,",
    "第二步,让AI排好卡片。",
  ]);
  // 时间:第一个有字的词开头 → 最后一个词结尾
  assert.deepEqual([lines[0].start, lines[0].end], [0.14, 5.04]);
  assert.deepEqual([lines[1].start, lines[1].end], [5.04, 5.52]);
  // 拆出来的语气词条,剪切建议认得出来
  assert.ok(isFillerLine(lines[1].text) && isFillerLine(lines[2].text));
  // 不传 isFiller:语气词留在句子里
  assert.equal(regroupPieces(pieces(ZH))[1].text, "嗯,那个,就是怎么给口播视频加动效。");
});

test("regroupPieces: long lines break between words, never inside an English word; leading punctuation goes back to the previous line", () => {
  const en = regroupPieces(pieces(EN), { isFiller: isFillerLine });
  assert.deepEqual(en.map((l) => l.text), [
    "And so, my fellow Americans,",
    "ask not what your country can do for you,",
    "ask what you can do for your country.",
  ]);
  assert.ok(en.every((l) => l.text.length <= 42));
  // 中文硬上限 18 字
  const long = regroupPieces(pieces(Array.from({ length: 30 }, (_, i) => [i, i + 1, "字"] as [number, number, string])));
  assert.deepEqual(long.map((l) => l.text.length), [18, 12]);
  assert.deepEqual([long[1].start, long[1].end], [18, 30]);
  // 刚断完一行就来一个标点:挂回上一行
  const p = regroupPieces(pieces([[0, 1, "很长很长很长很长很长很长很长很长很长"], [1, 1.2, "。"], [1.2, 2, "下一句"]]));
  assert.deepEqual(p.map((l) => l.text), ["很长很长很长很长很长很长很长很长很长。", "下一句"]);
  assert.equal(p[0].end, 1.2);
});

test("regroupPieces: English full stops end a line, decimals don't; English words inside Chinese aren't split; punctuation-only output is dropped", () => {
  const en = regroupPieces(pieces([[0, 1, " This"], [1, 2, " is"], [2, 3, " one"], [3, 3.1, "."], [3.1, 4, " Here"], [4, 5, " is"], [5, 6, " 3"], [6, 6.1, "."], [6.1, 7, "5"], [7, 7.1, "."]]));
  assert.deepEqual(en.map((l) => l.text), ["This is one.", "Here is 3.5."]);
  // 16 个汉字后面跟一个被拆成两个 token 的英文词:不在 Java|Script 中间断
  const mixed = regroupPieces(pieces([[0, 1, "我们今天来讲一个很好用的工具叫做"], [1, 2, "Java"], [2, 3, "Script"], [3, 4, "写代码"]]));
  assert.ok(mixed.every((l) => !l.text.startsWith("Script")), JSON.stringify(mixed));
  assert.ok(mixed.some((l) => l.text.includes("JavaScript")));
  // 小数点中间夹一个空 token;缩写后面的点不断句
  const en2 = regroupPieces(pieces([[0, 1, " Here"], [1, 2, " is"], [2, 3, " 3"], [3, 3.1, "."], [3.1, 3.2, ""], [3.2, 4, "5"], [4, 4.1, "."], [5, 6, " Mr"], [6, 6.1, "."], [6.1, 7, " Smith"], [7, 8, " came"], [8, 8.1, "."]]));
  assert.deepEqual(en2.map((l) => l.text), ["Here is 3.5.", "Mr. Smith came."]);
  // 中文里一行快满了也不在 3.|5、Node.|js 中间硬断
  const num = regroupPieces(pieces([[0, 1, "这个版本的性能比上一个版本提升了"], [1, 2, "3"], [2, 3, "."], [3, 4, "5"], [4, 5, "倍。"]]));
  assert.ok(num.some((l) => l.text.includes("3.5")), JSON.stringify(num));
  const node = regroupPieces(pieces([[0, 1, "我们今天来讲一个很好用的工具叫做"], [1, 2, "Node"], [2, 3, "."], [3, 4, "js"], [4, 5, "。"]]));
  assert.ok(node.some((l) => l.text.includes("Node.js")), JSON.stringify(node));
  assert.deepEqual(regroupPieces(pieces([[0, 1, "。"], [1, 2, "!"]])), []);
  assert.deepEqual(regroupPieces([]), []);
});

test("setupHint asks for ffmpeg first (it extracts the audio)", () => {
  assert.match(setupHint({ bin: "b", model: "m", ffmpeg: false, platform: "darwin" })!, /brew install ffmpeg/);
  assert.equal(setupHint({ bin: "b", model: "m", ffmpeg: true }), null);
});

test("parseSrtPieces + toSrt round-trip", () => {
  const srt = "1\n00:00:00,000 --> 00:00:00,140\n\n\n2\r\n00:00:00,140 --> 00:00:01,600\r\n大家好\r\n";
  assert.deepEqual(parseSrtPieces(srt).map((x) => [x.start, x.end, x.text]), [[0, 0.14, ""], [0.14, 1.6, "大家好"]]);
  const out = toSrt([{ start: 0.14, end: 61.5, text: "大家好" }, { start: 3725.007, end: 3726, text: "b" }]);
  assert.equal(out, "1\n00:00:00,140 --> 00:01:01,500\n大家好\n\n2\n01:02:05,007 --> 01:02:06,000\nb\n");
  assert.deepEqual(parseSrtPieces(out).map((x) => x.text), ["大家好", "b"]);
});

test("parseProgress reads the latest -pp progress line", () => {
  assert.equal(parseProgress("whisper_print_progress_callback: progress =  5%\n...progress = 40%\n"), 40);
  assert.equal(parseProgress("progress = 100%"), 100);
  assert.equal(parseProgress("loading model"), null);
});

test("findModel / findWhisperBin: env overrides first, then models/ in quality order, then PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-"));
  try {
    assert.equal(findModel(root, {}), null);
    fs.mkdirSync(path.join(root, "models"));
    fs.writeFileSync(path.join(root, "models", MODELS.base.file), "x");
    assert.equal(findModel(root, {}), path.join(root, "models", MODELS.base.file));
    fs.writeFileSync(path.join(root, "models", MODELS.turbo.file), "x");
    assert.equal(findModel(root, {}), path.join(root, "models", MODELS.turbo.file), "best model wins");
    assert.equal(findModel(root, { OVS_WHISPER_MODEL: path.join(root, "nope.bin") }), null);

    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    assert.equal(findWhisperBin({ PATH: bin }, "linux"), null);
    fs.writeFileSync(path.join(bin, "whisper-cpp"), "");
    assert.equal(findWhisperBin({ PATH: bin }, "linux"), path.join(bin, "whisper-cpp"), "Homebrew's old name");
    fs.writeFileSync(path.join(bin, "whisper-cli"), "");
    assert.equal(findWhisperBin({ PATH: `/nowhere:${bin}` }, "linux"), path.join(bin, "whisper-cli"));
    assert.equal(findWhisperBin({ PATH: bin, OVS_WHISPER_BIN: "/nowhere/x" }, "linux"), null);
    fs.writeFileSync(path.join(bin, "whisper-cli.exe"), "");
    assert.equal(whichBin("whisper-cli", { Path: bin }, "win32"), path.join(bin, "whisper-cli.exe"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setupHint says what's missing, per platform", () => {
  assert.match(setupHint({ bin: null, model: null, platform: "darwin" })!, /brew install whisper-cpp/);
  assert.match(setupHint({ bin: null, model: "m", platform: "win32" })!, /releases/);
  assert.match(setupHint({ bin: "b", model: null })!, /npm run whisper:model/);
  assert.equal(setupHint({ bin: "b", model: "m" }), null);
});

test("pinned model hashes look like sha256", () => {
  for (const m of Object.values(MODELS)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.size > 1e8);
  }
});
