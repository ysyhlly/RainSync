import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { ref, type Ref } from "vue";
import {
  createPlaybackRoomPort,
  type PlaybackRoomPort,
} from "../apps/web/src/features/playback/playback-room-port";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";

type Context = Parameters<typeof createPlaybackRoomPort>[0];
const factKeys = [
  "nativePlaybackMode",
  "duration",
  "live",
  "audioIndex",
  "playbackSummary",
  "recoveryLabel",
  "distributedFacts",
  "peerSharing",
  "peerStats",
] as const;
const actionKeys = [
  "useDistributedOutput",
  "useOriginalSource",
  "startPeerSharing",
  "stopPeerSharing",
] as const;
const portKeys = [...factKeys, ...actionKeys];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("constructs a passive thirteen-key view with exact lazy fact reads and live original objects", () => {
  vi.useFakeTimers();
  const reads: string[] = [];
  const summary = ref({ mode: "direct", reason: "owner-only reason" });
  const distributed = ref({
    job_id: "first-job",
    output_generation: "first-output",
  });
  const stats = ref({
    peerBytes: 1,
    httpBytes: 2,
    uploadedBytes: 3,
    duplicateBytes: 4,
    badHashes: 5,
    fallbacks: 6,
  });
  const facts = {
    nativePlaybackMode:
      ref<Context["playback"]["nativePlaybackMode"]["value"]>("auto"),
    duration: ref(120),
    live: ref(false),
    audioIndex: ref<number | undefined>(0),
    playbackSummary: summary,
    recoveryLabel: ref<Context["playback"]["recoveryLabel"]["value"]>(
      "正在重新校准房间时间…",
    ),
    distributedFacts: distributed,
    peerSharing: ref(false),
    peerStats: stats,
  };
  function tracedRef<T>(name: string, value: Ref<T>) {
    return new Proxy(value, {
      get(target, key) {
        reads.push(`${name}:${String(key)}`);
        return Reflect.get(target, key, target);
      },
    });
  }
  const playback = new Proxy(facts, {
    get(target, key: keyof typeof facts) {
      reads.push(`playback:${key}`);
      return tracedRef(key, target[key] as Ref<unknown>);
    },
  });
  const port = createPlaybackRoomPort({
    get playback() {
      reads.push("context:playback");
      return playback;
    },
    get actions(): Context["actions"] {
      throw Error("Fact reads must not look up actions");
    },
  });
  expect(Object.keys(port)).toEqual(portKeys);
  expect(portKeys).toHaveLength(13);
  expect(reads).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  for (const key of factKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(port, key)!;
    expect(descriptor.get).toBeTypeOf("function");
    expect(descriptor.set).toBeUndefined();
    expect(port[key]).toBe(facts[key].value);
  }
  expect(reads).toEqual(
    factKeys.flatMap((key) => [
      "context:playback",
      `playback:${key}`,
      `${key}:value`,
    ]),
  );

  reads.length = 0;
  expect(port.duration > 0 ? port.duration : 1).toBe(120);
  expect(port.playbackSummary && port.playbackSummary.mode).toBe("direct");
  expect(reads).toEqual(
    ["duration", "duration", "playbackSummary", "playbackSummary"].flatMap(
      (key) => ["context:playback", `playback:${key}`, `${key}:value`],
    ),
  );
  // These are narrow type views of the owner's objects, not runtime copies.
  expect(port.playbackSummary).toBe(summary.value);
  expect(Object.keys(port.playbackSummary!)).toEqual(["mode", "reason"]);
  expect(port.distributedFacts).toBe(distributed.value);
  expect(Object.keys(port.distributedFacts!)).toEqual([
    "job_id",
    "output_generation",
  ]);
  expect(port.peerStats).toBe(stats.value);
  summary.value.mode = "remux";
  distributed.value.job_id = "updated-job";
  stats.value.peerBytes = 42;
  expect(port.playbackSummary?.mode).toBe("remux");
  expect(port.distributedFacts?.job_id).toBe("updated-job");
  expect(port.peerStats?.peerBytes).toBe(42);

  summary.value = { mode: "transcode", reason: "replacement reason" };
  distributed.value = {
    job_id: "replacement-job",
    output_generation: "next-output",
  };
  stats.value = { ...stats.value, uploadedBytes: 99 };
  facts.nativePlaybackMode.value = "native";
  facts.duration.value = 0;
  facts.live.value = true;
  facts.audioIndex.value = undefined;
  facts.recoveryLabel.value = "";
  facts.peerSharing.value = true;
  for (const key of factKeys) expect(port[key]).toBe(facts[key].value);
  expect(port.playbackSummary?.mode).toBe("transcode");
  expect(port.distributedFacts?.job_id).toBe("replacement-job");
  expect(port.peerStats?.uploadedBytes).toBe(99);
  expect(vi.getTimerCount()).toBe(0);
});

