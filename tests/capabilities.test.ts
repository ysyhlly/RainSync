import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
} from "../packages/player-core";
import { H264_AAC_CONTENT_TYPE } from "../packages/player-core/capabilities";

afterEach(() => vi.useRealTimers());

describe("playback transport detection", () => {
  it("recognizes native HLS without assuming MSE on Safari", () => {
    const caps = detectCapabilities({
      canPlayType: (type) => (type.includes("mpegurl") ? "maybe" : ""),
    });
    expect(caps).toMatchObject({
      progressive_h264_aac: false,
      native_hls: true,
      mse_h264_aac: false,
    });
  });
  it("keeps MSE independent of progressive decoding", () => {
    const caps = detectCapabilities(
      { canPlayType: () => "" },
      { isTypeSupported: () => true },
    );
    expect(caps.mse_h264_aac).toBe(true);
    expect(caps.progressive_h264_aac).toBe(false);
  });
  it("reports only the exact codec/container hints returned by each API", () => {
    const caps = detectCapabilities(
      {
        canPlayType: (type) =>
          type.includes("avc1.42E01E")
            ? "probably"
            : type.includes("hvc1")
              ? "maybe"
              : "",
      },
      { isTypeSupported: (type) => type.includes("vp09") },
    );
    expect(caps.report?.schema_version).toBe(1);
    expect(caps.report?.candidates).toHaveLength(5);
    const [high, baseline, hevc, vp9, av1] = caps.report!.candidates;
    expect(high.content_type).toBe(H264_AAC_CONTENT_TYPE);
    expect(high.progressive).toBe("unsupported");
    expect(baseline.progressive).toBe("probably");
    expect(baseline.video).toMatchObject({ width: 640, height: 360 });
    expect(hevc.progressive).toBe("maybe");
    expect(hevc.mse_supported).toBe(false);
    expect(vp9.progressive).toBe("unsupported");
    expect(vp9.mse_supported).toBe(true);
    expect(av1.progressive).toBe("unsupported");
    // Baseline AVC, HEVC and WebM do not imply High/Level-4 AVC support.
    expect(caps.progressive_h264_aac).toBe(false);
    expect(caps.mse_h264_aac).toBe(false);
    expect(high.file_decoding).toBeUndefined();
    expect(high.mse_decoding).toBeUndefined();
  });
  it("does not turn API exceptions into support or suppress other probes", () => {
    const caps = detectCapabilities(
      {
        canPlayType: (type) => {
          if (type === H264_AAC_CONTENT_TYPE) throw new Error("unavailable");
          return type === "application/x-mpegURL" ? "maybe" : "";
        },
      },
      {
        isTypeSupported: (type) => {
          if (type === H264_AAC_CONTENT_TYPE) throw new Error("unavailable");
          return type.includes("vp09");
        },
      },
    );
    expect(caps.progressive_h264_aac).toBe(false);
    expect(caps.mse_h264_aac).toBe(false);
    expect(caps.native_hls).toBe(true);
    expect(caps.report!.candidates[0].progressive).toBe("unknown");
    expect(caps.report!.candidates[0].mse_supported).toBeUndefined();
    expect(caps.report!.candidates[3].mse_supported).toBe(true);
  });
  it("keeps absent MSE distinct from an explicit unsupported result", () => {
    const absent = detectCapabilities({ canPlayType: () => "" });
    const unsupported = detectCapabilities(
      { canPlayType: () => "" },
      { isTypeSupported: () => false },
    );
    expect(absent.report!.candidates[0].mse_supported).toBeUndefined();
    expect(unsupported.report!.candidates[0].mse_supported).toBe(false);
  });
  it("does not leak mutable sample configuration between reports", () => {
    const first = detectCapabilities({ canPlayType: () => "" });
    first.report!.candidates[0].video.width = 1;
    first.report!.candidates[0].audio.channels = "99";
    const second = detectCapabilities({ canPlayType: () => "" });
    expect(second.report!.candidates[0].video.width).toBe(1920);
    expect(second.report!.candidates[0].audio.channels).toBe("2");
  });
});

