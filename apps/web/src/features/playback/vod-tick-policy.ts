import type { Ref } from "vue";
import type { PlaybackPlan } from "../../../../../packages/protocol";
import {
  availablePlaybackRanges,
  containsPlaybackPosition,
} from "../../../../../packages/player-core";
import {
  target,
  type PlaybackState,
} from "../../../../../packages/sync-engine";
import type { createPlaybackSynchronization } from "./playback-synchronization";

type VodTickState = Readonly<Omit<PlaybackState, "live">> & {
  readonly live?: Readonly<NonNullable<PlaybackState["live"]>>;
};
type VodTickPlan = Readonly<
  Pick<PlaybackPlan, "timeline_origin_ms" | "rebuild_on_seek">
>;
type VodTickElement = Pick<HTMLVideoElement, "currentTime"> &
  Readonly<
    Pick<
      HTMLVideoElement,
      "seekable" | "buffered" | "ended" | "paused" | "seeking" | "readyState"
    >
  >;
type VodCorrectionOwner = Readonly<
  Pick<
    ReturnType<typeof createPlaybackSynchronization<object>>,
    | "resetCorrection"
    | "restoreBaseRate"
    | "ensureBaseRate"
    | "rateFacts"
    | "pendingPlay"
    | "playFailed"
    | "pendingForce"
    | "pendingUserSeek"
    | "correction"
    | "applyCorrection"
    | "reportUnsupportedRate"
  >
>;

/** Synchronous VOD correction only. The runtime selects the original room,
 * plan and element before entering; read ports stay live across rate events. */
export function createVodTickPolicy(ctx: {
  synchronization: VodCorrectionOwner;
  position: Pick<Ref<number>, "value">;
  dragging: Readonly<Ref<boolean>>;
  waiting: Readonly<Ref<boolean>>;
  blocked: Readonly<Ref<boolean>>;
  readonly generationPending: boolean;
  readonly generationFailed: boolean;
  readonly recovering: boolean;
  readonly generatedEnd: number | undefined;
  now: () => number;
  apply: (force?: boolean, userSeek?: boolean) => void;
  completed: () => void;
}) {
  return (
    s: VodTickState,
    el: VodTickElement,
    p: VodTickPlan,
    usable: boolean,
  ) => {
    if (!ctx.dragging.value)
      ctx.position.value = el.currentTime + p.timeline_origin_ms / 1000;
    if (!usable || s.playback_status !== "playing") {
      ctx.synchronization.resetCorrection();
      ctx.synchronization.restoreBaseRate();
      return;
    }
    if (!ctx.synchronization.ensureBaseRate()) return;
    if (el.ended) {
      void ctx.completed();
      return;
    }
    if (ctx.generationPending || ctx.generationFailed) return;
    if (ctx.recovering) {
      void ctx.apply(true);
      return;
    }
    const expected = Math.min(
      ctx.generatedEnd ?? Infinity,
      (target(s, ctx.now()) - p.timeline_origin_ms) / 1000,
    );
    const ranges = availablePlaybackRanges(el);
    if (!containsPlaybackPosition(ranges, expected)) {
      ctx.synchronization.restoreBaseRate();
      ctx.synchronization.resetCorrection();
      if (p.rebuild_on_seek) void ctx.apply(true);
      return;
    }
    if (
      !ctx.blocked.value &&
      !ctx.synchronization.pendingPlay &&
      !ctx.synchronization.playFailed &&
      (el.paused ||
        ctx.synchronization.pendingForce ||
        ctx.synchronization.pendingUserSeek)
    ) {
      void ctx.apply(
        ctx.synchronization.pendingForce,
        ctx.synchronization.pendingUserSeek,
      );
      return;
    }
    const drift = (expected - el.currentTime) * 1000;
    const pausedCorrection =
      ctx.waiting.value || el.seeking || ctx.blocked.value || el.readyState < 2;
    const adjustment = ctx.synchronization.correction(
      ctx.synchronization.rateFacts!.fineUnsupported && Math.abs(drift) <= 500
        ? 0
        : drift,
      s.playback_rate,
      performance.now(),
      pausedCorrection,
    );
    if (pausedCorrection || adjustment.seek)
      ctx.synchronization.restoreBaseRate();
    else if (!ctx.synchronization.rateFacts!.fineUnsupported)
      ctx.synchronization.applyCorrection(adjustment.rate);
    if (!ctx.synchronization.rateFacts!.baseSupported) {
      ctx.synchronization.reportUnsupportedRate();
      ctx.synchronization.resetCorrection();
      return;
    }
    if (adjustment.seek) el.currentTime = expected;
  };
}
