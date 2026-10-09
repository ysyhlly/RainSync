import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import * as selections from "../apps/web/src/features/playback/playback-selections";
import * as advanced from "../apps/web/src/features/playback/advanced-playback-intent";
import * as ladder from "../apps/web/src/features/playback/local-hls-ladder-intent";

const viewingProbe = vi.hoisted(() => ({ playback: undefined as any }));
vi.mock("../apps/web/src/app/viewing-runtime", async (original) => {
  const actual =
    await original<typeof import("../apps/web/src/app/viewing-runtime")>();
  return {
    ...actual,
    createViewingRuntime: (
      ...args: Parameters<typeof actual.createViewingRuntime>
    ) => {
      const viewing = actual.createViewingRuntime(...args);
      viewingProbe.playback = viewing.playback;
      return viewing;
    },
  };
});

const directory = fileURLToPath(
  new URL("../apps/web/src/features/playback/", import.meta.url),
);
const compiled = new Map<string, string>();
const stops: (() => void)[] = [];
afterEach(() => {
  stops
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type TreeNode = EventTarget & {
  tag: string;
  props: Record<string, any>;
  children: TreeNode[];
  parent?: TreeNode;
  text?: string;
  style: Record<string, string>;
  value?: unknown;
  checked?: boolean;
  open?: boolean;
};

const viewFields = [
  "advancedCapabilities",
  "advancedFacts",
  "audioIndex",
  "burnInSubtitleIndex",
  "ladderCapabilities",
  "ladderFacts",
  "ladderManual",
  "ladderQuality",
  "ladderSelected",
  "live",
  "localHlsLadderEnabled",
  "mode",
  "nativeCredentialMode",
  "nativeEncodedHeight",
  "nativeLadderRenditions",
  "nativePlatform",
  "nativePlaybackMode",
  "nativeProvider",
  "nativeQualityMaxHeight",
  "nativeQualityOptions",
  "nativeQualitySelectedHeight",
  "platformDanmakuEnabled",
  "platformDanmakuStatus",
  "platformLiveDanmakuMode",
  "platformSubtitleId",
  "platformSubtitleStatus",
  "platformSubtitleTracks",
  "platformTextError",
  "platformTextLive",
  "playbackSummary",
  "startupDiagnostics",
  "staticHlsAvailability",
  "staticHlsAvailabilityText",
  "staticHlsFallbackEnabled",
  "subtitleIndex",
  "subtitles",
  "toneMapHdr",
  "tracks",
  "upstreamMeasuredMatchesRequested",
  "upstreamMeasuredOutput",
] as const;
const methodFields = [
  "runPlayback",
  "loadMedia",
  "applySubtitles",
  "selectNativeQuality",
  "selectLadderQuality",
  "selectPlatformSubtitle",
  "setPlatformDanmaku",
  "setPlatformLiveDanmaku",
] as const;

function compile(name: string) {
  if (!compiled.has(name)) {
    const file = resolve(directory, name);
    const input = readFileSync(file, "utf8");
    const { descriptor, errors } = parse(input, { filename: file });
    if (errors.length) throw errors[0];
    const script = compileScript(descriptor, {
      id: `settings-caller-${name}`,
      inlineTemplate: true,
    });
    compiled.set(
      name,
      ts.transpileModule(script.content, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
    );
  }
  return compiled.get(name)!;
}

function fixture(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const pending: (() => unknown)[] = [];
  let armed = false;
  let defer = false;
  const methods: Record<string, (...args: any[]) => any> = {
    runPlayback: (action: () => unknown) => {
      events.push("run entered");
      if (defer) {
        pending.push(action);
        return Promise.resolve();
      }
      return action();
    },
    loadMedia: () => {
      events.push("load");
      return Promise.resolve();
    },
    applySubtitles: () => events.push("apply subtitles"),
    selectNativeQuality: (value) => {
      events.push(`native quality:${value}`);
      return Promise.resolve();
    },
    selectLadderQuality: (value) => events.push(`ladder quality:${value}`),
    selectPlatformSubtitle: (value) =>
      events.push(`platform subtitle:${value}`),
    setPlatformDanmaku: (value) => events.push(`danmaku:${value}`),
    setPlatformLiveDanmaku: (value) => events.push(`live danmaku:${value}`),
  };
  const plain: Record<string, any> = {
    state: { media_id: "movie" },
    nativePlatform: false,
    live: false,
    nativePlaybackMode: "auto",
    nativeCredentialMode: "own_or_anonymous",
    mode: "auto",
    nativeProvider: "bilibili",
    nativeQualityMaxHeight: "auto",
    nativeQualityOptions: [{ max_height: "1080", height: 1080 }],
    nativeQualitySelectedHeight: undefined,
    nativeEncodedHeight: undefined,
    nativeLadderRenditions: undefined,
    tracks: [
      { index: 1, label: "English", language: "en", codec: "aac", channels: 2 },
    ],
    subtitles: [
      {
        index: 4,
        label: "English",
        language: "en",
        codec: "webvtt",
        url: "/subtitle.vtt",
      },
    ],
    audioIndex: undefined,
    subtitleIndex: undefined,
    platformSubtitleTracks: [
      { id: "en", label: "English", language: "en", automatic: false },
    ],
    platformSubtitleId: null,
    platformSubtitleStatus: "available",
    platformDanmakuStatus: "available",
    platformDanmakuEnabled: false,
    platformTextError: "",
    platformTextLive: false,
    platformLiveDanmakuMode: "off",
    staticHlsAvailability: {
      version: 1,
      available: true,
      reason: "installed_runtime",
    },
    staticHlsAvailabilityText: "available fixture",
    staticHlsFallbackEnabled: false,
    localHlsLadderEnabled: false,
    ladderCapabilities: undefined,
    ladderFacts: undefined,
    ladderQuality: "auto",
    ladderSelected: undefined,
    ladderManual: false,
    advancedCapabilities: undefined,
    advancedFacts: undefined,
    toneMapHdr: false,
    burnInSubtitleIndex: undefined,
    playbackSummary: undefined,
    startupDiagnostics: undefined,
    upstreamMeasuredOutput: undefined,
    upstreamMeasuredMatchesRequested: undefined,
    ...overrides,
  };
  for (const key of ["audioIndex", "subtitleIndex"]) {
    let value = plain[key];
    Object.defineProperty(plain, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (next) => {
        if (armed) events.push(`write ${key}:${next}`);
        value = next;
      },
    });
  }
  for (const key of methodFields)
    Object.defineProperty(plain, key, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (armed) events.push(`lookup ${key}`);
        return methods[key];
      },
    });
  const raw = Vue.reactive(plain);
  const owner: Record<string, any> = {};
  for (const key of viewFields) owner[key] = Vue.toRef(raw, key);
  for (const key of methodFields)
    Object.defineProperty(owner, key, { get: () => raw[key] });
  return {
    raw,
    owner,
    methods,
    events,
    pending,
    arm: () => {
      armed = true;
      events.length = 0;
    },
    disarm: () => {
      armed = false;
    },
    defer: () => {
      defer = true;
    },
  };
}

