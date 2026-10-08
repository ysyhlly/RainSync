import { expect, it, vi } from "vitest";
const library = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../apps/web/src/features/playback/hls-library", () => ({
  loadHlsLibrary: library.load,
}));
import { loadHlsDriver } from "../apps/web/src/features/playback/hls-driver-loader";

it("shares the deferred load and retries after its first SDK failure", async () => {
  let reject!: (failure: unknown) => void;
  library.load.mockImplementationOnce(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  const first = loadHlsDriver();
  expect(loadHlsDriver()).toBe(first);
  reject(new Error("temporary SDK failure"));
  await expect(first).rejects.toThrow("temporary SDK failure");
  const supported = vi.fn(() => true);
  library.load.mockResolvedValue({ isSupported: supported });
  const retry = loadHlsDriver();
  expect(retry).not.toBe(first);
  expect(loadHlsDriver()).toBe(retry);
  const module = await retry;
  expect(module.isSupported()).toBe(true);
  expect(supported).toHaveBeenCalledOnce();
  expect(library.load).toHaveBeenCalledTimes(2);
});
