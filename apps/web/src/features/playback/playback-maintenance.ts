import type { PlaybackPlan } from "../../../../../packages/protocol";
import { RequestFailure } from "../../errors";
import { bestEffort } from "./playback-runtime-utils";

/** Timers and document listeners belong to one runtime, including late renewals. */
export function createPlaybackMaintenance(ctx: {
  tick: () => void;
  observe: () => void;
  sample: () => void;
  visibilityChanged: () => void;
  plan: () => PlaybackPlan | undefined;
  active: () => boolean;
  currentPlan: (plan: PlaybackPlan) => boolean;
  epoch: () => number;
  renew: (plan: PlaybackPlan) => Promise<unknown>;
  reload: () => void;
  expired: () => void;
}) {
  let disposed = false;
  // Only an explicit legacy receipt establishes this non-renewable boundary.
  // An ordinary 200 never means a fabricated extra 30 minutes.
  let legacyExpiry: { plan: PlaybackPlan; deadline: number } | undefined;
  let renewing: PlaybackPlan | undefined;
  const renew = () => {
    if (disposed) return;
    const plan = ctx.plan();
    if (!plan || plan.native_platform || !ctx.active() || renewing === plan)
      return;
    const epoch = ctx.epoch();
    renewing = plan;
    const current = () =>
      !disposed && ctx.currentPlan(plan) && ctx.epoch() === epoch;
    void ctx
      .renew(plan)
      .then((receipt: unknown) => {
        if (!current()) return;
        if (
          receipt &&
          typeof receipt === "object" &&
          "legacy_expiry_unchanged" in receipt &&
          receipt.legacy_expiry_unchanged === true &&
          "expires_in_seconds" in receipt &&
          typeof receipt.expires_in_seconds === "number" &&
          Number.isInteger(receipt.expires_in_seconds) &&
          receipt.expires_in_seconds >= 0 &&
          receipt.expires_in_seconds <= 1800
        ) {
          const deadline =
            performance.now() + receipt.expires_in_seconds * 1000;
          legacyExpiry = {
            plan,
            deadline:
              legacyExpiry?.plan === plan
                ? Math.min(legacyExpiry.deadline, deadline)
                : deadline,
          };
        }
      })
      .catch((failure) => {
        if (!current() || !(failure instanceof RequestFailure)) return;
        if (
          failure.code === "INVALID_PLAYBACK_SESSION" &&
          legacyExpiry?.plan === plan &&
          performance.now() >= legacyExpiry.deadline
        ) {
          // Server rejection after its truthful fixed expiry permits one new
          // intent. A 200 with zero remaining waits for normal cadence.
          legacyExpiry = undefined;
          ctx.reload();
        } else if (
          ["INVALID_PLAYBACK_SESSION", "SESSION_EXPIRED"].includes(failure.code)
        ) {
          ctx.expired();
        }
      })
      .finally(() => {
        if (renewing === plan) renewing = undefined;
      });
  };
  const visibilityChanged = () => {
    if (!disposed) ctx.visibilityChanged();
  };
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", visibilityChanged);
  const timers = [
    setInterval(() => {
      if (!disposed) ctx.tick();
    }, 500),
    setInterval(() => {
      if (!disposed) bestEffort(ctx.observe);
    }, 5000),
    setInterval(() => {
      if (!disposed) ctx.sample();
    }, 5000),
    setInterval(renew, 600000),
  ];
  return {
    stop() {
      disposed = true;
      for (const timer of timers) clearInterval(timer);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}
