import { describe, expect, it } from "vitest";
import { Clock } from "../packages/sync-engine";

const reply = (t1: number, clock_epoch = "epoch") => ({
  t1,
  t2: 110,
  t3: 111,
  clock_epoch,
});

describe("correlated clock recovery", () => {
  it("only accepts a current, registered, single-use reply", () => {
    const clock = new Clock();
    expect(clock.acceptReply(reply(0), "epoch", 11)).toBe(false);
    const t1 = clock.registerRequest("epoch", 0)!;
    expect(clock.acceptReply(reply(t1), "epoch", 11)).toBe(true);
    expect(clock.ready).toBe(true);
    expect(clock.offset).toBe(105);
    expect(clock.acceptReply(reply(t1), "epoch", 12)).toBe(false);
  });
  it("fences prior rounds and requires both request and reply epoch", () => {
    const clock = new Clock();
    const previous = clock.registerRequest("epoch", 0)!;
    const revision = clock.revision;
    clock.reset();
    expect(clock.revision).toBe(revision + 1);
    expect(clock.acceptReply(reply(previous), "epoch", 11)).toBe(false);
    expect(clock.ready).toBe(false);
    const wrongReply = clock.registerRequest("epoch", 20)!;
    expect(clock.acceptReply(reply(wrongReply, "old"), "epoch", 31)).toBe(
      false,
    );
    const wrongState = clock.registerRequest("old", 40)!;
    expect(clock.acceptReply(reply(wrongState), "epoch", 51)).toBe(false);
    const current = clock.registerRequest("epoch", 60)!;
    expect(clock.acceptReply(reply(current), "epoch", 71)).toBe(true);
  });
  it("bounds the pending table and rejects expired or invalid exchanges", () => {
    const clock = new Clock();
    const requests = Array.from({ length: 25 }, (_, n) =>
      clock.registerRequest("epoch", n)!,
    );
    expect(clock.acceptReply(reply(requests[0]), "epoch", 50)).toBe(false);
    expect(clock.acceptReply(reply(requests[1]), "epoch", 50)).toBe(true);
    clock.reset();
    const expired = clock.registerRequest("epoch", 100)!;
    expect(clock.acceptReply(reply(expired), "epoch", 5101)).toBe(false);
    const invalid = clock.registerRequest("epoch", 5200)!;
    expect(
      clock.acceptReply({ ...reply(invalid), t3: 109 }, "epoch", 5210),
    ).toBe(false);
    expect(clock.ready).toBe(false);
    expect(clock.registerRequest("epoch", NaN)).toBeUndefined();
    expect(clock.registerRequest("", 5250)).toBeUndefined();
  });
  it("keeps correlation unique across coarsened clocks and a backwards-clock reset", () => {
    const clock = new Clock();
    const old = clock.registerRequest("epoch", 1000)!;
    clock.reset();
    const current = clock.registerRequest("epoch", 10)!;
    expect(current).not.toBe(old);
    expect(clock.acceptReply(reply(old), "epoch", 20)).toBe(false);
    expect(clock.acceptReply(reply(current), "epoch", 21)).toBe(true);
    expect(clock.offset).toBe(95);
    const sameTime = clock.registerRequest("epoch", 10)!;
    expect(sameTime).not.toBe(current);
    expect(clock.acceptReply(reply(sameTime), "epoch", 21)).toBe(true);
    expect(clock.offset).toBe(95);
  });
});
