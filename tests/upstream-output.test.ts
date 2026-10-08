import { describe, expect, it, vi } from "vitest";
import {
  SameSidDecoderRecovery,
  upstreamOutputUrl,
  validateUpstreamOutput,
  upstreamOutputMatchesMeasuredBounds,
} from "../apps/web/src/features/playback/upstream-output";
import type {
  PlaybackPlan,
  UpstreamMeasuredOutput,
} from "../packages/protocol";
const id = "00000000-0000-0000-0000-000000000001";
const plan = () =>
  ({
    session_id: id,
    plan_generation: 7,
    transport: "hls",
    delivery_mode: "transcode",
    playback_url: `/media-delivery/${id}/index.m3u8?token=owned`,
    upstream_profile: {
      requested_video: {
        codec: "h264",
        profile: "main",
        max_width: 1280,
        max_height: 720,
        max_framerate: 30,
      },
      requested_audio: {
        max_channels: 2,
        requested_sample_rate: 48000,
        codec: "aac",
      },
    },
  }) as unknown as PlaybackPlan;
const facts = () =>
  ({
    schema_version: 1,
    semantics: "finite_same_sid_output_not_whole_title",
    session_id: id,
    plan_generation: 7,
    upstream_sid_sha256: "a".repeat(64),
    route_sha256: "b".repeat(64),
    representation_sha256: "c".repeat(64),
    measured_bytes: 562496,
    measured_segments: 3,
    manifest_duration_ms: 12000,
    video: {
      codec: "h264",
      profile: "Main",
      width: 1280,
      height: 720,
      pixel_format: "yuv420p",
      frame_rate: 30,
      decoded_frames: 360,
    },
    audio: {
      codec: "aac",
      profile: "LC",
      sample_rate: 44100,
      channels: 2,
      decoded_frames: 517,
    },
    process_tree_reaped: true,
  }) as UpstreamMeasuredOutput;
describe("finite same-SID upstream observations", () => {
  it("reports actual44.1 kHz separately from requested48 kHz", () => {
    const p = plan();
    const f = validateUpstreamOutput(facts(), p)!;
    expect(f.audio?.sample_rate).toBe(44100);
    expect(upstreamOutputMatchesMeasuredBounds(f, p)).toBe(false);
    p.upstream_profile!.audio_rate_contract = {
      allowed_sample_rates: [44100, 48000],
      source_sample_rate: 44100,
      mse_samples: [],
    };
    expect(upstreamOutputMatchesMeasuredBounds(f, p)).toBe(true);
  });
  it("rejects foreign grants, incomplete decode, oversized or whole-title claims", () => {
    for (const patch of [
      { session_id: "foreign" },
      { plan_generation: 8 },
      { process_tree_reaped: false },
      { measured_bytes: 16777217 },
      { measured_segments: 4 },
      { manifest_duration_ms: 24001 },
      { semantics: "whole_title" },
    ]) {
      expect(
        validateUpstreamOutput({ ...facts(), ...patch }, plan()),
      ).toBeUndefined();
    }
    const f = facts();
    f.video.decoded_frames = 0;
    expect(validateUpstreamOutput(f, plan())).toBeUndefined();
  });
  it("rejects unknown fields without copying unchecked report data", () => {
    expect(
      validateUpstreamOutput({ ...facts(), url: "private" }, plan()),
    ).toBeUndefined();
    expect(
      validateUpstreamOutput(
        { ...facts(), video: { ...facts().video, source: "unbound" } },
        plan(),
      ),
    ).toBeUndefined();
    expect(
      validateUpstreamOutput(
        { ...facts(), audio: { ...facts().audio, sample: "unbounded" } },
        plan(),
      ),
    ).toBeUndefined();
  });
  it("constructs only the exact own-token measurement route", () => {
    expect(upstreamOutputUrl(plan(), "https://room.test")).toBe(
      `https://room.test/media-delivery/${id}/upstream-output?token=owned`,
    );
    for (const url of [
      "https://foreign.test/a",
      `/media-delivery/${id}/index.m3u8?token=x&token=y`,
      `/media-delivery/${id}/index.m3u8?token=x&recovery=1`,
      `/media-delivery/${id}/index.m3u8?token=x#t=2`,
    ]) {
      expect(
        upstreamOutputUrl(
          { ...plan(), playback_url: url },
          "https://room.test",
        ),
      ).toBeUndefined();
    }
  });
  it("spends at mosttwo recoveries under exact same grant including re-entrant or late callbacks", () => {
    const p = plan();
    const recovery = new SameSidDecoderRecovery(p);
    let calls = 0;
    const recover = () =>
      recovery.recover({
        plan: p,
        current: true,
        fatal: true,
        type: "mediaError",
        recoverMediaError: () => calls++,
      });
    expect(recover()).toBe(true);
    expect(recover()).toBe(true);
    expect(recover()).toBe(false);
    expect(calls).toBe(2);
    expect(recovery.count()).toBe(2);
  });
  it("does not turn network failures, changed URLs, stopped plans or throws into fresh authority", () => {
    const p = plan();
    const recovery = new SameSidDecoderRecovery(p);
    const run = (patch: Partial<Parameters<typeof recovery.recover>[0]>) =>
      recovery.recover({
        plan: p,
        current: true,
        fatal: true,
        type: "mediaError",
        recoverMediaError: () => {},
        ...patch,
      });
    expect(run({ type: "networkError" })).toBe(false);
    expect(run({ current: false })).toBe(false);
    expect(
      run({ plan: { ...p, playback_url: p.playback_url + "&recovery=1" } }),
    ).toBe(false);
    expect(
      run({
        recoverMediaError: () => {
          throw new Error("sdk");
        },
      }),
    ).toBe(false);
    expect(recovery.count()).toBe(1);
    recovery.retire();
    expect(run({})).toBe(false);
  });
});

