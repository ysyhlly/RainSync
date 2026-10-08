import type { TimelineComment } from "./timeline-chat";

export const TIMELINE_WINDOW_LIMIT = 2000;

/** Older-page navigation owns its window; live refreshes only update its rows. */
export function mergeTimelineWindow(
  previous: readonly TimelineComment[],
  incoming: readonly TimelineComment[],
  mode: "latest" | "older" | "refresh",
) {
  const comments = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) {
    const cached = comments.get(message.id);
    if (mode === "refresh" && !cached) continue;
    // A delayed page must never restore a body after a deletion notification.
    comments.set(message.id, cached?.deleted ? cached : message);
  }
  const ordered = [...comments.values()].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  return mode === "latest"
    ? ordered.slice(-TIMELINE_WINDOW_LIMIT)
    : ordered.slice(0, TIMELINE_WINDOW_LIMIT);
}

/** An unchosen historical cutoff is deliberately not the playing film's time. */
export function historicalCutoffMs(seconds: unknown): number | null {
  return typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds >= 0 &&
    seconds <= 604800
    ? Math.round(seconds * 1000)
    : null;
}
