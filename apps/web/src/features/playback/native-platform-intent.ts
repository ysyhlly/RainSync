import type {
  PlaybackRequest,
  PlaybackPlan,
  NativePlatformCredentialMode,
  NativePlatformProvider,
  NativePlatformMaxHeight,
} from "../../../../../packages/protocol";
import {
  validNativeLiveBinding,
  validNativeLiveDeliveryUrl,
} from "./native-live";
import { validLocalHlsRenditions } from "./local-hls-ladder-intent";
import { createPlatformDashFence } from "../../../../../packages/player-core/dash/manifest";

export type NativePlatformPlaybackMode =
  "auto" | "native" | "compatibility" | "adaptive";
/** Independent transport observations, not a promise about provider permission
 * or codec discovery. A selected compatibility failure never returns native. */
export function nativePlatformPlaybackChoice(
  mode: NativePlatformPlaybackMode,
  provider: NativePlatformProvider,
  capabilities: {
    progressive_h264_aac: boolean;
    mse_h264_aac: boolean;
    native_hls: boolean;
  },
  live = false,
): "native" | "compatibility" | "unsupported" {
  const hls = capabilities.native_hls || capabilities.mse_h264_aac;
  if (live)
    return hls && mode !== "compatibility" && mode !== "adaptive"
      ? "native"
      : "unsupported";
  const native =
    provider === "bilibili"
      ? capabilities.mse_h264_aac
      : provider === "youtube"
        ? capabilities.mse_h264_aac || capabilities.progressive_h264_aac
        : capabilities.progressive_h264_aac;
  if (mode === "compatibility" || mode === "adaptive")
    return hls ? "compatibility" : "unsupported";
  if (native) return "native";
  return mode === "auto" && hls ? "compatibility" : "unsupported";
}

/** Same session, original token, and one actual qualified attempt only. Pending
 * entry URLs deliberately have no attempt, and can never be attached. */
