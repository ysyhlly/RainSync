import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { usePlatformAccount } from "../apps/web/src/features/account/platform-account.store";
import {
  platformAccountApi,
  shortPlatformAccountApi,
  type ShortPlatformAccountStatus,
  type ShortPlatformProvider,
} from "../apps/web/src/features/account/platform-account.api";
import {
  createShortAccountFlow,
  validateShortAccountStatus,
  validShortAccountCookieInput,
} from "../apps/web/src/features/account/short-account-flow";
import { platformImportAccountIntent } from "../apps/web/src/features/rooms/platform-import";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
// Synthetic fixture only. These tests never call any real provider or account API.
const cookie = "sessionid=synthetic-session-fixture";
function status(
  provider: ShortPlatformProvider = "douyin",
  revision: string | null = null,
  state: ShortPlatformAccountStatus["state"] = "revoked",
): ShortPlatformAccountStatus {
  return {
    id: revision === null ? null : id(1),
    provider,
    revision,
    state,
    login_method: "cookie_import",
    qr_available: false,
    verification: state === "revoked" ? "none" : "unverified",
    credential_expires_at: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function settle() {
  for (let i = 0; i < 12; ++i) await Promise.resolve();
}
function setup(api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: id(8),
    username: "viewer",
    csrf: "csrf-a",
    admin: false,
  });
  session.api = api;
  return { session, account: usePlatformAccount() };
}
afterEach(() => {
  vi.restoreAllMocks();
});

it("short account API is provider-specific, consented and revision-bound while Bili keeps QR", async () => {
  const api = vi.fn(async () => status());
  const short = shortPlatformAccountApi(api as any, "douyin");
  await short.status();
  await short.importCredential(cookie, "7");
  await short.unlink("8");
  expect(api.mock.calls).toEqual([
    ["/platform-accounts/douyin", "GET", undefined, undefined],
    [
      "/platform-accounts/douyin/credential",
      "PUT",
      { cookie, consent_to_store: true, expected_revision: "7" },
      undefined,
    ],
    [
      "/platform-accounts/douyin",
      "DELETE",
      { expected_revision: "8" },
      undefined,
    ],
  ]);
  await shortPlatformAccountApi(api as any, "tiktok").status();
  expect(api.mock.calls.at(-1)?.[0]).toBe("/platform-accounts/tiktok");
  expect(() => shortPlatformAccountApi(api as any, "youtube" as any)).toThrow();
  await platformAccountApi(api as any).start(id(4));
  expect(api.mock.calls.at(-1)?.slice(0, 3)).toEqual([
    "/platform-accounts/bilibili/login",
    "POST",
    { idempotency_key: id(4), consent_to_store: true },
  ]);
});

it("status cannot invent QR or authenticated login, mix providers, or retain unknown secret fields", () => {
  const saved = status("douyin", "2", "connected");
  expect(
    validateShortAccountStatus({ ...saved, cookie } as any, "douyin"),
  ).not.toHaveProperty("cookie");
  for (const patch of [
    { provider: "tiktok" },
    { qr_available: true },
    { verification: "verified" },
    { id: null },
    { revision: "oops" },
    { login_method: "qr" },
    { credential_expires_at: NaN },
  ])
    expect(() =>
      validateShortAccountStatus({ ...saved, ...patch } as any, "douyin"),
    ).toThrow();
});

it("input admits only bounded, provider-specific session fields without assuming login success", () => {
  expect(validShortAccountCookieInput(cookie, "douyin")).toBe(true);
  expect(
    validShortAccountCookieInput(
      `${cookie}; passport_auth_status=fixture`,
      "douyin",
    ),
  ).toBe(true);
  expect(
    validShortAccountCookieInput(`${cookie}; tt_csrf_token=fixture`, "tiktok"),
  ).toBe(true);
  for (const value of [
    `${cookie}; tt_csrf_token=fixture`,
    `${cookie}; sessionid=synthetic-session-fixture`,
    `${cookie}; unknown=value`,
    `${cookie}; msToken=fingerprint`,
    `${cookie}; Path=/`,
    `Cookie: ${cookie}`,
    `Set-Cookie: ${cookie}`,
    JSON.stringify({ sessionid: "synthetic" }),
    "# Netscape HTTP Cookie File",
    "sessionid=short",
    `${cookie}; sid_tt=short`,
    `${cookie}\n`,
    `${cookie}; uid_tt=bad value`,
    `${cookie}; uid_tt=bad\\value`,
    `${cookie}; uid_tt=\"quoted\"`,
    `${cookie};`,
    `sessionid=${"x".repeat(2049)}`,
    `${cookie}; ttwid=${"x".repeat(8192)}`,
  ])
    expect(
      validShortAccountCookieInput(value, "douyin"),
      value.slice(0, 60),
    ).toBe(false);
});

