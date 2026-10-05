import {
  validNativeLiveBinding,
  validNativeLiveDeliveryUrl,
} from "./native-live";
import type { PlaybackPlan } from "../../../../../packages/protocol";
export type PlatformTextStatus =
  | "idle"
  | "loading"
  | "available"
  | "none"
  | "login_required"
  | "unsupported"
  | "failed";
export type PlatformSubtitleTrack = {
  id: string;
  language: string;
  label: string;
  automatic: boolean;
};
export type PlatformDanmakuCue = {
  at_ms: number;
  text: string;
  mode: "scroll" | "top" | "bottom" | "positioned";
  style?: { color_rgb: number; font_size_px: number };
  position?: {
    x_permyriad: number;
    y_permyriad: number;
    to_x_permyriad: number;
    to_y_permyriad: number;
    duration_ms: number;
    move_duration_ms: number;
    move_delay_ms: number;
    opacity_from_permille: number;
    opacity_to_permille: number;
    rotation_z_deg: number;
  };
  advanced_unsupported?: true;
};
export const MAX_PLATFORM_TEXT_BYTES = 2 * 1024 * 1024;
const plain = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  [...value].length <= max &&
  !/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const availability = (value: unknown): value is PlatformTextStatus =>
  ["available", "none", "login_required", "unsupported"].includes(
    value as string,
  );
/** Never derive a fetch URL from upstream metadata. The exact same-origin
 * immutable grant supplies the session and opaque token only. */
export function platformTextBase(
  plan: PlaybackPlan,
  origin: string,
): string | undefined {
  try {
    if (
      !plan.native_platform ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(plan.session_id) ||
      typeof plan.playback_url !== "string" ||
      /[\\\s%#]/.test(plan.playback_url) ||
      plan.playback_url.startsWith("//") ||
      plan.playback_url
        .split("?")[0]
        .split("/")
        .some((part) => part === "." || part === "..")
    )
      return;
    const url = new URL(plan.playback_url, origin);
    if (plan.native_platform.live) {
      if (plan.native_platform.live.version !== 1) return;
      if (
        !validNativeLiveBinding(plan.native_platform.live) ||
        !validNativeLiveDeliveryUrl(
          plan.playback_url,
          plan.session_id,
          origin,
          true,
        )
      )
        return;
      return `/platform-live-delivery/${plan.session_id}/text?token=${url.searchParams.get("token")}`;
    }
    const compatibility = plan.native_platform.compatibility;
    const token = url.searchParams.get("token");
    const compatibleText =
      !!compatibility?.output &&
      plan.transport === "hls" &&
      plan.delivery_mode === "transcode" &&
      plan.rebuild_on_seek &&
      Number.isFinite(plan.timeline_origin_ms) &&
      plan.timeline_origin_ms >= 0 &&
      Number.isSafeInteger(compatibility.output.attempt) &&
      compatibility.output.attempt > 0 &&
      url.pathname ===
        `/api/v1/platform-delivery/${plan.session_id}/compatibility/${compatibility.mode === "hls_avc_aac_ladder" ? "master" : "index"}.m3u8` &&
      url.search === `?token=${token}&attempt=${compatibility.output.attempt}`;
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !/^[a-f0-9]{64}$/.test(token ?? "") ||
      (compatibility
        ? !compatibleText
        : !/^\?token=[a-f0-9]{64}$/.test(url.search) ||
          ![
            `/api/v1/platform-delivery/${plan.session_id}/manifest.mpd`,
            `/api/v1/platform-delivery/${plan.session_id}/tracks/progressive`,
          ].includes(url.pathname))
    )
      return;
    return `/platform-delivery/${plan.session_id}/text?token=${token}`;
  } catch {
    return;
  }
}
/** Other live providers may expose decoder-observed in-band captions while
 * their remote subtitle/chat API remains unsupported. Validate the exact grant
 * before observing any text; do not synthesize a server text endpoint. */
