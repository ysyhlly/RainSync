import type { Ref } from "vue";
import type { createPlaybackSynchronization } from "./playback-synchronization";

/** One call's original plan/element stay inside the runtime adapters. Facts
 * remain live, and play/edge actions perform their property access when called. */
export type GesturePlaybackTarget = Readonly<{
  live: boolean;
  ended: boolean;
  terminal: boolean;
  playing: boolean;
  edge: () => number | undefined;
  align: (edge: number | undefined) => void;
  failLive: () => void;
  play: () => Promise<void>;
  afterPlay: (revision: number, serial: number) => boolean;
}>;
export type GesturePlaybackSelection = Readonly<{
  failed: boolean;
  current: () => GesturePlaybackTarget | undefined;
}>;
type GestureSynchronization = Readonly<
  Pick<
    ReturnType<typeof createPlaybackSynchronization<object>>,
    | "ensureBaseRate"
    | "pendingPlay"
    | "beginGesture"
    | "claimPlay"
    | "failPlay"
    | "releasePlay"
  >
>;

/** The complete explicit gesture action, with the original two awaits. The
 * shared owner retains play/rate state; automatic reconciliation is a callback. */
export function createPlaybackGesture(ctx: {
  active: () => boolean;
  capture: () => GesturePlaybackSelection;
  clockUsable: () => boolean;
  clockRevision: () => number;
  queueApply: () => void;
  synchronization: GestureSynchronization;
  blocked: Pick<Ref<boolean>, "value">;
  isFailure: (
    failure: unknown,
    name: "NotAllowedError" | "AbortError",
  ) => boolean;
  interrupt: () => void;
  clearInterruption: () => void;
  observe: () => void;
  reconcile: () => Promise<void>;
}) {
  return async function enablePlayback() {
    if (!ctx.active()) return;
    const selection = ctx.capture();
    if (selection.failed) return;
    if (!ctx.clockUsable()) {
      ctx.queueApply();
      return;
    }
    const target = selection.current();
    if (
      target &&
      ctx.synchronization.ensureBaseRate() &&
      !ctx.synchronization.pendingPlay
    ) {
      if (target.live) {
        if (target.terminal || target.ended) {
          if (!target.terminal) target.failLive();
          return;
        }
        if (!target.playing) return;
        const edge = target.edge();
        target.align(edge);
      }
      const serial = ctx.synchronization.beginGesture(),
        revision = ctx.clockRevision();
      const playing = ctx.synchronization.claimPlay(true);
      // Gesture admission resumes the existing budgets while play waits.
      ctx.blocked.value = false;
      ctx.observe();
      try {
        await target.play();
      } catch (failure) {
        if (!target.afterPlay(revision, serial)) return;
        if (ctx.isFailure(failure, "NotAllowedError")) {
          ctx.blocked.value = true;
          ctx.observe();
        } else {
          ctx.synchronization.failPlay();
          if (ctx.isFailure(failure, "AbortError")) {
            ctx.interrupt();
            return;
          }
        }
        throw failure;
      } finally {
        ctx.synchronization.releasePlay(playing);
      }
      if (!target.afterPlay(revision, serial)) return;
      ctx.blocked.value = false;
      ctx.clearInterruption();
      ctx.observe();
      await ctx.reconcile();
    }
  };
}
