import { afterEach, expect, it, vi } from "vitest";
import type { PlatformLogin } from "../apps/web/src/features/account/platform-account.api";
import { createPlatformLoginFlow } from "../apps/web/src/features/account/platform-login-flow";
import { RequestFailure } from "../apps/web/src/errors";

const id = "00000000-0000-0000-0000-000000000001";
const key = "synthetic-qr-capability-0123456789";
const payload = `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${key}&from=`;
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
function flow(
  start: (key: string, signal: AbortSignal) => Promise<PlatformLogin>,
  poll: (id: string, signal: AbortSignal) => Promise<PlatformLogin>,
) {
  const change = vi.fn(),
    cancel = vi.fn(async () => {}),
    confirmed = vi.fn();
  const login = createPlatformLoginFlow({
    current: () => true,
    start,
    poll,
    cancel,
    change,
    confirmed,
    uuid: () => id,
    now: () => Date.now(),
  });
  return { login, change, cancel, confirmed };
}
afterEach(() => vi.useRealTimers());

it("accepts the current scan URL and retains its exact QR across payload-free pending polls", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const start = vi.fn(async () => response());
  const poll = vi
    .fn<() => Promise<PlatformLogin>>()
    .mockResolvedValueOnce(
      response({ qr_payload: null, server_time: 3000, next_poll_at: 6000 }),
    )
    .mockResolvedValueOnce(
      response({
        qr_payload: null,
        stage: "scanned",
        server_time: 6000,
        next_poll_at: 9000,
      }),
    )
    .mockResolvedValueOnce(
      response({
        status: "confirmed",
        stage: null,
        qr_payload: null,
        server_time: 9000,
      }),
    );
  const { login, change, confirmed } = flow(start, poll);
  await login.start();
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload,
    stage: "waiting",
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload,
    stage: "waiting",
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload,
    stage: "scanned",
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0].phase).toBe("confirmed");
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(poll).toHaveBeenCalledTimes(3);
  await login.close();
});

it("keeps a compatible start QR when the server intentionally omits its payload from a poll", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const qr_payload = `https://passport.bilibili.com/h5-app/passport/login?oauthKey=${key}`;
  const poll = vi.fn(async () =>
    response({ qr_payload: null, server_time: 3000, next_poll_at: 6000 }),
  );
  const { login, change } = flow(async () => response({ qr_payload }), poll);
  await login.start();
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload: qr_payload,
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload: qr_payload,
  });
  await login.close();
});

it("never accepts a missing start QR or borrows one from a completed flow", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const poll = vi.fn(async () => response({ qr_payload: null }));
  const start = vi.fn(async () => response({ qr_payload: null }));
  const first = flow(start, poll);
  await first.login.start();
  expect(first.change.mock.calls.at(-1)?.[0].phase).toBe("uncertain");
  expect(first.change.mock.calls.some(([s]) => s.payload)).toBe(false);
  await vi.advanceTimersByTimeAsync(9000);
  expect(poll).not.toHaveBeenCalled();
  await first.login.close();

  start
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(response({ qr_payload: null }));
  const second = flow(start, poll);
  await second.login.start();
  expect(second.change.mock.calls.at(-1)?.[0].phase).toBe("pending");
  await second.login.close();
  const third = flow(start, poll);
  await third.login.start();
  expect(third.change.mock.calls.at(-1)?.[0].phase).toBe("uncertain");
  expect(third.change.mock.calls.some(([s]) => s.payload)).toBe(false);
  await vi.advanceTimersByTimeAsync(9000);
  expect(poll).not.toHaveBeenCalled();
  await third.login.close();
});

it.each([
  `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=${key}&from=main_web`,
  `https://passport.bilibili.com/h5-app/passport/login?oauthKey=${key}`,
  `https://passport.bilibili.com/h5-app/passport/login?qrcode_key=${key}`,
])(
  "retains exactly bound compatible passport QR payload %s",
  async (qr_payload) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { login, change } = flow(
      async () => response({ qr_payload }),
      async () => response({ qr_payload: null }),
    );
    await login.start();
    expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "pending",
      payload: qr_payload,
    });
    await login.close();
  },
);

