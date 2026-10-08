import { loadDashJs } from "./dash/loader";
export { loadDashJs } from "./dash/loader";
import type { MediaPlayerClass, MediaPlayerSettingClass } from "dashjs";
import { platformSegmentBaseExtension } from "./dash/segment-base";
import {
  createPlatformDashFence,
  validatePlatformDashManifest,
  validatePlatformDashRequest,
  type PlatformDashFence,
} from "./dash/manifest";

export {
  createPlatformDashFence,
  validatePlatformDashManifest,
  validatePlatformDashRequest,
} from "./dash/manifest";
export type { PlatformDashFence, PlatformDashSource } from "./dash/manifest";

type RequestInterceptor = Parameters<
  MediaPlayerClass["addRequestInterceptor"]
>[0];
type ResponseInterceptor = Parameters<
  MediaPlayerClass["addResponseInterceptor"]
>[0];

/** Small DI surface: tests never import the browser SDK or perform requests. */
export interface DashPlayerBridge {
  extend?: MediaPlayerClass["extend"];
  initialize(video: HTMLVideoElement, url: string, autoplay: boolean): void;
  updateSettings(settings: MediaPlayerSettingClass): void;
  on(event: string, handler: (event: unknown) => void): void;
  off(event: string, handler: (event: unknown) => void): void;
  addRequestInterceptor(interceptor: RequestInterceptor): void;
  removeRequestInterceptor(interceptor: RequestInterceptor): void;
  addResponseInterceptor(interceptor: ResponseInterceptor): void;
  removeResponseInterceptor(interceptor: ResponseInterceptor): void;
  destroy(): void;
}
export interface DashModuleBridge {
  createPlayer(): DashPlayerBridge;
  events: { ready: string; error: string };
}
export type DashModuleLoader = () => Promise<DashModuleBridge>;

export type DashPlaybackStatus =
  | "idle"
  | "loading"
  | "loading_media"
  | "ready"
  | "waiting"
  | "playing"
  | "paused"
  | "seeking"
  | "ended"
  | "failed"
  | "detached";
export interface DashPlaybackSnapshot {
  status: DashPlaybackStatus;
  positionSeconds: number;
  durationSeconds: number;
  readyState: number;
  paused: boolean;
}
export interface DashPlaybackError {
  code:
    | "DASH_UNSAFE_SOURCE"
    | "DASH_LIBRARY_LOAD_FAILED"
    | "DASH_INITIALIZATION_FAILED"
    | "DASH_PLAYBACK_ERROR"
    | "DASH_UNSAFE_REQUEST"
    | "DASH_UNSAFE_MANIFEST"
    | "DASH_ENCRYPTED_MEDIA";
  message: string;
  /** Numeric diagnostic only. SDK objects can contain URLs, tokens or bodies. */
  dashCode?: number;
  mediaCode?: number;
}
export interface DashPlaybackOptions {
  video: HTMLVideoElement;
  sessionId: string;
  playbackUrl: string;
  /** Defaults to location.origin. Tests can supply an explicit same origin. */
  origin?: string;
  /** Runtime must fence plan, identity, room/media generation and element. */
  current?: () => boolean;
  /** Pipeline ready, not decoded data, successful play or a presented frame. */
  onReady?: () => void;
  onError?: (error: DashPlaybackError) => void;
  onEnded?: (positionSeconds: number) => void;
  /** Local observations only. Never translate them into automatic room actions. */
  onStatus?: (snapshot: DashPlaybackSnapshot) => void;
  /** initialize has attached the validated source, independently of readiness. */
  onSourceAttached?: () => void;
  loadModule?: DashModuleLoader;
}

/** Fixed clear-VOD policy; no public SDK settings, header, plugin or DRM API.
 * ABR may choose only AVC/AAC representations in the same validated MPD.
 * Server projections bound the rendition set; this does not build an encoder
 * ladder or authorize refreshing a platform URL. Room sync owns time and rate. */
