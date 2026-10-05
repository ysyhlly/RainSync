import { afterEach, expect, it, vi } from "vitest";
import { effectScope, ref } from "vue";
import { createPlaybackRuntime } from "./playback-runtime";
import { PlaybackCancelled, PlaybackRequests } from "../../playback-request";
import { PlaybackPlanGenerations } from "../../../../../packages/player-core";
import type {
  PlaybackPlan,
  PlaybackRequest,
} from "../../../../../packages/protocol";
import {
  createStaticHlsChildIntentState,
  type StaticHlsPlanBinding,
} from "./static-hls-child-intent";

const instances = vi.hoisted(() => [] as any[]);
vi.mock("hls.js", () => ({
  default: class {
    static Events = { ERROR: "error" };
    static isSupported = () => true;
    static getMediaSource = () => ({ isTypeSupported: () => true });
    config: any = {};
    handler?: (event: unknown, data: any) => void;
    constructor() {
      instances.push(this);
    }
    loadSource() {}
    attachMedia() {}
    startLoad() {}
    stopLoad() {}
    destroy() {}
    on(_event: string, handler: (event: unknown, data: any) => void) {
      this.handler = handler;
    }
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  instances.length = 0;
});
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const rootPlan = (generation = 1): PlaybackPlan => ({
  session_id: id(2),
  media_id: id(3),
  media_generation: 7,
  plan_generation: generation,
  delivery_mode: "direct",
  transport: "hls",
  playback_url: "/stream/parent.m3u8",
  timeline_origin_ms: 0,
  duration_ms: 100000,
  expires_in_seconds: 600,
  rebuild_on_seek: false,
  audio_tracks: [],
  subtitle_tracks: [],
  selected_audio_track: 4,
  observation_version: 1,
  observation_seq: 12,
  static_hls_fallback_version: 1,
});
const rootRequest: PlaybackRequest = {
  static_hls_fallback_version: 1,
  idempotency_key: id(1),
  viewer_id: id(8),
  plan_generation: 1,
  room_id: id(5),
  media_generation: 7,
  mode: "auto",
  position_ms: 0,
  audio_index: null,
  capabilities: {
    progressive_h264_aac: true,
    native_hls: true,
    mse_h264_aac: true,
  },
  observation_version: 1,
};
function proposal(plan = rootPlan()) {
  const state = createStaticHlsChildIntentState({ plan, request: rootRequest });
  const binding: StaticHlsPlanBinding = {
    plan,
    attachment: {},
    room_id: id(5),
    media_id: id(3),
    media_generation: 7,
    viewer_id: id(8),
    plan_generation: 1,
  };
  const child = state.propose({
    current: binding,
    failure: { binding, event: { kind: "native", code: 3 } },
    child: { viewer_id: id(8), plan_generation: 2, idempotency_key: id(9) },
    position_ms: 1200,
    final_observation: null,
  });
  if (child.kind !== "proposed") throw new Error(child.reason);
  return child.intent;
}
function stored() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
async function settle() {
  for (let n = 0; n < 30; ++n) await Promise.resolve();
}
function setup(
  options: {
    marked?: boolean;
    native?: boolean;
    optIn?: boolean;
    lost?: boolean;
    availability?: unknown;
    delayedAvailability?: Promise<unknown>;
  } = {},
) {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("sessionStorage", stored());
  vi.stubGlobal("location", { href: "http://localhost/rooms/room" });
  const events: string[] = [],
    bodies: string[] = [];
  let childCalls = 0;
  const api = vi.fn(async (path: string, method: string, body?: any) => {
    if (path === "/playback-candidates") return {};
    if (path === "/playback-static-hls-capabilities")
      return (
        options.delayedAvailability ??
        options.availability ?? {
          version: 1,
          available: true,
          reason: "installed_runtime",
        }
      );
    if (path === "/playback-sessions" && method === "POST") {
      if (!body.static_hls_fallback) {
        events.push("parent-post");
        return {
          ...rootPlan(body.plan_generation),
          static_hls_fallback_version: options.marked === false ? undefined : 1,
        };
      }
      bodies.push(JSON.stringify(body));
      events.push("child-post");
      ++childCalls;
      if (options.lost && childCalls === 1)
        throw new TypeError("lost response");
      return {
        ...rootPlan(body.plan_generation),
        session_id: id(10),
        delivery_mode: "transcode",
        static_hls_fallback_version: undefined,
      };
    }
    if (method === "DELETE") events.push(path);
    return {};
  });
  const session = {
    user: { id: id(6) } as { id: string } | undefined,
    epoch: 1,
    api,
  };
  const state = ref({
    room_id: id(5),
    media_id: id(3),
    media_generation: 7,
    playback_status: "paused",
    anchor_position_ms: 5000,
    anchor_server_time_ms: 0,
    playback_rate: 1,
  });
  const connected = ref(true),
    active = ref(true),
    error = ref("");
  const clock = { ready: true, revision: 1, now: () => 10000 };
  const scope = effectScope();
  const runtime = scope.run(() =>
    createPlaybackRuntime({
      session: session as any,
      state: state as any,
      connected,
      active,
      clock: clock as any,
      error,
      staticHlsFallback: options.optIn !== false,
      run: async (action) => {
        try {
          await action();
        } catch (e) {
          error.value = String(e);
        }
      },
    }),
  )!;
  const element: any = Object.assign(new EventTarget(), {
    canPlayType: (type: string) =>
      type.includes("mpegurl") && options.native === false ? "" : "probably",
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn((name) => {
      if (name === "src") element.src = "";
    }),
    getAttribute: (name: string) => (name === "src" ? element.src : null),
    querySelectorAll: () => [],
    src: "",
    error: null,
    buffered: { length: 0 },
    seekable: { length: 0 },
    currentTime: 1.2,
    playbackRate: 1,
    paused: true,
    seeking: false,
    readyState: 4,
  });
  runtime.attach(element);
  runtime.staticHlsFallbackEnabled.value = options.optIn !== false;
  return {
    runtime,
    element,
    api,
    events,
    bodies,
    session,
    state,
    connected,
    active,
    error,
    clock,
    posts: () =>
      api.mock.calls.filter(
        ([p, m]) => p === "/playback-sessions" && m === "POST",
      ),
    cleanup: () => scope.stop(),
  };
}
it("refused allocator proposals keep the parent's generation current", () => {
  const generations = new PlaybackPlanGenerations(id(8));
  const parent = generations.next();
  expect(generations.nextWhen(() => false)).toBeUndefined();
  expect(generations.current(parent)).toBe(true);
  expect(generations.nextWhen(() => true)?.plan_generation).toBe(2);
});
it("native decode freezes one child before detach, preserving default audio and the exact final sample", async () => {
  const f = setup();
  try {
    await f.runtime.loadMedia();
    f.element.currentTime = 1.2;
    const callback = f.element.onerror;
    f.element.error = { code: 3 };
    callback();
    callback();
    await settle();
    const child = f.posts()[1][2] as any;
    expect(f.posts()).toHaveLength(2);
    expect(child).toMatchObject({
      mode: "transcode",
      audio_index: null,
      plan_generation: 2,
      static_hls_fallback: {
        parent_session_id: id(2),
        failure: { kind: "native_decode", code: 3 },
        final_observation: { media_time_ms: 1200, seq: 13 },
      },
    });
    expect(Object.isFrozen(child)).toBe(true);
    const finalDelete = f.api.mock.calls.find(
      ([p, m]) => p === `/playback-sessions/${id(2)}` && m === "DELETE",
    )!;
    expect(finalDelete[2]).toEqual(child.static_hls_fallback.final_observation);
    expect(f.events.indexOf("child-post")).toBeLessThan(
      f.events.indexOf(`/playback-sessions/${id(2)}`),
    );
    f.element.error = { code: 3 };
    f.element.onerror();
    await settle();
    expect(f.posts()).toHaveLength(2);
  } finally {
    f.cleanup();
  }
});
it("unknown HTTP retries replay identical JSON/key even as room position changes, without early parent DELETE", async () => {
  const f = setup({ lost: true });
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 3 };
    f.element.onerror();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.bodies).toHaveLength(1);
    expect(f.events).not.toContain(`/playback-sessions/${id(2)}`);
    f.state.value.anchor_position_ms = 8000;
    f.element.currentTime = 8;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[1]).toBe(f.bodies[0]);
  } finally {
    f.cleanup();
  }
});
it.each([
  { fatal: true, type: "networkError", details: "fragLoadError" },
  { fatal: true, type: "mediaError", details: "bufferStalledError" },
  {
    fatal: true,
    type: "mediaError",
    details: "bufferAppendError",
    response: { code: 403 },
  },
  {
    fatal: true,
    type: "mediaError",
    details: "bufferAppendError",
    error: { name: "QuotaExceededError" },
  },
  { fatal: false, type: "mediaError", details: "bufferAppendError" },
])(
  "does not send a static child for non-decode HLS evidence: %j",
  async (event) => {
    const f = setup({ native: false });
    try {
      await f.runtime.loadMedia();
      instances.at(-1).handler("error", event);
      await settle();
      expect(f.posts()).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
);
it("fatal classified MSE decode uses the same attached Hls binding and no native decoder code is invented", async () => {
  const f = setup({ native: false });
  try {
    await f.runtime.loadMedia();
    instances.at(-1).handler("error", {
      fatal: true,
      type: "mediaError",
      details: "bufferAppendError",
    });
    await settle();
    expect(f.posts()).toHaveLength(2);
    expect((f.posts()[1][2] as any).static_hls_fallback.failure).toEqual({
      kind: "hls_media_decode",
    });
  } finally {
    f.cleanup();
  }
});
it("a callback from an Hls attachment replaced by recovery is stale", async () => {
  const f = setup({ native: false });
  try {
    await f.runtime.loadMedia();
    const old = instances.at(-1).handler;
    old("error", {
      fatal: true,
      type: "networkError",
      details: "fragLoadError",
      response: { code: 409 },
    });
    expect(instances).toHaveLength(2);
    old("error", {
      fatal: true,
      type: "mediaError",
      details: "bufferAppendError",
    });
    await settle();
    expect(f.posts()).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
it.each([
  "unmarked",
  "source",
  "logout",
  "inactive",
  "disconnected",
  "code4",
  "default",
])("no child for %s parent/callback", async (kind) => {
  const f = setup({ marked: kind !== "unmarked", optIn: kind !== "default" });
  try {
    await f.runtime.loadMedia();
    const old = f.element.onerror;
    if (kind === "source") f.state.value.media_id = id(11);
    if (kind === "logout") {
      f.session.user = undefined;
      ++f.session.epoch;
    }
    if (kind === "inactive") f.active.value = false;
    if (kind === "disconnected") f.connected.value = false;
    f.element.error = { code: kind === "code4" ? 4 : 3 };
    old();
    await settle();
    expect(f.posts()).toHaveLength(1);
    if (kind === "default") {
      const body = f.posts()[0][2] as any;
      expect(body.static_hls_fallback_version).toBeUndefined();
      expect(body.http_file_fallback_version).toBe(1);
      expect(body.capabilities.report).toBeDefined();
    }
  } finally {
    f.cleanup();
  }
});
it("request manager cannot network an unmarked parent, preserving it on refused proposals", async () => {
  const send = vi.fn(async () => ({
    ...rootPlan(),
    static_hls_fallback_version: undefined,
  }));
  const cancel = vi.fn(async () => {}),
    finalize = vi.fn(async () => {});
  const requests = new PlaybackRequests(send, cancel, stored(), "requests");
  await requests.prepare(rootRequest);
  await expect(
    requests.prepareStaticHlsChild(proposal(), finalize),
  ).rejects.toMatchObject({ code: "SOURCE_VERSION_REQUIRED" });
  expect(send).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(finalize).not.toHaveBeenCalled();
});
it("explicit Stop cancels a frozen child key before blocked parent finalization", async () => {
  let finish!: (plan: PlaybackPlan) => void, deleted!: () => void;
  const result = new Promise<PlaybackPlan>((resolve) => {
    finish = resolve;
  });
  const deletion = new Promise<void>((resolve) => {
    deleted = resolve;
  });
  const cancel = vi.fn(async () => {}),
    storage = stored();
  const send = vi.fn(async (body: PlaybackRequest) =>
    body.idempotency_key === id(1) ? rootPlan() : result,
  );
  const requests = new PlaybackRequests(send, cancel, storage, "requests");
  await requests.prepare(rootRequest);
  const preparing = requests.prepareStaticHlsChild(proposal(), () => deletion);
  const rejected = expect(preparing).rejects.toBeInstanceOf(PlaybackCancelled);
  await settle();
  const stopping = requests.stop();
  await settle();
  expect(cancel).toHaveBeenCalledWith(id(9), expect.any(AbortSignal));
  expect(cancel).not.toHaveBeenCalledWith(id(1), expect.any(AbortSignal));
  finish({
    ...rootPlan(2),
    session_id: id(10),
    static_hls_fallback_version: undefined,
  });
  deleted();
  await Promise.all([stopping, rejected]);
  expect(storage.getItem("requests")).toBe("[]");
});

it.each(["source", "audio", "logout", "stop"])(
  "unknown-result %s invalidation cannot replay the frozen child",
  async (kind) => {
    const f = setup({ lost: true });
    try {
      await f.runtime.loadMedia();
      f.element.error = { code: 3 };
      f.element.onerror();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.bodies).toHaveLength(1);
      if (kind === "source") f.state.value.media_id = id(11);
      if (kind === "audio") f.runtime.audioIndex.value = 2;
      if (kind === "logout") {
        f.session.user = undefined;
        ++f.session.epoch;
      }
      if (kind === "stop") await f.runtime.reset();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.bodies).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
);
it("clock recalibration after the claim keeps the frozen child key/body rather than creating a new generation", async () => {
  const f = setup({ lost: true });
  try {
    await f.runtime.loadMedia();
    f.element.error = { code: 3 };
    f.element.onerror();
    await vi.advanceTimersByTimeAsync(0);
    f.clock.ready = false;
    ++f.clock.revision;
    f.runtime.onClockInvalidated();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.bodies).toHaveLength(2);
    expect(f.bodies[1]).toBe(f.bodies[0]);
    f.clock.ready = true;
    f.runtime.onClockReady();
    await settle();
    expect(f.posts()).toHaveLength(3);
  } finally {
    f.cleanup();
  }
});

it.each([
  { version: 1, available: false, reason: "operator_disabled" },
  { version: 1, available: false, reason: "worker_unavailable" },
  { version: 1, available: false, reason: "source_unsupported" },
  { version: 1, available: true, reason: "ready" },
  { version: 2, available: true, reason: "installed_runtime" },
])(
  "unavailable or malformed availability never advertises an ordinary static intent: %j",
  async (availability) => {
    const f = setup({ availability });
    try {
      await f.runtime.loadMedia();
      expect(
        (f.posts()[0][2] as any).static_hls_fallback_version,
      ).toBeUndefined();
      expect((f.posts()[0][2] as any).http_file_fallback_version).toBe(1);
    } finally {
      f.cleanup();
    }
  },
);
it.each(["source", "logout", "toggle", "stop"])(
  "a delayed availability reply cannot revive a cancelled %s intent",
  async (kind) => {
    let resolve!: (value: unknown) => void;
    const delayedAvailability = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    const f = setup({ delayedAvailability });
    try {
      const loading = f.runtime.loadMedia();
      await settle();
      if (kind === "source") f.state.value.media_id = id(11);
      if (kind === "logout") {
        f.session.user = undefined;
        ++f.session.epoch;
      }
      if (kind === "toggle") f.runtime.staticHlsFallbackEnabled.value = false;
      if (kind === "stop") await f.runtime.reset();
      resolve({ version: 1, available: true, reason: "installed_runtime" });
      await loading.catch(() => {});
      expect(f.posts()).toHaveLength(0);
      expect(f.runtime.staticHlsAvailability.value).toBeUndefined();
    } finally {
      f.cleanup();
    }
  },
);
it("turning the viewer intent off retires an attached static failure callback", async () => {
  const f = setup();
  try {
    await f.runtime.loadMedia();
    f.runtime.staticHlsFallbackEnabled.value = false;
    f.element.error = { code: 3 };
    f.element.onerror();
    await settle();
    expect(f.posts()).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