export function platformInbandLive(plan: PlaybackPlan, origin: string) {
  try {
    const live = plan.native_platform?.live;
    if (
      !live ||
      !validNativeLiveBinding(live) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(plan.session_id) ||
      /[\\\s%#]/.test(plan.playback_url) ||
      plan.playback_url.startsWith("//") ||
      plan.playback_url
        .split("?")[0]
        .split("/")
        .some((part) => part === "." || part === "..")
    )
      return false;
    const url = new URL(plan.playback_url, origin);
    const namespace =
      live.version === 1
        ? "platform-live-delivery"
        : live.version === 2 &&
            ["youtube", "douyin", "tiktok"].includes(
              plan.native_platform!.provider,
            )
          ? "platform-other-live-delivery"
          : undefined;
    return (
      !!namespace &&
      validNativeLiveDeliveryUrl(
        plan.playback_url,
        plan.session_id,
        origin,
        true,
        live.version,
      ) &&
      url.origin === origin &&
      !url.username &&
      !url.password &&
      url.pathname ===
        `/api/v1/${namespace}/${plan.session_id}/playlist.m3u8` &&
      /^\?token=[a-f0-9]{64}$/.test(url.search)
    );
  } catch {
    return false;
  }
}
export function parsePlatformTextCatalog(value: unknown) {
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    !Array.isArray(value.subtitle_tracks) ||
    value.subtitle_tracks.length > 64 ||
    !availability(value.subtitles_status) ||
    !availability(value.danmaku_status)
  )
    throw new TypeError("平台字幕列表无效");
  const ids = new Set<string>();
  const tracks = value.subtitle_tracks.map((track): PlatformSubtitleTrack => {
    if (
      !object(track) ||
      Object.keys(track).length !== 4 ||
      typeof track.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(track.id) ||
      ids.has(track.id) ||
      typeof track.language !== "string" ||
      !/^[A-Za-z0-9_-]{1,48}$/.test(track.language) ||
      !plain(track.label, 80) ||
      typeof track.automatic !== "boolean"
    )
      throw new TypeError("平台字幕列表无效");
    ids.add(track.id);
    return {
      id: track.id,
      language: track.language,
      label: track.label,
      automatic: track.automatic,
    };
  });
  if ((value.subtitles_status === "available") !== tracks.length > 0)
    throw new TypeError("平台字幕列表无效");
  return {
    tracks,
    subtitleStatus: value.subtitles_status,
    danmakuStatus: value.danmaku_status,
  };
}
export function parsePlatformDanmaku(value: unknown): PlatformDanmakuCue[] {
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    value.snapshot !== true ||
    !Array.isArray(value.cues) ||
    value.cues.length > 20_000
  )
    throw new TypeError("原站弹幕数据无效");
  let last = -1,
    second = -1,
    density = 0;
  return value.cues.map((cue): PlatformDanmakuCue => {
    if (
      !object(cue) ||
      Object.keys(cue).some(
        (key) =>
          ![
            "at_ms",
            "text",
            "mode",
            "style",
            "position",
            "advanced_unsupported",
          ].includes(key),
      ) ||
      typeof cue.at_ms !== "number" ||
      !Number.isSafeInteger(cue.at_ms) ||
      cue.at_ms < 0 ||
      cue.at_ms > 604_800_000 ||
      cue.at_ms < last ||
      !plain(cue.text, 160) ||
      !["scroll", "top", "bottom", "positioned"].includes(cue.mode as string)
    )
      throw new TypeError("原站弹幕数据无效");
    const integer = (v: unknown, min: number, max: number): v is number =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
    if (
      cue.style !== undefined &&
      (!object(cue.style) ||
        Object.keys(cue.style).length !== 2 ||
        !integer(cue.style.color_rgb, 0, 0xffffff) ||
        !integer(cue.style.font_size_px, 12, 48))
    )
      throw new TypeError("原站弹幕样式无效");
    if ((cue.mode === "positioned") !== (cue.position !== undefined))
      throw new TypeError("原站弹幕定位无效");
    if (cue.position !== undefined) {
      const p = cue.position;
      if (
        !object(p) ||
        Object.keys(p).length !== 10 ||
        ![
          "x_permyriad",
          "y_permyriad",
          "to_x_permyriad",
          "to_y_permyriad",
        ].every((k) => integer(p[k], 0, 10000)) ||
        !integer(p.duration_ms, 1, 12000) ||
        !integer(p.move_duration_ms, 0, 12000) ||
        !integer(p.move_delay_ms, 0, 12000) ||
        p.move_delay_ms + p.move_duration_ms > p.duration_ms ||
        !integer(p.opacity_from_permille, 0, 1000) ||
        !integer(p.opacity_to_permille, 0, 1000) ||
        !integer(p.rotation_z_deg, -360, 360)
      )
        throw new TypeError("原站弹幕定位无效");
    }
    if (
      cue.advanced_unsupported !== undefined &&
      (cue.advanced_unsupported !== true ||
        cue.position !== undefined ||
        cue.mode !== "top")
    )
      throw new TypeError("原站弹幕降级数据无效");
    last = cue.at_ms;
    const bucket = Math.floor(last / 1000);
    density = second === bucket ? density + 1 : 1;
    second = bucket;
    if (density > 6) throw new TypeError("原站弹幕过于密集");
    return {
      at_ms: last,
      text: cue.text,
      mode: cue.mode as PlatformDanmakuCue["mode"],
      ...(cue.style !== undefined
        ? { style: cue.style as PlatformDanmakuCue["style"] }
        : {}),
      ...(cue.position !== undefined
        ? { position: cue.position as PlatformDanmakuCue["position"] }
        : {}),
      ...(cue.advanced_unsupported === true
        ? { advanced_unsupported: true as const }
        : {}),
    };
  });
}
/** Live cues retain provider broadcast time and a bounded server receipt clock.
 * Decoder-local HLS time is mapped on arrival, never room seek/sync time. */
