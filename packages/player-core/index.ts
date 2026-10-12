export {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
} from "./capabilities";
export {
  detectUpstreamProfileReport,
  isUpstreamProfileEnvelope,
  matchesUpstreamProfilePlan,
} from "./upstream-profile";
export {
  PlaybackPlanGenerations,
  matchesPlanGeneration,
} from "./plan-generation";
export { hasUsablePlaybackTimeline } from "./timeline";

export type PlaybackRange = [number, number];
const MIN_ROOM_RATE = 0.25;
const MAX_ROOM_RATE = 2;

/** Read actual intervals; a duration or the final end is not a seekable span. */
export function availablePlaybackRanges(
  element: Pick<HTMLVideoElement, "seekable" | "buffered">,
): PlaybackRange[] {
  try {
    const ranges = element.seekable.length
      ? element.seekable
      : element.buffered;
    return Array.from({ length: ranges.length }, (_, i): PlaybackRange => [
      ranges.start(i),
      ranges.end(i),
    ]).filter(
      ([start, end]) =>
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= 0 &&
        end >= start,
    );
  } catch {
    // A media resource can be replaced while its ranges are being read.
    return [];
  }
}

export function containsPlaybackPosition(
  ranges: readonly PlaybackRange[],
  position: number,
) {
  return (
    Number.isFinite(position) &&
    ranges.some(([start, end]) => position >= start && position <= end)
  );
}

type RateProof = {
  base?: number;
  accepted: boolean;
  rejected: boolean;
  fine: "unknown" | "checking" | "supported" | "unsupported";
  pendingRate?: number;
  appliedRate?: number;
  stableReads: number;
};
const emptyRateProof = (): RateProof => ({
  accepted: false,
  rejected: false,
  fine: "unknown",
  stableReads: 0,
});
/** Undefined is retirement, never evidence that the browser rejected a rate. */
export type PlaybackRateResult = boolean | undefined;
export type PlaybackRateReceipt = Readonly<{
  result: PlaybackRateResult;
  current: () => boolean;
}>;

/** Property readback is behavioral evidence, not decoder/hardware capability. */
export class PlaybackRateSupport {
  private proof = emptyRateProof();

  constructor(
    private readonly element: Pick<HTMLVideoElement, "playbackRate">,
  ) {}

