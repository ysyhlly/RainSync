import { describe, it, expect } from "vitest";
import {
  parseActivity,
  parseTimelinePage,
  mergeTimeline,
  displayedComments,
  type TimelineComment,
} from "../apps/web/src/features/rooms/timeline-chat";
import {
  parsePlatformDanmaku,
  visiblePlatformDanmaku,
} from "../apps/web/src/features/playback/platform-text";
const activity = "00000000-0000-4000-8000-000000000001",
  user = "00000000-0000-4000-8000-000000000002";
const message: TimelineComment = {
  id: "00000000-0000-4000-8000-000000000003",
  user_id: user,
  activity_id: activity,
  body: "safe <script>text",
  username: "u",
  display_name: "User",
  created_at: 1000,
  media_time_ms: 2000,
  anchor_source: "client_reported",
  deleted: false,
};
describe("timeline activity, replay and tombstones", () => {
  it("rejects wrong activity and invalid coordinates", () => {
    expect(
      parseActivity({
        id: activity,
        media_id: activity,
        media_generation: 1,
        lifecycle_epoch: 1,
        versioned: true,
      }),
    ).toBeTruthy();
    for (const patch of [
      { media_time_ms: -1 },
      { media_time_ms: Infinity },
      { media_time_ms: 0.5 },
      { activity_id: user },
      { anchor_source: "trusted_sync_metric" },
    ])
      expect(() =>
        parseTimelinePage(
          {
            items: [{ ...message, ...patch }],
            next_before: null,
            next_after: null,
          },
          activity,
        ),
      ).toThrow();
  });
  it("deduplicates replays and lets deletion replace cached body", () => {
    const merged = mergeTimeline(
      [message],
      [{ ...message, body: "", deleted: true }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe("");
    expect(merged[0].deleted).toBe(true);
    expect(() =>
      parseTimelinePage(
        {
          items: [{ ...message, deleted: true }],
          next_before: null,
          next_after: null,
        },
        activity,
      ),
    ).toThrow();
  });
  it("spoiler hiding is opt-in display and rewind updates it", () => {
    expect(displayedComments([message], 1000, true, true)).toEqual([]);
    expect(displayedComments([message], 3000, true, true)).toEqual([message]);
    expect(displayedComments([message], 1000, false, false)).toEqual([message]);
  });
});
describe("closed advanced danmaku", () => {
  const position = {
    x_permyriad: 1000,
    y_permyriad: 2000,
    to_x_permyriad: 9000,
    to_y_permyriad: 8000,
    duration_ms: 10000,
    move_duration_ms: 5000,
    move_delay_ms: 500,
    opacity_from_permille: 1000,
    opacity_to_permille: 500,
    rotation_z_deg: 45,
  };
  const cue = {
    at_ms: 1000,
    text: "<svg onload=alert(1)>plain",
    mode: "positioned",
    position,
    style: { color_rgb: 0xff8800, font_size_px: 36 },
  };
  it("accepts only numeric styles/normalized finite moves and bounds lifetime", () => {
    const parsed = parsePlatformDanmaku({ snapshot: true, cues: [cue] });
    expect(parsed[0]).toEqual(cue);
    expect(visiblePlatformDanmaku(parsed, 8000)).toHaveLength(1);
    expect(visiblePlatformDanmaku(parsed, 11000)).toEqual([]);
    expect(visiblePlatformDanmaku(parsed, 500)).toEqual([]);
  });
  it("rejects injection, unsupported fields, perspective and invalid motion data", () => {
    for (const patch of [
      { style: { color_rgb: "red;position:fixed", font_size_px: 20 } },
      { style: { color_rgb: 0xffffff, font_size_px: 100 } },
      {
        style: {
          color_rgb: 0xffffff,
          font_size_px: 20,
          url: "https://example.test",
        },
      },
      { position: { ...position, x_permyriad: 10001 } },
      {
        position: { ...position, move_duration_ms: 10000, move_delay_ms: 1000 },
      },
      { position: { ...position, rotation_y_deg: 45 } },
      { mode: "script" },
      { advanced_unsupported: true },
    ])
      expect(() =>
        parsePlatformDanmaku({ snapshot: true, cues: [{ ...cue, ...patch }] }),
      ).toThrow();
  });
  it("keeps explicit plain fallback for unsupported advanced data", () => {
    expect(
      parsePlatformDanmaku({
        snapshot: true,
        cues: [
          {
            at_ms: 0,
            text: "fallback",
            mode: "top",
            advanced_unsupported: true,
          },
        ],
      }),
    ).toHaveLength(1);
    expect(
      visiblePlatformDanmaku(
        Array.from({ length: 100 }, (_, i) => ({ ...cue, at_ms: i })),
        1000,
      ).length,
    ).toBeLessThanOrEqual(4);
  });
});
