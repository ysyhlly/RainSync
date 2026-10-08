import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { usePlatformAccount } from "../apps/web/src/features/account/platform-account.store";
import {
  platformAccountApi,
  type PlatformAccountStatus,
} from "../apps/web/src/features/account/platform-account.api";
import { platformAccountCheckMessage } from "../apps/web/src/features/account/platform-account-check";
import { createPlatformLoginFlow } from "../apps/web/src/features/account/platform-login-flow";
import {
  bilibiliRenewalApi,
  validateBilibiliRenewal,
} from "../apps/web/src/features/account/platform-renewal.api";

afterEach(() => vi.unstubAllGlobals());
const accountId = "00000000-0000-0000-0000-000000000001";
const connected: PlatformAccountStatus = {
  id: accountId,
  provider: "bilibili",
  revision: "1",
  state: "connected",
};
function renewal(account: PlatformAccountStatus, enabled = false) {
  return {
    account,
    method: "web_cookie_refresh",
    supported: true,
    enabled,
    state: enabled ? "scheduled" : "disabled",
    next_refresh_at: enabled ? 1000 : null,
    enable_requires: "new_consented_qr_login",
  };
}
function panel(api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: accountId,
    username: "fixture",
    admin: false,
    csrf: "fixture",
  });
  session.api = api;
  vi.stubGlobal("location", { origin: "https://fixture.test" });
  const instance = mountSetup(
    new URL(
      "../apps/web/src/features/account/PlatformAccountPanel.vue",
      import.meta.url,
    ),
    {
      useSession,
      usePlatformAccount,
      platformAccountApi,
      platformAccountCheckMessage,
      createPlatformLoginFlow,
      bilibiliRenewalApi,
      validateBilibiliRenewal,
      QRCode: { toDataURL: async () => "fixture:image" },
      Notice: {},
      AppDialog: {},
    },
  );
  return { ...instance, account: usePlatformAccount() };
}
it("loading and failed renewal reads never imply disabled or expose an old stop button", async () => {
  let reject!: (e: Error) => void;
  const pending = new Promise((_, fail) => {
    reject = fail;
  });
  const p = panel(
    vi.fn(async (path: string) =>
      path.endsWith("/renewal") ? pending : connected,
    ),
  );
  await vi.waitFor(() => expect(p.account.status).toEqual(connected));
  expect(p.controls.renewalPhase.value).toBe("loading");
  expect(p.controls.currentRenewal.value).toBeNull();
  reject(Error("synthetic unavailable"));
  await vi.waitFor(() => expect(p.controls.renewalPhase.value).toBe("error"));
  expect(p.controls.currentRenewal.value).toBeNull();
  p.unmount();
});
for (const action of ["unlink", "checkLogin"] as const) {
  it(`invalidates an enabled renewal on ${action} and reads the current account revision`, async () => {
    let status = connected;
    const changed: PlatformAccountStatus = {
      ...connected,
      revision: "2",
      state: action === "unlink" ? "revoked" : "expired",
    };
    const api = vi.fn(async (path: string, method = "GET") => {
      if (path.endsWith("/renewal"))
        return renewal(status, status.state === "connected");
      if (method === "DELETE") {
        status = changed;
        return changed;
      }
      if (path.endsWith("/check")) {
        status = changed;
        return {
          account: changed,
          verification: "invalid",
          checked_at: 1000,
          renew_method: "qr_login",
        };
      }
      return status;
    });
    const p = panel(api);
    await vi.waitFor(() =>
      expect(p.controls.currentRenewal.value?.enabled).toBe(true),
    );
    await p.controls[action]();
    expect(p.controls.currentRenewal.value?.enabled).toBe(false);
    expect(p.controls.currentRenewal.value?.account.revision).toBe("2");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/renewal")),
    ).toHaveLength(2);
    p.unmount();
  });
}
it("a delayed renewal from the old account version cannot overwrite a revoked state", async () => {
  let status = connected,
    resolveOld!: (value: unknown) => void,
    reads = 0;
  const old = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const revoked: PlatformAccountStatus = {
    ...connected,
    revision: "2",
    state: "revoked",
  };
  const api = vi.fn(async (path: string, method = "GET") => {
    if (path.endsWith("/renewal")) return ++reads === 1 ? old : renewal(status);
    if (method === "DELETE") {
      status = revoked;
      return revoked;
    }
    return status;
  });
  const p = panel(api);
  await vi.waitFor(() => expect(reads).toBe(1));
  await p.controls.unlink();
  expect(p.controls.currentRenewal.value?.account).toEqual(revoked);
  resolveOld(renewal(connected, true));
  await Promise.resolve();
  await Promise.resolve();
  expect(p.controls.currentRenewal.value?.account).toEqual(revoked);
  expect(p.controls.currentRenewal.value?.enabled).toBe(false);
  p.unmount();
});
