import { afterEach, expect, it, vi } from "vitest";
const { load } = vi.hoisted(() => ({ load: vi.fn().mockResolvedValue({}) }));
vi.mock("../packages/player-core/dash", () => ({ loadDashJs: load }));
import { prewarmNativeDash } from "../apps/web/src/features/playback/dash-prewarm";
const bili = {
  platform: {
    version: 1 as const,
    provider: "bilibili" as const,
    content_id: "BV1jdhv66Eu2",
    part: 1,
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  load.mockClear();
  load.mockResolvedValue({});
});
it("starts a public SDK warm-up for known native Bilibili intent before any playback grant", async () => {
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
  await prewarmNativeDash(bili, "native");
  expect(load).toHaveBeenCalledOnce();
});
it("does not download the SDK for unknown media, incompatible modes, live sources or unavailable MSE", () => {
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
  expect(prewarmNativeDash(undefined)).toBeUndefined();
  expect(prewarmNativeDash(bili, "compatibility")).toBeUndefined();
  expect(prewarmNativeDash(bili, "adaptive")).toBeUndefined();
  expect(
    prewarmNativeDash({ platform: { ...bili.platform, version: 3 } } as any),
  ).toBeUndefined();
  vi.stubGlobal("self", {});
  expect(prewarmNativeDash(bili)).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});
it("handles a failed optional warm-up without converting it to playback failure", async () => {
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
  load.mockRejectedValueOnce(Error("offline"));
  await expect(prewarmNativeDash(bili)).resolves.toBeUndefined();
  load.mockResolvedValueOnce({});
  await expect(prewarmNativeDash(bili)).resolves.toBeUndefined();
  expect(load).toHaveBeenCalledTimes(2);
});
