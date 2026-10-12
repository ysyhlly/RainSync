import { expect, it, vi } from "vitest";
import { PlaybackRateSupport } from "../packages/player-core";
import {
  createPlaybackMediaIO,
  type VodMediaPort,
} from "../apps/web/src/features/playback/drivers/media-io";

it("creates passive views of the exact element and preserves rate I/O order", () => {
  const effects: string[] = [];
  let rate = 1,
    position = 10;
  const element = {
    get playbackRate() {
      expect(this).toBe(element);
      effects.push("rate read");
      return rate;
    },
    set playbackRate(value: number) {
      expect(this).toBe(element);
      effects.push(`rate write ${value}`);
      rate = value;
    },
    get currentTime() {
      expect(this).toBe(element);
      effects.push("position read");
      return position;
    },
    set currentTime(value: number) {
      expect(this).toBe(element);
      effects.push(`seek ${value}`);
      position = value;
    },
  } as HTMLVideoElement;
  const io = createPlaybackMediaIO(element);
  const rates = new PlaybackRateSupport(io.rate);
  expect(effects).toEqual([]);
  expect(io.facts).toBe(element);
  expect(io.rate).toBe(element);
  expect(rates.ensureBase(1.5)).toBe(true);
  expect(effects).toEqual(["rate read", "rate write 1.5", "rate read"]);
  io.seek(12);
  expect(io.facts.currentTime).toBe(12);
  position = 20;
  expect(io.facts.currentTime).toBe(20);
  expect(effects.slice(3)).toEqual([
    "seek 12",
    "position read",
    "position read",
  ]);
});

it("forwards real media exceptions without adding validation or another effect", () => {
  const failure = new Error("media setter failed");
  const seek = vi.fn((_value: number) => {
    throw failure;
  });
  const rate = vi.fn((_value: number) => {
    throw failure;
  });
  const element = {
    get currentTime(): number {
      throw failure;
    },
    set currentTime(value: number) {
      seek(value);
    },
    get playbackRate() {
      return 1;
    },
    set playbackRate(value: number) {
      rate(value);
    },
  } as HTMLVideoElement;
  const io = createPlaybackMediaIO(element);
  expect(() => io.seek(12)).toThrow(failure);
  expect(seek).toHaveBeenCalledExactlyOnceWith(12);
  expect(() => io.facts.currentTime).toThrow(failure);
  expect(new PlaybackRateSupport(io.rate).ensureBase(1.5)).toBe(false);
  expect(rate).toHaveBeenCalledExactlyOnceWith(1.5);
});

it("a held physical view keeps its original element without looking up a later one", () => {
  const first = { currentTime: 1, playbackRate: 1 } as HTMLVideoElement;
  const second = { currentTime: 2, playbackRate: 2 } as HTMLVideoElement;
  const firstView = createPlaybackMediaIO(first);
  const secondView = createPlaybackMediaIO(second);
  firstView.seek(12);
  expect(first.currentTime).toBe(12);
  expect(second.currentTime).toBe(2);
  secondView.seek(24);
  expect(firstView.facts).toBe(first);
  expect(secondView.facts).toBe(second);
  expect(first.currentTime).toBe(12);
  expect(second.currentTime).toBe(24);
});

function finiteMediaPorts(
  io: ReturnType<typeof createPlaybackMediaIO>,
  vod: VodMediaPort,
) {
  // @ts-expect-error Readonly facts cannot replace the permanent element.
  io.facts = {};
  // @ts-expect-error Position mutation is an explicit owner-selected seek.
  vod.facts.currentTime = 12;
  // @ts-expect-error Rate writes stay private to the shared readback tracker.
  vod.facts.playbackRate = 2;
  // @ts-expect-error Periodic VOD does not receive the private rate I/O view.
  vod.rate;
  // @ts-expect-error Playback promises remain with the runtime policy.
  vod.facts.play();
  // @ts-expect-error This view carries no source-attachment operation.
  vod.facts.src = "/replacement";
  // @ts-expect-error Rate I/O cannot seek or control a grant.
  io.rate.currentTime = 20;
  // @ts-expect-error The driver has no API or session authority.
  io.prepare();
  // @ts-expect-error Local audio preferences use their separate permanent owner.
  vod.facts.volume = 0.5;
  vod.seek(10);
  io.rate.playbackRate = 1.5;
}
void finiteMediaPorts;
