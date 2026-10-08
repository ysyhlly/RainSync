import type { ControlRecoveryMetricsSample } from "../../../../../packages/protocol";

export const CONTROL_RECOVERY_MAX_MS = 604_800_000;
const CLOCK_DIFFERENCE_ALLOWANCE_MS = 5_000;

export type ControlRecoveryMetricsFence = Readonly<{
  /** One opaque identity per room/auth lifetime, independent of media. */
  identity: object;
  generation: number;
}>;
type Stamp = { monotonic: number; wall: number; background: boolean };
type Attempt = {
  fence: ControlRecoveryMetricsFence;
  opened: boolean;
  applied: boolean;
  closed: boolean;
  start?: Stamp;
};
type Config = {
  current: () => ControlRecoveryMetricsFence | undefined;
  foreground: () => boolean;
  now?: () => number;
  wallNow?: () => number;
};
const validTime = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const validFence = (value: ControlRecoveryMetricsFence | undefined) =>
  !!value &&
  typeof value.identity === "object" &&
  value.identity !== null &&
  Number.isSafeInteger(value.generation) &&
  value.generation > 0;

/** Client callback intervals only. No timer, transport, storage, online hint,
 * playback state or clock calibration. Unknown coverage produces no sample. */
export function createControlRecoveryMetrics(config: Config) {
  const now = config.now ?? (() => performance.now());
  const wallNow = config.wallNow ?? (() => Date.now());
  let attempt: Attempt | undefined;
  let outage: Stamp | undefined;
  let previous: Stamp | undefined;
  let disposed = false;

  function current(fence: ControlRecoveryMetricsFence) {
    try {
      const live = config.current();
      return (
        !disposed &&
        validFence(fence) &&
        validFence(live) &&
        live!.identity === fence.identity &&
        live!.generation === fence.generation
      );
    } catch {
      return false;
    }
  }
  function allowed(fence: ControlRecoveryMetricsFence) {
    return (
      current(fence) &&
      attempt?.fence.identity === fence.identity &&
      attempt.fence.generation === fence.generation
    );
  }
  function stamp(): Stamp | undefined {
    try {
      const monotonic = now(),
        wall = wallNow();
      const value = { monotonic, wall, background: !config.foreground() };
      if (
        !validTime(monotonic) ||
        !validTime(wall) ||
        (previous &&
          (monotonic < previous.monotonic ||
            Math.abs(wall - previous.wall - (monotonic - previous.monotonic)) >
              CLOCK_DIFFERENCE_ALLOWANCE_MS))
      ) {
        if (attempt) attempt.start = undefined;
        outage = undefined;
        previous = undefined;
        return;
      }
      previous = value;
      return value;
    } catch {
      if (attempt) attempt.start = undefined;
      outage = undefined;
      previous = undefined;
      return;
    }
  }
  function interval(start: Stamp, end: Stamp): number | undefined {
    const elapsed = end.monotonic - start.monotonic;
    const wallElapsed = end.wall - start.wall;
    if (
      elapsed < 0 ||
      elapsed > CONTROL_RECOVERY_MAX_MS ||
      Math.abs(wallElapsed - elapsed) > CLOCK_DIFFERENCE_ALLOWANCE_MS
    )
      return;
    return Math.floor(end.monotonic) - Math.floor(start.monotonic);
  }
  function reset() {
    attempt = undefined;
    outage = undefined;
    previous = undefined;
  }
  return {
    beginAttempt(fence: ControlRecoveryMetricsFence): void {
      if (!current(fence)) return;
      // Repeated begin must not erase an observed open or recovered baseline.
      if (allowed(fence)) return;
      if (attempt?.fence.identity !== fence.identity) outage = undefined;
      if (!outage) previous = undefined;
      attempt = {
        fence: { ...fence },
        opened: false,
        applied: false,
        closed: false,
      };
    },
    opened(fence: ControlRecoveryMetricsFence): void {
      if (!allowed(fence) || attempt!.opened || attempt!.closed) return;
      attempt!.opened = true;
      attempt!.start = stamp();
      if (!attempt!.start) outage = undefined;
    },
    disconnected(
      fence: ControlRecoveryMetricsFence,
      recoverable: boolean,
    ): void {
      if (!allowed(fence)) return;
      if (!recoverable) {
        reset();
        return;
      }
      if (attempt!.closed) return;
      attempt!.closed = true;
      const at = stamp();
      // Failed initial joins and explicit resyncs do not invent a disconnect.
      // Further failed attempts retain the first observed outage boundary.
      if (attempt!.applied && !outage) outage = at;
      attempt!.start = undefined;
    },
    snapshotApplied(
      fence: ControlRecoveryMetricsFence,
      negotiatedVersion: unknown,
    ): ControlRecoveryMetricsSample | undefined {
      if (!allowed(fence) || attempt!.applied || attempt!.closed) return;
      attempt!.applied = true;
      const start = attempt!.start,
        disconnected = outage;
      attempt!.start = undefined;
      outage = undefined;
      // Mark even a legacy snapshot recovered, but never send an unknown frame.
      if (negotiatedVersion !== 1 || !start) {
        previous = undefined;
        return;
      }
      const end = stamp();
      previous = undefined;
      if (!end) return;
      const socketMs = interval(start, end);
      const outageMs = disconnected ? interval(disconnected, end) : undefined;
      if (
        socketMs === undefined ||
        (disconnected && (outageMs === undefined || outageMs < socketMs))
      )
        return;
      return Object.freeze({
        type: "CONTROL_RECOVERY_METRICS",
        version: 1,
        socket_open_to_state_applied_ms: socketMs,
        ...(outageMs === undefined
          ? {}
          : {
              disconnect_observed_to_state_applied_ms: outageMs,
            }),
        background:
          start.background || end.background || !!disconnected?.background,
      });
    },
    visibilityChanged(foreground: boolean): void {
      if (disposed || foreground) return;
      if (attempt?.start) attempt.start.background = true;
      if (outage) outage.background = true;
    },
    suspended(): void {
      // A persisted page restore cannot certify continuity of either clock.
      if (attempt) attempt.start = undefined;
      outage = undefined;
      previous = undefined;
    },
    reset,
    dispose(): void {
      reset();
      disposed = true;
    },
  };
}
