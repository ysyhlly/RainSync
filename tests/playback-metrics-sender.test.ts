import { afterEach, expect, test, vi } from "vitest";
import {
  createPlaybackMetricsSender,
  type PlaybackMetricsBinding,
} from "../apps/web/src/features/playback/metrics-sender";
import type { PlaybackMetricsSnapshot } from "../apps/web/src/features/playback/playback-metrics";
import { RequestFailure } from "../apps/web/src/errors";

afterEach(() => vi.useRealTimers());
const binding = (generation = 1): PlaybackMetricsBinding => ({
  version: 1,
  sessionId: `session-${generation}`,
  planGeneration: generation,
  meterStartGeneration: 1,
  mediaGeneration: 1,
  startupOrigin: "user_intent",
  current: () => true,
});
const snapshot = (seq: number, final = false): PlaybackMetricsSnapshot => ({
  source: "client_reported",
  seq,
  generation: 99,
  startup_origin: "user_intent",
  elapsed_ms: seq * 5000,
  observed_ms: seq * 5000,
  expected_playback_ms: 0,
  final,
  startup_phases: {
    preparation_ms: seq * 5000,
    loading_ms: 0,
    unobserved_ms: 0,
  },
  totals: {
    startup_ms: seq * 5000,
    autoplay_blocked_ms: 0,
    background_ms: 0,
    paused_ms: 0,
    seeking_ms: 0,
    rebuffer_ms: 0,
    playing_ms: 0,
    unobserved_ms: 0,
  },
});
const receipt = (b: PlaybackMetricsBinding, body: any) => ({
  session_id: b.sessionId,
  meter_start_generation: body.meter_start_generation,
  metrics_seq: body.seq,
  closed: body.final,
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

test("same-package retry is immutable and DTO excludes local-only fields", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("lost receipt"))
    .mockImplementation(async (b, body) => receipt(b, body));
  const sender = createPlaybackMetricsSender(send);
  expect(sender.offer(snapshot(1))).toBe(false);
  sender.bind(binding());
  sender.offer(snapshot(1));
  await vi.advanceTimersByTimeAsync(1000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
  expect(Object.keys(send.mock.calls[0][1]).sort()).toEqual(
    [
      "version",
      "media_generation",
      "plan_generation",
      "meter_start_generation",
      "seq",
      "startup_origin",
      "elapsed_ms",
      "totals",
      "final",
    ].sort(),
  );
  expect(send.mock.calls[0][1].plan_generation).toBe(1);
  expect(Object.isFrozen(send.mock.calls[0][1].totals)).toBe(true);
  sender.stop();
});

test("only one in flight and one replaceable pending snapshot; latest cumulative packet survives coalescing", async () => {
  let complete!: () => void;
  const send = vi.fn(
    (b, body) =>
      new Promise<any>((resolve) => {
        complete = () => resolve(receipt(b, body));
      }),
  );
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding());
  sender.offer(snapshot(1));
  for (let seq = 2; seq <= 1000; seq++) sender.offer(snapshot(seq));
  expect(send).toHaveBeenCalledTimes(1);
  complete();
  await settle();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][1].seq).toBe(1000);
  complete();
  await settle();
  sender.stop();
});

test("binding switch aborts old request and never rewrites its destination or body", async () => {
  let resolve!: () => void;
  const send = vi.fn(
    (b, body, _signal: AbortSignal) =>
      new Promise<any>((r) => (resolve = () => r(receipt(b, body)))),
  );
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding());
  sender.offer(snapshot(1));
  sender.offer(snapshot(2));
  const old = send.mock.calls[0];
  sender.bind(binding(2));
  sender.offer(snapshot(3));
  expect(old[2].aborted).toBe(true);
  resolve();
  await settle();
  expect(send).toHaveBeenCalledTimes(2);
  expect(old[0].sessionId).toBe("session-1");
  expect(old[1].plan_generation).toBe(1);
  expect(send.mock.calls[1][0].sessionId).toBe("session-2");
  expect(send.mock.calls[1][1].seq).toBe(3);
  resolve();
  await settle();
  sender.stop();
});

test("deadline and retry budget are bounded; stop aborts and drops pending", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    (_b, _body, signal: AbortSignal) =>
      new Promise<any>((_r, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        ),
      ),
  );
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding());
  sender.offer(snapshot(1));
  await vi.advanceTimersByTimeAsync(11000);
  expect(send).toHaveBeenCalledTimes(2);
  sender.offer(snapshot(2));
  sender.offer(snapshot(3));
  sender.stop();
  await settle();
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2][2].aborted).toBe(true);
  expect(sender.offer(snapshot(4))).toBe(false);
});

test("429 uses the receiver's two-second backoff; switching binding cancels a queued retry", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      new RequestFailure({ error: { code: "RATE_LIMITED", retryable: true } }),
    )
    .mockImplementation(async (b, body) => receipt(b, body));
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding());
  sender.offer(snapshot(1));
  await vi.advanceTimersByTimeAsync(1999);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
  send.mockRejectedValueOnce(
    new RequestFailure({
      error: { code: "SERVICE_UNAVAILABLE", retryable: true },
    }),
  );
  sender.offer(snapshot(2));
  await settle();
  sender.bind(binding(2));
  sender.offer(snapshot(3));
  await settle();
  await vi.advanceTimersByTimeAsync(5000);
  expect(send.mock.calls.map((c) => c[1].seq)).toEqual([1, 1, 2, 3]);
  sender.stop();
});

