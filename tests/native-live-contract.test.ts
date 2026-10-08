import { expect, it } from "vitest";
import {
  nativePlatformRequest,
  validNativePlatformPlan,
} from "../apps/web/src/features/playback/native-platform-intent";
import {
  nativeLiveDirective,
  nativeLiveEdge,
  validNativeLiveDeliveryUrl,
  validNativeLiveBinding,
} from "../apps/web/src/features/playback/native-live";
import {
  ordinaryPlatformLink,
  validNativePlatformMetadata,
  validatePlatformImportPreview,
  validatePlatformImportBatch,
} from "../apps/web/src/features/rooms/platform-import";
import { target } from "../packages/sync-engine";
import type { PlaybackPlan, RoomState } from "../packages/protocol";
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const live = {
  version: 1,
  broadcast_id: "12:34:1700000000",
  sync_mode: "live_edge_control",
} as const;
const room = {
  room_id: id(1),
  revision: 1,
  media_id: id(2),
  media_generation: 3,
  playback_status: "playing",
  anchor_position_ms: 0,
  anchor_server_time_ms: 100,
  playback_rate: 1,
  duration_ms: null,
  controller_user_id: id(4),
  clock_epoch: id(5),
  live,
} satisfies RoomState;
const request = () =>
  nativePlatformRequest({
    viewer_id: id(6),
    plan_generation: 7,
    idempotency_key: id(8),
    room_id: room.room_id,
    media_generation: room.media_generation,
    position_ms: 99999,
    credential_mode: "anonymous",
    provider: "bilibili",
    media_id: room.media_id!,
    mse_h264_aac: true,
    native_hls: true,
    live: true,
  });
const plan = (): PlaybackPlan => ({
  session_id: id(9),
  media_id: room.media_id!,
  media_generation: 3,
  plan_generation: 7,
  delivery_mode: "direct",
  transport: "hls",
  playback_url: `/api/v1/platform-live-delivery/${id(9)}/playlist.m3u8?token=${"a".repeat(64)}`,
  timeline_origin_ms: 0,
  duration_ms: null,
  expires_in_seconds: 120,
  rebuild_on_seek: false,
  audio_tracks: [],
  subtitle_tracks: [],
  seekable_media_ranges_ms: [],
  native_platform: {
    version: 1,
    provider: "bilibili",
    credential_mode: "anonymous",
    refresh_after_seconds: 30,
    live,
  },
});

it("negotiates live explicitly; null duration alone never enables it", () => {
  const body = request(),
    p = plan();
  expect(body.position_ms).toBe(0);
  expect(body.native_platform?.live_version).toBe(1);
  expect(
    validNativePlatformPlan(
      body,
      p,
      "https://rain.test",
      "bilibili",
      live.broadcast_id,
    ),
  ).toBe(true);
  delete body.native_platform!.live_version;
  expect(
    validNativePlatformPlan(body, p, "https://rain.test", "bilibili"),
  ).toBe(false);
  expect(
    validNativePlatformPlan(
      request(),
      { ...p, native_platform: { ...p.native_platform!, live: undefined } },
      "https://rain.test",
      "bilibili",
    ),
  ).toBe(false);
  for (const patch of [
    { duration_ms: 1 },
    { timeline_origin_ms: 1 },
    { rebuild_on_seek: true },
    { seekable_media_ranges_ms: [{ start_ms: 0, end_ms: 100 }] },
    { transport: "dash" },
  ])
    expect(
      validNativePlatformPlan(
        request(),
        { ...p, ...patch },
        "https://rain.test",
        "bilibili",
      ),
    ).toBe(false);
  expect(
    validNativePlatformPlan(
      request(),
      p,
      "https://rain.test",
      "bilibili",
      "12:34:1700000001",
    ),
  ).toBe(false);
});

it("fences every private HLS request to exact same origin and session", () => {
  const p = plan(),
    base = p.playback_url;
  expect(
    validNativeLiveDeliveryUrl(base, p.session_id, "https://rain.test", true),
  ).toBe(true);
  expect(
    validNativeLiveDeliveryUrl(
      base.replace("playlist.m3u8", `segments/${"b".repeat(64)}`),
      p.session_id,
      "https://rain.test",
    ),
  ).toBe(true);
  for (const bad of [
    `https://cdn.test${base}`,
    base.replace(id(9), id(10)),
    base + "&x=1",
    base.replace("token=", "token=%61"),
    base + "#x",
    "//rain.test" + base,
    base.replace("playlist.m3u8", "../playlist.m3u8"),
    base.replace("playlist.m3u8", "segments/upstream.ts"),
    base.replace("playlist.m3u8", "segments/" + "b".repeat(63)),
  ])
    expect(
      validNativeLiveDeliveryUrl(bad, p.session_id, "https://rain.test"),
    ).toBe(false);
});

