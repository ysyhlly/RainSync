import { afterEach, expect, it, vi } from "vitest";
import { RequestFailure } from "../apps/web/src/errors";
import {
  createOAuthFlow,
  validateOAuthLogin,
  validateOAuthStatus,
} from "../apps/web/src/features/account/platform-oauth-flow";
import {
  platformOAuthApi,
  type OAuthLogin,
  type OAuthStatus,
} from "../apps/web/src/features/account/platform-oauth.api";
import {
  bilibiliRenewalApi,
  validateBilibiliRenewal,
} from "../apps/web/src/features/account/platform-renewal.api";
const id = "00000000-0000-0000-0000-000000000001",
  state = "a".repeat(64);
function login(extra: Partial<OAuthLogin> = {}): OAuthLogin {
  return {
    id,
    provider: "douyin",
    status: "pending",
    mode: "web",
    stage: null,
    authorization_url: `https://open.douyin.com/platform/oauth/connect/?client_key=fixture&state=${state}`,
    qr_payload: null,
    expires_at: 181000,
    next_poll_at: 4000,
    server_time: 1000,
    ...extra,
  };
}
function status(): OAuthStatus {
  return {
    provider: "douyin",
    id: null,
    revision: null,
    state: "revoked",
    available: false,
    missing_prerequisites: ["approved_developer_application"],
    authorization_kind: "official_oauth",
    playback_session: false,
    authorization_mode: "web",
    scopes: [],
    access_expires_at: null,
    refresh_expires_at: null,
    auto_renew: false,
    renewal_state: "disabled",
    next_refresh_at: null,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());
it("OAuth API is separate, revision-bound and sends explicit renewal choice", async () => {
  const api = vi.fn().mockResolvedValue({});
  const oauth = platformOAuthApi(api, "douyin");
  await oauth.start(id, null, false);
  expect(api).toHaveBeenLastCalledWith(
    "/platform-accounts/douyin/oauth/login",
    "POST",
    {
      idempotency_key: id,
      expected_revision: null,
      consent_to_store: true,
      consent_to_renew: false,
    },
    undefined,
  );
  await oauth.disableRenewal("5");
  expect(api).toHaveBeenLastCalledWith(
    "/platform-accounts/douyin/oauth/renewal",
    "PUT",
    { expected_revision: "5", enabled: false },
    undefined,
  );
  const bili = bilibiliRenewalApi(api);
  await bili.disable("7");
  expect(api).toHaveBeenLastCalledWith(
    "/platform-accounts/bilibili/renewal",
    "PUT",
    { expected_revision: "7", enabled: false },
    undefined,
  );
});
it("OAuth status discloses prerequisites without pretending a playback session", () => {
  expect(validateOAuthStatus(status(), "douyin").available).toBe(false);
  expect(() =>
    validateOAuthStatus(
      { ...status(), playback_session: true } as any,
      "douyin",
    ),
  ).toThrow();
  expect(() =>
    validateOAuthStatus({ ...status(), available: true }, "douyin"),
  ).toThrow();
  expect(() =>
    validateOAuthStatus({ ...status(), scopes: ["video.list"] }, "douyin"),
  ).toThrow();
});
it("QR and authorization links have closed official origins and terminal requests hold no payload", () => {
  expect(validateOAuthLogin(login(), "douyin", id).mode).toBe("web");
  expect(() =>
    validateOAuthLogin(
      login({ authorization_url: `https://attacker.invalid/?state=${state}` }),
      "douyin",
      id,
    ),
  ).toThrow();
  const qr = login({
    provider: "tiktok",
    mode: "qr",
    authorization_url: null,
    qr_payload: `aweme://authorize?client_key=fixture&client_ticket=${state}`,
  });
  expect(validateOAuthLogin(qr, "tiktok", id).mode).toBe("qr");
  expect(() =>
    validateOAuthLogin(
      {
        ...qr,
        qr_payload: `aweme://authorize?client_ticket=${state}&client_ticket=${state}`,
      },
      "tiktok",
      id,
    ),
  ).toThrow();
  expect(() =>
    validateOAuthLogin(login({ status: "confirmed" }), "douyin", id),
  ).toThrow();
});
it("close during start cancels exact id and rejects late confirmation", async () => {
  const work = deferred<OAuthLogin>(),
    change = vi.fn(),
    confirmed = vi.fn(),
    cancel = vi.fn();
  let current = true;
  const flow = createOAuthFlow({
    provider: "douyin",
    current: () => current,
    start: () => work.promise,
    read: vi.fn(),
    poll: vi.fn(),
    cancel,
    change,
    confirmed,
    uuid: () => id,
  });
  const start = flow.start();
  await settle();
  await flow.close();
  work.resolve(login({ status: "confirmed", authorization_url: null }));
  await start;
  expect(cancel).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(id);
  expect(confirmed).not.toHaveBeenCalled();
  expect(change.mock.calls.some(([s]) => s.phase === "confirmed")).toBe(false);
  current = false;
});
it("uncertain creation reads same request without repeating a remote generation", async () => {
  const start = vi.fn().mockRejectedValue(Error("synthetic transport loss")),
    read = vi
      .fn()
      .mockResolvedValue(
        login({ status: "confirmed", authorization_url: null }),
      ),
    confirmed = vi.fn();
  const flow = createOAuthFlow({
    provider: "douyin",
    current: () => true,
    start,
    read,
    poll: vi.fn(),
    cancel: vi.fn(),
    change: vi.fn(),
    confirmed,
    uuid: () => id,
  });
  await flow.start();
  await flow.start();
  expect(start).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  expect(confirmed).toHaveBeenCalledOnce();
  await flow.close();
});
it("identity loss makes pending polls inert and never cancels as another login", async () => {
  vi.useFakeTimers();
  let current = true;
  const poll = vi.fn(),
    read = vi.fn(),
    cancel = vi.fn(),
    flow = createOAuthFlow({
      provider: "douyin",
      current: () => current,
      start: async () => login(),
      read,
      poll,
      cancel,
      change: vi.fn(),
      confirmed: vi.fn(),
      uuid: () => id,
      now: () => 0,
    });
  await flow.start();
  current = false;
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).not.toHaveBeenCalled();
  await flow.close();
  expect(cancel).not.toHaveBeenCalled();
});
it("Bili renewal cannot claim enabled after an uncertain rotation", () => {
  const v = {
    account: { id, provider: "bilibili", revision: "2", state: "connected" },
    method: "web_cookie_refresh",
    supported: true,
    enabled: false,
    state: "uncertain",
    next_refresh_at: 1000,
    enable_requires: "new_consented_qr_login",
  } as const;
  expect(validateBilibiliRenewal(v).state).toBe("uncertain");
  expect(() => validateBilibiliRenewal({ ...v, enabled: true })).toThrow();
});

