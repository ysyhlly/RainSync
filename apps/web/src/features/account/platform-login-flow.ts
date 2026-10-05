import type { PlatformLogin } from "./platform-account.api";
import { RequestFailure } from "../../errors";
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
    timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false,
    loginDeadline: number | undefined;
  const now = options.now ?? (() => performance.now());
  const publish = (value: PlatformLoginFlowState) => {
    if (!closed && options.current()) options.change(value);
  };
  const current = (generation: number) =>
    !closed &&
    generation === serial &&
    options.current() &&
    !controller.signal.aborted;
  function validate(value: PlatformLogin, fromPoll: boolean) {
    if ((key && value.id !== key) || (loginId && value.id !== loginId))
      throw Error("Invalid login binding");
    if (
      value.provider !== "bilibili" ||
      !/^[0-9a-f-]{36}$/i.test(value.id) ||
      !["pending", "confirmed", "expired", "failed"].includes(value.status) ||
      ![value.expires_at, value.server_time, value.next_poll_at].every(
        Number.isSafeInteger,
      )
    )
      throw Error("Invalid login response");
    if (value.status === "pending") {
      // Poll responses deliberately omit the capability. Only this exact
      // login's validated start response can supply its immutable local QR.
      if (value.qr_payload === null) {
        if (!fromPoll || loginId !== value.id || !qrPayload)
          throw Error("Invalid QR response");
        return value;
      }
      if (
        typeof value.qr_payload !== "string" ||
        !value.qr_payload ||
        value.qr_payload.length > 4096 ||
        (qrPayload && value.qr_payload !== qrPayload)
      )
        throw Error("Invalid QR response");
      const url = new URL(value.qr_payload);
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
        throw Error("Invalid QR origin");
      const bindings = [...url.searchParams].filter(([name]) =>
        ["qrcode_key", "oauthKey"].includes(name),
      );
      if (
        bindings.length !== 1 ||
        ((accountScan || url.pathname.endsWith("/scan")) &&
          bindings[0]![0] !== "qrcode_key") ||
        !/^[a-z0-9_-]{16,128}$/i.test(bindings[0]![1])
      )
        throw Error("Invalid QR binding");
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
          throw Error("Invalid QR callback");
      }
    }
    return value;
  }
  function failed(error: unknown, fromPoll: boolean) {
    const failure = error instanceof RequestFailure ? error : undefined;
    const code =
      failure && /^[A-Z][A-Z0-9_]{0,79}$/.test(failure.code)
        ? failure.code
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
      qrPayload = undefined;
      loginDeadline = undefined;
    }
    publish({
      phase: expired ? "expired" : terminal ? "failed" : "uncertain",
      payload: terminal ? undefined : qrPayload,
      code,
      requestId: failure?.requestId,
      message: expired
        ? "二维码已过期，请关闭后重新确认登录。"
        : terminal
          ? "本次平台登录已失败，请关闭后重新确认登录。"
          : "登录结果尚未确认，点击重试同一登录。不会自动生成新的二维码。",
    });
  }
  function apply(value: PlatformLogin, generation: number, fromPoll = false) {
    if (!current(generation)) return;
    validate(value, fromPoll);
    loginId = value.id;
    if (value.status !== "pending") {
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
      publish({ phase: "expired", message: "二维码已过期，请重新确认登录" });
      return;
    }
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
        publish({ phase: "expired", message: "二维码已过期，请重新确认登录" });
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
    if (closed || !options.current()) return;
    clearTimeout(timer);
    controller.abort();
    controller = new AbortController();
    const generation = ++serial;
    key ??= (options.uuid ?? (() => crypto.randomUUID()))();
    publish({ phase: "starting" });
    try {
      apply(await options.start(key, controller.signal), generation);
    } catch (error) {
      if (current(generation)) failed(error, false);
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    ++serial;
    clearTimeout(timer);
    controller.abort();
    const pending = loginId ?? key;
    key = undefined;
    loginId = undefined;
    qrPayload = undefined;
    if (pending) await options.cancel(pending);
  }
  return { start, close };
}
