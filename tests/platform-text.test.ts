import { describe, expect, it } from "vitest";
import {
  parsePlatformTextCatalog,
  parsePlatformDanmaku,
  parsePlatformVtt,
  platformTextBase,
  platformInbandLive,
  visiblePlatformDanmaku,
} from "../apps/web/src/features/playback/platform-text";
import type { PlaybackPlan } from "../packages/protocol";
const session = "00000000-0000-4000-8000-000000000001",
  token = "a".repeat(64);
const plan = {
  session_id: session,
  native_platform: { version: 1 },
  playback_url: `/api/v1/platform-delivery/${session}/manifest.mpd?token=${token}`,
} as PlaybackPlan;
const track = {
  id: "ymen",
  language: "en",
  label: "English",
  automatic: false,
};
describe("closed platform text contracts", () => {
  it("uses only the existing same-origin immutable grant URL", () => {
    expect(platformTextBase(plan, "https://rainsync.test")).toBe(
      `/platform-delivery/${session}/text?token=${token}`,
    );
    for (const playback_url of [
      `https://evil.test${plan.playback_url}`,
      `//rainsync.test${plan.playback_url}`,
      plan.playback_url.replace("manifest.mpd", "text/catalog"),
      plan.playback_url + "&url=evil",
      plan.playback_url.replace(session, "other"),
      plan.playback_url.replace("manifest.mpd", "%6danifest.mpd"),
    ])
      expect(
        platformTextBase({ ...plan, playback_url }, "https://rainsync.test"),
      ).toBeUndefined();
    expect(
      platformTextBase(
        { ...plan, native_platform: undefined },
        "https://rainsync.test",
      ),
    ).toBeUndefined();
  });
  it("rejects raw URLs, ambiguous labels and forged catalog shape", () => {
    const catalog = {
      subtitle_tracks: [track],
      subtitles_status: "available",
      danmaku_status: "unsupported",
    };
    expect(parsePlatformTextCatalog(catalog).tracks).toEqual([track]);
    for (const value of [
      { ...catalog, url: "secret" },
      { ...catalog, subtitle_tracks: [{ ...track, url: "secret" }] },
      { ...catalog, subtitle_tracks: [track, track] },
      { ...catalog, subtitles_status: "none" },
      { ...catalog, subtitle_tracks: [{ ...track, id: "../evil" }] },
      { ...catalog, subtitle_tracks: [{ ...track, label: "line\nbreak" }] },
    ])
      expect(() => parsePlatformTextCatalog(value)).toThrow();
  });
  it("keeps escaped subtitle text without VTT block or style injection", () => {
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&lt;b&gt;Hi&lt;/b&gt; &amp; text\n\n";
    expect(parsePlatformVtt(vtt)).toEqual([
      { start: 1, end: 2, text: "&lt;b&gt;Hi&lt;/b&gt; &amp; text" },
    ]);
    for (const text of [
      "<script>x</script>",
      "STYLE\n::cue {color:red}",
      "REGION\nid:a",
      "unsafe&#x3c;text",
      "NOTE\nfoo",
    ])
      expect(() =>
        parsePlatformVtt(vtt.replace("&lt;b&gt;Hi&lt;/b&gt; &amp; text", text)),
      ).toThrow();
    expect(() => parsePlatformVtt(vtt.replace("02.000", "00.000"))).toThrow();
    expect(() =>
      parsePlatformVtt(vtt.replace("02.000", "02.000 line:50%")),
    ).toThrow();
  });
  it("validates plain bounded cue modes, time, ordering and density", () => {
    const cues = [
      { at_ms: 0, text: "<img src=x>", mode: "scroll" },
      { at_ms: 2000, text: "top", mode: "top" },
    ];
    expect(parsePlatformDanmaku({ cues, snapshot: true })).toEqual(cues);
    for (const cue of [
      { ...cues[0], mode: "script" },
      { ...cues[0], style: "color:red" },
      { ...cues[0], text: "x".repeat(161) },
      { ...cues[0], at_ms: -1 },
      { ...cues[0], at_ms: 0.2 },
    ])
      expect(() =>
        parsePlatformDanmaku({ cues: [cue], snapshot: true }),
      ).toThrow();
    expect(() =>
      parsePlatformDanmaku({ cues: [...cues].reverse(), snapshot: true }),
    ).toThrow();
    expect(() =>
      parsePlatformDanmaku({
        cues: Array.from({ length: 7 }, () => cues[0]),
        snapshot: true,
      }),
    ).toThrow();
  });
  it("uses the native video clock and a fixed active cue/lane bound across seeks", () => {
    const cues = Array.from({ length: 10000 }, (_, index) => ({
      at_ms: index * 200,
      text: "text",
      mode: "scroll" as const,
    }));
    expect(visiblePlatformDanmaku(cues, 0)).toHaveLength(1);
    const late = visiblePlatformDanmaku(cues, 1_000_000);
    expect(late.length).toBeLessThanOrEqual(6);
    expect(new Set(late.map((item) => item.lane)).size).toBe(late.length);
    expect(late.every((item) => item.progress >= 0 && item.progress < 1)).toBe(
      true,
    );
    expect(visiblePlatformDanmaku(cues, 0)).toHaveLength(1);
    expect(visiblePlatformDanmaku(cues, NaN)).toEqual([]);
  });
});

