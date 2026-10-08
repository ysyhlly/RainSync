import type Hls from "hls.js";
import type {
  FragmentLoaderContext,
  Loader,
  HlsConfig,
  LoaderConfiguration,
  LoaderCallbacks,
} from "hls.js";
import { RoomP2PTransport } from "./room-p2p";
export function createP2PFragmentLoader(
  transport: RoomP2PTransport,
  bufferSeconds: () => number,
  HlsLibrary: typeof Hls,
) {
  const Base = HlsLibrary.DefaultConfig.loader as new (
    config: HlsConfig,
  ) => Loader<FragmentLoaderContext>;
  return class SharedFragmentLoader extends Base {
    private controller?: AbortController;
    override load(
      context: FragmentLoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<FragmentLoaderContext>,
    ): void {
      if (
        context.responseType !== "arraybuffer" ||
        context.rangeStart !== undefined ||
        context.rangeEnd !== undefined ||
        !transport.has(context.url)
      ) {
        super.load(context, config, callbacks);
        return;
      }
      this.context = context;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      this.stats.loading.start = performance.now();
      void transport
        .load(context.url, bufferSeconds(), signal)
        .then((data) => {
          if (signal.aborted) return;
          this.stats.loaded = this.stats.total = data.byteLength;
          this.stats.chunkCount = 1;
          this.stats.loading.first = this.stats.loading.end = performance.now();
          callbacks.onSuccess(
            { url: context.url, data },
            this.stats,
            context,
            null,
          );
        })
        .catch((error) => {
          if (!signal.aborted)
            callbacks.onError(
              {
                code: 0,
                text:
                  error instanceof Error
                    ? error.message
                    : "P2P/HTTP 分片加载失败",
              },
              context,
              null,
              this.stats,
            );
        });
    }
    override abort(): void {
      this.controller?.abort();
      this.stats.aborted = true;
      super.abort();
    }
    override destroy(): void {
      this.controller?.abort();
      super.destroy();
    }
  };
}