describe("optional concrete decoding estimates", () => {
  const video = {
    canPlayType: (type: string): CanPlayTypeResult =>
      type === H264_AAC_CONTENT_TYPE ? "probably" : "",
  };
  const mse = {
    isTypeSupported: (type: string) => type === H264_AAC_CONTENT_TYPE,
  };

  it("uses exact track configurations and separates file from MSE estimates", async () => {
    const decodingInfo = vi.fn(async (config: MediaDecodingConfiguration) => ({
      supported: config.type === "file",
      smooth: false,
      powerEfficient: false,
    }));
    const caps = await detectCapabilitiesAsync(video, mse, { decodingInfo });
    expect(decodingInfo).toHaveBeenCalledTimes(2);
    expect(decodingInfo).toHaveBeenCalledWith({
      type: "file",
      video: {
        contentType: 'video/mp4; codecs="avc1.640028"',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 30,
      },
      audio: {
        contentType: 'audio/mp4; codecs="mp4a.40.2"',
        channels: "2",
        bitrate: 128_000,
        samplerate: 48_000,
      },
    });
    const sample = caps.report!.candidates[0];
    expect(sample.file_decoding).toEqual({
      supported: true,
      smooth: false,
      power_efficient: false,
    });
    expect(sample.mse_decoding).toEqual({
      supported: false,
      smooth: false,
      power_efficient: false,
    });
    // The 1080p sample's negative estimate cannot blacklist every AVC stream.
    expect(caps.mse_h264_aac).toBe(true);
  });
  it("preserves MIME hints when decodingInfo is absent, rejects or throws", async () => {
    const expected = detectCapabilities(video, mse);
    expect(await detectCapabilitiesAsync(video, mse)).toEqual(expected);
    for (const decodingInfo of [
      vi.fn().mockRejectedValue(new Error("unsupported configuration")),
      vi.fn(() => {
        throw new Error("disabled API");
      }),
    ]) {
      expect(
        await detectCapabilitiesAsync(video, mse, { decodingInfo }),
      ).toEqual(expected);
    }
  });
  it("does not probe decoding for unrecognized MIME formats or transports", async () => {
    const decodingInfo = vi.fn();
    const caps = await detectCapabilitiesAsync(
      { canPlayType: () => "" },
      undefined,
      {
        decodingInfo,
      },
    );
    expect(decodingInfo).not.toHaveBeenCalled();
    expect(caps.progressive_h264_aac).toBe(false);
  });
  it("bounds hanging probes and freezes the request snapshot after timeout", async () => {
    vi.useFakeTimers();
    let settle!: (value: MediaCapabilitiesInfo) => void;
    const decodingInfo = vi.fn(
      () => new Promise<MediaCapabilitiesInfo>((resolve) => (settle = resolve)),
    );
    const pending = detectCapabilitiesAsync(video, undefined, { decodingInfo });
    await vi.advanceTimersByTimeAsync(500);
    const caps = await pending;
    expect(caps.report!.candidates[0].file_decoding).toBeUndefined();
    const snapshot = JSON.stringify(caps);
    settle({ supported: true, smooth: true, powerEfficient: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(caps)).toBe(snapshot);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains completed probes when a different path times out", async () => {
    vi.useFakeTimers();
    const decodingInfo = vi.fn((config: MediaDecodingConfiguration) =>
      config.type === "file"
        ? Promise.resolve({
            supported: true,
            smooth: true,
            powerEfficient: true,
          })
        : new Promise<MediaCapabilitiesInfo>(() => {}),
    );
    const pending = detectCapabilitiesAsync(video, mse, { decodingInfo });
    await vi.advanceTimersByTimeAsync(500);
    const caps = await pending;
    expect(caps.report!.candidates[0].file_decoding?.supported).toBe(true);
    expect(caps.report!.candidates[0].mse_decoding).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("server-issued actual media candidates", () => {
  const candidates = {
    schema_version: 1,
    binding: "opaque-source-and-epoch-binding",
    decision_reason: "actual_source_and_constrained_output_candidates",
    candidates: [
      {
        id: "direct",
        delivery_mode: "direct",
        transport: "progressive",
        content_type: 'video/mp4; codecs="avc1.64000D"',
        video: {
          content_type: 'video/mp4; codecs="avc1.64000D"',
          width: 352,
          height: 288,
          framerate: 25,
          bitrate: 245678,
        },
        audio: null,
      },
    ],
  };
  it("probes exact source configuration without fabricating audio and echoes binding", async () => {
    const decodingInfo = vi
      .fn()
      .mockResolvedValue({
        supported: true,
        smooth: false,
        powerEfficient: false,
      });
    const report = await detectCandidateReport(
      { canPlayType: () => "probably" },
      candidates,
      undefined,
      { decodingInfo },
    );
    expect(decodingInfo).toHaveBeenCalledTimes(1);
    expect(decodingInfo).toHaveBeenCalledWith({
      type: "file",
      video: {
        contentType: 'video/mp4; codecs="avc1.64000D"',
        width: 352,
        height: 288,
        framerate: 25,
        bitrate: 245678,
      },
    });
    expect(report?.binding).toBe(candidates.binding);
    expect(report?.results[0].candidate_id).toBe("direct");
    expect(report?.excluded_candidates).toEqual([]);
  });
  it("treats empty legacy/provider fallback as no report and bounds candidate count", async () => {
    expect(
      await detectCandidateReport(
        { canPlayType: () => "" },
        { ...candidates, binding: null, candidates: [] },
      ),
    ).toBeUndefined();
    await expect(
      detectCandidateReport(
        { canPlayType: () => "" },
        { ...candidates, candidates: Array(5).fill(candidates.candidates[0]) },
      ),
    ).rejects.toThrow("候选过多");
  });
  it("freezes exact reports before late estimates settle", async () => {
    vi.useFakeTimers();
    let finish!: (value: MediaCapabilitiesInfo) => void;
    const pending = detectCandidateReport(
      { canPlayType: () => "probably" },
      candidates,
      undefined,
      { decodingInfo: () => new Promise((resolve) => (finish = resolve)) },
    );
    await vi.advanceTimersByTimeAsync(500);
    const report = await pending;
    finish({ supported: true, smooth: true, powerEfficient: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(report?.results[0].file_decoding).toBeUndefined();
  });
});
