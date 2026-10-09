import { expect, it, vi } from "vitest";
import {
  availablePlaybackRanges,
  containsPlaybackPosition,
  PlaybackRateSupport,
  type PlaybackRateReceipt,
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

it("a synchronous tracker reset retains its cleared rate proof", () => {
  let actual = 1;
  let resetOnWrite = true;
  let rates!: PlaybackRateSupport;
  const element = {
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      actual = value;
      if (resetOnWrite) {
        resetOnWrite = false;
        rates.reset();
      }
    },
  };
  rates = new PlaybackRateSupport(element);
  const result = rates.ensureBase(1.5);
  expect(rates.baseSupported).toBe(false);
  expect(result).toBeUndefined();
  expect(element.playbackRate).toBe(1.5);
});

it.each(["before write", "after write"])(
  "a reset during readback %s retires the old attempt without proof or another write",
  (point) => {
    let actual = 1,
      reads = 0;
    let rates!: PlaybackRateSupport;
    const writes = vi.fn((value: number) => {
      actual = value;
    });
    const element = {
      get playbackRate() {
        if (++reads === (point === "before write" ? 1 : 2)) rates.reset();
        return actual;
      },
      set playbackRate(value: number) {
        writes(value);
      },
    };
    rates = new PlaybackRateSupport(element);
    expect(rates.ensureBase(1.5)).toBeUndefined();
    expect(rates.baseSupported).toBe(false);
    expect(writes.mock.calls).toEqual(point === "before write" ? [] : [[1.5]]);
  },
);

it("a reentrant successor base keeps its own proof and cannot be adopted by an old attempt", () => {
  let actual = 1;
  let rates!: PlaybackRateSupport;
  let successor: boolean | undefined;
  const writes: number[] = [];
  const element = {
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      actual = value;
      writes.push(value);
      if (value === 1.5) {
        rates.reset();
        successor = rates.ensureBase(2);
      }
    },
  };
  rates = new PlaybackRateSupport(element);
  const original = rates.operation();
  const receipt = original.ensureBase(1.5);
  expect(receipt.result).toBeUndefined();
  expect(successor).toBe(true);
  expect(receipt.current()).toBe(false);
  expect(original.ensureBase(1.25).result).toBeUndefined();
  expect(original.restoreBase().result).toBeUndefined();
  expect(original.applyCorrection(2.1).result).toBeUndefined();
  expect(rates.baseSupported).toBe(true);
  expect(rates.fineUnsupported).toBe(false);
  expect(element.playbackRate).toBe(2);
  expect(writes).toEqual([1.5, 2]);
});

it.each(["clamp", "throw"])(
  "a retired fine %s cannot run base-restoration writes or poison successor proof",
  (failure) => {
    let actual = 1;
    let rates!: PlaybackRateSupport;
    const writes: number[] = [];
    const element = {
      get playbackRate() {
        return actual;
      },
      set playbackRate(value: number) {
        writes.push(value);
        actual = value;
        if (value === 1.05) {
          actual = 1.02;
          rates.reset();
          expect(rates.ensureBase(1.5)).toBe(true);
          if (failure === "throw") throw new Error("retired setter failed");
        }
      },
    };
    rates = new PlaybackRateSupport(element);
    expect(rates.ensureBase(1)).toBe(true);
    expect(rates.applyCorrection(1.05)).toBeUndefined();
    expect(rates.baseSupported).toBe(true);
    expect(rates.fineUnsupported).toBe(false);
    expect(element.playbackRate).toBe(1.5);
    expect(writes).toEqual([1.05, 1.5]);
  },
);

it("external retirement stays separate from genuine property exceptions", () => {
  let current = true;
  const setter = vi.fn((_value: number) => {
    current = false;
    throw new Error("setter failed after retirement");
  });
  const rates = new PlaybackRateSupport({
    get playbackRate() {
      return 1;
    },
    set playbackRate(value: number) {
      setter(value);
    },
  });
  expect(rates.operation(() => current).ensureBase(1.5).result).toBeUndefined();
  expect(rates.baseSupported).toBe(false);
  expect(setter).toHaveBeenCalledOnce();

  const writeAfterThrownRead = vi.fn();
  const throwing = new PlaybackRateSupport({
    get playbackRate(): number {
      throw new Error("real getter rejection");
    },
    set playbackRate(value: number) {
      writeAfterThrownRead(value);
    },
  });
  expect(throwing.ensureBase(1.5)).toBe(false);
  expect(writeAfterThrownRead).not.toHaveBeenCalled();
});