it("returns original lazy callbacks and their exact promises, arguments and rejection", async () => {
  const reads: string[] = [];
  const distributedResult = Promise.resolve();
  const originalResult = Promise.resolve();
  const stopResult = Promise.resolve();
  let rejectSharing!: (error: Error) => void;
  const sharingResult = new Promise<void>((_, reject) => {
    rejectSharing = reject;
  });
  const actions = {
    useDistributedOutput: vi.fn<Context["actions"]["useDistributedOutput"]>(
      () => distributedResult,
    ),
    useOriginalSource: vi.fn<Context["actions"]["useOriginalSource"]>(
      () => originalResult,
    ),
    startPeerSharing: vi.fn<Context["actions"]["startPeerSharing"]>(
      () => sharingResult,
    ),
    stopPeerSharing: vi.fn<Context["actions"]["stopPeerSharing"]>(
      () => stopResult,
    ),
  };
  const actionTable = new Proxy(actions, {
    get(target, key: keyof typeof actions) {
      reads.push(`actions:${key}`);
      return target[key];
    },
  });
  const port = createPlaybackRoomPort({
    get playback(): Context["playback"] {
      throw Error("Action access must not read playback facts");
    },
    get actions() {
      reads.push("context:actions");
      return actionTable;
    },
  });
  expect(reads).toEqual([]);
  for (const key of actionKeys) {
    expect(port[key]).toBe(actions[key]);
    expect(port[key]).toBe(actions[key]);
    expect(actions[key]).not.toHaveBeenCalled();
  }
  expect(reads).toEqual(
    actionKeys.flatMap((key) => [
      "context:actions",
      `actions:${key}`,
      "context:actions",
      `actions:${key}`,
    ]),
  );
  const intent = {
    schema_version: 1,
    job_id: "job",
    output_generation: "output",
  };
  expect(port.useDistributedOutput(intent)).toBe(distributedResult);
  expect(port.useDistributedOutput(intent, null)).toBe(distributedResult);
  expect(port.useDistributedOutput(intent, 0)).toBe(distributedResult);
  expect(actions.useDistributedOutput.mock.calls).toEqual([
    [intent],
    [intent, null],
    [intent, 0],
  ]);
  for (const [value] of actions.useDistributedOutput.mock.calls)
    expect(value).toBe(intent);
  expect(port.useOriginalSource()).toBe(originalResult);
  expect(port.stopPeerSharing()).toBe(stopResult);
  const consent = {
    acknowledge_peer_addresses: true,
    confirm_current_network: true,
    upload_allowed: true,
  };
  const result = port.startPeerSharing(consent);
  expect(result).toBe(sharingResult);
  expect(actions.startPeerSharing.mock.calls).toEqual([[consent]]);
  expect(actions.startPeerSharing.mock.calls[0][0]).toBe(consent);
  const failure = Error("original rejection");
  const rejected = expect(result).rejects.toBe(failure);
  rejectSharing(failure);
  await rejected;
  await Promise.all([distributedResult, originalResult, stopResult]);

  const captured = port.useOriginalSource;
  const replacementResult = Promise.resolve();
  actions.useOriginalSource = vi.fn(() => replacementResult);
  expect(port.useOriginalSource).toBe(actions.useOriginalSource);
  expect(port.useOriginalSource).not.toBe(captured);
  expect(captured()).toBe(originalResult);
  expect(port.useOriginalSource()).toBe(replacementResult);
});

