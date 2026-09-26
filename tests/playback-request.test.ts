import { afterEach, expect, it, vi } from "vitest";
import {
  PlaybackRequests,
  requestPlayback,
} from "../apps/web/src/playback-request";
import { RequestFailure } from "../apps/web/src/errors";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";

afterEach(() => vi.useRealTimers());
const input: PlaybackRequest = {
  room_id: "room",
  media_generation: 1,
  mode: "auto",
  position_ms: 42,
  audio_index: null,
  capabilities: null,
};
it("reuses one key and payload after a lost response and pending preparation", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("network lost"))
    .mockRejectedValueOnce(
      new RequestFailure({ error: { code: "PLAYBACK_REQUEST_IN_PROGRESS" } }),
    )
    .mockResolvedValueOnce({ session_id: "only-session" } as PlaybackPlan);
  const pending = requestPlayback(send, input);
  await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).session_id).toBe("only-session");
  expect(send).toHaveBeenCalledTimes(3);
  const payloads = send.mock.calls.map(([body]) => body);
  expect(payloads[0].idempotency_key).toBeTruthy();
  expect(payloads[1]).toEqual(payloads[0]);
  expect(payloads[2]).toEqual(payloads[0]);
  expect(input.idempotency_key).toBeUndefined();
});
it("does not retry authorization, conflicts or exhausted preparation", async () => {
  for (const code of [
    "FORBIDDEN",
    "PLAYBACK_REQUEST_CONFLICT",
    "PLAYBACK_REQUEST_RETRY_EXHAUSTED",
  ]) {
    const error = new RequestFailure({ error: { code, retryable: true } });
    const send = vi.fn().mockRejectedValue(error);
    await expect(requestPlayback(send, input)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it("retries transient preparation failures with the same key and bounded attempts", async () => {
  vi.useFakeTimers();
  for (const code of [
    "SOURCE_PROBE_FAILED",
    "UPSTREAM_PLAYBACK_FAILED",
    "MEDIA_UNAVAILABLE",
    "PLAYBACK_REQUEST_INTERRUPTED",
  ]) {
    const error = new RequestFailure({ error: { code, retryable: true } });
    const send = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ session_id: "recovered" });
    const result = requestPlayback(send, input);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).session_id).toBe("recovered");
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
    const alwaysFails = vi.fn().mockRejectedValue(error);
    const failure = expect(requestPlayback(alwaysFails, input)).rejects.toBe(
      error,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await failure;
    expect(alwaysFails).toHaveBeenCalledTimes(3);
  }
});
it("bounds transport retries and preparation waiting", async () => {
  vi.useFakeTimers();
  const network = vi.fn().mockRejectedValue(new TypeError("offline"));
  const failure = expect(requestPlayback(network, input)).rejects.toThrow(
    "offline",
  );
  await vi.advanceTimersByTimeAsync(3000);
  await failure;
  expect(network).toHaveBeenCalledTimes(3);
  const pending = vi
    .fn()
    .mockRejectedValue(
      new RequestFailure({ error: { code: "PLAYBACK_REQUEST_IN_PROGRESS" } }),
    );
  const timeout = expect(requestPlayback(pending, input)).rejects.toThrow(
    "播放准备超时",
  );
  await vi.advanceTimersByTimeAsync(66000);
  await timeout;
  expect(pending.mock.calls.length).toBeLessThanOrEqual(65);
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
it("surfaces exhausted attempts after same-key transient retries and then revokes", async () => {
  vi.useFakeTimers();
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      new RequestFailure({
        error: { code: "PLAYBACK_REQUEST_INTERRUPTED", retryable: true },
      }),
    )
    .mockRejectedValueOnce(
      new RequestFailure({
        error: { code: "SOURCE_PROBE_FAILED", retryable: true },
      }),
    )
    .mockRejectedValueOnce(
      new RequestFailure({
        error: {
          code: "PLAYBACK_REQUEST_RETRY_EXHAUSTED",
          retryable: false,
          message: "重试已用尽",
        },
      }),
    );
  const cancel = vi.fn().mockResolvedValue(undefined);
  const requests = new PlaybackRequests(send, cancel, storage(), "user");
  const failure = expect(requests.prepare(input)).rejects.toThrow("重试已用尽");
  await vi.advanceTimersByTimeAsync(3000);
  await failure;
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[2][0]).toEqual(send.mock.calls[0][0]);
  expect(cancel).toHaveBeenCalledWith(
    send.mock.calls[0][0].idempotency_key,
    expect.any(AbortSignal),
  );
});
it("revokes an unknown committed session after the transport budget is exhausted", async () => {
  vi.useFakeTimers();
  const active = new Set<string>();
  const send = vi.fn(async (body: PlaybackRequest) => {
    active.add(body.idempotency_key!);
    throw new TypeError("lost response");
  });
  const cancel = vi.fn(async (key: string) => {
    active.delete(key);
  });
  const saved = storage();
  const requests = new PlaybackRequests(send, cancel, saved, "user");
  for (let i = 0; i < 10; i++) {
    const failed = expect(requests.prepare(input)).rejects.toThrow(
      "lost response",
    );
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(active.size).toBe(0);
  }
  expect(cancel).toHaveBeenCalledTimes(10);
  expect(saved.getItem("user")).toBe("[]");
});
it("persists failed cleanup across reload and blocks new preparation until acknowledged", async () => {
  vi.useFakeTimers();
  const saved = storage();
  const send = vi.fn().mockRejectedValue(new TypeError("offline"));
  const cancel = vi.fn().mockRejectedValue(new TypeError("cleanup offline"));
  const requests = new PlaybackRequests(send, cancel, saved, "user");
  const failure = expect(requests.prepare(input)).rejects.toThrow("offline");
  await vi.advanceTimersByTimeAsync(3000);
  await failure;
  const key = send.mock.calls[0][0].idempotency_key;
  expect(JSON.parse(saved.getItem("user")!)).toEqual([key]);
  const reloaded = new PlaybackRequests(send, cancel, saved, "user");
  await expect(reloaded.prepare(input)).rejects.toThrow("cleanup offline");
  expect(send).toHaveBeenCalledTimes(3);
  cancel.mockResolvedValue(undefined);
  send.mockResolvedValue({ session_id: "new-session" });
  await reloaded.prepare(input);
  expect(cancel.mock.calls.at(-1)![0]).toBe(key);
  expect(send.mock.calls.at(-1)![0].idempotency_key).not.toBe(key);
  await reloaded.stop();
  expect(saved.getItem("user")).toBe("[]");
});
it("revokes timed out or superseded preparation even without a session response", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const send = vi
    .fn()
    .mockRejectedValue(
      new RequestFailure({ error: { code: "PLAYBACK_REQUEST_IN_PROGRESS" } }),
    );
  const requests = new PlaybackRequests(send, cancel, storage(), "user");
  const failure = expect(requests.prepare(input)).rejects.toThrow(
    "播放准备超时",
  );
  await vi.advanceTimersByTimeAsync(66000);
  await failure;
  expect(cancel).toHaveBeenCalledWith(
    send.mock.calls[0][0].idempotency_key,
    expect.any(AbortSignal),
  );
  let finish!: (plan: PlaybackPlan) => void;
  send.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const obsolete = expect(requests.prepare(input)).rejects.toThrow(
    "播放准备已取消",
  );
  await vi.advanceTimersByTimeAsync(0);
  await requests.stop();
  finish({ session_id: "late" } as PlaybackPlan);
  await obsolete;
});
