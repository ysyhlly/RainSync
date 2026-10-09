import type Hls from "hls.js";
import type { ErrorData, HlsListeners } from "hls.js";
import type { LadderLevel } from "../local-hls-ladder-intent";
import { createP2PFragmentLoader } from "../room-p2p-loader";
export { RoomP2PTransport } from "../room-p2p";

const liveCodes = [
  "NATIVE_LIVE_WINDOW_EXPIRED",
  "NATIVE_LIVE_BROADCAST_CHANGED",
  "NATIVE_LIVE_NOT_BROADCASTING",
  "NATIVE_LIVE_PLAYLIST_CHANGED",
  "NATIVE_LIVE_STATE_CHANGED",
  "NATIVE_LIVE_RATE_LIMITED",
  "NATIVE_LIVE_CAPACITY",
  "NATIVE_PLATFORM_URL_EXPIRED",
  "ROOM_NOT_ACTIVE",
  "STALE_MEDIA",
] as const;

/** SDK facts only. No response body, request handle or retry authority escapes. */
export type HlsFailure = Readonly<{
  fatal: boolean;
  type: string;
  details: string;
  response?: Readonly<{ code?: number }>;
  media_error_code?: number;
  error_name?: string;
  liveCode?: (typeof liveCodes)[number];
  unsupportedTimeline: boolean;
}>;
function failureFact(data: ErrorData, element: HTMLVideoElement): HlsFailure {
  let reported: unknown;
  try {
    const body =
      data.networkDetails && "responseText" in data.networkDetails
        ? data.networkDetails.responseText
        : undefined;
    if (typeof body === "string" && body.length <= 16384)
      reported = JSON.parse(body)?.error?.code;
  } catch {
    // Raw upstream responses and throwing SDK accessors never become UI text.
  }
  return Object.freeze({
    fatal: data.fatal,
    type: data.type,
    details: data.details,
    response: data.response && Object.freeze({ code: data.response.code }),
    media_error_code: element.error?.code,
    error_name: data.error?.name,
    liveCode: liveCodes.find((code) => code === reported),
    unsupportedTimeline:
      data.response?.code === 422 && reported === "UNSUPPORTED_TIMELINE",
  });
}

export type HlsDriverOptions = {
  element: HTMLVideoElement;
  url: string;
  startPosition: number;
  current: () => boolean;
  live?: boolean;
  validateRequest?: (url: string) => boolean;
  fragments?: {
    transport: Parameters<typeof createP2PFragmentLoader>[0];
    bufferSeconds: () => number;
  };
  attached: () => void;
  manifest?: (levels: readonly LadderLevel[]) => void;
  level?: (level: number) => void;
  captions?: (track: string, cues: unknown[]) => void;
  error: (failure: HlsFailure) => void;
};

/** Construct one owned SDK without attaching. The caller binds its source fence
 * before attach(); disposal retires callbacks before touching SDK resources. */
export function createHlsDriver(HlsLibrary: typeof Hls, ctx: HlsDriverOptions) {
  const {
    element,
    url,
    startPosition,
    current: ownsAttachment,
    live,
    validateRequest,
    fragments,
    attached: onAttached,
    manifest,
    level,
    captions,
    error,
  } = ctx;
  const transport = fragments?.transport;
  const bufferSeconds = fragments?.bufferSeconds;
  let disposed = false,
    attached = false;
  const current = () => !disposed && ownsAttachment();
  const sdk = new HlsLibrary({
    startPosition,
    ...(transport && bufferSeconds
      ? {
          fLoader: createP2PFragmentLoader(
            {
              has: (source) => current() && transport.has(source),
              load: (...args) =>
                current()
                  ? transport.load(...args)
                  : Promise.reject(new Error("PLAYBACK_ATTACHMENT_RETIRED")),
            },
            bufferSeconds,
            HlsLibrary,
          ),
        }
      : {}),
    ...(live
      ? {
          enableCEA708Captions: true,
          enableWebVTT: false,
          enableIMSC1: false,
          renderTextTracksNatively: false,
        }
      : {}),
    xhrSetup: (_xhr: XMLHttpRequest, url: string) => {
      if (!current()) throw new Error("PLAYBACK_ATTACHMENT_RETIRED");
      if (validateRequest && !validateRequest(url))
        throw new Error("NATIVE_PLATFORM_DELIVERY_INVALID");
    },
    maxBufferLength: 20,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
  });
  const listeners: (() => void)[] = [];
  function on<E extends keyof HlsListeners>(
    event: E,
    listener: HlsListeners[E],
  ) {
    sdk.on(event, listener);
    listeners.push(() => sdk.off?.(event, listener));
  }
  if (captions)
    on(HlsLibrary.Events.CUES_PARSED, (_, data) => {
      if (current() && data.type === "captions")
        captions!(data.track, data.cues);
    });
  if (manifest)
    on(HlsLibrary.Events.MANIFEST_PARSED, () => {
      if (current()) manifest!(sdk.levels);
    });
  if (level)
    on(HlsLibrary.Events.LEVEL_SWITCHED, (_, data) => {
      if (current()) level!(data.level);
    });
  return {
    get liveSyncPosition() {
      return current() ? sdk.liveSyncPosition : undefined;
    },
    attach() {
      if (attached || !current()) return false;
      attached = true;
      sdk.loadSource(url);
      if (!current()) return false;
      sdk.attachMedia(element);
      if (!current()) return false;
      onAttached();
      if (!current()) return false;
      // Keep the original loadSource → attachMedia → source fact → error-listener order.
      on(HlsLibrary.Events.ERROR, (_, data) => {
        if (current()) error(failureFact(data, element));
      });
      return true;
    },
    reload(position: number) {
      if (!current()) return false;
      sdk.config.startPosition = position;
      sdk.loadSource(url);
      if (!current()) return false;
      sdk.startLoad(position);
      return true;
    },
    startLoad(position: number) {
      if (current()) sdk.startLoad(position);
    },
    stopLoad() {
      // Cleanup remains usable after the application has retired this owner.
      if (!disposed) sdk.stopLoad();
    },
    recoverMediaError() {
      if (current()) sdk.recoverMediaError();
    },
    setLevel(level: number) {
      if (current()) sdk.loadLevel = level;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      try {
        for (const off of listeners.splice(0)) off();
      } finally {
        sdk.destroy();
      }
    },
  };
}
export type HlsDriver = ReturnType<typeof createHlsDriver>;