it("a different-base reentrant adapter call does not become an unsupported-rate exception", () => {
  let actual = 1;
  let adapter!: VideoAdapter;
  const element = {
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      actual = value;
      if (value === 1.5) adapter.setRate(2);
    },
  } as HTMLVideoElement;
  adapter = new VideoAdapter(element);
  expect(() => adapter.setRate(1.5)).not.toThrow();
  expect(element.playbackRate).toBe(2);
  expect(() => adapter.setRate(2)).not.toThrow();
});

it("preserves same-base reentrant reads while the outer setter remains current", () => {
  let actual = 1;
  let reenter = true;
  let rates!: PlaybackRateSupport;
  const nested: unknown[] = [];
  const element = {
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      actual = value;
      if (reenter) {
        reenter = false;
        nested.push(rates.ensureBase(value), rates.restoreBase());
      }
    },
  };
  rates = new PlaybackRateSupport(element);
  expect(rates.ensureBase(1.5)).toBe(true);
  expect(nested).toEqual([false, false]);
  expect(rates.baseSupported).toBe(true);
  expect(element.playbackRate).toBe(1.5);
});

it("an older invocation cannot follow a same-handle successor record", () => {
  let actual = 1;
  let inner: PlaybackRateReceipt | undefined;
  let attempt!: ReturnType<PlaybackRateSupport["operation"]>;
  const writes: number[] = [];
  const rates = new PlaybackRateSupport({
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      writes.push(value);
      actual = value;
      if (value === 1.5) inner = attempt.ensureBase(2);
    },
  });
  attempt = rates.operation();
  const outer = attempt.ensureBase(1.5);
  expect(inner!.result).toBe(true);
  expect(inner!.current()).toBe(true);
  expect(outer.result).toBeUndefined();
  expect(outer.current()).toBe(false);
  expect(rates.baseSupported).toBe(true);
  expect(actual).toBe(2);
  expect(attempt.restoreBase().result).toBe(true);
  expect(writes).toEqual([1.5, 2]);
});

it("a returned receipt stays bound when a later callback advances its handle", () => {
  const s = rateElement();
  const rates = new PlaybackRateSupport(s.element);
  const attempt = rates.operation();
  const original = attempt.ensureBase(1.5);
  const beforeCallback = attempt.capture();
  expect(original.result).toBe(true);
  const callback = () => attempt.ensureBase(2);
  const successor = callback();
  expect(successor.result).toBe(true);
  expect(successor.current()).toBe(true);
  expect(original.current()).toBe(false);
  expect(beforeCallback()).toBe(false);
  expect(rates.baseSupported).toBe(true);
  expect(attempt.restoreBase().result).toBe(true);
  expect(s.setter.mock.calls).toEqual([[1.5], [2]]);
});

it("same-handle same-base nesting preserves the current outer readback", () => {
  let actual = 1,
    reenter = true;
  let attempt!: ReturnType<PlaybackRateSupport["operation"]>;
  const nested: PlaybackRateReceipt[] = [];
  const rates = new PlaybackRateSupport({
    get playbackRate() {
      return actual;
    },
    set playbackRate(value: number) {
      actual = value;
      if (reenter) {
        reenter = false;
        nested.push(attempt.ensureBase(value), attempt.restoreBase());
      }
    },
  });
  attempt = rates.operation();
  const outer = attempt.ensureBase(1.5);
  expect(outer.result).toBe(true);
  expect(outer.current()).toBe(true);
  expect(nested.map((receipt) => receipt.result)).toEqual([false, false]);
  expect(nested.every((receipt) => receipt.current())).toBe(true);
  expect(rates.baseSupported).toBe(true);
  expect(attempt.restoreBase().result).toBe(true);
  expect(actual).toBe(1.5);
});
