import { afterEach, expect, it, vi } from "vitest";
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
