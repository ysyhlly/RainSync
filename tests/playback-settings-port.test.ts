import { afterEach, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { ref } from "vue";
import {
  createPlaybackSettingsPort,
  type PlaybackSettingsPort,
} from "../apps/web/src/features/playback/playback-settings-port";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Context = Parameters<typeof createPlaybackSettingsPort>[0];

it("constructs a passive settings view and retains live nested fact identity", () => {
  const reads: string[] = [];
  const tracks = ref([
    { index: 1, label: "Original", language: "en", codec: "aac" },
  ]);
  const startupDiagnostics = ref<any>();
  const owner = { tracks, startupDiagnostics };
  const port = createPlaybackSettingsPort({
    playback: new Proxy(owner, {
      get(target, key) {
        reads.push(String(key));
        return target[key as keyof typeof owner];
      },
    }) as unknown as Context["playback"],
    actions: new Proxy(
      {},
      {
        get() {
          throw Error("No action lookup at construction");
        },
      },
    ) as Context["actions"],
    hasMedia: () => {
      reads.push("media");
      return true;
    },
  });
  expect(reads).toEqual([]);
  expect(port.tracks).toBe(tracks.value);
  tracks.value[0].label = "Updated";
  expect(port.tracks[0].label).toBe("Updated");
  expect(port.startupDiagnostics).toBeUndefined();
  startupDiagnostics.value = { startup_phases: { loading_ms: 5000 } };
  expect(port.startupDiagnostics).toBe(startupDiagnostics.value);
  expect(port.startupDiagnostics?.startup_phases.loading_ms).toBe(5000);
  expect(port.hasMedia).toBe(true);
});

const retiredAliases = [
  "mode",
  "nativeEncodedHeight",
  "nativeLadderRenditions",
  "upstreamMeasuredOutput",
  "upstreamMeasuredMatchesRequested",
  "nativeProvider",
  "nativeCredentialMode",
  "nativeQualityMaxHeight",
  "nativeQualityOptions",
  "nativeQualitySelectedHeight",
  "selectNativeQuality",
  "platformSubtitleTracks",
  "platformSubtitleId",
  "platformSubtitleStatus",
  "platformDanmakuStatus",
  "platformTextError",
  "platformTextLive",
  "platformLiveDanmakuMode",
  "setPlatformLiveDanmaku",
  "selectPlatformSubtitle",
  "setPlatformDanmaku",
  "tracks",
  "advancedCapabilities",
  "advancedFacts",
  "staticHlsFallbackEnabled",
  "staticHlsAvailability",
  "staticHlsAvailabilityText",
  "localHlsLadderEnabled",
  "ladderCapabilities",
  "ladderFacts",
  "ladderQuality",
  "ladderSelected",
  "ladderManual",
  "selectLadderQuality",
  "toneMapHdr",
  "burnInSubtitleIndex",
] as const;

it("the real composition retires exactly the Settings-only aliases and retains private action hooks", async () => {
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
    csrf: "settings-contract",
  });
  const runtime = useRoomRuntime();
  try {
    expect(retiredAliases).toHaveLength(36);
    for (const key of retiredAliases) expect(key in runtime, key).toBe(false);
    const names: string[] = [];
    runtime.$onAction(({ name, store }) => {
      expect(store).toBe(runtime);
      names.push(name);
    });
    await runtime.playbackSettings.chooseNativeQuality("auto");
    expect(names).toEqual(["runPlayback", "selectNativeQuality"]);
    names.length = 0;
    await runtime.playbackSettings.reload();
    expect(names).toEqual(["runPlayback", "loadMedia"]);
    expect(runtime.busy).toBe(false);
    for (const key of retiredAliases) expect(key in runtime, key).toBe(false);
  } finally {
    disposePinia(pinia);
  }
});

function consumerContract(
  settings: PlaybackSettingsPort,
  runtime: ReturnType<typeof useRoomRuntime>,
) {
  const label: string = settings.tracks[0].label;
  const height: number = settings.nativeQualityOptions[0].height;
  const elapsed: number | undefined =
    settings.startupDiagnostics?.startup_phases.loading_ms;
  void [label, height, elapsed];
  // @ts-expect-error The consumer cannot replace a fact or write a draft directly.
  settings.mode = "direct";
  // @ts-expect-error Nested track facts are readonly.
  settings.tracks[0].label = "mutated";
  // @ts-expect-error Track collection is readonly.
  settings.tracks.push({ index: 2, label: "", language: "", codec: "aac" });
  // @ts-expect-error Nested quality facts are readonly.
  settings.nativeQualityOptions[0].height = 1;
  // @ts-expect-error Nested capabilities are readonly.
  settings.advancedCapabilities!.subtitle_streams[0].index = 1;
  // @ts-expect-error Later meter samples remain readonly observations.
  settings.startupDiagnostics!.startup_phases.loading_ms = 1;
  // @ts-expect-error No media element authority.
  settings.video;
  // @ts-expect-error No room/store authority.
  settings.state;
  // @ts-expect-error No generic request access.
  settings.api;
  // @ts-expect-error No generic action runner.
  settings.runPlayback;
  // @ts-expect-error No unwrapped load callback.
  settings.loadMedia;
  // @ts-expect-error No SID or request ownership.
  settings.sessionId;
  // @ts-expect-error The former Settings-only draft alias is retired.
  runtime.mode;
  // @ts-expect-error The former Settings-only action alias is retired.
  runtime.selectNativeQuality;
}
void consumerContract;
