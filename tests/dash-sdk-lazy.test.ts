import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.doUnmock("dashjs");
  vi.resetModules();
  vi.unstubAllGlobals();
});
it("imports the DASH SDK only when its module loader is requested", async () => {
  vi.resetModules();
  const loaded = vi.fn(),
    create = vi.fn(() => ({ player: "owned" }));
  vi.doMock("dashjs", () => {
    loaded();
    const MediaPlayer = Object.assign(() => ({ create }), {
      events: { STREAM_INITIALIZED: "ready", ERROR: "failure" },
    });
    return { MediaPlayer };
  });
  const dash = await import("../packages/player-core/dash");
  expect(loaded).not.toHaveBeenCalled();
  const preloaded = dash.loadDashJs(),
    concurrent = dash.loadDashJs();
  expect(concurrent).toBe(preloaded);
  expect(create).not.toHaveBeenCalled();
  const module = await preloaded;
  expect(loaded).toHaveBeenCalledOnce();
  expect(dash.loadDashJs()).toBe(preloaded);
  expect(module.events).toEqual({ ready: "ready", error: "failure" });
  expect(module.createPlayer()).toEqual({ player: "owned" });
});

it("evicts a failed SDK download so a subsequent request can load it", async () => {
  vi.resetModules();
  vi.doMock("dashjs", () => {
    throw new Error("chunk unavailable");
  });
  const dash = await import("../packages/player-core/dash");
  const rejected = dash.loadDashJs();
  await expect(rejected).rejects.toThrow();
  const MediaPlayer = Object.assign(() => ({ create: () => ({}) }), {
    events: { STREAM_INITIALIZED: "ready", ERROR: "failure" },
  });
  vi.doMock("dashjs", () => ({ MediaPlayer }));
  const retry = dash.loadDashJs();
  expect(retry).not.toBe(rejected);
  await expect(retry).resolves.toMatchObject({ events: { ready: "ready" } });
});

it.each([false, true])(
  "prewarm and attachment share one SDK load after optional first failure=%s",
  async (failFirst) => {
    vi.resetModules();
    vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
    const { prewarmNativeDash } =
      await import("../apps/web/src/features/playback/dash-prewarm");
    const legacy = await import("../packages/player-core/dash");
    const direct = await import("../packages/player-core/dash/loader");
    expect(legacy.loadDashJs).toBe(direct.loadDashJs);
    const media = {
      platform: {
        version: 1 as const,
        provider: "bilibili" as const,
        content_id: "BV1jdhv66Eu2",
        part: 1,
      },
    };
    const player = {
      initialize: vi.fn(),
      updateSettings: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      addRequestInterceptor: vi.fn(),
      removeRequestInterceptor: vi.fn(),
      addResponseInterceptor: vi.fn(),
      removeResponseInterceptor: vi.fn(),
      destroy: vi.fn(),
    };
    const create = vi.fn(() => player);
    const MediaPlayer = Object.assign(() => ({ create }), {
      events: { STREAM_INITIALIZED: "ready", ERROR: "failure" },
    });
    const video = Object.assign(new EventTarget(), {
      currentTime: 0,
      duration: 30,
      readyState: 0,
      paused: true,
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
    }) as unknown as HTMLVideoElement;
    const onError = vi.fn();
    const make = () =>
      legacy.createDashPlayback({
        video,
        origin: "http://localhost",
        sessionId: "12345678-1234-1234-1234-123456789abc",
        playbackUrl:
          "/api/v1/platform-delivery/12345678-1234-1234-1234-123456789abc/manifest.mpd?token=opaque_server_token_123456789",
        onError,
      });
    if (failFirst) {
      const failedImport = vi.fn(() => {
        throw Error("first SDK load failed");
      });
      vi.doMock("dashjs", failedImport);
      const warming = prewarmNativeDash(media),
        first = make();
      expect(await first.load()).toBe(false);
      await warming;
      expect(failedImport).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "DASH_LIBRARY_LOAD_FAILED" }),
      );
      first.destroy();
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const imported = vi.fn(async () => {
      await gate;
      return { MediaPlayer };
    });
    vi.doMock("dashjs", imported);
    const warming = prewarmNativeDash(media),
      attached = make();
    const loading = attached.load(),
      shared = direct.loadDashJs();
    expect(legacy.loadDashJs()).toBe(shared);
    await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
    expect(create).not.toHaveBeenCalled();
    expect(player.initialize).not.toHaveBeenCalled();
    release();
    await warming;
    expect(await loading).toBe(true);
    expect(direct.loadDashJs()).toBe(shared);
    expect(imported).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(player.initialize).toHaveBeenCalledWith(
      video,
      expect.stringContaining("manifest.mpd"),
      false,
    );
    attached.destroy();
    expect(player.destroy).toHaveBeenCalledOnce();
  },
);
