export interface MediaActivity {
  id: string;
  media_id: string;
  media_generation: number;
  lifecycle_epoch: number;
  versioned: boolean;
  duration_ms?: number | null;
  created_at?: number;
}
export interface TimelineComment {
  id: string;
  user_id: string;
  activity_id: string;
  body: string;
  username: string;
  display_name: string;
  created_at: number;
  media_time_ms: number;
  anchor_source: "server_received" | "client_reported";
  deleted: boolean;
}
export const reactionEmoji = ["👏", "😂", "❤️", "😮", "🎉", "😢"] as const;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;
export function parseActivity(value: unknown): MediaActivity {
  if (
    !record(value) ||
    !uuid(value.id) ||
    !uuid(value.media_id) ||
    !integer(value.media_generation, 4294967295) ||
    !integer(value.lifecycle_epoch) ||
    typeof value.versioned !== "boolean" ||
    (value.duration_ms !== undefined &&
      value.duration_ms !== null &&
      (typeof value.duration_ms !== "number" ||
        !Number.isFinite(value.duration_ms) ||
        value.duration_ms < 0))
  )
    throw new TypeError("评论场次数据无效");
  return value as unknown as MediaActivity;
}
export function parseTimelinePage(value: unknown, activity: string) {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    (value.next_before !== null && !uuid(value.next_before)) ||
    (value.next_after !== null && !uuid(value.next_after))
  )
    throw new TypeError("评论分页数据无效");
  const ids = new Set<string>();
  const items = value.items.map((v): TimelineComment => {
    if (
      !record(v) ||
      !uuid(v.id) ||
      ids.has(v.id) ||
      !uuid(v.user_id) ||
      v.activity_id !== activity ||
      typeof v.body !== "string" ||
      [...v.body].length > 2000 ||
      typeof v.username !== "string" ||
      typeof v.display_name !== "string" ||
      !integer(v.created_at) ||
      !integer(v.media_time_ms, 604800000) ||
      !["server_received", "client_reported"].includes(
        v.anchor_source as string,
      ) ||
      typeof v.deleted !== "boolean" ||
      (v.deleted && v.body !== "")
    )
      throw new TypeError("评论内容数据无效");
    ids.add(v.id);
    return v as unknown as TimelineComment;
  });
  return {
    items,
    nextBefore: value.next_before as string | null,
    nextAfter: value.next_after as string | null,
  };
}
export function mergeTimeline(
  previous: readonly TimelineComment[],
  incoming: readonly TimelineComment[],
) {
  const comments = new Map(previous.map((m) => [m.id, m]));
  for (const m of incoming) comments.set(m.id, m);
  return [...comments.values()]
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
    .slice(-2000);
}
export function displayedComments(
  comments: readonly TimelineComment[],
  atMs: number,
  hideFuture: boolean,
  timeline: boolean,
) {
  const list = comments.filter((m) => !hideFuture || m.media_time_ms <= atMs);
  return timeline
    ? list.sort(
        (a, b) =>
          a.media_time_ms - b.media_time_ms || a.created_at - b.created_at,
      )
    : list;
}
export function timeLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
