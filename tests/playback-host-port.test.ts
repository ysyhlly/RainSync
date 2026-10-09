import { afterEach, expect, it, vi } from "vitest";
import { ref } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import {
  createPlaybackHostPort,
  type PlaybackHostPort,
} from "../apps/web/src/features/playback/playback-host-port";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";

type Context = Parameters<typeof createPlaybackHostPort>[0];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("Host port construction reads no owner, action or child and keeps live original facts", () => {
  const reads: string[] = [];
  const room = ref({ id: "room", name: "Room" });
  const subtitles = ref([
    {
      index: 4,
      label: "English",
      language: "en",
      codec: "webvtt",
      url: "/subtitle.vtt",
    },
  ]);
  const preparation = ref<any>({ phase: "idle" });
  const playback = { subtitles, preparation, recoveryLabel: ref("recovering") };
  const controls = {} as Context["playbackControls"],
    settings = {} as Context["playbackSettings"];
  const port = createPlaybackHostPort({
    timeline: new Proxy(
      { room },
      {
        get(target, key) {
          reads.push(`timeline:${String(key)}`);
          return target[key as keyof typeof target];
        },
      },
    ) as unknown as Context["timeline"],
    playback: new Proxy(playback, {
      get(target, key) {
        reads.push(`playback:${String(key)}`);
        return target[key as keyof typeof target];
      },
    }) as unknown as Context["playback"],
    notice: { error: ref("original notice"), errorNotice: ref(undefined) },
    actions: new Proxy(
      {},
      {
        get() {
          throw Error(
            "No action lookup at construction or while reading facts",
          );
        },
      },
    ) as Context["actions"],
    get playbackControls() {
      reads.push("controls");
      return controls;
    },
    get playbackSettings() {
      reads.push("settings");
      return settings;
    },
  });
  expect(reads).toEqual([]);
  expect(port.room).toBe(room.value);
  expect(port.subtitles).toBe(subtitles.value);
  expect(port.preparation).toBe(preparation.value);
  expect(port.notice.preparation).toBe(preparation.value);
  expect(port.information.recoveryLabel).toBe("recovering");
  expect(port.playbackControls).toBe(controls);
  expect(port.playbackSettings).toBe(settings);
  room.value.name = "Updated";
  preparation.value = {
    phase: "failed",
    failure: { message: "Later failure", retryable: false },
  };
  expect(port.room?.name).toBe("Updated");
  expect(port.preparation.failure?.message).toBe("Later failure");
  expect(port.notice.preparation).toBe(preparation.value);
});

const deleted = [
  "blocked",
  "dragging",
  "platformDanmakuEnabled",
  "platformDanmakuCues",
  "subtitles",
  "subtitleIndex",
  "preparation",
  "loadingStage",
  "startupDiagnostics",
  "cancelPreparation",
  "enablePlayback",
  "applySubtitles",
  "distributedFacts",
  "peerStats",
  "peerSharing",
  "useDistributedOutput",
  "useOriginalSource",
  "startPeerSharing",
  "stopPeerSharing",
  "live",
  "audioIndex",
  "duration",
  "playbackSummary",
  "nativePlaybackMode",
  "position",
] as const;
const retained = [
  "runPlayback",
  "waiting",
  "nativePlatform",
  "sessionId",
  "recoveryState",
  "recoveryLabel",
  "loadMedia",
  "attach",
] as const;

