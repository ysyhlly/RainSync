import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";
import type { HlsLibrary } from "../apps/web/src/features/playback/hls-library";
import type { RoomP2PTransport as Peer } from "../apps/web/src/features/playback/room-p2p";

const library = vi.hoisted(() => ({ load: vi.fn() }));
const observed = vi.hoisted(() => ({ peers: [] as Peer[] }));
vi.mock("../apps/web/src/features/playback/hls-library", () => ({
  loadHlsLibrary: library.load,
}));
vi.mock("../apps/web/src/features/playback/room-p2p", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../apps/web/src/features/playback/room-p2p")
    >();
  return {
    ...original,
    // Observe construction without replacing the real peer's lifecycle or I/O.
    RoomP2PTransport: new Proxy(original.RoomP2PTransport, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget) as Peer;
        observed.peers.push(peer);
        return peer;
      },
    }),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const intent = { schema_version: 1, job_id: id(10), output_generation: id(11) };

// Same qualified primary-output fixture as distributed-primary-playback.test.ts.
function plan(request: PlaybackRequest, session: string): PlaybackPlan {
  return {
    session_id: session,
    plan_generation: request.plan_generation,
    media_id: id(4),
    media_generation: request.media_generation,
    delivery_mode: "transcode",
    transport: "hls",
    playback_url: `/api/v1/playback-sessions/${session}/distributed/files/index.m3u8`,
    timeline_origin_ms: 0,
    duration_ms: 16000,
    expires_in_seconds: 600,
    rebuild_on_seek: false,
    audio_tracks: [],
    subtitle_tracks: [],
    subtitle_mode: "none",
    seekable_media_ranges_ms: [{ start_ms: 0, end_ms: 16000 }],
    decoder_fallback_modes: [],
    distributed_compute: {
      ...intent,
      attempt: 2,
      qualification_sha256: "a".repeat(64),
      manifest_sha256: "b".repeat(64),
      directory_url: `/api/v1/playback-sessions/${session}/distributed/directory`,
      p2p_enabled: true,
      source_video_index: 0,
      source_audio_index: null,
      video_codec: "h264",
      width: 852,
      height: 480,
      audio_codec: null,
      audio_channels: null,
      audio_sample_rate: null,
      source_duration_ms: 16000,
      timestamp_shift_ms: 1480,
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  vi.resetModules();
  // Bootstrap Vue before installing the intentionally minimal media document.
  await import("vue");
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
  observed.peers.length = 0;
  library.load.mockReset();
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("location", {
    origin: "http://localhost",
    href: `http://localhost/rooms/${id(2)}`,
  });
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(options: { readyState?: number; playing?: boolean } = {}) {
  const sdkReady = deferred<HlsLibrary>();
  const sdkRequested = deferred<void>();
  library.load.mockImplementation(() => {
    sdkRequested.resolve();
    return sdkReady.promise;
  });
  const vue = await import("vue");
  // Finish the call-through mock before the runtime imports its constructor.
  const peerModule = await import("../apps/web/src/features/playback/room-p2p");
  const originalPrepare = peerModule.RoomP2PTransport.prototype.prepare;
  const prepare = vi.spyOn(peerModule.RoomP2PTransport.prototype, "prepare");
  const start = vi.spyOn(peerModule.RoomP2PTransport.prototype, "start");
  const stop = vi.spyOn(peerModule.RoomP2PTransport.prototype, "stop");
  const loader = await import("../apps/web/src/features/playback/hls-driver-loader");
  const originalLoad = loader.loadHlsDriver;
  const successorAtHls = deferred<void>();
  let driverRequests = 0;
  const loadDriver = vi.spyOn(loader, "loadHlsDriver").mockImplementation(() => {
    const pending = originalLoad();
    if (++driverRequests === 2) successorAtHls.resolve();
    return pending;
  });
  const [{ createPlaybackRuntime }, { playbackTestContext }] = await Promise.all([
    import("../apps/web/src/features/playback/playback-runtime"),
    import("./helpers/playback-context"),
  ]);
  const instances: FakeHls[] = [];
  class FakeHls {
    static Events = { ERROR: "error" };
    static DefaultConfig = { loader: class {} };
    static isSupported = () => true;
    readonly destroy = vi.fn();
    readonly stopLoad = vi.fn();
    readonly startLoad = vi.fn();
    readonly loadSource = vi.fn();
    readonly attachMedia = vi.fn();
    readonly on = vi.fn();
    readonly off = vi.fn();
    constructor(readonly config: { fLoader?: unknown }) {
      instances.push(this);
    }
  }
  const releaseLibrary = () => sdkReady.resolve(FakeHls as unknown as HlsLibrary);
  const plans: PlaybackPlan[] = [];
  const directoryEntered = deferred<void>();
  let directoryGate: Promise<void> | undefined;
  const releases: (() => void)[] = [releaseLibrary];
  const api = vi.fn(async (path: string, method = "GET", body?: any) => {
    if (path === "/playback-sessions/distributed-compute" && method === "POST") {
      const value = plan(body, id(5 + plans.length));
      plans.push(value);
      return value;
    }
    const current = plans.find(
      (value) =>
        path === `/playback-sessions/${value.session_id}/distributed/directory`,
    );
    if (current) {
      directoryEntered.resolve();
      await directoryGate;
      return {
        session_id: current.session_id,
        job_id: intent.job_id,
        output_generation: intent.output_generation,
        files: [
          {
            name: "index.m3u8",
            url: current.playback_url,
            sha256: "b".repeat(64),
            size_bytes: 100,
          },
          {
            name: "segment00000.ts",
            url: `/api/v1/playback-sessions/${current.session_id}/distributed/files/segment00000.ts`,
            sha256: "c".repeat(64),
            size_bytes: 1000,
          },
        ],
      };
    }
    const readiness = plans.find((value) =>
      path.startsWith(`/playback-sessions/${value.session_id}?`),
    );
    if (readiness)
      return {
        session_id: readiness.session_id,
        plan_generation: readiness.plan_generation,
        status: "ready",
        complete: true,
      };
    return {};
  });
  const session = vue.reactive({ user: { id: id(1) }, epoch: 1, api });
  const state = vue.ref({
    room_id: id(2),
    media_id: id(4),
    media_generation: 4,
    playback_status: options.playing ? "playing" : "paused",
    anchor_position_ms: 5000,
    anchor_server_time_ms: 10000,
    playback_rate: 1,
  });
  const scope = vue.effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime(
      playbackTestContext({
        session: session as any,
        state: state as any,
        connected: vue.ref(true),
        active: vue.ref(true),
        clock: { ready: true, revision: 1, now: () => 10000 } as any,
      }),
    ),
  )!;
  const ranges = { length: 1, start: () => 0, end: () => 16 };
  const element: any = Object.assign(new EventTarget(), {
    canPlayType: (mime: string) => (mime.includes("mpegurl") ? "" : "probably"),
    pause: vi.fn(),
    play: vi.fn(async () => {}),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: () => null,
    querySelectorAll: () => [],
    error: null,
    buffered: ranges,
    seekable: ranges,
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    seeking: false,
    readyState: options.readyState ?? 4,
    duration: 16,
  });
  runtime.attach(element);
  const loads: Promise<void>[] = [];
  const load = () => {
    const pending = runtime.useDistributedOutput(intent);
    loads.push(pending);
    return pending;
  };
  cleanups.push(async () => {
    const reset = runtime.reset();
    for (const release of releases) release();
    await Promise.allSettled([reset, ...loads]);
    scope.stop();
  });
  return {
    runtime,
    session,
    state,
    scope,
    api,
    element,
    plans,
    instances,
    prepare,
    start,
    stop,
    loadDriver,
    load,
    releaseLibrary,
    sdkRequested: sdkRequested.promise,
    successorAtHls: successorAtHls.promise,
    directoryEntered: directoryEntered.promise,
    holdDirectory() {
      const gate = deferred<void>();
      directoryGate = gate.promise;
      const release = () => gate.resolve();
      releases.push(release);
      return release;
    },
    holdPrepareCompletion() {
      const prepared = deferred<void>();
      const gate = deferred<void>();
      prepare.mockImplementationOnce(async function (this: Peer) {
        await originalPrepare.call(this);
        prepared.resolve();
        await gate.promise;
      });
      const release = () => gate.resolve();
      releases.push(release);
      return { prepared: prepared.promise, release };
    },
  };
}

function expectNoAutomaticSharing(f: Awaited<ReturnType<typeof setup>>) {
  expect(f.start).not.toHaveBeenCalled();
  expect(f.runtime.peerSharing.value).toBe(false);
  expect(
    f.api.mock.calls.filter(([path]) => path.includes("p2p")),
  ).toEqual([]);
}

it.each(["identity", "room", "media", "reset", "element"])(
  "%s replacement during the existing HLS await prevents peer construction and preparation",
  async (replacement) => {
    const f = await setup();
    const loading = f.load();
    await f.sdkRequested;
    expect(f.runtime.sessionId.value).toBe(id(5));
    expect(observed.peers).toHaveLength(0);
    expect(f.prepare).not.toHaveBeenCalled();
    if (replacement === "identity") f.session.epoch++;
    else if (replacement === "room") f.state.value.room_id = id(20);
    else if (replacement === "media") f.state.value.media_generation++;
    else if (replacement === "reset") await f.runtime.reset();
    else {
      // Fixture-only identity replacement isolates the captured-element fence.
      // The production attach API still requires the permanent media element.
      f.runtime.video.value = Object.assign(new EventTarget(), f.element);
    }
    const stage = f.runtime.loadingStage.value;
    f.releaseLibrary();
    await loading;
    expect(observed.peers).toHaveLength(0);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.instances).toHaveLength(0);
    expect(f.runtime.loadingStage.value).toBe(stage);
    expect(f.runtime.peerStats.value).toBeUndefined();
    expectNoAutomaticSharing(f);
  },
);

it("a same-element successor constructs only its own peer when the shared HLS load settles", async () => {
  const f = await setup();
  const oldLoading = f.load();
  await f.sdkRequested;
  const currentLoading = f.load();
  await f.successorAtHls;
  expect(f.runtime.sessionId.value).toBe(id(6));
  expect(f.loadDriver).toHaveBeenCalledTimes(2);
  expect(library.load).toHaveBeenCalledOnce();
  expect(observed.peers).toHaveLength(0);
  f.releaseLibrary();
  await Promise.all([oldLoading, currentLoading]);
  expect(observed.peers).toHaveLength(1);
  const [peer] = observed.peers;
  expect(f.prepare.mock.contexts).toEqual([peer]);
  expect(f.stop).not.toHaveBeenCalled();
  expect(peer.has(f.plans[0].playback_url)).toBe(false);
  expect(peer.has(f.plans[1].playback_url)).toBe(true);
  expect(f.instances).toHaveLength(1);
  expect(f.instances[0].loadSource).toHaveBeenCalledExactlyOnceWith(
    f.plans[1].playback_url,
  );
  expect(f.instances[0].attachMedia).toHaveBeenCalledExactlyOnceWith(f.element);
  expect(library.load).toHaveBeenCalledOnce();
  expectNoAutomaticSharing(f);
});

it("prepares one current distributed HLS peer after the existing await without automatic consent or start", async () => {
  const f = await setup();
  const loading = f.load();
  await f.sdkRequested;
  expect(observed.peers).toHaveLength(0);
  expect(f.prepare).not.toHaveBeenCalled();
  f.releaseLibrary();
  await loading;
  expect(observed.peers).toHaveLength(1);
  const [peer] = observed.peers;
  expect(peer.room).toBe(id(2));
  expect(peer.job).toBe(intent.job_id);
  expect(peer.active).toBe(false);
  expect(peer.has(f.plans[0].playback_url)).toBe(true);
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith();
  expect(f.prepare.mock.contexts).toEqual([peer]);
  expect(f.instances).toHaveLength(1);
  expect(f.instances[0].loadSource).toHaveBeenCalledExactlyOnceWith(
    f.plans[0].playback_url,
  );
  expect(f.instances[0].attachMedia).toHaveBeenCalledExactlyOnceWith(f.element);
  expect(f.instances[0].config.fLoader).toBeTypeOf("function");
  expect(f.runtime.peerStats.value).toEqual(peer.stats);
  expectNoAutomaticSharing(f);
});

it("a real directory reply after reset cannot revive the retired peer", async () => {
  const f = await setup();
  const releaseDirectory = f.holdDirectory();
  const loading = f.load();
  await f.sdkRequested;
  f.releaseLibrary();
  await f.directoryEntered;
  const [peer] = observed.peers;
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.instances).toHaveLength(0);
  await f.runtime.reset();
  expect(f.stop.mock.contexts).toEqual([peer]);
  releaseDirectory();
  await loading;
  expect(observed.peers).toEqual([peer]);
  expect(peer.has(f.plans[0].playback_url)).toBe(false);
  expect(f.instances).toHaveLength(0);
  expect(f.runtime.sessionId.value).toBeNull();
  expect(f.runtime.peerStats.value).toBeUndefined();
  expect(f.runtime.preparation.value.phase).toBe("idle");
  expectNoAutomaticSharing(f);
});

