import { mountSetup } from "./helpers/mount-setup";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { RequestFailure } from "../apps/web/src/errors";
import { useSession } from "../apps/web/src/features/auth/session.store";
import {
  platformOAuthApi,
  oauthPrerequisiteLabels,
  type OAuthLogin,
  type OAuthStatus,
} from "../apps/web/src/features/account/platform-oauth.api";
import {
  createOAuthFlow,
  validateOAuthStatus,
} from "../apps/web/src/features/account/platform-oauth-flow";
const id = "00000000-0000-0000-0000-000000000001",
  state = "a".repeat(64);
const status = {
  provider: "douyin",
  id: null,
  revision: null,
  state: "revoked",
  available: true,
  missing_prerequisites: [],
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
function login(extra: Partial<OAuthLogin> = {}): OAuthLogin {
  return {
    id,
    provider: "douyin",
    status: "pending",
    mode: "web",
    stage: null,
    authorization_url: `https://open.douyin.com/platform/oauth/connect/?state=${state}`,
    qr_payload: null,
    expires_at: 181000,
    next_poll_at: 4000,
    server_time: 1000,
    ...extra,
  };
}
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
/** Run the real SFC setup/lifecycle with Vue's in-memory renderer. No browser,
 * DOM package, listener or real account endpoint is used. */
function mountPanel(api: any, provider: "douyin" | "tiktok" = "douyin") {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id,
    username: "fixture",
    admin: false,
    csrf: "fixture-csrf",
  });
  session.api = api;
  vi.stubGlobal("location", { origin: "https://fixture.example" });
  vi.stubGlobal("crypto", { randomUUID: () => id });
  return mountSetup(
    new URL(
      "../apps/web/src/features/account/OfficialPlatformAccountPanel.vue",
      import.meta.url,
    ),
    {
      QRCode: { toDataURL: async () => "fixture:image" },
      useSession,
      platformOAuthApi,
      oauthPrerequisiteLabels,
      createOAuthFlow,
      validateOAuthStatus,
      AppDialog: {},
      Notice: {},
    },
    { provider },
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("component Cancel during start captures cancellation before hiding the dialog", async () => {
  let resolve!: (v: OAuthLogin) => void;
  const start = new Promise<OAuthLogin>((r) => {
    resolve = r;
  });
  const api = vi.fn(async (path: string, method: string) =>
    path.endsWith("/oauth")
      ? status
      : method === "DELETE"
        ? login({ status: "failed", authorization_url: null })
        : start,
  );
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = true;
  const beginning = panel.controls.begin();
  await settle();
  expect(panel.controls.state.value.phase).toBe("starting");
  await panel.controls.close();
  expect(
    api.mock.calls.some(
      ([path, method]) => path.endsWith(`/login/${id}`) && method === "DELETE",
    ),
  ).toBe(true);
  expect(panel.controls.open.value).toBe(false);
  resolve(login({ status: "confirmed", authorization_url: null }));
  await beginning;
  expect(panel.controls.state.value.phase).toBe("idle");
  panel.unmount();
});
it("component Close while pending cancels exact request and stops future polls", async () => {
  vi.useFakeTimers();
  const api = vi.fn(async (path: string, method: string) =>
    path.endsWith("/oauth")
      ? status
      : method === "DELETE"
        ? login({ status: "failed", authorization_url: null })
        : login(),
  );
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = true;
  await panel.controls.begin();
  expect(panel.controls.state.value.phase).toBe("pending");
  await panel.controls.close();
  expect(
    api.mock.calls.filter(
      ([path, method]) => path.endsWith(`/login/${id}`) && method === "DELETE",
    ),
  ).toHaveLength(1);
  const count = api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.mock.calls).toHaveLength(count);
  panel.unmount();
});

it("component retries a rejected preparation without closing or reading a nonexistent request", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const api = vi.fn(async (path: string, method: string) => {
    if (path.endsWith("/oauth")) return status;
    if (method === "DELETE")
      return login({ status: "failed", authorization_url: null });
    if (method === "POST" && ++attempts === 1)
      throw new RequestFailure({
        error: { code: "RATE_LIMITED", message: "private credential fixture" },
      });
    return login();
  });
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = true;
  await panel.controls.begin();
  expect(panel.controls.state.value).toEqual({ phase: "retryable" });
  expect(panel.controls.open.value).toBe(true);
  expect(panel.controls.busy.value).toBe(false);
  expect(panel.controls.error.value).toBe("");
  await Promise.all([panel.controls.begin(), panel.controls.begin()]);
  const starts = api.mock.calls.filter(
    ([path, method]) => path.endsWith("/login") && method === "POST",
  );
  expect(starts).toHaveLength(2);
  expect(starts[0]).toEqual(starts[1]);
  expect(
    api.mock.calls.filter(
      ([path, method]) => path.endsWith(`/login/${id}`) && method === "GET",
    ),
  ).toHaveLength(0);
  expect(panel.controls.state.value.phase).toBe("pending");
  await panel.controls.close();
  panel.unmount();
});