function mountSettings(raw: Record<string, any>, owner: Record<string, any>) {
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { fullscreenElement: null }),
  );
  vi.stubGlobal("window", new EventTarget());
  const select = Vue.defineComponent({
    props: ["modelValue", "label", "disabled", "options"],
    emits: ["update:modelValue", "change"],
    setup:
      (props, { emit }) =>
      () =>
        Vue.h("select", {
          "aria-label": props.label,
          disabled: props.disabled,
          value: props.modelValue,
          onPick: (value: unknown) => {
            emit("update:modelValue", value);
            emit("change", value);
          },
        }),
  });
  const icon = Vue.defineComponent({ setup: () => () => Vue.h("i") });
  const loaded = new Map<string, Vue.Component>();
  const require = (name: string): unknown => {
    if (name === "vue") return Vue;
    if (name === "../rooms/room-runtime") return { useRoomRuntime: () => raw };
    if (name === "./playback-selections") return selections;
    if (name === "./advanced-playback-intent") return advanced;
    if (name === "./local-hls-ladder-intent") return ladder;
    if (name === "../../shared/ui/AppSelect.vue")
      return { __esModule: true, default: select };
    if (name === "../../shared/ui/AppIcon.vue")
      return { __esModule: true, default: icon };
    if (name.startsWith("./") && name.endsWith(".vue"))
      return { __esModule: true, default: load(name.slice(2)) };
    throw Error(`Unexpected Settings caller import: ${name}`);
  };
  const load = (name: string): Vue.Component => {
    if (!loaded.has(name)) {
      const module = { exports: {} as { default: Vue.Component } };
      new Function("require", "module", "exports", compile(name))(
        require,
        module,
        module.exports,
      );
      loaded.set(name, module.exports.default);
    }
    return loaded.get(name)!;
  };
  // The identical caller file can characterize the old real SFC/store and the
  // later real SFC/production port. No test imitation of the new port is used.
  const portFile = resolve(directory, "playback-settings-port.ts");
  let settings: unknown = raw.playbackSettings;
  if (existsSync(portFile) && !settings) {
    const module = {
      exports: {} as {
        createPlaybackSettingsPort: (context: unknown) => unknown;
      },
    };
    const code = ts.transpileModule(readFileSync(portFile, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    new Function("require", "module", "exports", code)(
      require,
      module,
      module.exports,
    );
    settings = module.exports.createPlaybackSettingsPort({
      playback: owner,
      actions: owner,
      hasMedia: () => !!raw.state?.media_id,
    });
  }
  expect(!!settings).toBe(
    !readFileSync(resolve(directory, "PlaybackSettings.vue"), "utf8").includes(
      'from "../rooms/room-runtime"',
    ),
  );
  const node = (tag: string): TreeNode =>
    Object.assign(new EventTarget(), {
      tag,
      props: {},
      children: [],
      style: {},
    });
  const remove = (item: TreeNode) => {
    if (item.parent) {
      const siblings = item.parent.children;
      const index = siblings.indexOf(item);
      if (index >= 0) siblings.splice(index, 1);
      item.parent = undefined;
    }
  };
  const renderer = Vue.createRenderer<TreeNode, TreeNode>({
    patchProp(item, key, _old, value) {
      item.props[key] = value;
      if (key === "onChange") {
        if (typeof _old === "function")
          item.removeEventListener("change", _old);
        if (typeof value === "function") item.addEventListener("change", value);
      }
      if (["value", "checked", "open"].includes(key))
        (item as any)[key] = value;
    },
    insert(item, parent, anchor) {
      remove(item);
      item.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at < 0) parent.children.push(item);
      else parent.children.splice(at, 0, item);
    },
    remove,
    createElement: node,
    createText: (text) => Object.assign(node("text"), { text }),
    createComment: (text) => Object.assign(node("comment"), { text }),
    setText(item, text) {
      item.text = text;
    },
    setElementText(item, text) {
      item.children = [];
      item.text = text;
    },
    parentNode: (item) => item.parent ?? null,
    nextSibling: (item) =>
      item.parent?.children[item.parent.children.indexOf(item) + 1] ?? null,
  });
  const props = Vue.shallowReactive({ active: true, settings });
  const app = renderer.createApp({
    render: () => Vue.h(load("PlaybackSettings.vue"), props),
  });
  const root = node("root");
  app.mount(root);
  stops.push(() => app.unmount());
  const all = (item: TreeNode = root): TreeNode[] => [
    item,
    ...item.children.flatMap(all),
  ];
  const text = (item: TreeNode): string =>
    (item.text ?? "") + item.children.map(text).join("");
  const get = (label: string) => {
    const found = all().find((item) => item.props["aria-label"] === label);
    expect(found, label).toBeDefined();
    return found!;
  };
  const button = () => {
    const found = all().find(
      (item) => item.tag === "button" && text(item).includes("重新加载"),
    );
    expect(found).toBeDefined();
    return found!;
  };
  return {
    get,
    all,
    text: () => text(root),
    button,
    props,
    pick: (label: string, value: unknown) => get(label).props.onPick(value),
  };
}

