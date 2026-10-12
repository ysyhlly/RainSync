import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.doUnmock("../apps/web/src/features/playback/drivers/dash-driver");
  vi.resetModules();
});
it("shares a deferred driver import and permits retry after the first import fails", async () => {
  vi.resetModules();
  vi.doMock("../apps/web/src/features/playback/drivers/dash-driver", () => {
    throw Error("module unavailable");
  });
  const { loadDashDriver } =
    await import("../apps/web/src/features/playback/dash-driver-loader");
  const failed = loadDashDriver();
  expect(loadDashDriver()).toBe(failed);
  await expect(failed).rejects.toThrow();
  const create = vi.fn();
  vi.doMock("../apps/web/src/features/playback/drivers/dash-driver", () => ({
    createDashDriver: create,
  }));
  const retry = loadDashDriver();
  expect(retry).not.toBe(failed);
  expect(loadDashDriver()).toBe(retry);
  await expect(retry).resolves.toMatchObject({ createDashDriver: create });
  expect(create).not.toHaveBeenCalled();
});