const removedAliases = [
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
] as const;
const retainedAliases = [
  "runPlayback",
  "loadMedia",
  "attach",
  "sessionId",
  "waiting",
  "recoveryState",
  "nativePlatform",
  "nativePlaybackMode",
  "position",
  "recoveryLabel",
] as const satisfies readonly (keyof ReturnType<typeof useRoomRuntime>)[];

it("real composition removes eleven aliases, retains ten and emits each original action hook once", async () => {
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
    csrf: "room-port-contract",
  });
  const runtime = useRoomRuntime();
  try {
    expect(removedAliases).toHaveLength(11);
    expect(retainedAliases).toHaveLength(10);
    for (const key of removedAliases) expect(key in runtime, key).toBe(false);
    for (const key of retainedAliases) expect(key in runtime, key).toBe(true);
    const port = runtime.playbackRoom;
    expect(Object.keys(port)).toEqual(portKeys);
    for (const key of actionKeys) expect(port[key]).toBe(port[key]);
    const calls: { name: string; args: unknown[] }[] = [];
    const settled: { name: string; result?: unknown; error?: unknown }[] = [];
    const unsubscribe = runtime.$onAction(
      ({ name, store, args, after, onError }) => {
        expect(store).toBe(runtime);
        calls.push({ name, args });
        after((result) => settled.push({ name, result }));
        onError((error) => settled.push({ name, error }));
      },
    );
    const intent = {
      schema_version: 1,
      job_id: "11111111-1111-4111-8111-111111111111",
      output_generation: "22222222-2222-4222-8222-222222222222",
    };
    const consent = {
      acknowledge_peer_addresses: true,
      confirm_current_network: true,
      upload_allowed: true,
    };
    await port.useDistributedOutput(intent, 0);
    await port.useOriginalSource();
    await port.stopPeerSharing();
    await expect(port.startPeerSharing(consent)).rejects.toThrow(
      "当前主播放器不能启用 P2P 分片共享",
    );
    expect(calls).toEqual([
      { name: "useDistributedOutput", args: [intent, 0] },
      { name: "useOriginalSource", args: [] },
      { name: "stopPeerSharing", args: [] },
      { name: "startPeerSharing", args: [consent] },
    ]);
    expect(calls[0].args[0]).toBe(intent);
    expect(calls[3].args[0]).toBe(consent);
    expect(settled).toEqual([
      { name: "useDistributedOutput", result: undefined },
      { name: "useOriginalSource", result: undefined },
      { name: "stopPeerSharing", result: undefined },
      {
        name: "startPeerSharing",
        error: expect.objectContaining({
          message: "当前主播放器不能启用 P2P 分片共享",
        }),
      },
    ]);
    expect(runtime.busy).toBe(false);
    expect(runtime.error).toBe("");
    for (const key of removedAliases) expect(key in runtime, key).toBe(false);
    unsubscribe();
  } finally {
    await runtime.leave();
    disposePinia(pinia);
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  }
});

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

