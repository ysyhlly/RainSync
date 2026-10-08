import { afterEach, expect, it, vi } from "vitest";
import { isReadonly, reactive, readonly, ref } from "vue";
import { createPlaybackSessionController } from "../apps/web/src/features/playback/playback-session-controller";
import { createPlaybackScope } from "../apps/web/src/features/playback/playback-scope";
import type { PlaybackIntent } from "../apps/web/src/features/playback/playback-runtime-types";
import type { ApiClient } from "../apps/web/src/shared/api/client";
import { StaleIdentity } from "../apps/web/src/shared/api/client";
import { RequestFailure } from "../apps/web/src/errors";
import {
  PlaybackCancelled,
  PlaybackViewerOriginRequired,
} from "../apps/web/src/playback-request";
import type {
  PlaybackPlan,
  PlaybackRequest,
  RoomState,
} from "../packages/protocol";

const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (failure: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function planFor(request: PlaybackRequest, rebuild = false): PlaybackPlan {
  return {
    session_id: `session-${request.plan_generation}`,
    plan_generation: request.plan_generation,
    media_id: "media",
    media_generation: request.media_generation,
    transport: "progressive",
    delivery_mode: "direct",
    playback_url: "/fixture.mp4",
    timeline_origin_ms: 0,
    duration_ms: 120_000,
    expires_in_seconds: 120,
    rebuild_on_seek: rebuild,
    audio_tracks: [],
    subtitle_tracks: [],
  };
}
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("document", new EventTarget());
  const identity = reactive({
    userId: "viewer" as string | undefined,
    epoch: 1,
  });
  const state = ref<RoomState | null>({
    room_id: "room",
    revision: 1,
    media_id: "media",
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "viewer",
    duration_ms: 120_000,
    clock_epoch: "clock",
  });
  const saved = new Map<string, string>();
  const api = vi.fn(
    async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      if (path === "/playback-sessions" && method === "POST")
        return planFor(body as PlaybackRequest);
      return {};
    },
  );
  const prepared = vi.fn(),
    readiness = vi.fn();
  const controller = createPlaybackSessionController({
    identity: {
      current: () => Object.freeze({ ...identity }),
    },
    api: api as ApiClient,
    timeline: { state: readonly(state), active: readonly(ref(true)) },
    storage: () => ({
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    }),
    origin: () => "http://localhost",
    retryStaticChild: () => undefined,
    intentCurrent: (intent) =>
      controller.intent() === intent &&
      intent.epoch === identity.epoch &&
      intent.user === identity.userId,
    prepared,
    readiness,
  });
  function intent(key: string, originRecoveryUsed = false) {
    const generation = controller.nextPlan();
    const owner = createPlaybackScope<
      Omit<PlaybackIntent, "owner" | "origin" | "initialPlanGeneration">
    >(
      {
        user: identity.userId,
        epoch: identity.epoch,
        room: "room",
        media: 1,
        mediaId: "media",
        mode: "auto",
        audio: undefined,
        staticHlsFallback: false,
        failedCandidates: [],
        originRecoveryUsed,
        accountChange: 0,
        nativeCredentialMode: "anonymous",
        nativeQualityMaxHeight: "auto",
        nativePlaybackMode: "auto",
      },
      {
        t0: performance.now(),
        startGeneration: generation.plan_generation,
        origin: "user_intent",
      },
    ).intent;
    controller.adoptIntent(owner);
    const request: PlaybackRequest = {
      ...generation,
      idempotency_key: key,
      room_id: "room",
      media_generation: 1,
      mode: "auto",
      position_ms: 0,
      audio_index: null,
      capabilities: {
        progressive_h264_aac: true,
        native_hls: false,
        mse_h264_aac: false,
      },
    };
    return { owner, request };
  }
  async function publish(key: string) {
    const selected = intent(key);
    const plan = await controller.prepare(selected.request);
    controller.adoptPlan(plan, selected.owner);
    controller.publishSession(plan);
    return { ...selected, plan };
  }
  return {
    controller,
    identity,
    api,
    saved,
    state,
    prepared,
    readiness,
    intent,
    publish,
  };
}