it("Settings caller baseline: ordinary mode stages synchronously without entering the runner", () => {
  const f = fixture();
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  stops.push(
    Vue.watch(
      () => f.raw.mode,
      (value) => f.events.push(`sync mode:${value}`),
      { flush: "sync" },
    ),
  );
  m.pick("播放方式", "remux");
  expect(f.raw.mode).toBe("remux");
  expect(f.events).toEqual(["sync mode:remux"]);
});

it.each([
  ["平台播放方式", "adaptive", "nativePlaybackMode"],
  ["平台账号", "anonymous", "nativeCredentialMode"],
])(
  "Settings caller baseline: %s remains a staged input",
  (label, value, key) => {
    const f = fixture({ nativePlatform: true });
    const m = mountSettings(f.raw, f.owner);
    f.arm();
    stops.push(
      Vue.watch(
        () => f.raw[key],
        (next) => f.events.push(`sync ${key}:${next}`),
        { flush: "sync" },
      ),
    );
    m.pick(label, value);
    expect(f.raw[key]).toBe(value);
    expect(f.events).toEqual([`sync ${key}:${value}`]);
  },
);

it("Settings caller baseline: audio writes and sync watchers precede runner and load lookup", () => {
  const f = fixture();
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  stops.push(
    Vue.watch(
      () => f.raw.audioIndex,
      () => {
        f.events.push("audio watcher");
        f.methods.loadMedia = () => {
          f.events.push("latest load");
          return Promise.resolve();
        };
      },
      { flush: "sync" },
    ),
  );
  m.pick("音轨", 1);
  expect(f.events).toEqual([
    "write audioIndex:1",
    "audio watcher",
    "lookup runPlayback",
    "lookup loadMedia",
    "run entered",
    "latest load",
  ]);
});