it("late successful prepare completion cleans up only its original peer after a replacement attaches", async () => {
  const f = await setup();
  const completion = f.holdPrepareCompletion();
  const oldLoading = f.load();
  await f.sdkRequested;
  f.releaseLibrary();
  await completion.prepared;
  const [oldPeer] = observed.peers;
  expect(oldPeer.has(f.plans[0].playback_url)).toBe(true);
  oldPeer.stats.httpBytes = 123;
  expect(f.instances).toHaveLength(0);
  await f.runtime.reset();
  await f.load();
  const [, currentPeer] = observed.peers;
  expect(observed.peers).toHaveLength(2);
  expect(f.prepare.mock.contexts).toEqual([oldPeer, currentPeer]);
  expect(f.stop.mock.contexts).toEqual([oldPeer]);
  expect(f.runtime.sessionId.value).toBe(id(6));
  expect(f.instances).toHaveLength(1);
  const stats = f.runtime.peerStats.value;
  expect(stats).not.toEqual(oldPeer.stats);
  const stage = f.runtime.loadingStage.value;
  completion.release();
  await oldLoading;
  expect(f.stop.mock.contexts).toEqual([oldPeer, oldPeer]);
  expect(f.runtime.sessionId.value).toBe(id(6));
  // stop() refreshes the current peer's stats snapshot through its real callback.
  expect(f.runtime.peerStats.value).toEqual(stats);
  expect(f.runtime.peerStats.value).not.toEqual(oldPeer.stats);
  expect(f.runtime.loadingStage.value).toBe(stage);
  expect(f.instances).toHaveLength(1);
  expect(f.instances[0].loadSource).toHaveBeenCalledExactlyOnceWith(
    f.plans[1].playback_url,
  );
  expect(f.instances[0].destroy).not.toHaveBeenCalled();
  expect(currentPeer.has(f.plans[1].playback_url)).toBe(true);
  expectNoAutomaticSharing(f);
});

it.each([
  ["media data", 0, false, "MEDIA_DATA_TIMEOUT"],
  ["first frame", 4, true, "FIRST_FRAME_TIMEOUT"],
] as const)(
  "HLS attachment still starts the 20-second %s deadline after deferred loading",
  async (_name, readyState, playing, code) => {
    const f = await setup({ readyState, playing });
    const loading = f.load();
    await f.sdkRequested;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.runtime.preparation.value.failure).toBeUndefined();
    expect(observed.peers).toHaveLength(0);
    f.releaseLibrary();
    await loading;
    expect(f.prepare).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(f.runtime.preparation.value.failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runtime.preparation.value.failure?.code).toBe(code);
    expect(f.runtime.loadingStage.value).toBe("failed");
    expect(f.instances).toHaveLength(1);
    expect(f.prepare).toHaveBeenCalledOnce();
    expectNoAutomaticSharing(f);
  },
);
