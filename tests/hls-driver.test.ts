import { afterEach, expect, it, vi } from "vitest";
import type Hls from "hls.js";
import type {
  HlsDriverOptions,
  HlsFailure,
} from "../apps/web/src/features/playback/drivers/hls-driver";
import { createHlsDriver } from "../apps/web/src/features/playback/drivers/hls-driver";

class FakeFragmentLoader {
  stats = { loading: { start: 0 }, aborted: false };
  constructor(private config: Record<string, any>) {}
  load(context: { url: string }) {
    this.config.xhrSetup({}, context.url);
  }
  abort() {}
  destroy() {}
}
class FakeHls {
  static Events = {
    ERROR: "error",
    CUES_PARSED: "cues",
    MANIFEST_PARSED: "manifest",
    LEVEL_SWITCHED: "level",
  };
  static instances: FakeHls[] = [];
  static DefaultConfig = { loader: FakeFragmentLoader };
  handlers = new Map<string, Set<(event: string, data: any) => void>>();
  levels: any[] = [];
  loadLevel = -1;
  liveSyncPosition = 31;
  source: (() => void) | undefined;
  loadSource = vi.fn((_url: string) => this.source?.());
  attachMedia = vi.fn();
  startLoad = vi.fn();
  stopLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn();
  on = vi.fn((event: string, listener: (event: string, data: any) => void) => {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(listener);
    this.handlers.set(event, handlers);
  });
  off = vi.fn((event: string, listener: (event: string, data: any) => void) =>
    this.handlers.get(event)?.delete(listener),
  );
  constructor(public config: Record<string, any>) {
    FakeHls.instances.push(this);
  }
  emit(event: string, data: unknown = {}) {
    this.handlers.get(event)?.forEach((listener) => listener(event, data));
  }
}
afterEach(() => {
  FakeHls.instances.length = 0;
});
function setup(overrides: Partial<HlsDriverOptions> = {}) {
  const active = { value: true };
  const element = { error: null } as HTMLVideoElement;
  const events: HlsFailure[] = [];
  const options: HlsDriverOptions = {
    element,
    url: "/original.m3u8",
    startPosition: 7,
    current: () => active.value,
    attached: vi.fn(),
    manifest: vi.fn(),
    level: vi.fn(),
    captions: vi.fn(),
    error: (value) => events.push(value),
    ...overrides,
  };
  const driver = createHlsDriver(FakeHls as unknown as typeof Hls, options);
  return {
    driver,
    sdk: FakeHls.instances.at(-1)!,
    options,
    active,
    element,
    events,
  };
}
it("owns one SDK and attaches the original element in the existing event order", () => {
  const f = setup({ live: true });
  expect(f.sdk.loadSource).not.toHaveBeenCalled();
  expect(f.sdk.attachMedia).not.toHaveBeenCalled();
  expect(f.sdk.config).toMatchObject({
    startPosition: 7,
    maxBufferLength: 20,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
    enableCEA708Captions: true,
    enableWebVTT: false,
    enableIMSC1: false,
    renderTextTracksNatively: false,
  });
  expect(f.sdk.handlers.has("error")).toBe(false);
  expect(f.driver.attach()).toBe(true);
  expect(f.driver.attach()).toBe(false);
  expect(f.sdk.loadSource).toHaveBeenCalledExactlyOnceWith("/original.m3u8");
  expect(f.sdk.attachMedia).toHaveBeenCalledExactlyOnceWith(f.element);
  expect(f.options.attached).toHaveBeenCalledOnce();
  expect(f.sdk.loadSource.mock.invocationCallOrder[0]).toBeLessThan(
    f.sdk.attachMedia.mock.invocationCallOrder[0]!,
  );
  expect(f.sdk.attachMedia.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(f.options.attached).mock.invocationCallOrder[0]!,
  );
  expect(
    vi.mocked(f.options.attached).mock.invocationCallOrder[0],
  ).toBeLessThan(f.sdk.on.mock.invocationCallOrder.at(-1)!);
  f.driver.setLevel(2);
  expect(f.sdk.loadLevel).toBe(2);
  expect(f.driver.liveSyncPosition).toBe(31);
  f.driver.destroy();
});
it("captures source, element and callbacks rather than adopting later option mutations", () => {
  const f = setup(),
    originalElement = f.element;
  f.options.url = "/successor.m3u8";
  f.options.element = {} as HTMLVideoElement;
  f.options.current = () => false;
  f.options.error = vi.fn();
  expect(f.driver.attach()).toBe(true);
  f.sdk.emit("error", {
    fatal: true,
    type: "mediaError",
    details: "bufferAppendError",
  });
  expect(f.sdk.loadSource).toHaveBeenCalledWith("/original.m3u8");
  expect(f.sdk.attachMedia).toHaveBeenCalledWith(originalElement);
  expect(f.events).toHaveLength(1);
  expect(f.options.error).not.toHaveBeenCalled();
  f.driver.destroy();
});
it("retires all exact listeners before idempotent SDK destruction", () => {
  const f = setup();
  f.driver.attach();
  const listeners = [...f.sdk.handlers].flatMap(([event, callbacks]) =>
    [...callbacks].map((callback) => ({ event, callback })),
  );
  f.sdk.destroy.mockImplementation(() =>
    listeners.forEach(({ event, callback }) =>
      callback(event, {
        fatal: true,
        type: "mediaError",
        details: "bufferAppendError",
      }),
    ),
  );
  f.driver.destroy();
  f.driver.destroy();
  expect(f.sdk.destroy).toHaveBeenCalledOnce();
  expect(f.sdk.off).toHaveBeenCalledTimes(listeners.length);
  for (const { event, callback } of listeners)
    expect(f.sdk.off).toHaveBeenCalledWith(event, callback);
  expect([...f.sdk.handlers.values()].every((set) => set.size === 0)).toBe(
    true,
  );
  expect(f.events).toHaveLength(0);
  expect(f.driver.attach()).toBe(false);
  expect(f.driver.reload(10)).toBe(false);
});
it("a retired owner cannot emit facts or drive playback, but its cleanup remains usable", () => {
  const f = setup();
  f.driver.attach();
  f.active.value = false;
  f.sdk.emit("error", {
    fatal: true,
    type: "networkError",
    details: "fragLoadError",
  });
  f.sdk.emit("manifest");
  f.sdk.emit("level", { level: 2 });
  f.sdk.emit("cues", { type: "captions", track: "cc", cues: [] });
  f.driver.startLoad(7);
  f.driver.recoverMediaError();
  f.driver.setLevel(2);
  expect(f.driver.reload(7)).toBe(false);
  expect(f.driver.liveSyncPosition).toBeUndefined();
  expect(f.events).toHaveLength(0);
  expect(f.options.manifest).not.toHaveBeenCalled();
  expect(f.options.level).not.toHaveBeenCalled();
  expect(f.options.captions).not.toHaveBeenCalled();
  expect(f.sdk.startLoad).not.toHaveBeenCalled();
  expect(f.sdk.recoverMediaError).not.toHaveBeenCalled();
  expect(f.sdk.loadLevel).toBe(-1);
  f.driver.stopLoad();
  f.driver.destroy();
  expect(f.sdk.stopLoad).toHaveBeenCalledOnce();
  expect(f.sdk.destroy).toHaveBeenCalledOnce();
});
it("late callbacks and repeated cleanup of a disposed driver cannot affect its successor", () => {
  const old = setup();
  old.driver.attach();
  const callback = [...old.sdk.handlers.get("error")!][0]!;
  old.driver.destroy();
  const next = setup({ element: old.element });
  next.driver.attach();
  callback("error", {
    fatal: true,
    type: "mediaError",
    details: "bufferAppendError",
  });
  old.driver.destroy();
  old.driver.startLoad(0);
  expect(old.events).toHaveLength(0);
  expect(old.sdk.destroy).toHaveBeenCalledOnce();
  expect(next.sdk.destroy).not.toHaveBeenCalled();
  expect(next.sdk.attachMedia).toHaveBeenCalledExactlyOnceWith(old.element);
  next.driver.destroy();
});
it("synchronous source invalidation cannot attach or announce a retired source", () => {
  const f = setup();
  f.sdk.source = () => f.driver.destroy();
  expect(f.driver.attach()).toBe(false);
  expect(f.sdk.attachMedia).not.toHaveBeenCalled();
  expect(f.options.attached).not.toHaveBeenCalled();
  expect(f.sdk.handlers.has("error")).toBe(false);
});
it("reload uses the captured source and stops before startLoad when its owner changes", () => {
  const f = setup();
  f.driver.attach();
  expect(f.driver.reload(12)).toBe(true);
  expect(f.sdk.config.startPosition).toBe(12);
  expect(f.sdk.startLoad).toHaveBeenCalledExactlyOnceWith(12);
  f.sdk.source = () => {
    f.active.value = false;
  };
  expect(f.driver.reload(20)).toBe(false);
  expect(f.sdk.loadSource.mock.calls.map(([url]) => url)).toEqual([
    "/original.m3u8",
    "/original.m3u8",
    "/original.m3u8",
  ]);
  expect(f.sdk.startLoad).toHaveBeenCalledTimes(1);
  f.driver.destroy();
});
it("keeps original bounded delivery codes and never returns raw response or request objects", () => {
  const f = setup();
  f.driver.attach();
  const emit = (code: number, body: unknown) =>
    f.sdk.emit("error", {
      fatal: true,
      type: "networkError",
      details: "fragLoadError",
      response: { code, url: "private-url" },
      networkDetails: { responseText: body },
      error: new Error("raw upstream text"),
    });
  emit(410, JSON.stringify({ error: { code: "NATIVE_LIVE_WINDOW_EXPIRED" } }));
  expect(f.events.at(-1)?.liveCode).toBe("NATIVE_LIVE_WINDOW_EXPIRED");
  emit(422, JSON.stringify({ error: { code: "UNSUPPORTED_TIMELINE" } }));
  expect(f.events.at(-1)?.unsupportedTimeline).toBe(true);
  emit(500, JSON.stringify({ error: { code: "UNSUPPORTED_TIMELINE" } }));
  expect(f.events.at(-1)?.unsupportedTimeline).toBe(false);
  emit(410, "x".repeat(16385));
  expect(f.events.at(-1)?.liveCode).toBeUndefined();
  emit(410, JSON.stringify({ error: { code: "untrusted-code" } }));
  expect(f.events.at(-1)?.liveCode).toBeUndefined();
  for (const fact of f.events) {
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.response)).toBe(true);
    expect(JSON.stringify(fact)).not.toMatch(
      /private-url|raw upstream text|untrusted-code|networkDetails/,
    );
  }
  f.driver.destroy();
});
it("validates native request URLs under the original live attachment owner", () => {
  const validateRequest = vi.fn((url: string) => url === "/allowed");
  const f = setup({ validateRequest });
  f.driver.attach();
  expect(() => f.sdk.config.xhrSetup({}, "/allowed")).not.toThrow();
  expect(() => f.sdk.config.xhrSetup({}, "/foreign")).toThrow(
    "NATIVE_PLATFORM_DELIVERY_INVALID",
  );
  f.active.value = false;
  expect(() => f.sdk.config.xhrSetup({}, "/allowed")).toThrow(
    "PLAYBACK_ATTACHMENT_RETIRED",
  );
  expect(validateRequest).toHaveBeenCalledTimes(2);
  f.driver.destroy();
});

