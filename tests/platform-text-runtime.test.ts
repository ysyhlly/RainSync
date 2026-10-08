import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, reactive, shallowRef } from "vue";
import { createPlatformTextRuntime } from "../apps/web/src/features/playback/platform-text-runtime";
import type { PlaybackPlan } from "../packages/protocol";
import type { useSession } from "../apps/web/src/features/auth/session.store";
const sessionId = "00000000-0000-4000-8000-000000000001";
const plan = {
  session_id: sessionId,
  media_id: "media-1",
  media_generation: 1,
  timeline_origin_ms: 0,
  native_platform: {
    version: 1,
    provider: "youtube",
    credential_mode: "anonymous",
  },
  playback_url: `/api/v1/platform-delivery/${sessionId}/manifest.mpd?token=${"a".repeat(64)}`,
} as PlaybackPlan;
const track = {
  id: "ymen",
  language: "en",
  label: "English",
  automatic: false,
};
const catalog = {
  subtitle_tracks: [track],
  subtitles_status: "available",
  danmaku_status: "available",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const scopes: ReturnType<typeof effectScope>[] = [];
function setup(
  api = vi.fn().mockResolvedValue(catalog),
  preferenceScope?: () => string | undefined,
) {
  vi.stubGlobal("location", { origin: "https://rainsync.test" });
  vi.stubGlobal(
    "VTTCue",
    class {
      constructor(
        public startTime: number,
        public endTime: number,
        public text: string,
      ) {}
    },
  );
  const cues: unknown[] = [];
  const textTrack = {
    mode: "disabled",
    // Match browsers that hide the cue list while disabled.
    get cues() {
      return this.mode === "disabled" ? null : cues;
    },
    addCue: vi.fn((cue: unknown) => cues.push(cue)),
    removeCue: vi.fn((cue: unknown) => cues.splice(cues.indexOf(cue), 1)),
  };
  const element = { addTextTrack: vi.fn(() => textTrack) };
  const session = reactive({ epoch: 0, api, invalidate: vi.fn() });
  const video = shallowRef(element as unknown as HTMLVideoElement),
    scope = effectScope();
  scopes.push(scope);
  const runtime = scope.run(() =>
    createPlatformTextRuntime({
      session: session as unknown as ReturnType<typeof useSession>,
      video,
      preferenceScope,
    }),
  )!;
  return { runtime, cues, textTrack, element, session, video, api };
}
afterEach(() => {
  scopes.splice(0).forEach((s) => s.stop());
  vi.unstubAllGlobals();
});
describe("platform text async ownership", () => {
  it("maps source subtitles and danmaku onto a compatibility seek origin without changing source authority", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\npast\n\n00:00:04.000 --> 00:00:06.000\nclip\n\n00:00:07.000 --> 00:00:08.000\nnext\n\n",
          { headers: { "Content-Type": "text/vtt; charset=utf-8" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const api = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce({
        snapshot: true,
        cues: [
          { at_ms: 1000, text: "past", mode: "scroll" },
          { at_ms: 5000, text: "now", mode: "top" },
          { at_ms: 7000, text: "next", mode: "bottom" },
        ],
      });
    const { runtime, cues } = setup(api);
    const transformed = {
      ...plan,
      transport: "hls",
      delivery_mode: "transcode",
      rebuild_on_seek: true,
      timeline_origin_ms: 5000,
      native_platform: {
        ...plan.native_platform,
        compatibility: {
          version: 1,
          mode: "hls_avc_aac",
          output: {
            attempt: 7,
            complete: false,
            width: 1280,
            height: 720,
            codecs: "avc1.64001F,mp4a.40.2",
          },
        },
      },
      playback_url: `/api/v1/platform-delivery/${sessionId}/compatibility/index.m3u8?token=${"a".repeat(64)}&attempt=7`,
    } as PlaybackPlan;
    await runtime.bind(transformed);
    await runtime.selectPlatformSubtitle("ymen");
    expect(cues).toEqual([
      { startTime: 0, endTime: 1, text: "clip" },
      { startTime: 2, endTime: 3, text: "next" },
    ]);
    await runtime.setPlatformDanmaku(true);
    expect(runtime.platformDanmakuCues.value).toEqual([
      { at_ms: 0, text: "now", mode: "top" },
      { at_ms: 2000, text: "next", mode: "bottom" },
    ]);
    expect(api.mock.calls[0][0]).toBe(
      `/platform-delivery/${sessionId}/text/catalog?token=${"a".repeat(64)}`,
    );
    expect(fetch.mock.calls[0][0]).not.toContain("attempt=");
    runtime.unsupported();
    expect(cues).toEqual([]);
  });
  it("fences late catalog results after a newer plan and logout", async () => {
    const old = deferred<unknown>(),
      latest = deferred<unknown>();
    const { runtime, session } = setup(
      vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => latest.promise),
    );
    const first = runtime.bind(plan),
      second = runtime.bind(plan);
    latest.resolve(catalog);
    await second;
    expect(runtime.platformSubtitleTracks.value).toEqual([track]);
    old.resolve({ ...catalog, subtitle_tracks: [{ ...track, id: "old" }] });
    await first;
    expect(runtime.platformSubtitleTracks.value).toEqual([track]);
    session.epoch++;
    expect(runtime.platformSubtitleTracks.value).toEqual([]);
    expect(runtime.platformSubtitleId.value).toBeNull();
  });
  it("turning subtitles Off aborts and fences an already-issued load", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetch);
    const { runtime, cues } = setup();
    await runtime.bind(plan);
    const selected = runtime.selectPlatformSubtitle("ymen");
    expect(runtime.platformSubtitleId.value).toBe("ymen");
    await runtime.selectPlatformSubtitle(null);
    pending.resolve(
      new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ntext\n\n", {
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      }),
    );
    await selected;
    expect(cues).toEqual([]);
    expect(runtime.platformSubtitleId.value).toBeNull();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
  });
  it("native cues are removed immediately on logout and a replacement video", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n&lt;b&gt;literal&lt;/b&gt;\n\n",
            { headers: { "Content-Type": "text/vtt; charset=utf-8" } },
          ),
        ),
    );
    const { runtime, cues, textTrack, session } = setup();
    await runtime.bind(plan);
    await runtime.selectPlatformSubtitle("ymen");
    expect(cues).toHaveLength(1);
    expect(textTrack.mode).toBe("showing");
    session.epoch++;
    expect(cues).toHaveLength(0);
    expect(textTrack.mode).toBe("disabled");
    expect(runtime.platformSubtitleId.value).toBeNull();
  });
  it("replacing the video removes the prior element's managed cues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ntext\n\n", {
          headers: { "Content-Type": "text/vtt; charset=utf-8" },
        }),
      ),
    );
    const { runtime, cues, video, textTrack } = setup();
    await runtime.bind(plan);
    await runtime.selectPlatformSubtitle("ymen");
    expect(cues).toHaveLength(1);
    video.value = { addTextTrack: vi.fn() } as unknown as HTMLVideoElement;
    expect(cues).toHaveLength(0);
    expect(textTrack.mode).toBe("disabled");
    expect(runtime.platformSubtitleTracks.value).toEqual([]);
  });
  it("danmaku Off and media resets discard late snapshots", async () => {
    const pending = deferred<unknown>();
    const api = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockImplementationOnce(() => pending.promise);
    const { runtime } = setup(api);
    await runtime.bind(plan);
    const enabling = runtime.setPlatformDanmaku(true);
    await runtime.setPlatformDanmaku(false);
    pending.resolve({
      cues: [{ at_ms: 0, text: "<script>plain</script>", mode: "scroll" }],
      snapshot: true,
    });
    await enabling;
    expect(runtime.platformDanmakuEnabled.value).toBe(false);
    expect(runtime.platformDanmakuCues.value).toEqual([]);
    runtime.reset();
    expect(runtime.platformDanmakuStatus.value).toBe("idle");
  });
  it.each(["PGC", "course"])(
    "selecting a %s episode removes prior cues and fences late text without a new request",
    async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nprior UGC cue\n\n",
              { headers: { "Content-Type": "text/vtt; charset=utf-8" } },
            ),
          ),
      );
      const { runtime, cues, textTrack, api } = setup();
      await runtime.bind(plan);
      await runtime.selectPlatformSubtitle("ymen");
      expect(cues).toHaveLength(1);
      runtime.unsupported();
      expect(cues).toEqual([]);
      expect(textTrack.mode).toBe("disabled");
      expect(runtime.platformSubtitleStatus.value).toBe("unsupported");
      expect(runtime.platformDanmakuStatus.value).toBe("unsupported");
      await runtime.selectPlatformSubtitle("ymen");
      await runtime.setPlatformDanmaku(true);
      expect(api).toHaveBeenCalledTimes(1);
      expect(runtime.platformDanmakuEnabled.value).toBe(false);
      const late = deferred<unknown>();
      api.mockImplementationOnce(() => late.promise);
      const pending = runtime.bind(plan);
      runtime.unsupported();
      late.resolve(catalog);
      await pending;
      expect(runtime.platformSubtitleTracks.value).toEqual([]);
      expect(runtime.platformSubtitleStatus.value).toBe("unsupported");
    },
  );
  it("unsupported providers keep controls unavailable without synthesizing tracks", async () => {
    const { runtime, api } = setup(
      vi.fn().mockResolvedValue({
        subtitle_tracks: [],
        subtitles_status: "unsupported",
        danmaku_status: "unsupported",
      }),
    );
    await runtime.bind(plan);
    await runtime.selectPlatformSubtitle("ymen");
    await runtime.setPlatformDanmaku(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(runtime.platformSubtitleTracks.value).toEqual([]);
    expect(runtime.platformDanmakuEnabled.value).toBe(false);
  });
});