it("Settings caller baseline: subtitle writes and sync watchers precede current apply lookup", () => {
  const f = fixture();
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  stops.push(
    Vue.watch(
      () => f.raw.subtitleIndex,
      () => {
        f.events.push("subtitle watcher");
        f.methods.applySubtitles = () => f.events.push("latest subtitles");
      },
      { flush: "sync" },
    ),
  );
  m.pick("字幕", 4);
  expect(f.events).toEqual([
    "write subtitleIndex:4",
    "subtitle watcher",
    "lookup applySubtitles",
    "latest subtitles",
  ]);
});

it("Settings caller baseline: Reload evaluates runner then load before runner entry", () => {
  const f = fixture();
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  m.button().props.onClick();
  expect(f.events).toEqual([
    "lookup runPlayback",
    "lookup loadMedia",
    "run entered",
    "load",
  ]);
});

it("Settings caller baseline: native quality looks up the selection only inside the runner callback", () => {
  const f = fixture({ nativePlatform: true });
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  f.defer();
  m.pick("清晰度", "1080");
  expect(f.raw.nativeQualityMaxHeight).toBe("auto");
  expect(f.events).toEqual(["lookup runPlayback", "run entered"]);
  f.methods.selectNativeQuality = (value) =>
    f.events.push(`latest quality:${value}`);
  f.pending[0]();
  expect(f.events).toEqual([
    "lookup runPlayback",
    "run entered",
    "lookup selectNativeQuality",
    "latest quality:1080",
  ]);
});

it("Settings caller baseline: platform subtitle retains its rendered direct callback", async () => {
  const f = fixture({ nativePlatform: true });
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  f.methods.selectPlatformSubtitle = (value) =>
    f.events.push(`replacement subtitle:${value}`);
  m.pick("平台字幕语言", "en");
  expect(f.events).toEqual(["platform subtitle:en"]);
  f.raw.platformSubtitleStatus = "loading";
  await Vue.nextTick();
  f.events.length = 0;
  m.pick("平台字幕语言", null);
  expect(f.events).toEqual(["replacement subtitle:null"]);
});

it("Settings caller baseline: native platform danmaku stays a direct text action", () => {
  const f = fixture({ nativePlatform: true });
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  const input = m
    .all()
    .find((item) => item.tag === "input" && item.props.type === "checkbox")!;
  expect(input).toBeDefined();
  input.props.onChange({ target: { checked: true } });
  expect(f.events).toEqual(["danmaku:true"]);
});

it("Settings caller baseline: removed audio track and missing media retain child validation", async () => {
  const f = fixture();
  const m = mountSettings(f.raw, f.owner);
  const oldPick = m.get("音轨").props.onPick;
  f.raw.tracks = [];
  await Vue.nextTick();
  f.arm();
  oldPick(1);
  expect(f.events).toEqual([]);
  f.raw.tracks = [{ index: 1, label: "English", language: "en", codec: "aac" }];
  f.raw.state.media_id = null;
  await Vue.nextTick();
  f.events.length = 0;
  m.pick("音轨", 1);
  expect(f.events).toEqual([]);
  expect(m.button().props.disabled).toBe(true);
  // The parent callback itself has never been an admission authority. An
  // already delivered click still reaches the existing runtime action owner.
  m.button().props.onClick();
  expect(f.events).toEqual([
    "lookup runPlayback",
    "lookup loadMedia",
    "run entered",
    "load",
  ]);
});

const ladderCapabilities = {
  schema_version: 1,
  worker_runtime_required: true,
  renditions: [
    {
      id: "low",
      width: 640,
      height: 360,
      bandwidth: 1250000,
      codecs: "avc1.64001F",
    },
  ],
};
const advancedCapabilities = {
  schema_version: 1,
  worker_runtime_required: true,
  tone_map_hdr: true,
  subtitle_streams: [
    { index: 7, codec: "ass", label: "Styled", language: "eng" },
  ],
};

