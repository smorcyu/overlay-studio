import { test } from "node:test";
import assert from "node:assert/strict";
import { autosavePayload, parseAutosave } from "../src/app/autosave.ts";

const card = { id: "a", kind: "chapter-bar", start: 0, end: 2, params: {} };
const doc = { version: 1, cards: [card] } as never;

test("autosavePayload drops blob video URLs and empty dismissed lists", () => {
  const now = new Date("2026-01-02T03:04:05Z");
  const base = { overlay: doc, origin: null, srt: null, now };
  const p = autosavePayload({ ...base, videoUrl: "blob:http://x/1", dismissed: { video: null, cuts: [] } });
  assert.equal(p.videoUrl, undefined);
  assert.equal(p.dismissed, undefined);
  assert.equal(p.savedAt, "2026-01-02T03:04:05.000Z");
  const d = { video: "/_media/a.mp4", cuts: [{ start: 1, end: 2 }] };
  const q = autosavePayload({ ...base, videoUrl: "/_media/a.mp4", dismissed: d });
  assert.equal(q.videoUrl, "/_media/a.mp4");
  assert.deepEqual(q.dismissed, d);
});

test("parseAutosave round-trips a save and picks the first card", () => {
  const raw = JSON.stringify(
    autosavePayload({
      overlay: doc,
      origin: doc,
      srt: [{ i: 1, start: 0, end: 1, text: "hi" }] as never,
      videoUrl: "/_media/a.mp4",
      dismissed: { video: "/_media/a.mp4", cuts: [{ start: 1, end: 2 }] },
      now: new Date(),
    }),
  );
  const { state, dropped } = parseAutosave(raw);
  assert.deepEqual(dropped, []);
  assert.equal(state.overlay?.cards[0].id, "a");
  assert.equal(state.origin?.cards[0].id, "a");
  assert.equal(state.srt?.length, 1);
  assert.equal(state.videoUrl, "/_media/a.mp4");
  assert.deepEqual(state.dismissed, { video: "/_media/a.mp4", cuts: [{ start: 1, end: 2 }] });
  assert.equal(state.firstCardId, "a");
});

test("parseAutosave: no cards → nothing restored except a saved /_media/ video; unknown cards are reported", () => {
  const empty = parseAutosave(JSON.stringify({ overlay: { cards: [] }, srt: [{}], videoUrl: "/_media/b.mp4" }));
  assert.deepEqual(empty.state, { overlay: null, origin: null, srt: null, videoUrl: "/_media/b.mp4", dismissed: null, firstCardId: null });
  assert.equal(parseAutosave(JSON.stringify({ videoUrl: "blob:x" })).state.videoUrl, null);
  const r = parseAutosave(JSON.stringify({ overlay: { version: 1, cards: [card, { ...card, id: "z", kind: "no-such-kind" }] } }));
  assert.deepEqual(r.dropped, ["no-such-kind×1"]);
  assert.deepEqual(r.state.overlay?.cards.map((c) => c.id), ["a"]);
  // 坏 dismissed 不恢复;空字幕稿不恢复
  const bad = parseAutosave(JSON.stringify({ overlay: doc, dismissed: { cuts: "x" }, srt: [] }));
  assert.equal(bad.state.dismissed, null);
  assert.equal(bad.state.srt, null);
  assert.throws(() => parseAutosave("{not json"));
});
