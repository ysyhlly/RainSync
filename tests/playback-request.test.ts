import { afterEach, expect, it, vi } from "vitest";
import {
  PlaybackRequests,
  PlaybackCancelled,
  PlaybackTimeout,
  requestPlayback,
  waitPlaybackReady,
} from "../apps/web/src/playback-request";
import { RequestFailure } from "../apps/web/src/errors";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";

afterEach(() => vi.useRealTimers());

it("waits for published readiness on one session, tolerating a transient read failure", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ session_id: "s", status: "queued" })
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce({ session_id: "s", status: "preparing" })
    .mockResolvedValueOnce({
      session_id: "s",
      status: "ready",
      complete: false,
    });
  const done = waitPlaybackReady(read, "s", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  await done;
  expect(read).toHaveBeenCalledTimes(4);
  expect(read.mock.calls.every(([id]) => id === "s")).toBe(true);
});

it("cancels readiness polling without reporting a timeout", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const read = vi
    .fn()
    .mockResolvedValue({ session_id: "s", status: "preparing" });
  const rejected = expect(
    waitPlaybackReady(read, "s", controller.signal),
  ).rejects.toBeInstanceOf(PlaybackCancelled);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(200000);
  expect(read).toHaveBeenCalledTimes(1);
});

it("bounds readiness waiting and rejects another session's response", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const wrong = vi
    .fn()
    .mockResolvedValue({ session_id: "other", status: "ready" });
  await expect(
    waitPlaybackReady(wrong, "s", controller.signal),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  const read = vi.fn().mockResolvedValue({ session_id: "s", status: "queued" });
  const expired = expect(
    waitPlaybackReady(read, "s", controller.signal),
  ).rejects.toBeInstanceOf(PlaybackTimeout);
  await vi.advanceTimersByTimeAsync(180000);
  await expired;
  const count = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(count);
});