export function parsePlatformLiveDanmaku(
  value: unknown,
  startedMs: number,
  snapshot: boolean,
) {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    value.snapshot !== snapshot ||
    value.broadcast_started_ms !== startedMs ||
    typeof value.server_now_ms !== "number" ||
    !Number.isSafeInteger(value.server_now_ms) ||
    value.server_now_ms < startedMs ||
    value.server_now_ms > startedMs + 604800000
  )
    throw new TypeError("直播弹幕身份或时间无效");
  const cues = parsePlatformDanmaku({ snapshot: true, cues: value.cues });
  if (
    cues.some(
      (cue) =>
        startedMs + cue.at_ms > (value.server_now_ms as number) + 5000 ||
        startedMs + cue.at_ms < (value.server_now_ms as number) - 120000,
    )
  )
    throw new TypeError("直播弹幕时间无效");
  return { cues, nowMs: value.server_now_ms };
}
/** Accept only our sanitized VTT subset: timestamps and escaped plain text.
 * No cue IDs, settings, STYLE/REGION/NOTE blocks or embedded markup exist. */
export function parsePlatformVtt(
  vtt: string,
): { start: number; end: number; text: string }[] {
  if (
    new TextEncoder().encode(vtt).length > MAX_PLATFORM_TEXT_BYTES ||
    !vtt.startsWith("WEBVTT\n\n") ||
    vtt.includes("\r")
  )
    throw new TypeError("平台字幕数据无效");
  const blocks = vtt.slice(8).split("\n\n").filter(Boolean);
  if (blocks.length > 20_000) throw new TypeError("平台字幕数据过大");
  const time = (h: string, m: string, s: string, ms: string) =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  let last = -1;
  return blocks.map((block) => {
    const match =
      /^(\d{2,3}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2,3}):([0-5]\d):([0-5]\d)\.(\d{3})\n([^\n]+)$/.exec(
        block,
      );
    if (
      !match ||
      !plain(match[9], 12000) ||
      /[<>]/.test(match[9]) ||
      /&(?!amp;|lt;|gt;)/.test(match[9])
    )
      throw new TypeError("平台字幕数据无效");
    const start = time(match[1], match[2], match[3], match[4]),
      end = time(match[5], match[6], match[7], match[8]);
    if (start < last || end <= start || end > 604800)
      throw new TypeError("平台字幕时间无效");
    last = start;
    return { start, end, text: match[9] };
  });
}
export function visiblePlatformDanmaku(
  cues: readonly PlatformDanmakuCue[],
  timeMs: number,
) {
  if (!Number.isFinite(timeMs) || timeMs < 0) return [];
  // Binary search avoids scanning a long snapshot on every video frame.
  let lo = 0,
    hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].at_ms <= timeMs) lo = mid + 1;
    else hi = mid;
  }
  const lanes = new Set<string>(),
    visible = [];
  for (
    let index = lo - 1;
    index >= 0 && cues[index].at_ms > timeMs - 12000;
    index--
  ) {
    const cue = cues[index],
      lifetime = cue.position?.duration_ms ?? 6000,
      lane =
        index % (cue.mode === "scroll" ? 6 : cue.mode === "positioned" ? 4 : 2),
      key = `${cue.mode}:${lane}`;
    if (timeMs - cue.at_ms >= lifetime || lanes.has(key)) continue;
    lanes.add(key);
    visible.push({
      cue,
      lane,
      key: index,
      progress: (timeMs - cue.at_ms) / lifetime,
    });
    if (visible.length >= 10) break;
  }
  return visible;
}
