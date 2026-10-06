import { describe, expect, it } from "vitest";
import {
  displayedComments,
  type TimelineComment,
} from "../apps/web/src/features/rooms/timeline-chat";
import {
  historicalCutoffMs,
  mergeTimelineWindow,
  TIMELINE_WINDOW_LIMIT,
} from "../apps/web/src/features/rooms/timeline-view-state";

const message = (index: number): TimelineComment => ({
  id: String(index).padStart(8, "0"),
  user_id: "viewer",
  activity_id: "activity",
  username: "viewer",
  display_name: "Viewer",
  body: `Comment ${index}`,
  created_at: index,
  media_time_ms: 60000,
  anchor_source: "client_reported",
  deleted: false,
});

describe("bounded timeline browsing windows", () => {
  it("keeps older pages reachable past 2000 rows instead of immediately evicting them", () => {
    const all = Array.from({ length: 2101 }, (_, index) => message(index));
    let window = all.slice(-100);
    for (let end = 2001; end > 0; end -= 100) {
      const incoming = all.slice(Math.max(0, end - 100), end);
      window = mergeTimelineWindow(window, incoming, "older");
      expect(window.length).toBeLessThanOrEqual(TIMELINE_WINDOW_LIMIT);
      for (const row of incoming)
        expect(window.some((m) => m.id === row.id)).toBe(true);
    }
    expect(window[0]).toEqual(all[0]);
    expect(window).toHaveLength(2000);
  });

  it("refreshes cached deletion state without moving a historical window", () => {
    const window = Array.from({ length: 2000 }, (_, index) => message(index));
    const deleted = { ...window[12], deleted: true, body: "" };
    const updated = mergeTimelineWindow(
      window,
      [deleted, message(2102)],
      "refresh",
    );
    expect(updated.map((m) => m.id)).toEqual(window.map((m) => m.id));
    expect(updated[12]).toEqual(deleted);
    expect(mergeTimelineWindow(updated, [window[12]], "older")[12]).toEqual(
      deleted,
    );
  });

  it("deduplicates overlapping pages and retains the latest live tail", () => {
    const window = Array.from({ length: 2000 }, (_, index) => message(index));
    const updated = mergeTimelineWindow(
      window,
      [message(1999), message(2000)],
      "latest",
    );
    expect(updated).toHaveLength(2000);
    expect(updated[0].created_at).toBe(1);
    expect(updated.at(-1)?.created_at).toBe(2000);
    expect(new Set(updated.map((m) => m.id)).size).toBe(2000);
  });
});

describe("independent historical spoiler cutoff", () => {
  it("requires an explicit valid history cutoff, including zero", () => {
    for (const value of [undefined, "", "120", NaN, Infinity, -1, 604801])
      expect(historicalCutoffMs(value)).toBeNull();
    expect(historicalCutoffMs(0)).toBe(0);
    expect(historicalCutoffMs(120)).toBe(120000);
    expect(
      displayedComments([message(1)], historicalCutoffMs(120)!, true, true),
    ).toHaveLength(1);
    expect(
      displayedComments([message(1)], historicalCutoffMs(30)!, true, true),
    ).toHaveLength(0);
  });
});