it.each([
  payload.replace("https://", "http://"),
  payload.replace("account.bilibili.com", "account.bilibili.com.evil.invalid"),
  payload.replace("account.bilibili.com", "passport.bilibili.com"),
  payload.replace("account.bilibili.com", "user@account.bilibili.com"),
  payload.replace("account.bilibili.com", "account.bilibili.com:444"),
  payload.replace("scan-web", "scan-web/other"),
  payload.replace("callback=close", "callback=https%3A%2F%2Fevil.invalid"),
  payload.replace("callback=close&", ""),
  payload.replace("qrcode_key=", "oauthKey="),
  `${payload}&callback=close`,
  `${payload}&navhide=1`,
  `${payload}&redirect=other`,
  payload.replace("from=", "from=unknown"),
  `${payload}&from=`,
  `${payload}&qrcode_key=${key}`,
  `${payload}&qrcode_key=different-synthetic-capability`,
  `${payload}&oauthKey=${key}`,
  `${payload}&oauthKey=different-synthetic-capability`,
  `https://passport.bilibili.com/h5-app/passport/login/scan?oauthKey=${key}`,
  `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1`,
  `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=short`,
  `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${key}%0a`,
  `https://passport.bilibili.com/h5-app/passport/login/scan/other?qrcode_key=${key}`,
  `https://passport.bilibili.com.evil.invalid/h5-app/passport/login/scan?qrcode_key=${key}`,
  `https://user@passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${key}`,
  `https://passport.bilibili.com:444/h5-app/passport/login/scan?qrcode_key=${key}`,
  `${payload}#fragment`,
  `https://passport.bilibili.com/h5-app/passport/login?oauthKey=${key}&oauthKey=${key}`,
  `https://passport.bilibili.com/h5-app/passport/login?oauthKey=${key}&qrcode_key=${key}`,
  "https://passport.bilibili.com/h5-app/passport/login?from=pc",
])(
  "rejects malformed or ambiguous QR capabilities without scheduling polling: %s",
  async (qr_payload) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const poll = vi.fn(async () => response());
    const { login, change } = flow(async () => response({ qr_payload }), poll);
    await login.start();
    expect(change.mock.calls.at(-1)?.[0].phase).toBe("uncertain");
    expect(change.mock.calls.at(-1)?.[0].code).toBe(
      "PLATFORM_LOGIN_RESPONSE_INVALID",
    );
    expect(change.mock.calls.at(-1)?.[0].message).toContain("未通过安全校验");
    expect(change.mock.calls.at(-1)?.[0].message).not.toContain(qr_payload);
    expect(change.mock.calls.some(([s]) => s.payload)).toBe(false);
    await vi.advanceTimersByTimeAsync(12000);
    expect(poll).not.toHaveBeenCalled();
    await login.close();
  },
);

it("shows definitive generation failure with safe diagnostics and requires a fresh consent flow", async () => {
  const requestId = "00000000-0000-4000-8000-000000000002";
  const poll = vi.fn(async () => response());
  const { login, change, cancel } = flow(async () => {
    throw new RequestFailure({
      error: {
        code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
        message: "private URL or QR key",
        request_id: requestId,
        retryable: true,
      },
    });
  }, poll);
  await login.start();
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "failed",
    code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
    requestId,
  });
  expect(change.mock.calls.at(-1)?.[0].message).not.toMatch(/private|QR key/);
  expect(poll).not.toHaveBeenCalled();
  await login.close();
  expect(cancel).toHaveBeenCalledWith(id);
});