it("keeps canonical plan object identity and publishes SID through its sole readonly owner", async () => {
  const f = setup(),
    selected = f.intent("key-1");
  const plan = await f.controller.prepare(selected.request);
  expect(f.controller.plan()).toBeUndefined();
  expect(f.controller.sessionId.value).toBeNull();
  f.controller.adoptPlan(plan, selected.owner);
  expect(f.controller.plan()).toBe(plan);
  expect(f.controller.sessionId.value).toBeNull();
  f.controller.publishSession(plan);
  expect(f.controller.sessionId.value).toBe(plan.session_id);
  expect(isReadonly(f.controller.sessionId)).toBe(true);
  const retired = f.controller.retirePlan();
  expect(retired?.plan).toBe(plan);
  expect(f.controller.plan()).toBeUndefined();
  expect(f.controller.sessionId.value).toBeNull();
});

it("captured old SID/key cleanup survives cleared intent and cannot delete the successor", async () => {
  const f = setup(),
    first = await f.publish("key-1");
  const retired = f.controller.retirePlan()!,
    requests = f.controller.captureRequests()!;
  f.controller.clearIntent();
  const gate = deferred<unknown>(),
    events: string[] = [];
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) => {
    events.push(`${method} ${path}`);
    if (path === "/playback-sessions/session-1" && method === "DELETE")
      return gate.promise;
    return original(path, method, body);
  });
  const stopping = requests.stop(async () => {
    await retired.stop({ final: true });
  });
  const next = f.intent("key-2"),
    pending = f.controller.prepare(next.request);
  await vi.advanceTimersByTimeAsync(0);
  expect(events).not.toContain("POST /playback-sessions");
  gate.resolve({ ok: true });
  const [, plan] = await Promise.all([stopping, pending]);
  f.controller.adoptPlan(plan, next.owner);
  f.controller.publishSession(plan);
  expect(f.controller.plan()).toBe(plan);
  expect(events.indexOf("DELETE /playback-sessions/session-1")).toBeLessThan(
    events.indexOf("POST /playback-sessions"),
  );
  expect(events).not.toContain("DELETE /playback-requests/key-2");
  // The captured closure retains the original SID even if its old DTO is changed.
  first.plan.session_id = "mutated-old-object";
  await retired.stop();
  expect(events.at(-1)).toBe("DELETE /playback-sessions/session-1");
  expect(f.controller.sessionId.value).toBe("session-2");
});

it("old grant and key cleanup never borrows a newer exact login's credentials", async () => {
  const f = setup();
  const { plan } = await f.publish("key-1");
  const retired = f.controller.retirePlan()!,
    requests = f.controller.captureRequests()!;
  const before = f.api.mock.calls.length;
  ++f.identity.epoch;
  f.identity.userId = "new-viewer";
  await expect(retired.stop()).rejects.toBeInstanceOf(StaleIdentity);
  await expect(requests.stop()).rejects.toBeInstanceOf(StaleIdentity);
  expect(f.api).toHaveBeenCalledTimes(before);
  expect(f.saved.get("rainsync:playback:viewer")).toBe('["key-1"]');
  expect(f.controller.currentPlan(plan)).toBe(false);
});

it("a late POST response cannot publish preparation or replace a successor plan", async () => {
  const f = setup(),
    gate = deferred<PlaybackPlan>();
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) => {
    if (
      path === "/playback-sessions" &&
      (body as PlaybackRequest).plan_generation === 1
    )
      return gate.promise;
    return original(path, method, body);
  });
  const first = f.intent("key-1");
  const old = f.controller.prepare(first.request).catch((failure) => failure);
  await vi.waitFor(() =>
    expect(
      f.api.mock.calls.some(([path]) => path === "/playback-sessions"),
    ).toBe(true),
  );
  const next = await f.publish("key-2");
  gate.resolve(planFor(first.request));
  expect(await old).toBeInstanceOf(PlaybackCancelled);
  expect(f.controller.plan()).toBe(next.plan);
  expect(f.controller.sessionId.value).toBe(next.plan.session_id);
  expect(f.prepared.mock.calls.map(([plan]) => plan.session_id)).toEqual([
    next.plan.session_id,
  ]);
  expect(
    f.api.mock.calls.filter(([path]) => path === "/playback-sessions"),
  ).toHaveLength(2);
});

