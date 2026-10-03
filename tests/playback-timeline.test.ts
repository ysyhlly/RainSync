import { expect, test } from "vitest";
import { hasUsablePlaybackTimeline } from "../packages/player-core";
import type { PlaybackPlan } from "../packages/protocol";
import { isUnsupportedTimelineResponse } from "../apps/web/src/errors";

const plan = {
  timeline_origin_ms: 0,
  duration_ms: 120_000,
  transport: "hls",
  delivery_mode: "transcode",
  rebuild_on_seek: true,
} as PlaybackPlan;

test("only a bounded recognized delivery error body has timeline semantics", () => {
  const body = JSON.stringify({ error: { code: "UNSUPPORTED_TIMELINE" } });
  expect(isUnsupportedTimelineResponse(422, body)).toBe(true);
  expect(isUnsupportedTimelineResponse(401, body)).toBe(false);
  expect(isUnsupportedTimelineResponse(422, "UNSUPPORTED_TIMELINE")).toBe(
    false,
  );
  expect(isUnsupportedTimelineResponse(422, body + " ".repeat(16384))).toBe(
    false,
  );
  expect(
    isUnsupportedTimelineResponse(422, {
      error: { code: "UNSUPPORTED_TIMELINE" },
    }),
  ).toBe(false);
});

test("only the exact decoded HLS recipe can carry a nonzero scalar origin", () => {
  expect(
    hasUsablePlaybackTimeline({ ...plan, timeline_origin_ms: 12_345 }),
  ).toBe(true);
  for (const fields of [
    { rebuild_on_seek: false },
    { transport: "progressive" },
    { delivery_mode: "remux" },
    { delivery_mode: "direct" },
  ])
    expect(
      hasUsablePlaybackTimeline({
        ...plan,
        ...fields,
        timeline_origin_ms: 12_345,
      }),
    ).toBe(false);
  expect(hasUsablePlaybackTimeline({ ...plan, rebuild_on_seek: false })).toBe(
    true,
  );
});

test("missing/nonfinite/out-of-range origins and duration are never seek coordinates", () => {
  for (const origin of [undefined, null, "0", NaN, Infinity, -1, 120_001])
    expect(
      hasUsablePlaybackTimeline({
        ...plan,
        timeline_origin_ms: origin,
      } as PlaybackPlan),
    ).toBe(false);
  for (const duration of ["120000", NaN, Infinity, -1])
    expect(
      hasUsablePlaybackTimeline({
        ...plan,
        duration_ms: duration,
      } as PlaybackPlan),
    ).toBe(false);
  expect(hasUsablePlaybackTimeline({ ...plan, duration_ms: null })).toBe(true);
});
