export {
  detectCapabilities,
  detectCapabilitiesAsync,
  detectCandidateReport,
} from "./capabilities";
export {
  PlaybackPlanGenerations,
  matchesPlanGeneration,
} from "./plan-generation";

export interface PlayerAdapter {
  play(): Promise<void>;
  pause(): void;
  seek(positionSeconds: number): void;
  setRate(rate: number): void;
  getPosition(): number;
  getBufferedRanges(): [number, number][];
}
export class VideoAdapter implements PlayerAdapter {
  constructor(readonly video: HTMLVideoElement) {}
  play() {
    return this.video.play();
  }
  pause() {
    this.video.pause();
  }
  seek(seconds: number) {
    this.video.currentTime = Math.max(0, seconds);
  }
  setRate(rate: number) {
    this.video.playbackRate = rate;
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
