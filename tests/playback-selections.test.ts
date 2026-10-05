import { describe, expect, it } from "vitest";
import type { MediaTrack, PlaybackSelectedOutput } from "../packages/protocol";
import {
  audioSelectionOptions,
  subtitleSelectionOptions,
  buildPlaybackSelectionParameters,
  describePlaybackQuality,
  PlaybackSelectionError,
  type PlaybackQualityPlan,
} from "../apps/web/src/features/playback/playback-selections";

const audio = (index: number, label = "Original"): MediaTrack => ({
  index,
  label,
  language: "eng",
  url: null,
});
const subtitle = (
  index: number,
  url: string | null = "/authorized-subtitle.vtt",
): MediaTrack => ({ index, label: "中文", language: "zho", url });
const availability = {
  audio_tracks: [audio(17), audio(0)],
  subtitle_tracks: [subtitle(31)],
};

describe("playback selection parameters", () => {
  it("keeps sparse provider IDs and treats index zero as a track", () => {
    expect(
      buildPlaybackSelectionParameters(
        { audioIndex: 17, subtitleIndex: 31 },
        availability,
      ),
    ).toEqual({ request: { audio_index: 17 }, subtitleIndex: 31 });
    expect(
      buildPlaybackSelectionParameters({ audioIndex: 0 }, availability).request
        .audio_index,
    ).toBe(0);
    expect(
      audioSelectionOptions(availability.audio_tracks).map(
        (option) => option.value,
      ),
    ).toEqual([null, 17, 0]);
  });
  it("maps default audio and closed subtitles without inventing a wire field", () => {
    expect(
      buildPlaybackSelectionParameters(
        { audioIndex: null, subtitleIndex: null },
        availability,
      ),
    ).toEqual({ request: { audio_index: null }, subtitleIndex: undefined });
    expect(buildPlaybackSelectionParameters({}, availability).request).toEqual({
      audio_index: null,
    });
  });
  it("allows default preferences before any plan exists", () => {
    expect(
      buildPlaybackSelectionParameters(
        {},
        { audio_tracks: [], subtitle_tracks: [] },
      ),
    ).toEqual({ request: { audio_index: null }, subtitleIndex: undefined });
  });
  it.each(["17", "", -1, 1.5, NaN, Infinity, 0x100000000, 1])(
    "rejects an invalid or unavailable audio selection: %s",
    (audioIndex) => {
      expect(() =>
        buildPlaybackSelectionParameters({ audioIndex }, availability),
      ).toThrow(PlaybackSelectionError);
    },
  );
  it("rejects stale subtitle IDs and subtitles without a delivery URL", () => {
    expect(() =>
      buildPlaybackSelectionParameters({ subtitleIndex: 17 }, availability),
    ).toThrow("此字幕已不可用");
    expect(() =>
      buildPlaybackSelectionParameters(
        { subtitleIndex: 31 },
        { ...availability, subtitle_tracks: [subtitle(31, null)] },
      ),
    ).toThrow("此字幕已不可用");
  });
  it("rejects duplicate provider IDs instead of selecting an ambiguous track", () => {
    const tracks = [audio(17), audio(17, "Other edition"), audio(0)];
    expect(audioSelectionOptions(tracks).map((option) => option.value)).toEqual(
      [null, 0],
    );
    expect(() =>
      buildPlaybackSelectionParameters(
        { audioIndex: 17 },
        { ...availability, audio_tracks: tracks },
      ),
    ).toThrow("此音轨已不可用");
  });
  it("omits non-deliverable subtitles and retains the server's style-loss label", () => {
    const label =
      "<img src=x>（ASS/SSA 转为 WebVTT 普通文本：样式无法完整保留）";
    expect(
      subtitleSelectionOptions([
        subtitle(1, null),
        subtitle(2, ""),
        subtitle(3, "  "),
        { ...subtitle(31), label },
      ]),
    ).toEqual([
      { value: null, label: "关闭" },
      { value: 31, label: label + " · zho" },
    ]);
  });
  it("does not invent audio, subtitle or quality options for empty metadata", () => {
    expect(audioSelectionOptions([])).toEqual([]);
    expect(subtitleSelectionOptions([])).toEqual([]);
    expect(describePlaybackQuality()).toBeUndefined();
  });
  it("uses stable ID labels if the server leaves track text blank", () => {
    expect(
      audioSelectionOptions([{ ...audio(17, "  "), language: " " }])[1],
    ).toEqual({ value: 17, label: "音轨 17" });
  });
});

const output: PlaybackSelectedOutput = {
  configuration: {
    id: "transcode_720p",
    delivery_mode: "transcode",
    transport: "hls",
    content_type: 'video/mp4; codecs="avc1.64001F"',
    video: {
      content_type: 'video/mp4; codecs="avc1.64001F"',
      width: 1280,
      height: 720,
      bitrate: 4000000,
      framerate: 30,
    },
    audio: null,
  },
  video_basis: "constrained_encoder_recipe",
  audio_basis: null,
};
const qualityPlan = (): PlaybackQualityPlan => ({
  delivery_mode: "transcode",
  selected_candidate_id: "transcode_720p",
  decision_reason: "actual_media_transcode_720p",
  selected_output: structuredClone(output),
});

describe("confirmed plan quality facts", () => {
  it("labels dimensions as an encoding target, without claiming measured output", () => {
    expect(describePlaybackQuality(qualityPlan())).toBe("1280×720（编码目标）");
    const plan = qualityPlan();
    plan.selected_output!.video_basis = "source_probe";
    expect(describePlaybackQuality(plan)).toBe("1280×720（片源配置）");
  });
  it("does not infer a quality option from a legacy mode or candidate name", () => {
    expect(
      describePlaybackQuality({
        delivery_mode: "transcode",
        selected_candidate_id: "transcode_720p",
      }),
    ).toBeUndefined();
  });
  it("ignores foreign and unmatched output facts", () => {
    for (const altered of [
      { delivery_mode: "direct" },
      { selected_candidate_id: "direct" },
      { decision_reason: "unknown" },
    ])
      expect(
        describePlaybackQuality({ ...qualityPlan(), ...altered }),
      ).toBeUndefined();
  });
  it.each([0, -1, 1.5, Infinity, 16385])(
    "rejects invalid dimension %s",
    (width) => {
      const plan = qualityPlan();
      plan.selected_output!.configuration.video.width = width;
      expect(describePlaybackQuality(plan)).toBeUndefined();
    },
  );
});
