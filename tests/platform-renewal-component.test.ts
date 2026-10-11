import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { usePlatformAccount } from "../apps/web/src/features/account/platform-account.store";
import { RequestFailure } from "../apps/web/src/errors";
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
  return { ...instance, session, account: usePlatformAccount() };
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

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 8; ++i) await Promise.resolve();
}

for (const method of ["GET", "PUT"] as const) {
  for (const retire of [
    "epoch",
    "user",
    "csrf",
    "account-id",
    "account-revision",
    "account-state",
    "serial",
    "abort",
    "unmount",
  ] as const) {
    it(`${method} fences ${retire} before reading a late poisoned response`, async () => {
      const late = deferred();
      const touch = vi.fn(() => {
        throw Error("retired response getter must not run");
      });
      const poison = Object.defineProperty({}, "account", { get: touch });
      let status = connected;
      let gets = 0;
      const api = vi.fn(async (path: string, verb = "GET") => {
        if (!path.endsWith("/renewal")) return status;
        if (verb === "PUT") return late.promise;
        if (++gets === 1 && method === "GET") return late.promise;
        return renewal(status, method === "PUT" && gets === 1);
      });
      const p = panel(api);
      await vi.waitFor(() => expect(gets).toBe(1));
      if (method === "PUT")
        await vi.waitFor(() =>
          expect(p.controls.currentRenewal.value?.enabled).toBe(true),
        );
      const running =
        method === "GET"
          ? p.controls.readRenewal()
          : p.controls.disableRenewal();

      if (retire === "epoch") ++p.session.epoch;
      else if (retire === "user")
        p.session.user!.id = "00000000-0000-0000-0000-000000000002";
      else if (retire === "csrf") p.session.user!.csrf = "replacement-csrf";
      else if (retire.startsWith("account-")) {
        status = {
          ...connected,
          ...(retire === "account-id"
            ? { id: "00000000-0000-0000-0000-000000000003" }
            : retire === "account-revision"
              ? { revision: "2" }
              : { state: "expired" as const }),
        };
        p.account.status = status;
      } else if (retire === "serial") await p.controls.refresh();
      else if (retire === "abort") p.controls.checkController.abort();
      else p.unmount();
      await settle();
      const before = {
        phase: p.controls.renewalPhase.value,
        renewal: p.controls.renewal.value,
        error: p.controls.error.value,
      };
      late.resolve(poison);
      await running;
      await settle();
      expect(touch).not.toHaveBeenCalled();
      expect({
        phase: p.controls.renewalPhase.value,
        renewal: p.controls.renewal.value,
        error: p.controls.error.value,
      }).toEqual(before);
      expect(
        api.mock.calls.filter(
          ([path, verb]) => path.endsWith("/renewal") && verb === "PUT",
        ),
      ).toHaveLength(method === "PUT" ? 1 : 0);
      if (retire !== "unmount") p.unmount();
    });
  }

  it.each([
    undefined,
    null,
    true,
    7,
    "malformed",
    [],
    {},
    { ...renewal(connected), account: { provider: "bilibili" } },
    { ...renewal(connected), account: { ...connected, revision: "01" } },
  ])(
    `${method} malformed current response %j fails closed without enabling a repeat write`,
    async (response) => {
      const api = vi.fn(async (path: string, verb = "GET") => {
        if (!path.endsWith("/renewal")) return connected;
        if (method === "GET" || verb === "PUT") return response;
        return renewal(connected, true);
      });
      const p = panel(api);
      if (method === "PUT") {
        await vi.waitFor(() =>
          expect(p.controls.currentRenewal.value?.enabled).toBe(true),
        );
        await p.controls.disableRenewal();
        expect(p.controls.error.value).toBe(
          "停止自动续期结果尚未确认，请刷新状态",
        );
      }
      await vi.waitFor(() =>
        expect(p.controls.renewalPhase.value).toBe("error"),
      );
      expect(p.controls.currentRenewal.value).toBeNull();
      expect(p.controls.renewal.value).toBeNull();
      await p.controls.disableRenewal();
      expect(api.mock.calls.filter(([, verb]) => verb === "PUT")).toHaveLength(
        method === "PUT" ? 1 : 0,
      );
      p.unmount();
    },
  );

  it(`${method} keeps only the validated renewal/account whitelist in reactive state`, async () => {
    const raw = {
      ...renewal(connected, method === "GET"),
      secret: "synthetic-root-secret",
      account: { ...connected, cookie: "synthetic-account-secret" },
    };
    const api = vi.fn(async (path: string, verb = "GET") => {
      if (!path.endsWith("/renewal")) return connected;
      return method === "GET" || verb === "PUT"
        ? raw
        : renewal(connected, true);
    });
    const p = panel(api);
    await vi.waitFor(() =>
      expect(p.controls.currentRenewal.value?.enabled).toBe(true),
    );
    if (method === "PUT") await p.controls.disableRenewal();
    expect(p.controls.renewal.value).toEqual(
      renewal(connected, method === "GET"),
    );
    expect(JSON.stringify(p.controls.renewal.value)).not.toContain("secret");
    expect(p.controls.renewal.value.account).not.toBe(raw.account);
    p.unmount();
  });

  it.each([
    { ...connected, id: "00000000-0000-0000-0000-000000000002" },
    { ...connected, revision: "2" },
    { ...connected, state: "expired" as const },
  ])(
    `${method} rejects a complete receipt for a different current account tuple %j`,
    async (other) => {
      const api = vi.fn(async (path: string, verb = "GET") => {
        if (!path.endsWith("/renewal")) return connected;
        return method === "GET" || verb === "PUT"
          ? renewal(other)
          : renewal(connected, true);
      });
      const p = panel(api);
      if (method === "PUT") {
        await vi.waitFor(() =>
          expect(p.controls.currentRenewal.value?.enabled).toBe(true),
        );
        await p.controls.disableRenewal();
      }
      await vi.waitFor(() =>
        expect(p.controls.renewalPhase.value).toBe("error"),
      );
      expect(p.controls.currentRenewal.value).toBeNull();
      expect(p.account.status).toEqual(connected);
      await p.controls.disableRenewal();
      expect(api.mock.calls.filter(([, verb]) => verb === "PUT")).toHaveLength(
        method === "PUT" ? 1 : 0,
      );
      p.unmount();
    },
  );
}

