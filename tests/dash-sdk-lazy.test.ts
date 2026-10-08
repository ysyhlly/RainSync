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
  const module = await dash.loadDashJs();
  expect(loaded).toHaveBeenCalledOnce();
  expect(module.events).toEqual({ ready: "ready", error: "failure" });
  expect(module.createPlayer()).toEqual({ player: "owned" });
});
