import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs } from "../scripts/compose-final.mjs";

const base = {
  footage: "foot.mp4",
  seq: "frames/frame_%06d.png",
  fpsArg: "30000/1001",
  stage: { w: 1920, h: 1080 },
  out: "out.mp4",
};
const filterOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1];
const mapsOf = (args: string[]) => args.slice(args.indexOf("-map"), args.indexOf("-c:v"));

test("voice + sfx: sfx turned down and mixed under the voice", () => {
  const a = buildArgs({ ...base, sfxMix: "sfx.m4a", footageHasAudio: true });
  assert.match(filterOf(a), /\[2:a\]volume=0\.2\[sx\];\[0:a\]\[sx\]amix=inputs=2:duration=first:normalize=0\[am\]/);
  assert.deepEqual(mapsOf(a), ["-map", "[v]", "-map", "[am]"]);
});

test("voice only / sfx only / silent footage map the right audio", () => {
  assert.deepEqual(mapsOf(buildArgs({ ...base, sfxMix: null, footageHasAudio: true })), ["-map", "[v]", "-map", "0:a"]);
  assert.deepEqual(mapsOf(buildArgs({ ...base, sfxMix: "s.m4a", footageHasAudio: false })), ["-map", "[v]", "-map", "[am]"]);
  assert.deepEqual(mapsOf(buildArgs({ ...base, sfxMix: null, footageHasAudio: false })), ["-map", "[v]"]);
});

test("cuts: video and audio use the same half-open keep expression", () => {
  const a = buildArgs({
    ...base,
    sfxMix: null,
    footageHasAudio: true,
    cuts: [{ start: 6, end: 7 }, { start: 2, end: 4 }],
  });
  const keep = "not(gte(t,2)*lt(t,4)+gte(t,6)*lt(t,7))";
  assert.ok(filterOf(a).includes(`select='${keep}',setpts=N/FRAME_RATE/TB`));
  assert.ok(filterOf(a).includes(`[0:a]aselect='${keep}',asetpts=N/SR/TB[a]`));
  assert.deepEqual(mapsOf(a), ["-map", "[v]", "-map", "[a]"]);
});

test("cam segments black out the footage underneath", () => {
  const a = buildArgs({ ...base, footageHasAudio: false, camSegs: [{ start: 1, end: 2.5 }, { start: 3, end: 3 }] });
  assert.ok(filterOf(a).includes("enable='between(t,1,2.5)'"));
  assert.equal(filterOf(a).match(/drawbox/g)?.length, 1); // 零长度段丢掉
});
