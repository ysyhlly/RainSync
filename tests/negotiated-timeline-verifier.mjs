import assert from "node:assert/strict";
import {
  verifySourceClock,
  verifyOutputTimeline,
} from "../scripts/negotiated-timeline-verifier.mjs";
const frames = Array.from({ length: 350 }, (_, n) => ({
  frame_index: n,
  original_position_ms: n * 40,
  source_pts_ms: n * 40,
}));
const source = {
  frames,
  formatStartMs: 0,
  videoStartMs: 0,
  selectedAudioStartMs: null,
};
assert.equal(verifySourceClock(source), true);
for (const key of ["formatStartMs", "videoStartMs", "selectedAudioStartMs"])
  assert.throws(
    () => verifySourceClock({ ...source, [key]: 400 }),
    /unestablished zero/,
  );
assert.throws(
  () =>
    verifySourceClock({
      ...source,
      frames: frames.map((f, n) => ({
        ...f,
        source_pts_ms: f.source_pts_ms + (n >= 125 ? 1000 : 0),
      })),
    }),
  /clock|jump/,
);
// Even when the marker also follows a gap, it is outside this narrowly
// measured continuous source-clock contract (not a production rejection).
assert.throws(
  () =>
    verifySourceClock({
      ...source,
      frames: frames.map((f, n) => ({
        ...f,
        source_pts_ms: f.source_pts_ms + (n >= 125 ? 1000 : 0),
        original_position_ms: f.original_position_ms + (n >= 125 ? 1000 : 0),
      })),
    }),
  /jump/,
);
const outputFrames = Array.from({ length: 380 }, (_, n) => (n * 1000) / 30);
const samples = [0, 45, 119, 120, 121, 239, 240, 241].map((n) => {
  const t = 1250 + outputFrames[n];
  const ms = n === 0 ? Math.ceil(t / 40) * 40 : Math.round(t / 40) * 40;
  return {
    output_frame_index: n,
    frame_index: ms / 40,
    original_position_ms: ms,
  };
});
const good = {
  startMs: 1250,
  sourceFrames: frames,
  samples,
  outputFrames,
  timeBase: "1/15360",
};
assert.equal(verifyOutputTimeline(good).length, 8);
assert.throws(
  () =>
    verifyOutputTimeline({
      ...good,
      samples: samples.map((s, n) =>
        n ? s : { ...s, frame_index: 0, original_position_ms: 0 },
      ),
    }),
  /wrong source frame/,
);
assert.throws(
  () =>
    verifyOutputTimeline({
      ...good,
      samples: samples.map((s, n) =>
        n === 4
          ? {
              ...s,
              frame_index: s.frame_index + 2,
              original_position_ms: s.original_position_ms + 80,
            }
          : s,
      ),
    }),
  /wrong source frame/,
);
assert.throws(
  () =>
    verifyOutputTimeline({
      ...good,
      outputFrames: outputFrames.map((p, n) => p + (n > 60 ? 100 : 0)),
    }),
  /continuous CFR/,
);
assert.throws(
  () =>
    verifyOutputTimeline({
      ...good,
      outputFrames: outputFrames.map((p) => p + 33.333),
    }),
  /continuous CFR/,
);
// A first source frame before the request is not excused by the later-frame rule.
assert.throws(
  () =>
    verifyOutputTimeline({
      ...good,
      samples: samples.map((s, n) =>
        n ? s : { ...s, frame_index: 31, original_position_ms: 1240 },
      ),
    }),
  /wrong source frame/,
);
assert.throws(
  () =>
    verifyOutputTimeline({
      ...good,
      samples: samples.filter((s) => s.output_frame_index !== 120),
    }),
  /missing/,
);
assert.throws(
  () => verifyOutputTimeline({ ...good, samples: [...samples, samples[0]] }),
  /duplicate/,
);
console.log(
  "PASS: bounded owned-source origin, exact first frame, adjacent CFR quantization, wrong-zero, drift and jump negatives",
);
