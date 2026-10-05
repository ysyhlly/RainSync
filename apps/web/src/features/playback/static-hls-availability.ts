/** Availability is a short-lived UI observation, never admission or a plan. */
export type StaticHlsAvailability = Readonly<{
  version: 1;
  available: boolean;
  reason:
    | "operator_disabled"
    | "source_unsupported"
    | "worker_unavailable"
    | "installed_runtime";
}>;
export function staticHlsAvailability(
  value: unknown,
): StaticHlsAvailability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 3 ||
    !["version", "available", "reason"].every(key => Object.hasOwn(v, key)) ||
    v.version !== 1 ||
    typeof v.available !== "boolean" ||
    ![
      "operator_disabled",
      "source_unsupported",
      "worker_unavailable",
      "installed_runtime",
    ].includes(String(v.reason)) ||
    v.available !== (v.reason === "installed_runtime")
  )
    return;
  return Object.freeze({
    version: 1,
    available: v.available,
    reason: v.reason,
  } as StaticHlsAvailability);
}
export function staticHlsAvailabilityLabel(
  value?: StaticHlsAvailability,
): string {
  return value?.reason === "installed_runtime"
    ? "兼容管线已安装；片源仍需独立资格检查"
    : value?.reason === "operator_disabled"
      ? "管理员尚未启用静态 HLS 兼容管线"
      : value?.reason === "source_unsupported"
        ? "此方案仅适用于有限 HTTP 静态 HLS 片源"
        : value?.reason === "worker_unavailable"
          ? "Worker 兼容管线暂不可用"
          : "尚未确认服务可用性，请重新加载播放";
}
export const STATIC_HLS_AVAILABILITY_MS = 5000;
export function staticHlsOfferCurrent(
  available: StaticHlsAvailability | undefined,
  observedAt: number | undefined,
  now: number,
): boolean {
  return (
    available?.available === true &&
    observedAt !== undefined &&
    Number.isFinite(now) &&
    Number.isFinite(observedAt) &&
    now >= observedAt &&
    now - observedAt < STATIC_HLS_AVAILABILITY_MS
  );
}