export function platformDashSettings(): MediaPlayerSettingClass {
  return {
    debug: { logLevel: 0, dispatchEvent: false },
    streaming: {
      applyServiceDescription: false,
      applyProducerReferenceTime: false,
      applyContentSteering: false,
      parseInbandPrft: false,
      protection: {
        ignoreEmeEncryptedEvent: true,
        keepProtectionMediaKeys: false,
      },
      utcSynchronization: {
        enabled: false,
        useManifestDateHeaderTimeSource: false,
        backgroundAttempts: 0,
        enableBackgroundSyncAfterSegmentDownloadError: false,
      },
      liveCatchup: { enabled: false },
      gaps: {
        jumpGaps: false,
        jumpLargeGaps: false,
        enableSeekFix: false,
        enableStallFix: false,
      },
      buffer: {
        bufferTimeDefault: 20,
        bufferTimeAtTopQuality: 30,
        bufferTimeAtTopQualityLongForm: 30,
        bufferToKeep: 20,
        fastSwitchEnabled: false,
        enableSeekDecorrelationFix: false,
      },
      scheduling: { scheduleWhilePaused: true },
      text: { defaultEnabled: false },
      lastBitrateCachingInfo: { enabled: false },
      lastMediaSettingsCachingInfo: { enabled: false },
      saveLastMediaSettingsForCurrentStreamingSession: false,
      fragmentRequestTimeout: 20000,
      manifestRequestTimeout: 10000,
      retryAttempts: {
        MPD: 1,
        MediaSegment: 1,
        InitializationSegment: 1,
        IndexSegment: 1,
        XLinkExpansion: 0,
        license: 0,
        licenseCertificate: 0,
        other: 0,
      },
      abr: {
        autoSwitchBitrate: { video: true, audio: true },
        enableSupplementalPropertyAdaptationSetSwitching: false,
      },
      cmcd: { enabled: false, applyParametersFromMpd: false },
      cmsd: { enabled: false },
    },
  };
}

function numberCode(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "number" &&
    Number.isSafeInteger(result) &&
    result >= 0
    ? result
    : undefined;
}
function diagnostic(event: unknown) {
  if (!event || typeof event !== "object") return undefined;
  return numberCode((event as Record<string, unknown>).error, "code");
}
function safely(action: () => void) {
  try {
    action();
  } catch {
    /* Local callbacks/teardown must not leak the owned player. */
  }
}

/** Owns SDK attachment only. The actual player remains options.video, which the
 * existing runtime controls directly for play/pause/currentTime/playbackRate. */
