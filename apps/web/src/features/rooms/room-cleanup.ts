export interface RoomCleanupStatus {
  lifecycle: "active" | "closing" | "closed" | "archived";
  cleanup: {
    attempts: number;
    completed: boolean;
    phase?: "queued" | "running" | "waiting" | "completed";
    blockers: string[];
    last_error: string | null;
    elapsed_ms?: number;
    next_attempt_at_ms?: number;
    lease_active: boolean;
    retryable: boolean;
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finiteCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseRoomCleanupStatus(value: unknown): RoomCleanupStatus {
  if (
    !record(value) ||
    !["active", "closing", "closed", "archived"].includes(
      String(value.lifecycle),
    ) ||
    !record(value.cleanup)
  )
    throw Error("无法读取房间清理状态，请重新加载");
  const c = value.cleanup;
  if (
    !finiteCount(c.attempts) ||
    typeof c.completed !== "boolean" ||
    (c.blockers != null &&
      (!Array.isArray(c.blockers) ||
        c.blockers.some((x) => typeof x !== "string"))) ||
    (c.phase != null &&
      !["queued", "running", "waiting", "completed"].includes(String(c.phase)))
  )
    throw Error("无法读取房间清理状态，请重新加载");
  return {
    lifecycle: value.lifecycle as RoomCleanupStatus["lifecycle"],
    cleanup: {
      attempts: c.attempts as number,
      completed: c.completed,
      phase: c.phase as RoomCleanupStatus["cleanup"]["phase"],
      blockers: (c.blockers as string[]) ?? [],
      last_error: typeof c.last_error === "string" ? c.last_error : null,
      elapsed_ms: finiteCount(c.elapsed_ms)
        ? (c.elapsed_ms as number)
        : undefined,
      next_attempt_at_ms: finiteCount(c.next_attempt_at_ms)
        ? (c.next_attempt_at_ms as number)
        : undefined,
      lease_active: c.lease_active === true,
      retryable: c.retryable === true,
    },
  };
}
const CLEANUP_FALLBACK = "尚待确认释放的资源";
export function cleanupBlockerLabel(code: string): string {
  const labels: Record<string, string> = {
    playback_requests: "播放准备请求",
    preparing: "播放准备请求",
    executions: "媒体处理进程",
    processes: "媒体处理进程",
    static_hls: "视频分片与读取",
    captures: "视频分片与读取",
    legacy_upstream: "上游播放会话",
    upstream: "上游播放会话",
    transfers: "媒体传输",
    relay: "媒体转发",
    distributed: "分布式播放",
    preparation_owners: "准备任务资源",
    leases: "仍在使用的资源",
    legacy_agent_drain_unconfirmed: "旧版传输任务尚未确认释放",
    playback_preparation_drain_unconfirmed: "播放准备尚未确认释放",
    media_execution_drain_unconfirmed: "媒体读取尚未确认释放",
    static_hls_capture_drain_unconfirmed: "视频分片读取尚未确认释放",
    agent_transfer_drain_unconfirmed: "媒体传输尚未确认释放",
    upstream_operation_unconfirmed: "上游操作尚未确认结束",
    upstream_cleanup_failed: "上游清理失败",
    legacy_upstream_cleanup_unconfirmed: "上游播放会话尚未确认释放",
    upstream_cleanup_pending: "上游播放会话正在释放",
    playback_revocation_pending: "播放正在停止",
    distributed_compute_drain_unconfirmed: "分布式播放尚未确认释放",
    room_cleanup_locked: "清理任务正在等待房间锁",
    room_cleanup_timeout: "清理检查超时",
    room_cleanup_retry: "清理将自动重试",
  };
  return labels[code] ?? CLEANUP_FALLBACK;
}
