import { expect, it, vi } from "vitest";
import {
  availablePlaybackRanges,
  containsPlaybackPosition,
  PlaybackRateSupport,
  VideoAdapter,
} from "../packages/player-core";

function intervals(values: [number, number][]) {
  return {
    length: values.length,
    start: (i: number) => values[i][0],
    end: (i: number) => values[i][1],
  };
}
function rateElement(
  accept: (rate: number) => number = (rate) => rate,
  initial = 1,
) {
  let actual = initial;
  const setter = vi.fn((rate: number) => {
    actual = accept(rate);
  });
  const element = Object.defineProperty({}, "playbackRate", {
    get: () => actual,
    set: setter,
  }) as HTMLVideoElement;
  return {
    element,
    setter,
    change: (rate: number) => {
      actual = rate;
    },
  };
}

it("requires interval membership, including boundaries and later intervals", () => {
  const ranges = availablePlaybackRanges({
    seekable: intervals([
      [3, 10],
      [20, 30],
    ]),
    buffered: intervals([[0, 40]]),
  });
  for (const position of [3, 10, 20, 25, 30])
    expect(containsPlaybackPosition(ranges, position)).toBe(true);
  for (const position of [-1, 0, 15, 31, NaN])
    expect(containsPlaybackPosition(ranges, position)).toBe(false);
});

it("uses actual decoded buffers when seekable is not exposed and rejects absent ranges", () => {
  expect(
    availablePlaybackRanges({
      seekable: intervals([]),
      buffered: intervals([
        [0, 4],
        [8, 12],
      ]),
    }),
  ).toEqual([
    [0, 4],
    [8, 12],
  ]);
  expect(
    availablePlaybackRanges({
      seekable: intervals([]),
      buffered: intervals([]),
    }),
  ).toEqual([]);
});

it("preserves the room base and needs three stable readbacks for fine rate evidence", () => {
  const s = rateElement();
  const rates = new PlaybackRateSupport(s.element);
  expect(rates.ensureBase(1.5)).toBe(true);
  expect(rates.applyCorrection(100)).toBe(true);
  expect(s.element.playbackRate).toBeCloseTo(1.575);
  expect(rates.fineSupported).toBe(false);
  rates.applyCorrection(1.52);
  expect(rates.fineSupported).toBe(false);
  rates.applyCorrection(1.53);
  expect(rates.fineSupported).toBe(true);
  expect(s.setter).toHaveBeenCalledTimes(2);
  expect(rates.restoreBase()).toBe(true);
  expect(s.element.playbackRate).toBe(1.5);
});

it.each(["throws", "ignored", "clamped"])(
  "latches a %s fine rate and restores an accepted base without retry writes",
  (behavior) => {
    const s = rateElement((rate) => {
      if (rate === 1) return rate;
      if (behavior === "throws") throw new Error("unsupported");
      return behavior === "ignored" ? 1 : 1.02;
    });
    const rates = new PlaybackRateSupport(s.element);
    expect(rates.ensureBase(1)).toBe(true);
    expect(rates.applyCorrection(1.05)).toBe(false);
    expect(rates.baseSupported).toBe(true);
    expect(rates.fineUnsupported).toBe(true);
    const calls = s.setter.mock.calls.length;
    for (let i = 0; i < 10; i++) {
      expect(rates.ensureBase(1)).toBe(true);
      expect(rates.applyCorrection(0.95)).toBe(false);
    }
    expect(s.setter).toHaveBeenCalledTimes(calls);
    expect(s.element.playbackRate).toBe(1);
  },
);

it.each(["throws", "ignored", "clamped"])(
  "latches a %s base rate until base changes or an explicit reset",
  (behavior) => {
    const s = rateElement((rate) => {
      if (rate === 1) return rate;
      if (behavior === "throws") throw new Error("unsupported");
      return behavior === "ignored" ? 1 : 1.25;
    });
    const rates = new PlaybackRateSupport(s.element);
    expect(rates.ensureBase(1.5)).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(rates.ensureBase(1.5)).toBe(false);
      expect(rates.restoreBase()).toBe(false);
      expect(rates.applyCorrection(1.55)).toBe(false);
    }
    expect(s.setter).toHaveBeenCalledTimes(1);
    expect(rates.ensureBase(1)).toBe(true);
    expect(rates.ensureBase(1.5)).toBe(false);
    rates.reset();
    expect(rates.ensureBase(1.5)).toBe(false);
    expect(s.setter).toHaveBeenCalledTimes(behavior === "clamped" ? 4 : 3);
  },
);

it("rejects delayed fine readback changes and invalid room rates without setter loops", () => {
  const s = rateElement();
  const rates = new PlaybackRateSupport(s.element);
  rates.ensureBase(1);
  rates.applyCorrection(1.05);
  s.change(1);
  expect(rates.applyCorrection(1.05)).toBe(false);
  expect(rates.fineUnsupported).toBe(true);
  const count = s.setter.mock.calls.length;
  for (const rate of [NaN, Infinity, -1, 0, 0.1, 2.5]) {
    expect(rates.ensureBase(rate)).toBe(false);
    expect(rates.ensureBase(rate)).toBe(false);
  }
  expect(s.setter).toHaveBeenCalledTimes(count);
});

it("the adapter shares bounded rate and interval validation", () => {
  const s = rateElement((rate) => (rate === 1.5 ? 1 : rate));
  Object.assign(s.element, {
    currentTime: 0,
    duration: 60,
    seekable: intervals([
      [0, 10],
      [20, 30],
    ]),
    buffered: intervals([]),
  });
  const adapter = new VideoAdapter(s.element);
  expect(() => adapter.seek(15)).toThrow("尚不可定位");
  expect(s.element.currentTime).toBe(0);
  adapter.seek(20);
  expect(s.element.currentTime).toBe(20);
  expect(() => adapter.setRate(1.5)).toThrow("不支持此速率");
  expect(() => adapter.setRate(1.5)).toThrow("不支持此速率");
  expect(s.setter).toHaveBeenCalledTimes(1);
  expect(() => adapter.setRate(1)).not.toThrow();
});

it("detects a delayed base clamp on later readback and latches without another write", () => {
  const s = rateElement();
  const rates = new PlaybackRateSupport(s.element);
  expect(rates.ensureBase(1.5)).toBe(true);
  s.change(1);
  expect(rates.ensureBase(1.5)).toBe(false);
  for (let i = 0; i < 10; i++) {
    expect(rates.ensureBase(1.5)).toBe(false);
    expect(rates.applyCorrection(1.575)).toBe(false);
  }
  expect(s.setter).toHaveBeenCalledTimes(1);
  expect(rates.ensureBase(1)).toBe(true);
});

it("rejects a delayed clamp after fine-rate evidence and rechecks the restored base", () => {
  const s = rateElement();
  const rates = new PlaybackRateSupport(s.element);
  rates.ensureBase(1.5);
  for (let i = 0; i < 3; i++) rates.applyCorrection(1.575);
  expect(rates.fineSupported).toBe(true);
  s.change(1.5);
  expect(rates.ensureBase(1.5)).toBe(true);
  expect(rates.fineUnsupported).toBe(true);
  expect(s.setter).toHaveBeenCalledTimes(2);
  s.change(1);
  expect(rates.ensureBase(1.5)).toBe(false);
  expect(rates.baseSupported).toBe(false);
  expect(s.setter).toHaveBeenCalledTimes(2);
});