describe("live private text ownership", () => {
  function livePlan() {
    return {
      ...plan,
      native_platform: {
        ...plan.native_platform,
        live: {
          version: 1,
          sync_mode: "live_edge_control",
          broadcast_id: "123:456:1700000000",
        },
      },
      playback_url: `/api/v1/platform-live-delivery/${sessionId}/playlist.m3u8?token=${"a".repeat(64)}`,
    } as PlaybackPlan;
  }
  const liveCatalog = {
    subtitle_tracks: [],
    subtitles_status: "unsupported",
    danmaku_status: "available",
  };
  it("advertises only observed timed in-band captions and sanitizes their text", async () => {
    const { runtime, cues, session } = setup(
      vi.fn().mockResolvedValue(liveCatalog),
    );
    await runtime.bind(livePlan());
    expect(runtime.platformSubtitleTracks.value).toEqual([]);
    runtime.ingestLiveInbandCaptions("cc1", [
      { startTime: 1, endTime: 3, text: "<img src=x>\nSTYLE" },
      { startTime: 4, endTime: 3, text: "invalid" },
    ]);
    expect(runtime.platformSubtitleTracks.value).toHaveLength(1);
    await runtime.selectPlatformSubtitle("ic1");
    expect(cues).toEqual([
      { startTime: 1, endTime: 3, text: "&lt;img src=x&gt; STYLE" },
    ]);
    session.epoch++;
    expect(cues).toEqual([]);
    expect(runtime.platformSubtitleTracks.value).toEqual([]);
    runtime.ingestLiveInbandCaptions("cc1", [
      { startTime: 1, endTime: 3, text: "late" },
    ]);
    expect(runtime.platformSubtitleTracks.value).toEqual([]);
  });
  it("maps genuine live timestamps to the decoder clock, then fences a late history on Off", async () => {
    const pending = deferred<unknown>(),
      api = vi
        .fn()
        .mockResolvedValueOnce(liveCatalog)
        .mockResolvedValueOnce({
          snapshot: true,
          broadcast_started_ms: 1700000000000,
          server_now_ms: 1700000010000,
          cues: [
            { at_ms: 9000, text: "<script>literal</script>", mode: "scroll" },
          ],
        })
        .mockImplementationOnce(() => pending.promise);
    const { runtime, element } = setup(api);
    Object.assign(element, { currentTime: 10 });
    await runtime.bind(livePlan());
    await runtime.setPlatformLiveDanmaku("history");
    expect(runtime.platformDanmakuCues.value[0].at_ms).toBe(9000);
    expect(runtime.platformLiveDanmakuMode.value).toBe("history");
    const next = runtime.setPlatformLiveDanmaku("history");
    await runtime.setPlatformLiveDanmaku("off");
    pending.resolve({
      snapshot: true,
      broadcast_started_ms: 1700000000000,
      server_now_ms: 1700000010000,
      cues: [],
    });
    await next;
    expect(runtime.platformDanmakuEnabled.value).toBe(false);
    expect(runtime.platformDanmakuCues.value).toEqual([]);
  });
  it("explicit realtime consent never silently falls back to a history request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "NATIVE_LIVE_DANMAKU_AUTH_DENIED",
            message: "denied",
            retryable: false,
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const { runtime, api } = setup(vi.fn().mockResolvedValue(liveCatalog));
    await runtime.bind(livePlan());
    await runtime.setPlatformLiveDanmaku("realtime");
    expect(fetch.mock.calls[0][0]).toContain("/text/realtime?");
    expect(fetch.mock.calls[0][0]).toContain("&consent_client_id=1");
    expect(api).toHaveBeenCalledTimes(1);
    expect(runtime.platformDanmakuCues.value).toEqual([]);
    expect(runtime.platformTextError.value).toContain("平台拒绝");
  });
});