function consumerContract(
  room: PlaybackRoomPort,
  ctx: Context,
  runtime: ReturnType<typeof useRoomRuntime>,
) {
  const exactKeys: Equal<keyof PlaybackRoomPort, (typeof portKeys)[number]> =
    true;
  const exactSummary: Equal<
    keyof NonNullable<PlaybackRoomPort["playbackSummary"]>,
    "mode"
  > = true;
  const exactDistributed: Equal<
    keyof NonNullable<PlaybackRoomPort["distributedFacts"]>,
    "job_id"
  > = true;
  const aliasesAbsent: Equal<
    Extract<keyof typeof runtime, (typeof removedAliases)[number]>,
    never
  > = true;
  const mode: string | undefined = room.playbackSummary?.mode;
  const job: string | undefined = room.distributedFacts?.job_id;
  const peerBytes: number | undefined = room.peerStats?.peerBytes;
  const activate: Context["actions"]["useDistributedOutput"] =
    room.useDistributedOutput;
  const original: Context["actions"]["useOriginalSource"] =
    room.useOriginalSource;
  const share: Context["actions"]["startPeerSharing"] = room.startPeerSharing;
  const stop: Context["actions"]["stopPeerSharing"] = room.stopPeerSharing;
  void [
    exactKeys,
    exactSummary,
    exactDistributed,
    aliasesAbsent,
    mode,
    job,
    peerBytes,
    activate,
    original,
    share,
    stop,
  ];
  // @ts-expect-error Staged preferences are observations, not writable drafts.
  room.nativePlaybackMode = "auto";
  // @ts-expect-error Duration is an observation.
  room.duration = 1;
  // @ts-expect-error Live status is an observation.
  room.live = true;
  // @ts-expect-error Audio changes belong to the original finite operation.
  room.audioIndex = 1;
  // @ts-expect-error Summary facts cannot be replaced.
  room.playbackSummary = undefined;
  // @ts-expect-error Recovery presentation cannot be mutated.
  room.recoveryLabel = "other";
  // @ts-expect-error Distributed facts cannot be replaced.
  room.distributedFacts = undefined;
  // @ts-expect-error Sharing changes belong to the original finite operations.
  room.peerSharing = true;
  // @ts-expect-error Statistics cannot be replaced.
  room.peerStats = undefined;
  // @ts-expect-error Nested summary facts are readonly.
  room.playbackSummary!.mode = "other";
  // @ts-expect-error Nested job facts are readonly.
  room.distributedFacts!.job_id = "other";
  // @ts-expect-error Nested statistics are readonly.
  room.peerStats!.uploadedBytes = 1;
  // @ts-expect-error RoomPage consumes only the summary mode.
  room.playbackSummary!.reason;
  // @ts-expect-error No source generation or transport authority.
  room.distributedFacts!.output_generation;
  // @ts-expect-error No source directory authority.
  room.distributedFacts!.directory_url;
  // @ts-expect-error No raw media element.
  room.video;
  // @ts-expect-error No generic API access.
  room.api;
  // @ts-expect-error No general playback runner.
  room.runPlayback(async () => {});
  // @ts-expect-error No command bridge.
  room.send("PLAY");
  // @ts-expect-error No full room projection.
  room.state;
  // @ts-expect-error No session identity or source ownership.
  room.sessionId;
  // @ts-expect-error No mutable distributed source intent.
  room.distributedIntent;
  // @ts-expect-error No unlisted load operation.
  room.loadMedia();
  // @ts-expect-error No independent media attachment.
  room.attach(document.createElement("video"));
  // @ts-expect-error No unlisted settings operation.
  room.selectNativeQuality("auto");
  // @ts-expect-error Original callback references cannot be replaced by consumers.
  room.startPeerSharing = share;
  // @ts-expect-error Adapter input fact refs are readonly too.
  ctx.playback.duration.value = 1;
  // @ts-expect-error Adapter input nested summary facts remain readonly.
  ctx.playback.playbackSummary.value!.mode = "other";
  // @ts-expect-error Adapter input nested job facts remain readonly.
  ctx.playback.distributedFacts.value!.job_id = "other";
  // @ts-expect-error Adapter input nested statistics remain readonly.
  ctx.playback.peerStats.value!.peerBytes = 1;
  // @ts-expect-error The adapter cannot overwrite the original operation table.
  ctx.actions.stopPeerSharing = stop;
  // @ts-expect-error The former RoomPage action alias is retired.
  runtime.useOriginalSource();
  // @ts-expect-error The former RoomPage fact alias is retired.
  runtime.duration;
}
void consumerContract;