it("component missing-request recovery keeps the id and original explicit renewal choice", async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const api = vi.fn(async (path: string, method: string) => {
    if (path.endsWith("/oauth")) return status;
    if (method === "DELETE")
      return login({ status: "failed", authorization_url: null });
    if (method === "GET")
      throw new RequestFailure({ error: "platform_login_request_not_found" });
    if (++attempts === 1) throw Error("synthetic transport loss");
    return login();
  });
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = panel.controls.renew.value = true;
  await panel.controls.begin();
  expect(panel.controls.state.value.phase).toBe("uncertain");
  await panel.controls.begin();
  expect(panel.controls.state.value).toEqual({ phase: "retryable" });
  expect(attempts).toBe(1);
  panel.controls.renew.value = false;
  await panel.controls.begin();
  const starts = api.mock.calls.filter(
    ([path, method]) => path.endsWith("/login") && method === "POST",
  );
  expect(starts).toHaveLength(2);
  expect(starts[0]).toEqual(starts[1]);
  expect((starts[1] as unknown[])[2]).toMatchObject({
    idempotency_key: id,
    expected_revision: null,
    consent_to_store: true,
    consent_to_renew: true,
  });
  expect(panel.controls.state.value.phase).toBe("pending");
  await panel.controls.close();
  panel.unmount();
});

it("component successful uncertain-result read completes without another OAuth start", async () => {
  const api = vi.fn(async (path: string, method: string) => {
    if (path.endsWith("/oauth")) return status;
    if (method === "POST") throw Error("synthetic transport loss");
    return login({ status: "confirmed", authorization_url: null });
  });
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = true;
  await panel.controls.begin();
  await panel.controls.begin();
  expect(panel.controls.state.value).toEqual({ phase: "confirmed" });
  expect(
    api.mock.calls.filter(
      ([path, method]) => path.endsWith("/login") && method === "POST",
    ),
  ).toHaveLength(1);
  expect(
    api.mock.calls.filter(
      ([path, method]) => path.endsWith(`/login/${id}`) && method === "GET",
    ),
  ).toHaveLength(1);
  await panel.controls.close();
  panel.unmount();
});

it.each(["close", "identity", "provider", "unmount"])(
  "component ignores late missing-result recovery after %s",
  async (ending) => {
    let reject!: (error: unknown) => void;
    const reading = new Promise<OAuthLogin>((_, no) => {
      reject = no;
    });
    const api = vi.fn(async (path: string, method: string) => {
      if (path.endsWith("/oauth")) return status;
      if (method === "POST") throw Error("synthetic transport loss");
      if (method === "DELETE")
        return login({ status: "failed", authorization_url: null });
      return reading;
    });
    const panel = mountPanel(api);
    await settle();
    await panel.controls.show();
    panel.controls.consent.value = true;
    await panel.controls.begin();
    const retry = panel.controls.begin();
    await settle();
    if (ending === "close") await panel.controls.close();
    if (ending === "identity")
      useSession().accept({
        id: "00000000-0000-0000-0000-000000000002",
        username: "other",
        admin: false,
        csrf: "other-csrf",
      });
    if (ending === "provider") panel.setProps({ provider: "tiktok" });
    if (ending === "unmount") panel.unmount();
    await settle();
    reject(new RequestFailure({ error: "platform_login_request_not_found" }));
    await retry;
    expect(panel.controls.open.value).toBe(false);
    expect(panel.controls.state.value).toEqual({ phase: "idle" });
    expect(
      api.mock.calls.filter(
        ([path, method]) => path.endsWith("/login") && method === "POST",
      ),
    ).toHaveLength(1);
    const cancellations = api.mock.calls.filter(
      ([, method]) => method === "DELETE",
    );
    expect(cancellations).toHaveLength(
      ending === "close" || ending === "unmount" ? 1 : 0,
    );
    if (ending !== "unmount") panel.unmount();
  },
);