it("pause/resume and offline/generation changes use edge controls, never VOD alignment", () => {
  const p = plan(),
    args = { room, plan: p, active: true, connected: true, ended: false };
  expect(target(room, 1e12)).toBe(0);
  expect(
    target({ ...room, live: undefined, anchor_position_ms: 1000 }, 1000),
  ).toBe(1900);
  expect(nativeLiveDirective(args)).toBe("play_edge");
  expect(
    nativeLiveDirective({
      ...args,
      room: { ...room, playback_status: "paused" },
    }),
  ).toBe("pause");
  expect(nativeLiveDirective({ ...args, connected: false })).toBe("wait");
  expect(nativeLiveDirective({ ...args, ended: true })).toBe("offline");
  expect(nativeLiveDirective({ ...args, active: false })).toBe("stale");
  expect(
    nativeLiveDirective({ ...args, room: { ...room, media_generation: 4 } }),
  ).toBe("stale");
  expect(
    nativeLiveDirective({
      ...args,
      room: { ...room, live: { ...live, broadcast_id: "12:34:1700000001" } },
    }),
  ).toBe("stale");
  expect(
    nativeLiveEdge([
      [100, 110],
      [120, 130],
    ]),
  ).toBe(127);
  expect(nativeLiveEdge([[120, 130]], 125)).toBe(125);
  expect(nativeLiveEdge([[120, 130]], 99)).toBe(127);
  expect(nativeLiveEdge([])).toBeUndefined();
});

it("imports only bounded exact live identities with explicit receipt opt-in", () => {
  expect(ordinaryPlatformLink("https://live.bilibili.com/blanc/12/")).toEqual({
    provider: "bilibili",
    url: "https://live.bilibili.com/12",
    part: 1,
    live_version: 1,
  });
  for (const url of [
    "https://live.bilibili.com/12?",
    "https://live.bilibili.com/12?a=1",
    "https://live.bilibili.com/0",
    "https://live.bilibili.com/9223372036854775808",
    "https://live.bilibili.com/a/../12",
    "https://live.bilibili.com/%31%32",
    "https://evil.test/12",
  ])
    expect(() => ordinaryPlatformLink(url)).toThrow();
  const platform = {
    version: 3,
    provider: "bilibili",
    content_id: `live:12:${live.broadcast_id}`,
    part: 1,
    resource: {
      kind: "bilibili_live",
      room_id: "12",
      uid: "34",
      broadcast_id: live.broadcast_id,
    },
  };
  expect(validNativePlatformMetadata(platform)).toBe(true);
  expect(
    validNativePlatformMetadata({
      ...platform,
      resource: { ...platform.resource, uid: "35" },
    }),
  ).toBe(false);
  expect(validNativeLiveBinding({ ...live, frame_aligned: true })).toBe(false);
  const item = {
    key: "f".repeat(64),
    provider: "bilibili" as const,
    url: "https://live.bilibili.com/12",
    part: 1,
    title: "Live",
    live_version: 1 as const,
  };
  const preview = { items: [item], failures: [], truncated: false, limit: 20 };
  expect(validatePlatformImportPreview(preview).items[0].live_version).toBe(1);
  expect(() =>
    validatePlatformImportPreview({
      ...preview,
      items: [{ ...item, live_version: undefined }],
    }),
  ).toThrow();
  const selected = [item];
  const value = {
    outcomes: [
      {
        key: item.key,
        media: {
          id: id(2),
          kind: "native_platform",
          title: "Live",
          platform,
          duration_ms: null,
        },
      },
    ],
    stopped: null,
  };
  expect(
    validatePlatformImportBatch(value, selected).outcomes[0].media?.id,
  ).toBe(id(2));
  expect(() =>
    validatePlatformImportBatch(
      {
        ...value,
        outcomes: [
          {
            key: item.key,
            media: { ...value.outcomes[0].media, duration_ms: 500 },
          },
        ],
      },
      selected,
    ),
  ).toThrow();
});
