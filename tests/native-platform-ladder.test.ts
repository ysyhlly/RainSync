import { expect, it } from "vitest";
import {
  nativePlatformRequest,
  validNativeCompatibilityPlan,
  validNativeCompatibilityDeliveryUrl,
} from "../apps/web/src/features/playback/native-platform-intent";
import {
  bindLocalHlsLevels,
  hasHlsLadder,
} from "../apps/web/src/features/playback/local-hls-ladder-intent";
import type { PlaybackPlan } from "../packages/protocol";
const origin = "https://rain.test",
  token = "a".repeat(64),
  id = "00000000-0000-0000-0000-000000000001";
const request = () =>
  nativePlatformRequest({
    viewer_id: id,
    plan_generation: 2,
    idempotency_key: id,
    room_id: id,
    media_generation: 3,
    position_ms: 5000,
    credential_mode: "anonymous",
    mse_h264_aac: true,
    compatibility: true,
    compatibility_ladder: true,
  });
const rungs = [
  {
    id: "low",
    width: 640,
    height: 360,
    bandwidth: 1410000,
    codecs: "avc1.64001F,mp4a.40.2",
  },
  {
    id: "medium",
    width: 1280,
    height: 720,
    bandwidth: 3910000,
    codecs: "avc1.64001F,mp4a.40.2",
  },
  {
    id: "high",
    width: 1920,
    height: 1080,
    bandwidth: 7660000,
    codecs: "avc1.640028,mp4a.40.2",
  },
];
function plan(ready = true): PlaybackPlan {
  return {
    session_id: id,
    media_id: id,
    media_generation: 3,
    plan_generation: 2,
    delivery_mode: "transcode",
    transport: ready ? "hls" : "pending_hls",
    playback_url: `/api/v1/platform-delivery/${id}/compatibility/master.m3u8?token=${token}${ready ? "&attempt=7" : ""}`,
    timeline_origin_ms: 5000,
    duration_ms: 100000,
    expires_in_seconds: 120,
    rebuild_on_seek: true,
    audio_tracks: [],
    subtitle_tracks: [],
    subtitle_mode: "none",
    seekable_media_ranges_ms: ready ? [{ start_ms: 5000, end_ms: 13000 }] : [],
    ...(ready ? {} : { pending_job_id: id }),
    native_platform: {
      version: 1,
      provider: "bilibili",
      credential_mode: "anonymous",
      refresh_after_seconds: 90,
      compatibility: {
        version: 1,
        mode: "hls_avc_aac_ladder",
        ...(ready
          ? {
              output: {
                attempt: 7,
                complete: false,
                width: 1920,
                height: 1080,
                codecs: rungs[2]!.codecs,
                renditions: rungs,
              },
            }
          : {}),
      },
    },
  };
}
it("keeps pending master devoid of invented output rungs, pins exact qualified ladder", () => {
  expect(validNativeCompatibilityPlan(request(), plan(false), origin)).toBe(
    true,
  );
  expect(hasHlsLadder(plan(false))).toBe(false);
  expect(validNativeCompatibilityPlan(request(), plan(), origin)).toBe(true);
  for (const change of ["attempt", "codecs", "width", "renditions"]) {
    const p = plan();
    if (change === "attempt")
      p.native_platform!.compatibility!.output!.attempt = 8;
    if (change === "codecs")
      p.native_platform!.compatibility!.output!.codecs =
        "avc1.64001F,mp4a.40.2";
    if (change === "width")
      p.native_platform!.compatibility!.output!.width = 1280;
    if (change === "renditions")
      p.native_platform!.compatibility!.output!.renditions = [
        { ...rungs[0]!, bandwidth: 1 },
      ];
    expect(validNativeCompatibilityPlan(request(), p, origin)).toBe(false);
  }
});
it("binds actual SDK indices, refuses mismatched attempts, URL scope or fake rungs", () => {
  const p = plan();
  const levels = rungs
    .map((r) => ({
      width: r.width,
      height: r.height,
      bitrate: r.bandwidth,
      videoCodec: r.codecs.split(",")[0],
      audioCodec: "mp4a.40.2",
      url: [
        `${origin}/api/v1/platform-delivery/${id}/compatibility/${r.id}/index.m3u8?token=${token}&attempt=7`,
      ],
    }))
    .reverse();
  expect([...bindLocalHlsLevels(p, levels, origin)!]).toEqual([
    ["high", 0],
    ["medium", 1],
    ["low", 2],
  ]);
  expect(hasHlsLadder(p)).toBe(true);
  for (const suffix of [
    "low/index0.m4s",
    "high/init.mp4",
    "medium/index.m3u8",
  ]) {
    expect(
      validNativeCompatibilityDeliveryUrl(
        `${origin}/api/v1/platform-delivery/${id}/compatibility/${suffix}?token=${token}&attempt=7`,
        p,
        origin,
      ),
    ).toBe(true);
  }
  levels[0]!.url[0] = levels[0]!.url[0]!.replace("attempt=7", "attempt=8");
  expect(bindLocalHlsLevels(p, levels, origin)).toBeUndefined();
  for (const path of [
    "../low/init.mp4",
    "low/index00.m4s",
    "index.m3u8",
    "high/key.bin",
  ]) {
    expect(
      validNativeCompatibilityDeliveryUrl(
        `${origin}/api/v1/platform-delivery/${id}/compatibility/${path}?token=${token}&attempt=7`,
        p,
        origin,
      ),
    ).toBe(false);
  }
});