function deferredReceipt() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((yes) => (resolve = yes));
  return { promise, resolve };
}
function connected(provider: "douyin" | "tiktok" = "douyin"): OAuthStatus {
  return {
    ...status,
    provider,
    authorization_kind: "official_oauth",
    authorization_mode: "web",
    playback_session: false,
    id,
    revision: "90071992547409931234567890",
    state: "connected",
    scopes: [provider === "douyin" ? "user_info" : "user.info.basic"],
    access_expires_at: 1000,
    refresh_expires_at: 2000,
    auto_renew: true,
    renewal_state: "scheduled",
  };
}
for (const operation of ["refresh", "disable", "unlink"] as const) {
  it.each(["epoch", "user", "csrf", "provider", "origin", "abort", "unmount"])(
    `component ${operation} fences poisoned success before parsing after %s`,
    async (ending) => {
      const pending = deferredReceipt();
      const api = vi
        .fn()
        .mockResolvedValueOnce(connected())
        .mockReturnValue(pending.promise);
      const panel = mountPanel(api);
      await settle();
      panel.controls.unlinkOpen.value = true;
      const work = panel.controls[operation]();
      if (ending === "epoch") ++useSession().epoch;
      if (ending === "user")
        useSession().user!.id = "00000000-0000-0000-0000-000000000002";
      if (ending === "csrf") useSession().user!.csrf = "new-csrf";
      if (ending === "provider") panel.setProps({ provider: "tiktok" });
      if (ending === "origin")
        vi.stubGlobal("location", { origin: "https://other.example" });
      if (ending === "abort") panel.controls.controller.abort();
      if (ending === "unmount") panel.unmount();
      await settle();
      const oldStatus = panel.controls.status.value;
      const oldError = panel.controls.error.value;
      const oldDialog = panel.controls.unlinkOpen.value;
      const getter = vi.fn(() => {
        throw Error("late receipt must not be inspected");
      });
      pending.resolve(Object.defineProperty({}, "provider", { get: getter }));
      await work;
      expect(getter).not.toHaveBeenCalled();
      expect(panel.controls.status.value).toBe(oldStatus);
      expect(panel.controls.error.value).toBe(oldError);
      expect(panel.controls.unlinkOpen.value).toBe(oldDialog);
      expect(api).toHaveBeenCalledTimes(2);
      if (ending === "unmount" || ending === "abort")
        expect(api.mock.calls[1][3].aborted).toBe(true);
      if (ending !== "unmount") panel.unmount();
    },
  );
  it.each([null, [], { state: "connected" }])(
    `component current invalid ${operation} keeps the last snapshot and reports the original error`,
    async (receipt) => {
      const pending = deferredReceipt();
      const api = vi
        .fn()
        .mockResolvedValueOnce(connected())
        .mockReturnValue(pending.promise);
      const panel = mountPanel(api);
      await settle();
      panel.controls.unlinkOpen.value = true;
      const work = panel.controls[operation]();
      if (operation !== "refresh") await panel.controls[operation]();
      pending.resolve(receipt);
      await work;
      expect(panel.controls.status.value).toEqual(connected());
      expect(panel.controls.unlinkOpen.value).toBe(true);
      expect(panel.controls.busy.value).toBe(false);
      expect(panel.controls.error.value).toBe(
        {
          refresh: "无法确认开放平台授权状态，请刷新重试",
          disable: "停止自动续期的结果未确认，请刷新状态",
          unlink: "解除开放平台授权的结果未确认，请刷新状态",
        }[operation],
      );
      expect(api).toHaveBeenCalledTimes(2);
      panel.unmount();
    },
  );
}
it("component refresh serial rejects a superseded poisoned receipt before parsing", async () => {
  const pending = deferredReceipt();
  const newer = { ...connected(), revision: "90071992547409931234567891" };
  const api = vi
    .fn()
    .mockResolvedValueOnce(connected())
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(newer);
  const panel = mountPanel(api);
  await settle();
  const first = panel.controls.refresh();
  await panel.controls.refresh();
  const getter = vi.fn(() => {
    throw Error("superseded receipt");
  });
  pending.resolve(Object.defineProperty({}, "provider", { get: getter }));
  await first;
  expect(getter).not.toHaveBeenCalled();
  expect(panel.controls.status.value).toEqual(newer);
  expect(panel.controls.error.value).toBe("");
  panel.unmount();
});
it.each(["douyin", "tiktok"] as const)(
  "component %s commits only whitelisted status and unchanged revision-bound writes",
  async (provider) => {
    const initial = connected(provider);
    const disabled = {
      ...initial,
      auto_renew: false,
      renewal_state: "disabled",
    };
    const unlinked = { ...disabled, state: "revoked" };
    const extra = { secret: { token: "private" } };
    const api = vi
      .fn()
      .mockResolvedValueOnce({ ...initial, ...extra })
      .mockResolvedValueOnce({ ...disabled, ...extra })
      .mockResolvedValueOnce({ ...unlinked, ...extra });
    const panel = mountPanel(api, provider);
    await settle();
    expect(panel.controls.status.value).toEqual(initial);
    await panel.controls.disable();
    expect(panel.controls.status.value).toEqual(disabled);
    panel.controls.unlinkOpen.value = true;
    await panel.controls.unlink();
    expect(panel.controls.status.value).toEqual(unlinked);
    expect(panel.controls.unlinkOpen.value).toBe(false);
    expect(api.mock.calls[1]).toEqual([
      `/platform-accounts/${provider}/oauth/renewal`,
      "PUT",
      { expected_revision: initial.revision, enabled: false },
      expect.any(AbortSignal),
    ]);
    expect(api.mock.calls[2]).toEqual([
      `/platform-accounts/${provider}/oauth`,
      "DELETE",
      { expected_revision: initial.revision },
      expect.any(AbortSignal),
    ]);
    panel.unmount();
  },
);
it("component ignores successful cancellation payloads, even malformed ones, without adding a request", async () => {
  vi.useFakeTimers();
  const getter = vi.fn(() => {
    throw Error("unused cancellation receipt");
  });
  const api = vi.fn(async (path: string, method: string) => {
    if (path.endsWith("/oauth")) return status;
    if (method === "DELETE")
      return Object.defineProperty({}, "provider", { get: getter });
    return login();
  });
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = true;
  await panel.controls.begin();
  await Promise.all([panel.controls.close(), panel.controls.close()]);
  expect(panel.controls.open.value).toBe(false);
  expect(panel.controls.state.value).toEqual({ phase: "idle" });
  expect(panel.controls.error.value).toBe("");
  expect(getter).not.toHaveBeenCalled();
  expect(
    api.mock.calls.filter(([, method]) => method === "DELETE"),
  ).toHaveLength(1);
  const count = api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(api).toHaveBeenCalledTimes(count);
  panel.unmount();
});