describe("episode and live text grants", () => {
  it("admits course plans through their exact immutable finite grant", () => {
    expect(
      platformTextBase(
        {
          ...plan,
          native_platform: { ...plan.native_platform, course_version: 1 },
        },
        "https://rainsync.test",
      ),
    ).toBe(`/platform-delivery/${session}/text?token=${token}`);
  });
  it("admits only exact Bili live broadcast and playlist grants", () => {
    const livePlan = {
      ...plan,
      native_platform: {
        ...plan.native_platform,
        live: {
          version: 1,
          sync_mode: "live_edge_control",
          broadcast_id: "123:456:1700000000",
        },
      },
      playback_url: `/api/v1/platform-live-delivery/${session}/playlist.m3u8?token=${token}`,
    } as PlaybackPlan;
    expect(platformTextBase(livePlan, "https://rainsync.test")).toBe(
      `/platform-live-delivery/${session}/text?token=${token}`,
    );
    expect(
      platformTextBase(
        {
          ...livePlan,
          playback_url: livePlan.playback_url + "&consent_client_id=1",
        },
        "https://rainsync.test",
      ),
    ).toBeUndefined();
    expect(
      platformTextBase(
        {
          ...livePlan,
          native_platform: {
            ...livePlan.native_platform,
            live: { ...livePlan.native_platform!.live!, broadcast_id: "wrong" },
          },
        },
        "https://rainsync.test",
      ),
    ).toBeUndefined();
  });
});

it("binds source text to an exact qualified ABR master, without output attempt authority", () => {
  const ladder = {
    ...plan,
    transport: "hls",
    delivery_mode: "transcode",
    rebuild_on_seek: true,
    timeline_origin_ms: 5000,
    native_platform: {
      ...plan.native_platform,
      compatibility: {
        version: 1,
        mode: "hls_avc_aac_ladder",
        output: {
          attempt: 4,
          complete: false,
          width: 1280,
          height: 720,
          codecs: "avc1.64001F,mp4a.40.2",
          renditions: [
            {
              id: "r1",
              width: 1280,
              height: 720,
              bandwidth: 2400000,
              codecs: "avc1.64001F,mp4a.40.2",
            },
          ],
        },
      },
    },
    playback_url: `/api/v1/platform-delivery/${session}/compatibility/master.m3u8?token=${token}&attempt=4`,
  } as PlaybackPlan;
  expect(platformTextBase(ladder, "https://rainsync.test")).toBe(
    `/platform-delivery/${session}/text?token=${token}`,
  );
  expect(
    platformTextBase(
      {
        ...ladder,
        playback_url: ladder.playback_url.replace("master", "index"),
      },
      "https://rainsync.test",
    ),
  ).toBeUndefined();
});

it("keeps other-live captions in-band only with exact namespace and current grant", () => {
  const other = {
    ...plan,
    native_platform: {
      version: 1,
      provider: "youtube",
      live: {
        version: 2,
        sync_mode: "live_edge_control",
        broadcast_id: "c".repeat(64),
      },
    },
    playback_url: `/api/v1/platform-other-live-delivery/${session}/playlist.m3u8?token=${token}`,
  } as PlaybackPlan;
  expect(platformTextBase(other, "https://rainsync.test")).toBeUndefined();
  expect(platformInbandLive(other, "https://rainsync.test")).toBe(true);
  expect(
    platformInbandLive(
      {
        ...other,
        playback_url: other.playback_url.replace(
          "platform-other-live-delivery",
          "platform-live-delivery",
        ),
      },
      "https://rainsync.test",
    ),
  ).toBe(false);
  expect(
    platformInbandLive(
      {
        ...other,
        playback_url: other.playback_url.replace("/api/", "/fake/../api/"),
      },
      "https://rainsync.test",
    ),
  ).toBe(false);
});
