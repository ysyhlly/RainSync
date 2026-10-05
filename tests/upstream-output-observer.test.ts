import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlaybackPlan,
  UpstreamMeasuredOutput,
} from "../packages/protocol";
import { observeUpstreamOutput } from "../apps/web/src/features/playback/upstream-output-observer";
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

const reply = (
  value: unknown = facts(),
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });
afterEach(() => vi.useRealTimers());
describe("bounded upstream observer", () => {
  it("publishes one measured response and never negotiates a new session", async () => {
    const fetcher = vi.fn(async () => reply());
    const publish = vi.fn();
    const observed = observeUpstreamOutput({
      plan: plan(),
      origin: "https://room.test",
      current: () => true,
      facts: publish,
      fetcher,
    });
    await observed.done;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith(facts());
    expect(fetcher.mock.calls[0][0]).toContain(
      `/media-delivery/${id}/upstream-output?token=owned`,
    );
  });
  it("does not publish a late response after source authority changes", async () => {
    let current = true;
    const publish = vi.fn();
    const fetcher = vi.fn(async () => {
      current = false;
      return reply();
    });
    await observeUpstreamOutput({
      plan: plan(),
      origin: "https://room.test",
      current: () => current,
      facts: publish,
      fetcher,
    }).done;
    expect(publish).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects large, foreign and malformed reports without retry", async () => {
    for (const response of [
      reply(facts(), { "content-length": "32769" }),
      reply({ ...facts(), session_id: "foreign" }),
      reply("x".repeat(32769)),
      new Response("not json", {
        headers: { "content-type": "application/json" },
      }),
      reply(facts(), { "content-type": "text/plain" }),
    ]) {
      const fetcher = vi.fn(async () => response);
      const publish = vi.fn();
      await observeUpstreamOutput({
        plan: plan(),
        origin: "https://room.test",
        current: () => true,
        facts: publish,
        fetcher,
      }).done;
      expect(publish).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("cancels a stalled body at the original deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const publish = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn(
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const observed = observeUpstreamOutput({
      plan: plan(),
      origin: "https://room.test",
      current: () => true,
      facts: publish,
      fetcher,
    });
    await vi.advanceTimersByTimeAsync(30001);
    await observed.done;
    expect(cancel).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("explicit disposal cancels its read without reporting a playback failure", async () => {
    const cancel = vi.fn();
    const publish = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn(
      async () =>
        new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const observed = observeUpstreamOutput({
      plan: plan(),
      origin: "https://room.test",
      current: () => true,
      facts: publish,
      fetcher,
    });
    await Promise.resolve();
    await Promise.resolve();
    observed.stop();
    await observed.done;
    expect(cancel).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });
});
