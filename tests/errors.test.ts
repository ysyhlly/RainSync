import { expect, it } from "vitest";
import { RequestFailure, stopsReconnect } from "../apps/web/src/errors";

it("shows structured diagnostics and stops reconnecting after session expiry", () => {
  const error = new RequestFailure({
    error: {
      code: "SESSION_EXPIRED",
      message: "请重新登录",
      retryable: false,
      request_id: "11111111-1111-4111-8111-111111111111",
    },
  });
  expect(error.message).toContain("请重新登录");
  expect(error.message).toContain("11111111-1111-4111-8111-111111111111");
  expect(error.retryable).toBe(false);
  expect(error.retryAfterMs).toBeUndefined();
  expect(stopsReconnect(error)).toBe(true);
});

it("preserves bounded retry information without inventing a delay", () => {
  const error = new RequestFailure({
    error: {
      code: "ROOM_BUSY",
      message: "房间繁忙",
      retryable: true,
      retry_after_ms: 1200,
    },
  });
  expect(error.retryable).toBe(true);
  expect(error.retryAfterMs).toBe(1200);
  expect(stopsReconnect(error)).toBe(false);
  expect(
    new RequestFailure({ error: { retry_after_ms: -1 } }).retryAfterMs,
  ).toBeUndefined();
});

it("handles old alpha and non-JSON gateway errors during upgrades", () => {
  const legacy = new RequestFailure({ error: "session_expired" });
  expect(legacy.message).toBe("session_expired");
  expect(stopsReconnect(legacy)).toBe(true);
  expect(new RequestFailure(null).message).not.toContain("[object Object]");
  expect(new RequestFailure({ error: {} }).retryable).toBe(false);
});

it("command permission errors do not terminate the watching connection", () => {
  for (const code of ["CONTROLLER_REQUIRED", "FORBIDDEN"])
    expect(stopsReconnect(new RequestFailure({ error: { code } }))).toBe(false);
  expect(stopsReconnect(new RequestFailure({ error: "forbidden" }))).toBe(
    false,
  );
  expect(
    stopsReconnect(new RequestFailure({ error: { code: "NOT_A_MEMBER" } })),
  ).toBe(true);
});

it("explains locally detected stale playback plans without automatic retry", () => {
  const failure = new RequestFailure({
    error: { code: "STALE_PLAYBACK_PLAN" },
  });
  expect(failure.message).toContain("新的操作替代");
  expect(failure.retryable).toBe(false);
  expect(
    new RequestFailure({ error: { code: "PLAYBACK_VIEWER_LIMIT_EXCEEDED" } })
      .message,
  ).toContain("现有播放器");
});

it("shows media failure guidance without treating upstream denial as logout", () => {
  for (const code of [
    "MEDIA_INPUT_INVALID",
    "MEDIA_INPUT_DENIED",
    "MEDIA_DECODER_UNAVAILABLE",
    "MEDIA_ENCODER_UNAVAILABLE",
  ]) {
    const error = new RequestFailure({
      error: { code, message: "请检查媒体或处理程序", retryable: false },
    });
    expect(error.message).toBe("请检查媒体或处理程序");
    expect(error.retryable).toBe(false);
    expect(stopsReconnect(error)).toBe(false);
  }
});
