import type { OAuthLogin, OAuthStatus } from "./platform-oauth.api";
import type { ShortPlatformProvider } from "./platform-account.api";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateOAuthStatus(
  v: OAuthStatus,
  provider: ShortPlatformProvider,
): OAuthStatus {
  const stamp = (x: number | null) =>
    x === null || (Number.isSafeInteger(x) && x > 0);
  const scopes = provider === "douyin" ? ["user_info"] : ["user.info.basic"];
  if (
    !v ||
    v.provider !== provider ||
    (v.id !== null && !uuid.test(v.id)) ||
    (v.revision !== null && !/^[1-9]\d*$/.test(v.revision)) ||
    (v.id === null) !== (v.revision === null) ||
    !["connected", "expired", "revoked"].includes(v.state) ||
    typeof v.available !== "boolean" ||
    !Array.isArray(v.missing_prerequisites) ||
    v.missing_prerequisites.some((x) => typeof x !== "string") ||
    v.authorization_kind !== "official_oauth" ||
    v.playback_session !== false ||
    !["web", "qr"].includes(v.authorization_mode) ||
    !Array.isArray(v.scopes) ||
    v.scopes.some((s) => !scopes.includes(s)) ||
    typeof v.auto_renew !== "boolean" ||
    ![
      "disabled",
      "scheduled",
      "running",
      "uncertain",
      "reauthorization_required",
    ].includes(v.renewal_state) ||
    ![v.access_expires_at, v.refresh_expires_at, v.next_refresh_at].every(
      stamp,
    ) ||
    (v.available && v.missing_prerequisites.length !== 0) ||
    (v.state === "connected" &&
      (!v.id ||
        !v.access_expires_at ||
        !v.refresh_expires_at ||
        v.scopes.length !== 1))
  )
    throw Error("开放平台状态响应不完整");
  return {
    provider: v.provider,
    id: v.id,
    revision: v.revision,
    state: v.state,
    available: v.available,
    missing_prerequisites: [...v.missing_prerequisites],
    authorization_kind: v.authorization_kind,
    playback_session: false,
    authorization_mode: v.authorization_mode,
    scopes: [...v.scopes],
    access_expires_at: v.access_expires_at,
    refresh_expires_at: v.refresh_expires_at,
    auto_renew: v.auto_renew,
    renewal_state: v.renewal_state,
    next_refresh_at: v.next_refresh_at,
  };
}
export function validateOAuthLogin(
  v: OAuthLogin,
  provider: ShortPlatformProvider,
  id: string,
): OAuthLogin {
  if (
    !v ||
    v.id !== id ||
    !uuid.test(id) ||
    v.provider !== provider ||
    !["pending", "confirmed", "expired", "failed"].includes(v.status) ||
    !["web", "qr"].includes(v.mode) ||
    ![v.expires_at, v.next_poll_at, v.server_time].every(
      Number.isSafeInteger,
    ) ||
    ![null, "waiting", "scanned"].includes(v.stage) ||
    (v.authorization_url !== null && typeof v.authorization_url !== "string") ||
    (v.qr_payload !== null && typeof v.qr_payload !== "string")
  )
    throw Error("开放平台授权响应不完整");
  if (v.status === "pending") {
    if (v.mode === "web") {
      if (
        !v.authorization_url ||
        v.authorization_url.length > 8192 ||
        v.qr_payload !== null
      )
        throw Error("授权页面不完整");
      const u = new URL(v.authorization_url);
      const expected =
        provider === "douyin"
          ? ["https://open.douyin.com", "/platform/oauth/connect/"]
          : ["https://www.tiktok.com", "/v2/auth/authorize/"];
      if (
        u.origin !== expected[0] ||
        u.pathname !== expected[1] ||
        u.username ||
        u.password ||
        u.hash ||
        u.searchParams.getAll("state").length !== 1 ||
        !/^[a-f0-9]{64}$/.test(u.searchParams.get("state") ?? "")
      )
        throw Error("授权页面来源无效");
    } else {
      if (
        provider !== "tiktok" ||
        !v.qr_payload ||
        v.qr_payload.length > 8192 ||
        v.authorization_url !== null
      )
        throw Error("授权二维码不完整");
      const u = new URL(v.qr_payload);
      if (
        u.protocol !== "aweme:" ||
        u.hostname !== "authorize" ||
        u.pathname ||
        u.username ||
        u.password ||
        u.port ||
        u.hash ||
        u.searchParams.getAll("client_ticket").length !== 1 ||
        !/^[a-f0-9]{64}$/.test(u.searchParams.get("client_ticket") ?? "")
      )
        throw Error("授权二维码来源无效");
    }
  } else if (v.authorization_url !== null || v.qr_payload !== null)
    throw Error("已关闭的授权仍包含登录凭据");
  return v;
}
export interface OAuthFlowState {
  phase:
    | "idle"
    | "starting"
    | "pending"
    | "confirmed"
    | "expired"
    | "failed"
    | "uncertain";
  login?: OAuthLogin;
}
/** Exact origin/login closure; one id, no stored tokens, no implicit new QR. */
export function createOAuthFlow(options: {
  provider: ShortPlatformProvider;
  current: () => boolean;
  start: (id: string, signal: AbortSignal) => Promise<OAuthLogin>;
  read: (id: string, signal: AbortSignal) => Promise<OAuthLogin>;
  poll: (id: string, signal: AbortSignal) => Promise<OAuthLogin>;
  cancel: (id: string) => Promise<unknown>;
  change: (state: OAuthFlowState) => void;
  confirmed: () => void;
  uuid?: () => string;
  now?: () => number;
}) {
  const id = (options.uuid ?? (() => crypto.randomUUID()))();
  let closed = false,
    busy = false,
    started = false,
    deadline = Infinity,
    timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController(),
    now = options.now ?? (() => performance.now());
  const current = () =>
    !closed && !controller.signal.aborted && options.current();
  const publish = (state: OAuthFlowState) => {
    if (current()) options.change(state);
  };
  function apply(value: OAuthLogin) {
    if (!current()) return;
    validateOAuthLogin(value, options.provider, id);
    if (value.status !== "pending") {
      publish({ phase: value.status });
      if (value.status === "confirmed") options.confirmed();
      return;
    }
    deadline = Math.min(
      deadline,
      now() +
        Math.max(0, Math.min(180000, value.expires_at - value.server_time)),
    );
    if (now() >= deadline) {
      publish({ phase: "expired" });
      return;
    }
    publish({ phase: "pending", login: value });
    timer = setTimeout(
      async () => {
        timer = undefined;
        if (!current()) return;
        if (now() >= deadline) {
          publish({ phase: "expired" });
          return;
        }
        try {
          apply(
            await (value.mode === "qr" ? options.poll : options.read)(
              id,
              controller.signal,
            ),
          );
        } catch {
          publish({ phase: "uncertain" });
        }
      },
      Math.min(
        Math.max(3000, value.next_poll_at - value.server_time),
        Math.max(1, deadline - now()),
      ),
    );
  }
  async function start() {
    if (!current() || busy) return;
    busy = true;
    clearTimeout(timer);
    publish({ phase: "starting" });
    try {
      const value = await (started ? options.read : options.start)(
        id,
        controller.signal,
      );
      started = true;
      apply(value);
    } catch {
      started = true;
      publish({ phase: "uncertain" });
    } finally {
      busy = false;
    }
  }
  async function close() {
    if (closed) return;
    const mayCancel = options.current();
    closed = true;
    clearTimeout(timer);
    controller.abort();
    if (started || busy) {
      if (mayCancel) await options.cancel(id);
    }
  }
  return { start, close };
}
