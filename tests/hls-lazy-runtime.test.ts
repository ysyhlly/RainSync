import { expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";

const sdk = vi.hoisted(() => ({
  requested: 0,
  release: undefined as (() => void) | undefined,
  attached: [] as unknown[],
  sources: [] as string[],
}));
vi.mock("hls.js", async () => {
  sdk.requested++;
  await new Promise<void>((resolve) => {
    sdk.release = resolve;
  });
  return {
    default: class {
      static Events = { ERROR: "error" };
      static isSupported = () => true;
      config = {};
      attachMedia(element: unknown) {
        sdk.attached.push(element);
      }
      loadSource(url: string) {
        sdk.sources.push(url);
      }
      on() {}
      startLoad() {}
      stopLoad() {}
      destroy() {}
    },
  };
});

it("loads HLS once only for HLS plans and fences late SDK resolution by reset, identity and media", async () => {
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal("location", {
    href: "http://localhost/rooms/room",
    origin: "http://localhost",
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
  const { createPlaybackRuntime } =
    await import("../apps/web/src/features/playback/playback-runtime");
  expect(sdk.requested).toBe(0);
  const scopes: ReturnType<typeof effectScope>[] = [];
  const setup = (transport: "hls" | "progressive", id: string) => {
    const state = ref({
      room_id: "room",
      media_id: "media",
      media_generation: 1,
      revision: 1,
      playback_status: "paused",
      playback_rate: 1,
      anchor_position_ms: 0,
      anchor_server_time_ms: 0,
      duration_ms: 120000,
    });
    const api = vi.fn(async (path: string, method?: string, body?: any) => {
      if (path === "/playback-sessions" && method === "POST")
        return {
          session_id: id,
          plan_generation: body.plan_generation,
          media_id: "media",
          media_generation: 1,
          transport,
          delivery_mode: "direct",
          playback_url: `/${id}`,
          timeline_origin_ms: 0,
          duration_ms: 120000,
          rebuild_on_seek: false,
          audio_tracks: [],
          subtitle_tracks: [],
        };
      return {};
    });
    const session = { user: { id: "user" }, epoch: 1, api };
    const scope = effectScope();
    scopes.push(scope);
    const runtime = scope.run(() =>
      createPlaybackRuntime({
        session: session as any,
        state: state as any,
        connected: ref(true),
        active: ref(true),
        clock: { ready: true, revision: 0, now: () => 0 } as any,
        error: ref(""),
        run: (action) => action(),
      }),
    )!;
    const ranges = { length: 1, start: () => 0, end: () => 120 };
    const element: any = Object.assign(new EventTarget(), {
      src: "",
      readyState: 4,
      paused: true,
      currentTime: 0,
      playbackRate: 1,
      duration: 120,
      seekable: ranges,
      buffered: ranges,
      seeking: false,
      ended: false,
      canPlayType: (mime: string) =>
        mime.includes("mpegurl") ? "" : "probably",
      querySelectorAll: () => [],
      load() {},
      pause() {},
      play: async () => {},
      getAttribute: (name: string) => (name === "src" ? element.src : null),
      removeAttribute: () => {
        element.src = "";
      },
    });
    runtime.attach(element);
    return { runtime, session, state, element };
  };
  try {
    const progressive = setup("progressive", "plain.mp4");
    await progressive.runtime.loadMedia();
    expect(progressive.element.src).toBe("/plain.mp4");
    expect(sdk.requested).toBe(0);
    const reset = setup("hls", "reset.m3u8"),
      identity = setup("hls", "identity.m3u8"),
      media = setup("hls", "media.m3u8"),
      current = setup("hls", "current.m3u8");
    const pending = [reset, identity, media, current].map((s) =>
      s.runtime.loadMedia(),
    );
    await vi.waitFor(() => expect(sdk.requested).toBe(1));
    const { loadHlsLibrary } =
      await import("../apps/web/src/features/playback/hls-library");
    expect(loadHlsLibrary()).toBe(loadHlsLibrary());
    await reset.runtime.reset();
    ++identity.session.epoch;
    media.state.value.media_generation++;
    sdk.release!();
    await Promise.all(pending);
    expect(sdk.attached).toEqual([current.element]);
    expect(sdk.sources).toEqual(["/current.m3u8"]);
    expect(reset.element.src).toBe("");
    expect(identity.element.src).toBe("");
    expect(media.element.src).toBe("");
    expect(sdk.requested).toBe(1);
  } finally {
    sdk.release?.();
    for (const scope of scopes) scope.stop();
    vi.unstubAllGlobals();
  }
});