it("real composition keeps retired aliases absent and shares original named Host action wrappers", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const pinia = createPinia();
  setActivePinia(pinia);
  useSession().accept({
    id: "viewer",
    username: "viewer",
    admin: false,
    csrf: "synthetic-host-port",
  });
  const runtime = useRoomRuntime();
  try {
    expect(deleted).toHaveLength(25);
    expect(retained).toHaveLength(8);
    for (const key of deleted) expect(key in runtime, key).toBe(false);
    for (const key of retained) expect(key in runtime, key).toBe(true);
    const port = runtime.playbackHost;
    expect(port.attach).toBe(runtime.attach);
    expect(port.can).toBe(runtime.can);
    expect(port.notice.dismissError).toBe(runtime.dismissError);
    expect(port.playbackControls).toBe(runtime.playbackControls);
    expect(port.playbackSettings).toBe(runtime.playbackSettings);
    const names: string[] = [];
    runtime.$onAction(({ name, store }) => {
      expect(store).toBe(runtime);
      names.push(name);
    });
    await port.joinPlayback();
    expect(names).toEqual(["runPlayback", "enablePlayback"]);
    names.length = 0;
    await port.retryPlayback();
    expect(names).toEqual(["runPlayback", "loadMedia"]);
    names.length = 0;
    await port.cancelPlayback();
    expect(names).toEqual(["runPlayback", "cancelPreparation"]);
    names.length = 0;
    port.applySubtitles();
    expect(names).toEqual(["applySubtitles"]);
    names.length = 0;
    port.can("seek");
    port.notice.dismissError(undefined);
    expect(names).toEqual(["can", "dismissError"]);
    expect(runtime.busy).toBe(false);
    for (const key of deleted) expect(key in runtime, key).toBe(false);
  } finally {
    await runtime.leave();
    disposePinia(pinia);
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  }
});

function consumerContract(
  host: PlaybackHostPort,
  ctx: Context,
  runtime: ReturnType<typeof useRoomRuntime>,
  element: HTMLVideoElement,
) {
  const id: string | null | undefined = host.state?.media_id;
  const name: string | undefined = host.room?.name;
  const label: string = host.information.recoveryLabel;
  host.attach(element);
  host.setWaiting(false);
  host.closeSubtitles();
  host.seekDanmaku(10);
  void [id, name, label];
  // @ts-expect-error No raw element getter or independent physical actuation.
  host.video;
  // @ts-expect-error No generic request/command/runner authority.
  host.api;
  // @ts-expect-error No generic command bridge.
  host.send("PLAY");
  // @ts-expect-error No arbitrary runner callback.
  host.runPlayback(async () => {});
  // @ts-expect-error The Host cannot create or replace sessions.
  host.loadMedia();
  // @ts-expect-error No full room ownership/lifecycle object.
  host.room!.owner_id;
  // @ts-expect-error Only Host's five original permission queries are exposed.
  host.can("manage_members");
  // @ts-expect-error No room projection mutation.
  host.state!.media_id = "other";
  // @ts-expect-error Waiting writes require the finite event operation.
  host.waiting = true;
  // @ts-expect-error Session identity is an observation only.
  host.sessionId = "other";
  // @ts-expect-error No direct subtitle draft mutation.
  host.subtitleIndex = 2;
  // @ts-expect-error Subtitle facts remain deeply readonly.
  host.subtitles[0].url = "/other.vtt";
  // @ts-expect-error Preparation facts do not expose owner mutation.
  host.preparation.failure!.message = "other";
  // @ts-expect-error Nested interaction option arrays are readonly.
  host.platformDanmakuCues[0].interaction!.options.push("other");
  // @ts-expect-error Nested scene nodes are readonly too.
  host.platformDanmakuCues[0].scene!.nodes[0].animations.push({});
  // @ts-expect-error Scoped presentation has no error setter.
  host.notice.error = "other";
  // @ts-expect-error No mutable recovery presentation.
  host.information.recoveryLabel = "other";
  // @ts-expect-error Factory receives readonly facts except its two finite writes.
  ctx.playback.blocked.value = true;
  // @ts-expect-error Nested owned facts remain readonly inside the adapter.
  ctx.playback.preparation.value.phase = "failed";
  // @ts-expect-error The old unused flat alias is retired.
  runtime.applySubtitles();
  // @ts-expect-error The old mutable preparation alias is retired.
  runtime.preparation.phase = "failed";
}
void consumerContract;
