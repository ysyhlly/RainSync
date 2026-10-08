import { expect, it } from "vitest";
import type { PlaybackState } from "../packages/sync-engine";
import { clientPlaybackStatus } from "../apps/web/src/features/rooms/client-playback-status";

const vod: PlaybackState = {
  anchor_position_ms: 1000,
  anchor_server_time_ms: 1000,
  playback_status: "playing",
  playback_rate: 1,
  duration_ms: 60000,
};
it("VOD status preserves actual reported drift and excludes nonfinite scalars", () => {
  expect(clientPlaybackStatus(vod, 2000, 1.8, true)).toEqual({
    buffering: true,
    drift_ms: 200,
  });
  expect(clientPlaybackStatus(vod, 2000, Number.NaN, false)).toEqual({
    buffering: false,
  });
});
it("live-edge status never invents zero drift or compare decoder PTS to VOD time", () => {
  const live = {
    ...vod,
    duration_ms: null,
    live: {
      version: 1,
      broadcast_id: "1:1700000000",
      sync_mode: "live_edge_control",
    },
  };
  for (const position of [0, 42, 86400, Number.NaN]) {
    expect(clientPlaybackStatus(live, 2000, position, true)).toEqual({
      buffering: true,
    });
    expect(
      JSON.stringify(clientPlaybackStatus(live, 2000, position, false)),
    ).not.toContain("drift");
  }
});