export function validNativeCompatibilityDeliveryUrl(
  value: string,
  plan: PlaybackPlan,
  origin: string,
  entryOnly = false,
): boolean {
  try {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      /[\s\\%#]/.test(value) ||
      value.startsWith("//") ||
      /\/(?:\.|\.\.)(?:\/|\?)/.test(value) ||
      (!value.startsWith("/") && !/^https?:\/\//.test(value))
    )
      return false;
    const url = new URL(value, origin),
      entry = new URL(plan.playback_url, origin);
    const prefix = `/api/v1/platform-delivery/${plan.session_id}/compatibility/`;
    const ladder =
      plan.native_platform?.compatibility?.mode === "hls_avc_aac_ladder";
    const path = url.pathname.slice(prefix.length),
      actual = plan.native_platform?.compatibility?.output?.attempt;
    const rung = path.split("/")[0];
    const segment = path.match(/\/index(0|[1-9][0-9]*)\.m4s$/)?.[1];
    if (
      ladder &&
      path !== "master.m3u8" &&
      (!plan.native_platform?.compatibility?.output?.renditions?.some(
        (r) => r.id === rung,
      ) ||
        (segment !== undefined && Number(segment) >= 20000))
    )
      return false;
    const query =
      actual === undefined || actual === null
        ? /^\?token=[a-f0-9]{64}$/
        : new RegExp(`^\\?token=[a-f0-9]{64}&attempt=${actual}$`);
    return (
      url.origin === origin &&
      entry.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname.startsWith(prefix) &&
      query.test(url.search) &&
      url.search === entry.search &&
      (ladder
        ? path === "master.m3u8" ||
          (!entryOnly &&
            actual != null &&
            /^(?:low|medium|high)\/(?:index\.m3u8|init\.mp4|index(?:0|[1-9][0-9]*)\.m4s)$/.test(
              path,
            ))
        : path === "index.m3u8" ||
          (!entryOnly &&
            actual != null &&
            (path === "init.mp4" ||
              /^index(?:0|[1-9][0-9]*)\.m4s$/.test(path))))
    );
  } catch {
    return false;
  }
}

export function validNativeCompatibilityPlan(
  request: PlaybackRequest,
  plan: PlaybackPlan,
  origin: string,
): boolean {
  const intent = request.native_platform?.compatibility,
    binding = plan.native_platform?.compatibility;
  if (
    !intent ||
    !binding ||
    Object.keys(intent).sort().join(",") !== "mode,version" ||
    Object.keys(binding).some(
      (key) => !["version", "mode", "output"].includes(key),
    ) ||
    intent.version !== 1 ||
    binding.version !== 1 ||
    !["hls_avc_aac", "hls_avc_aac_ladder"].includes(intent.mode) ||
    binding.mode !== intent.mode ||
    request.native_platform?.live_version !== undefined ||
    plan.native_platform?.live ||
    request.mode !== "transcode" ||
    !(request.capabilities?.native_hls || request.capabilities?.mse_h264_aac) ||
    plan.delivery_mode !== "transcode" ||
    !plan.rebuild_on_seek ||
    !Number.isFinite(request.position_ms) ||
    request.position_ms < 0 ||
    plan.timeline_origin_ms !== request.position_ms ||
    !Number.isFinite(plan.duration_ms) ||
    plan.duration_ms! <= plan.timeline_origin_ms ||
    plan.advanced_playback ||
    plan.local_hls_ladder ||
    plan.selected_output ||
    plan.selected_audio_track != null ||
    plan.subtitle_mode !== "none"
  )
    return false;
  const output = binding.output;
  const ladder = intent.mode === "hls_avc_aac_ladder";
  if (plan.transport === "pending_hls") {
    if (
      output != null ||
      plan.pending_job_id !== plan.session_id ||
      !Array.isArray(plan.seekable_media_ranges_ms) ||
      plan.seekable_media_ranges_ms.length !== 0
    )
      return false;
  } else if (plan.transport === "hls") {
    if (
      !output ||
      Object.keys(output).sort().join(",") !==
        (ladder
          ? "attempt,codecs,complete,height,renditions,width"
          : "attempt,codecs,complete,height,width") ||
      !Number.isSafeInteger(output.attempt) ||
      output.attempt <= 0 ||
      typeof output.complete !== "boolean" ||
      (ladder
        ? !validLocalHlsRenditions(output.renditions) ||
          output.width !== output.renditions.at(-1)?.width ||
          output.height !== output.renditions.at(-1)?.height ||
          output.codecs !== output.renditions.at(-1)?.codecs ||
          output.renditions.some((r) => !r.codecs.endsWith(",mp4a.40.2"))
        : output.codecs !== "avc1.64001F,mp4a.40.2" ||
          output.width !== 1280 ||
          output.height !== 720) ||
      plan.pending_job_id != null
    )
      return false;
    const ranges = plan.seekable_media_ranges_ms;
    if (
      !Array.isArray(ranges) ||
      ranges.length !== 1 ||
      ranges[0].start_ms !== plan.timeline_origin_ms ||
      !Number.isFinite(ranges[0].end_ms) ||
      ranges[0].end_ms <= ranges[0].start_ms
    )
      return false;
  } else return false;
  return validNativeCompatibilityDeliveryUrl(
    plan.playback_url,
    plan,
    origin,
    true,
  );
}

/** Dedicated route body deliberately has no decoder/candidate/HTTP fallback offers. */
export function nativePlatformRequest(input: {
  viewer_id: string;
  plan_generation: number;
  idempotency_key: string;
  room_id: string;
  media_generation: number;
  position_ms: number;
  credential_mode: NativePlatformCredentialMode;
  mse_h264_aac: boolean;
  progressive_h264_aac?: boolean;
  provider?: NativePlatformProvider;
  account_id?: string;
  media_id?: string;
  max_height?: NativePlatformMaxHeight;
  live?: boolean;
  native_hls?: boolean;
  compatibility?: boolean;
  compatibility_ladder?: boolean;
  course?: boolean;
  /** Existing optional metrics negotiation for finite Bilibili playback only. */
  playback_metrics?: PlaybackRequest["playback_metrics"];
}): PlaybackRequest {
  if (input.compatibility_ladder && !input.compatibility)
    throw new TypeError("多清晰度 HLS 需要兼容播放模式");
  if (input.live && (input.compatibility || input.course))
    throw new TypeError("直播不支持有限媒体转码或课程播放选项");
  const provider = input.provider ?? "bilibili",
    bilibili = provider === "bilibili",
    dashPlayback = bilibili || provider === "youtube";
  return {
    viewer_id: input.viewer_id,
    plan_generation: input.plan_generation,
    idempotency_key: input.idempotency_key,
    room_id: input.room_id,
    media_generation: input.media_generation,
    position_ms: input.live ? 0 : input.position_ms,
    mode: input.compatibility ? "transcode" : "direct",
    audio_index: null,
    ...(bilibili && !input.live && !input.course && input.playback_metrics
      ? {
          playback_metrics_version: 1,
          playback_metrics_supported_versions: [1, 2],
          playback_metrics: { ...input.playback_metrics },
        }
      : {}),
    capabilities: {
      progressive_h264_aac: !bilibili && input.progressive_h264_aac === true,
      native_hls:
        (input.live === true || input.compatibility === true) &&
        input.native_hls === true,
      mse_h264_aac:
        (dashPlayback || input.compatibility === true || input.live === true) &&
        input.mse_h264_aac,
    },
    native_platform: {
      version: 1,
      ...(input.compatibility
        ? {
            compatibility: {
              version: 1,
              mode: input.compatibility_ladder
                ? ("hls_avc_aac_ladder" as const)
                : ("hls_avc_aac" as const),
            },
          }
        : {}),
      ...(input.course ? { course_version: 1 } : {}),
      ...(input.live ? { live_version: bilibili ? 1 : 2 } : {}),
      credential_mode: input.credential_mode,
      ...(input.credential_mode !== "anonymous" && input.account_id
        ? { account_id: input.account_id }
        : {}),
      ...(!input.live &&
      input.max_height &&
      input.max_height !== "auto" &&
      (provider === "bilibili" || provider === "youtube") &&
      input.media_id
        ? {
            quality: {
              version: 1,
              provider,
              media_id: input.media_id,
              max_height: input.max_height,
            },
          }
        : {}),
    },
  };
}

const qualityHeights: Record<NativePlatformMaxHeight, number> = {
  auto: 4320,
  p144: 144,
  p240: 240,
  p360: 360,
  p480: 480,
  p720: 720,
  p1080: 1080,
  p1440: 1440,
  p2160: 2160,
  p4320: 4320,
};
export function validNativePlatformQuality(
  request: PlaybackRequest,
  plan: PlaybackPlan,
): boolean {
  const intent = request.native_platform?.quality,
    quality = plan.native_platform?.quality;
  if (
    intent &&
    (intent.version !== 1 ||
      intent.provider !== plan.native_platform?.provider ||
      intent.media_id !== plan.media_id ||
      !Object.hasOwn(qualityHeights, intent.max_height))
  )
    return false;
  if (!quality) return !intent;
  if (
    quality.version !== 1 ||
    !["bilibili", "youtube"].includes(plan.native_platform!.provider) ||
    quality.requested_max_height !== (intent?.max_height ?? "auto") ||
    !Object.hasOwn(qualityHeights, quality.requested_max_height) ||
    !Number.isInteger(quality.selected_height) ||
    quality.selected_height < 1 ||
    quality.selected_height > qualityHeights[quality.requested_max_height] ||
    !Array.isArray(quality.options) ||
    !quality.options.length ||
    quality.options.length > 9
  )
    return false;
  const seen = new Set<string>();
  let previous = 0;
  for (const option of quality.options) {
    if (
      !option ||
      option.max_height === "auto" ||
      !Object.hasOwn(qualityHeights, option.max_height) ||
      seen.has(option.max_height) ||
      !Number.isInteger(option.height) ||
      option.height <= previous ||
      option.height > qualityHeights[option.max_height] ||
      Object.values(qualityHeights).some(
        (height) =>
          height < qualityHeights[option.max_height] && option.height <= height,
      )
    )
      return false;
    seen.add(option.max_height);
    previous = option.height;
  }
  return true;
}

/** The MP4 route uses the same RainSync session grant as DASH.
 * Reject aliases before URL parsing, and never attach upstream/CDN URLs. */
export function validNativeProgressiveUrl(
  playbackUrl: string,
  sessionId: string,
  origin: string,
): boolean {
  try {
    const base = new URL(origin);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.origin !== origin ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        sessionId,
      ) ||
      typeof playbackUrl !== "string" ||
      !playbackUrl ||
      playbackUrl.length > 2048 ||
      /[\s\\%#]/.test(playbackUrl) ||
      playbackUrl.startsWith("//") ||
      (!playbackUrl.startsWith("/") && !/^https?:\/\//.test(playbackUrl)) ||
      /\/(?:\.|\.\.)(?:\/|\?)/.test(playbackUrl)
    )
      return false;
    const url = new URL(playbackUrl, origin);
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname ===
        `/api/v1/platform-delivery/${sessionId}/tracks/progressive` &&
      /^\?token=[A-Za-z0-9_-]{16,512}$/.test(url.search)
    );
  } catch {
    return false;
  }
}

