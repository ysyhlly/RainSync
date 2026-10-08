import { mountSetup } from "./helpers/mount-setup";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { RequestFailure } from "../apps/web/src/errors";
import { useSession } from "../apps/web/src/features/auth/session.store";
import {
  platformOAuthApi,
  oauthPrerequisiteLabels,
  type OAuthLogin,
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
function mountPanel(api: any) {
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
    { provider: "douyin" },
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
