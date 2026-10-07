import { shallowRef, type App } from "vue";
import { isNavigationFailure, type Router } from "vue-router";
import { RequestFailure, playbackFailureMessage } from "../errors";
import { StaleIdentity } from "../shared/api/client";

type Source = "component" | "navigation" | "script" | "promise" | "resource";
type Category = "request" | "network" | "resource" | "render" | "unexpected";
type Context = { source: Source; rendering?: boolean };
export type FrontendErrorNotice = { message: string; reference: string };
export const frontendError = shallowRef<FrontendErrorNotice>();
let sequence = 0;
let lastError: unknown;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const requestMessages: Record<string, string> = {
  LOGIN_REQUIRED: "登录状态已失效，请重新登录。",
  SESSION_EXPIRED: "登录状态已失效，请重新登录。",
  FORBIDDEN: "当前账号没有这项操作的权限。",
  NOT_A_MEMBER: "当前账号没有这个房间的访问权限。",
  CSRF_REJECTED: "操作验证失败，请刷新页面后重试。",
  ORIGIN_REJECTED: "操作验证失败，请刷新页面后重试。",
  RATE_LIMITED: "操作过于频繁，请稍后重试。",
  ROOM_BUSY: "房间暂时繁忙，请稍后重试。",
  SERVICE_UNAVAILABLE: "服务暂时无法连接，请稍后重试。",
};

export function dismissFrontendError() {
  frontendError.value = undefined;
  lastError = undefined;
}

export function expectedFrontendCancellation(error: unknown): boolean {
  return (
    error instanceof StaleIdentity ||
    isNavigationFailure(error) ||
    (error instanceof Error &&
      [
        "AbortError",
        "CanceledError",
        "CancelledError",
        "PlaybackCancelled",
        "StaleIdentity",
      ].includes(error.name)) ||
    (error instanceof RequestFailure && error.code === "STALE_PLAYBACK_PLAN")
  );
}

function describe(
  error: unknown,
  context: Context,
): { message: string; category: Category; reference?: string } {
  if (error instanceof RequestFailure) {
    const message =
      playbackFailureMessage(error.code) ??
      (Object.hasOwn(requestMessages, error.code)
        ? requestMessages[error.code]
        : undefined) ??
      "请求未完成，请确认操作结果后重试。";
    return {
      message,
      category: "request",
      reference:
        error.requestId && uuid.test(error.requestId)
          ? error.requestId
          : undefined,
    };
  }
  if (
    context.source === "resource" ||
    (error instanceof Error &&
      (error.name === "ChunkLoadError" ||
        /^(?:Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS)/i.test(
          error.message,
        )))
  )
    return {
      message: "页面资源加载失败，请检查网络后刷新页面。",
      category: "resource",
    };
  if (
    error instanceof TypeError &&
    [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
    ].includes(error.message)
  )
    return { message: "网络连接中断，请检查连接后重试。", category: "network" };
  return context.rendering
    ? { message: "页面显示出现问题，请刷新后重试。", category: "render" }
    : {
        message: "操作未能完成，请确认结果后重试；如果问题持续，请刷新页面。",
        category: "unexpected",
      };
}

/** Keep URLs, credentials, raw messages, component state and stacks out of both
 * the shared notice and the console. API UUIDs and fixed categories are enough
 * to connect a user report to a server request or frontend failure boundary. */
export function reportFrontendError(error: unknown, context: Context) {
  if (expectedFrontendCancellation(error)) return;
  if (frontendError.value && error !== undefined && error === lastError) return;
  lastError = error;
  const detail = describe(error, context);
  const reference = detail.reference ?? `FE-${++sequence}`;
  frontendError.value = {
    message: `${detail.message}（诊断编号：${reference}）`,
    reference,
  };
  console.error("RainSync frontend failure", {
    source: context.source,
    category: detail.category,
    reference,
  });
}

export function installGlobalErrorHandlers(
  app: Pick<App, "config">,
  router: Pick<Router, "onError">,
  target: EventTarget = window,
) {
  const previous = app.config.errorHandler;
  const handler: NonNullable<App["config"]["errorHandler"]> = (
    error,
    _instance,
    info,
  ) =>
    reportFrontendError(error, {
      source: "component",
      rendering: info === "render function",
    });
  app.config.errorHandler = handler;
  const stopRouter = router.onError((error) =>
    reportFrontendError(error, { source: "navigation" }),
  );
  const rejected = (event: Event) => {
    reportFrontendError((event as PromiseRejectionEvent).reason, {
      source: "promise",
    });
    event.preventDefault();
  };
  const failed = (event: Event) => {
    const failure = event as ErrorEvent;
    // ResizeObserver defers remaining layout notifications to the next frame.
    // Its Window-only delivery notice has no exception object; real exceptions
    // and errors from resource elements still use the normal failure boundary.
    // https://drafts.csswg.org/resize-observer/#deliver-resize-loop-error
    if (
      event.target === target &&
      failure.error == null &&
      [
        "ResizeObserver loop completed with undelivered notifications.",
        "ResizeObserver loop limit exceeded",
      ].includes(failure.message)
    ) {
      event.preventDefault();
      return;
    }
    const tag = (event.target as Element | null)?.tagName;
    if (tag === "IMG" || tag === "VIDEO" || tag === "SOURCE") return;
    reportFrontendError((event as ErrorEvent).error, {
      source: tag === "SCRIPT" || tag === "LINK" ? "resource" : "script",
    });
    event.preventDefault();
  };
  target.addEventListener("unhandledrejection", rejected);
  target.addEventListener("error", failed, true);
  return () => {
    stopRouter();
    target.removeEventListener("unhandledrejection", rejected);
    target.removeEventListener("error", failed, true);
    if (app.config.errorHandler === handler) app.config.errorHandler = previous;
  };
}
