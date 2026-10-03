import { describe, expect, it } from "vitest";
import { summarizePlaybackPlan } from "../apps/web/src/features/playback/playback-summary";
import type { PlaybackSelectedOutput } from "../packages/protocol";

const output = (mode = "audio_transcode"): PlaybackSelectedOutput => ({
  configuration: {
    id: mode === "transcode" ? "transcode_720p" : mode,
    delivery_mode: mode,
    transport: "hls",
    content_type: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
    video: {
      content_type: 'video/mp4; codecs="avc1.64001F"',
      width: 1280,
      height: 720,
      bitrate: 4000000,
      framerate: 30,
    },
    audio: {
      content_type: 'audio/mp4; codecs="mp4a.40.2"',
      channels: "2",
      samplerate: 48000,
      bitrate: 128000,
    },
  },
  video_basis:
    mode === "transcode" ? "constrained_encoder_recipe" : "source_probe",
  audio_basis: "constrained_encoder_recipe",
});
const summary = (facts: PlaybackSelectedOutput) =>
  summarizePlaybackPlan({
    delivery_mode: facts.configuration.delivery_mode,
    selected_candidate_id: facts.configuration.id,
    decision_reason: `actual_media_${facts.configuration.id}`,
    selected_output: facts,
  });

describe("server-authored selected output explanations", () => {
  it("explains audio-only encoding while identifying the copied video", () => {
    expect(summary(output())).toEqual({
      mode: "仅音频转码",
      reason:
        "片源视频配置：H.264 1280×720 / 30 fps，音频编码目标 AAC 2 声道；设备兼容性为估计",
    });
    expect(summary(output("transcode"))?.reason).toContain("视频编码目标");
  });
  it("preserves no-audio instead of inventing AAC", () => {
    const facts = output();
    facts.configuration.audio = null;
    facts.audio_basis = null;
    expect(summary(facts)?.reason).toContain("无音轨");
  });
  it("recognizes exact HEVC and labels the device result an estimate", () => {
    const facts = output("direct");
    facts.configuration.video.content_type =
      'video/mp4; codecs="hvc1.2.4.L93.B0"';
    expect(summary(facts)?.reason).toContain("HEVC");
    expect(summary(facts)?.reason).toContain("估计");
  });
  it("ignores malformed and foreign facts, retaining the v1 explanation", () => {
    const facts = output();
    facts.configuration.video.width = Infinity;
    expect(summary(facts)?.reason).toBe("根据当前文件和设备能力报告选择");
    expect(
      summarizePlaybackPlan({
        delivery_mode: "audio_transcode",
        selected_candidate_id: "audio_transcode",
        decision_reason: "actual_media_audio_transcode",
      })?.mode,
    ).toBe("仅音频转码");
    expect(
      summarizePlaybackPlan({
        delivery_mode: "direct",
        selected_candidate_id: "direct",
        decision_reason: "actual_media_direct",
        selected_output: output(),
      })?.reason,
    ).toBe("根据当前文件和设备能力报告选择");
  });
});
