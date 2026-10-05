import type { PlaybackReadiness } from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { PlaybackTimeout } from "../../playback-request";

export type PlaybackPreparationPhase =
  | "idle"
  | "preparing"
  | "queued"
  | "transcoding"
  | "ready"
  | "cancelling"
  | "cancelled"
  | "failed";

export type PlaybackPreparationFailure = {
  message: string;
  retryable: boolean;
  code?: string;
  requestId?: string;
  retryAfterMs?: number;
};

export type PlaybackPreparationState = {
  phase: PlaybackPreparationPhase;
  generation?: number;
  sessionId?: string;
  deliveryMode?: string;
  failure?: PlaybackPreparationFailure;
};

/** UI adapter for future prepare responses. The caller must validate identity,
 * room/media generation and authorization before forwarding server evidence.
 * queued/transcoding must be explicit facts, never inferred from elapsed time.
 * No progress percentage, queue position or completion ETA is fabricated. */
export type PlaybackPreparationSnapshot = {
  generation: number;
  phase: "preparing" | "queued" | "transcoding" | "ready";
  sessionId?: string;
  deliveryMode?: string;
};

export function applyPreparationSnapshot(
  current: PlaybackPreparationState,
  snapshot: PlaybackPreparationSnapshot,
): PlaybackPreparationState {
  if (
    !Number.isInteger(snapshot.generation) ||
    snapshot.generation <= 0 ||
    snapshot.generation > 0xffff_ffff ||
    !["preparing", "queued", "transcoding", "ready"].includes(snapshot.phase) ||
    current.generation !== snapshot.generation ||
    ["idle", "cancelling", "cancelled", "failed"].includes(current.phase) ||
    (current.sessionId && current.sessionId !== snapshot.sessionId)
  )
    return current;
  return { ...current, ...snapshot, failure: undefined };
}

/** Preparing a direct/remux route does not prove that a transcode is running. */
export function preparationReadinessSnapshot(
  readiness: PlaybackReadiness,
  deliveryMode?: string,
): PlaybackPreparationSnapshot | undefined {
  if (
    readiness.plan_generation === undefined ||
    !["queued", "preparing", "ready"].includes(readiness.status)
  )
    return;
  return {
    generation: readiness.plan_generation,
    sessionId: readiness.session_id,
    deliveryMode,
    phase:
      readiness.status === "preparing" &&
      ["transcode", "audio_transcode"].includes(deliveryMode ?? "")
        ? "transcoding"
        : readiness.status,
  };
}

const failureMessages: Record<string, string> = {
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

  LOGIN_REQUIRED: "登录已失效，请重新登录后播放。",
  SESSION_EXPIRED: "登录已失效，请重新登录后播放。",
  NOT_A_MEMBER: "你已不在此房间，请重新加入后播放。",
  FORBIDDEN: "当前账号没有播放此媒体的权限。",
  MEDIA_JOB_FAILED: "媒体处理失败，请稍后重试或选择其他影片。",
  MEDIA_UNAVAILABLE: "当前片源暂不可用，请检查片源连接。",
  SOURCE_PROBE_FAILED: "无法读取媒体信息，请检查片源。",
  AGENT_OFFLINE: "NAS 代理离线，恢复连接后重试。",
  AGENT_TIMEOUT: "NAS 代理响应超时，请稍后重试。",
  MEDIA_QUEUE_FULL: "媒体处理队列已满，请稍后重试。",
  PROBE_BUSY: "媒体探测资源正忙，请稍后重试。",
  SERVICE_UNAVAILABLE: "播放服务暂不可用，请稍后重试。",
  RATE_LIMITED: "播放请求过于频繁，请稍后重试。",
  UNSUPPORTED_TIMELINE: "此媒体时间轴无法安全播放，请选择其他播放路线。",
  UNSUPPORTED_MEDIA: "当前媒体格式不受支持，请选择其他影片。",
  UNSUPPORTED_CODEC: "当前媒体编码不受支持，请选择其他影片。",
  STALE_PLAYBACK_PLAN: "播放方案已过期，请重新加载当前播放。",
  UPSTREAM_PLAYBACK_FAILED: "上游媒体服务无法准备播放，请检查片源。",
  REQUEST_TIMEOUT: "播放服务响应超时，请稍后重试。",
};

/** Keep raw server/native messages, URLs and paths out of the status surface. */
export function preparationFailure(error: unknown): PlaybackPreparationFailure {
  if (error instanceof RequestFailure) {
    const safeCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : undefined;
    return {
      message:
        (safeCode && failureMessages[safeCode]) ||
        "播放准备失败，请检查片源或稍后重试。",
      retryable: error.retryable,
      code: safeCode,
      requestId: error.requestId,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return {
    message:
      error instanceof PlaybackTimeout
        ? "播放准备超时，请重新发起播放。"
        : error instanceof TypeError
          ? "无法连接播放服务，请检查网络后重试。"
          : "播放准备失败，请检查连接后重试。",
    retryable: true,
  };
}

export function describePlaybackPreparation(state: PlaybackPreparationState) {
  const labels: Record<PlaybackPreparationPhase, [string, string]> = {
    idle: ["", ""],
    preparing: ["正在准备影片", "正在检查片源并等待播放资源。"],
    queued: ["正在排队", "媒体处理资源正忙，等待服务端开始处理。"],
    transcoding: ["正在转码", "正在生成播放资源，生成所需片段后即可播放。"],
    ready: ["可播放", "播放资源已就绪；画面仍需由播放器加载。"],
    cancelling: ["正在取消播放准备", "正在停止本地播放并确认服务端请求撤销。"],
    cancelled: ["播放准备已取消", "可重新发起本地播放。"],
    failed: ["播放失败", state.failure?.message ?? "请检查连接或片源后重试。"],
  };
  const [label, detail] = labels[state.phase];
  return {
    label,
    detail,
    busy: ["preparing", "queued", "transcoding", "cancelling"].includes(
      state.phase,
    ),
    cancel: ["preparing", "queued", "transcoding"].includes(state.phase),
    retry:
      state.phase === "cancelled" ||
      (state.phase === "failed" && state.failure?.retryable === true),
  };
}
