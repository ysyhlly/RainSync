import type { Ref } from "vue";
import type { createPlaybackSynchronization } from "./playback-synchronization";

/** Periodic live convergence uses the already selected room/plan identities.
 * Decoder-edge selection, play promises and terminal/window effects stay with
 * their existing owners behind the finite callbacks. */
export function createLiveTickPolicy<
  Room extends Readonly<{ playback_status: string }>,
  Plan extends object,
>(ctx: {
  synchronization: Readonly<
    Pick<
      ReturnType<typeof createPlaybackSynchronization<object>>,
      "resetCorrection"
    >
  >;
  position: Pick<Ref<number>, "value">;
  duration: Pick<Ref<number>, "value">;
  readonly terminalEnd: boolean;
  readonly needsEdge: boolean;
  matches: (room: Room, plan: Plan) => boolean;
  fail: (plan: Plan, code?: "NATIVE_LIVE_STATE_CHANGED") => void;
  apply: () => void;
}) {
  return (
    s: Room,
    el: Readonly<Pick<HTMLVideoElement, "ended" | "paused">>,
    p: Plan,
  ) => {
    ctx.position.value = ctx.duration.value = 0;
    ctx.synchronization.resetCorrection();
    if (!ctx.matches(s, p)) {
      ctx.fail(p, "NATIVE_LIVE_STATE_CHANGED");
      return;
    }
    if (el.ended) {
      if (!ctx.terminalEnd) ctx.fail(p);
      return;
    }
    if (
      !ctx.terminalEnd &&
      (s.playback_status !== "playing" || el.paused || ctx.needsEdge)
    )
      void ctx.apply();
    return;
  };
}