  private supported(proof: RateProof) {
    return proof.accepted && !proof.rejected;
  }
  get baseSupported() {
    return this.supported(this.proof);
  }
  get fineSupported() {
    return this.proof.fine === "supported";
  }
  get fineUnsupported() {
    return this.proof.fine === "unsupported";
  }
  reset() {
    // An in-flight getter/setter may reset this same tracker synchronously.
    // Its older stack retains only the detached record, never successor proof.
    this.proof = emptyRateProof();
  }
  private readMatches(rate: number, current: () => boolean) {
    if (!current()) return undefined;
    let matches: boolean | null = null;
    try {
      const observed = this.element.playbackRate;
      matches =
        Number.isFinite(observed) && Math.abs(observed - rate) <= 0.0001;
    } catch {
      // Null represents an actual getter exception, separately from retirement.
    }
    return current() ? matches : undefined;
  }
  private writeAndRead(
    rate: number,
    current: () => boolean,
  ): PlaybackRateResult {
    if (!current()) return undefined;
    if (!Number.isFinite(rate) || rate <= 0) return false;
    const before = this.readMatches(rate, current);
    if (before === undefined) return undefined;
    if (before === null) return false;
    if (!before) {
      let failed = false;
      try {
        this.element.playbackRate = rate;
      } catch {
        failed = true;
      }
      if (!current()) return undefined;
      if (failed) return false;
    }
    const after = this.readMatches(rate, current);
    return after === null ? false : after;
  }
  private verifyAppliedRate(
    proof: RateProof,
    current: () => boolean,
  ): PlaybackRateResult {
    if (!current()) return undefined;
    if (!this.supported(proof) || proof.appliedRate === undefined)
      return this.supported(proof);
    const matches = this.readMatches(proof.appliedRate, current);
    if (matches === undefined) return undefined;
    if (matches) return true;
    if (proof.appliedRate !== proof.base) {
      if (this.rejectFine(proof, current) === undefined) return undefined;
      return this.supported(proof);
    }
    proof.accepted = false;
    proof.rejected = true;
    return false;
  }
  /** Each invocation returns its own immutable continuation qualification. */
  operation(qualify: () => boolean = () => true) {
    let proof = this.proof;
    const bind = (selected: RateProof) => () =>
      this.proof === selected && qualify();
    return {
      capture: () => bind(proof),
      ensureBase: (rate: number): PlaybackRateReceipt => {
        const previous = proof,
          previousCurrent = bind(previous);
        if (!previousCurrent())
          return { result: undefined, current: previousCurrent };
        const changed = !Object.is(previous.base, rate);
        const selected = changed
          ? { ...emptyRateProof(), base: rate }
          : previous;
        // Adopt only this invocation's own new record. A reentrant call may
        // advance the handle, but cannot retarget this captured selected record.
        if (changed) proof = this.proof = selected;
        const current = bind(selected);
        let result: PlaybackRateResult;
        if (!changed) result = this.verifyAppliedRate(selected, current);
        else {
          const accepted =
            rate >= MIN_ROOM_RATE &&
            rate <= MAX_ROOM_RATE &&
            this.writeAndRead(rate, current);
          if (accepted !== undefined) {
            selected.accepted = accepted;
            selected.rejected = !accepted;
            if (accepted) selected.appliedRate = rate;
            result = this.supported(selected);
          }
        }
        return { result, current };
      },
      restoreBase: (): PlaybackRateReceipt => {
        const selected = proof,
          current = bind(selected);
        return { result: this.restoreBaseFor(selected, current), current };
      },
      applyCorrection: (rate: number): PlaybackRateReceipt => {
        const selected = proof,
          current = bind(selected);
        return {
          result: this.applyCorrectionFor(selected, current, rate),
          current,
        };
      },
    };
  }
  ensureBase(rate: number) {
    return this.operation().ensureBase(rate).result;
  }
  restoreBase() {
    return this.operation().restoreBase().result;
  }
  applyCorrection(rate: number) {
    return this.operation().applyCorrection(rate).result;
  }
  private restoreBaseFor(
    proof: RateProof,
    current: () => boolean,
  ): PlaybackRateResult {
    if (!current()) return undefined;
    if (!this.supported(proof) || proof.base === undefined) return false;
    proof.pendingRate = undefined;
    proof.stableReads = 0;
    if (proof.fine === "checking") proof.fine = "unknown";
    const accepted = this.writeAndRead(proof.base, current);
    if (accepted === undefined) return undefined;
    proof.accepted = accepted;
    proof.rejected = !accepted;
    if (accepted) proof.appliedRate = proof.base;
    return this.supported(proof);
  }
  private applyCorrectionFor(
    proof: RateProof,
    current: () => boolean,
    rate: number,
  ): PlaybackRateResult {
    const verified = this.verifyAppliedRate(proof, current);
    if (verified === undefined) return undefined;
    if (!verified || proof.base === undefined) return false;
    if (proof.fine === "unsupported") return false;
    // Corrections are bounded relative to the user's room rate.
    const bounded = Math.max(
      proof.base * 0.95,
      Math.min(proof.base * 1.05, rate),
    );
    if (!Number.isFinite(bounded)) return this.rejectFine(proof, current);
    if (Math.abs(bounded - proof.base) <= 0.0001)
      return this.restoreBaseFor(proof, current);
    if (proof.fine === "checking" && proof.pendingRate !== undefined) {
      const matches = this.readMatches(proof.pendingRate, current);
      if (matches === undefined) return undefined;
      if (!matches) return this.rejectFine(proof, current);
      if (++proof.stableReads >= 3) {
        proof.fine = "supported";
        proof.pendingRate = undefined;
      }
      return true;
    }
    const accepted = this.writeAndRead(bounded, current);
    if (accepted === undefined) return undefined;
    if (!accepted) return this.rejectFine(proof, current);
    proof.appliedRate = bounded;
    if (proof.fine !== "supported") {
      proof.fine = "checking";
      proof.pendingRate = bounded;
      proof.stableReads = 1;
    }
    return true;
  }
  private rejectFine(
    proof: RateProof,
    current: () => boolean,
  ): PlaybackRateResult {
    if (!current()) return undefined;
    proof.fine = "unsupported";
    if (this.restoreBaseFor(proof, current) === undefined) return undefined;
    return false;
  }
}

export interface PlayerAdapter {
  play(): Promise<void>;
  pause(): void;
  seek(positionSeconds: number): void;
  setRate(rate: number): void;
  getPosition(): number;
  getBufferedRanges(): [number, number][];
}
export class VideoAdapter implements PlayerAdapter {
  private readonly rates: PlaybackRateSupport;
  constructor(readonly video: HTMLVideoElement) {
    this.rates = new PlaybackRateSupport(video);
  }
  play() {
    return this.video.play();
  }
  pause() {
    this.video.pause();
  }
  seek(seconds: number) {
    if (!containsPlaybackPosition(availablePlaybackRanges(this.video), seconds))
      throw new RangeError("目标进度尚不可定位");
    this.video.currentTime = seconds;
  }
  setRate(rate: number) {
    if (this.rates.ensureBase(rate) === false)
      throw new RangeError("不支持此速率");
  }
  getPosition() {
    return this.video.currentTime;
  }
  getBufferedRanges(): [number, number][] {
    return Array.from({ length: this.video.buffered.length }, (_, i) => [
      this.video.buffered.start(i),
      this.video.buffered.end(i),
    ]);
  }
}
