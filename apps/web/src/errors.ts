import type { ApiError } from "../../../packages/protocol";

/** The new UI accepts both structured errors and the previous alpha's strings
 * so it can be deployed before Server/Worker during a rolling upgrade. */
const playbackMessages: Record<string, string> = {
  PLATFORM_COLLECTION_INVALID:
    "播放列表链接无效；YouTube 仅支持 PL 编号或完整 /playlist?list=PL… 链接",
  PLATFORM_COLLECTION_SINGLE_REQUIRED: "一次只能展开一个合集或播放列表",
  PLATFORM_COLLECTION_UNSUPPORTED:
    "此类合集或播放列表暂不支持，请粘贴单独视频链接",
  PLATFORM_IMPORT_LIMIT: "一次最多预览和导入 20 条，输入不得超过 16 KiB",
  PLATFORM_IMPORT_DEADLINE: "本次预览或导入已超时，请重新预览或重试未导入条目",
  PLATFORM_ACCOUNT_CHANGED: "自己的对应平台会话已变化，请刷新后重新预览并确认",
  NATIVE_LIVE_WINDOW_EXPIRED: "当前直播窗口已过期，请重新加载以返回直播边缘",
  NATIVE_LIVE_CLIENT_UNSUPPORTED:
    "当前客户端未启用直播边缘与控制同步，请更新客户端",
  NATIVE_LIVE_BROADCAST_CHANGED: "直播场次已变化，请重新预览并导入此直播间",
  NATIVE_LIVE_NOT_BROADCASTING: "此直播场次已结束或尚未开播，请选择其他媒体",
  NATIVE_LIVE_RATE_LIMITED: "直播平台请求过于频繁，请稍后重试",
  NATIVE_LIVE_CAPACITY: "直播播放服务正忙，请稍后重试",
  NATIVE_LIVE_PLAYLIST_CHANGED: "直播播放列表已变化，请重新加载当前场次",
  NATIVE_LIVE_SEEK_UNSUPPORTED: "直播不支持房间进度跳转",
  NATIVE_LIVE_RATE_UNSUPPORTED: "直播仅支持 1 倍速",
  NATIVE_LIVE_END_UNSUPPORTED: "直播不会自动切换下一项，请手动选择媒体",
  NATIVE_LIVE_STATE_CHANGED: "直播身份已变化，请重新加载当前媒体",

  ADVANCED_LOCAL_SOURCE_REQUIRED:
    "高级播放当前仅支持由 Server 完整持有并核对版本的本地片源",
  DEDICATED_ADVANCED_ENDPOINT_REQUIRED:
    "高级播放需要受支持的专用接口，请更新客户端和服务端",
  INVALID_SUBTITLE_TRACK:
    "所选嵌入字幕不可用或无法安全烧录，请重新加载片源信息",
  NATIVE_PLATFORM_INVALID: "平台视频链接无效，请使用支持平台的完整视频链接",
  NATIVE_PLATFORM_INVALID_INTENT:
    "平台播放请求不受支持，请重新加载或更新客户端",
  NATIVE_PLATFORM_DEVICE_UNSUPPORTED: "浏览器不支持此平台视频所需的播放格式",
  NATIVE_PLATFORM_ACCESS_DENIED:
    "平台拒绝访问此视频，请检查自己的平台登录状态和视频权限。",
  NATIVE_PLATFORM_ANONYMOUS_UNSUPPORTED:
    "此视频需要平台登录或额外权限，当前请求使用匿名观看；可尝试使用自己的对应平台会话（平台支持时）",
  NATIVE_PLATFORM_PROVIDER_UNAVAILABLE:
    "此平台的服务端解析器未启用或暂不可用，请联系服务管理员",
  NATIVE_PLATFORM_EXTRACTOR_UNAVAILABLE:
    "YouTube 提取器未启用或暂不可用，请联系服务管理员",
  NATIVE_PLATFORM_RESOLVE_TIMEOUT: "平台视频解析超时，请稍后重试",
  NATIVE_PLATFORM_RESOLVE_FAILED: "平台视频解析失败，请重试或选择其他视频",
  NATIVE_PLATFORM_CODEC_UNSUPPORTED:
    "此平台视频的编码暂不受支持，请选择其他视频",
  NATIVE_PLATFORM_COMPATIBILITY_SOURCE_UNSUPPORTED:
    "此片源无法安全核对完整媒体身份，暂不支持兼容转码；平台授权、有效期和编码限制仍适用",
  NATIVE_PLATFORM_DESCRIPTOR_UNSUPPORTED:
    "此平台视频不支持安全的原生播放，请选择其他视频",
  NATIVE_PLATFORM_PROGRESSIVE_UNSUPPORTED:
    "此平台视频未提供可用的 MP4 播放路线",
  NATIVE_PLATFORM_URL_EXPIRED: "平台视频播放地址已失效，请重新加载",
  UNSUPPORTED_TIMELINE: "此媒体时间轴无法安全映射，请使用已验证的连续播放路线",
  STALE_PLAYBACK_PLAN: "此播放方案已被新的操作替代，请重新加载当前播放",
  PLAYBACK_VIEWER_ORIGIN_REQUIRED: "旧播放器身份不能续用，请重新发起播放",
  INVALID_PLAN_GENERATION: "播放方案代次格式无效，请更新客户端",
  PLAYBACK_VIEWER_LIMIT_EXCEEDED:
    "此账号在该房间的播放器身份已达上限，现有播放器可继续使用；新播放器需使用新房间",
};

export function playbackFailureMessage(code: string): string | undefined {
  return Object.hasOwn(playbackMessages, code)
    ? playbackMessages[code]
    : undefined;
}

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
      playbackFailureMessage(code) ??
      (typeof detail?.message === "string"
        ? detail.message
        : typeof error === "string"
          ? error
          : "请求失败，请稍后重试");
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