it("Settings caller baseline: static fallback checkbox changes only its existing draft", () => {
  const f = fixture();
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  stops.push(
    Vue.watch(
      () => f.raw.staticHlsFallbackEnabled,
      (value) => f.events.push(`static:${value}`),
      { flush: "sync" },
    ),
  );
  const checkbox = m
    .all()
    .find((item) => item.tag === "input" && item.props.type === "checkbox")!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  expect(f.events).toEqual(["static:true"]);
  expect(f.raw.staticHlsFallbackEnabled).toBe(true);
});

it.each([false, true])(
  "Settings caller baseline: %s native ladder toggle remains staged",
  (native) => {
    const f = fixture({
      nativePlatform: native,
      nativePlaybackMode: "compatibility",
      ladderCapabilities,
      nativeLadderRenditions: ladderCapabilities.renditions,
      staticHlsAvailability: undefined,
    });
    const m = mountSettings(f.raw, f.owner);
    f.arm();
    const key = native ? "nativePlaybackMode" : "localHlsLadderEnabled";
    stops.push(
      Vue.watch(
        () => f.raw[key],
        (value) => f.events.push(`stage:${value}`),
        { flush: "sync" },
      ),
    );
    const field = m
      .all()
      .find(
        (item) =>
          item.tag === "fieldset" &&
          item.props.class ===
            (native ? "native-ladder-settings" : "ladder-settings"),
      )!;
    const input = m
      .all()
      .find((item) => item.tag === "input" && item.parent?.parent === field)!;
    expect(input).toBeDefined();
    input.props.onChange({ target: { checked: true } });
    expect(f.events).toEqual([`stage:${native ? "adaptive" : true}`]);
  },
);

it("Settings caller baseline: advanced subtitle chooses tone mapping before its draft and does not reload", () => {
  const f = fixture({ advancedCapabilities });
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  stops.push(
    Vue.watch(
      () => f.raw.toneMapHdr,
      (value) => f.events.push(`tone:${value}`),
      { flush: "sync" },
    ),
  );
  stops.push(
    Vue.watch(
      () => f.raw.burnInSubtitleIndex,
      (value) => f.events.push(`burn:${value}`),
      { flush: "sync" },
    ),
  );
  m.pick("关联字幕烧录", 7);
  expect(f.events).toEqual(["tone:true", "burn:7"]);
});

it.each([false, true])(
  "Settings caller baseline: %s native ladder quality uses its rendered direct callback",
  (native) => {
    const f = fixture({
      nativePlatform: native,
      nativePlaybackMode: "adaptive",
      ladderCapabilities,
      nativeLadderRenditions: ladderCapabilities.renditions,
      ladderManual: true,
      ladderFacts: { renditions: ladderCapabilities.renditions },
    });
    const m = mountSettings(f.raw, f.owner);
    f.arm();
    f.methods.selectLadderQuality = () => f.events.push("replacement ladder");
    m.pick(native ? "平台兼容 HLS 输出清晰度" : "本地 HLS 清晰度", "low");
    expect(f.events).toEqual(["ladder quality:low"]);
  },
);

it("Settings caller baseline: live danmaku forwards the existing explicit text action", () => {
  const f = fixture({ nativePlatform: true, live: true });
  const m = mountSettings(f.raw, f.owner);
  f.arm();
  m.pick("直播弹幕模式", "history");
  expect(f.events).toEqual(["live danmaku:history"]);
});

function actualStoreFixture() {
  vi.useFakeTimers();
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { fullscreenElement: null }),
  );
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", {
    protocol: "http:",
    host: "localhost",
    href: "http://localhost/",
  });
  vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json([])),
  );
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({
    id: "viewer",
    username: "viewer",
    admin: false,
    csrf: "synthetic-settings",
  });
  const runtime = useRoomRuntime();
  stops.push(() => disposePinia(pinia));
  // The original owner refs seed facts without creating retired aliases on the
  // Pinia proxy. Candidate execution takes the composition's real settings port.
  return {
    runtime,
    owner: viewingProbe.playback,
    playback: viewingProbe.playback,
  };
}

