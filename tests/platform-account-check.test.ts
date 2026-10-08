import { afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { usePlatformAccount } from "../apps/web/src/features/account/platform-account.store";
import {
  platformAccountApi,
  type PlatformAccountCheck,
  type PlatformAccountStatus,
} from "../apps/web/src/features/account/platform-account.api";
import {
  platformAccountCheckMessage,
  validatePlatformAccountCheck,
} from "../apps/web/src/features/account/platform-account-check";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function status(
  revision = "3",
  state: PlatformAccountStatus["state"] = "connected",
): PlatformAccountStatus {
  return { id: id(1), provider: "bilibili", revision, state };
}
function checked(
  verification: PlatformAccountCheck["verification"] = "verified",
): PlatformAccountCheck {
  return {
    account: verification === "invalid" ? status("4", "expired") : status(),
    verification,
    checked_at: 1730000000000,
    renew_method: "qr_login",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
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
afterEach(() => vi.restoreAllMocks());

it("checks are explicit, POSTed and exact-revision bound", async () => {
  const api = vi.fn(async () => checked());
  await platformAccountApi(api as any).check("3");
  expect(api).toHaveBeenCalledWith(
    "/platform-accounts/bilibili/check",
    "POST",
    { expected_revision: "3" },
    undefined,
  );
});

it("check response validation rejects inconsistent or secret-bearing DTO fields", () => {
  const value = { ...checked(), cookie: "synthetic-secret" };
  expect(validatePlatformAccountCheck(value)).toEqual(checked());
  expect(validatePlatformAccountCheck(value)).not.toHaveProperty("cookie");
  for (const invalid of [
    { ...checked(), verification: "none" },
    { ...checked(), checked_at: null },
    { ...checked(), checked_at: NaN },
    { ...checked(), renew_method: "refresh_token" },
    { ...checked(), account: { ...status(), revision: "03" } },
    { ...checked(), account: { ...status(), id: null } },
    { ...checked(), account: status("3", "expired") },
    { ...checked("invalid"), account: status() },
  ])
    expect(() => validatePlatformAccountCheck(invalid as any)).toThrow();
});

it("transient checks preserve the account and cannot claim a current entitlement", async () => {
  const api = vi.fn(async (path: string) =>
    path.endsWith("/check") ? checked("unknown") : status(),
  );
  const { account } = setup(api);
  await account.refresh();
  await account.checkLogin();
  expect(account.status).toEqual(status());
  expect(account.change).toBe(0);
  expect(platformAccountCheckMessage(account.lastCheck)).toContain(
    "已保留原会话",
  );
  expect(platformAccountCheckMessage(checked())).toContain("最近检查时");
});

it("definitive invalid login accepts the expired revision and invalidates playback observers", async () => {
  const api = vi.fn(async (path: string) =>
    path.endsWith("/check") ? checked("invalid") : status(),
  );
  const { account } = setup(api);
  await account.refresh();
  await account.checkLogin();
  expect(account.status).toEqual(status("4", "expired"));
  expect(account.change).toBe(1);
  expect(account.lastCheck?.verification).toBe("invalid");
});

it("late status reads cannot restore a credential after check invalidation", async () => {
  const old = deferred<PlatformAccountStatus>();
  let reads = 0;
  const api = vi.fn(async (path: string) =>
    path.endsWith("/check")
      ? checked("invalid")
      : ++reads === 1
        ? status()
        : old.promise,
  );
  const { account } = setup(api);
  await account.refresh();
  const read = account.refresh(true);
  const rejected = expect(read).rejects.toThrow();
  await account.checkLogin();
  old.resolve(status());
  await rejected;
  expect(account.status).toEqual(status("4", "expired"));
});

it("logout and cancellation make delayed check responses inert", async () => {
  for (const cancel of [false, true]) {
    const response = deferred<PlatformAccountCheck>();
    const api = vi.fn(async (path: string) =>
      path.endsWith("/check") ? response.promise : status(),
    );
    const { session, account } = setup(api);
    await account.refresh();
    const controller = new AbortController();
    const work = account.checkLogin(controller.signal);
    const rejected = expect(work).rejects.toThrow();
    await Promise.resolve();
    if (cancel) controller.abort();
    else session.clear();
    response.resolve(checked("invalid"));
    await rejected;
    expect(account.lastCheck).toBeUndefined();
    expect(account.status).toEqual(cancel ? status() : undefined);
  }
});

it("repeated checks are single-flight mutations and refresh waits for their outcome", async () => {
  const response = deferred<PlatformAccountCheck>();
  const api = vi.fn(async (path: string) =>
    path.endsWith("/check") ? response.promise : status(),
  );
  const { account } = setup(api);
  await account.refresh();
  const work = account.checkLogin();
  await expect(account.checkLogin()).rejects.toThrow();
  const refreshed = account.refresh();
  response.resolve(checked());
  await work;
  await refreshed;
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/check")),
  ).toHaveLength(1);
});
