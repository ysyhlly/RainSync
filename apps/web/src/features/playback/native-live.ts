import type {
  NativePlatformLiveBinding,
  PlaybackPlan,
  RoomState,
} from "../../../../../packages/protocol";

export function validNativeLiveBinding(
  value: unknown,
): value is NativePlatformLiveBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const live = value as Record<string, unknown>;
  return (
    Object.keys(live).sort().join(",") === "broadcast_id,sync_mode,version" &&
    (live.version === 1 || live.version === 2) &&
    live.sync_mode === "live_edge_control" &&
    typeof live.broadcast_id === "string" &&
    live.broadcast_id.length <= 64 &&
    (live.version === 2 ? /^[a-f0-9]{64}$/.test(live.broadcast_id) :
    /^[1-9]\d{0,18}:[1-9]\d{0,18}:[1-9]\d{0,18}$/.test(live.broadcast_id) &&
    live.broadcast_id
      .split(":")
      .every((part) => BigInt(part) <= 9223372036854775807n))
  );
}

/** Same-origin, exact-session proxy URLs only, including every HLS subrequest. */
export function validNativeLiveDeliveryUrl(
  raw: string,
  session: string,
  origin: string,
  playlistOnly = false,
  version = 1,
): boolean {
  try {
    if (
      new URL(origin).origin !== origin ||
      !/^https?:\/\//.test(origin) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(session) ||
      typeof raw !== "string" ||
      !raw ||
      raw.length > 2048 ||
      /[\s\\%#]/.test(raw) ||
      raw.startsWith("//") ||
      (!raw.startsWith("/") && !/^https?:\/\//.test(raw)) ||
      /\/(?:\.|\.\.)(?:\/|\?|$)/.test(raw)
    )
      return false;
    const url = new URL(raw, origin),
      root = version === 1 ? `/api/v1/platform-live-delivery/${session}`
        : version === 2 ? `/api/v1/platform-other-live-delivery/${session}` : "";
    return (
      !!root && url.origin === origin &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^\?token=[a-f0-9]{64}$/.test(url.search) &&
      (url.pathname === `${root}/playlist.m3u8` ||
        (!playlistOnly &&
          new RegExp(`^${root}/segments/[a-f0-9]{64}$`).test(url.pathname)))
    );
  } catch {
    return false;
  }
}

export function liveRoomMatchesPlan(
  room: RoomState,
  plan: PlaybackPlan,
): boolean {
  return (
    !!room.live &&
    validNativeLiveBinding(room.live) &&
    validNativeLiveBinding(plan.native_platform?.live) &&
    room.live.broadcast_id === plan.native_platform!.live!.broadcast_id &&
    room.live.version === plan.native_platform!.live!.version &&
    room.media_id === plan.media_id &&
    room.media_generation === plan.media_generation
  );
}

/** A decoder-local edge is not a shared absolute room position. */
export function nativeLiveEdge(
  ranges: readonly (readonly [number, number])[],
  syncPosition?: number,
): number | undefined {
  const valid = ranges.filter(
    ([start, end]) =>
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start,
  );
  const last = valid.at(-1);
  if (!last) return;
  if (
    syncPosition !== undefined &&
    Number.isFinite(syncPosition) &&
    valid.some(([start, end]) => syncPosition >= start && syncPosition < end)
  )
    return syncPosition;
  const [start, end] = last;
  return Math.max(start, end - Math.min(3, (end - start) / 2));
}

export function nativeLiveDirective(input: {
  room: RoomState;
  plan: PlaybackPlan;
  active: boolean;
  connected: boolean;
  ended: boolean;
}): "stale" | "offline" | "pause" | "play_edge" | "wait" {
  if (!input.active || !liveRoomMatchesPlan(input.room, input.plan))
    return "stale";
  if (input.ended) return "offline";
  if (input.room.playback_status !== "playing") return "pause";
  return input.connected ? "play_edge" : "wait";
}
