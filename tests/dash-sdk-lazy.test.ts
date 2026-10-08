import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.doUnmock("dashjs");
  vi.resetModules();
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
