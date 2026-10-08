import { loadHlsLibrary } from "./hls-library";
import type { HlsDriverOptions } from "./drivers/hls-driver";

async function load() {
  const [Hls, { createHlsDriver }] = await Promise.all([
    loadHlsLibrary(),
    import("./drivers/hls-driver"),
  ]);
  return {
    isSupported: () => Hls.isSupported(),
    create: (options: HlsDriverOptions) => createHlsDriver(Hls, options),
  };
}
let driver: ReturnType<typeof load> | undefined;
/** Driver code and SDK share the existing HLS-only await, not a second load path. */
export function loadHlsDriver() {
  if (!driver) {
    const pending = load();
    driver = pending;
    void pending.catch(() => {
      if (driver === pending) driver = undefined;
    });
  }
  return driver;
}