it("late readiness from a retired scope cannot update the successor's preparation", async () => {
  const f = setup(),
    ready = deferred<unknown>();
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) => {
    if (
      path === "/playback-sessions" &&
      (body as PlaybackRequest).plan_generation === 1
    )
      return planFor(body as PlaybackRequest, true);
    if (path.startsWith("/playback-sessions/session-1?")) return ready.promise;
    return original(path, method, body);
  });
  const first = f.intent("key-1");
  const old = f.controller.prepare(first.request).catch((failure) => failure);
  await vi.waitFor(() =>
    expect(
      f.api.mock.calls.some(([path]) =>
        path.startsWith("/playback-sessions/session-1?"),
      ),
    ).toBe(true),
  );
  const next = await f.publish("key-2");
  ready.resolve({
    session_id: "session-1",
    plan_generation: 1,
    status: "ready",
    complete: true,
  });
  expect(await old).toBeInstanceOf(PlaybackCancelled);
  expect(f.readiness).not.toHaveBeenCalled();
  expect(f.controller.plan()).toBe(next.plan);
});

it("ordinary renewal remains owned by its original plan and ignores a late failure", async () => {
  const f = setup(),
    old = await f.publish("key-1"),
    renewal = deferred<unknown>();
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) =>
    path === `/playback-sessions/${old.plan.session_id}` && method === "POST"
      ? renewal.promise
      : original(path, method, body),
  );
  const expired = vi.fn(),
    reload = vi.fn();
  const maintenance = f.controller.startMaintenance({
    tick: vi.fn(),
    observe: vi.fn(),
    sample: vi.fn(),
    visibilityChanged: vi.fn(),
    expired,
    reload,
  });
  stops.push(maintenance.stop);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(
    f.api.mock.calls.filter(
      ([path, method]) =>
        path === "/playback-sessions/session-1" && method === "POST",
    ),
  ).toHaveLength(1);
  f.controller.retirePlan();
  const next = await f.publish("key-2");
  renewal.reject(new RequestFailure({ error: { code: "SESSION_EXPIRED" } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(expired).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(f.controller.plan()).toBe(next.plan);
});

it("an unretired old plan cannot renew under a replacement login", async () => {
  const f = setup();
  await f.publish("key-1");
  ++f.identity.epoch;
  const before = f.api.mock.calls.length,
    expired = vi.fn();
  const maintenance = f.controller.startMaintenance({
    tick: vi.fn(),
    observe: vi.fn(),
    sample: vi.fn(),
    visibilityChanged: vi.fn(),
    expired,
    reload: vi.fn(),
  });
  stops.push(maintenance.stop);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(f.api).toHaveBeenCalledTimes(before);
  expect(expired).not.toHaveBeenCalled();
});

it("only the dedicated pre-mutation origin rejection may rotate an unused current viewer", () => {
  const f = setup(),
    selected = f.intent("key-1");
  const raw = new RequestFailure({
    error: { code: "PLAYBACK_VIEWER_ORIGIN_REQUIRED" },
  });
  expect(f.controller.rotateViewerOrigin(raw, selected.owner)).toBe(false);
  expect(f.controller.nextPlan().viewer_id).toBe(selected.request.viewer_id);
  expect(
    f.controller.rotateViewerOrigin(
      new PlaybackViewerOriginRequired(raw),
      selected.owner,
    ),
  ).toBe(true);
  expect(
    f.controller.rotateViewerOrigin(
      new PlaybackViewerOriginRequired(raw),
      selected.owner,
    ),
  ).toBe(false);
  const fresh = f.controller.nextPlan();
  expect(fresh.viewer_id).not.toBe(selected.request.viewer_id);
  expect(fresh.plan_generation).toBe(1);
  const retried = f.intent("retry", true);
  expect(
    f.controller.rotateViewerOrigin(
      new PlaybackViewerOriginRequired(raw),
      retried.owner,
    ),
  ).toBe(false);
});

it("an uncertain request never replays under a newly selected intent owner", async () => {
  const f = setup();
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) => {
    if (path === "/playback-sessions") throw new TypeError("lost response");
    return original(path, method, body);
  });
  const first = f.intent("original-key");
  const pending = f.controller
    .prepare(first.request)
    .catch((failure) => failure);
  await vi.waitFor(() =>
    expect(
      f.api.mock.calls.some(([path]) => path === "/playback-sessions"),
    ).toBe(true),
  );
  const next = f.intent("next-key");
  await vi.advanceTimersByTimeAsync(2500);
  expect(await pending).toBeInstanceOf(PlaybackCancelled);
  expect(
    f.api.mock.calls.filter(([path]) => path === "/playback-sessions"),
  ).toHaveLength(1);
  expect(f.controller.intent()).toBe(next.owner);
  expect(f.controller.plan()).toBeUndefined();
  expect(f.prepared).not.toHaveBeenCalled();
});

