import type { ApiError } from "../../../packages/protocol";

/** The new UI accepts both structured errors and the previous alpha's strings
 * so it can be deployed before Server/Worker during a rolling upgrade. */
const playbackMessages: Record<string, string> = {
  UNSUPPORTED_TIMELINE: "此媒体时间轴无法安全映射，请使用已验证的连续播放路线",
  STALE_PLAYBACK_PLAN: "此播放方案已被新的操作替代，请重新加载当前播放",
  PLAYBACK_VIEWER_ORIGIN_REQUIRED: "旧播放器身份不能续用，请重新发起播放",
  INVALID_PLAN_GENERATION: "播放方案代次格式无效，请更新客户端",
  PLAYBACK_VIEWER_LIMIT_EXCEEDED:
    "此账号在该房间的播放器身份已达上限，现有播放器可继续使用；新播放器需使用新房间",
};

/** Hls' default XHR loader exposes the already-read body in networkDetails.
 * Match only our stable code/status; never display a raw media-origin body. */
export function isUnsupportedTimelineResponse(
  status: number | undefined,
  body: unknown,
): boolean {
  if (status !== 422 || typeof body !== "string" || body.length > 16384)
    return false;
  try {
    return JSON.parse(body)?.error?.code === "UNSUPPORTED_TIMELINE";
  } catch {
    return false;
  }
}

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
          : (playbackMessages[code] ?? "请求失败，请稍后重试");
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