it("coalesces same-identity pending reads and admits no stop write before a checked enabled receipt", async () => {
  const read = deferred();
  const api = vi.fn(async (path: string) =>
    path.endsWith("/renewal") ? read.promise : connected,
  );
  const p = panel(api);
  await vi.waitFor(() => expect(p.account.status).toEqual(connected));
  const first = p.controls.readRenewal();
  const second = p.controls.readRenewal();
  await p.controls.disableRenewal();
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/renewal")),
  ).toHaveLength(1);
  read.resolve(renewal(connected, true));
  await Promise.all([first, second]);
  expect(p.controls.currentRenewal.value?.enabled).toBe(true);
  p.unmount();
});

it.each(["conflict", "unconfirmed transport", "uncertain receipt"] as const)(
  "%s preserves pending exclusion and requires a fresh enabled read before another stop write",
  async (outcome) => {
    const write = deferred();
    let writes = 0;
    const api = vi.fn(async (path: string, method = "GET", _body?: unknown) => {
      if (!path.endsWith("/renewal")) return connected;
      if (method === "GET") return renewal(connected, true);
      if (++writes === 1) return write.promise;
      return renewal(connected);
    });
    const p = panel(api);
    await vi.waitFor(() =>
      expect(p.controls.currentRenewal.value?.enabled).toBe(true),
    );
    const pending = p.controls.disableRenewal();
    expect(p.controls.busy.value).toBe(true);
    expect(p.controls.currentRenewal.value).toBeNull();
    await p.controls.disableRenewal();
    expect(writes).toBe(1);
    if (outcome === "conflict")
      write.reject(
        new RequestFailure({
          error: {
            code: "PLATFORM_ACCOUNT_CHANGED",
            message: "synthetic conflict",
          },
        }),
      );
    else if (outcome === "unconfirmed transport")
      write.reject(Error("synthetic network error"));
    else
      write.resolve({
        ...renewal(connected),
        state: "uncertain",
        next_refresh_at: 1000,
      });
    await pending;
    expect(p.controls.busy.value).toBe(false);
    if (outcome === "uncertain receipt") {
      expect(p.controls.currentRenewal.value?.state).toBe("uncertain");
      expect(p.controls.currentRenewal.value?.enabled).toBe(false);
      expect(p.controls.error.value).toBe("");
    } else {
      expect(p.controls.renewalPhase.value).toBe("error");
      expect(p.controls.currentRenewal.value).toBeNull();
      expect(p.controls.error.value).toBe(
        "停止自动续期结果尚未确认，请刷新状态",
      );
    }
    await p.controls.disableRenewal();
    expect(writes).toBe(1);
    await p.controls.refresh();
    expect(p.controls.currentRenewal.value?.enabled).toBe(true);
    await p.controls.disableRenewal();
    expect(writes).toBe(2);
    expect(p.controls.currentRenewal.value?.enabled).toBe(false);
    expect(
      api.mock.calls
        .filter(([, verb]) => verb === "PUT")
        .map((call) => call[2]),
    ).toEqual([
      { expected_revision: connected.revision, enabled: false },
      { expected_revision: connected.revision, enabled: false },
    ]);
    p.unmount();
  },
);
