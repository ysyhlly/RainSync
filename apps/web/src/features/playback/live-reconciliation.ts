import type { Ref } from "vue";
import type { nativeLiveDirective } from "./native-live";
import type { createPlaybackSynchronization } from "./playback-synchronization";

/** Private to one reconciliation call. The runtime retains the original room,
 * plan, element and apply serial; no reusable media authority escapes. */
export type LiveReconciliationTarget = Readonly<{
  directive: () => ReturnType<typeof nativeLiveDirective>;
  terminal: boolean;
  readyState: number;
  paused: boolean;
  needsEdge: boolean;
  failChanged: () => void;
  failOffline: () => void;
  pause: () => void;
  requireEdge: () => void;
  edge: () => number | undefined;
  align: (edge: number) => void;
  play: () => Promise<void>;
  afterPlay: (revision: number) => boolean;
}>;
type LiveSynchronization = Readonly<
  Pick<
    ReturnType<typeof createPlaybackSynchronization<object>>,
    | "resetCorrection"
    | "ensureBaseRate"
    | "restoreBaseRate"
    | "clearPendingApply"
    | "pendingPlay"
    | "playFailed"
    | "claimPlay"
    | "failPlay"
    | "releasePlay"
  >
>;

/** Automatic live policy keeps its one original await and shared play token.
 * Admission and the outer cancellation/recovery boundary remain in runtime. */
export function createLiveReconciliation(ctx: {
  synchronization: LiveSynchronization;
  blocked: Pick<Ref<boolean>, "value">;
  foreground: () => boolean;
  clockRevision: () => number;
  isPermissionDenied: (failure: unknown) => boolean;
  interrupt: () => void;
}) {
  return async function reconcileLive(
    target: LiveReconciliationTarget,
    force: boolean,
    userSeek: boolean,
  ) {
    const directive = target.directive();
    ctx.synchronization.resetCorrection();
    if (directive === "stale") {
      target.failChanged();
      return;
    }
    if (directive === "offline") {
      if (!target.terminal) target.failOffline();
      return;
    }
    if (!ctx.synchronization.ensureBaseRate()) return;
    if (ctx.synchronization.restoreBaseRate() === undefined) return;
    if (directive === "pause") {
      target.pause();
      target.requireEdge();
      return;
    }
    if (directive === "wait" || !ctx.foreground() || target.readyState < 1)
      return;
    if (userSeek) return; // Room-wide seeks are never broadcast timeline claims.
    if (target.paused) target.requireEdge();
    if (force || target.needsEdge) {
      const edge = target.edge();
      if (edge !== undefined) {
        target.align(edge);
      }
    }
    ctx.synchronization.clearPendingApply();
    if (
      target.paused &&
      !ctx.blocked.value &&
      !ctx.synchronization.pendingPlay &&
      !ctx.synchronization.playFailed
    ) {
      const playing = ctx.synchronization.claimPlay();
      const revision = ctx.clockRevision();
      try {
        await target.play();
        if (!target.afterPlay(revision)) return;
        ctx.blocked.value = false;
      } catch (failure) {
        if (!target.afterPlay(revision)) return;
        if (ctx.isPermissionDenied(failure)) ctx.blocked.value = true;
        else {
          ctx.synchronization.failPlay();
          ctx.interrupt();
        }
      } finally {
        ctx.synchronization.releasePlay(playing);
      }
    }
    return;
  };
}