function recoveryFlow(
  overrides: {
    start?: (id: string, signal: AbortSignal) => Promise<OAuthLogin>;
    read?: (id: string, signal: AbortSignal) => Promise<OAuthLogin>;
    current?: () => boolean;
    now?: () => number;
  } = {},
) {
  const start = vi.fn(overrides.start ?? (async () => login()));
  const read = vi.fn(overrides.read ?? (async () => login()));
  const change = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const confirmed = vi.fn();
  const flow = createOAuthFlow({
    provider: "douyin",
    current: overrides.current ?? (() => true),
    start,
    read,
    poll: vi.fn(),
    cancel,
    change,
    confirmed,
    uuid: () => id,
    now: overrides.now ?? (() => 0),
  });
  return { flow, start, read, change, cancel, confirmed };
}

it.each([
  "RATE_LIMITED",
  "PLATFORM_OAUTH_APPLICATION_CONFIGURATION_REQUIRED",
  "PLATFORM_STORAGE_CONSENT_REQUIRED",
  "PLATFORM_ACCOUNT_CHANGED",
  "PLATFORM_LOGIN_IN_PROGRESS",
])(
  "definitive pre-creation %s can retry the same id without reading a missing request",
  async (code) => {
    vi.useFakeTimers();
    const h = recoveryFlow();
    h.start.mockRejectedValueOnce(
      new RequestFailure({
        error: { code, message: "private upstream fixture" },
      }),
    );
    await h.flow.start();
    expect(h.change).toHaveBeenLastCalledWith({ phase: "retryable" });
    await h.flow.start();
    expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.start.mock.calls.map(([requestId]) => requestId)).toEqual([
      id,
      id,
    ]);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.change).toHaveBeenLastCalledWith({
      phase: "pending",
      login: login(),
    });
    expect(JSON.stringify(h.change.mock.calls)).not.toContain(
      "private upstream fixture",
    );
    await h.flow.close();
  },
);

it("unknown creation reads first, exact missing unlocks only an explicit same-id start retry", async () => {
  vi.useFakeTimers();
  const h = recoveryFlow();
  h.start.mockRejectedValueOnce(new TypeError("transport outcome unknown"));
  h.read.mockRejectedValueOnce(
    new RequestFailure({ error: "platform_login_request_not_found" }),
  );
  await h.flow.start();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "uncertain" });
  await h.flow.start();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "retryable" });
  expect(h.start).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.start).toHaveBeenCalledOnce();
  await h.flow.start();
  expect(h.start.mock.calls.map(([requestId]) => requestId)).toEqual([id, id]);
  expect(h.read).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
  expect(h.change).toHaveBeenLastCalledWith({
    phase: "pending",
    login: login(),
  });
  await h.flow.close();
});

