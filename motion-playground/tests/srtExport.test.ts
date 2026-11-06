import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSrt, parseSrt } from "../src/overlay/srt.ts";
import { nameFromVideo } from "../src/app/download.ts";

test("formatSrt writes standard SRT that parseSrt reads back", () => {
  const lines = [
    { start: 0.14, end: 5.04, text: "大家好,今天我们来讲一个东西。" },
    { start: 5.04, end: 5.52, text: "嗯," },
    { start: 3725.0074, end: 3726.9996, text: "第二行\n\n不能断块" },
  ];
  const out = formatSrt(lines);
  assert.equal(
    out,
    "1\n00:00:00,140 --> 00:00:05,040\n大家好,今天我们来讲一个东西。\n\n" +
      "2\n00:00:05,040 --> 00:00:05,520\n嗯,\n\n" +
      "3\n01:02:05,007 --> 01:02:07,000\n第二行 不能断块\n",
  );
  assert.deepEqual(
    parseSrt(out).map((l) => [l.start, l.end, l.text]),
    [[0.14, 5.04, "大家好,今天我们来讲一个东西。"], [5.04, 5.52, "嗯,"], [3725.007, 3727, "第二行 不能断块"]],
  );
  assert.equal(formatSrt([]), "");
  // 进位:分、时
  assert.ok(formatSrt([{ start: 59.9995, end: 3599.9995, text: "x" }]).includes("00:01:00,000 --> 01:00:00,000"));
});

test("nameFromVideo names the file after the talking-head video", () => {
  assert.equal(nameFromVideo("/_media/%E5%8F%A3%E6%92%AD-%E7%AC%AC3%E6%9C%9F.mp4", "srt", "字幕稿.srt"), "口播-第3期.srt");
  assert.equal(nameFromVideo("/_media/a.b.mov?v=2", "srt", "x.srt"), "a.b.srt");
  assert.equal(nameFromVideo("blob:http://localhost/123", "srt", "字幕稿.srt"), "字幕稿.srt");
  assert.equal(nameFromVideo(null, "srt", "字幕稿.srt"), "字幕稿.srt");
  assert.equal(nameFromVideo("/_media/50%off.mp4", "srt", "字幕稿.srt"), "字幕稿.srt"); // 解码失败
  assert.equal(nameFromVideo("/_media/.mp4", "srt", "字幕稿.srt"), "字幕稿.srt");
});