it("queued readiness cannot borrow a successor selected before its prepare begins", async () => {
  const f = setup();
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) => {
    if (path === "/playback-sessions")
      return planFor(body as PlaybackRequest, true);
    if (path.startsWith("/playback-sessions/session-1?"))
      return { session_id: "session-1", plan_generation: 1, status: "queued" };
    return original(path, method, body);
  });
  const first = f.intent("original-key");
  const pending = f.controller
    .prepare(first.request)
    .catch((failure) => failure);
  await vi.waitFor(() => expect(f.readiness).toHaveBeenCalledOnce());
  const next = f.intent("next-key");
  await vi.advanceTimersByTimeAsync(2500);
  expect(await pending).toBeInstanceOf(PlaybackCancelled);
  expect(
    f.api.mock.calls.filter(([path]) =>
      path.startsWith("/playback-sessions/session-1?"),
    ),
  ).toHaveLength(1);
  expect(f.readiness).toHaveBeenCalledOnce();
  expect(f.controller.intent()).toBe(next.owner);
});

it("late POST completion after acknowledged Stop cannot resurrect an adoptable session", async () => {
  const f = setup(),
    result = deferred<PlaybackPlan>();
  const original = f.api.getMockImplementation()!;
  f.api.mockImplementation(async (path, method, body) =>
    path === "/playback-sessions"
      ? result.promise
      : original(path, method, body),
  );
  const first = f.intent("key-1");
  const pending = f.controller
    .prepare(first.request)
    .catch((failure) => failure);
  await vi.waitFor(() =>
    expect(
      f.api.mock.calls.some(([path]) => path === "/playback-sessions"),
    ).toBe(true),
  );
  await f.controller.captureRequests()!.stop();
  const late = planFor(first.request);
  result.resolve(late);
  expect(await pending).toBeInstanceOf(PlaybackCancelled);
  expect(() => f.controller.adoptPlan(late, first.owner)).toThrow(
    PlaybackCancelled,
  );
  expect(f.controller.plan()).toBeUndefined();
  expect(f.prepared).not.toHaveBeenCalled();
});

it("guaranteed pre-mutation origin rejection forgets only its uncreated key binding", async () => {
  const f = setup(),
    original = f.api.getMockImplementation()!;
  let rejectOrigin = true;
  f.api.mockImplementation(async (path, method, body) => {
    if (path === "/playback-sessions" && rejectOrigin) {
      rejectOrigin = false;
      throw new RequestFailure({
        error: { code: "PLAYBACK_VIEWER_ORIGIN_REQUIRED" },
      });
    }
    return original(path, method, body);
  });
  const first = f.intent("uncreated-key");
  await expect(f.controller.prepare(first.request)).rejects.toBeInstanceOf(
    PlaybackViewerOriginRequired,
  );
  const next = await f.publish("uncreated-key");
  expect(f.controller.plan()).toBe(next.plan);
  expect(
    f.api.mock.calls.filter(([path]) => path === "/playback-sessions"),
  ).toHaveLength(2);
  expect(
    f.api.mock.calls.some(
      ([path, method]) =>
        path === "/playback-requests/uncreated-key" && method === "DELETE",
    ),
  ).toBe(false);
});

function finiteControllerIdentity(
  context: Parameters<typeof createPlaybackSessionController>[0],
) {
  // @ts-expect-error Session admission reads identity; it cannot mutate authentication.
  context.identity.invalidate(new Error("not owned"));
  // @ts-expect-error The application owns the exact-login lifecycle subscription.
  context.identity.subscribeInvalidation(() => {});
}
void finiteControllerIdentity;