export function createDashPlayback(options: DashPlaybackOptions) {
  const video = options.video;
  let generation = 0,
    destroyed = false;
  let status: DashPlaybackStatus = "idle";
  let attachment:
    | {
        player: DashPlayerBridge;
        cleanup: (() => void)[];
        ready: boolean;
        manifestValidated: boolean;
      }
    | undefined;
  const externalCurrent = () => {
    try {
      return !destroyed && options.current?.() !== false;
    } catch {
      return false;
    }
  };
  const snapshot = (): DashPlaybackSnapshot => ({
    status,
    positionSeconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
    readyState: video.readyState,
    paused: video.paused,
  });
  const publish = (next: DashPlaybackStatus) => {
    status = next;
    if (externalCurrent()) safely(() => options.onStatus?.(snapshot()));
  };
  const release = () => {
    ++generation; // Invalidate callbacks BEFORE SDK reset dispatches media events.
    const old = attachment;
    attachment = undefined;
    if (!old) return;
    for (const cleanup of old.cleanup.reverse()) safely(cleanup);
    safely(() => old.player.destroy()); // dash.js destroy also resets source/view.
    safely(() => video.pause());
    safely(() => video.removeAttribute("src"));
    safely(() => video.load());
  };
  const fail = (error: DashPlaybackError) => {
    const notify = externalCurrent();
    release();
    const failedGeneration = generation;
    status = "failed";
    if (notify) {
      safely(() => options.onStatus?.(snapshot()));
      // A status observer can replace this source synchronously. Its new load
      // must not receive the remainder of the previous attachment's failure.
      if (failedGeneration === generation && externalCurrent())
        safely(() => options.onError?.(error));
    }
  };

  return {
    video,
    get attached() {
      return attachment !== undefined;
    },
    get status() {
      return status;
    },
    snapshot,
    /** True means initialize attached this source; await is not readiness or
     * first-frame evidence. False means failed, superseded or detached. */
    async load(): Promise<boolean> {
      if (destroyed) return false;
      release();
      const serial = generation;
      const live = () => serial === generation && externalCurrent();
      if (!live()) return false;
      let fence: PlatformDashFence;
      try {
        const browserOrigin = globalThis.location?.origin;
        if (browserOrigin && options.origin && options.origin !== browserOrigin)
          throw new Error();
        fence = createPlatformDashFence({
          playbackUrl: options.playbackUrl,
          sessionId: options.sessionId,
          origin: options.origin ?? browserOrigin ?? "",
        });
      } catch {
        fail({
          code: "DASH_UNSAFE_SOURCE",
          message: "DASH 播放地址无法安全使用",
        });
        return false;
      }
      publish("loading");
      let module: DashModuleBridge;
      try {
        module = await (options.loadModule ?? loadDashJs)();
      } catch {
        if (live())
          fail({
            code: "DASH_LIBRARY_LOAD_FAILED",
            message: "DASH 播放器加载失败，请重试",
          });
        return false;
      }
      if (!live()) return false;
      try {
        const owned = {
          player: module.createPlayer(),
          cleanup: [] as (() => void)[],
          ready: false,
          manifestValidated: false,
        };
        attachment = owned;
        const current = () => live() && attachment === owned;
        // dash.js 5.2.0 HTTPLoader does not catch interceptor rejections. A
        // denied gate therefore stays unresolved AFTER synchronous destruction:
        // no loader.load occurs, and destroy releases queues/listeners. These
        // promises own no timer, abort listener or helper-held reference. They
        // are not an application wait and load() has already settled normally.
        const denied = <T>(): Promise<T> => new Promise<T>(() => {});
        const block = (
          code: "DASH_UNSAFE_REQUEST" | "DASH_UNSAFE_MANIFEST",
        ) => {
          if (current())
            fail({ code, message: "DASH 播放资源校验失败，请重新加载" });
        };
        const requestInterceptor: RequestInterceptor = async (request) => {
          if (!current()) return denied();
          try {
            validatePlatformDashRequest(request.url, fence);
            if (
              (request.method ?? "GET") !== "GET" &&
              request.method !== "HEAD"
            )
              throw new Error();
            if (request.body !== undefined && request.body !== null)
              throw new Error();
            for (const [name, value] of Object.entries(request.headers ?? {})) {
              if (
                name.toLowerCase() !== "range" ||
                !/^bytes=\d+-\d*$/.test(value)
              )
                throw new Error();
            }
            request.credentials = "same-origin";
            request.mode = "same-origin";
            return request;
          } catch {
            block("DASH_UNSAFE_REQUEST");
            return denied();
          }
        };
        const responseInterceptor: ResponseInterceptor = async (response) => {
          if (!current()) return denied();
          try {
            const requestUrl = validatePlatformDashRequest(
              response.request.url,
              fence,
            );
            if (
              response.redirected ||
              (response.url &&
                validatePlatformDashRequest(response.url, fence) !== requestUrl)
            )
              throw new Error();
            if (
              requestUrl === fence.manifestUrl &&
              (response.status ?? 0) >= 200 &&
              (response.status ?? 0) < 300
            ) {
              validatePlatformDashManifest(response.data, fence);
              owned.manifestValidated = true;
            }
            return response;
          } catch {
            block("DASH_UNSAFE_MANIFEST");
            return denied();
          }
        };
        owned.player.addRequestInterceptor(requestInterceptor);
        owned.cleanup.push(() =>
          owned.player.removeRequestInterceptor(requestInterceptor),
        );
        owned.player.addResponseInterceptor(responseInterceptor);
        owned.cleanup.push(() =>
          owned.player.removeResponseInterceptor(responseInterceptor),
        );
        // FactoryMaker applies this only inside this player's context. Enable
        // precise selection after our generated static SegmentBase MPD passes
        // the existing response guard; stale/detached players keep no authority.
        owned.player.extend?.(
          "SegmentBaseGetter",
          platformSegmentBaseExtension(
            () => current() && owned.manifestValidated,
          ),
          true,
        );
        const bind = (event: string, callback: (event: unknown) => void) => {
          const handler = (data: unknown) => {
            if (current()) callback(data);
          };
          owned.player.on(event, handler);
          owned.cleanup.push(() => owned.player.off(event, handler));
        };
        bind(module.events.ready, (event) => {
          if (!owned.manifestValidated) {
            block("DASH_UNSAFE_MANIFEST");
            return;
          }
          if (
            event &&
            typeof event === "object" &&
            (event as Record<string, unknown>).error
          ) {
            fail({
              code: "DASH_PLAYBACK_ERROR",
              message: "DASH 媒体初始化失败",
              dashCode: diagnostic(event),
            });
            return;
          }
          if (owned.ready) return;
          owned.ready = true;
          publish("ready");
          if (current()) safely(() => options.onReady?.());
        });
        bind(module.events.error, (event) => {
          fail({
            code: "DASH_PLAYBACK_ERROR",
            message: "DASH 媒体加载或解码失败，请重新加载",
            dashCode: diagnostic(event),
          });
        });
        const media = (event: string, callback: () => void) => {
          const handler = () => {
            if (current()) callback();
          };
          video.addEventListener(event, handler);
          owned.cleanup.push(() => video.removeEventListener(event, handler));
        };
        for (const [event, next] of [
          ["waiting", "waiting"],
          ["stalled", "waiting"],
          ["playing", "playing"],
          ["pause", "paused"],
          ["seeking", "seeking"],
        ] as const)
          media(event, () => {
            if (owned.ready) publish(next);
          });
        media("seeked", () => {
          if (owned.ready) publish(video.paused ? "paused" : "playing");
        });
        media("ended", () => {
          if (!owned.ready || !video.ended) return;
          publish("ended");
          if (current())
            safely(() => options.onEnded?.(snapshot().positionSeconds));
        });
        media("error", () => {
          const mediaCode = numberCode(video.error, "code");
          if (mediaCode === undefined || mediaCode === 1) return;
          fail({
            code: "DASH_PLAYBACK_ERROR",
            message: "DASH 媒体加载或解码失败，请重新加载",
            mediaCode,
          });
        });
        media("encrypted", () =>
          fail({
            code: "DASH_ENCRYPTED_MEDIA",
            message: "此播放方式不支持加密媒体",
          }),
        );
        owned.player.updateSettings(platformDashSettings());
        video.autoplay = false;
        video.pause();
        if (!current()) {
          release();
          return false;
        }
        // Do not supply a start time. Runtime metadata/apply fences own seeking.
        owned.player.initialize(video, fence.manifestUrl, false);
        if (!current()) return false;
        safely(() => options.onSourceAttached?.());
        if (current() && !owned.ready) publish("loading_media");
        return current();
      } catch {
        if (live())
          fail({
            code: "DASH_INITIALIZATION_FAILED",
            message: "DASH 播放器初始化失败，请重新加载",
          });
        return false;
      }
    },
    detach() {
      release();
      publish("detached");
    },
    destroy() {
      if (destroyed) return;
      release();
      destroyed = true;
      status = "detached";
    },
  };
}

export type DashPlayback = ReturnType<typeof createDashPlayback>;