it("revokes a prepared session when readiness fails rather than creating another", async () => {
  const send = vi
    .fn()
    .mockResolvedValue({ session_id: "s", rebuild_on_seek: true });
  const cancel = vi.fn().mockResolvedValue({});
  const read = vi
    .fn()
    .mockRejectedValue(
      new RequestFailure({ error: { code: "MEDIA_JOB_FAILED" } }),
    );
  const requests = new PlaybackRequests(send, cancel, storage(), "user", read);
  await expect(requests.prepare(input)).rejects.toMatchObject({
    code: "MEDIA_JOB_FAILED",
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith(
    send.mock.calls[0][0].idempotency_key,
    expect.any(AbortSignal),
  );
});
const input: PlaybackRequest = {
  room_id: "room",
  media_generation: 1,
  mode: "auto",
  position_ms: 42,
  audio_index: null,
  capabilities: null,
};
it("polls the advancing room position relative to the plan origin without preparing again", async () => {
  vi.useFakeTimers();
  let position = 12000;
  const send = vi.fn().mockResolvedValue({
    session_id: "s",
    rebuild_on_seek: true,
    timeline_origin_ms: 10000,
  });
  const read = vi
    .fn()
    .mockResolvedValueOnce({ session_id: "s", status: "preparing" })
    .mockResolvedValueOnce({ session_id: "s", status: "ready" });
  const requests = new PlaybackRequests(
    send,
    vi.fn().mockResolvedValue({}),
    storage(),
    "user",
    read,
  );
  const ready = requests.prepare(input, () => position);
  await vi.advanceTimersByTimeAsync(0);
  position = 13000;
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  expect(read.mock.calls.map((call) => call[2])).toEqual([2000, 3000]);
  expect(send).toHaveBeenCalledTimes(1);
});
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
    "CACHE_READ_ONLY",
    "CACHE_PERMISSION_DENIED",
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
    "MEDIA_QUEUE_FULL",
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
  await vi.advanceTimersByTimeAsync(336000);
  await timeout;
  expect(pending.mock.calls.length).toBeLessThanOrEqual(335);
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
  await vi.advanceTimersByTimeAsync(336000);
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

it("distinguishes external cancellation during fetch and backoff from timeout", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const send = vi.fn(
    (_body, signal: AbortSignal) =>
      new Promise<PlaybackPlan>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const result = requestPlayback(send, input, controller.signal);
  const cancelled = expect(result).rejects.toBeInstanceOf(PlaybackCancelled);
  controller.abort();
  await cancelled;
  expect(send).toHaveBeenCalledTimes(1);
  const backoff = new AbortController();
  const failing = vi.fn().mockRejectedValue(new TypeError("lost"));
  const waiting = expect(
    requestPlayback(failing, input, backoff.signal),
  ).rejects.toThrow("播放准备已取消");
  await vi.advanceTimersByTimeAsync(0);
  backoff.abort();
  await waiting;
  await vi.advanceTimersByTimeAsync(1000);
  expect(failing).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("allows all three 45-second server attempts under one key without revocation", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn().mockResolvedValue(undefined);
  let count = 0;
  const send = vi.fn(
    (_body, signal: AbortSignal) =>
      new Promise<PlaybackPlan>((resolve, reject) => {
        const attempt = ++count;
        const timer = setTimeout(
          () =>
            attempt < 3
              ? reject(
                  new RequestFailure({
                    error: {
                      code: "PLAYBACK_REQUEST_INTERRUPTED",
                      retryable: true,
                    },
                  }),
                )
              : resolve({ session_id: "slow-success" } as PlaybackPlan),
          45000,
        );
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const requests = new PlaybackRequests(send, cancel, storage(), "user");
  const pending = requests.prepare(input);
  await vi.advanceTimersByTimeAsync(65000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][1].aborted).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(72000);
  expect((await pending).session_id).toBe("slow-success");
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[2][0]).toEqual(send.mock.calls[0][0]);
  expect(cancel).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds individually stalled HTTP attempts and reports a real timeout", async () => {
  vi.useFakeTimers();
  const send = vi.fn(
    (_body, signal: AbortSignal) =>
      new Promise<PlaybackPlan>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const failure = expect(requestPlayback(send, input)).rejects.toBeInstanceOf(
    PlaybackTimeout,
  );
  await vi.advanceTimersByTimeAsync(197000);
  await failure;
  expect(send).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps superseded failures silent even when their cleanup fails late", async () => {
  vi.useFakeTimers();
  let rejectOld!: (error: Error) => void;
  const send = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    )
    .mockResolvedValue({ session_id: "new-success" });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const requests = new PlaybackRequests(send, cancel, storage(), "user");
  const old = expect(requests.prepare(input)).rejects.toBeInstanceOf(
    PlaybackCancelled,
  );
  await vi.advanceTimersByTimeAsync(0);
  const next = await requests.prepare({ ...input, media_generation: 2 });
  expect(next.session_id).toBe("new-success");
  cancel.mockRejectedValue(new TypeError("old cleanup lost"));
  rejectOld(new TypeError("old response lost"));
  await old;
});

for (const transport of ["lost", "timeout"]) {
  it(`preserves three preparation attempts after ${transport} transport failures`, async () => {
    vi.useFakeTimers();
    let count = 0;
    const send = vi.fn((_body: PlaybackRequest, signal: AbortSignal) => {
      const attempt = ++count;
      if (attempt <= 2) {
        if (transport === "lost") return Promise.reject(new TypeError("lost"));
        return new Promise<PlaybackPlan>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return new Promise<PlaybackPlan>((resolve, reject) => {
        setTimeout(
          () =>
            attempt < 5
              ? reject(
                  new RequestFailure({
                    error: {
                      code: "PLAYBACK_REQUEST_INTERRUPTED",
                      retryable: true,
                    },
                  }),
                )
              : resolve({ session_id: "third-preparation" } as PlaybackPlan),
          45000,
        );
      });
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const requests = new PlaybackRequests(send, cancel, storage(), "user");
    const result = requests.prepare(input);
    await vi.advanceTimersByTimeAsync(269000);
    expect((await result).session_id).toBe("third-preparation");
    expect(send).toHaveBeenCalledTimes(5);
    for (const [body] of send.mock.calls)
      expect(body).toEqual(send.mock.calls[0][0]);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
}