it.each(["confirmed", "invalid"] as const)(
  "TikTok polling %s clears rendered capability and only a valid confirmation refreshes status",
  async (outcome) => {
    vi.useFakeTimers();
    const qrLogin: OAuthLogin = {
      ...login(),
      provider: "tiktok",
      mode: "qr",
      authorization_url: null,
      qr_payload: `aweme://authorize?client_ticket=${state}`,
    };
    const terminal = { ...qrLogin, status: "confirmed", qr_payload: null };
    const api = vi.fn(async (path: string, method: string) => {
      if (path.endsWith("/oauth")) return connected("tiktok");
      if (path.endsWith("/poll"))
        return outcome === "confirmed" ? terminal : Object.assign([], terminal);
      if (method === "DELETE") return undefined;
      return { ...qrLogin, secret: { token: "private" } };
    });
    const panel = mountPanel(api, "tiktok");
    await settle();
    await panel.controls.show();
    panel.controls.consent.value = true;
    await panel.controls.begin();
    await settle();
    expect(panel.controls.state.value.login).toEqual(qrLogin);
    expect(panel.controls.image.value).toBe("fixture:image");
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(panel.controls.state.value).toEqual({
      phase: outcome === "confirmed" ? "confirmed" : "uncertain",
    });
    expect(panel.controls.image.value).toBe("");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/oauth")),
    ).toHaveLength(outcome === "confirmed" ? 3 : 2);
    const count = api.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(api).toHaveBeenCalledTimes(count);
    await panel.controls.close();
    panel.unmount();
  },
);
it("component cancellation rejection keeps the original uncertain-stop message without retry", async () => {
  vi.useFakeTimers();
  const api = vi.fn(async (path: string, method: string) => {
    if (path.endsWith("/oauth")) return status;
    if (method === "DELETE") throw Error("lost cancellation receipt");
    return login();
  });
  const panel = mountPanel(api);
  await settle();
  await panel.controls.show();
  panel.controls.consent.value = true;
  await panel.controls.begin();
  await panel.controls.close();
  expect(panel.controls.open.value).toBe(false);
  expect(panel.controls.state.value).toEqual({ phase: "idle" });
  expect(panel.controls.error.value).toBe(
    "停止授权尚未确认，请刷新状态。到期后此授权请求会失效",
  );
  const count = api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(api).toHaveBeenCalledTimes(count);
  panel.unmount();
});