test("final starts without awaiting Stop and has one fixed request deadline", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    (_b, _body, signal: AbortSignal) =>
      new Promise<any>((_r, reject) =>
        signal.addEventListener("abort", () =>
          reject(new DOMException("cancelled", "AbortError")),
        ),
      ),
  );
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding());
  sender.offer(snapshot(1, true));
  sender.unbind(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][2].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(send.mock.calls[0][2].aborted).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  sender.stop();
});

test("terminal rejection or invalid receipt disables transport; invalid/horizon samples never queue", async () => {
  const send = vi.fn(async () => ({
    session_id: "wrong",
    meter_start_generation: 1,
    metrics_seq: 1,
    closed: false,
  }));
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding());
  for (const elapsed_ms of [-1, NaN, Infinity, 604800001])
    expect(sender.offer({ ...snapshot(1), elapsed_ms })).toBe(false);
  sender.offer(snapshot(1));
  await settle();
  expect(send).toHaveBeenCalledTimes(1);
  expect(sender.offer(snapshot(2))).toBe(false);
  sender.stop();
});

test("v2 packets preserve immutable phases and originating server generation across retry", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("lost ACK"))
    .mockImplementation(async (b, body) => receipt(b, body));
  const sender = createPlaybackMetricsSender(send);
  sender.bind({ ...binding(5), version: 2 });
  const input = {
    ...snapshot(1),
    startup_phases: { preparation_ms: 700, loading_ms: 300, unobserved_ms: 0 },
    first_frame: {
      elapsed_ms: 950,
      confirmed_elapsed_ms: 1000,
      evidence: "video_frame_callback" as const,
    },
    first_frame_plan_generation: 3,
  };
  expect(sender.offer(input)).toBe(true);
  input.startup_phases.preparation_ms = 999;
  input.first_frame_plan_generation = 99;
  await vi.advanceTimersByTimeAsync(1000);
  const packet = send.mock.calls[0][1];
  expect(packet).toBe(send.mock.calls[1][1]);
  expect(packet).toMatchObject({
    version: 2,
    plan_generation: 5,
    first_frame_plan_generation: 3,
    startup_phases: { preparation_ms: 700, loading_ms: 300, unobserved_ms: 0 },
  });
  expect(Object.isFrozen(packet.startup_phases)).toBe(true);
  expect(Object.isFrozen(packet.first_frame)).toBe(true);
  expect(JSON.stringify(packet).length).toBeLessThan(4096);
  sender.stop();
});

test("v2 rejects missing, nonpartitioning or invalid phases and unpaired frame generations", () => {
  const sender = createPlaybackMetricsSender(async (b, body) =>
    receipt(b, body),
  );
  sender.bind({ ...binding(3), version: 2 });
  for (const invalid of [
    { startup_phases: undefined },
    {
      startup_phases: {
        preparation_ms: -1,
        loading_ms: 5001,
        unobserved_ms: 0,
      },
    },
    {
      startup_phases: { preparation_ms: 5000, loading_ms: 1, unobserved_ms: 0 },
    },
    {
      startup_phases: {
        preparation_ms: 4999.5,
        loading_ms: 0.5,
        unobserved_ms: 0,
      },
    },
    {
      startup_phases: { preparation_ms: NaN, loading_ms: 0, unobserved_ms: 0 },
    },
    { first_frame_plan_generation: 1 },
    {
      first_frame: {
        elapsed_ms: 0,
        confirmed_elapsed_ms: 5000,
        evidence: "video_frame_callback",
      },
    },
    ...[0, 4, 1.5, NaN].map((first_frame_plan_generation) => ({
      first_frame: {
        elapsed_ms: 0,
        confirmed_elapsed_ms: 5000,
        evidence: "video_frame_callback",
      },
      first_frame_plan_generation,
    })),
  ])
    expect(sender.offer({ ...snapshot(1), ...invalid } as any)).toBe(false);
  expect(sender.offer(snapshot(1))).toBe(true);
  sender.stop();
});

test("v1 strips v2-only fields even when a complete v2 local receipt exists", async () => {
  const send = vi.fn(async (b, body) => receipt(b, body));
  const sender = createPlaybackMetricsSender(send);
  sender.bind(binding(3));
  expect(
    sender.offer({
      ...snapshot(1),
      first_frame_plan_generation: 1,
      first_frame: {
        elapsed_ms: 900,
        confirmed_elapsed_ms: 1000,
        evidence: "video_frame_callback",
      },
    }),
  ).toBe(true);
  const body = send.mock.calls[0][1];
  expect(body.version).toBe(1);
  expect(body).not.toHaveProperty("startup_phases");
  expect(body).not.toHaveProperty("first_frame_plan_generation");
  expect(body.first_frame).toEqual({
    elapsed_ms: 900,
    confirmed_elapsed_ms: 1000,
    evidence: "video_frame_callback",
  });
  sender.stop();
});
