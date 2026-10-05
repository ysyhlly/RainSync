import { expect, it } from "vitest";
import {
  bindLocalHlsLevels,
  localHlsLadderRequest,
  matchesLocalHlsLadderPlan,
  validLocalHlsRenditions,
} from "../apps/web/src/features/playback/local-hls-ladder-intent";
import type {
  LocalHlsLadderCapabilities,
  PlaybackPlan,
} from "../packages/protocol";
export const caps: LocalHlsLadderCapabilities = {
  schema_version: 1,
  worker_runtime_required: true,
  renditions: [
    {
      id: "low",
      width: 640,
      height: 360,
      bandwidth: 1250000,
      codecs: "avc1.64001F",
    },
    {
      id: "medium",
      width: 1280,
      height: 720,
      bandwidth: 3750000,
      codecs: "avc1.64001F",
    },
  ],
};
const plan: PlaybackPlan = {
  session_id: "session",
  media_id: "media",
  media_generation: 1,
  plan_generation: 2,
  delivery_mode: "transcode",
  transport: "hls",
  playback_url: "/media-delivery/session/ladder/master.m3u8?token=secret",
  timeline_origin_ms: 5000,
  duration_ms: 100000,
  expires_in_seconds: 1800,
  rebuild_on_seek: true,
  audio_tracks: [],
  subtitle_tracks: [],
  local_hls_ladder: {
    request: { schema_version: 1 },
    renditions: caps.renditions,
    video_basis: "constrained_encoder_recipe",
  },
};
const levels = () =>
  caps.renditions.map((r) => ({
    width: r.width,
    height: r.height,
    bitrate: r.bandwidth,
    videoCodec: r.codecs,
    url: [
      `http://localhost/media-delivery/session/ladder/${r.id}/index.m3u8?token=secret&attempt=1`,
    ],
  }));
it("keeps legacy absence and allows sealed advanced composition", () => {
  expect(localHlsLadderRequest(false, undefined, false)).toBeUndefined();
  expect(localHlsLadderRequest(true, caps, false)).toEqual({
    schema_version: 1,
  });
  expect(localHlsLadderRequest(true, caps, true)).toEqual({schema_version:1});
  expect(() =>
    localHlsLadderRequest(true, { ...caps, renditions: [] }, false),
  ).toThrow();
});
it("rejects fabricated geometry, rates, codecs, duplicates and unbounded rung counts", () => {
  expect(validLocalHlsRenditions(caps.renditions)).toBe(true);
  for (const patch of [
    { id: "arbitrary" },
    { width: 1920 },
    { height: 361 },
    { bandwidth: 1000 },
    { codecs: "hvc1" },
  ])
    expect(validLocalHlsRenditions([{ ...caps.renditions[0], ...patch }])).toBe(
      false,
    );
  expect(
    validLocalHlsRenditions([caps.renditions[0], caps.renditions[0]]),
  ).toBe(false);
  expect(validLocalHlsRenditions(Array(4).fill(caps.renditions[0]))).toBe(
    false,
  );
});
it("requires explicit echo, exact server facts and a dedicated same-origin master", () => {
  expect(
    matchesLocalHlsLadderPlan(
      { schema_version: 1 },
      plan,
      "http://localhost",
      caps,
    ),
  ).toBe(true);
  for (const bad of [
    { local_hls_ladder: undefined },
    { rebuild_on_seek: false },
    { plan_generation: undefined },
    { playback_url: "https://evil.test/master.m3u8?token=secret" },
    {
      playback_url: "/media-delivery/session/index.m3u8?token=secret&attempt=1",
    },
  ])
    expect(
      matchesLocalHlsLadderPlan(
        { schema_version: 1 },
        { ...plan, ...bad },
        "http://localhost",
        caps,
      ),
    ).toBe(false);
  expect(matchesLocalHlsLadderPlan(undefined, plan, "http://localhost")).toBe(
    false,
  );
});
it("maps SDK levels by authorized master facts rather than array index", () => {
  expect([
    ...bindLocalHlsLevels(plan, levels().reverse(), "http://localhost")!,
  ]).toEqual([
    ["medium", 0],
    ["low", 1],
  ]);
  for (const patch of [
    { width: 638 },
    { bitrate: 10 },
    { videoCodec: "avc1.640028" },
    { url: ["https://evil.test/index.m3u8"] },
    {
      url: [
        "http://localhost/media-delivery/session/ladder/low/index.m3u8?token=other&attempt=1",
      ],
    },
  ]) {
    const actual = levels();
    actual[0] = { ...actual[0], ...patch } as any;
    expect(
      bindLocalHlsLevels(plan, actual, "http://localhost"),
    ).toBeUndefined();
  }
  expect(
    bindLocalHlsLevels(plan, levels().slice(0, 1), "http://localhost"),
  ).toBeUndefined();
});

it("requires one canonical positive pinned attempt across the complete master", () => {
  for (const attempt of [
    "0",
    "-1",
    "01",
    "9223372036854775808",
    "3&unknown=x",
  ]) {
    const actual = levels();
    actual[0]!.url[0] = actual[0]!.url[0]!.replace(
      "attempt=1",
      `attempt=${attempt}`,
    );
    expect(
      bindLocalHlsLevels(plan, actual, "http://localhost"),
    ).toBeUndefined();
  }
  const mixed = levels();
  mixed[1]!.url[0] = mixed[1]!.url[0]!.replace("attempt=1", "attempt=2");
  expect(bindLocalHlsLevels(plan, mixed, "http://localhost")).toBeUndefined();
});