it("retains the validated QR through an upstream poll failure and retries the same login", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const requestId = "00000000-0000-4000-8000-000000000002";
  const start = vi.fn(async () => response());
  const poll = vi
    .fn<() => Promise<PlatformLogin>>()
    .mockRejectedValueOnce(
      new RequestFailure({
        error: {
          code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
          request_id: requestId,
          retryable: true,
        },
      }),
    )
    .mockResolvedValueOnce(
      response({ qr_payload: null, server_time: 3000, next_poll_at: 6000 }),
    );
  const { login, change } = flow(start, poll);
  await login.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "uncertain",
    payload,
    code: "PLATFORM_LOGIN_UPSTREAM_FAILED",
    requestId,
  });
  await login.start();
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(poll).toHaveBeenLastCalledWith(id, expect.any(AbortSignal));
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload,
  });
  await login.close();
});

function rateLimited(retryAfterMs?: number) {
  return new RequestFailure({
    error: {
      code: "RATE_LIMITED",
      message: "private upstream response",
      request_id: "00000000-0000-4000-8000-000000000002",
      retryable: true,
      retry_after_ms: retryAfterMs,
    },
  });
}

it("honors the server cooldown and retries the original creation only after an explicit click", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const start = vi
    .fn<(key: string, signal: AbortSignal) => Promise<PlatformLogin>>()
    .mockRejectedValueOnce(rateLimited(6500))
    .mockResolvedValueOnce(response({ server_time: 6500, next_poll_at: 9500 }));
  const poll = vi.fn(async () => response());
  const { login, change } = flow(start, poll);
  await login.start();
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "uncertain",
    code: "RATE_LIMITED",
    retryAfterSeconds: 7,
  });
  expect(change.mock.calls.at(-1)?.[0].message).not.toContain("private");
  await login.start();
  await vi.advanceTimersByTimeAsync(6000);
  expect(change.mock.calls.at(-1)?.[0].retryAfterSeconds).toBe(1);
  await login.start();
  expect(start).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(change.mock.calls.at(-1)?.[0].retryAfterSeconds).toBeUndefined();
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).not.toHaveBeenCalled();
  await login.start();
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls.map((args) => args[0])).toEqual([id, id]);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload,
  });
  await login.close();
});

it("keeps the exact QR during a limited poll and resumes polling without another creation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const start = vi.fn(async () => response());
  const poll = vi
    .fn<() => Promise<PlatformLogin>>()
    .mockRejectedValueOnce(rateLimited(5000))
    .mockResolvedValueOnce(
      response({ qr_payload: null, server_time: 8000, next_poll_at: 11000 }),
    );
  const { login, change } = flow(start, poll);
  await login.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    payload,
    retryAfterSeconds: 5,
  });
  await login.start();
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "uncertain",
    payload,
  });
  expect(poll).toHaveBeenCalledTimes(1);
  await login.start();
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "pending",
    payload,
  });
  await login.close();
});

it("expires the original QR during cooldown without extending it or creating another", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const start = vi.fn(async () => response({ expires_at: 5000 }));
  const poll = vi.fn(async () => {
    throw rateLimited(60000);
  });
  const { login, change } = flow(start, poll);
  await login.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(change.mock.calls.at(-1)?.[0].payload).toBe(payload);
  await vi.advanceTimersByTimeAsync(2000);
  expect(change.mock.calls.at(-1)?.[0]).toEqual({
    phase: "expired",
    message: "二维码已过期，请重新确认登录",
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(1);
  await login.close();
});

it("close cancels the original request and fences cooldown updates and retries", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const start = vi.fn(async () => {
    throw rateLimited(60000);
  });
  const poll = vi.fn(async () => response());
  const { login, change, cancel } = flow(start, poll);
  await login.start();
  await login.close();
  expect(cancel).toHaveBeenCalledWith(id);
  const updates = change.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  await login.start();
  expect(change).toHaveBeenCalledTimes(updates);
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).not.toHaveBeenCalled();
});

it("rejects a poll that attempts to replace the QR capability of the same login", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const poll = vi.fn(async () =>
    response({
      qr_payload: payload.replace(key, "different-synthetic-capability"),
    }),
  );
  const { login, change } = flow(async () => response(), poll);
  await login.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(change.mock.calls.at(-1)?.[0].phase).toBe("uncertain");
  expect(
    change.mock.calls.some(([s]) => s.payload?.includes("different")),
  ).toBe(false);
  await login.close();
});

