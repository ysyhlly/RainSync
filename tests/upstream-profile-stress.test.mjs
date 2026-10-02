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
