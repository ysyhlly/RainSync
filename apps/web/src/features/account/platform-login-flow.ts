import type { PlatformLogin } from "./platform-account.api";
import { RequestFailure } from "../../errors";
class LoginResponseFailure extends Error {}
export interface PlatformLoginFlowState {
  phase:
    | "idle"
    | "starting"
    | "pending"
    | "confirmed"
    | "expired"
    | "failed"
    | "uncertain";
  stage?: "waiting" | "scanned";
  payload?: string;
  message?: string;
  code?: string;
  requestId?: string;
  retryAfterSeconds?: number;
}
/** Login capability is held in this exact origin/session closure, never persisted. */
export function createPlatformLoginFlow(options: {
  current: () => boolean;
  start: (key: string, signal: AbortSignal) => Promise<PlatformLogin>;
  poll: (id: string, signal: AbortSignal) => Promise<PlatformLogin>;
  cancel: (id: string) => Promise<unknown>;
  change: (state: PlatformLoginFlowState) => void;
  confirmed: () => void;
  uuid?: () => string;
  now?: () => number;
}) {
  let serial = 0,
    key: string | undefined,
    loginId: string | undefined,
    qrPayload: string | undefined;
  let controller = new AbortController(),
    timer: ReturnType<typeof setTimeout> | undefined,
    expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false,
    finished = false,
    loginDeadline: number | undefined,
    retryDeadline: number | undefined;
  const now = options.now ?? (() => performance.now());
  const publish = (value: PlatformLoginFlowState) => {
    if (!closed && options.current()) options.change(value);
  };
  const current = (generation: number) =>
    !closed &&
    generation === serial &&
    options.current() &&
    !controller.signal.aborted;
  function clearDeadline() {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    loginDeadline = undefined;
  }
  function expire() {
    finished = true;
    ++serial;
    controller.abort();
    clearTimeout(timer);
    clearDeadline();
    qrPayload = undefined;
    retryDeadline = undefined;
    publish({ phase: "expired", message: "二维码已过期，请重新确认登录" });
  }
  // QR expiry is independent from polling and retry cooldowns. A retry can
  // replace the request controller, but never extend this original deadline.
  function armExpiry(generation: number) {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!qrPayload || loginDeadline === undefined) return;
    const tick = () => {
      if (!current(generation)) return;
      const remaining = loginDeadline! - now();
      if (remaining <= 0) expire();
      else expiryTimer = setTimeout(tick, remaining);
    };
    tick();
  }
  function validate(value: PlatformLogin, fromPoll: boolean) {
    if (!value || typeof value !== "object")
      throw new LoginResponseFailure("Invalid login response");
    if ((key && value.id !== key) || (loginId && value.id !== loginId))
      throw new LoginResponseFailure("Invalid login binding");
    if (
      value.provider !== "bilibili" ||
      !/^[0-9a-f-]{36}$/i.test(value.id) ||
      !["pending", "confirmed", "expired", "failed"].includes(value.status) ||
      ![value.expires_at, value.server_time, value.next_poll_at].every(
        Number.isSafeInteger,
      )
    )
      throw new LoginResponseFailure("Invalid login response");
    if (value.status === "pending") {
      // Poll responses deliberately omit the capability. Only this exact
      // login's validated start response can supply its immutable local QR.
      if (value.qr_payload === null) {
        if (!fromPoll || loginId !== value.id || !qrPayload)
          throw new LoginResponseFailure("Invalid QR response");
        return value;
      }
      if (
        typeof value.qr_payload !== "string" ||
        !value.qr_payload ||
        value.qr_payload.length > 4096 ||
        (qrPayload && value.qr_payload !== qrPayload)
      )
        throw new LoginResponseFailure("Invalid QR response");
      let url: URL;
      try {
        url = new URL(value.qr_payload);
      } catch {
        throw new LoginResponseFailure("Invalid QR response");
      }
      const accountScan =
        url.origin === "https://account.bilibili.com" &&
        url.pathname === "/h5/account-h5/auth/scan-web";
      const passportScan =
        url.origin === "https://passport.bilibili.com" &&
        ["/h5-app/passport/login", "/h5-app/passport/login/scan"].includes(
          url.pathname,
        );
      if (
        !(accountScan || passportScan) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new LoginResponseFailure("Invalid QR origin");
      const bindings = [...url.searchParams].filter(([name]) =>
        ["qrcode_key", "oauthKey"].includes(name),
      );
      if (
        bindings.length !== 1 ||
        ((accountScan || url.pathname.endsWith("/scan")) &&
          bindings[0]![0] !== "qrcode_key") ||
        !/^[a-z0-9_-]{16,128}$/i.test(bindings[0]![1])
      )
        throw new LoginResponseFailure("Invalid QR binding");
      if (accountScan) {
        const query = [...url.searchParams];
        if (
          query.some(([name, value]) =>
            name === "qrcode_key"
              ? false
              : name === "navhide"
                ? value !== "1"
                : name === "callback"
                  ? value !== "close"
                  : name === "from"
                    ? value !== ""
                    : true,
          ) ||
          url.searchParams.getAll("callback").length !== 1 ||
          url.searchParams.getAll("navhide").length > 1 ||
          url.searchParams.getAll("from").length > 1
        )
          throw new LoginResponseFailure("Invalid QR callback");
      }
    }
    return value;
  }
  function failed(error: unknown, fromPoll: boolean) {
    if (loginDeadline !== undefined && now() >= loginDeadline) {
      expire();
      return;
    }
    const failure = error instanceof RequestFailure ? error : undefined;
    const invalidResponse = error instanceof LoginResponseFailure;
    const code =
      failure && /^[A-Z][A-Z0-9_]{0,79}$/.test(failure.code)
        ? failure.code
        : invalidResponse
          ? "PLATFORM_LOGIN_RESPONSE_INVALID"
          : undefined;
    const expired = code === "PLATFORM_LOGIN_EXPIRED";
    // Generation failure is terminal on the server. Poll failures release the
    // claim while retaining the same QR, so their outcome stays uncertain.
    const terminal =
      expired ||
      (!fromPoll && code === "PLATFORM_LOGIN_UPSTREAM_FAILED") ||
      [
        "PLATFORM_LOGIN_CHANGED",
        "PLATFORM_LOGIN_REQUEST_NOT_FOUND",
        "PLATFORM_LOGIN_REQUEST_CONFLICT",
        "PLATFORM_LOGIN_REQUEST_INVALID",
        "LOGIN_REQUIRED",
        "SESSION_EXPIRED",
      ].includes(code ?? "");
    if (terminal) {
      finished = true;
      qrPayload = undefined;
      clearDeadline();
    }
    const state: PlatformLoginFlowState = {
      phase: expired ? "expired" : terminal ? "failed" : "uncertain",
      payload: terminal ? undefined : qrPayload,
      code,
      requestId: failure?.requestId,
      message: invalidResponse
        ? "登录响应未通过安全校验，请停止此登录、刷新页面后重试。"
        : expired
          ? "二维码已过期，请关闭后重新确认登录。"
          : terminal
            ? "本次平台登录已失败，请关闭后重新确认登录。"
            : "登录结果尚未确认，点击重试同一登录。不会自动生成新的二维码。",
    };
    if (!terminal && code === "RATE_LIMITED") {
      retryDeadline =
        now() +
        Math.max(1000, Math.min(3600000, failure?.retryAfterMs ?? 3000));
      const generation = serial;
      const countdown = () => {
        if (!current(generation)) return;
        if (loginDeadline !== undefined && now() >= loginDeadline) {
          expire();
          return;
        }
        const seconds = Math.ceil(Math.max(0, retryDeadline! - now()) / 1000);
        publish({
          ...state,
          retryAfterSeconds: seconds || undefined,
          message: seconds
            ? `登录请求过于频繁，请等待 ${seconds} 秒后重试同一登录。`
            : "等待已结束，可以重试同一登录。",
        });
        if (seconds)
          timer = setTimeout(
            countdown,
            Math.min(
              1000,
              retryDeadline! - now(),
              loginDeadline === undefined ? Infinity : loginDeadline - now(),
            ),
          );
        else retryDeadline = undefined;
      };
      countdown();
    } else publish(state);
  }
  function apply(value: PlatformLogin, generation: number, fromPoll = false) {
    if (!current(generation)) return;
    // A resumed tab may process a settled request before its overdue timer.
    if (loginDeadline !== undefined && now() >= loginDeadline) {
      expire();
      return;
    }
    validate(value, fromPoll);
    loginId = value.id;
    if (value.status !== "pending") {
      finished = true;
      clearDeadline();
      key = undefined;
      loginId = undefined;
      qrPayload = undefined;
      publish({
        phase: value.status,
        message:
          value.status === "expired"
            ? "二维码已过期，请重新确认登录"
            : value.status === "failed"
              ? "平台登录未完成，请重新确认登录"
              : "Bilibili 账号已连接",
      });
      if (value.status === "confirmed") options.confirmed();
      return;
    }
    qrPayload = value.qr_payload ?? qrPayload;
    loginDeadline = Math.min(
      loginDeadline ?? Infinity,
      now() +
        Math.max(0, Math.min(300000, value.expires_at - value.server_time)),
    );
    const remaining = Math.max(0, loginDeadline - now());
    if (!remaining) {
      expire();
      return;
    }
    armExpiry(generation);
    publish({
      phase: "pending",
      stage: value.stage ?? "waiting",
      payload: qrPayload!,
    });
    const deadline = now() + remaining;
    const delay = Math.max(
      3000,
      Math.min(remaining, value.next_poll_at - value.server_time),
    );
    timer = setTimeout(async () => {
      timer = undefined;
      if (!current(generation)) return;
      if (now() >= deadline) {
        expire();
        return;
      }
      try {
        apply(
          await options.poll(value.id, controller.signal),
          generation,
          true,
        );
      } catch (error) {
        if (current(generation)) failed(error, true);
      }
    }, delay);
  }
  async function start() {
    if (
      closed ||
      finished ||
      !options.current() ||
      (retryDeadline !== undefined && now() < retryDeadline)
    )
      return;
    clearTimeout(timer);
    retryDeadline = undefined;
    controller.abort();
    controller = new AbortController();
    const generation = ++serial;
    key ??= (options.uuid ?? (() => crypto.randomUUID()))();
    const fromPoll = !!loginId && !!qrPayload;
    if (fromPoll && loginDeadline !== undefined && now() >= loginDeadline) {
      expire();
      return;
    }
    armExpiry(generation);
    publish({ phase: "starting", payload: qrPayload });
    try {
      const response = fromPoll
        ? await options.poll(loginId!, controller.signal)
        : await options.start(key, controller.signal);
      apply(response, generation, fromPoll);
    } catch (error) {
      if (current(generation)) failed(error, fromPoll);
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    ++serial;
    clearTimeout(timer);
    clearDeadline();
    controller.abort();
    const pending = loginId ?? key;
    key = undefined;
    loginId = undefined;
    qrPayload = undefined;
    if (pending) await options.cancel(pending);
  }
  return { start, close };
}
