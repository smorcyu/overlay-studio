import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sfxPointsFor } from "../scripts/export-sfx.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const card = (id: string, kind: string, start: number, params: Record<string, unknown> = {}) => ({ id, kind, start, end: start + 2, params });

test("sfxPointsFor: sound per card kind, per-card override, 'none' and the subtitle layer stay silent, sorted by time", () => {
  const doc = {
    cards: [
      card("c", "stat-proof", 6),
      card("a", "chapter-bar", 0),
      card("b", "punch-pill", 1), // 没在表里:默认音效
      card("d", "caption-track", 0), // 字幕层:不配音效
      card("e", "stat-proof", 3, { sfx: "none" }), // 这张关了
      card("f", "punch-pill", 4, { sfx: "whoosh" }), // 这张手动换了
    ],
  };
  const pts = sfxPointsFor(doc, ROOT);
  assert.deepEqual(pts.map((p: { t: number; kind: string; sfx: string }) => [p.t, p.kind, p.sfx]), [
    [0, "chapter-bar", "chime"],
    [1, "punch-pill", "pop-light"],
    [4, "punch-pill", "whoosh"],
    [6, "stat-proof", "rise"],
  ]);
  // 自己没放 public/sfx/ 时用随仓库附带的默认音效
  for (const p of pts) assert.ok(p.file.endsWith(`${p.sfx}.mp3`));
  // 不存在的音效名:跳过这张,不报错
  assert.deepEqual(sfxPointsFor({ cards: [card("x", "punch-pill", 1, { sfx: "no-such-sound" })] }, ROOT), []);
  assert.deepEqual(sfxPointsFor(null, ROOT), []);
});
