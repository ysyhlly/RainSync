import { PlaybackRateSupport } from "../../../../../packages/player-core";
import { Corrector } from "../../../../../packages/sync-engine";

export type PlaybackRateFacts = Readonly<
  Pick<PlaybackRateSupport, "baseSupported" | "fineUnsupported">
>;
type SynchronizationElement = Pick<HTMLVideoElement, "pause" | "playbackRate">;

/** One synchronous action/rate owner for VOD, live and explicit gestures.
 * The caller retains play promises, seek policy, grants and loading deadlines. */
export function createPlaybackSynchronization<Plan extends object>(ctx: {
  element: () => SynchronizationElement | undefined;
  currentPlan: (plan: Plan) => boolean;
  active: () => boolean;
  status: () => string | undefined;
  rate: () => number | undefined;
  captureRateScope: () => () => boolean;
  clockUsable: () => boolean;
  clockRevision: () => number;
  rateSupported: () => void;
  rateRejected: () => void;
}) {
  const corrector = new Corrector();
  let rates: PlaybackRateSupport | undefined;
  let rateFacts: PlaybackRateFacts | undefined;
  let confirmedBaseRate: number | undefined,
    rejectedBaseRate: number | undefined;
  let applySerial = 0,
    seekRevision = 0,
    pendingForce = false,
    pendingUserSeek = false;
  let pendingPlay: object | undefined;
  let playFailed = false;

  function rateAttempt() {
    const rate = ctx.rate(),
      tracker = rates;
    if (rate === undefined || !tracker) return undefined;
    const qualify = ctx.captureRateScope();
    return {
      rate,
      operation: tracker.operation(
        () => rates === tracker && Object.is(ctx.rate(), rate) && qualify(),
      ),
    };
  }
  type RateAttempt = NonNullable<ReturnType<typeof rateAttempt>>;
  function rejectRate(rate: number, current: () => boolean) {
    if (!current()) return undefined;
    rejectedBaseRate = rate;
    ctx.rateRejected();
    return current() ? false : undefined;
  }
  function reportUnsupportedRate() {
    const attempt = rateAttempt();
    return attempt
      ? rejectRate(attempt.rate, attempt.operation.capture())
      : false;
  }
  function ensureRate(attempt: RateAttempt) {
    const receipt = attempt.operation.ensureBase(attempt.rate);
    if (receipt.result === undefined || !receipt.current()) return receipt;
    if (!receipt.result) rejectRate(attempt.rate, receipt.current);
    else {
      confirmedBaseRate = attempt.rate;
      rejectedBaseRate = undefined;
      ctx.rateSupported();
    }
    return receipt;
  }
  function ensureBaseRate() {
    const attempt = rateAttempt();
    if (!attempt) return false;
    const receipt = ensureRate(attempt);
    return receipt.current() ? receipt.result : undefined;
  }
  function restoreBaseRate() {
    const attempt = rateAttempt();
    if (!attempt) return false;
    const ensured = ensureRate(attempt);
    // A proof callback cannot lend the old continuation a newer record, even
    // when a reusable operation handle has advanced to that successor.
    if (!ensured.current()) return undefined;
    if (ensured.result !== true) return ensured.result;
    const restored = attempt.operation.restoreBase();
    return restored.result === false
      ? rejectRate(attempt.rate, restored.current)
      : restored.current()
        ? restored.result
        : undefined;
  }
  function clearPendingApply() {
    pendingForce = pendingUserSeek = false;
  }
  function actionCurrent(
    plan: Plan,
    element: SynchronizationElement,
    revision: number,
    serial: number,
  ) {
    // clockUsable may synchronously invalidate this action. Compare afterward.
    return (
      ctx.clockUsable() &&
      revision === ctx.clockRevision() &&
      serial === applySerial &&
      ctx.currentPlan(plan) &&
      ctx.active() &&
      ctx.element() === element
    );
  }
  return {
    get seekRevision() {
      return seekRevision;
    },
    get pendingForce() {
      return pendingForce;
    },
    get pendingUserSeek() {
      return pendingUserSeek;
    },
    get pendingPlay() {
      return !!pendingPlay;
    },
    get playFailed() {
      return playFailed;
    },
    get rateFacts() {
      return rateFacts;
    },
    get confirmedBaseRate() {
      return confirmedBaseRate;
    },
    get rejectedBaseRate() {
      return rejectedBaseRate;
    },
    beginApply(userSeek: boolean) {
      if (userSeek) ++seekRevision;
      pendingUserSeek ||= userSeek;
      return ++applySerial;
    },
    beginGesture() {
      return ++applySerial;
    },
    claimPlay(gesture = false) {
      const playing = {};
      pendingPlay = playing;
      if (gesture) playFailed = false;
      return playing;
    },
    releasePlay(playing: object) {
      if (pendingPlay === playing) pendingPlay = undefined;
    },
    failPlay() {
      playFailed = true;
    },
    invalidatePlayActions() {
      ++applySerial;
      pendingPlay = undefined;
      playFailed = false;
    },
    invalidateClock() {
      // Clock recovery fences results but retains the in-flight play claim.
      ++applySerial;
      corrector.reset();
      restoreBaseRate();
    },
    afterPlay(
      plan: Plan,
      element: SynchronizationElement,
      revision: number,
      serial: number,
    ) {
      // A newer PAUSE still wins on this plan/element while its clock recovers.
      // An old promise must never pause a replacement plan or element.
      if (
        ctx.currentPlan(plan) &&
        ctx.element() === element &&
        ctx.status() !== "playing"
      )
        element.pause();
      return (
        actionCurrent(plan, element, revision, serial) &&
        ctx.status() === "playing"
      );
    },
    queueApply(force = false, userSeek = false) {
      pendingForce ||= force;
      pendingUserSeek ||= userSeek;
    },
    clearPendingApply,
    preparedSeek(revision: number) {
      if (revision === seekRevision) clearPendingApply();
    },
    attachRateElement(element: SynchronizationElement) {
      const tracker = new PlaybackRateSupport(element);
      rates = tracker;
      // A snapshot keeps the tracker selected at its original read point.
      // These getters read that tracker directly; no support state is cached.
      rateFacts = {
        get baseSupported() {
          return tracker.baseSupported;
        },
        get fineUnsupported() {
          return tracker.fineUnsupported;
        },
      };
      confirmedBaseRate = rejectedBaseRate = undefined;
    },
    resetRates() {
      rates?.reset();
      confirmedBaseRate = rejectedBaseRate = undefined;
    },
    resetCorrection() {
      corrector.reset();
    },
    correction(drift: number, rate: number, now: number, paused: boolean) {
      return corrector.step(drift, rate, now, paused);
    },
    applyCorrection(rate: number) {
      const attempt = rateAttempt();
      if (!attempt) return false;
      const receipt = attempt.operation.applyCorrection(rate);
      return receipt.current() ? receipt.result : undefined;
    },
    ensureBaseRate,
    restoreBaseRate,
    reportUnsupportedRate,
  };
}
