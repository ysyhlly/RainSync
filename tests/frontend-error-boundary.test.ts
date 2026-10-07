import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "vue";
import type { Router } from "vue-router";
import { RequestFailure } from "../apps/web/src/errors";
import { StaleIdentity } from "../apps/web/src/shared/api/client";
import {
  dismissFrontendError,
  frontendError,
  installGlobalErrorHandlers,
  reportFrontendError,
} from "../apps/web/src/app/global-errors";

beforeEach(() => {
  dismissFrontendError();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  dismissFrontendError();
  vi.restoreAllMocks();
});

it.each([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
])(
  "handles the native layout-delivery notice without an operation error: %s",
  (message) => {
    const target = new EventTarget();
    const app = { config: {} } as Pick<App, "config">;
    const router = { onError: () => () => {} } as Pick<Router, "onError">;
    const dispose = installGlobalErrorHandlers(app, router, target);
    try {
      const event = new Event("error", { cancelable: true });
      Object.assign(event, { message, error: null });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(frontendError.value).toBeUndefined();
      expect(console.error).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  },
);

it("still reports real exceptions with a layout-like message and other native errors", () => {
  const target = new EventTarget();
  const app = { config: {} } as Pick<App, "config">;
  const router = { onError: () => () => {} } as Pick<Router, "onError">;
  const dispose = installGlobalErrorHandlers(app, router, target);
  try {
    for (const payload of [
      {
        message: "ResizeObserver loop limit exceeded",
        error: new Error("real failure"),
      },
      { message: "some other runtime error", error: null },
      {
        message: "ResizeObserver loop limit exceeded with private URL",
        error: null,
      },
    ]) {
      dismissFrontendError();
      const event = new Event("error", { cancelable: true });
      Object.assign(event, payload);
      target.dispatchEvent(event);
      expect(frontendError.value?.message).toContain("操作未能完成");
      expect(event.defaultPrevented).toBe(true);
    }
    expect(console.error).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "private URL",
    );
  } finally {
    dispose();
  }
});

it("gives a failed route asset a useful recovery message without logging its signed URL", () => {
  const privateUrl = "https://private.example/room?token=private-credential";
  const failure = new TypeError(
    `Failed to fetch dynamically imported module: ${privateUrl}`,
  );
  reportFrontendError(failure, { source: "navigation" });
  expect(frontendError.value?.message).toContain("页面资源加载失败");
  expect(frontendError.value?.message).toContain("检查网络");
  expect(JSON.stringify(frontendError.value)).not.toContain(privateUrl);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    "private-credential",
  );
  expect(console.error).toHaveBeenCalledWith(
    "RainSync frontend failure",
    expect.objectContaining({ source: "navigation", category: "resource" }),
  );
  reportFrontendError(failure, { source: "promise" });
  expect(console.error).toHaveBeenCalledTimes(1);
});

it("keeps stable API context and a validated request ID without echoing backend error text", () => {
  reportFrontendError(
    new RequestFailure({
      error: {
        code: "SESSION_EXPIRED",
        message: "password=private-value",
        request_id: "11111111-1111-4111-8111-111111111111",
      },
    }),
    { source: "promise" },
  );
  expect(frontendError.value?.message).toContain("重新登录");
  expect(frontendError.value?.reference).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(
    JSON.stringify([frontendError.value, vi.mocked(console.error).mock.calls]),
  ).not.toContain("private-value");
  reportFrontendError(
    new RequestFailure({
      error: { code: "PRIVATE_UNKNOWN", message: "Bearer another-secret" },
    }),
    { source: "promise" },
  );
  expect(frontendError.value?.message).toContain("确认操作结果");
  expect(
    JSON.stringify([frontendError.value, vi.mocked(console.error).mock.calls]),
  ).not.toContain("another-secret");
});

it("ignores replaced identity, aborted fetch and stale playback results", () => {
  for (const failure of [
    new StaleIdentity(),
    new DOMException("token=hidden", "AbortError"),
    Object.assign(new Error("cancelled playback"), {
      name: "PlaybackCancelled",
    }),
    new RequestFailure({ error: { code: "STALE_PLAYBACK_PLAN" } }),
  ])
    reportFrontendError(failure, { source: "promise" });
  expect(frontendError.value).toBeUndefined();
  expect(console.error).not.toHaveBeenCalled();
});

it("connects Vue, router and window boundaries and removes all owned handlers", () => {
  const prior = vi.fn(),
    app = { config: { errorHandler: prior } } as unknown as Pick<App, "config">;
  let navigationError: (error: Error) => void = () => {};
  const unregister = vi.fn(),
    router = {
      onError: vi.fn((callback: (error: Error) => void) => {
        navigationError = callback;
        return unregister;
      }),
    } as unknown as Pick<Router, "onError">;
  const target = new EventTarget();
  const dispose = installGlobalErrorHandlers(app, router, target);
  app.config.errorHandler?.(
    new Error("cookie=secret"),
    null,
    "render function",
  );
  expect(frontendError.value?.message).toContain("页面显示出现问题");
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    "cookie",
  );
  dismissFrontendError();
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.defineProperty(event, "reason", {
    value: new DOMException("cancelled", "AbortError"),
  });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(frontendError.value).toBeUndefined();
  navigationError(new TypeError("Failed to fetch"));
  expect(frontendError.value?.message).toContain("网络连接中断");
  dispose();
  expect(unregister).toHaveBeenCalledOnce();
  expect(app.config.errorHandler).toBe(prior);
  dismissFrontendError();
  const later = new Event("unhandledrejection");
  Object.defineProperty(later, "reason", { value: new Error("late") });
  target.dispatchEvent(later);
  expect(frontendError.value).toBeUndefined();
});
