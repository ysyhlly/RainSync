import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  platformAccountApi,
  type PlatformLogin,
} from "../apps/web/src/features/account/platform-account.api";
import type { ApiClient } from "../apps/web/src/shared/api/client";
import { createPlatformLoginFlow } from "../apps/web/src/features/account/platform-login-flow";

const id = "00000000-0000-0000-0000-000000000001";
const otherId = "00000000-0000-0000-0000-000000000002";
const payload =
  "https://account.bilibili.com/h5/account-h5/auth/scan-web?callback=close&qrcode_key=synthetic-qr-capability-0123456789";
function response(extra: Partial<PlatformLogin> = {}): PlatformLogin {
  return {
    id,
    provider: "bilibili",
    status: "pending",
    stage: "waiting",
    qr_payload: payload,
    expires_at: 180000,
    server_time: 0,
    next_poll_at: 3000,
    ...extra,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Options = Parameters<typeof createPlatformLoginFlow>[0];
function flow(overrides: Partial<Options> = {}) {
  const start = vi.fn<Options["start"]>(async () => response());
  const poll = vi.fn<Options["poll"]>(async () =>
    response({ qr_payload: null }),
  );
  const cancel = vi.fn<Options["cancel"]>(async () => undefined);
  const change = vi.fn<Options["change"]>();
  const confirmed = vi.fn();
  const options: Options = {
    current: () => true,
    start,
    poll,
    cancel,
    change,
    confirmed,
    uuid: () => id,
    now: () => Date.now(),
    ...overrides,
  };
  return {
    login: createPlatformLoginFlow(options),
    start,
    poll,
    cancel,
    change,
    confirmed,
  };
}
function poisoned() {
  const get = vi.fn(() => {
    throw Error("Retired receipt was touched");
  });
  const raw = Object.fromEntries(
    Object.keys(response()).map((name) => [name, undefined]),
  );
  for (const name of Object.keys(raw))
    Object.defineProperty(raw, name, { get });
  return { raw, get };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

const invalid: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["boolean", true],
  ["number", 1],
  ["string", "receipt"],
  ["array", []],
  ["decorated array", Object.assign([], response())],
  ["empty record", {}],
  ["wrong id", response({ id: otherId })],
  ["wrong provider", { ...response(), provider: "youtube" }],
  ["unknown status", { ...response(), status: "success" }],
  [
    "missing stage",
    Object.fromEntries(
      Object.entries(response()).filter(([name]) => name !== "stage"),
    ),
  ],
  ["undefined stage", { ...response(), stage: undefined }],
  ["unknown stage", { ...response(), stage: "confirmed" }],
  ["numeric stage", { ...response(), stage: 0 }],
  ["object stage", { ...response(), stage: {} }],
  ["missing payload", { ...response(), qr_payload: undefined }],
  ["object payload", { ...response(), qr_payload: {} }],
  ...["expires_at", "server_time", "next_poll_at"].flatMap(
    (field): [string, unknown][] =>
      [undefined, "3000", 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
        (value) => [
          `${field}=${String(value)}`,
          { ...response(), [field]: value },
        ],
      ),
  ),
];
it.each(["start", "poll"] as const)(
  "rejects current malformed %s receipts without changing capability or automatically retrying",
  async (operation) => {
    for (const [label, raw] of invalid) {
      const f = flow();
      if (operation === "start") f.start.mockResolvedValueOnce(raw);
      else f.poll.mockResolvedValueOnce(raw);
      await f.login.start();
      if (operation === "poll") await vi.advanceTimersByTimeAsync(3000);
      expect(f.change.mock.calls.at(-1)?.[0], label).toMatchObject({
        phase: "uncertain",
        code: "PLATFORM_LOGIN_RESPONSE_INVALID",
      });
      expect(f.change.mock.calls.at(-1)?.[0].payload, label).toBe(
        operation === "poll" ? payload : undefined,
      );
      expect(f.confirmed, label).not.toHaveBeenCalled();
      const requests = f.poll.mock.calls.length;
      await vi.advanceTimersByTimeAsync(12000);
      expect(f.poll, label).toHaveBeenCalledTimes(requests);
      expect(f.start, label).toHaveBeenCalledTimes(1);
      await f.login.close();
    }
  },
);

it.each([null, "waiting", "scanned"] as const)(
  "preserves the DTO stage %s and the pending null-stage fallback",
  async (stage) => {
    const f = flow({ start: async () => response({ stage }) });
    await f.login.start();
    expect(f.change.mock.calls.at(-1)?.[0]).toEqual({
      phase: "pending",
      stage: stage ?? "waiting",
      payload,
    });
    await f.login.close();
  },
);

it("copies each whitelisted start/poll field once and never enumerates extra secret getters", async () => {
  const startRaw = response();
  const pollRaw = response({
    qr_payload: null,
    stage: "scanned",
    server_time: 3000,
    next_poll_at: 6000,
  });
  const reads: ReturnType<typeof vi.fn>[] = [];
  const extra = vi.fn(() => {
    throw Error("Extra secret must not be read");
  });
  function withGetters(raw: PlatformLogin) {
    const receipt = {};
    for (const name of Object.keys(raw) as (keyof PlatformLogin)[]) {
      const get = vi.fn(() => raw[name]);
      reads.push(get);
      Object.defineProperty(receipt, name, { enumerable: true, get });
    }
    Object.defineProperty(receipt, "secret", { enumerable: true, get: extra });
    return receipt;
  }
  const f = flow();
  f.start.mockResolvedValueOnce(withGetters(startRaw));
  f.poll
    .mockResolvedValueOnce(withGetters(pollRaw))
    .mockResolvedValueOnce(response({ status: "confirmed", qr_payload: null }));
  await f.login.start();
  Object.assign(startRaw, {
    id: otherId,
    qr_payload: "https://invalid.test/private",
    stage: "scanned",
    next_poll_at: 1,
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.poll).toHaveBeenLastCalledWith(id, expect.any(AbortSignal));
  expect(f.change.mock.calls.at(-1)?.[0]).toEqual({
    phase: "pending",
    stage: "scanned",
    payload,
  });
  Object.assign(pollRaw, {
    id: otherId,
    status: "failed",
    qr_payload: "changed",
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.poll).toHaveBeenLastCalledWith(id, expect.any(AbortSignal));
  expect(f.confirmed).toHaveBeenCalledTimes(1);
  for (const get of reads) expect(get).toHaveBeenCalledTimes(1);
  expect(extra).not.toHaveBeenCalled();
  expect(f.change.mock.calls.some(([state]) => "secret" in state)).toBe(false);
  await f.login.close();
});

it.each(["start", "poll"] as const)(
  "fences late poisoned %s receipts after retirement, Close, and a newer generation",
  async (operation) => {
    for (const reason of ["identity", "close", "generation"] as const) {
      let current = true;
      const delayed = deferred();
      const poison = poisoned();
      const f = flow({ current: () => current });
      let pending: Promise<void> | undefined;
      if (operation === "start") {
        f.start.mockReturnValueOnce(delayed.promise);
        pending = f.login.start();
      } else {
        f.poll.mockReturnValueOnce(delayed.promise);
        await f.login.start();
        await vi.advanceTimersByTimeAsync(3000);
      }
      const oldSignal = (operation === "start" ? f.start : f.poll).mock
        .calls[0]![1];
      if (reason === "identity") current = false;
      else if (reason === "close") {
        await f.login.close();
        await f.login.close();
      } else await f.login.start();
      if (reason !== "identity") expect(oldSignal.aborted).toBe(true);
      const updates = f.change.mock.calls.length;
      delayed.resolve(poison.raw);
      await pending;
      await Promise.resolve();
      await Promise.resolve();
      expect(poison.get, `${operation}/${reason}`).not.toHaveBeenCalled();
      expect(f.change, `${operation}/${reason}`).toHaveBeenCalledTimes(updates);
      expect(f.confirmed).not.toHaveBeenCalled();
      await f.login.close();
      expect(f.cancel).toHaveBeenCalledTimes(1);
      expect(f.cancel).toHaveBeenCalledWith(id);
    }
  },
);

it.each(["timer", "suspended timer"] as const)(
  "checks the original expiry before touching a late poisoned poll (%s)",
  async (reason) => {
    const delayed = deferred();
    const poison = poisoned();
    const f = flow();
    f.start.mockResolvedValueOnce(response({ expires_at: 5000 }));
    f.poll.mockReturnValueOnce(delayed.promise);
    await f.login.start();
    await vi.advanceTimersByTimeAsync(3000);
    if (reason === "timer") await vi.advanceTimersByTimeAsync(2000);
    else vi.setSystemTime(10000);
    delayed.resolve(poison.raw);
    await Promise.resolve();
    await Promise.resolve();
    expect(poison.get).not.toHaveBeenCalled();
    expect(f.change.mock.calls.at(-1)?.[0].phase).toBe("expired");
    expect(f.poll.mock.calls[0]![1].aborted).toBe(true);
    expect(f.confirmed).not.toHaveBeenCalled();
    await f.login.start();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.poll).toHaveBeenCalledTimes(1);
    await f.login.close();
  },
);

it("cancels only once across repeated Close and ignores the unknown cancel receipt", async () => {
  const delayed = deferred();
  const poison = poisoned();
  const f = flow();
  f.cancel.mockReturnValueOnce(delayed.promise);
  await f.login.start();
  const closing = f.login.close();
  await f.login.close();
  await f.login.start();
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.start.mock.calls[0]![1].aborted).toBe(true);
  const updates = f.change.mock.calls.length;
  delayed.resolve(poison.raw);
  await closing;
  await f.login.close();
  await vi.advanceTimersByTimeAsync(300000);
  expect(poison.get).not.toHaveBeenCalled();
  expect(f.change).toHaveBeenCalledTimes(updates);
  expect(f.poll).not.toHaveBeenCalled();
  expect(f.confirmed).not.toHaveBeenCalled();
});

it.each(["start", "poll"] as const)(
  "retries a timed-out %s only on explicit start with the same binding",
  async (operation) => {
    const f = flow();
    const request = operation === "start" ? f.start : f.poll;
    request.mockRejectedValueOnce(
      new DOMException("Synthetic timeout", "TimeoutError"),
    );
    await f.login.start();
    if (operation === "poll") await vi.advanceTimersByTimeAsync(3000);
    expect(f.change.mock.calls.at(-1)?.[0].phase).toBe("uncertain");
    expect(f.change.mock.calls.at(-1)?.[0].payload).toBe(
      operation === "poll" ? payload : undefined,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    await f.login.start();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([key]) => key)).toEqual([id, id]);
    expect(request.mock.calls[0]![1].aborted).toBe(true);
    expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "pending",
      payload,
    });
    await f.login.close();
  },
);

