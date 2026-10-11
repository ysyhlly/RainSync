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
import type { ShortPlatformProvider } from "../apps/web/src/features/account/platform-account.api";

const id = "00000000-0000-0000-0000-000000000001";
const otherId = "00000000-0000-0000-0000-000000000002";
const token = "a".repeat(64);
const revision = "900719925474099312345678901234567890";
function status(provider: ShortPlatformProvider = "douyin"): OAuthStatus {
  return {
    provider,
    id,
    revision,
    state: "connected",
    available: true,
    missing_prerequisites: [],
    authorization_kind: "official_oauth",
    playback_session: false,
    authorization_mode: "web",
    scopes: [provider === "douyin" ? "user_info" : "user.info.basic"],
    access_expires_at: 1000,
    refresh_expires_at: 2000,
    auto_renew: true,
    renewal_state: "scheduled",
    next_refresh_at: 1000,
  };
}
function login(provider: ShortPlatformProvider = "douyin"): OAuthLogin {
  return {
    id,
    provider,
    status: "pending",
    mode: provider === "douyin" ? "web" : "qr",
    stage: "waiting",
    authorization_url:
      provider === "douyin"
        ? `https://open.douyin.com/platform/oauth/connect/?state=${token}`
        : null,
    qr_payload:
      provider === "tiktok" ? `aweme://authorize?client_ticket=${token}` : null,
    expires_at: 181000,
    next_poll_at: 4000,
    server_time: 1000,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((yes) => (resolve = yes));
  return { promise, resolve };
}
function poisoned(field: string) {
  const getter = vi.fn(() => {
    throw Error("retired receipt must not be inspected");
  });
  return { value: Object.defineProperty({}, field, { get: getter }), getter };
}
afterEach(() => vi.useRealTimers());

it.each(["douyin", "tiktok"] as const)(
  "%s transport preserves every endpoint, signal and revision without inspecting receipts",
  async (provider) => {
    const poison = poisoned("provider");
    const api = vi.fn().mockResolvedValue(poison.value);
    const oauth = platformOAuthApi(api, provider);
    const signal = new AbortController().signal;
    const path = `/platform-accounts/${provider}/oauth`;
    expect(await oauth.status(signal)).toBe(poison.value);
    expect(await oauth.start(id, revision, true, signal)).toBe(poison.value);
    expect(await oauth.read(id, signal)).toBe(poison.value);
    expect(await oauth.poll(id, signal)).toBe(poison.value);
    expect(await oauth.cancel(id)).toBe(poison.value);
    expect(await oauth.disableRenewal(revision, signal)).toBe(poison.value);
    expect(await oauth.unlink(revision, signal)).toBe(poison.value);
    expect(api.mock.calls).toEqual([
      [path, "GET", undefined, signal],
      [
        `${path}/login`,
        "POST",
        {
          idempotency_key: id,
          expected_revision: revision,
          consent_to_store: true,
          consent_to_renew: true,
        },
        signal,
      ],
      [`${path}/login/${id}`, "GET", undefined, signal],
      [`${path}/login/${id}/poll`, "POST", undefined, signal],
      [`${path}/login/${id}`, "DELETE", undefined, expect.any(AbortSignal)],
      [
        `${path}/renewal`,
        "PUT",
        { expected_revision: revision, enabled: false },
        signal,
      ],
      [path, "DELETE", { expected_revision: revision }, signal],
    ]);
    expect(poison.getter).not.toHaveBeenCalled();
  },
);

it.each([
  null,
  undefined,
  true,
  false,
  1,
  0,
  "dto",
  1n,
  [],
  [status()],
  Object.assign([], status()),
])("status rejects non-record receipt %s", (receipt) => {
  expect(() => validateOAuthStatus(receipt, "douyin")).toThrow();
});
it.each([
  null,
  undefined,
  true,
  1,
  "dto",
  1n,
  [],
  [login()],
  Object.assign([], login()),
])("login rejects non-record receipt %s", (receipt) => {
  expect(() => validateOAuthLogin(receipt, "douyin", id)).toThrow();
});
it.each(Object.keys(status()))("status requires declared field %s", (field) => {
  const receipt: Record<string, unknown> = { ...status() };
  delete receipt[field];
  expect(() => validateOAuthStatus(receipt, "douyin")).toThrow();
});
it.each(Object.keys(login()))("login requires declared field %s", (field) => {
  const receipt: Record<string, unknown> = { ...login() };
  delete receipt[field];
  expect(() => validateOAuthLogin(receipt, "douyin", id)).toThrow();
});
it.each([0, 1, 1n, "0", "01", "-1", "1.0", " 1", "1e3", "", {}, []])(
  "status rejects non-string or non-positive-decimal revision %s",
  (value) => {
    expect(() =>
      validateOAuthStatus({ ...status(), revision: value }, "douyin"),
    ).toThrow();
  },
);
it.each(["douyin", "tiktok"] as const)(
  "%s parsers whitelist complete DTOs and copy nested arrays",
  (provider) => {
    const extra = vi.fn(() => {
      throw Error("extra field must not be read");
    });
    const raw = status(provider);
    Object.defineProperty(raw, "secret", { enumerable: true, get: extra });
    Object.defineProperty(raw.scopes, "secret", {
      enumerable: true,
      get: extra,
    });
    Object.defineProperty(raw.missing_prerequisites, "secret", {
      enumerable: true,
      get: extra,
    });
    const parsed = validateOAuthStatus(raw, provider);
    expect(parsed).toEqual(status(provider));
    expect(parsed === raw).toBe(false);
    expect(parsed.scopes === raw.scopes).toBe(false);
    expect(parsed.missing_prerequisites === raw.missing_prerequisites).toBe(
      false,
    );
    expect(Object.keys(parsed)).toEqual(Object.keys(status(provider)));
    expect(Object.keys(parsed.scopes)).toEqual(["0"]);
    expect(Object.keys(parsed.missing_prerequisites)).toEqual([]);
    expect(parsed.revision).toBe(revision);
    raw.scopes.length = 0;
    raw.missing_prerequisites.push("new_unknown_prerequisite");
    expect(parsed.scopes).toHaveLength(1);
    expect(parsed.missing_prerequisites).toEqual([]);

    const rawLogin = { ...login(provider), nested: { secret: "private" } };
    Object.defineProperty(rawLogin, "secret", { enumerable: true, get: extra });
    const parsedLogin = validateOAuthLogin(rawLogin, provider, id);
    expect(parsedLogin).toEqual(login(provider));
    expect(parsedLogin === rawLogin).toBe(false);
    expect(Object.keys(parsedLogin)).toEqual(Object.keys(login(provider)));
    expect(extra).not.toHaveBeenCalled();
  },
);
it("preserves existing unvalidated status combinations and signed-safe login timestamps", () => {
  const raw = {
    ...status(),
    id: null,
    revision: null,
    state: "expired",
    available: false,
    missing_prerequisites: ["future_prerequisite", "future_prerequisite"],
    scopes: ["user_info", "user_info"],
    authorization_mode: "qr",
    access_expires_at: null,
    refresh_expires_at: null,
    next_refresh_at: null,
    auto_renew: true,
    renewal_state: "disabled",
  };
  expect(validateOAuthStatus(raw, "douyin")).toEqual(raw);
  const terminal = {
    ...login(),
    status: "expired",
    mode: "qr",
    stage: "scanned",
    authorization_url: null,
    qr_payload: null,
    expires_at: -1,
    next_poll_at: 0,
    server_time: Number.MAX_SAFE_INTEGER,
  };
  expect(validateOAuthLogin(terminal, "douyin", id)).toEqual(terminal);
});
it.each(["douyin", "tiktok"] as const)(
  "%s keeps provider-specific status scope and login binding checks",
  (provider) => {
    const other = provider === "douyin" ? "tiktok" : "douyin";
    expect(() => validateOAuthStatus(status(other), provider)).toThrow();
    expect(() =>
      validateOAuthStatus(
        { ...status(provider), scopes: status(other).scopes },
        provider,
      ),
    ).toThrow();
    expect(() => validateOAuthLogin(login(other), provider, id)).toThrow();
    expect(() =>
      validateOAuthLogin({ ...login(provider), id: otherId }, provider, id),
    ).toThrow();
    expect(() =>
      validateOAuthLogin(
        { ...login(provider), id: "invalid" },
        provider,
        "invalid",
      ),
    ).toThrow();
  },
);
it.each([
  `http://open.douyin.com/platform/oauth/connect/?state=${token}`,
  `https://open.douyin.com.attacker.invalid/platform/oauth/connect/?state=${token}`,
  `https://open.douyin.com/other/?state=${token}`,
  `https://user:pass@open.douyin.com/platform/oauth/connect/?state=${token}`,
  `https://open.douyin.com/platform/oauth/connect/?state=${token}#payload`,
  `https://open.douyin.com/platform/oauth/connect/?state=${token}&state=${token}`,
  `https://open.douyin.com/platform/oauth/connect/?state=${token.toUpperCase()}`,
  "x".repeat(8193),
])("rejects unsafe web capability %s", (authorization_url) => {
  expect(() =>
    validateOAuthLogin({ ...login(), authorization_url }, "douyin", id),
  ).toThrow();
});
it("allows both official web providers and preserves extra query parameters", () => {
  for (const provider of ["douyin", "tiktok"] as const) {
    const base =
      provider === "douyin"
        ? "https://open.douyin.com/platform/oauth/connect/"
        : "https://www.tiktok.com/v2/auth/authorize/";
    const value = {
      ...login(provider),
      mode: "web",
      qr_payload: null,
      authorization_url: `${base}?state=${token}&future=value`,
    };
    expect(validateOAuthLogin(value, provider, id)).toEqual(value);
  }
});
it.each([
  `https://authorize?client_ticket=${token}`,
  `aweme://other?client_ticket=${token}`,
  `aweme://authorize/path?client_ticket=${token}`,
  `aweme://user:pass@authorize?client_ticket=${token}`,
  `aweme://authorize:42?client_ticket=${token}`,
  `aweme://authorize?client_ticket=${token}#payload`,
  `aweme://authorize?client_ticket=${token}&client_ticket=${token}`,
  `aweme://authorize?client_ticket=${token.toUpperCase()}`,
  "x".repeat(8193),
])("rejects unsafe QR capability %s", (qr_payload) => {
  expect(() =>
    validateOAuthLogin({ ...login("tiktok"), qr_payload }, "tiktok", id),
  ).toThrow();
});
it.each(["confirmed", "expired", "failed"] as const)(
  "terminal %s rejects retained web or QR capabilities",
  (phase) => {
    for (const provider of ["douyin", "tiktok"] as const) {
      expect(() =>
        validateOAuthLogin({ ...login(provider), status: phase }, provider, id),
      ).toThrow();
    }
  },
);

function flowHarness(provider: ShortPlatformProvider = "douyin") {
  let current = true;
  const start = vi
    .fn<(...args: [string, AbortSignal]) => Promise<unknown>>()
    .mockResolvedValue(login(provider));
  const read = vi
    .fn<(...args: [string, AbortSignal]) => Promise<unknown>>()
    .mockResolvedValue(login(provider));
  const poll = vi
    .fn<(...args: [string, AbortSignal]) => Promise<unknown>>()
    .mockResolvedValue(login(provider));
  const cancel = vi
    .fn<(...args: [string]) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  const change = vi.fn();
  const confirmed = vi.fn();
  const flow = createOAuthFlow({
    provider,
    current: () => current,
    start,
    read,
    poll,
    cancel,
    change,
    confirmed,
    uuid: () => id,
    now: () => 0,
  });
  return {
    flow,
    start,
    read,
    poll,
    cancel,
    change,
    confirmed,
    retire: () => {
      current = false;
    },
  };
}
for (const entry of ["start", "read", "poll"] as const) {
  it.each(["close", "identity"] as const)(
    `${entry} ignores a poisoned late receipt after %s before reading any field`,
    async (ending) => {
      vi.useFakeTimers();
      const h = flowHarness(entry === "poll" ? "tiktok" : "douyin");
      const pending = deferred();
      h[entry].mockReturnValueOnce(pending.promise);
      let completion: Promise<void>;
      if (entry === "read") {
        h.start.mockRejectedValueOnce(Error("uncertain start"));
        await h.flow.start();
        completion = h.flow.start();
      } else if (entry === "poll") {
        await h.flow.start();
        completion = vi.advanceTimersByTimeAsync(3000);
        await completion;
      } else completion = h.flow.start();
      const poison = poisoned("id");
      if (ending === "identity") h.retire();
      await h.flow.close();
      const published = h.change.mock.calls.length;
      pending.resolve(poison.value);
      await completion;
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10000);
      expect(poison.getter).not.toHaveBeenCalled();
      expect(h.change).toHaveBeenCalledTimes(published);
      expect(h.confirmed).not.toHaveBeenCalled();
      expect(h.cancel).toHaveBeenCalledTimes(ending === "close" ? 1 : 0);
      expect(h[entry]).toHaveBeenCalledExactlyOnceWith(
        id,
        expect.any(AbortSignal),
      );
    },
  );
  it(`${entry} treats malformed current success as uncertain, clearing capability and never confirming`, async () => {
    vi.useFakeTimers();
    const h = flowHarness(entry === "poll" ? "tiktok" : "douyin");
    h[entry].mockResolvedValueOnce(Object.assign([], login()));
    if (entry === "read") h.start.mockRejectedValueOnce(Error("lost receipt"));
    await h.flow.start();
    if (entry === "read") await h.flow.start();
    if (entry === "poll") await vi.advanceTimersByTimeAsync(3000);
    expect(h.change).toHaveBeenLastCalledWith({ phase: "uncertain" });
    expect(h.confirmed).not.toHaveBeenCalled();
    const calls =
      h.start.mock.calls.length +
      h.read.mock.calls.length +
      h.poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      h.start.mock.calls.length +
        h.read.mock.calls.length +
        h.poll.mock.calls.length,
    ).toBe(calls);
    await h.flow.close();
  });
}
it("flow publishes only the parser copy and holds no capabilities after terminal confirmation", async () => {
  vi.useFakeTimers();
  const h = flowHarness();
  const raw = { ...login(), secret: { token: "private" } };
  h.start.mockResolvedValueOnce(raw);
  h.read.mockResolvedValueOnce({
    ...login(),
    status: "confirmed",
    authorization_url: null,
    secret: "private",
  });
  await h.flow.start();
  const published = h.change.mock.calls.at(-1)![0].login;
  expect(published).toEqual(login());
  expect(published).not.toBe(raw);
  raw.authorization_url = "https://attacker.invalid";
  raw.mode = "qr";
  expect(published.authorization_url).toBe(login().authorization_url);
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.change).toHaveBeenLastCalledWith({ phase: "confirmed" });
  expect(h.confirmed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.poll).not.toHaveBeenCalled();
  await h.flow.close();
});
it("duplicate starts share one attempt and repeated Close ignores opaque cancellation receipts", async () => {
  const h = flowHarness();
  const pending = deferred();
  const poison = poisoned("id");
  h.start.mockReturnValueOnce(pending.promise);
  h.cancel.mockResolvedValueOnce(poison.value);
  const first = h.flow.start();
  await h.flow.start();
  await Promise.all([h.flow.close(), h.flow.close()]);
  pending.resolve(poison.value);
  await first;
  expect(h.start).toHaveBeenCalledOnce();
  expect(h.start.mock.calls[0][1].aborted).toBe(true);
  expect(h.cancel).toHaveBeenCalledExactlyOnceWith(id);
  expect(poison.getter).not.toHaveBeenCalled();
  expect(h.confirmed).not.toHaveBeenCalled();
});