it("aborts an owned realtime response and removes cues before late queued bytes", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  const fetch = vi.fn().mockResolvedValue(
    new Response(body, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const { runtime, element } = setup(
    vi.fn().mockResolvedValue({
      subtitle_tracks: [],
      subtitles_status: "unsupported",
      danmaku_status: "available",
    }),
  );
  Object.assign(element, { currentTime: 10 });
  const live = {
    ...plan,
    native_platform: {
      ...plan.native_platform,
      live: {
        version: 1,
        sync_mode: "live_edge_control",
        broadcast_id: "123:456:1700000000",
      },
    },
    playback_url: `/api/v1/platform-live-delivery/${sessionId}/playlist.m3u8?token=${"a".repeat(64)}`,
  } as PlaybackPlan;
  await runtime.bind(live);
  const pending = runtime.setPlatformLiveDanmaku("realtime");
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        snapshot: false,
        broadcast_started_ms: 1700000000000,
        server_now_ms: 1700000005000,
        cues: [{ at_ms: 4000, text: "hello", mode: "scroll" }],
      }) + "\n",
    ),
  );
  await vi.waitFor(() =>
    expect(runtime.platformDanmakuEnabled.value).toBe(true),
  );
  await runtime.setPlatformLiveDanmaku("off");
  expect(runtime.platformDanmakuCues.value).toEqual([]);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  controller.enqueue(new TextEncoder().encode("{}\n"));
  await pending;
  expect(cancel).toHaveBeenCalled();
  expect(runtime.platformDanmakuCues.value).toEqual([]);
  expect(runtime.platformLiveDanmakuMode.value).toBe("off");
});