it("captures the fragment read port and fences it when the attachment retires", async () => {
  const bytes = new ArrayBuffer(8);
  const original = {
    has: vi.fn(() => true),
    load: vi.fn(async () => bytes),
  };
  const successor = { has: vi.fn(() => true), load: vi.fn() };
  const fragments = { transport: original, bufferSeconds: () => 17 };
  const f = setup({ fragments });
  f.driver.attach();
  fragments.transport = successor;
  fragments.bufferSeconds = () => 0;
  const Loader = f.sdk.config.fLoader;
  const callbacks = { onSuccess: vi.fn(), onError: vi.fn() };
  new Loader(f.sdk.config).load(
    { url: "/fragment.ts", responseType: "arraybuffer" },
    {},
    callbacks,
  );
  await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
  expect(original.load).toHaveBeenCalledWith(
    "/fragment.ts",
    17,
    expect.any(AbortSignal),
  );
  expect(successor.has).not.toHaveBeenCalled();
  expect(successor.load).not.toHaveBeenCalled();
  f.active.value = false;
  expect(() =>
    new Loader(f.sdk.config).load(
      { url: "/fragment.ts", responseType: "arraybuffer" },
      {},
      callbacks,
    ),
  ).toThrow("PLAYBACK_ATTACHMENT_RETIRED");
  expect(original.load).toHaveBeenCalledTimes(1);
  f.driver.destroy();
});

function finiteHlsDriver(
  options: HlsDriverOptions,
  driver: ReturnType<typeof createHlsDriver>,
) {
  // @ts-expect-error A driver does not request playback sessions.
  options.api("/playback-sessions", "POST");
  // @ts-expect-error Only the session controller can replace the plan.
  options.adoptPlan({});
  // @ts-expect-error The SDK instance never escapes the finite media port.
  driver.sdk.destroy();
}
void finiteHlsDriver;