it.each([
  ["id", {}],
  ["id", [id]],
  ["revision", { toString: () => "1" }],
  ["state", "unknown"],
  ["available", 1],
  ["missing_prerequisites", [null]],
  ["authorization_kind", "cookie_import"],
  ["playback_session", true],
  ["authorization_mode", "other"],
  ["scopes", [null]],
  ["auto_renew", "true"],
  ["renewal_state", "other"],
  ["access_expires_at", 0],
  ["refresh_expires_at", -1],
  ["next_refresh_at", Number.MAX_SAFE_INTEGER + 1],
  ["next_refresh_at", Infinity],
  ["access_expires_at", 1.5],
  ["refresh_expires_at", "1000"],
])("status rejects malformed declared field %s = %s", (field, value) => {
  expect(() =>
    validateOAuthStatus({ ...status(), [field as string]: value }, "douyin"),
  ).toThrow();
});
it.each([
  ["status", "unknown"],
  ["mode", "other"],
  ["stage", "other"],
  ["authorization_url", 1],
  ["qr_payload", {}],
  ["expires_at", Infinity],
  ["next_poll_at", 1.5],
  ["server_time", Number.MAX_SAFE_INTEGER + 1],
])("login rejects malformed declared field %s = %s", (field, value) => {
  expect(() =>
    validateOAuthLogin({ ...login(), [field as string]: value }, "douyin", id),
  ).toThrow();
});
for (const entry of ["start", "read", "poll"] as const) {
  it(`preserves an already in-flight ${entry} terminal receipt after the local deadline`, async () => {
    vi.useFakeTimers();
    let now = 0;
    const provider = entry === "poll" ? "tiktok" : "douyin";
    const pending = deferred();
    const start = vi.fn().mockResolvedValue(login(provider));
    const read = vi.fn().mockReturnValue(pending.promise);
    const poll = vi.fn().mockReturnValue(pending.promise);
    const confirmed = vi.fn();
    const change = vi.fn();
    if (entry === "start") start.mockReturnValueOnce(pending.promise);
    if (entry === "read")
      start.mockRejectedValueOnce(Error("lost start receipt"));
    const flow = createOAuthFlow({
      provider,
      current: () => true,
      start,
      read,
      poll,
      cancel: vi.fn(),
      change,
      confirmed,
      uuid: () => id,
      now: () => now,
    });
    let completion = flow.start();
    if (entry !== "start") {
      await completion;
      if (entry === "read") completion = flow.start();
      else await vi.advanceTimersByTimeAsync(3000);
    }
    now = 180001;
    pending.resolve({
      ...login(provider),
      status: "confirmed",
      authorization_url: null,
      qr_payload: null,
    });
    await completion;
    await Promise.resolve();
    expect(change).toHaveBeenLastCalledWith({ phase: "confirmed" });
    expect(confirmed).toHaveBeenCalledOnce();
    await flow.close();
  });
}
