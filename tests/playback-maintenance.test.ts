import { afterEach, expect, it, vi } from "vitest";
import { createPlaybackMaintenance } from "../apps/web/src/features/playback/playback-maintenance";
import { RequestFailure } from "../apps/web/src/errors";
import type { PlaybackPlan } from "../packages/protocol";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(renew: () => Promise<unknown>) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const document = new EventTarget();
  vi.stubGlobal("document", document);
  const plan = { session_id: "owned" } as PlaybackPlan;
  const tick = vi.fn(),
    observe = vi.fn(),
    sample = vi.fn(),
    visibilityChanged = vi.fn();
  const reload = vi.fn(),
    expired = vi.fn();
  const scheduled: Array<() => void> = [];
  const interval = globalThis.setInterval;
  const intervalSpy = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation((callback: any, ...args: any[]) => {
      scheduled.push(callback);
      return interval(callback, ...args);
    });
  const add = vi.spyOn(document, "addEventListener");
  const maintenance = createPlaybackMaintenance({
    tick,
    observe,
    sample,
    visibilityChanged,
    plan: () => plan,
    active: () => true,
    currentPlan: (value) => value === plan,
    epoch: () => 1,
    renew,
    reload,
    expired,
  });
  intervalSpy.mockRestore();
  const visibility = add.mock.calls[0][1] as () => void;
  return {
    maintenance,
    document,
    tick,
    observe,
    sample,
    visibilityChanged,
    reload,
    expired,
    scheduled,
    visibility,
  };
}
it("retires timers/listeners and ignores an in-flight renewal rejection after disposal", async () => {
  let reject!: (failure: unknown) => void;
  const renew = vi.fn(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const s = setup(renew);
  try {
    s.document.dispatchEvent(new Event("visibilitychange"));
    expect(s.visibilityChanged).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1200000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(s.tick).toHaveBeenCalledTimes(2400);
    expect(s.observe).toHaveBeenCalledTimes(240);
    expect(s.sample).toHaveBeenCalledTimes(240);
    s.maintenance.stop();
    expect(vi.getTimerCount()).toBe(0);
    s.document.dispatchEvent(new Event("visibilitychange"));
    expect(s.visibilityChanged).toHaveBeenCalledTimes(1);
    // A callback already queued before disposal still cannot mutate this scope.
    s.visibility();
    for (const callback of s.scheduled) callback();
    expect(s.visibilityChanged).toHaveBeenCalledTimes(1);
    expect(s.tick).toHaveBeenCalledTimes(2400);
    expect(s.observe).toHaveBeenCalledTimes(240);
    expect(s.sample).toHaveBeenCalledTimes(240);
    expect(renew).toHaveBeenCalledTimes(1);
    reject(new RequestFailure({ error: { code: "SESSION_EXPIRED" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(s.expired).not.toHaveBeenCalled();
    expect(s.reload).not.toHaveBeenCalled();
  } finally {
    s.maintenance.stop();
  }
});
it("does not extend a fixed legacy expiry with later successful renewals", async () => {
  const renew = vi
    .fn()
    .mockResolvedValueOnce({
      legacy_expiry_unchanged: true,
      expires_in_seconds: 600,
    })
    .mockResolvedValueOnce({
      legacy_expiry_unchanged: true,
      expires_in_seconds: 1800,
    })
    .mockRejectedValueOnce(
      new RequestFailure({ error: { code: "INVALID_PLAYBACK_SESSION" } }),
    );
  const s = setup(renew);
  try {
    await vi.advanceTimersByTimeAsync(1800000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(s.reload).toHaveBeenCalledTimes(1);
    expect(s.expired).not.toHaveBeenCalled();
  } finally {
    s.maintenance.stop();
  }
});
