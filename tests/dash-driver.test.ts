import { expect, it, vi } from "vitest";
const adapter = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../packages/player-core/dash", () => ({
  createDashPlayback: adapter.create,
}));
import {
  createDashDriver,
  type DashDriverOptions,
} from "../apps/web/src/features/playback/drivers/dash-driver";

it("keeps immutable original inputs and leaves SDK lifetime with the existing adapter", async () => {
  const video = {} as HTMLVideoElement;
  const current = vi.fn(() => true),
    status = vi.fn(),
    attached = vi.fn(),
    error = vi.fn();
  let captured: DashDriverOptions | undefined;
  const load = vi.fn(async () => {
    captured!.onSourceAttached?.();
    return captured!.current();
  });
  const destroy = vi.fn();
  adapter.create.mockImplementation((options: DashDriverOptions) => {
    captured = options;
    return { load, destroy, video, snapshot: vi.fn(), detach: vi.fn() };
  });
  const options: DashDriverOptions = {
    video,
    sessionId: "original-session",
    playbackUrl: "/original.mpd",
    current,
    onStatus: status,
    onSourceAttached: attached,
    onError: error,
  };
  const driver = createDashDriver(options);
  options.video = {} as HTMLVideoElement;
  options.sessionId = "successor-session";
  options.playbackUrl = "/successor.mpd";
  options.current = () => false;
  options.onSourceAttached = vi.fn();
  expect(await driver.load()).toBe(true);
  expect(captured).toMatchObject({
    video,
    sessionId: "original-session",
    playbackUrl: "/original.mpd",
    current,
    onStatus: status,
    onError: error,
  });
  expect(attached).toHaveBeenCalledOnce();
  expect(options.onSourceAttached).not.toHaveBeenCalled();
  expect(adapter.create).toHaveBeenCalledOnce();
  driver.destroy();
  expect(destroy).toHaveBeenCalledOnce();
  expect(Object.keys(driver).sort()).toEqual(["destroy", "load"]);
});
function finiteDashDriver(
  options: DashDriverOptions,
  driver: ReturnType<typeof createDashDriver>,
) {
  // @ts-expect-error The driver cannot create a playback grant.
  options.api("/playback-sessions", "POST");
  // @ts-expect-error SDK configuration/loading is owned by the existing adapter.
  options.loadModule = () => Promise.resolve({});
  // @ts-expect-error The permanent video stays with the application.
  driver.video = document.createElement("video");
}
void finiteDashDriver;
