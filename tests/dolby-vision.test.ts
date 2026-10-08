import { expect, it } from "vitest";
import { detectCandidateReport } from "../packages/player-core/capabilities";
import { needsDolbyVisionToneMap } from "../apps/web/src/features/playback/advanced-playback-intent";
import type {
  AdvancedPlaybackCapabilities,
  PlaybackCandidateSet,
} from "../packages/protocol";

const dolby = {
  profile: 8,
  level: 4,
  compatibility_id: 4,
  codec: "dvh1.08.04",
};
const caps: AdvancedPlaybackCapabilities = {
  schema_version: 1,
  tone_map_hdr: true,
  subtitle_streams: [],
  worker_runtime_required: true,
  dolby_vision: dolby,
};
const set: PlaybackCandidateSet = {
  schema_version: 1,
  binding: "owned-source-binding",
  decision_reason: "actual_source",
  candidates: [
    {
      id: "direct",
      delivery_mode: "direct",
      transport: "progressive",
      content_type: 'video/mp4; codecs="hvc1.2.4.L120.B0, mp4a.40.2"',
      video: {
        content_type: 'video/mp4; codecs="hvc1.2.4.L120.B0"',
        width: 1920,
        height: 1080,
        framerate: 29.97,
        bitrate: 8_000_000,
        dolby_vision: dolby,
      },
      audio: null,
    },
  ],
};
const decoded = { supported: true, smooth: true, powerEfficient: false };

it("probes actual HDR metadata and requires Dolby decoding plus an HDR display", async () => {
  let configuration: MediaDecodingConfiguration | undefined;
  const report = await detectCandidateReport(
    { canPlayType: () => "probably" },
    set,
    undefined,
    {
      decodingInfo: async (value) => {
        configuration = value;
        return decoded;
      },
    },
    true,
  );
  expect(configuration?.video).toMatchObject({
    contentType: set.candidates[0].video.content_type,
    hdrMetadataType: "smpteSt2094-10",
    colorGamut: "rec2020",
    transferFunction: "hlg",
  });
  expect(configuration?.video).not.toHaveProperty("dolby_vision");
  expect(report?.results[0].dolby_vision_supported).toBe(true);
  expect(needsDolbyVisionToneMap(caps, set, report)).toBe(false);
  expect(needsDolbyVisionToneMap(caps, set, report, ["direct"])).toBe(true);
});

it.each(["plain-hevc", "sdr-display", "no-decoding-api", "decoder-rejection"])(
  "falls back to SDR for %s without using ordinary HEVC hints as Dolby proof",
  async (reason) => {
    const report = await detectCandidateReport(
      {
        canPlayType: (type) =>
          reason === "plain-hevc" && type.includes("dvh1") ? "" : "probably",
      },
      set,
      undefined,
      reason === "no-decoding-api"
        ? undefined
        : {
            decodingInfo: async () => ({
              ...decoded,
              supported: reason !== "decoder-rejection",
            }),
          },
      reason !== "sdr-display",
    );
    expect(report?.results[0].dolby_vision_supported).toBe(false);
    expect(needsDolbyVisionToneMap(caps, set, report)).toBe(true);
  },
);

it("requires source eligibility and leaves ordinary HDR preference explicit", () => {
  expect(
    needsDolbyVisionToneMap(
      { ...caps, dolby_vision: undefined },
      undefined,
      undefined,
    ),
  ).toBe(false);
  expect(
    needsDolbyVisionToneMap(
      { ...caps, tone_map_hdr: false },
      undefined,
      undefined,
    ),
  ).toBe(false);
  expect(
    needsDolbyVisionToneMap(
      { ...caps, dolby_vision: { ...dolby, profile: 7 } },
      undefined,
      undefined,
    ),
  ).toBe(false);
  expect(needsDolbyVisionToneMap(caps, undefined, undefined)).toBe(true);
});