it.each(["confirmed", "expired", "failed"] as const)(
  "clears terminal %s without adding terminal-only stage or QR URL constraints",
  async (status) => {
    const f = flow();
    // Existing semantic checks apply to pending QR capabilities only. A terminal
    // DTO still has string/null payload shape, but its string is never displayed.
    f.poll.mockResolvedValueOnce(
      response({ status, stage: "scanned", qr_payload: "not-a-pending-QR" }),
    );
    await f.login.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.change.mock.calls.at(-1)?.[0].phase).toBe(status);
    expect(f.change.mock.calls.at(-1)?.[0].payload).toBeUndefined();
    expect(f.confirmed).toHaveBeenCalledTimes(status === "confirmed" ? 1 : 0);
    await f.login.start();
    await f.login.close();
    await f.login.close();
    await vi.advanceTimersByTimeAsync(300000);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.poll).toHaveBeenCalledTimes(1);
    expect(f.cancel).not.toHaveBeenCalled();
  },
);

it("preserves QR transport routes, bodies, consent, signals, and untouched unknown receipts", async () => {
  const poison = poisoned();
  const request = vi.fn(async () => poison.raw);
  const api = platformAccountApi(request as ApiClient);
  const controller = new AbortController();
  expect(await api.start(id, controller.signal)).toBe(poison.raw);
  expect(request).toHaveBeenLastCalledWith(
    "/platform-accounts/bilibili/login",
    "POST",
    { idempotency_key: id, consent_to_store: true },
    controller.signal,
  );
  await api.start(id, controller.signal, true);
  expect(request).toHaveBeenLastCalledWith(
    "/platform-accounts/bilibili/login",
    "POST",
    { idempotency_key: id, consent_to_store: true, consent_to_renew: true },
    controller.signal,
  );
  const encodedId = "synthetic/id?";
  expect(await api.poll(encodedId, controller.signal)).toBe(poison.raw);
  expect(request).toHaveBeenLastCalledWith(
    "/platform-accounts/bilibili/login/synthetic%2Fid%3F/poll",
    "POST",
    undefined,
    controller.signal,
  );
  const timeoutSignal = new AbortController().signal;
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(timeoutSignal);
  try {
    expect(await api.cancel(encodedId)).toBe(poison.raw);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10000);
    expect(request).toHaveBeenLastCalledWith(
      "/platform-accounts/bilibili/login/synthetic%2Fid%3F",
      "DELETE",
      undefined,
      timeoutSignal,
    );
    expect(poison.get).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

it.each(["confirmed", "expired", "failed"] as const)(
  "requires complete stage/payload shape even on a current terminal %s receipt",
  async (status) => {
    for (const fields of [
      { stage: undefined },
      { stage: "invalid" },
      { qr_payload: undefined },
      { qr_payload: 7 },
    ]) {
      const f = flow();
      f.poll.mockResolvedValueOnce({ ...response({ status }), ...fields });
      await f.login.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.change.mock.calls.at(-1)?.[0]).toMatchObject({
        phase: "uncertain",
        code: "PLATFORM_LOGIN_RESPONSE_INVALID",
        payload,
      });
      expect(f.confirmed).not.toHaveBeenCalled();
      await f.login.close();
    }
  },
);

it("does not retry failed cancellation or reopen the retired flow", async () => {
  const f = flow();
  const failure = new Error("Synthetic cancel failure");
  f.cancel.mockRejectedValueOnce(failure);
  await f.login.start();
  await expect(f.login.close()).rejects.toBe(failure);
  const updates = f.change.mock.calls.length;
  await f.login.close();
  await f.login.start();
  await vi.advanceTimersByTimeAsync(300000);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.change).toHaveBeenCalledTimes(updates);
  expect(f.poll).not.toHaveBeenCalled();
});
