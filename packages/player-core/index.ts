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

/** Property readback is behavioral evidence, not decoder/hardware capability. */
export class PlaybackRateSupport {
  private base: number | undefined;
  private accepted = false;
  private rejected = false;
  private fine: "unknown" | "checking" | "supported" | "unsupported" =
    "unknown";
  private pendingRate: number | undefined;
  private appliedRate: number | undefined;
  private stableReads = 0;

  constructor(
    private readonly element: Pick<HTMLVideoElement, "playbackRate">,
  ) {}

  get baseSupported() {
    return this.accepted && !this.rejected;
  }
  get fineSupported() {
    return this.fine === "supported";
  }
  get fineUnsupported() {
    return this.fine === "unsupported";
  }
  reset() {
    this.base = undefined;
    this.accepted = this.rejected = false;
    this.fine = "unknown";
    this.pendingRate = undefined;
    this.appliedRate = undefined;
    this.stableReads = 0;
  }
  private matches(rate: number) {
    const observed = this.element.playbackRate;
    return Number.isFinite(observed) && Math.abs(observed - rate) <= 0.0001;
  }
  private writeAndRead(rate: number) {
    try {
      if (!Number.isFinite(rate) || rate <= 0) return false;
      if (!this.matches(rate)) this.element.playbackRate = rate;
      return this.matches(rate);
    } catch {
      return false;
    }
  }
  private verifyAppliedRate() {
    if (!this.baseSupported || this.appliedRate === undefined)
      return this.baseSupported;
    let matches = false;
    try {
      matches = this.matches(this.appliedRate);
    } catch {
      /* A delayed setter/readback failure is still a rejected property rate. */
    }
    if (matches) return true;
    if (this.appliedRate !== this.base) {
      this.rejectFine();
      return this.baseSupported;
    }
    this.accepted = false;
    this.rejected = true;
    return false;
  }
  ensureBase(rate: number) {
    if (Object.is(this.base, rate)) return this.verifyAppliedRate();
    this.reset();
    this.base = rate;
    this.accepted =
      rate >= MIN_ROOM_RATE && rate <= MAX_ROOM_RATE && this.writeAndRead(rate);
    this.rejected = !this.accepted;
    if (this.accepted) this.appliedRate = rate;
    return this.baseSupported;
  }
  restoreBase() {
    if (!this.baseSupported || this.base === undefined) return false;
    this.pendingRate = undefined;
    this.stableReads = 0;
    if (this.fine === "checking") this.fine = "unknown";
    this.accepted = this.writeAndRead(this.base);
    this.rejected = !this.accepted;
    if (this.accepted) this.appliedRate = this.base;
    return this.baseSupported;
  }
  applyCorrection(rate: number) {
    if (!this.verifyAppliedRate() || this.base === undefined) return false;
    if (this.fineUnsupported) return false;
    // Corrections are bounded relative to the user's room rate.
    const bounded = Math.max(
      this.base * 0.95,
      Math.min(this.base * 1.05, rate),
    );
    if (!Number.isFinite(bounded)) return this.rejectFine();
    if (Math.abs(bounded - this.base) <= 0.0001) return this.restoreBase();
    if (this.fine === "checking" && this.pendingRate !== undefined) {
      try {
        if (!this.matches(this.pendingRate)) return this.rejectFine();
      } catch {
        return this.rejectFine();
      }
      if (++this.stableReads >= 3) {
        this.fine = "supported";
        this.pendingRate = undefined;
      }
      return true;
    }
    if (!this.writeAndRead(bounded)) return this.rejectFine();
    this.appliedRate = bounded;
    if (!this.fineSupported) {
      this.fine = "checking";
      this.pendingRate = bounded;
      this.stableReads = 1;
    }
    return true;
  }
  private rejectFine() {
    this.fine = "unsupported";
    this.restoreBase();
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
    if (!this.rates.ensureBase(rate)) throw new RangeError("不支持此速率");
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
