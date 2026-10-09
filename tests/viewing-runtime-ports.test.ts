import type { createPlatformTextRuntime } from "../apps/web/src/features/playback/platform-text-runtime";
import type { PlatformTextGrant } from "../apps/web/src/features/playback/platform-text";
import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effectScope, proxyRefs, reactive, readonly, ref } from "vue";
import {
  createPlaybackIdentityPort,
  createViewingRuntime,
} from "../apps/web/src/app/viewing-runtime";
import type { PlaybackRuntimeContext } from "../apps/web/src/features/playback/playback-runtime-types";
import type { RoomState } from "../packages/protocol";
import { useRoomNotice } from "../apps/web/src/features/playback/room-notice";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { preparationFailure } from "../apps/web/src/features/playback/playback-preparation";
import { PlaybackCancelled } from "../apps/web/src/playback-request";
import { StaleIdentity } from "../apps/web/src/shared/api/client";

const stops: (() => void)[] = [];
afterEach(() => {
  stops
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function environment() {
  vi.useFakeTimers();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
}
function deferred() {
  let resolve!: () => void, reject!: (failure: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function viewing() {
  environment();
  const auth = reactive({ userId: "viewer" as string | undefined, epoch: 1 });
  const identity = createPlaybackIdentityPort(() => ({ ...auth }), vi.fn());
  const state = ref<RoomState | null>(null);
  const room = {
    error: ref(""),
    busy: ref(false),
    identityInvalidated: vi.fn(),
  };
  const scope = effectScope();
  stops.push(() => scope.stop());
  const context: PlaybackRuntimeContext = {
    identity,
    api: vi.fn().mockResolvedValue({}),
    timeline: {
      state: readonly(state),
      connected: readonly(ref(true)),
      active: readonly(ref(true)),
      clock: Object.freeze({ ready: true, revision: 1, now: () => 0 }),
    },
    commands: {},
  };
  const runtime = scope.run(() => createViewingRuntime(context, room))!;
  const notice = scope.run(() =>
    useRoomNotice(
      proxyRefs({
        error: runtime.error,
        errorNotice: runtime.errorNotice,
        dismissError: runtime.dismissError,
        preparation: runtime.playback.preparation,
      }),
    ),
  )!;
  return { auth, context, room, runtime, notice, scope, state };
}

// These are compiled by the P04 type gate, never run. The context exposes no
// authentication mutation, writable projection/clock, or borrowed status owner.
function finitePortContract(context: PlaybackRuntimeContext) {
  // @ts-expect-error No full store crosses the playback boundary.
  context.session.logout();
  // @ts-expect-error The playback owner creates its own error state.
  context.error.value = "shared";
  // @ts-expect-error The playback owner creates its own action runner.
  context.run(async () => {});
  if (context.timeline.state.value) {
    // @ts-expect-error The snapshot is deeply readonly.
    context.timeline.state.value.revision++;
    if (context.timeline.state.value.live) {
      // @ts-expect-error Nested live identity is readonly too.
      context.timeline.state.value.live.broadcast_id = "replacement";
    }
  }
  // @ts-expect-error Only RoomProjection can replace room state.
  context.timeline.state.value = null;
  // @ts-expect-error The clock port cannot be reset by playback.
  context.timeline.clock.reset();
  // @ts-expect-error Identity snapshots are immutable.
  context.identity.current().epoch++;
}
void finitePortContract;

it("identity snapshots are immutable and epoch invalidation runs before the next Vue tick", () => {
  const f = viewing();
  const old = f.context.identity.current();
  expect(Object.isFrozen(old)).toBe(true);
  f.runtime.playback.playbackError.value = "old login";
  ++f.auth.epoch;
  expect(f.room.identityInvalidated).toHaveBeenCalledOnce();
  expect(f.runtime.playback.playbackError.value).toBe("");
  expect(old).toEqual({ userId: "viewer", epoch: 1 });
  expect(f.context.identity.current().epoch).toBe(2);
  f.auth.userId = "replacement";
  expect(f.context.identity.current().userId).toBe("replacement");
  expect(f.room.identityInvalidated).toHaveBeenCalledOnce();
});

it("room and playback actions retain independent errors and busy ownership", async () => {
  const f = viewing(),
    pending = deferred();
  f.room.error.value = "room command failed";
  f.room.busy.value = true;
  const running = f.runtime.playback.runPlayback(() => pending.promise);
  expect(f.runtime.playback.playbackBusy.value).toBe(true);
  expect(f.room.busy.value).toBe(true);
  expect(f.room.error.value).toBe("room command failed");
  pending.reject(Error("playback failed"));
  await running;
  expect(f.runtime.playback.playbackError.value).toBe("playback failed");
  expect(f.runtime.error.value).toBe("playback failed");
  expect(f.runtime.playback.playbackBusy.value).toBe(false);
  expect(f.runtime.busy.value).toBe(true);
  f.room.busy.value = false;
  expect(f.runtime.busy.value).toBe(false);
  await f.runtime.playback.runPlayback(async () => {});
  expect(f.runtime.error.value).toBe("room command failed");
  expect(f.room.error.value).toBe("room command failed");
});

it("a stale dismissal cannot clear another error owner even when its text is identical", () => {
  const f = viewing();
  f.room.error.value = "same visible text";
  const old = f.notice.value!;
  f.runtime.playback.playbackError.value = "same visible text";
  const current = f.notice.value!;
  expect(current.key).not.toBe(old.key);
  expect(f.runtime.errorNotice.value?.owner).toBe("playback");
  old.dismiss();
  expect(f.runtime.playback.playbackError.value).toBe("same visible text");
  current.dismiss();
  expect(f.runtime.playback.playbackError.value).toBe("");
  expect(f.room.error.value).toBe("same visible text");
  expect(f.runtime.errorNotice.value?.owner).toBe("room");
});

it("the writable legacy error facade clears only the visible owner", () => {
  const f = viewing();
  f.runtime.error.value = "legacy room error";
  f.runtime.playback.playbackError.value = "new playback error";
  f.runtime.error.value = "";
  expect(f.runtime.playback.playbackError.value).toBe("");
  expect(f.room.error.value).toBe("legacy room error");
  expect(f.runtime.error.value).toBe("legacy room error");
});

it("old action failures and finalizers cannot overwrite a successor exact login", async () => {
  const f = viewing(),
    old = deferred(),
    current = deferred();
  const oldRun = f.runtime.playback.runPlayback(() => old.promise);
  ++f.auth.epoch;
  expect(f.runtime.playback.playbackBusy.value).toBe(false);
  const newRun = f.runtime.playback.runPlayback(() => current.promise);
  old.reject(Error("retired action"));
  await oldRun;
  expect(f.runtime.playback.playbackError.value).toBe("");
  expect(f.runtime.playback.playbackBusy.value).toBe(true);
  current.resolve();
  await newRun;
  expect(f.runtime.playback.playbackBusy.value).toBe(false);
});

it.each([new PlaybackCancelled(), new StaleIdentity()])(
  "expected cancellation stays inside the playback owner: %s",
  async (failure) => {
    const f = viewing();
    f.room.error.value = "unrelated room error";
    await f.runtime.playback.runPlayback(async () => {
      throw failure;
    });
    expect(f.runtime.playback.playbackError.value).toBe("");
    expect(f.runtime.error.value).toBe("unrelated room error");
  },
);

it("disposed playback actions cannot publish a late error or retain identity subscriptions", async () => {
  const f = viewing(),
    pending = deferred();
  const running = f.runtime.playback.runPlayback(() => pending.promise);
  f.scope.stop();
  ++f.auth.epoch;
  pending.reject(Error("after disposal"));
  await running;
  const staleAction = vi.fn(async () => {});
  await f.runtime.playback.runPlayback(staleAction);
  expect(staleAction).not.toHaveBeenCalled();
  expect(f.runtime.playback.playbackError.value).toBe("");
  expect(f.room.identityInvalidated).not.toHaveBeenCalled();
});

it("the room facade begins leaving synchronously when the exact-login epoch changes", () => {
  environment();
  const pinia = createPinia();
  setActivePinia(pinia);
  stops.push(() => disposePinia(pinia));
  const session = useSession();
  session.accept({
    id: "viewer",
    username: "viewer",
    admin: false,
    csrf: "fixture",
  });
  session.api = vi.fn().mockResolvedValue([]);
  const room = useRoomRuntime();
  room.room = { id: "old-room", name: "Old", owner_id: "viewer" };
  room.state = {
    room_id: "old-room",
    revision: 1,
    media_id: null,
    media_generation: 0,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "viewer",
    duration_ms: null,
    clock_epoch: "clock",
  };
  room.error = "existing account failure";
  session.clear();
  expect(room.error).toBe("existing account failure");
  expect(room.room).toBeNull();
  expect(room.state).toBeNull();
  expect(room.connected).toBe(false);
});

it("a preparation failure hides only its own playback notice, never equal room text", () => {
  const f = viewing();
  const message = "same originating message";
  f.runtime.playback.preparation.value = {
    phase: "failed",
    generation: 1,
    failure: preparationFailure(Error(message)),
  };
  f.runtime.playback.playbackError.value = message;
  expect(f.notice.value).toBeUndefined();
  f.room.error.value = message;
  expect(f.runtime.errorNotice.value?.owner).toBe("room");
  expect(f.notice.value?.message).toBe(message);
});

it.each(["SEEK", "PLAY"])(
  "a WS %s projection reports apply failure through playback's owner",
  async (action) => {
    environment();
    vi.stubGlobal("navigator", {});
    const pinia = createPinia();
    setActivePinia(pinia);
    stops.push(() => disposePinia(pinia));
    const session = useSession();
    session.accept({
      id: "viewer",
      username: "viewer",
      admin: false,
      csrf: "fixture",
    });
    const media = {
      id: "media",
      kind: "file",
      title: "Fixture",
      duration_ms: 45_000,
      original_title: "Fixture",
      shared_title: null,
      shared_title_revision: "0",
      personal_title: null,
      personal_title_revision: "0",
      cover: {
        status: "missing",
        revision: null,
        url: null,
        retry_after_ms: null,
      },
    };
    session.api = vi.fn(
      async (path: string, method = "GET", body?: unknown) => {
        if (path.includes("/media/")) return media;
        if (path.endsWith("/playlist")) return [];
        if (path === "/playback-sessions" && method === "POST") {
          const request = body as {
            plan_generation: number;
            media_generation: number;
          };
          return {
            session_id: "fixture-playback",
            media_id: media.id,
            media_generation: request.media_generation,
            plan_generation: request.plan_generation,
            transport: "progressive",
            delivery_mode: "direct",
            playback_url: "/fixture.mp4",
            timeline_origin_ms: 0,
            duration_ms: 45_000,
            expires_in_seconds: 120,
            rebuild_on_seek: false,
            audio_tracks: [],
            subtitle_tracks: [],
          };
        }
        return {};
      },
    ) as typeof session.api;
    const sockets: {
      send: ReturnType<typeof vi.fn>;
      onopen: () => void;
      onmessage: (event: { data: string }) => void;
    }[] = [];
    class Socket {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      send = vi.fn();
      close = vi.fn();
      onopen = () => {};
      onmessage = (_event: { data: string }) => {};
      constructor() {
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", Socket);
    const playback = useRoomRuntime();
    const pending = deferred();
    const element = Object.assign(new EventTarget(), {
      src: "",
      readyState: 4,
      paused: true,
      seeking: false,
      ended: false,
      duration: 45,
      currentTime: 1,
      playbackRate: 1,
      seekable: { length: 1, start: () => 0, end: () => 45 },
      buffered: { length: 1, start: () => 0, end: () => 45 },
      canPlayType: () => "probably",
      querySelectorAll: () => [],
      load: vi.fn(),
      pause: vi.fn(() => {
        element.paused = true;
      }),
      play: vi.fn(() => pending.promise),
      getAttribute: (name: string) => (name === "src" ? element.src : null),
      removeAttribute: (name: string) => {
        if (name === "src") element.src = "";
      },
    });
    playback.attach(element as unknown as HTMLVideoElement);
    await playback.enter({
      id: "room",
      name: "Fixture room",
      owner_id: "viewer",
    });
    const socket = sockets[0];
    socket.onopen();
    const state: RoomState = {
      room_id: "room",
      revision: 1,
      media_id: media.id,
      media_generation: 1,
      playback_status: "paused",
      anchor_position_ms: 1000,
      anchor_server_time_ms: 0,
      playback_rate: 1,
      controller_user_id: "viewer",
      duration_ms: 45_000,
      clock_epoch: "clock",
    };
    const frame = (value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    frame({ type: "SNAPSHOT", state, control_epoch: { id: "control" } });
    const clockRequest = socket.send.mock.calls
      .map(([value]) => JSON.parse(value as string))
      .find((value) => value.type === "CLOCK_SYNC");
    expect(clockRequest).toBeDefined();
    frame({
      type: "CLOCK_SYNC_REPLY",
      t1: clockRequest.t1,
      t2: 0,
      t3: 0,
      clock_epoch: "clock",
    });
    await vi.waitFor(() => expect(playback.sessionId).toBe("fixture-playback"));
    await vi.advanceTimersByTimeAsync(0);
    playback.roomError = "unrelated room failure";
    // Exercise the public playback action instead of exposing its error writer
    // through every room page solely for this fixture.
    await playback.runPlayback(async () => {
      throw Error("retained automatic playback notice");
    });
    frame({
      type: "EVENT",
      action: { type: action },
      state: { ...state, revision: 2, playback_status: "playing" },
    });
    expect(element.play).toHaveBeenCalledOnce();
    expect(playback.roomBusy).toBe(false);
    expect(playback.busy).toBe(action === "SEEK");
    expect(playback.errorNotice).toMatchObject({
      owner: "playback",
      message: "retained automatic playback notice",
    });
    pending.reject(Error("projection apply failed"));
    await vi.waitFor(() =>
      expect(playback.error).toBe("projection apply failed"),
    );
    expect(playback.roomError).toBe("unrelated room failure");
    expect(playback.errorNotice?.owner).toBe("playback");
    expect(playback.busy).toBe(false);
  },
);

function finitePlatformTextInputs(
  context: Parameters<typeof createPlatformTextRuntime>[0],
  grant: PlatformTextGrant,
) {
  if (context.video.value) {
    // @ts-expect-error Text observes time; synchronization owns seeking.
    context.video.value.currentTime = 10;
    // @ts-expect-error Source attachment is not a text capability.
    context.video.value.src = "/replacement.mp4";
    // @ts-expect-error Autoplay remains with the application.
    context.video.value.play();
    context.video.value.addTextTrack("subtitles");
  }
  // @ts-expect-error Text cannot replace the permanent media element.
  context.video.value = undefined;
  const signal = new AbortController().signal;
  context.api("/catalog", "GET", undefined, signal);
  // @ts-expect-error Text's JSON reader cannot submit a mutation.
  context.api("/playback-sessions", "POST", undefined, signal);
  // @ts-expect-error The read port accepts no request body.
  context.api("/catalog", "GET", { unauthorized: true }, signal);
  // @ts-expect-error The read port cannot supply arbitrary credentials/headers.
  context.api("/catalog", "GET", undefined, signal, {
    authorization: "unowned",
  });
  // @ts-expect-error Responses stay unknown until the existing parser validates them.
  context.api<{ unauthorized: true }>("/catalog", "GET", undefined, signal);
  // @ts-expect-error The session owner controls SID and grant identity.
  grant.session_id = "replacement";
  if (grant.native_platform?.live) {
    // @ts-expect-error Broadcast ownership cannot be rewritten by captions.
    grant.native_platform.live.broadcast_id = "replacement";
  }
  if (grant.native_platform?.compatibility?.output) {
    // @ts-expect-error The granted output attempt is immutable.
    grant.native_platform.compatibility.output.attempt = 2;
  }
  // @ts-expect-error Text does not own or consume server plan generation.
  grant.plan_generation;
  // @ts-expect-error Decoder/worker fallback policy does not belong to text.
  grant.decoder_fallback_modes;
  // @ts-expect-error Quality selection is outside the text grant view.
  grant.native_platform?.quality;
}
void finitePlatformTextInputs;