describe("same-SID bounded transient-network retry", () => {
  it("keeps an independent budget and the original monotonic deadline", () => {
    vi.useFakeTimers();
    try {
      const p = { ...plan(), expires_in_seconds: 10 };
      const recovery = new SameSidDecoderRecovery(p);
      let calls = 0;
      const run = (
        patch: Partial<Parameters<typeof recovery.recoverNetwork>[0]> = {},
      ) =>
        recovery.recoverNetwork({
          plan: p,
          current: true,
          fatal: true,
          type: "networkError",
          details: "fragLoadError",
          status: 503,
          startLoad: () => calls++,
          ...patch,
        });
      expect(run()).toBe(true);
      expect(run()).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(run()).toBe(true);
      vi.advanceTimersByTime(2001);
      expect(run()).toBe(false);
      expect(calls).toBe(2);
      expect(recovery.networkCount()).toBe(2);
      expect(recovery.count()).toBe(0);
      const second = new SameSidDecoderRecovery(p);
      vi.advanceTimersByTime(10_001);
      expect(
        second.recoverNetwork({
          plan: { ...p, expires_in_seconds: 1800 },
          current: true,
          fatal: true,
          type: "networkError",
          details: "fragLoadError",
          status: 503,
          startLoad: () => calls++,
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed for auth, missing status, foreign grants, retired callbacks and SDK throws", () => {
    const p = { ...plan(), expires_in_seconds: 100 };
    for (const patch of [
      { status: 401 },
      { status: 403 },
      { status: 404 },
      { status: undefined },
      { details: "keyLoadError" },
      { current: false },
      { plan: { ...p, session_id: "foreign" } },
      { plan: { ...p, playback_url: p.playback_url + "&recovery=1" } },
    ]) {
      const r = new SameSidDecoderRecovery(p);
      expect(
        r.recoverNetwork({
          plan: p,
          current: true,
          fatal: true,
          type: "networkError",
          details: "fragLoadError",
          status: 503,
          startLoad: () => {},
          ...patch,
        }),
      ).toBe(false);
      expect(r.networkCount()).toBe(0);
    }
    const r = new SameSidDecoderRecovery(p);
    expect(
      r.recoverNetwork({
        plan: p,
        current: true,
        fatal: true,
        type: "networkError",
        details: "fragLoadError",
        status: 503,
        startLoad: () => {
          throw Error("sdk");
        },
      }),
    ).toBe(false);
    expect(r.networkCount()).toBe(1);
    r.retire();
    expect(
      r.recoverNetwork({
        plan: p,
        current: true,
        fatal: true,
        type: "networkError",
        details: "fragLoadError",
        status: 503,
        startLoad: () => {},
      }),
    ).toBe(false);
  });
});