it("flow clears input before sending, rejects duplicate clicks, and close fences delayed success", async () => {
  const pending = deferred<ShortPlatformAccountStatus>(),
    changes = vi.fn(),
    clearSecret = vi.fn();
  let signal!: AbortSignal;
  const submit = vi.fn(
    (value: string, revision: string | null, valueSignal: AbortSignal) => {
      expect(clearSecret).toHaveBeenCalledTimes(1);
      expect(value).toBe(cookie);
      expect(revision).toBe(null);
      signal = valueSignal;
      return pending.promise;
    },
  );
  const flow = createShortAccountFlow({
    provider: "douyin",
    current: () => true,
    submit,
    clearSecret,
    change: changes,
  });
  const work = flow.submit(cookie, null, true);
  await flow.submit(cookie, null, true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(changes).toHaveBeenLastCalledWith({ phase: "submitting" });
  flow.close();
  expect(signal.aborted).toBe(true);
  pending.resolve(status("douyin", "1", "connected"));
  await work;
  expect(changes).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(changes.mock.calls)).not.toContain(cookie);
});

it("flow requires own-account consent and never echoes raw errors or auto-retries secrets", async () => {
  const changes = vi.fn(),
    clearSecret = vi.fn(),
    submit = vi.fn(async () => {
      throw Error(cookie);
    });
  const flow = createShortAccountFlow({
    provider: "tiktok",
    current: () => true,
    submit,
    clearSecret,
    change: changes,
  });
  await flow.submit(cookie, null, false);
  expect(submit).not.toHaveBeenCalled();
  await flow.submit("sessionid=short", null, true);
  expect(submit).not.toHaveBeenCalled();
  expect(changes).toHaveBeenLastCalledWith({ phase: "invalid" });
  await flow.submit(cookie, null, true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(changes).toHaveBeenLastCalledWith({ phase: "uncertain" });
  expect(JSON.stringify(changes.mock.calls)).not.toContain(cookie);
  flow.close();
});

it("flow ignores a response from the old exact login and does not claim successful platform authentication", async () => {
  const pending = deferred<ShortPlatformAccountStatus>(),
    changes = vi.fn();
  let current = true;
  const flow = createShortAccountFlow({
    provider: "douyin",
    current: () => current,
    submit: () => pending.promise,
    clearSecret: vi.fn(),
    change: changes,
  });
  const work = flow.submit(cookie, null, true);
  current = false;
  pending.resolve(status("douyin", "1", "connected"));
  await work;
  expect(changes).toHaveBeenCalledTimes(1);
  flow.close();
});

it("imports send a matching viewer-owned short account only for explicit own mode", async () => {
  const saved = status("douyin", "3", "connected");
  expect(
    platformImportAccountIntent("douyin", "own_or_anonymous", saved),
  ).toEqual({ credential_mode: "own_or_anonymous", account_id: id(1) });
  expect(platformImportAccountIntent("douyin", "anonymous", saved)).toEqual({
    credential_mode: "anonymous",
  });
  expect(
    platformImportAccountIntent("tiktok", "own_or_anonymous", saved),
  ).toEqual({ credential_mode: "own_or_anonymous" });
  expect(
    platformImportAccountIntent(
      "douyin",
      "own_or_anonymous",
      status("douyin", "4"),
    ),
  ).toEqual({ credential_mode: "own_or_anonymous" });
  expect(
    platformImportAccountIntent("bilibili", "own_or_anonymous", saved),
  ).toBeUndefined();
  expect(
    platformImportAccountIntent("youtube", "own_or_anonymous", saved),
  ).toEqual({ credential_mode: "own_or_anonymous" });
  const api = vi.fn(async () => ({}));
  await roomsApi(api as any).importPlatform(
    id(2),
    "https://www.douyin.com/video/1",
    undefined,
    undefined,
    "douyin",
    platformImportAccountIntent("douyin", "own_or_anonymous", saved),
  );
  expect(api.mock.calls[0][2]).toEqual({
    provider: "douyin",
    url: "https://www.douyin.com/video/1",
    credential_mode: "own_or_anonymous",
    account_id: id(1),
  });
  await roomsApi(api as any).importPlatform(
    id(2),
    "https://www.youtube.com/watch?v=AbCde12_-34",
    undefined,
    undefined,
    "youtube",
    { credential_mode: "own_or_anonymous", account_id: id(1) },
  );
  expect(api.mock.calls[1][2]).toMatchObject({
    credential_mode: "own_or_anonymous",
    account_id: id(1),
  });
});

it("store isolates provider revisions and invalidates an older GET before importing", async () => {
  const old = deferred<ShortPlatformAccountStatus>();
  let gets = 0;
  const api = vi.fn(async (path: string, method: string) => {
    if (path.includes("tiktok")) return status("tiktok");
    if (method === "PUT") return status("douyin", "1", "connected");
    if (++gets === 2) return old.promise;
    return status();
  });
  const { account } = setup(api);
  await account.refreshShort("douyin");
  await account.refreshShort("tiktok");
  const read = account.refreshShort("douyin", true);
  const rejected = expect(read).rejects.toThrow();
  await account.importShort("douyin", cookie, null);
  old.resolve(status());
  await rejected;
  expect(account.shortStatuses.douyin?.revision).toBe("1");
  expect(account.shortChanges).toEqual({ douyin: 1, tiktok: 0 });
});

it("refresh waits behind mutation, so a stale GET cannot overwrite a newer import", async () => {
  const put = deferred<ShortPlatformAccountStatus>();
  let current = status();
  const api = vi.fn(async (_path: string, method: string) =>
    method === "PUT" ? put.promise : current,
  );
  const { account } = setup(api);
  await account.refreshShort("douyin");
  const saving = account.importShort("douyin", cookie, null);
  await settle();
  const refreshing = account.refreshShort("douyin", true);
  await settle();
  expect(api.mock.calls.filter(([, method]) => method === "GET")).toHaveLength(
    1,
  );
  await expect(account.unlinkShort("douyin", null)).rejects.toThrow();
  expect(
    api.mock.calls.filter(([, method]) => method === "DELETE"),
  ).toHaveLength(0);
  current = status("douyin", "2", "connected");
  put.resolve(current);
  await saving;
  await refreshing;
  expect(account.shortStatuses.douyin?.revision).toBe("2");
  expect(api.mock.calls.filter(([, method]) => method === "GET")).toHaveLength(
    2,
  );
});

it("unlink carries the confirmation's revision and stale/canceled/old-login responses stay inert", async () => {
  const late = deferred<ShortPlatformAccountStatus>();
  const api = vi.fn(async (_path: string, method: string) => {
    if (method === "PUT") return late.promise;
    if (method === "DELETE") return status("douyin", "3", "revoked");
    return status("douyin", "2", "connected");
  });
  const { account, session } = setup(api);
  await account.refreshShort("douyin");
  await expect(account.unlinkShort("douyin", "1")).rejects.toThrow();
  expect(
    api.mock.calls.filter(([, method]) => method === "DELETE"),
  ).toHaveLength(0);
  await account.unlinkShort("douyin", "2");
  expect(api.mock.calls.at(-1)?.[2]).toEqual({ expected_revision: "2" });
  expect(account.shortStatuses.douyin).toEqual(
    status("douyin", "3", "revoked"),
  );
  const controller = new AbortController();
  const saving = account.importShort("douyin", cookie, "3", controller.signal);
  const rejected = expect(saving).rejects.toThrow();
  await settle();
  controller.abort();
  session.accept({
    id: id(8),
    username: "viewer",
    csrf: "csrf-b",
    admin: false,
  });
  expect(account.shortStatuses).toEqual({});
  late.resolve(status("douyin", "4", "connected"));
  await rejected;
  expect(account.shortStatuses).toEqual({});
});

it("profile updates preserve short session state and pending import, exact login changes retire it", async () => {
  const late = deferred<ShortPlatformAccountStatus>();
  let submittedSignal: AbortSignal | undefined;
  const api = vi.fn(
    async (
      _path: string,
      method: string,
      _body: unknown,
      signal?: AbortSignal,
    ) => {
      if (method === "PUT") {
        submittedSignal = signal;
        return late.promise;
      }
      return status("douyin", "2", "connected");
    },
  );
  const { account, session } = setup(api);
  await account.refreshShort("douyin");
  const previousChanges = account.shortChanges.douyin;
  const saving = account.importShort(
    "douyin",
    cookie,
    "2",
    new AbortController().signal,
  );
  await settle();
  session.updateProfile(
    { display_name: "new profile", custom_display_name: "new profile" },
    id(8),
  );
  expect(submittedSignal?.aborted).toBe(false);
  expect(account.shortStatuses.douyin?.revision).toBe("2");
  expect(account.shortChanges.douyin).toBe(previousChanges);
  late.resolve(status("douyin", "3", "connected"));
  await saving;
  expect(account.shortStatuses.douyin?.revision).toBe("3");
  session.accept({
    id: id(8),
    username: "viewer",
    csrf: "csrf-b",
    admin: false,
  });
  expect(account.shortStatuses).toEqual({});
});