export function validNativePlatformPlan(
  request: PlaybackRequest,
  plan: PlaybackPlan,
  origin: string,
  provider: NativePlatformProvider = "bilibili",
  broadcastId?: string,
  course = false,
): boolean {
  const binding = plan.native_platform;
  try {
    // Server chooses a transport from this exact capability snapshot. A bad
    // DASH response must fail closed, never become a client-side MP4 fallback.
    const livePlayback =
      request.native_platform?.live_version ===
        (provider === "bilibili" ? 1 : 2) &&
      binding?.live?.version === request.native_platform?.live_version &&
      plan.transport === "hls" &&
      (request.capabilities?.mse_h264_aac === true ||
        request.capabilities?.native_hls === true) &&
      validNativeLiveBinding(binding?.live) &&
      (!broadcastId || binding!.live!.broadcast_id === broadcastId) &&
      request.position_ms === 0 &&
      plan.duration_ms === null &&
      Array.isArray(plan.seekable_media_ranges_ms) &&
      plan.seekable_media_ranges_ms.length === 0 &&
      !request.native_platform.quality &&
      !binding!.quality &&
      validNativeLiveDeliveryUrl(
        plan.playback_url,
        plan.session_id,
        origin,
        true,
        binding!.live!.version,
      );
    if (
      (binding?.live ||
        broadcastId ||
        request.native_platform?.live_version !== undefined) &&
      !livePlayback
    )
      return false;
    const dashPlayback =
      plan.transport === "dash" &&
      (provider === "bilibili" || provider === "youtube") &&
      request.capabilities?.mse_h264_aac === true;
    const progressivePlayback =
      plan.transport === "progressive" &&
      provider !== "bilibili" &&
      request.capabilities?.progressive_h264_aac === true;
    const compatibilityPlayback = validNativeCompatibilityPlan(
      request,
      plan,
      origin,
    );
    return (
      ["bilibili", "douyin", "tiktok", "youtube"].includes(provider) &&
      !!request.native_platform &&
      request.native_platform.version === 1 &&
      ["own_or_anonymous", "anonymous"].includes(
        request.native_platform.credential_mode,
      ) &&
      (livePlayback ||
        (request.native_platform.compatibility
          ? compatibilityPlayback
          : dashPlayback || progressivePlayback)) &&
      !!binding &&
      binding.version === 1 &&
      binding.provider === provider &&
      (course
        ? provider === "bilibili" &&
          request.native_platform.course_version === 1 &&
          binding.course_version === 1
        : request.native_platform.course_version === undefined &&
          binding.course_version === undefined) &&
      (request.native_platform.compatibility
        ? !!binding.compatibility && !binding.live
        : binding.compatibility === undefined) &&
      validNativePlatformQuality(request, plan) &&
      ["own_account", "anonymous"].includes(binding.credential_mode) &&
      (request.native_platform.credential_mode !== "anonymous" ||
        binding.credential_mode === "anonymous") &&
      (!request.native_platform.account_id ||
        binding.credential_mode === "own_account") &&
      !Object.hasOwn(binding, "account_id") &&
      (!Object.hasOwn(request.native_platform, "account_id") ||
        (request.native_platform.credential_mode === "own_or_anonymous" &&
          typeof request.native_platform.account_id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            request.native_platform.account_id,
          ))) &&
      Number.isInteger(binding.refresh_after_seconds) &&
      binding.refresh_after_seconds >= 1 &&
      Number.isInteger(plan.expires_in_seconds) &&
      plan.expires_in_seconds >= 1 &&
      binding.refresh_after_seconds < plan.expires_in_seconds &&
      plan.media_generation === request.media_generation &&
      plan.plan_generation === request.plan_generation &&
      (compatibilityPlayback
        ? true
        : plan.delivery_mode === "direct" &&
          plan.timeline_origin_ms === 0 &&
          !plan.rebuild_on_seek &&
          !plan.pending_job_id) &&
      !plan.selected_candidate_id &&
      !plan.upstream_profile &&
      plan.http_file_fallback_version === undefined &&
      plan.static_hls_fallback_version === undefined &&
      !plan.decoder_fallback_modes?.length &&
      !plan.audio_tracks.length &&
      !plan.subtitle_tracks.length &&
      (livePlayback || compatibilityPlayback
        ? true
        : dashPlayback
          ? !!createPlatformDashFence({
              sessionId: plan.session_id,
              playbackUrl: plan.playback_url,
              origin,
            })
          : validNativeProgressiveUrl(
              plan.playback_url,
              plan.session_id,
              origin,
            ))
    );
  } catch {
    return false;
  }
}
