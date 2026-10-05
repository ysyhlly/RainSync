import { ref, watch, onScopeDispose, type Ref } from "vue";
import type { PlaybackPlan } from "../../../../../packages/protocol";
import type { useSession } from "../auth/session.store";
import { RequestFailure } from "../../errors";
import {
  platformTextBase,
  platformInbandLive,
  parsePlatformTextCatalog,
  parsePlatformDanmaku,
  parsePlatformVtt,
  parsePlatformLiveDanmaku,
  MAX_PLATFORM_TEXT_BYTES,
  type PlatformSubtitleTrack,
  type PlatformDanmakuCue,
  type PlatformTextStatus,
} from "./platform-text";
export function createPlatformTextRuntime(ctx: {
  session: ReturnType<typeof useSession>;
  video: Ref<HTMLVideoElement | undefined>;
}) {
  const platformSubtitleTracks = ref<PlatformSubtitleTrack[]>([]),
    platformSubtitleId = ref<string | null>(null),
    platformSubtitleStatus = ref<PlatformTextStatus>("idle"),
    platformDanmakuStatus = ref<PlatformTextStatus>("idle"),
    platformDanmakuEnabled = ref(false),
    platformDanmakuCues = ref<PlatformDanmakuCue[]>([]),
    platformTextError = ref(""),
    platformTextLive = ref(false),
    platformLiveDanmakuMode = ref<"off" | "history" | "realtime">("off");
  let serial = 0,
    subtitleSerial = 0,
    danmakuSerial = 0,
    base: string | undefined;
  let timelineOriginSeconds = 0,
    liveStartedMs = 0;
  let danmakuTimer: ReturnType<typeof setTimeout> | undefined;
  let catalogRequest: AbortController | undefined,
    subtitleRequest: AbortController | undefined,
    danmakuRequest: AbortController | undefined;
  let nativeTrack: TextTrack | undefined,
    nativeElement: HTMLVideoElement | undefined;
  type InbandCue = { start: number; end: number; text: string };
  const inband = new Map<
    string,
    { track: PlatformSubtitleTrack; cues: InbandCue[] }
  >();
  const liveSeen = new Map<string, number>();
  let inbandSerial = 0;
  let removeInbandListeners: (() => void) | undefined;
  function liveInbandTracks() {
    return [...inband.values()].map((item) => item.track);
  }
  function renderInband(id: string) {
    const source = inband.get(id),
      element = ctx.video.value;
    if (!source || !element) return;
    clearTrack();
    if (nativeElement !== element || !nativeTrack) {
      nativeElement = element;
      nativeTrack = element.addTextTrack("subtitles", "直播内嵌字幕", "und");
    }
    nativeTrack.mode = "hidden";
    for (const cue of source.cues)
      nativeTrack.addCue(new VTTCue(cue.start, cue.end, cue.text));
    nativeTrack.mode = "showing";
  }
  /** Only observed CEA/native caption cues. Never synthesize timing, advertise
   * absent tracks, execute markup, or follow EXT-X-MEDIA subtitle addresses. */
  function ingestLiveInbandCaptions(track: string, value: unknown) {
    if (
      !platformTextLive.value ||
      !/^[A-Za-z0-9_-]{1,48}$/.test(track) ||
      !Array.isArray(value) ||
      value.length > 512
    )
      return;
    let source = [...inband.values()].find(
      (item) => item.track.label === `直播内嵌字幕 ${track}`,
    );
    if (!source) {
      if (inband.size >= 8) return;
      const id = `ic${++inbandSerial}`;
      source = {
        track: {
          id,
          language: "und",
          label: `直播内嵌字幕 ${track}`,
          automatic: false,
        },
        cues: [],
      };
      inband.set(id, source);
    }
    const cues: InbandCue[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object") continue;
      const cue = candidate as {
        startTime?: unknown;
        endTime?: unknown;
        text?: unknown;
      };
      if (
        typeof cue.startTime !== "number" ||
        typeof cue.endTime !== "number" ||
        typeof cue.text !== "string" ||
        !Number.isFinite(cue.startTime) ||
        !Number.isFinite(cue.endTime) ||
        cue.startTime < 0 ||
        cue.endTime <= cue.startTime ||
        cue.endTime > 604800 ||
        cue.text.length > 12000
      )
        continue;
      const text = [
        ...cue.text
          .replace(/[\n\r\t]/g, " ")
          .replace(
            /[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
            "",
          ),
      ]
        .slice(0, 2000)
        .join("")
        .trim()
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      if (text) cues.push({ start: cue.startTime, end: cue.endTime, text });
    }
    if (!cues.length) {
      if (!source.cues.length) inband.delete(source.track.id);
      return;
    }
    const now = ctx.video.value?.currentTime ?? 0,
      seen = new Set<string>();
    source.cues = [...source.cues, ...cues]
      .filter((cue) => cue.end > now - 120 && cue.start < now + 120)
      .sort((a, b) => a.start - b.start)
      .filter((cue) => {
        const key = `${cue.start}:${cue.end}:${cue.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-512);
    platformSubtitleTracks.value = liveInbandTracks();
    platformSubtitleStatus.value = "available";
    if (platformSubtitleId.value === source.track.id)
      renderInband(source.track.id);
  }
  function observeNativeLiveCaptions(plan: PlaybackPlan) {
    const element = ctx.video.value,
      tracks = element?.textTracks;
    if (!tracks || typeof tracks.addEventListener !== "function") return;
    const expected = new URL(plan.playback_url, location.origin).href;
    const current = () =>
      platformTextLive.value &&
      ctx.video.value === element &&
      element.currentSrc === expected;
    const disposers: (() => void)[] = [];
    const watched = new Set<TextTrack>();
    function scan() {
      if (!current()) return;
      for (const track of Array.from(tracks!)) {
        if (track.kind !== "captions" || watched.has(track)) continue;
        watched.add(track);
        track.mode = "hidden";
        const key = `cc${watched.size}`;
        const observe = () => {
          if (current())
            ingestLiveInbandCaptions(key, Array.from(track.cues ?? []));
        };
        track.addEventListener("cuechange", observe);
        disposers.push(() => track.removeEventListener("cuechange", observe));
        observe();
      }
    }
    tracks.addEventListener("addtrack", scan);
    element.addEventListener("loadedmetadata", scan);
    scan();
    removeInbandListeners = () => {
      tracks.removeEventListener("addtrack", scan);
      element.removeEventListener("loadedmetadata", scan);
      disposers.forEach((dispose) => dispose());
    };
  }
  function clearTrack() {
    if (!nativeTrack) return;
    // A disabled TextTrack may expose cues=null. Hidden loads its cue list
    // without displaying old text, so reset really removes every prior cue.
    nativeTrack.mode = "hidden";
    for (const cue of Array.from(nativeTrack.cues ?? []))
      nativeTrack.removeCue(cue);
    nativeTrack.mode = "disabled";
  }
  function reset() {
    removeInbandListeners?.();
    removeInbandListeners = undefined;
    inband.clear();
    liveSeen.clear();
    inbandSerial = 0;
    ++serial;
    ++subtitleSerial;
    ++danmakuSerial;
    catalogRequest?.abort();
    subtitleRequest?.abort();
    danmakuRequest?.abort();
    clearTimeout(danmakuTimer);
    danmakuTimer = undefined;
    platformTextLive.value = false;
    platformLiveDanmakuMode.value = "off";
    liveStartedMs = 0;
    catalogRequest = subtitleRequest = danmakuRequest = undefined;
    clearTrack();
    base = undefined;
    timelineOriginSeconds = 0;
    platformSubtitleTracks.value = [];
    platformSubtitleId.value = null;
    platformSubtitleStatus.value = platformDanmakuStatus.value = "idle";
    platformDanmakuEnabled.value = false;
    platformDanmakuCues.value = [];
    platformTextError.value = "";
  }
  /** Retire old cues and in-flight catalogs without requesting unsupported text. */
  function unsupported() {
    reset();
    platformSubtitleStatus.value = platformDanmakuStatus.value = "unsupported";
  }
  function requestUrl(suffix: string) {
    if (!base) throw new TypeError("平台播放会话已变化");
    const [path, query] = base.split("?");
    return `${path}${suffix}?${query}`;
  }
  async function bind(plan: PlaybackPlan) {
    reset();
    base = platformTextBase(plan, location.origin);
    if (!base) {
      if (platformInbandLive(plan, location.origin)) {
        platformTextLive.value = true;
        platformSubtitleStatus.value = platformDanmakuStatus.value =
          "unsupported";
        observeNativeLiveCaptions(plan);
      }
      return;
    }
    platformTextLive.value = !!plan.native_platform?.live;
    liveStartedMs = platformTextLive.value
      ? Number(plan.native_platform!.live!.broadcast_id.split(":").at(-1)) *
        1000
      : 0;
    // Text remains bound to the exact original source grant. Finite transform
    // time starts at its seek origin; cue times must be mapped explicitly.
    timelineOriginSeconds = plan.native_platform?.compatibility
      ? plan.timeline_origin_ms / 1000
      : 0;
    if (platformTextLive.value) observeNativeLiveCaptions(plan);
    const active = serial,
      epoch = ctx.session.epoch;
    const controller = new AbortController();
    catalogRequest = controller;
    platformSubtitleStatus.value = platformDanmakuStatus.value = "loading";
    try {
      const result = await ctx.session.api(
        requestUrl("/catalog"),
        "GET",
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      );
      if (
        serial !== active ||
        ctx.session.epoch !== epoch ||
        controller.signal.aborted
      )
        return;
      const catalog = parsePlatformTextCatalog(result);
      platformSubtitleTracks.value = platformTextLive.value
        ? liveInbandTracks()
        : catalog.tracks;
      platformSubtitleStatus.value =
        platformTextLive.value && inband.size
          ? "available"
          : catalog.subtitleStatus;
      platformDanmakuStatus.value = catalog.danmakuStatus;
    } catch (error) {
      if (
        serial !== active ||
        ctx.session.epoch !== epoch ||
        controller.signal.aborted
      )
        return;
      platformSubtitleStatus.value =
        platformTextLive.value && inband.size ? "available" : "failed";
      platformDanmakuStatus.value = "failed";
      platformTextError.value = textFailure(
        error,
        "平台字幕或弹幕不可用，可重新加载播放后再试",
      );
    } finally {
      if (catalogRequest === controller) catalogRequest = undefined;
    }
  }
  async function selectPlatformSubtitle(id: string | null) {
    const selection = ++subtitleSerial,
      active = serial,
      epoch = ctx.session.epoch;
    subtitleRequest?.abort();
    clearTrack();
    platformSubtitleId.value = null;
    platformTextError.value = "";
    if (id === null) return;
    const descriptor = platformSubtitleTracks.value.find(
      (track) => track.id === id,
    );
    if (!descriptor) return;
    if (platformTextLive.value && inband.has(id)) {
      platformSubtitleId.value = id;
      renderInband(id);
      return;
    }
    if (!base) return;
    platformSubtitleId.value = id;
    const controller = new AbortController();
    subtitleRequest = controller;
    try {
      const response = await fetch(
        "/api/v1" + requestUrl(`/subtitles/${encodeURIComponent(id)}`),
        {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(35000),
          ]),
        },
      );
      if (!response.ok) {
        const failure = new RequestFailure(
          await response.json().catch(() => null),
        );
        if (ctx.session.epoch === epoch) ctx.session.invalidate(failure);
        throw failure;
      }
      if (response.headers.get("Content-Type") !== "text/vtt; charset=utf-8")
        throw new TypeError("平台字幕类型无效");
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("平台字幕响应不完整");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let vtt = "",
        size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_PLATFORM_TEXT_BYTES)
            throw new TypeError("平台字幕过大");
          vtt += decoder.decode(part.value, { stream: true });
        }
        vtt += decoder.decode();
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      if (
        serial !== active ||
        subtitleSerial !== selection ||
        ctx.session.epoch !== epoch ||
        controller.signal.aborted
      )
        return;
      const cues = parsePlatformVtt(vtt),
        element = ctx.video.value;
      if (!element) throw new TypeError("播放器未就绪");
      if (nativeElement !== element || !nativeTrack) {
        clearTrack();
        nativeElement = element;
        nativeTrack = element.addTextTrack(
          "subtitles",
          "平台字幕",
          descriptor.language,
        );
      }
      nativeTrack.mode = "hidden";
      for (const cue of cues) {
        if (cue.end <= timelineOriginSeconds) continue;
        nativeTrack.addCue(
          new VTTCue(
            Math.max(0, cue.start - timelineOriginSeconds),
            cue.end - timelineOriginSeconds,
            cue.text,
          ),
        );
      }
      nativeTrack.mode = "showing";
    } catch (error) {
      if (
        serial !== active ||
        subtitleSerial !== selection ||
        ctx.session.epoch !== epoch ||
        controller.signal.aborted
      )
        return;
      clearTrack();
      platformSubtitleId.value = null;
      platformTextError.value = "平台字幕加载失败，可选择语言重试";
    } finally {
      if (subtitleRequest === controller) subtitleRequest = undefined;
    }
  }
  function sourceTimeMs() {
    const time = ctx.video.value?.currentTime;
    return Math.max(
      0,
      Math.round(
        ((typeof time === "number" && Number.isFinite(time) ? time : 0) +
          timelineOriginSeconds) *
          1000,
      ),
    );
  }
  function textFailure(error: unknown, fallback: string) {
    const code = error instanceof RequestFailure ? error.code : "";
    return (
      (
        {
          NATIVE_PLATFORM_CAPTION_METADATA_UNAVAILABLE:
            "平台未提供可核对的字幕元数据，未假定此影片没有字幕",
          NATIVE_PLATFORM_CAPTION_FORMAT_UNSUPPORTED:
            "平台提供的字幕格式暂不支持",
          NATIVE_PLATFORM_CAPTION_ORIGIN_UNSUPPORTED:
            "平台字幕地址超出已核对的安全范围",
          NATIVE_PLATFORM_CAPTION_SIGNING_REQUIRED:
            "平台字幕需要额外签名或验证，当前请求已停止",
          NATIVE_LIVE_DANMAKU_LOGIN_REQUIRED: "实时弹幕需要自己的有效平台账号",
          NATIVE_LIVE_DANMAKU_AUTH_DENIED:
            "平台拒绝实时弹幕连接，未切换账号或重试验证",
        } as Record<string, string>
      )[code] ?? (error instanceof RequestFailure ? error.message : fallback)
    );
  }
  async function setPlatformDanmaku(enabled: boolean) {
    if (platformTextLive.value) {
      await setPlatformLiveDanmaku(enabled ? "history" : "off");
      return;
    }
    const selection = ++danmakuSerial,
      active = serial,
      epoch = ctx.session.epoch;
    danmakuRequest?.abort();
    clearTimeout(danmakuTimer);
    platformDanmakuEnabled.value = false;
    platformDanmakuCues.value = [];
    platformTextError.value = "";
    if (!enabled || !base || platformDanmakuStatus.value !== "available")
      return;
    const controller = new AbortController();
    danmakuRequest = controller;
    const current = () =>
      serial === active &&
      danmakuSerial === selection &&
      ctx.session.epoch === epoch &&
      !controller.signal.aborted;
    let segment = -1;
    async function load() {
      if (!current()) return;
      try {
        const at = sourceTimeMs(),
          wanted = Math.floor(at / 360000);
        if (wanted !== segment) {
          const value = await ctx.session.api(
            requestUrl("/danmaku") + `&at_ms=${at}&rendering_version=2`,
            "GET",
            undefined,
            AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
          );
          if (!current()) return;
          platformDanmakuCues.value = parsePlatformDanmaku(value)
            .filter((cue) => cue.at_ms >= timelineOriginSeconds * 1000)
            .map((cue) => ({
              ...cue,
              at_ms: cue.at_ms - timelineOriginSeconds * 1000,
            }));
          segment = wanted;
          platformDanmakuEnabled.value = true;
        }
        if (current()) danmakuTimer = setTimeout(() => void load(), 1000);
      } catch (error) {
        if (!current()) return;
        platformDanmakuEnabled.value = false;
        platformDanmakuCues.value = [];
        platformTextError.value = textFailure(
          error,
          "原站弹幕加载失败，可重新开启重试",
        );
      }
    }
    await load();
  }
  function mapLive(value: unknown, snapshot: boolean) {
    if (value && typeof value === "object" && "error" in value)
      throw new RequestFailure(value);
    const packet = parsePlatformLiveDanmaku(value, liveStartedMs, snapshot),
      time = ctx.video.value?.currentTime ?? 0;
    if (!Number.isFinite(time) || time < 0)
      throw new TypeError("直播播放器时钟无效");
    const now = Math.round(time * 1000);
    for (const [key, at] of liveSeen)
      if (at < packet.nowMs - 120000) liveSeen.delete(key);
    const mapped = packet.cues
      .filter((cue) => {
        const key = `${cue.at_ms}:${cue.mode}:${cue.text}`;
        if (liveSeen.has(key)) return false;
        liveSeen.set(key, packet.nowMs);
        if (liveSeen.size > 1000)
          liveSeen.delete(liveSeen.keys().next().value!);
        return true;
      })
      .map((cue) => ({
        ...cue,
        at_ms: now - (packet.nowMs - liveStartedMs - cue.at_ms),
      }))
      .filter((cue) => cue.at_ms >= 0 && cue.at_ms <= now + 5000);
    // Keep only a tiny decoder-local display window; raw user IDs, event IDs,
    // provider URLs and client identifiers are never present in the response.
    const all = [...platformDanmakuCues.value, ...mapped]
      .filter((cue) => cue.at_ms > now - 6000)
      .sort((a, b) => a.at_ms - b.at_ms);
    const seen = new Set<string>();
    let second = -1,
      density = 0;
    platformDanmakuCues.value = all
      .filter((cue) => {
        const key = `${cue.at_ms}:${cue.mode}:${cue.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        const bucket = Math.floor(cue.at_ms / 1000);
        density = second === bucket ? density + 1 : 1;
        second = bucket;
        return density <= 6;
      })
      .slice(-100);
  }
  async function setPlatformLiveDanmaku(mode: "off" | "history" | "realtime") {
    const selection = ++danmakuSerial,
      active = serial,
      epoch = ctx.session.epoch;
    danmakuRequest?.abort();
    clearTimeout(danmakuTimer);
    platformDanmakuEnabled.value = false;
    platformDanmakuCues.value = [];
    platformLiveDanmakuMode.value = "off";
    platformTextError.value = "";
    if (
      mode === "off" ||
      !platformTextLive.value ||
      !base ||
      platformDanmakuStatus.value !== "available"
    )
      return;
    const controller = new AbortController();
    danmakuRequest = controller;
    const current = () =>
      serial === active &&
      danmakuSerial === selection &&
      ctx.session.epoch === epoch &&
      !controller.signal.aborted;
    platformLiveDanmakuMode.value = mode;
    if (mode === "history") {
      async function poll() {
        try {
          const value = await ctx.session.api(
            requestUrl("/danmaku"),
            "GET",
            undefined,
            AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
          );
          if (!current()) return;
          mapLive(value, true);
          platformDanmakuEnabled.value = true;
          danmakuTimer = setTimeout(() => void poll(), 5000);
        } catch (error) {
          if (!current()) return;
          platformDanmakuEnabled.value = false;
          platformDanmakuCues.value = [];
          platformLiveDanmakuMode.value = "off";
          platformTextError.value = textFailure(
            error,
            "近期直播弹幕获取失败，可重新选择重试",
          );
        }
      }
      await poll();
      return;
    }
    try {
      // The separate UI opt-in discloses transient provider client-ID issuance.
      // No anonymous fallback, automatic reconnect or identifier reuse exists.
      const response = await fetch(
        "/api/v1" + requestUrl("/realtime") + "&consent_client_id=1",
        {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(125000),
          ]),
        },
      );
      if (!response.ok) {
        const failure = new RequestFailure(
          await response.json().catch(() => null),
        );
        if (ctx.session.epoch === epoch) ctx.session.invalidate(failure);
        throw failure;
      }
      if (
        response.headers.get("Content-Type") !==
        "application/x-ndjson; charset=utf-8"
      )
        throw new TypeError("实时弹幕类型无效");
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError("实时弹幕响应不完整");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "",
        total = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (!current()) {
            await reader.cancel();
            return;
          }
          total += part.value.byteLength;
          if (total > MAX_PLATFORM_TEXT_BYTES)
            throw new TypeError("实时弹幕过大");
          pending += decoder.decode(part.value, { stream: true });
          if (pending.length > 256 * 1024)
            throw new TypeError("实时弹幕帧过大");
          let end;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (line) {
              mapLive(JSON.parse(line), false);
              platformDanmakuEnabled.value = true;
            }
          }
        }
        pending += decoder.decode();
        if (pending) throw new TypeError("实时弹幕帧不完整");
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      if (current()) {
        platformDanmakuEnabled.value = false;
        platformDanmakuCues.value = [];
        platformLiveDanmakuMode.value = "off";
        platformTextError.value = "实时弹幕连接已结束，可重新选择开启";
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof RequestFailure && ctx.session.epoch === epoch)
        ctx.session.invalidate(error);
      platformDanmakuEnabled.value = false;
      platformDanmakuCues.value = [];
      platformLiveDanmakuMode.value = "off";
      platformTextError.value = textFailure(
        error,
        "实时弹幕连接失败，未切换账号或自动重连",
      );
    }
  }
  watch(() => ctx.session.epoch, reset, { flush: "sync" });
  watch(
    ctx.video,
    (value, previous) => {
      if (value !== previous) {
        reset();
        nativeTrack = undefined;
        nativeElement = undefined;
      }
    },
    { flush: "sync" },
  );
  onScopeDispose(reset);
  return {
    platformSubtitleTracks,
    platformSubtitleId,
    platformSubtitleStatus,
    platformDanmakuStatus,
    platformDanmakuEnabled,
    platformDanmakuCues,
    platformTextError,
    platformTextLive,
    platformLiveDanmakuMode,
    setPlatformLiveDanmaku,
    ingestLiveInbandCaptions,
    bind,
    reset,
    unsupported,
    selectPlatformSubtitle,
    setPlatformDanmaku,
  };
}