it.each(["resolved", "rejected", "quality early return", "disposed"])(
  "Settings actual Pinia baseline: %s retains hooks and busy/error/result settlement",
  async (scenario) => {
    const { runtime, owner, playback } = actualStoreFixture();
    let reject = false;
    if (scenario === "rejected") {
      runtime.room = { id: "room", name: "Room", owner_id: "viewer" };
      runtime.state = {
        room_id: "room",
        media_generation: 1,
        clock_epoch: "clock",
        playback_rate: 1,
        playback_status: "paused",
        anchor_position_ms: 0,
        anchor_server_time_ms: 0,
        get media_id() {
          if (reject) {
            reject = false;
            throw Error("settings-load-rejected");
          }
          return "movie";
        },
      } as any;
    }
    if (scenario === "quality early return") {
      playback.nativePlatform.value = true;
      playback.nativeQualityOptions.value = [
        { max_height: "1080", height: 1080 },
      ];
    }
    const m = mountSettings(runtime as any, owner);
    if (scenario === "disposed") runtime.$dispose();
    let tick = 0,
      settled = false;
    const events: string[] = [];
    runtime.$onAction(({ name, after, onError }) => {
      events.push(`${tick}:start:${name}`);
      after(() => events.push(`${tick}:after:${name}`));
      onError(() => events.push(`${tick}:error:${name}`));
    });
    stops.push(
      Vue.watch(
        () => runtime.busy,
        (value) => events.push(`${tick}:busy:${value}`),
        { flush: "sync" },
      ),
    );
    stops.push(
      Vue.watch(
        () => runtime.error,
        (value) => events.push(`${tick}:notice:${value}`),
        { flush: "sync" },
      ),
    );
    reject = scenario === "rejected";
    const result =
      scenario === "quality early return"
        ? (m.get("清晰度").props.onPick("1080"), undefined)
        : m.button().props.onClick();
    // Vue emits discard the quality handler's return, just as the real child
    // does. The action's after hook still records its observable settlement.
    result?.then(() => {
      settled = true;
      events.push(`${tick}:public settled`);
    });
    const states = [`${+runtime.busy}/${+!!runtime.error}/${+settled}`];
    for (tick = 1; tick <= 12; tick++) {
      await Promise.resolve();
      states.push(`${+runtime.busy}/${+!!runtime.error}/${+settled}`);
    }
    expect({ scenario, states, events }).toMatchSnapshot();
  },
);

it("Settings actual runtime baseline: a staged credential change runs the existing synchronous quality reset without a playback action", () => {
  const { runtime, owner, playback } = actualStoreFixture();
  playback.nativePlatform.value = true;
  playback.nativeQualityOptions.value = [{ max_height: "1080", height: 1080 }];
  playback.nativeQualitySelectedHeight.value = 1080;
  playback.nativeQualityMaxHeight.value = "1080";
  const m = mountSettings(runtime as any, owner);
  const events: string[] = [];
  runtime.$onAction(({ name }) => events.push(`action:${name}`));
  for (const field of [
    "nativeQualityOptions",
    "nativeQualitySelectedHeight",
    "nativeQualityMaxHeight",
    "nativeCredentialMode",
  ]) {
    stops.push(
      Vue.watch(
        playback[field],
        (value) => events.push(`${field}:${JSON.stringify(value)}`),
        { flush: "sync" },
      ),
    );
  }
  m.pick("平台账号", "anonymous");
  expect(events).toEqual([
    "nativeQualityOptions:[]",
    "nativeQualitySelectedHeight:undefined",
    'nativeQualityMaxHeight:"auto"',
    'nativeCredentialMode:"anonymous"',
  ]);
  expect(runtime.busy).toBe(false);
  expect(runtime.error).toBe("");
});

it("Settings port new contract: replacement props use the current finite port and keep later diagnostics live", async () => {
  const first = fixture();
  const second = fixture();
  const mounted = mountSettings(first.raw, first.owner);
  const replacement = mountSettings(second.raw, second.owner);
  mounted.props.settings = replacement.props.settings;
  await Vue.nextTick();
  first.arm();
  second.arm();
  mounted.pick("音轨", 1);
  expect(first.raw.audioIndex).toBeUndefined();
  expect(first.events).toEqual([]);
  expect(second.raw.audioIndex).toBe(1);
  expect(second.events).toEqual([
    "write audioIndex:1", "lookup runPlayback", "lookup loadMedia", "run entered", "load",
  ]);
  second.disarm();
  second.raw.startupDiagnostics = {
    startup_phases: { preparation_ms: 1200, loading_ms: 2300, unobserved_ms: 0 },
    first_frame: { elapsed_ms: 3500, evidence: "video_frame_callback" },
  };
  await Vue.nextTick();
  expect(mounted.text()).toContain("3.5 秒");
  expect(mounted.text()).toContain("不是实测屏幕显示时间");
});
