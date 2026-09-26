import type { ApiError } from "../../../packages/protocol";

/** The new UI accepts both structured errors and the previous alpha's strings
 * so it can be deployed before Server/Worker during a rolling upgrade. */
export class RequestFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(response: unknown) {
    const error =
      response && typeof response === "object" && "error" in response
        ? response.error
        : undefined;
    const detail =
      error && typeof error === "object"
        ? (error as Partial<ApiError>)
        : undefined;
    const code =
      typeof detail?.code === "string"
        ? detail.code
        : typeof error === "string"
          ? error.toUpperCase()
          : "INVALID_RESPONSE";
    const requestId =
      typeof detail?.request_id === "string" &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(detail.request_id)
        ? detail.request_id
        : undefined;
    const message =
      typeof detail?.message === "string"
        ? detail.message
        : typeof error === "string"
          ? error
          : "请求失败，请稍后重试";
    super(message + (requestId ? `（诊断编号：${requestId}）` : ""));
    this.name = "RequestFailure";
    this.code = code;
    this.retryable = detail?.retryable === true;
    this.requestId = requestId;
    this.retryAfterMs =
      typeof detail?.retry_after_ms === "number" &&
      Number.isFinite(detail.retry_after_ms) &&
      detail.retry_after_ms >= 0
        ? detail.retry_after_ms
        : undefined;
  }
}

export function stopsReconnect(error: RequestFailure): boolean {
  return [
    "LOGIN_REQUIRED",
    "SESSION_EXPIRED",
    "NOT_A_MEMBER",
    "ORIGIN_REJECTED",
    "PROTOCOL_VERSION",
  ].includes(error.code);
}
