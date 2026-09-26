export interface PlaybackState {
  anchor_position_ms: number;
  anchor_server_time_ms: number;
  playback_rate: number;
  playback_status: string;
  duration_ms: number | null;
}
export class Clock {
  private samples: { rtt: number; offset: number }[] = [];
  offset = 0;
  reset() {
    this.samples = [];
    this.offset = 0;
  }
  sample(t1: number, t2: number, t3: number, t4: number) {
    const rtt = t4 - t1 - (t3 - t2);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.samples.push({ rtt, offset: (t2 - t1 + (t3 - t4)) / 2 });
    this.samples = this.samples.slice(-24);
    const best = [...this.samples]
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, 3)
      .map((v) => v.offset)
      .sort((a, b) => a - b);
    this.offset = best[Math.floor(best.length / 2)];
  }
  now() {
    return performance.now() + this.offset;
  }
}
export function target(s: PlaybackState, now: number) {
  return Math.min(
    s.duration_ms ?? Infinity,
    Math.max(
      0,
      s.anchor_position_ms +
        (s.playback_status === "playing"
          ? Math.max(0, now - s.anchor_server_time_ms) * s.playback_rate
          : 0),
    ),
  );
}
export class Corrector {
  private since: number | null = null;
  private lastSeek = -Infinity;
  reset() {
    this.since = null;
    this.lastSeek = -Infinity;
  }
  step(
    errorMs: number,
    rate: number,
    now: number,
    blocked = false,
  ): { rate: number; seek: boolean } {
    if (blocked || Math.abs(errorMs) <= 150) {
      this.since = null;
      return { rate, seek: false };
    }
    this.since ??= now;
    if (
      (Math.abs(errorMs) > 2000 || now - this.since >= 15000) &&
      now - this.lastSeek >= 5000
    ) {
      this.lastSeek = now;
      this.since = null;
      return { rate, seek: true };
    }
    return {
      rate: rate * (1 + Math.max(-0.05, Math.min(0.05, errorMs / 10000))),
      seek: false,
    };
  }
}
export function reconnectDelay(attempt: number, random = Math.random()) {
  return Math.min(10000, 500 * 2 ** attempt) * (0.8 + 0.4 * random);
}