it("close fences a delayed payload-free poll and does not generate a new QR", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let resolve!: (value: PlatformLogin) => void;
  const start = vi.fn(async () => response());
  const poll = vi.fn(() => new Promise<PlatformLogin>((r) => (resolve = r)));
  const { login, change, cancel } = flow(start, poll);
  await login.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(poll).toHaveBeenCalledTimes(1);
  await login.close();
  expect(cancel).toHaveBeenCalledWith(id);
  const before = change.mock.calls.length;
  resolve(response({ qr_payload: null, stage: "scanned" }));
  await vi.advanceTimersByTimeAsync(12000);
  expect(change).toHaveBeenCalledTimes(before);
  expect(start).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(1);
});

it.each(["transient", "cooldown-ended"])(
  "expires the retained QR at its original deadline after %s without retrying",
  async (failureKind) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const start = vi.fn(async () => response({ expires_at: 15000 }));
    const poll = vi.fn(async () => {
      if (failureKind === "cooldown-ended") throw rateLimited(5000);
      throw new TypeError("temporary network failure");
    });
    const { login, change } = flow(start, poll);
    await login.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "uncertain",
      payload,
    });
    await vi.advanceTimersByTimeAsync(11999);
    expect(change.mock.calls.at(-1)?.[0].payload).toBe(payload);
    await vi.advanceTimersByTimeAsync(1);
    expect(change.mock.calls.at(-1)?.[0]).toEqual({
      phase: "expired",
      message: "二维码已过期，请重新确认登录",
    });
    await login.start();
    await vi.advanceTimersByTimeAsync(300000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await login.close();
  },
);

it("expires a QR while its poll is pending and fences a late confirmation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let resolve!: (value: PlatformLogin) => void;
  const poll = vi.fn(
    (_id: string, _signal: AbortSignal) =>
      new Promise<PlatformLogin>((done) => {
        resolve = done;
      }),
  );
  const { login, change, confirmed } = flow(
    async () => response({ expires_at: 5000 }),
    poll,
  );
  await login.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(change.mock.calls.at(-1)?.[0].phase).toBe("expired");
  expect(poll.mock.calls[0][1].aborted).toBe(true);
  resolve(response({ status: "confirmed", qr_payload: null }));
  await vi.advanceTimersByTimeAsync(1);
  expect(change.mock.calls.at(-1)?.[0].phase).toBe("expired");
  expect(confirmed).not.toHaveBeenCalled();
  await login.close();
});

it("clears the independent QR deadline on close and terminal completion", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  for (const closeEarly of [true, false]) {
    const { login, change } = flow(
      async () => response({ expires_at: 15000 }),
      async () => response({ status: "confirmed", qr_payload: null }),
    );
    await login.start();
    if (closeEarly) await login.close();
    else await vi.advanceTimersByTimeAsync(3000);
    const updates = change.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300000);
    expect(change).toHaveBeenCalledTimes(updates);
    await login.close();
  }
});

it("checks the deadline before applying a late poll when browser timers were suspended", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let resolve!: (value: PlatformLogin) => void;
  const poll = vi.fn(
    () =>
      new Promise<PlatformLogin>((done) => {
        resolve = done;
      }),
  );
  const { login, change, confirmed } = flow(
    async () => response({ expires_at: 5000 }),
    poll,
  );
  await login.start();
  await vi.advanceTimersByTimeAsync(3000);
  // Move the supplied clock without executing the pending deadline callback.
  vi.setSystemTime(10000);
  resolve(response({ status: "confirmed", qr_payload: null }));
  await Promise.resolve();
  await Promise.resolve();
  expect(change.mock.calls.at(-1)?.[0].phase).toBe("expired");
  expect(confirmed).not.toHaveBeenCalled();
  await login.close();
});
