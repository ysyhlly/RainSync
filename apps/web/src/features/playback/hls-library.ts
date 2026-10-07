import type Hls from "hls.js";
export type HlsLibrary = typeof Hls;
let library: Promise<HlsLibrary> | undefined;
/** Concurrent HLS plans share one download; a failed download may be retried. */
export function loadHlsLibrary(): Promise<HlsLibrary> {
  if (!library) {
    const pending = import("hls.js").then((module) => module.default);
    library = pending;
    void pending.catch(() => {
      if (library === pending) library = undefined;
    });
  }
  return library;
}
