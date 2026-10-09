import type { Ref } from "vue";
import { containsPlaybackPosition } from "../../../../../packages/player-core";
import {
  target,
  type PlaybackState,
} from "../../../../../packages/sync-engine";
import type { createPlaybackSynchronization } from "./playback-synchronization";

type VodReconciliationState = Readonly<Omit<PlaybackState, "live">> & {
  readonly live?: Readonly<NonNullable<PlaybackState["live"]>>;
};
export type VodReconciliationSelection = Readonly<{
  state: VodReconciliationState;
  plan: Readonly<{
    timeline_origin_ms: number;
    rebuild_on_seek: boolean;
    hasUpstreamProfile: boolean;
  }>;
  media: Readonly<{
    readyState: number;
    ended: boolean;
    paused: boolean;
    currentTime: number;
    ranges: () => [number, number][];
    pause: () => void;
    seek: (position: number) => void;
    play: () => Promise<void>;
    afterPlay: (revision: number) => boolean;
  }>;
  waitForGenerated: () => Promise<void>;
}>;
type VodSynchronization = Readonly<
  Pick<
    ReturnType<typeof createPlaybackSynchronization<object>>,
    | "ensureBaseRate"
    | "restoreBaseRate"
    | "pendingUserSeek"
    | "pendingForce"
    | "clearPendingApply"
    | "queueApply"
    | "pendingPlay"
    | "playFailed"
    | "claimPlay"
    | "failPlay"
    | "releasePlay"
  >
>;

/** One automatic VOD invocation. Opaque dispatcher inputs may only be retained
 * by passive capture; the policy receives finite live views and fixed effects.
 * Neither selection nor media is a reusable per-grant actuation capability. */
export function createVodReconciliation<
  RoomInput,
  ElementInput,
  PlanInput,
>(ctx: {
  capture: (
    room: RoomInput,
    element: ElementInput,
    plan: PlanInput,
    serial: number,
  ) => VodReconciliationSelection;
  synchronization: VodSynchronization;
  blocked: Pick<Ref<boolean>, "value">;
  clockUsable: () => boolean;
  clockRevision: () => number;
  now: () => number;
  queueApply: (force: boolean, userSeek: boolean) => void;
  completed: () => void;
  prepare: () => Promise<void> | undefined;
  fallback: () => Promise<void>;
  generated: Readonly<{
    pending: boolean;
    failed: boolean;
    end: number | undefined;
    recovering: boolean;
    resetSeek: () => void;
    rejectHole: () => void;
    clearRecovery: () => void;
  }>;
  notice: Readonly<{
    unavailable: () => void;
    clearUnavailable: () => void;
    clearInterruption: () => void;
  }>;
  observe: () => void;
  playFailureIs: (
    failure: unknown,
    name: "NotAllowedError" | "AbortError",
  ) => boolean;
  interrupt: () => void;
}) {
  return async function reconcileVod(
    sInput: RoomInput,
    elInput: ElementInput,
    pInput: PlanInput,
    serial: number,
    force: boolean,
    userSeek: boolean,
  ) {
    const selected = ctx.capture(sInput, elInput, pInput, serial);
    const s = selected.state,
      el = selected.media,
      p = selected.plan;
    if (s.playback_status !== "playing") {
      el.pause();
      if (ctx.synchronization.restoreBaseRate() === undefined) return;
    }
    if (!ctx.clockUsable()) {
      if (ctx.synchronization.restoreBaseRate() === undefined) return;
      ctx.queueApply(force, userSeek);
      return;
    }
    if (el.readyState < 1) return;
    userSeek ||= ctx.synchronization.pendingUserSeek;
    force ||= ctx.synchronization.pendingForce;
    ctx.synchronization.clearPendingApply();
    if (el.ended && s.playback_status === "playing" && !userSeek) {
      void ctx.completed();
      return;
    }
    if (!ctx.synchronization.ensureBaseRate()) return;
    const revision = ctx.clockRevision();
    if (userSeek) {
      ctx.generated.resetSeek();
    }
    if (ctx.generated.pending || ctx.generated.failed) return;
    const relative = (target(s, ctx.now()) - p.timeline_origin_ms) / 1000;
    const expected = Math.min(
      ctx.generated.end ?? Infinity,
      Math.max(0, relative),
    );
    const ranges = el.ranges();
    const seekable = containsPlaybackPosition(ranges, expected);
    const end = ranges.length
      ? Math.max(...ranges.map(([, end]) => end))
      : undefined;
    if (
      force &&
      p.rebuild_on_seek &&
      (relative < -0.5 || (userSeek && !seekable))
    ) {
      // A fresh authoritative target before this upstream timeline is a new
      // seek intent, not a decoder retry of the previous profile or SID.
      const profileTimelineSeek = relative < -0.5 && p.hasUpstreamProfile;
      if (userSeek || profileTimelineSeek) await ctx.prepare();
      else await ctx.fallback();
      return;
    }
    if (ctx.generated.recovering && !seekable) {
      if (end !== undefined && expected <= end) {
        ctx.generated.rejectHole();
      }
      return;
    }
    if (
      p.rebuild_on_seek &&
      !userSeek &&
      !ctx.generated.recovering &&
      ctx.generated.end === undefined &&
      !seekable &&
      (end === undefined || expected > end + 0.1)
    ) {
      await selected.waitForGenerated();
      return;
    }
    // Neither a finite duration nor a later interval authorizes a seek into a
    // hole. Generated holes stay on the finite recovery/reload path.
    if (!seekable && Math.abs(el.currentTime - expected) > 0.15) {
      if (ctx.synchronization.restoreBaseRate() === undefined) return;
      ctx.notice.unavailable();
      // Initial playback may need play() to expose any local intervals. Keep
      // the metadata seek pending, and never assign an unavailable position.
      if (!ranges.length && force && !userSeek)
        ctx.synchronization.queueApply(true);
      if (userSeek || ranges.length) return;
    }
    if (ctx.generated.recovering) ctx.generated.clearRecovery();
    if (seekable) ctx.notice.clearUnavailable();
    if (force || s.playback_status !== "playing") {
      if (seekable && Math.abs(el.currentTime - expected) > 0.15)
        el.seek(expected);
    }
    if (s.playback_status === "playing") {
      if (
        el.paused &&
        !ctx.blocked.value &&
        !ctx.synchronization.pendingPlay &&
        !ctx.synchronization.playFailed
      ) {
        const playing = ctx.synchronization.claimPlay();
        try {
          await el.play();
          if (!el.afterPlay(revision)) return;
          ctx.blocked.value = false;
          ctx.notice.clearInterruption();
          ctx.observe();
        } catch (failure) {
          if (!el.afterPlay(revision)) return;
          if (ctx.playFailureIs(failure, "NotAllowedError")) {
            ctx.blocked.value = true;
            ctx.observe();
          } else {
            // Stop periodic play retries without claiming a gesture denial or
            // suspending the independent media-data deadline.
            ctx.synchronization.failPlay();
            if (ctx.playFailureIs(failure, "AbortError")) {
              ctx.interrupt();
              return;
            }
            throw failure;
          }
        } finally {
          ctx.synchronization.releasePlay(playing);
        }
      }
    }
  };
}
