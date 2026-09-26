import type { PlaybackCapabilities } from "../protocol";

export function detectCapabilities(
  video: Pick<HTMLVideoElement, "canPlayType">,
  mse?: { isTypeSupported(type: string): boolean },
): PlaybackCapabilities {
  const avc = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';
  return {
    progressive_h264_aac: video.canPlayType(avc) !== "",
    native_hls: video.canPlayType("application/vnd.apple.mpegurl") !== "",
    mse_h264_aac: !!mse?.isTypeSupported(avc),
  };
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
