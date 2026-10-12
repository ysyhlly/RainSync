import { expect, it, vi } from "vitest";
import {
  createNativeDriver,
  type NativeDriverOptions,
  type NativeMediaFailure,
} from "../apps/web/src/features/playback/drivers/native-driver";

function setup(options: Partial<NativeDriverOptions> = {}) {
  const active = { value: true };
  let source = "";
  const changes: string[] = [];
  const element = {
    error: null as { code: number; message?: string } | null,
    onerror: null as (() => void) | null,
    currentTime: 9,
    playbackRate: 1.5,
    seekable: { length: 1, start: () => 0, end: () => 30 },
    play: vi.fn(),
    pause: vi.fn(),
    load: vi.fn(),
    sourceChanged: undefined as (() => void) | undefined,
    getAttribute: () => source,
    get src() {
      return source;
    },
    set src(value: string) {
      source = value;
      changes.push(value);
      this.sourceChanged?.();
    },
  };
  const errors: NativeMediaFailure[] = [];
  const config: NativeDriverOptions = {
    element: element as unknown as HTMLVideoElement,
    source: "/original.mp4",
    current: () => active.value,
    attached: vi.fn(),
    error: (failure) => errors.push(failure),
    ...options,
  };
  const driver = createNativeDriver(config);
  return { driver, element, active, errors, changes, config };
}
it("captures its original element/source and leaves autoplay, rate and seeking to the caller", () => {
  const f = setup(),
    originalAttached = f.config.attached;
  f.config.source = "/unowned.mp4";
  f.config.element = {} as HTMLVideoElement;
  f.config.attached = vi.fn();
  f.config.current = () => false;
  expect(f.changes).toEqual([]);
  expect(f.driver.attach()).toBe(true);
  expect(f.driver.attach()).toBe(false);
  expect(f.changes).toEqual(["/original.mp4"]);
  expect(f.element.onerror).toBeTypeOf("function");
  expect(f.element.load).not.toHaveBeenCalled();
  expect(originalAttached).toHaveBeenCalledOnce();
  expect(f.config.attached).not.toHaveBeenCalled();
  expect(f.element.play).not.toHaveBeenCalled();
  expect(f.element.pause).not.toHaveBeenCalled();
  expect(f.element.currentTime).toBe(9);
  expect(f.element.playbackRate).toBe(1.5);
  expect(f.element.seekable.end()).toBe(30);
  f.driver.destroy();
});
it("uses a fresh error binding for a same-element source reload", () => {
  const f = setup();
  f.driver.attach();
  const old = f.element.onerror!;
  expect(f.driver.reload("/original.mp4?recovery=1#t=9")).toBe(true);
  const next = f.element.onerror!;
  expect(next).not.toBe(old);
  expect(f.element.load).toHaveBeenCalledOnce();
  expect(f.config.attached).toHaveBeenCalledTimes(2);
  f.element.error = { code: 3 };
  old();
  expect(f.errors).toEqual([]);
  next();
  expect(f.errors).toEqual([{ code: 3 }]);
  expect(Object.isFrozen(f.errors[0])).toBe(true);
  f.driver.destroy();
});
it("a late old dispose or reload cannot clear a successor's handler or source", () => {
  const old = setup();
  old.driver.attach();
  const oldListener = old.element.onerror!;
  const next = setup({
    element: old.element as unknown as HTMLVideoElement,
    source: "/next.mp4",
  });
  next.driver.attach();
  const nextListener = old.element.onerror;
  expect(old.driver.reload("/old.mp4")).toBe(false);
  old.driver.destroy();
  old.driver.destroy();
  expect(old.element.src).toBe("/next.mp4");
  expect(old.element.onerror).toBe(nextListener);
  old.element.error = { code: 2 };
  oldListener();
  expect(old.errors).toEqual([]);
  nextListener!();
  expect(next.errors).toEqual([{ code: 2 }]);
  next.driver.destroy();
});
it("retires the exact error listener even after its application owner is invalid", () => {
  const f = setup();
  f.driver.attach();
  const callback = f.element.onerror!;
  f.active.value = false;
  f.element.error = { code: 3 };
  callback();
  expect(f.errors).toEqual([]);
  expect(f.driver.reload("/retired.mp4")).toBe(false);
  f.driver.destroy();
  expect(f.element.onerror).toBeNull();
  expect(f.element.src).toBe("/original.mp4");
  expect(f.element.load).not.toHaveBeenCalled();
  expect(f.driver.attach()).toBe(false);
});
it("does not announce or load a source invalidated while assigning src", () => {
  const f = setup();
  f.element.sourceChanged = () => f.driver.destroy();
  expect(f.driver.attach(true)).toBe(false);
  expect(f.element.load).not.toHaveBeenCalled();
  expect(f.config.attached).not.toHaveBeenCalled();
  expect(f.element.onerror).toBeNull();
});
it("a reentrant reload announces only the successor source", () => {
  const f = setup();
  f.driver.attach();
  f.element.load.mockImplementation(() => {
    if (f.element.src === "/intermediate.mp4") f.driver.reload("/latest.mp4");
  });
  expect(f.driver.reload("/intermediate.mp4")).toBe(false);
  expect(f.element.src).toBe("/latest.mp4");
  expect(f.config.attached).toHaveBeenCalledTimes(2);
  f.driver.destroy();
});
it("preserves distinct ordinary and live source guards and filters only abort errors", () => {
  for (const requireSource of [true, false]) {
    const f = setup({ requireSource });
    f.driver.attach();
    const listener = f.element.onerror!;
    f.element.src = "";
    f.element.error = { code: 2, message: "private upstream text" };
    listener();
    expect(f.errors).toEqual(requireSource ? [] : [{ code: 2 }]);
    f.element.src = "/original.mp4";
    for (const code of [1, 2, 3, 4]) {
      f.element.error = { code, message: "private upstream text" };
      listener();
    }
    expect(f.errors.slice(-3)).toEqual([{ code: 2 }, { code: 3 }, { code: 4 }]);
    expect(JSON.stringify(f.errors)).not.toContain("private upstream text");
    f.driver.destroy();
  }
});
it("does not reload before attachment or replace an independently installed listener", () => {
  const f = setup();
  expect(f.driver.reload("/early.mp4")).toBe(false);
  f.driver.attach();
  const foreign = vi.fn();
  f.element.onerror = foreign;
  expect(f.driver.reload("/unowned.mp4")).toBe(false);
  f.driver.destroy();
  expect(f.element.onerror).toBe(foreign);
  expect(f.element.src).toBe("/original.mp4");
});
function finiteNativePort(
  options: NativeDriverOptions,
  driver: ReturnType<typeof createNativeDriver>,
) {
  // @ts-expect-error Native media attachment cannot prepare a grant.
  options.api("/playback-sessions", "POST");
  // @ts-expect-error Intent/plan adoption is owned by the session controller.
  options.adoptPlan({});
  // @ts-expect-error The permanent element remains owned by the application.
  driver.element = document.createElement("video");
}
void finiteNativePort;
