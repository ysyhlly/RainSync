import { describe, it, expect } from "vitest";
import {
  Clock,
  Corrector,
  target,
  reconnectDelay,
} from "../packages/sync-engine";
describe("clock and playback convergence", () => {
  it("estimates offset and rejects a high latency outlier", () => {
    const c = new Clock();
    c.sample(0, 105, 106, 11);
    expect(c.offset).toBe(100);
    c.sample(20, 125, 126, 31);
    c.sample(40, 145, 146, 51);
    c.sample(60, 1000, 1001, 1000);
    expect(c.offset).toBe(100);
  });
  it("honors pause, rate and duration", () => {
    const s = {
      anchor_position_ms: 1000,
      anchor_server_time_ms: 100,
      playback_rate: 2,
      playback_status: "playing",
      duration_ms: 2000,
    };
    expect(target(s, 300)).toBe(1400);
    expect(target(s, 10000)).toBe(2000);
    expect(target({ ...s, playback_status: "paused" }, 10000)).toBe(1000);
  });
  it("suppresses seek storms and buffering corrections", () => {
    const c = new Corrector();
    expect(c.step(3000, 1, 0).seek).toBe(true);
    expect(c.step(3000, 1, 1000).seek).toBe(false);
    expect(c.step(3000, 1, 6000, true).seek).toBe(false);
    expect(c.step(100, 1, 7000)).toEqual({ rate: 1, seek: false });
  });
  it("escalates an uncorrected drift after 15 seconds", () => {
    const c = new Corrector();
    expect(c.step(500, 1, 0).rate).toBe(1.05);
    expect(c.step(500, 1, 15000).seek).toBe(true);
  });
  it("bounds retry delay", () => {
    expect(reconnectDelay(0, 0.5)).toBe(500);
    expect(reconnectDelay(10, 0.5)).toBe(10000);
  });
});
