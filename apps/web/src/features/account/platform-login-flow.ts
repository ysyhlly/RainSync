import type { PlatformLogin } from "./platform-account.api";
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
    loginId: string | undefined;
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
  function validate(value: PlatformLogin) {
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
      if (!value.qr_payload || value.qr_payload.length > 4096)
        throw Error("Invalid QR response");
      const url = new URL(value.qr_payload);
      if (
        url.origin !== "https://passport.bilibili.com" ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== "/h5-app/passport/login"
      )
        throw Error("Invalid QR origin");
    }
    return value;
  }
  function apply(value: PlatformLogin, generation: number) {
    if (!current(generation)) return;
    validate(value);
    loginId = value.id;
    if (value.status !== "pending") {
      key = undefined;
      loginId = undefined;
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
      payload: value.qr_payload!,
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
        apply(await options.poll(value.id, controller.signal), generation);
      } catch {
        if (current(generation))
          publish({
            phase: "uncertain",
            message:
              "登录结果尚未确认，点击重试同一登录。不会自动生成新的二维码。",
          });
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
    } catch {
      if (current(generation))
        publish({
          phase: "uncertain",
          message:
            "登录结果尚未确认，点击重试同一登录。不会自动生成新的二维码。",
        });
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
    if (pending) await options.cancel(pending);
  }
  return { start, close };
}