it.each([
  Error("platform_login_request_not_found"),
  new RequestFailure({ error: "not_found" }),
  new RequestFailure({ error: "rate_limited" }),
  new RequestFailure({
    error: "platform_oauth_application_configuration_required",
  }),
  new RequestFailure({
    error: { code: "PLATFORM_LOGIN_REQUEST_CONFLICT", retryable: true },
  }),
  new RequestFailure({ error: "platform_login_changed" }),
])(
  "unconfirmed read failures never permit blind creation: %s",
  async (error) => {
    const h = recoveryFlow({
      start: async () => {
        throw Error("lost response");
      },
      read: async () => {
        throw error;
      },
    });
    await h.flow.start();
    await h.flow.start();
    await h.flow.start();
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.change).toHaveBeenLastCalledWith({ phase: "uncertain" });
    await h.flow.close();
  },
);

it("a previously observed OAuth request disappearing expires without recreating its grant", async () => {
  vi.useFakeTimers();
  const h = recoveryFlow();
  h.read.mockRejectedValue(
    new RequestFailure({ error: "platform_login_request_not_found" }),
  );
  await h.flow.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.change).toHaveBeenLastCalledWith({ phase: "expired" });
  await h.flow.start();
  expect(h.start).toHaveBeenCalledOnce();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "expired" });
  await h.flow.close();
});

it("an unknown attempt cannot recreate a missing request beyond its original lifetime", async () => {
  let now = 0;
  const h = recoveryFlow({ now: () => now });
  h.start.mockRejectedValueOnce(Error("lost response"));
  h.read.mockRejectedValue(
    new RequestFailure({ error: "platform_login_request_not_found" }),
  );
  await h.flow.start();
  now = 180001;
  await h.flow.start();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "expired" });
  await h.flow.start();
  expect(h.start).toHaveBeenCalledOnce();
  await h.flow.close();
});

it("close after an absent read fences a delayed start using the original cancellation id", async () => {
  const h = recoveryFlow();
  h.start.mockRejectedValueOnce(Error("lost response"));
  h.read.mockRejectedValueOnce(
    new RequestFailure({ error: "platform_login_request_not_found" }),
  );
  await h.flow.start();
  await h.flow.start();
  await h.flow.close();
  await h.flow.start();
  expect(h.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(h.start).toHaveBeenCalledOnce();
});

it.each(["close", "identity"])(
  "a late absent read cannot unlock retry after %s",
  async (ending) => {
    let current = true;
    let reject!: (error: unknown) => void;
    const reading = new Promise<OAuthLogin>((_, no) => {
      reject = no;
    });
    const h = recoveryFlow({ current: () => current, read: () => reading });
    h.start.mockRejectedValueOnce(Error("lost response"));
    await h.flow.start();
    const retry = h.flow.start();
    if (ending === "identity") current = false;
    await h.flow.close();
    const count = h.change.mock.calls.length;
    reject(new RequestFailure({ error: "platform_login_request_not_found" }));
    await retry;
    await h.flow.start();
    expect(h.change).toHaveBeenCalledTimes(count);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.confirmed).not.toHaveBeenCalled();
    expect(h.cancel).toHaveBeenCalledTimes(ending === "close" ? 1 : 0);
  },
);

it("same-id retry permission expires without extending the original recovery deadline", async () => {
  let now = 0;
  const h = recoveryFlow({ now: () => now });
  h.start.mockRejectedValueOnce(Error("lost response"));
  h.read.mockRejectedValueOnce(
    new RequestFailure({ error: "platform_login_request_not_found" }),
  );
  await h.flow.start();
  await h.flow.start();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "retryable" });
  now = 180001;
  await h.flow.start();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "expired" });
  expect(h.start).toHaveBeenCalledOnce();
  expect(h.read).toHaveBeenCalledOnce();
  await h.flow.close();
});

it("a malformed successful creation response still queries before any retry", async () => {
  const h = recoveryFlow();
  h.start.mockResolvedValueOnce(login({ provider: "tiktok" }));
  h.read.mockResolvedValueOnce(
    login({ status: "confirmed", authorization_url: null }),
  );
  await h.flow.start();
  expect(h.change).toHaveBeenLastCalledWith({ phase: "uncertain" });
  await h.flow.start();
  expect(h.start).toHaveBeenCalledOnce();
  expect(h.read).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
  expect(h.confirmed).toHaveBeenCalledOnce();
  await h.flow.close();
});