describe("platform text preferences across fresh grants", () => {
  const subtitle = () =>
    new Response(
      "WEBVTT\n\n00:00:04.000 --> 00:00:06.000\nclip\n\n00:00:07.000 --> 00:00:08.000\nnext\n\n",
      { headers: { "Content-Type": "text/vtt; charset=utf-8" } },
    );
  const snapshot = {
    snapshot: true,
    cues: [{ at_ms: 5000, text: "now", mode: "scroll" }],
  };
  function fresh(extra: Partial<PlaybackPlan> = {}) {
    return {
      ...plan,
      session_id: "00000000-0000-4000-8000-000000000002",
      playback_url: `/api/v1/platform-delivery/00000000-0000-4000-8000-000000000002/manifest.mpd?token=${"b".repeat(64)}`,
      ...extra,
    } as PlaybackPlan;
  }
  function apiForText() {
    return vi.fn((url: string) =>
      Promise.resolve(url.includes("/catalog?") ? catalog : snapshot),
    );
  }
  it.each(["automatic refresh", "quality reload", "compatibility seek"])(
    "keeps selections through %s using only the new grant",
    async (kind) => {
      const fetch = vi.fn().mockImplementation(async () => subtitle());
      vi.stubGlobal("fetch", fetch);
      const { runtime, cues, api } = setup(apiForText());
      await runtime.bind(plan);
      await runtime.selectPlatformSubtitle(track.id);
      await runtime.setPlatformDanmaku(true);
      runtime.retire();
      expect(cues).toEqual([]);
      expect(runtime.platformDanmakuCues.value).toEqual([]);
      const replacement = fresh(
        kind === "compatibility seek"
          ? {
              timeline_origin_ms: 5000,
              transport: "hls",
              delivery_mode: "transcode",
              rebuild_on_seek: true,
              playback_url: `/api/v1/platform-delivery/00000000-0000-4000-8000-000000000002/compatibility/index.m3u8?token=${"b".repeat(64)}&attempt=7`,
              native_platform: {
                ...plan.native_platform!,
                compatibility: {
                  version: 1,
                  mode: "hls_avc_aac",
                  output: {
                    attempt: 7,
                    complete: false,
                    width: 1280,
                    height: 720,
                    codecs: "avc1.64001F,mp4a.40.2",
                  },
                },
              },
            }
          : {},
      );
      await runtime.bind(replacement);
      expect(runtime.platformSubtitleId.value).toBe(track.id);
      expect(runtime.platformDanmakuEnabled.value).toBe(true);
      expect(fetch.mock.calls.at(-1)?.[0]).toContain(replacement.session_id);
      expect(fetch.mock.calls.at(-1)?.[0]).toContain("token=" + "b".repeat(64));
      expect(api.mock.calls.at(-1)?.[0]).toContain("token=" + "b".repeat(64));
      expect(cues[0]).toMatchObject({
        startTime: kind === "compatibility seek" ? 0 : 4,
      });
      expect(runtime.platformDanmakuCues.value[0].at_ms).toBe(
        kind === "compatibility seek" ? 0 : 5000,
      );
    },
  );
  it("fences old subtitle and danmaku loads while restoring pending intent", async () => {
    const oldSubtitle = deferred<Response>(),
      oldDanmaku = deferred<unknown>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => oldSubtitle.promise)
      .mockImplementation(async () => subtitle());
    vi.stubGlobal("fetch", fetch);
    const api = apiForText()
      .mockImplementationOnce(async () => catalog)
      .mockImplementationOnce(() => oldDanmaku.promise);
    const { runtime, cues } = setup(api);
    await runtime.bind(plan);
    const selecting = runtime.selectPlatformSubtitle(track.id);
    const enabling = runtime.setPlatformDanmaku(true);
    await runtime.bind(fresh());
    oldSubtitle.resolve(subtitle());
    oldDanmaku.resolve(snapshot);
    await Promise.all([selecting, enabling]);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(api.mock.calls[1][3].aborted).toBe(true);
    expect(cues).toHaveLength(2);
    expect(runtime.platformDanmakuCues.value).toHaveLength(1);
    expect(runtime.platformSubtitleId.value).toBe(track.id);
    expect(runtime.platformDanmakuEnabled.value).toBe(true);
  });
  it("explicit Off during rediscovery cancels restoration and future reloads", async () => {
    const pending = deferred<unknown>();
    const fetch = vi.fn().mockImplementation(async () => subtitle());
    vi.stubGlobal("fetch", fetch);
    const api = apiForText();
    const { runtime } = setup(api);
    await runtime.bind(plan);
    await runtime.selectPlatformSubtitle(track.id);
    await runtime.setPlatformDanmaku(true);
    api.mockImplementationOnce(() => pending.promise);
    const reloading = runtime.bind(fresh());
    await runtime.selectPlatformSubtitle(null);
    await runtime.setPlatformDanmaku(false);
    pending.resolve(catalog);
    await reloading;
    await runtime.bind(fresh());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      api.mock.calls.filter(([url]) => url.includes("/danmaku?")),
    ).toHaveLength(1);
    expect(runtime.platformSubtitleId.value).toBeNull();
    expect(runtime.platformDanmakuEnabled.value).toBe(false);
  });
  it.each(["media", "generation", "viewer", "room-account"])(
    "clears preferences on a changed %s identity",
    async (axis) => {
      const owner = shallowRef("owner-room-account-1");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => subtitle()),
      );
      const { runtime, session } = setup(apiForText(), () => owner.value);
      await runtime.bind(plan);
      await runtime.selectPlatformSubtitle(track.id);
      await runtime.setPlatformDanmaku(true);
      if (axis === "viewer") session.epoch++;
      if (axis === "room-account") owner.value = "owner-room-account-2";
      await runtime.bind(
        fresh(
          axis === "media"
            ? { media_id: "media-2" }
            : axis === "generation"
              ? { media_generation: 2 }
              : {},
        ),
      );
      expect(runtime.platformSubtitleId.value).toBeNull();
      expect(runtime.platformDanmakuEnabled.value).toBe(false);
    },
  );
  it.each(["missing", "wrong-language", "wrong-role"])(
    "does not resurrect a %s subtitle identity on subsequent grants",
    async (kind) => {
      const fetch = vi.fn().mockImplementation(async () => subtitle());
      vi.stubGlobal("fetch", fetch);
      const api = apiForText();
      const { runtime } = setup(api);
      await runtime.bind(plan);
      await runtime.selectPlatformSubtitle(track.id);
      api.mockImplementationOnce(async () => ({
        ...catalog,
        subtitles_status: kind === "missing" ? "none" : "available",
        subtitle_tracks:
          kind === "missing"
            ? []
            : [
                {
                  ...track,
                  language: kind === "wrong-language" ? "ja" : "en",
                  automatic: kind === "wrong-role",
                },
              ],
      }));
      await runtime.bind(fresh());
      await runtime.bind(fresh());
      expect(runtime.platformSubtitleId.value).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("does not reconnect realtime live danmaku after a fresh live grant", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("", {
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { runtime } = setup(apiForText());
    const live = {
      ...plan,
      native_platform: {
        ...plan.native_platform!,
        live: {
          version: 1,
          sync_mode: "live_edge_control",
          broadcast_id: "123:456:1700000000",
        },
      },
      playback_url: `/api/v1/platform-live-delivery/${sessionId}/playlist.m3u8?token=${"a".repeat(64)}`,
    } as PlaybackPlan;
    await runtime.bind(live);
    await runtime.setPlatformLiveDanmaku("realtime");
    await runtime.bind(live);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(runtime.platformLiveDanmakuMode.value).toBe("off");
  });
});

it("keeps ingesting recent native live cues when the decoder retains over 512", async () => {
  const { runtime, element, cues } = setup();
  const retained = Array.from({ length: 513 }, (_, index) => ({
    startTime: index,
    endTime: index + 1,
    text: `cue-${index}`,
  }));
  let observe: (() => void) | undefined;
  const source = {
    kind: "captions",
    mode: "disabled",
    cues: retained,
    addEventListener: (_name: string, callback: () => void) => {
      observe = callback;
    },
    removeEventListener: vi.fn(),
  };
  const tracks = Object.assign([source], {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const live = {
    ...plan,
    native_platform: {
      ...plan.native_platform!,
      live: {
        version: 1,
        sync_mode: "live_edge_control",
        broadcast_id: "123:456:1700000000",
      },
    },
    playback_url: `/api/v1/platform-live-delivery/${sessionId}/playlist.m3u8?token=${"a".repeat(64)}`,
  } as PlaybackPlan;
  Object.assign(element, {
    currentTime: 512,
    currentSrc: "https://rainsync.test" + live.playback_url,
    textTracks: tracks,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  await runtime.bind(live);
  expect(runtime.platformSubtitleTracks.value).toHaveLength(1);
  await runtime.selectPlatformSubtitle("ic1");
  expect(cues.at(-1)).toMatchObject({ text: "cue-512" });
  retained.push({ startTime: 513, endTime: 514, text: "latest" });
  observe!();
  expect(cues.at(-1)).toMatchObject({ text: "latest" });
  expect(cues.length).toBeLessThanOrEqual(512);
  runtime.reset();
  observe!();
  expect(cues).toEqual([]);
});

it("ignores a retired subtitle grant's late denial before invalidating the current viewer", async () => {
  const pending = deferred<Response>();
  const fetch = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockImplementation(
      async () =>
        new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nnew\n\n", {
          headers: { "Content-Type": "text/vtt; charset=utf-8" },
        }),
    );
  vi.stubGlobal("fetch", fetch);
  const { runtime, session, cues } = setup();
  await runtime.bind(plan);
  const old = runtime.selectPlatformSubtitle(track.id);
  await runtime.bind({
    ...plan,
    session_id: "00000000-0000-4000-8000-000000000002",
    playback_url: `/api/v1/platform-delivery/00000000-0000-4000-8000-000000000002/manifest.mpd?token=${"b".repeat(64)}`,
  });
  pending.resolve(
    new Response(JSON.stringify({ error: { code: "SESSION_EXPIRED" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  );
  await old;
  expect(session.invalidate).not.toHaveBeenCalled();
  expect(runtime.platformSubtitleId.value).toBe(track.id);
  expect(cues).toEqual([{ startTime: 1, endTime: 2, text: "new" }]);
});
