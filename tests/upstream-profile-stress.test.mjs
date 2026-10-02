import assert from "node:assert/strict";
import test from "node:test";
import {
  upstreamFixtureSampleSettings,
  upstreamProfileFixtureSampleSettings,
} from "./fixtures/upstream-real.mjs";

test("profile stress opts both synthetic codecs and every audio track into 60fps/44.1k", () => {
  assert.deepEqual(upstreamProfileFixtureSampleSettings(true), {
    h264_frame_rate: 60,
    h264_sample_rate: 44100,
    hevc_frame_rate: 60,
    hevc_sample_rate: 44100,
  });
  assert.deepEqual(upstreamProfileFixtureSampleSettings(), {
    h264_frame_rate: 10,
    h264_sample_rate: 48000,
    hevc_frame_rate: 10,
    hevc_sample_rate: 48000,
  });
  assert.deepEqual(upstreamFixtureSampleSettings(true), {
    h264_frame_rate: 60,
    h264_sample_rate: 44100,
  });
  assert.throws(() => upstreamProfileFixtureSampleSettings("true"));
});

test("profile rate fixtures opt into known 44.1/48k stereo and non-AAC media without changing legacy defaults", async () => {
  const { upstreamProfileAudioRateFixtures } = await import("./fixtures/upstream-real.mjs");
  assert.deepEqual(upstreamProfileAudioRateFixtures(), []);
  assert.deepEqual(upstreamProfileAudioRateFixtures(true), [
    { title: "rainsync-h264-48k-stereo-aac", sample_rate: 48000, channels: 2, audio_codec: "aac" },
    { title: "rainsync-h264-44k-stereo-ac3", sample_rate: 44100, channels: 2, audio_codec: "ac3" },
    { title: "rainsync-h264-48k-stereo-ac3", sample_rate: 48000, channels: 2, audio_codec: "ac3" },
  ]);
  assert.throws(() => upstreamProfileAudioRateFixtures("true"));
});

test("measured audio oracle is an exact Emby rate set and unchanged fixed Jellyfin 48k", async () => {
  const { assertObservedAudioRate } = await import("./fixtures/upstream-profile-rate-contract.mjs");
  for (const value of [44100, 48000]) assertObservedAudioRate("emby", value);
  assertObservedAudioRate("jellyfin", 48000);
  for (const value of [null, undefined, 0, -1, 8000, 32000, 44099, 44101, 47999, 48001, 96000, NaN, Infinity, "44100"])
    assert.throws(() => assertObservedAudioRate("emby", value), `Emby rejects ${value}`);
  assert.throws(() => assertObservedAudioRate("jellyfin", 44100));
});

test("test reports keep v1 wire shape and emit every canonical v2 rate or explicit silent empty list", async () => {
  const { positiveRateReports } = await import("./fixtures/upstream-profile-rate-contract.mjs");
  assert.deepEqual(positiveRateReports({ profile_version: 1 }), {});
  assert.deepEqual(positiveRateReports({ profile_version: 2 }), { audio_rate_reports: [] });
  const reports = positiveRateReports({ profile_version: 2,
    audio_rate_contract: { allowed_sample_rates: [44100, 48000] } });
  assert.deepEqual(reports.audio_rate_reports.map((entry) => entry.sample_rate), [44100, 48000]);
  assert.ok(reports.audio_rate_reports.every((entry) => entry.mse_supported && entry.mse_decoding.supported));
  assert.throws(() => positiveRateReports({ profile_version: 3 }));
});
