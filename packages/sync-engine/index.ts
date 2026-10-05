export interface PlaybackState {
  live?: { version: number; broadcast_id: string; sync_mode: string };
  anchor_position_ms: number;
  anchor_server_time_ms: number;
  playback_rate: number;
  playback_status: string;
  duration_ms: number | null;
}
export class Clock {
  private samples: { rtt: number; offset: number }[] = [];
  private pending = new Map<number, { epoch: string; sent: number }>();
  private lastRequest = -Infinity;
  revision = 0;
  offset = 0;
  get ready() {
    return this.samples.length > 0;
  }
  reset() {
    this.samples = [];
    this.pending.clear();
    this.offset = 0;
    ++this.revision;
  }
  registerRequest(epoch: string, sent: number) {
    if (!epoch || !Number.isFinite(sent) || sent < 0) return undefined;
    // The server echoes t1 unchanged. Keep that key unique even with coarsened
    // or backwards client clocks; offset/RTT use the recorded real send time.
    const t1 = Math.max(sent, this.lastRequest + 1);
    this.lastRequest = t1;
    for (const [key, request] of this.pending) {
      if (sent - request.sent > 5000) this.pending.delete(key);
    }
    if (this.pending.size >= 24)
      this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(t1, { epoch, sent });
    return t1;
  }
  acceptReply(
    reply: { t1: number; t2: number; t3: number; clock_epoch: string },
    currentEpoch: string,
    t4: number,
  ) {
    const request = this.pending.get(reply.t1);
    if (!request) return false;
    // Consume even an invalid reply, so neither duplicates nor a later corrected
    // payload can establish calibration using the same request.
    this.pending.delete(reply.t1);
    if (
      request.epoch !== currentEpoch ||
      reply.clock_epoch !== currentEpoch ||
      !Number.isFinite(t4) ||
      t4 < request.sent ||
      t4 - request.sent > 5000
    )
      return false;
    return this.sample(request.sent, reply.t2, reply.t3, t4);
  }
  sample(t1: number, t2: number, t3: number, t4: number) {
    const rtt = t4 - t1 - (t3 - t2);
    if (
      ![t1, t2, t3, t4].every(Number.isFinite) ||
      !Number.isFinite(rtt) ||
      t4 < t1 ||
      t3 < t2 ||
      rtt < 0
    )
      return false;
    this.samples.push({ rtt, offset: (t2 - t1 + (t3 - t4)) / 2 });
    this.samples = this.samples.slice(-24);
    const best = [...this.samples]
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, 3)
      .map((v) => v.offset)
      .sort((a, b) => a - b);
    this.offset = best[Math.floor(best.length / 2)];
    return true;
  }
  now() {
    return performance.now() + this.offset;
  }
}
export function target(s: PlaybackState, now: number) {
  if (s.live) return 0;
  return Math.min(
    s.duration_ms ?? 7 * 24 * 60 * 60 * 1000,
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
