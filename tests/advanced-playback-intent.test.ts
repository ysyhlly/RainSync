import { describe, expect, it } from "vitest";
import type {
  AdvancedPlaybackCapabilities,
  PlaybackPlan,
} from "../packages/protocol";
import {
  advancedPlaybackRequest,
  matchesAdvancedPlaybackPlan,
  validAdvancedPlaybackCapabilities,
} from "../apps/web/src/features/playback/advanced-playback-intent";

const caps: AdvancedPlaybackCapabilities = {
  schema_version: 1,
  tone_map_hdr: true,
  subtitle_streams: [
    { index: 0, codec: "ass", label: "Styled", language: "eng" },
    { index: 17, codec: "pgs", label: "Bitmap", language: "zho" },
  ],
  worker_runtime_required: true,
};
const plan = (): Pick<
  PlaybackPlan,
  | "advanced_playback"
  | "delivery_mode"
  | "transport"
  | "subtitle_mode"
  | "selected_candidate_id"
> => ({
  delivery_mode: "transcode",
  transport: "hls",
  subtitle_mode: "burned_in",
  selected_candidate_id: "transcode_720p",
  advanced_playback: {
    request: {
      schema_version: 1,
      tone_map_hdr: true,
      subtitle_stream_index: 0,
    },
    subtitle_codec: "ass",
    video_basis: "constrained_encoder_recipe",
  },
});

describe("advanced owned local playback intent", () => {
  it("leaves legacy requests absent and preserves absolute subtitle index zero", () => {
    expect(
      advancedPlaybackRequest({ toneMapHdr: false }, undefined),
    ).toBeUndefined();
    const request = advancedPlaybackRequest(
      { toneMapHdr: true, subtitleStreamIndex: 0 },
      caps,
    );
    expect(request).toEqual({
      schema_version: 1,
      tone_map_hdr: true,
      subtitle_stream_index: 0,
    });
    expect(Object.isFrozen(request)).toBe(true);
  });
  it("rejects unavailable HDR, stale streams, invalid indices, and HDR burn-in without tone mapping", () => {
    expect(() =>
      advancedPlaybackRequest({ toneMapHdr: true }, undefined),
    ).toThrow();
    expect(() =>
      advancedPlaybackRequest(
        { toneMapHdr: true },
        { ...caps, tone_map_hdr: false },
      ),
    ).toThrow();
    for (const index of [-1, 1.5, NaN, Infinity, 0x100000000, 3])
      expect(() =>
        advancedPlaybackRequest(
          { toneMapHdr: true, subtitleStreamIndex: index },
          caps,
        ),
      ).toThrow();
    expect(() =>
      advancedPlaybackRequest(
        { toneMapHdr: false, subtitleStreamIndex: 0 },
        caps,
      ),
    ).toThrow();
  });
  it("validates finite unique subtitle capabilities without claiming hardware", () => {
    expect(validAdvancedPlaybackCapabilities(caps)).toBe(true);
    expect(
      validAdvancedPlaybackCapabilities({
        ...caps,
        worker_runtime_required: false,
      }),
    ).toBe(false);
    expect(
      validAdvancedPlaybackCapabilities({
        ...caps,
        subtitle_streams: [caps.subtitle_streams[0], caps.subtitle_streams[0]],
      }),
    ).toBe(false);
    expect(
      validAdvancedPlaybackCapabilities({
        ...caps,
        subtitle_streams: [{ ...caps.subtitle_streams[0], codec: "webvtt" }],
      }),
    ).toBe(false);
  });
  it("requires exact advanced plan echo and a transcode recipe before consumption", () => {
    const request = advancedPlaybackRequest(
      { toneMapHdr: true, subtitleStreamIndex: 0 },
      caps,
    )!;
    expect(matchesAdvancedPlaybackPlan(request, plan())).toBe(true);
    for (const patch of [
      { advanced_playback: undefined },
      { delivery_mode: "direct" },
      { transport: "progressive" },
      { subtitle_mode: "external_vtt" },
      { selected_candidate_id: "direct" },
      {
        advanced_playback: {
          ...plan().advanced_playback!,
          request: { ...request, subtitle_stream_index: 17 },
        },
      },
      {
        advanced_playback: {
          ...plan().advanced_playback!,
          video_basis: "source_probe",
        },
      },
    ])
      expect(
        matchesAdvancedPlaybackPlan(request, { ...plan(), ...patch } as any),
      ).toBe(false);
    expect(matchesAdvancedPlaybackPlan(undefined, plan())).toBe(false);
    expect(
      matchesAdvancedPlaybackPlan(undefined, {
        ...plan(),
        advanced_playback: undefined,
      }),
    ).toBe(true);
  });
  it("supports tone map without burning text and SDR styled burn-in without inventing a tone map", () => {
    const tone = advancedPlaybackRequest({ toneMapHdr: true }, caps)!;
    expect(
      matchesAdvancedPlaybackPlan(tone, {
        ...plan(),
        subtitle_mode: "external_vtt",
        advanced_playback: {
          request: tone,
          subtitle_codec: null,
          video_basis: "constrained_encoder_recipe",
        },
      }),
    ).toBe(true);
    expect(
      advancedPlaybackRequest(
        { toneMapHdr: false, subtitleStreamIndex: 17 },
        { ...caps, tone_map_hdr: false },
      ),
    ).toEqual({
      schema_version: 1,
      tone_map_hdr: false,
      subtitle_stream_index: 17,
    });
  });
});
