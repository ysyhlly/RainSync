import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useMediaCatalog } from "../apps/web/src/features/library/media-catalog.store";
import type { PlaybackPlan, PlaybackRequest } from "../packages/protocol";
import { createRoomViewingMode } from "../apps/web/src/features/rooms/room-viewing-mode";
import { roomPermissionOptions } from "../apps/web/src/features/rooms/room-permissions";
import { useRoomLayout } from "../apps/web/src/features/room-layout/layout-controller";
import * as layoutModel from "../apps/web/src/features/room-layout/layout-model";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
import { useAction, formatTime } from "../apps/web/src/shared/use-action";
import { prewarmNativeDash } from "../apps/web/src/features/playback/dash-prewarm";
import { supportsHlsPlayback } from "../apps/web/src/features/playback/browser-mse";

// The caller uses the real prewarm helper; only the optional public SDK
// acquisition is synthetic. No media grant is issued by this fixture boundary.
const dashProbe = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../packages/player-core/dash/loader", () => ({
  loadDashJs: (...args: unknown[]) => dashProbe.load(...args),
}));
const directory = fileURLToPath(
  new URL("../apps/web/src/features/rooms/", import.meta.url),
);
const compiled = new Map<string, string>();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const cleanup of roomPiniaCleanups.splice(0).reverse()) await cleanup();
  await roomPiniaTicks(40);
  await ticks(30);
  vi.restoreAllMocks();
  roomPiniaHls.instances.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function ticks(count = 5) {
  for (let index = 0; index < count; index++) await Vue.nextTick();
}
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function compile(name: string) {
  const path = resolve(directory, name);
  if (!compiled.has(path)) {
    const { descriptor, errors } = parse(readFileSync(path, "utf8"), {
      filename: path,
    });
    if (errors.length) throw errors[0];
    const script = compileScript(descriptor, {
      id: `room-playback-caller-${name}`,
      inlineTemplate: true,
    });
    compiled.set(
      path,
      ts.transpileModule(script.content, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
    );
  }
  return compiled.get(path)!;
}

function environment() {
  vi.useFakeTimers();
  dashProbe.load.mockReset().mockResolvedValue({});
  const effects: string[] = [];
  class Target extends EventTarget {
    constructor(readonly name: string) {
      super();
      Vue.markRaw(this);
    }
    addEventListener(type: string, callback: any, options?: any) {
      effects.push(`add:${this.name}:${type}`);
      super.addEventListener(type, callback, options);
    }
    removeEventListener(type: string, callback: any, options?: any) {
      effects.push(`remove:${this.name}:${type}`);
      super.removeEventListener(type, callback, options);
    }
  }
  class Node extends Target {
    props: Record<string, any> = {};
    children: Node[] = [];
    parent?: Node;
    text = "";
    checked = false;
    value: any = "";
    clientWidth = 1000;
    style: Record<string, any> = {};
    constructor(readonly tag: string) {
      super(tag);
    }
    get tagName() {
      return this.tag.toUpperCase();
    }
    get parentElement() {
      return this.parent;
    }
    getAttribute(key: string) {
      return this.props[key] ?? null;
    }
    setAttribute(key: string, value: string) {
      this.props[key] = value;
    }
    removeAttribute(key: string) {
      delete this.props[key];
    }
    focus() {
      effects.push(`focus:${this.tag}`);
    }
    querySelector(tag: string): Node | null {
      return (
        this.children.find((child) => child.tag === tag) ??
        this.children.map((child) => child.querySelector(tag)).find(Boolean) ??
        null
      );
    }
    requestFullscreen() {
      effects.push("fullscreen:request");
      return Promise.resolve();
    }
  }
  const document: any = Object.assign(new Target("document"), {
    fullscreenElement: null,
    fullscreenEnabled: true,
    hidden: false,
    visibilityState: "visible",
    documentElement: new Node("html"),
    querySelector: () => null,
    exitFullscreen: () => Promise.resolve(),
  });
  const window = Object.assign(new Target("window"), {
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    scrollTo: (x: number, y: number) => effects.push(`scroll:${x}:${y}`),
  });
  const observers: any[] = [];
  class ResizeObserver {
    constructor(readonly callback: (...args: any[]) => void) {
      observers.push(this);
    }
    observe(node: Node) {
      effects.push(`observe:${node.tag}`);
    }
    disconnect() {
      effects.push("observer:disconnect");
    }
  }
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  };
  const source = { isTypeSupported: vi.fn(() => true) };
  for (const [key, value] of Object.entries({
    document,
    window,
    ResizeObserver,
    HTMLElement: Node,
    Element: Node,
    localStorage: storage,
    sessionStorage: storage,
    self: { MediaSource: source },
    navigator: {},
    location: {
      protocol: "http:",
      host: "localhost",
      href: "http://localhost/rooms/room",
    },
    fetch: vi.fn(async () => Response.json([])),
  }))
    vi.stubGlobal(key, value);
  return { Node, effects, document, window, observers, saved, source };
}
type Environment = ReturnType<typeof environment>;
type TreeNode = InstanceType<Environment["Node"]>;
const media = (id = "film") => ({
  id,
  title: `Film ${id}`,
  duration_ms: 90000,
  kind: "native_platform",
  platform: { version: 1, provider: "bilibili" },
});
const computeReply = (patch: Record<string, unknown> = {}) => ({
  enabled: true,
  p2p_enabled: true,
  jobs: [
    {
      id: "job",
      status: "ready",
      recipe: "h264_480p_hls_v1",
      attempt: 1,
      output_generation: "output",
      primary_qualified: true,
      selected_audio_index: 0,
    },
  ],
  source_probe_ready: true,
  source_audio_tracks: [{ index: 0, label: "Original", language: "en" }],
  ...patch,
});
// Test binding only: preserve the original fixture getters and action identities
// while the component moves to its finite production input. The exact-baseline
// replay uses the original flat store; no action invocation is wrapped here.
function roomPlayback(runtime: any) {
  return runtime.playbackRoom ?? runtime;
}
function roomFixtureView(runtime: any) {
  return Object.defineProperties(
    {},
    Object.fromEntries(
      [
        "nativePlaybackMode",
        "duration",
        "live",
        "audioIndex",
        "playbackSummary",
        "recoveryLabel",
        "distributedFacts",
        "peerSharing",
        "peerStats",
        "useDistributedOutput",
        "useOriginalSource",
        "startPeerSharing",
        "stopPeerSharing",
      ].map((key) => [key, { enumerable: true, get: () => runtime[key] }]),
    ),
  );
}
// End test binding.
function fakeRuntime(overrides: Record<string, any> = {}) {
  const events: string[] = [];
  const reads = new Set<string>();
  const permissions = new Set(
    roomPermissionOptions.map((option) => option.value),
  );
  const callbacks = {
    useDistributedOutput: vi.fn(async (...args: any[]) => {
      events.push(`activate:${JSON.stringify(args)}`);
    }),
    useOriginalSource: vi.fn(async () => {
      events.push("original");
    }),
    startPeerSharing: vi.fn(async (consent: unknown) => {
      events.push(`share:${JSON.stringify(consent)}`);
    }),
    stopPeerSharing: vi.fn(async () => {
      events.push("stop");
    }),
  };
  const base = Vue.reactive<any>({
    room: { id: "room", name: "Room", owner_id: "viewer", lifecycle: "active" },
    state: {
      room_id: "room",
      media_id: "film",
      media_generation: 7,
      playback_status: "paused",
    },
    roomActive: true,
    connected: true,
    connectionStopped: false,
    canManageRoom: true,
    lifecycleLabel: "开放中",
    cleanupError: "",
    currentTitle: "Film",
    presence: undefined,
    presenceNames: {},
    nativePlaybackMode: "auto",
    duration: 120,
    live: false,
    audioIndex: undefined,
    playbackSummary: { mode: "Native fixture" },
    recoveryLabel: "Recalibrating fixture",
    distributedFacts: { job_id: "job" },
    peerSharing: false,
    peerStats: {
      peerBytes: 1,
      httpBytes: 2,
      uploadedBytes: 3,
      fallbacks: 4,
      badHashes: 5,
      duplicateBytes: 6,
    },
    playlist: [{ id: "queue", media_id: "queued", title: "Queued" }],
    playlistLoaded: true,
    playlistLoading: false,
    playlistError: "",
    queuePending: () => false,
    run: (action: () => unknown) => action(),
    removeQueue: vi.fn(),
    can: (permission: any) => {
      if (reads.has("can")) events.push(`can:${permission}`);
      return permissions.has(permission);
    },
    choose: vi.fn((id: string) => {
      events.push(`choose:${id}`);
      return Promise.resolve(true);
    }),
    refreshMetadata: vi.fn(),
    enter: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    ...callbacks,
    ...overrides,
  });
  const runtime = new Proxy(base, {
    get(target, key, receiver) {
      if (reads.has(String(key))) events.push(`read:${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
  Object.defineProperty(base, "playbackRoom", {
    configurable: true,
    value: roomFixtureView(runtime),
  });
  const records = Vue.reactive<Record<string, any>>({
    film: media(),
    queued: media("queued"),
  });
  const catalog = {
    roomRecord: (room: string | undefined, id: string | undefined) => {
      if (reads.has("catalog")) events.push(`catalog:${room}:${id}`);
      return room && id ? records[id] : undefined;
    },
  };
  const api = vi.fn(async (path: string) =>
    path.endsWith("/compute") ? computeReply() : [],
  );
  const session = Vue.reactive<any>({
    epoch: 1,
    user: { id: "viewer", display_name: "Viewer", guest: false },
    api,
    logout: vi.fn(async () => {}),
  });
  const prewarm = vi.fn((selected: any, mode: string) => {
    events.push(`prewarm:${selected?.id}:${mode}`);
    return prewarmNativeDash(selected, mode);
  });
  return {
    runtime,
    base,
    callbacks,
    events,
    permissions,
    records,
    catalog,
    session,
    api,
    prewarm,
    reads,
    spy(keys: string[]) {
      reads.clear();
      keys.forEach((key) => reads.add(key));
      events.length = 0;
    },
  };
}
type Fixture = ReturnType<typeof fakeRuntime>;

function mountPage(
  f: Pick<Fixture, "runtime" | "session" | "catalog" | "prewarm">,
  env: Environment,
  roomId = "room",
) {
  const loaded = new Map<string, Vue.Component>();
  const guards = {
    leave: [] as (() => unknown)[],
    update: [] as (() => unknown)[],
  };
  const route = Vue.reactive({
    params: { id: roomId },
    path: `/rooms/${roomId}`,
  });
  const placeholder = (
    tag: string,
    props: string[] = [],
    emits: string[] = [],
  ) =>
    Vue.defineComponent({
      props,
      emits,
      setup:
        (values, { slots, emit }) =>
        () =>
          Vue.h(
            tag,
            {
              ...values,
              onPick: (value: unknown) => emit("update:modelValue", value),
            },
            slots.default?.(),
          ),
    });
  const dialog = Vue.defineComponent({
    props: ["modelValue", "title", "busy", "drawer"],
    emits: ["update:modelValue"],
    setup:
      (props, { slots, emit }) =>
      () =>
        props.modelValue
          ? Vue.h(
              "test-dialog",
              {
                title: props.title,
                onClose: () => emit("update:modelValue", false),
              },
              slots.default?.(),
            )
          : null,
  });
  const canvas = Vue.defineComponent({
    props: ["layout", "editing", "viewing", "chatVisible"],
    setup(props: any, { slots, expose }) {
      expose({
        cancelGesture: () => env.effects.push("canvas:cancel"),
        focusWidget: async (id: string) =>
          env.effects.push(`canvas:focus:${id}`),
      });
      return () =>
        Vue.h(
          "test-canvas",
          {},
          props.layout.items.map((item: any) =>
            slots.widget?.({ item, visible: true }),
          ),
        );
    },
  });
  function load(name: string): Vue.Component {
    if (loaded.has(name)) return loaded.get(name)!;
    const require = (specifier: string): any => {
      if (specifier === "vue") return Vue;
      if (specifier.endsWith(".css")) return {};
      if (specifier === "vue-router")
        return {
          useRoute: () => route,
          useRouter: () => ({ push: vi.fn(async () => {}) }),
          onBeforeRouteLeave: (guard: () => unknown) =>
            guards.leave.push(guard),
          onBeforeRouteUpdate: (guard: () => unknown) =>
            guards.update.push(guard),
        };
      if (specifier === "./room-runtime")
        return { useRoomRuntime: () => f.runtime };
      if (specifier === "../auth/session.store")
        return { useSession: () => f.session };
      if (specifier === "./rooms.api") return { roomsApi };
      if (specifier === "../library/media-catalog.store")
        return { useMediaCatalog: () => f.catalog };
      if (specifier === "./room-viewing-mode") return { createRoomViewingMode };
      if (specifier === "./room-permissions") return { roomPermissionOptions };
      if (specifier === "../room-layout/layout-controller")
        return { useRoomLayout };
      if (specifier === "../room-layout/layout-model") return layoutModel;
      if (specifier === "../../shared/use-action")
        return { useAction, formatTime };
      if (specifier === "../playback/dash-prewarm")
        return { prewarmNativeDash: f.prewarm };
      if (specifier === "./browser-mse") return { supportsHlsPlayback };
      if (specifier === "../playback/DistributedComputePanel.vue")
        return { __esModule: true, default: load(specifier) };
      if (specifier === "../room-layout/RoomLayoutCanvas.vue")
        return { __esModule: true, default: canvas };
      if (specifier === "../../shared/ui/AppDialog.vue")
        return { __esModule: true, default: dialog };
      if (specifier === "../../shared/ui/AppSelect.vue")
        return {
          __esModule: true,
          default: placeholder(
            "test-select",
            ["modelValue", "options", "label", "disabled"],
            ["update:modelValue"],
          ),
        };
      if (specifier === "../playback/RoomPlayerAnchor.vue")
        return {
          __esModule: true,
          default: placeholder("test-anchor", ["editing"]),
        };
      if (specifier.endsWith(".vue"))
        return { __esModule: true, default: placeholder("test-child") };
      throw Error(`Unexpected RoomPage caller import: ${specifier}`);
    };
    const module = { exports: {} as { default: Vue.Component } };
    new Function("require", "module", "exports", compile(name))(
      require,
      module,
      module.exports,
    );
    loaded.set(name, module.exports.default);
    return module.exports.default;
  }
  const remove = (node: TreeNode) => {
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) node.parent.children.splice(index, 1);
      node.parent = undefined;
    }
  };
  const renderer = Vue.createRenderer<TreeNode, TreeNode>({
    patchProp(node, key, old, value) {
      node.props[key] = value;
      if (key === "value") node.value = value;
      if (key === "type") (node as any).type = value;
      if (key === "style") {
        for (const name of Object.keys(old ?? {}))
          if (!value || !(name in value)) delete node.style[name];
        if (value) Object.assign(node.style, value);
      }
    },
    insert(node, parent, anchor) {
      remove(node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node);
      else parent.children.splice(index, 0, node);
    },
    remove,
    createElement: (tag) => new env.Node(tag),
    createText: (text) => Object.assign(new env.Node("text"), { text }),
    createComment: (text) => Object.assign(new env.Node("comment"), { text }),
    setText: (node, text) => {
      node.text = text;
    },
    setElementText: (node, text) => {
      node.children = [];
      node.text = text;
    },
    parentNode: (node) => node.parent ?? null,
    nextSibling: (node) =>
      node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  });
  const app = renderer.createApp(load("RoomPage.vue"));
  app.component("RouterLink", placeholder("a", ["to"]));
  const root = new env.Node("root");
  const vm = app.mount(root);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      app.unmount();
    }
  };
  cleanups.push(unmount);
  const all = (node = root): TreeNode[] => [
    node,
    ...node.children.flatMap((child) => all(child)),
  ];
  const text = (node: TreeNode): string =>
    node.tag === "comment" ? "" : node.text + node.children.map(text).join("");
  const find = (predicate: (node: TreeNode) => boolean) => {
    const node = all().find(predicate);
    expect(node).toBeDefined();
    return node!;
  };
  const child = (name: string): any => {
    const visit = (vnode: any): any => {
      if (!vnode) return;
      if (vnode.type?.__name === name) return vnode;
      if (vnode.component) {
        const found = visit(vnode.component.subTree);
        if (found) return found;
      }
      if (Array.isArray(vnode.children))
        for (const next of vnode.children) {
          const found = visit(next);
          if (found) return found;
        }
    };
    return visit(vm.$.subTree);
  };
  const button = (label: string) =>
    find((node) => node.tag === "button" && text(node).trim() === label);
  return {
    root,
    all,
    text,
    find,
    child,
    button,
    guards,
    route,
    unmount,
    async openManagement() {
      button("房间管理").props.onClick();
      await ticks();
    },
    select(label: string, value: unknown) {
      find(
        (node) => node.tag === "test-select" && node.props.label === label,
      ).props.onPick(value);
    },
    checkbox(index: number, value: boolean) {
      const node = all().filter(
        (node) => node.tag === "input" && node.props.type === "checkbox",
      )[index];
      expect(node).toBeDefined();
      node.checked = value;
      node.dispatchEvent(new Event("change"));
    },
    panel: () => child("DistributedComputePanel")?.component,
  };
}

it("RoomPage baseline renders its complete distributed boundary through the original child", async () => {
  const env = environment(),
    f = fakeRuntime(),
    m = mountPage(f, env);
  await ticks();
  expect(m.all().filter((node) => node.tag === "test-anchor")).toHaveLength(1);
  expect(m.panel()).toBeUndefined();
  f.spy([
    "audioIndex",
    "distributedFacts",
    "peerSharing",
    "peerStats",
    "useDistributedOutput",
    "useOriginalSource",
    "startPeerSharing",
    "stopPeerSharing",
  ]);
  await m.openManagement();
  expect(f.events).toEqual([
    "read:audioIndex",
    "read:distributedFacts",
    "read:peerSharing",
    "read:peerStats",
    "read:useDistributedOutput",
    "read:useOriginalSource",
    "read:startPeerSharing",
    "read:stopPeerSharing",
  ]);
  const props = m.child("DistributedComputePanel").props;
  expect(props.activate).toBe(f.callbacks.useDistributedOutput);
  expect(props.original).toBe(f.callbacks.useOriginalSource);
  expect(props.share).toBe(f.callbacks.startPeerSharing);
  expect(props["stop-sharing"]).toBe(f.callbacks.stopPeerSharing);
  expect(m.panel().props.stopSharing).toBe(f.callbacks.stopPeerSharing);
  expect(props.stats).toBe(f.base.peerStats);
  expect(props["active-job"]).toBe("job");
  expect(m.text(m.root)).toContain("Native fixture");
  expect(m.text(m.root)).toContain("Recalibrating fixture");
});

it.each([
  "disconnected",
  "non-controller",
  "inactive",
  "no-room",
  "no-state",
  "no-media",
  "closed-dialog",
])(
  "RoomPage baseline keeps the original management panel predicate: %s",
  async (variant) => {
    const env = environment(),
      f = fakeRuntime(),
      m = mountPage(f, env);
    await ticks();
    if (variant === "disconnected") f.base.connected = false;
    if (variant === "non-controller") {
      f.base.canManageRoom = false;
      f.permissions.clear();
    }
    if (variant === "inactive") f.base.roomActive = false;
    if (variant === "no-room") f.base.room = null;
    if (variant === "no-state") f.base.state = null;
    if (variant === "no-media") f.base.state.media_id = null;
    if (variant !== "closed-dialog") await m.openManagement();
    await ticks();
    expect(!!m.panel()).toBe(
      ["disconnected", "non-controller", "no-media"].includes(variant),
    );
    expect(f.callbacks.useDistributedOutput).not.toHaveBeenCalled();
    expect(f.callbacks.startPeerSharing).not.toHaveBeenCalled();
  },
);

it("RoomPage baseline live presentation short-circuits duration while retaining the original panel", async () => {
  const env = environment(),
    f = fakeRuntime({ live: true });
  f.spy(["live", "duration"]);
  const m = mountPage(f, env);
  expect(f.events.filter((event) => event.startsWith("read:"))).toEqual([
    "read:live",
  ]);
  expect(m.text(m.root)).toContain("直播");
  await m.openManagement();
  expect(m.panel()).toBeDefined();
});

it.each(["unqualified", "missing-generation"])(
  "RoomPage baseline keeps selected job qualification in the original panel: %s",
  async (variant) => {
    const env = environment(),
      f = fakeRuntime();
    const reply = computeReply();
    if (variant === "unqualified") reply.jobs[0].primary_qualified = false;
    else
      delete (reply.jobs[0] as { output_generation?: string })
        .output_generation;
    f.api.mockResolvedValue(reply);
    const m = mountPage(f, env);
    await m.openManagement();
    m.select("房间内计算产物", "job");
    await ticks();
    await m.button("用于房间主播放器").props.onClick();
    expect(f.callbacks.useDistributedOutput).not.toHaveBeenCalled();
    expect(m.text(m.root)).toContain("完整产物尚未通过主播放资格校验");
  },
);

it("RoomPage baseline activates the selected original job/audio and keeps panel error handling local", async () => {
  const env = environment(),
    f = fakeRuntime(),
    m = mountPage(f, env);
  await m.openManagement();
  m.select("房间内计算产物", "job");
  await ticks();
  const operation = deferred<void>();
  f.callbacks.useDistributedOutput.mockImplementationOnce(
    () => operation.promise,
  );
  const button = m.button("用于房间主播放器");
  const pending = button.props.onClick();
  expect(f.callbacks.useDistributedOutput).toHaveBeenCalledWith(
    { schema_version: 1, job_id: "job", output_generation: "output" },
    0,
  );
  await ticks();
  expect(button.props.disabled).toBe(true);
  await button.props.onClick();
  expect(f.callbacks.useDistributedOutput).toHaveBeenCalledTimes(1);
  operation.reject(Error("Original source failure"));
  await pending;
  await ticks();
  expect(button.props.disabled).toBe(false);
  expect(m.text(m.root)).toContain("Original source failure");
});

it("RoomPage baseline sharing uses real checkbox handlers and the three original consent fields", async () => {
  const env = environment(),
    f = fakeRuntime(),
    m = mountPage(f, env);
  await m.openManagement();
  const start = m.button("启用主播放器分片共享");
  await start.props.onClick();
  expect(f.callbacks.startPeerSharing).not.toHaveBeenCalled();
  expect(m.text(m.root)).toContain("请先确认当前网络、上传与地址披露");
  for (let index = 0; index < 3; index++) m.checkbox(index, true);
  await ticks();
  await start.props.onClick();
  expect(f.callbacks.startPeerSharing).toHaveBeenCalledWith({
    acknowledge_peer_addresses: true,
    confirm_current_network: true,
    upload_allowed: true,
  });
  f.base.peerSharing = true;
  await ticks();
  f.base.peerSharing = false;
  await ticks();
  expect(
    m
      .all()
      .filter((node) => node.tag === "input" && node.props.type === "checkbox")
      .map((node) => node.checked),
  ).toEqual([false, false, false]);
});

it.each([true, false])(
  "RoomPage baseline preserves nested display identity and lazy repeated reads: present=%s",
  (present) => {
    const env = environment(),
      f = fakeRuntime({
        duration: present ? 120 : 0,
        recoveryLabel: present ? "Recovering" : "",
      });
    f.base.playbackSummary = present
      ? Vue.markRaw({
          get mode() {
            f.events.push("read:summary.mode");
            return "Original mode";
          },
        })
      : undefined;
    f.spy(["live", "duration", "playbackSummary", "recoveryLabel"]);
    const m = mountPage(f, env);
    const facts = f.events.filter((event) => event.startsWith("read:"));
    expect(facts).toEqual(
      present
        ? [
            "read:live",
            "read:duration",
            "read:duration",
            "read:playbackSummary",
            "read:playbackSummary",
            "read:summary.mode",
            "read:recoveryLabel",
            "read:recoveryLabel",
          ]
        : [
            "read:live",
            "read:duration",
            "read:playbackSummary",
            "read:recoveryLabel",
          ],
    );
    expect(m.text(m.root)).toContain(present ? "2:00" : "1:30");
    expect(m.text(m.root).includes("Original mode")).toBe(present);
  },
);

it("RoomPage baseline keeps child callback capture until the original parent rerender", async () => {
  const env = environment(),
    f = fakeRuntime(),
    m = mountPage(f, env);
  await m.openManagement();
  m.select("房间内计算产物", "job");
  await ticks();
  const before = m.child("DistributedComputePanel").props.activate;
  const next = vi.fn(async () => {});
  f.base.useDistributedOutput = next;
  const pending = m.button("用于房间主播放器").props.onClick();
  expect(before).toBe(f.callbacks.useDistributedOutput);
  expect(f.callbacks.useDistributedOutput).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
  await pending;
  await ticks();
  expect(m.child("DistributedComputePanel").props.activate).toBe(next);
  await m.button("用于房间主播放器").props.onClick();
  expect(next).toHaveBeenCalledTimes(1);
});

it("RoomPage baseline passes current audio and exact replacement peer stats without cloning", async () => {
  const env = environment(),
    f = fakeRuntime(),
    m = mountPage(f, env);
  await m.openManagement();
  const first = m.panel().props.stats;
  expect(first).toBe(f.base.peerStats);
  f.base.audioIndex = 0;
  f.base.peerStats.peerBytes = 41;
  f.base.distributedFacts = { job_id: "successor" };
  await ticks();
  expect(m.panel().props.stats).toBe(first);
  expect(m.panel().props.audioIndex).toBe(0);
  expect(m.panel().props.activeJob).toBe("successor");
  expect(m.text(m.root)).toContain("Peer 接收 41 B");
  f.base.peerStats = { ...f.base.peerStats, peerBytes: 73 };
  await ticks();
  expect(m.panel().props.stats).toBe(f.base.peerStats);
  expect(m.panel().props.stats).not.toBe(first);
  expect(m.text(m.root)).toContain("Peer 接收 73 B");
});

it.each(["allowed", "inactive", "disconnected", "denied"])(
  "RoomPage baseline queue hover and focus use the original prewarm short circuit: %s",
  async (variant) => {
    const env = environment(),
      f = fakeRuntime(),
      m = mountPage(f, env);
    await ticks();
    const play = m.find(
      (node) =>
        node.tag === "button" &&
        String(node.props["aria-label"]).startsWith("播放 "),
    );
    if (variant === "inactive") f.base.roomActive = false;
    if (variant === "disconnected") f.base.connected = false;
    if (variant === "denied") f.permissions.delete("change_media");
    const expected = ["read:roomActive"];
    if (variant !== "inactive") expected.push("read:connected");
    if (!["inactive", "disconnected"].includes(variant))
      expected.push("read:can", "can:change_media");
    if (variant === "allowed")
      expected.push(
        "catalog:room:queued",
        "read:nativePlaybackMode",
        "prewarm:queued:auto",
      );
    for (const event of ["onPointerenter", "onFocus"]) {
      f.spy([
        "roomActive",
        "connected",
        "can",
        "catalog",
        "nativePlaybackMode",
      ]);
      expect(play.props[event]()).toBeUndefined();
      expect(f.events).toEqual(expected);
    }
    expect(f.runtime.choose).not.toHaveBeenCalled();
  },
);

it.each(["allowed", "denied"])(
  "RoomPage baseline queue click returns choose directly after optional prewarm: %s",
  async (variant) => {
    const env = environment(),
      f = fakeRuntime(),
      m = mountPage(f, env);
    await ticks();
    const play = m.find(
      (node) =>
        node.tag === "button" &&
        String(node.props["aria-label"]).startsWith("播放 "),
    );
    const sdk = deferred(),
      choice = deferred<boolean>();
    dashProbe.load.mockReturnValueOnce(sdk.promise);
    f.runtime.choose.mockImplementationOnce((id: string) => {
      f.events.push(`choose:${id}`);
      return choice.promise;
    });
    if (variant === "denied") f.permissions.delete("change_media");
    f.spy([
      "roomActive",
      "connected",
      "can",
      "catalog",
      "nativePlaybackMode",
      "choose",
    ]);
    const result = play.props.onClick();
    expect(result).toBe(choice.promise);
    expect(f.events).toEqual([
      "read:roomActive",
      "read:connected",
      "read:can",
      "can:change_media",
      ...(variant === "allowed"
        ? [
            "catalog:room:queued",
            "read:nativePlaybackMode",
            "prewarm:queued:auto",
          ]
        : []),
      "read:choose",
      "choose:queued",
    ]);
    choice.resolve(false);
    expect(await result).toBe(false);
    if (variant === "allowed") sdk.reject(Error("Optional SDK failure"));
    else sdk.resolve(undefined);
    await ticks();
    expect(f.callbacks.useDistributedOutput).not.toHaveBeenCalled();
  },
);

it("RoomPage baseline immediate media watcher keeps its original inputs and uses the staged mode only when called", async () => {
  const env = environment(),
    f = fakeRuntime();
  f.permissions.clear();
  const m = mountPage(f, env);
  await ticks();
  expect(f.prewarm).toHaveBeenCalledExactlyOnceWith(f.records.film, "auto");
  f.prewarm.mockClear();
  f.base.nativePlaybackMode = "adaptive";
  await ticks();
  expect(f.prewarm).not.toHaveBeenCalled();
  f.records.film = media("replacement-fact");
  await ticks();
  expect(f.prewarm).toHaveBeenCalledExactlyOnceWith(f.records.film, "adaptive");
  f.prewarm.mockClear();
  f.base.connected = false;
  f.records.film = media("disconnected-fact");
  await ticks();
  expect(f.prewarm).not.toHaveBeenCalled();
  f.base.connected = true;
  await ticks();
  expect(f.prewarm).not.toHaveBeenCalled();
  f.records.film = media("connected-fact");
  await ticks();
  expect(f.prewarm).toHaveBeenCalledExactlyOnceWith(f.records.film, "adaptive");
  expect(m.all().filter((node) => node.tag === "test-anchor")).toHaveLength(1);
});

it("RoomPage baseline queue click preserves a direct rejected choose Promise", async () => {
  const env = environment(),
    f = fakeRuntime(),
    m = mountPage(f, env);
  await ticks();
  const play = m.find(
    (node) =>
      node.tag === "button" &&
      String(node.props["aria-label"]).startsWith("播放 "),
  );
  const choice = deferred<boolean>();
  f.runtime.choose.mockReturnValueOnce(choice.promise);
  const result = play.props.onClick();
  expect(result).toBe(choice.promise);
  const rejected = expect(result).rejects.toThrow("Original queue failure");
  choice.reject(Error("Original queue failure"));
  await rejected;
});

it.each([0, 1, 2])(
  "RoomPage baseline refuses share when consent %s alone is absent",
  async (absent) => {
    const env = environment(),
      f = fakeRuntime(),
      m = mountPage(f, env);
    await m.openManagement();
    for (let index = 0; index < 3; index++) m.checkbox(index, index !== absent);
    await ticks();
    await m.button("启用主播放器分片共享").props.onClick();
    expect(f.callbacks.startPeerSharing).not.toHaveBeenCalled();
    expect(m.text(m.root)).toContain("请先确认当前网络、上传与地址披露");
  },
);

it.each(["identity", "media", "close"])(
  "RoomPage baseline retires local panel results and consent after %s",
  async (change) => {
    const env = environment(),
      f = fakeRuntime(),
      m = mountPage(f, env);
    await m.openManagement();
    for (let index = 0; index < 3; index++) m.checkbox(index, true);
    await ticks();
    const operation = deferred<void>();
    f.callbacks.startPeerSharing.mockImplementationOnce(
      () => operation.promise,
    );
    const old = m.button("启用主播放器分片共享").props.onClick();
    expect(f.callbacks.startPeerSharing).toHaveBeenCalledTimes(1);
    if (change === "identity") f.session.epoch++;
    if (change === "media") f.base.state.media_generation++;
    if (change === "close")
      m.find(
        (node) => node.tag === "test-dialog" && node.props.title === "房间管理",
      ).props.onClose();
    await ticks();
    operation.reject(Error("Retired panel failure"));
    await old;
    await ticks();
    expect(m.text(m.root)).not.toContain("Retired panel failure");
    if (change === "close") expect(m.panel()).toBeUndefined();
    else
      expect(
        m
          .all()
          .filter(
            (node) => node.tag === "input" && node.props.type === "checkbox",
          )
          .map((node) => node.checked),
      ).toEqual([false, false, false]);
    expect(f.callbacks.stopPeerSharing).not.toHaveBeenCalled();
  },
);

it("RoomPage baseline panel close cancels only its polling and retains owner sharing", async () => {
  const env = environment(),
    f = fakeRuntime({ peerSharing: true }),
    m = mountPage(f, env);
  await m.openManagement();
  expect(f.api).toHaveBeenCalledWith("/rooms/room/compute");
  m.find(
    (node) => node.tag === "test-dialog" && node.props.title === "房间管理",
  ).props.onClose();
  await ticks();
  const count = f.api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2500);
  expect(f.api).toHaveBeenCalledTimes(count);
  expect(f.base.peerSharing).toBe(true);
  expect(f.callbacks.stopPeerSharing).not.toHaveBeenCalled();
  await m.openManagement();
  expect(m.panel().props.sharing).toBe(true);
  expect(
    m
      .all()
      .filter((node) => node.tag === "input" && node.props.type === "checkbox")
      .map((node) => node.checked),
  ).toEqual([false, false, false]);
});

// A passthrough capture only. Production composition, owner action bodies,
// scope watchers, API client, Pinia and RoomP2PTransport stay real.
const roomPiniaCapture = vi.hoisted(() => ({ owner: undefined as any }));
vi.mock("../apps/web/src/app/viewing-runtime", async (original) => {
  const actual =
    await original<typeof import("../apps/web/src/app/viewing-runtime")>();
  return {
    ...actual,
    createViewingRuntime: (
      ...args: Parameters<typeof actual.createViewingRuntime>
    ) => {
      const result = actual.createViewingRuntime(...args);
      roomPiniaCapture.owner = result.playback;
      return result;
    },
  };
});
const roomPiniaHls = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("hls.js", () => ({
  default: class {
    static Events = {
      ERROR: "error",
      MANIFEST_PARSED: "manifest",
      LEVEL_SWITCHED: "level",
      CUES_PARSED: "cues",
    };
    static DefaultConfig = { loader: class {} };
    static isSupported = () => true;
    static getMediaSource = () => ({ isTypeSupported: () => true });
    readonly destroy = vi.fn();
    readonly stopLoad = vi.fn();
    readonly startLoad = vi.fn();
    readonly loadSource = vi.fn();
    readonly attachMedia = vi.fn();
    readonly on = vi.fn();
    readonly off = vi.fn();
    constructor(readonly config: unknown) {
      roomPiniaHls.instances.push(this);
    }
  },
}));

const roomPiniaCleanups: (() => Promise<void> | void)[] = [];
beforeAll(async () => {
  // The real lazy driver's initial module import is not the boundary under
  // test. Finish it before measuring action Promise microtask settlement.
  const { loadHlsDriver } =
    await import("../apps/web/src/features/playback/hls-driver-loader");
  await loadHlsDriver();
});
const roomPiniaId = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const roomPiniaIntent = {
  schema_version: 1,
  job_id: roomPiniaId(10),
  output_generation: roomPiniaId(11),
};
const roomPiniaConsent = {
  acknowledge_peer_addresses: true,
  confirm_current_network: true,
  upload_allowed: true,
};
function roomPiniaDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function roomPiniaTicks(count = 1) {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
async function roomPiniaUntil(predicate: () => boolean, label: string) {
  for (let index = 0; index < 400 && !predicate(); index++)
    await Promise.resolve();
  expect(predicate(), label).toBe(true);
}
function roomPiniaPlan(
  request: PlaybackRequest,
  session: string,
  distributed: boolean,
): PlaybackPlan {
  const audio = request.audio_index ?? null;
  const value: PlaybackPlan = {
    session_id: session,
    plan_generation: request.plan_generation,
    media_id: roomPiniaId(4),
    media_generation: request.media_generation,
    delivery_mode: distributed ? "transcode" : "direct",
    transport: distributed ? "hls" : "progressive",
    playback_url: distributed
      ? `/api/v1/playback-sessions/${session}/distributed/files/index.m3u8`
      : `/original-${session}.mp4`,
    timeline_origin_ms: 0,
    duration_ms: 16000,
    expires_in_seconds: 600,
    rebuild_on_seek: false,
    selected_audio_track: audio ?? undefined,
    audio_tracks:
      audio === null
        ? []
        : [{ index: audio, label: "Audio", language: "eng", codec: "aac" }],
    subtitle_tracks: [],
    subtitle_mode: "none",
    seekable_media_ranges_ms: [{ start_ms: 0, end_ms: 16000 }],
    decoder_fallback_modes: [],
  };
  if (distributed)
    value.distributed_compute = {
      ...request.distributed_compute!,
      attempt: 2,
      qualification_sha256: "a".repeat(64),
      manifest_sha256: "b".repeat(64),
      directory_url: `/api/v1/playback-sessions/${session}/distributed/directory`,
      p2p_enabled: true,
      source_video_index: 0,
      source_audio_index: audio,
      video_codec: "h264",
      width: 852,
      height: 480,
      audio_codec: audio === null ? null : "aac",
      audio_channels: audio === null ? null : 2,
      audio_sample_rate: audio === null ? null : 48000,
      source_duration_ms: 16000,
      timestamp_shift_ms: 1480,
    };
  return value;
}
function roomPiniaFixture(presentation?: Environment) {
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
  const effects: string[] = [];
  let stopFault: Error | undefined;
  class Document extends EventTarget {
    visibilityState = "visible";
    removeEventListener(type: string, callback: any, options?: any) {
      if (type === "visibilitychange") {
        effects.push("document:remove-visibility");
        if (stopFault) {
          const error = stopFault;
          stopFault = undefined;
          throw error;
        }
      }
      super.removeEventListener(type, callback, options);
    }
  }
  vi.stubGlobal("document", presentation?.document ?? new Document());
  vi.stubGlobal("window", presentation?.window ?? new EventTarget());
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("self", { MediaSource: { isTypeSupported: () => true } });
  vi.stubGlobal("location", {
    origin: "http://localhost",
    protocol: "http:",
    host: "localhost",
    href: `http://localhost/rooms/${roomPiniaId(2)}`,
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    readonly send = vi.fn();
    readonly close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const requests: { path: string; method: string; body: any }[] = [];
  const grants: PlaybackPlan[] = [];
  const control = {
    compute: computeReply({
      jobs: [
        {
          id: roomPiniaIntent.job_id,
          status: "ready",
          recipe: "h264_480p_hls_v1",
          attempt: 1,
          output_generation: roomPiniaIntent.output_generation,
          primary_qualified: true,
          selected_audio_index: 0,
        },
      ],
    }),
    playlist: [] as Record<string, unknown>[],
    badDistributedPlan: false,
    failGrant: undefined as Error | undefined,
    grantGate: undefined as
      ReturnType<typeof roomPiniaDeferred<Response>> | undefined,
    peerGate: undefined as
      ReturnType<typeof roomPiniaDeferred<Response>> | undefined,
    deleteGate: undefined as
      ReturnType<typeof roomPiniaDeferred<Response>> | undefined,
  };
  const peerReply = (p: PlaybackPlan) => ({
    peer_id: roomPiniaId(20),
    peers: [],
    output_generation: roomPiniaIntent.output_generation,
    authorization: {
      version: 1,
      peer_id: roomPiniaId(20),
      room_id: roomPiniaId(2),
      job_id: roomPiniaIntent.job_id,
      output_generation: roomPiniaIntent.output_generation,
      session_id: p.session_id,
      lease_ms: 3000,
      peers: [],
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api\/v1/, "");
      const method = init.method ?? "GET";
      const body =
        init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      effects.push(`http:${method}:${path}`);
      if (path === `/rooms/${roomPiniaId(2)}/compute` && method === "GET")
        return Response.json(control.compute);
      if (path === `/rooms/${roomPiniaId(2)}/playlist` && method === "GET")
        return Response.json(control.playlist);
      if (
        (path === "/playback-sessions/distributed-compute" ||
          path === "/playback-sessions") &&
        method === "POST"
      ) {
        if (control.failGrant) throw control.failGrant;
        const p = roomPiniaPlan(
          body,
          roomPiniaId(100 + grants.length),
          path.includes("distributed-compute"),
        );
        if (control.badDistributedPlan && p.distributed_compute)
          p.distributed_compute.output_generation = roomPiniaId(999);
        grants.push(p);
        return control.grantGate?.promise ?? Response.json(p);
      }
      const p = grants.find((value) =>
        path.startsWith(`/playback-sessions/${value.session_id}/distributed/`),
      );
      if (p && path.endsWith("/directory"))
        return Response.json({
          session_id: p.session_id,
          job_id: roomPiniaIntent.job_id,
          output_generation: roomPiniaIntent.output_generation,
          files: [
            {
              name: "index.m3u8",
              url: p.playback_url,
              sha256: "b".repeat(64),
              size_bytes: 100,
            },
            {
              name: "segment00000.ts",
              url: `/api/v1/playback-sessions/${p.session_id}/distributed/files/segment00000.ts`,
              sha256: "c".repeat(64),
              size_bytes: 1000,
            },
          ],
        });
      if (p && path.endsWith("/p2p") && method === "POST")
        return control.peerGate?.promise ?? Response.json(peerReply(p));
      if (path === `/room-p2p/${roomPiniaId(20)}` && method === "DELETE")
        return control.deleteGate?.promise ?? Response.json({});
      const ready = grants.find((value) =>
        path.startsWith(`/playback-sessions/${value.session_id}?`),
      );
      if (ready)
        return Response.json({
          session_id: ready.session_id,
          plan_generation: ready.plan_generation,
          status: "ready",
          complete: true,
        });
      if (path === "/playback-candidates")
        return Response.json({
          schema_version: 1,
          binding: null,
          candidates: [],
          decision_reason: "legacy_transport_fallback",
        });
      if (path.includes("/media/"))
        return Response.json({
          id: roomPiniaId(4),
          title: "Synthetic movie",
          kind: "file",
        });
      return Response.json([]);
    }),
  );
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({
    id: roomPiniaId(1),
    username: "viewer",
    admin: false,
    csrf: "synthetic-room-probe",
  });
  const runtime = useRoomRuntime();
  const owner = roomPiniaCapture.owner;
  const ranges = { length: 1, start: () => 0, end: () => 16 };
  const element: any = Object.assign(new EventTarget(), {
    src: "",
    currentTime: 0,
    duration: 16,
    playbackRate: 1,
    readyState: 4,
    paused: true,
    ended: false,
    seeking: false,
    error: null,
    buffered: ranges,
    seekable: ranges,
    canPlayType: (mime: string) => (mime.includes("mpegurl") ? "" : "probably"),
    querySelectorAll: () => [],
    getAttribute: (name: string) => (name === "src" ? element.src : null),
    removeAttribute: (name: string) => {
      effects.push(`media:remove:${name}`);
      if (name === "src") element.src = "";
    },
    load: () => effects.push("media:load"),
    pause: () => {
      element.paused = true;
      effects.push("media:pause");
    },
    play: async () => {
      element.paused = false;
      effects.push("media:play");
    },
  });
  roomPiniaCleanups.push(async () => {
    control.grantGate?.resolve(Response.json(grants.at(-1) ?? {}));
    control.peerGate?.resolve(Response.json(peerReply(grants.at(-1)!)));
    control.deleteGate?.resolve(Response.json({}));
    stopFault = undefined;
    await runtime.leave();
    disposePinia(pinia);
  });
  async function ready() {
    runtime.attach(element);
    await runtime.enter({
      id: roomPiniaId(2),
      name: "Room",
      owner_id: roomPiniaId(1),
    });
    const socket = sockets[0];
    socket.onopen();
    const frame = (value: unknown) =>
      socket.onmessage({ data: JSON.stringify(value) });
    frame({
      type: "SNAPSHOT",
      control_epoch: { id: "control" },
      state: {
        room_id: roomPiniaId(2),
        revision: 1,
        media_id: null,
        media_generation: 4,
        playback_status: "paused",
        anchor_position_ms: 5000,
        anchor_server_time_ms: 0,
        playback_rate: 1,
        controller_user_id: roomPiniaId(1),
        duration_ms: 16000,
        clock_epoch: "epoch",
      },
    });
    const request = socket.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .find((v: any) => v.type === "CLOCK_SYNC");
    expect(request).toBeDefined();
    frame({
      type: "CLOCK_SYNC_REPLY",
      t1: request.t1,
      t2: 100,
      t3: 100,
      clock_epoch: "epoch",
    });
    await roomPiniaTicks(60);
    runtime.state = { ...runtime.state!, media_id: roomPiniaId(4) };
    await roomPiniaTicks(60);
    expect(runtime.connected).toBe(true);
    effects.length = 0;
    requests.length = 0;
  }
  return {
    runtime,
    owner,
    session,
    effects,
    requests,
    grants,
    control,
    element,
    ready,
    peerReply,
    failNextStop: (error: Error) => {
      stopFault = error;
    },
  };
}

type RoomPiniaFixture = ReturnType<typeof roomPiniaFixture>;
function roomPiniaActionProbe(f: RoomPiniaFixture) {
  let tick = 0;
  const events: string[] = [];
  const calls: { name: string; args: unknown[]; sameStore: boolean }[] = [];
  const unsubscribe = f.runtime.$onAction(
    ({ name, args, store, after, onError }) => {
      calls.push({ name, args, sameStore: store === f.runtime });
      events.push(`${tick}:before:${name}`);
      after((value) => events.push(`${tick}:after:${name}:${String(value)}`));
      onError((error) =>
        events.push(
          `${tick}:error:${name}:${(error as Error).name}:${(error as Error).message}`,
        ),
      );
    },
  );
  roomPiniaCleanups.push(unsubscribe);
  return {
    events,
    calls,
    stop: unsubscribe,
    record: (value: string) => events.push(`${tick}:${value}`),
    async advance(count = 1) {
      for (let index = 0; index < count; index++) {
        tick++;
        await Promise.resolve();
      }
    },
    async observe(call: () => Promise<unknown>, count = 12) {
      const result = call();
      expect(result).toBeInstanceOf(Promise);
      events.push(`${tick}:returned:Promise`);
      let outcome:
        { status: string; value?: unknown; error?: unknown } | undefined;
      result.then(
        (value) => {
          outcome = { status: "fulfilled", value };
          events.push(`${tick}:public:fulfilled:${String(value)}`);
        },
        (error) => {
          outcome = { status: "rejected", error };
          events.push(`${tick}:public:rejected:${error.name}:${error.message}`);
        },
      );
      for (tick = 1; tick <= count; tick++) await Promise.resolve();
      return { result, outcome, events: [...events], calls: [...calls] };
    },
  };
}
const roomPiniaDraftSeed = {
  audioIndex: 7,
  mode: "transcode",
  advancedCapabilities: { seed: "capability" },
  advancedFacts: { seed: "advanced-facts" },
  toneMapHdr: true,
  burnInSubtitleIndex: 3,
  localHlsLadderEnabled: true,
  ladderCapabilities: { seed: "ladder-capability" },
  ladderFacts: { seed: "ladder-facts" },
  ladderQuality: "low",
  ladderSelected: "low",
  ladderManual: true,
  staticHlsFallbackEnabled: true,
  staticHlsAvailability: { seed: "static-availability" },
};
function seedRoomPiniaDrafts(owner: any) {
  for (const [key, value] of Object.entries(roomPiniaDraftSeed))
    owner[key].value = value;
}
function watchRoomPiniaDrafts(owner: any, record: (value: string) => void) {
  for (const key of [
    "audioIndex",
    "distributedIntent",
    ...Object.keys(roomPiniaDraftSeed).filter((key) => key !== "audioIndex"),
    "preparation",
  ])
    roomPiniaCleanups.push(
      Vue.watch(
        owner[key],
        (value) =>
          record(
            `${key}:${value === undefined ? "undefined" : JSON.stringify(value)}`,
          ),
        { flush: "sync" },
      ),
    );
}

it.each([
  ["useDistributedOutput", [roomPiniaIntent]],
  ["useOriginalSource", []],
  ["startPeerSharing", [roomPiniaConsent]],
  ["stopPeerSharing", []],
] as const)(
  "Room actual Pinia original %s captures direct no-room Promise hooks",
  async (name, args) => {
    const f = roomPiniaFixture();
    const probe = roomPiniaActionProbe(f);
    expect(roomPlayback(f.runtime)[name]).not.toBe(f.owner[name]);
    const result = await probe.observe(() =>
      (roomPlayback(f.runtime)[name] as any)(...args),
    );
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].name).toBe(name);
    expect(probe.calls[0].sameStore).toBe(true);
    expect(probe.calls[0].args).toHaveLength(args.length);
    args.forEach((arg, index) => expect(probe.calls[0].args[index]).toBe(arg));
    expect(f.runtime.busy).toBe(false);
    expect(f.runtime.error).toBe("");
    if (name === "startPeerSharing")
      await expect(result.result).rejects.toThrow(
        "当前主播放器不能启用 P2P 分片共享",
      );
    else await expect(result.result).resolves.toBeUndefined();

    expect(probe.events).toEqual(roomActionBaseline[`no-room:${name}`]);
  },
);

it.each([
  ["omitted", []],
  ["undefined", [undefined]],
  ["null", [null]],
  ["zero", [0]],
  ["negative", [-1]],
  ["fraction", [0.5]],
  ["overflow", [65536]],
  ["NaN", [NaN]],
  ["string", ["0"]],
] as const)(
  "Room actual Pinia original distributed audio %s preserves validation and source-write order",
  async (label, audio) => {
    const f = roomPiniaFixture();
    seedRoomPiniaDrafts(f.owner);
    const input = { ...roomPiniaIntent };
    const probe = roomPiniaActionProbe(f);
    watchRoomPiniaDrafts(f.owner, probe.record);
    const result = await probe.observe(() =>
      (roomPlayback(f.runtime).useDistributedOutput as any)(input, ...audio),
    );
    expect(probe.calls[0]).toEqual({
      name: "useDistributedOutput",
      args: [input, ...audio],
      sameStore: true,
    });
    expect(probe.calls[0].args[0]).toBe(input);
    const valid = ["omitted", "undefined", "null", "zero"].includes(label);
    if (valid) {
      await expect(result.result).resolves.toBeUndefined();
      expect(f.owner.audioIndex.value).toBe(
        label === "null" ? undefined : label === "zero" ? 0 : 7,
      );
      expect(f.owner.distributedIntent.value).toEqual(roomPiniaIntent);
      expect(f.owner.distributedIntent.value).not.toBe(input);
      expect(Object.isFrozen(f.owner.distributedIntent.value)).toBe(true);
      input.job_id = roomPiniaId(999);
      expect(f.owner.distributedIntent.value.job_id).toBe(
        roomPiniaIntent.job_id,
      );
    } else {
      await expect(result.result).rejects.toThrow("原片音轨编号无效");
      for (const [key, value] of Object.entries(roomPiniaDraftSeed))
        expect(f.owner[key].value).toEqual(value);
      expect(f.owner.distributedIntent.value).toBeUndefined();
    }
    expect(f.requests).toHaveLength(0);

    expect(probe.events).toEqual(roomActionBaseline[`audio:${label}`]);
  },
);

it("Room actual Pinia original invalid intent rejects before audio or any source draft write", async () => {
  const f = roomPiniaFixture();
  seedRoomPiniaDrafts(f.owner);
  const probe = roomPiniaActionProbe(f);
  watchRoomPiniaDrafts(f.owner, probe.record);
  const invalid = { ...roomPiniaIntent, extra: "invalid" };
  const result = await probe.observe(() =>
    roomPlayback(f.runtime).useDistributedOutput(invalid, -1),
  );
  await expect(result.result).rejects.toThrow("NAS 产物绑定无效");
  expect(probe.calls[0].args).toEqual([invalid, -1]);
  for (const [key, value] of Object.entries(roomPiniaDraftSeed))
    expect(f.owner[key].value).toEqual(value);

  expect(probe.events).toEqual(roomActionBaseline["invalid-intent"]);
});

it("Room actual Pinia original-source no-op clears only distributed draft and retains all other drafts", async () => {
  const f = roomPiniaFixture();
  await roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent);
  seedRoomPiniaDrafts(f.owner);
  const probe = roomPiniaActionProbe(f);
  watchRoomPiniaDrafts(f.owner, probe.record);
  const result = await probe.observe(() =>
    roomPlayback(f.runtime).useOriginalSource(),
  );
  await expect(result.result).resolves.toBeUndefined();
  expect(f.owner.distributedIntent.value).toBeUndefined();
  for (const [key, value] of Object.entries(roomPiniaDraftSeed))
    expect(f.owner[key].value).toEqual(value);

  expect(probe.events).toEqual(roomActionBaseline["original-retained-drafts"]);
});

it.each(["useDistributedOutput", "useOriginalSource"] as const)(
  "Room actual Pinia original %s rejects a real beginLoad accessor failure without runPlayback",
  async (name) => {
    const f = roomPiniaFixture();
    let throwNext = false;
    const failure = new Error("synthetic-source-read-failed");
    f.runtime.room = {
      id: roomPiniaId(2),
      name: "Room",
      owner_id: roomPiniaId(1),
    };
    f.runtime.state = {
      room_id: roomPiniaId(2),
      media_generation: 4,
      clock_epoch: "epoch",
      playback_rate: 1,
      playback_status: "paused",
      anchor_position_ms: 0,
      anchor_server_time_ms: 0,
      get media_id() {
        if (throwNext) {
          throwNext = false;
          throw failure;
        }
        return roomPiniaId(4);
      },
    } as any;
    await roomPiniaTicks(60);
    f.owner.distributedIntent.value = Object.freeze({ ...roomPiniaIntent });
    seedRoomPiniaDrafts(f.owner);
    const probe = roomPiniaActionProbe(f);
    watchRoomPiniaDrafts(f.owner, probe.record);
    throwNext = true;
    const result = await probe.observe(() =>
      name === "useDistributedOutput"
        ? roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent, 0)
        : roomPlayback(f.runtime).useOriginalSource(),
    );
    await expect(result.result).rejects.toBe(failure);
    expect(probe.calls.map((call) => call.name)).toEqual([name]);
    expect(f.runtime.busy).toBe(false);
    expect(f.runtime.error).toBe("");

    expect(probe.events).toEqual(
      roomActionBaseline[`load-accessor-failed:${name}`],
    );
  },
);

it("Room actual Pinia original successful grants use the real API client, driver and peer lifecycle", async () => {
  const f = roomPiniaFixture();
  await f.ready();
  const probe = roomPiniaActionProbe(f);
  const loaded = await probe.observe(
    () => roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent, 0),
    160,
  );
  await expect(loaded.result).resolves.toBeUndefined();
  expect(f.grants).toHaveLength(1);
  expect(
    f.requests.find(
      (request) => request.path === "/playback-sessions/distributed-compute",
    )!.body,
  ).toMatchObject({
    distributed_compute: roomPiniaIntent,
    audio_index: 0,
    position_ms: 5000,
  });
  expect(f.runtime.playbackHost.sessionId).toBe(f.grants[0].session_id);
  expect(roomPiniaHls.instances).toHaveLength(1);
  expect(f.owner.peerSharing.value).toBe(false);
  const start = roomPiniaActionProbe(f);
  const started = await start.observe(
    () => roomPlayback(f.runtime).startPeerSharing(roomPiniaConsent),
    80,
  );
  await expect(started.result).resolves.toBeUndefined();
  expect(f.owner.peerSharing.value).toBe(true);
  expect(start.calls[0].args[0]).toBe(roomPiniaConsent);
  const stop = roomPiniaActionProbe(f);
  const stopped = await stop.observe(
    () => roomPlayback(f.runtime).stopPeerSharing(),
    80,
  );
  await expect(stopped.result).resolves.toBeUndefined();
  expect(f.owner.peerSharing.value).toBe(false);
  const original = roomPiniaActionProbe(f);
  const switched = await original.observe(
    () => roomPlayback(f.runtime).useOriginalSource(),
    160,
  );
  await expect(switched.result).resolves.toBeUndefined();
  expect(f.grants).toHaveLength(2);
  expect(f.grants[1].distributed_compute).toBeUndefined();
  expect(f.owner.distributedIntent.value).toBeUndefined();
  expect(f.owner.audioIndex.value).toBe(0);
  expect(f.element.src).toBe(f.grants[1].playback_url);

  expect({
    loaded: loaded.events.slice(0, 4),
    started: started.events.slice(0, 4),
    stopped: stopped.events.slice(0, 4),
    switched: switched.events,
  }).toEqual(roomActionBaseline["successful-actions"]);
});

it.each(["useDistributedOutput", "useOriginalSource"] as const)(
  "Room actual Pinia original %s preserves direct grant rejection and hooks",
  async (name) => {
    const f = roomPiniaFixture();
    await f.ready();
    const failure = new Error("synthetic-grant-failed");
    f.control.failGrant = failure;
    const probe = roomPiniaActionProbe(f);
    const result = await probe.observe(
      () =>
        name === "useDistributedOutput"
          ? roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent)
          : roomPlayback(f.runtime).useOriginalSource(),
      160,
    );
    await expect(result.result).rejects.toBe(failure);
    expect(probe.calls.map((call) => call.name)).toEqual([name]);
    expect(f.runtime.busy).toBe(false);

    expect(probe.events).toEqual(roomActionBaseline[`grant-failed:${name}`]);
  },
);

it.each([
  "acknowledge_peer_addresses",
  "confirm_current_network",
  "upload_allowed",
] as const)(
  "Room actual Pinia original peer start rejects missing %s inside the real peer",
  async (missing) => {
    const f = roomPiniaFixture();
    await f.ready();
    await roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent);
    const probe = roomPiniaActionProbe(f);
    const submitted = { ...roomPiniaConsent, [missing]: false };
    const result = await probe.observe(
      () => roomPlayback(f.runtime).startPeerSharing(submitted),
      30,
    );
    await expect(result.result).rejects.toThrow(
      "启用前请确认上传与网络地址披露",
    );
    expect(probe.calls[0].args[0]).toBe(submitted);
    expect(f.requests.some((request) => request.path.endsWith("/p2p"))).toBe(
      false,
    );

    expect(probe.events).toEqual(
      roomActionBaseline[`missing-consent:${missing}`],
    );
  },
);

it("Room actual Pinia original stop propagates a synthetic document failure from the real peer stop", async () => {
  const f = roomPiniaFixture();
  await f.ready();
  await roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent);
  await roomPlayback(f.runtime).startPeerSharing(roomPiniaConsent);
  const failure = new Error("synthetic-remove-listener-failed");
  f.failNextStop(failure);
  const probe = roomPiniaActionProbe(f);
  const result = await probe.observe(() =>
    roomPlayback(f.runtime).stopPeerSharing(),
  );
  await expect(result.result).rejects.toBe(failure);
  // This is an injected DOM exception, not a claim about ordinary stop failure.
  expect(f.owner.peerSharing.value).toBe(true);

  expect(probe.events).toEqual(roomActionBaseline["stop-environment-failure"]);
});

it("Room actual Pinia original advanced-scope cleanup calls raw stop without a public action", async () => {
  const f = roomPiniaFixture();
  await f.ready();
  await roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent);
  await roomPlayback(f.runtime).startPeerSharing(roomPiniaConsent);
  const gate = roomPiniaDeferred<Response>();
  f.control.deleteGate = gate;
  const probe = roomPiniaActionProbe(f);
  roomPiniaCleanups.push(
    Vue.watch(
      f.owner.peerSharing,
      (value) => probe.record(`sharing:${value}`),
      { flush: "sync" },
    ),
  );
  roomPiniaCleanups.push(
    Vue.watch(
      f.owner.distributedIntent,
      (value) => probe.record(`distributed:${String(value)}`),
      { flush: "sync" },
    ),
  );
  f.effects.length = 0;
  f.runtime.state!.media_generation++;
  probe.record("state-write-returned");
  expect(probe.calls).toEqual([]);
  expect(f.owner.distributedIntent.value).toBeUndefined();
  expect(f.effects).toContain(`http:DELETE:/room-p2p/${roomPiniaId(20)}`);
  expect(f.owner.peerSharing.value).toBe(true);
  gate.resolve(Response.json({}));
  for (let index = 0; index < 30 && f.owner.peerSharing.value; index++)
    await probe.advance();
  expect(f.owner.peerSharing.value).toBe(false);
  expect(probe.calls).toEqual([]);

  expect(probe.events).toEqual(roomActionBaseline["raw-scope-stop"]);
});

it.each([
  ["omitted", [], 7],
  ["null", [null], null],
  ["zero", [0], 0],
] as const)(
  "Room actual Pinia original %s audio reaches the genuine grant after ordered draft cleanup",
  async (label, audio, expected) => {
    const f = roomPiniaFixture();
    await f.ready();
    seedRoomPiniaDrafts(f.owner);
    f.effects.length = 0;
    watchRoomPiniaDrafts(f.owner, (event) => f.effects.push(`draft:${event}`));
    const probe = roomPiniaActionProbe(f);
    const result = await probe.observe(
      () =>
        (roomPlayback(f.runtime).useDistributedOutput as any)(
          roomPiniaIntent,
          ...audio,
        ),
      160,
    );
    await expect(result.result).resolves.toBeUndefined();
    const request = f.requests.find(
      (item) => item.path === "/playback-sessions/distributed-compute",
    );
    expect(request?.body.audio_index).toBe(expected);
    expect(f.owner.distributedFacts.value.source_audio_index).toBe(expected);
    expect(f.grants).toHaveLength(1);
    const sequence = f.effects.filter(
      (event) =>
        event.startsWith("draft:") ||
        event.startsWith("media:") ||
        event === "http:POST:/playback-sessions/distributed-compute",
    );

    expect(sequence).toEqual(roomActionBaseline[`successful-audio:${label}`]);
  },
);

it("Room actual Pinia original qualified-plan mismatch rejects through its original wrapper", async () => {
  const f = roomPiniaFixture();
  await f.ready();
  f.control.badDistributedPlan = true;
  const probe = roomPiniaActionProbe(f);
  const result = await probe.observe(
    () => roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent),
    160,
  );
  await expect(result.result).rejects.toMatchObject({
    code: "STALE_CAPABILITY_REPORT",
  });
  expect(f.runtime.playbackHost.sessionId).toBeNull();
  expect(roomPiniaHls.instances).toHaveLength(0);
  expect(probe.calls.map((call) => call.name)).toEqual([
    "useDistributedOutput",
  ]);

  expect(probe.events).toEqual(roomActionBaseline["plan-mismatch"]);
});

it("Room actual Pinia original-source switch during a pending peer join keeps late cleanup raw", async () => {
  const f = roomPiniaFixture();
  await f.ready();
  await roomPlayback(f.runtime).useDistributedOutput(roomPiniaIntent, 0);
  const distributed = f.grants[0];
  const gate = roomPiniaDeferred<Response>();
  f.control.peerGate = gate;
  const probe = roomPiniaActionProbe(f);
  let startFailure: unknown;
  const starting = roomPlayback(f.runtime).startPeerSharing(roomPiniaConsent);
  starting.catch((error) => {
    startFailure = error;
    probe.record(`start-caller:${error.name}:${error.message}`);
  });
  await roomPiniaUntil(
    () =>
      f.requests.some((request) => request.path.endsWith("/distributed/p2p")),
    "peer join entered",
  );
  probe.record("original-click");
  const original = roomPlayback(f.runtime).useOriginalSource();
  original.then(() => probe.record("original-caller:fulfilled"));
  await original;
  expect(f.owner.distributedIntent.value).toBeUndefined();
  expect(f.grants).toHaveLength(2);
  expect(f.runtime.playbackHost.sessionId).toBe(f.grants[1].session_id);
  expect(f.owner.audioIndex.value).toBe(0);
  expect(startFailure).toBeUndefined();
  probe.record("late-join-release");
  gate.resolve(Response.json(f.peerReply(distributed)));
  await expect(starting).rejects.toMatchObject({ name: "AbortError" });
  await roomPiniaTicks(10);
  expect(f.owner.peerSharing.value).toBe(false);
  expect(f.runtime.playbackHost.sessionId).toBe(f.grants[1].session_id);
  expect(probe.calls.map((call) => call.name)).toEqual([
    "startPeerSharing",
    "useOriginalSource",
  ]);
  expect(
    f.requests.filter(
      (request) =>
        request.path === `/room-p2p/${roomPiniaId(20)}` &&
        request.method === "DELETE",
    ),
  ).toHaveLength(1);

  expect(probe.events).toEqual(roomActionBaseline["original-during-peer-join"]);
});

it("Room actual Pinia original-source switch while a distributed grant is outstanding keeps only successor authority", async () => {
  const f = roomPiniaFixture();
  await f.ready();
  const gate = roomPiniaDeferred<Response>();
  f.control.grantGate = gate;
  const probe = roomPiniaActionProbe(f);
  const distributed = roomPlayback(f.runtime).useDistributedOutput(
    roomPiniaIntent,
    0,
  );
  distributed.then(
    () => probe.record("distributed-caller:fulfilled"),
    (error) =>
      probe.record(`distributed-caller:${error.name}:${error.message}`),
  );
  await roomPiniaUntil(
    () => f.grants.length === 1,
    "distributed grant entered",
  );
  const stalePlan = f.grants[0];
  f.control.grantGate = undefined;
  probe.record("original-click");
  const original = roomPlayback(f.runtime).useOriginalSource();
  original.then(() => probe.record("original-caller:fulfilled"));
  expect(f.owner.distributedIntent.value).toBeUndefined();
  probe.record("late-grant-release");
  gate.resolve(Response.json(stalePlan));
  await expect(distributed).resolves.toBeUndefined();
  await expect(original).resolves.toBeUndefined();
  expect(f.grants).toHaveLength(2);
  expect(f.runtime.playbackHost.sessionId).toBe(f.grants[1].session_id);
  expect(f.element.src).toBe(f.grants[1].playback_url);
  expect(roomPiniaHls.instances).toHaveLength(0);
  expect(probe.calls.map((call) => call.name)).toEqual([
    "useDistributedOutput",
    "useOriginalSource",
  ]);
  const firstRequest = f.requests.find(
    (request) => request.path === "/playback-sessions/distributed-compute",
  )!;
  expect(
    f.requests.some(
      (request) =>
        request.path ===
          `/playback-requests/${firstRequest.body.idempotency_key}` &&
        request.method === "DELETE",
    ),
  ).toBe(true);
  // Record the exact accepted owner's cleanup route; do not invent a second
  // per-SID DELETE contract for a grant that its request owner already retired.
  expect(
    f.requests.some(
      (request) =>
        request.path === `/playback-sessions/${stalePlan.session_id}` &&
        request.method === "DELETE",
    ),
  ).toEqual(false);

  expect(probe.events).toEqual(roomActionBaseline["original-during-grant"]);
});

// Learned only from the accepted 69dc4bc source with these synthetic inputs.
// These traces preserve existing behavior; they are not new product contracts.
const roomActionBaseline: Record<string, unknown> = {
  "no-room:useDistributedOutput": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:after:useDistributedOutput:undefined",
    "4:public:fulfilled:undefined",
  ],
  "no-room:useOriginalSource": [
    "0:before:useOriginalSource",
    "0:returned:Promise",
    "2:after:useOriginalSource:undefined",
    "4:public:fulfilled:undefined",
  ],
  "no-room:startPeerSharing": [
    "0:before:startPeerSharing",
    "0:returned:Promise",
    "2:error:startPeerSharing:Error:当前主播放器不能启用 P2P 分片共享",
    "5:public:rejected:Error:当前主播放器不能启用 P2P 分片共享",
  ],
  "no-room:stopPeerSharing": [
    "0:before:stopPeerSharing",
    "0:returned:Promise",
    "2:after:stopPeerSharing:undefined",
    "4:public:fulfilled:undefined",
  ],
  "audio:omitted": [
    "0:before:useDistributedOutput",
    '0:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    '0:mode:"auto"',
    "0:advancedCapabilities:undefined",
    "0:advancedFacts:undefined",
    "0:toneMapHdr:false",
    "0:burnInSubtitleIndex:undefined",
    "0:localHlsLadderEnabled:false",
    "0:ladderCapabilities:undefined",
    "0:ladderFacts:undefined",
    '0:ladderQuality:"auto"',
    "0:ladderSelected:undefined",
    "0:ladderManual:false",
    "0:staticHlsFallbackEnabled:false",
    "0:staticHlsAvailability:undefined",
    "0:returned:Promise",
    "2:after:useDistributedOutput:undefined",
    "4:public:fulfilled:undefined",
  ],
  "audio:undefined": [
    "0:before:useDistributedOutput",
    '0:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    '0:mode:"auto"',
    "0:advancedCapabilities:undefined",
    "0:advancedFacts:undefined",
    "0:toneMapHdr:false",
    "0:burnInSubtitleIndex:undefined",
    "0:localHlsLadderEnabled:false",
    "0:ladderCapabilities:undefined",
    "0:ladderFacts:undefined",
    '0:ladderQuality:"auto"',
    "0:ladderSelected:undefined",
    "0:ladderManual:false",
    "0:staticHlsFallbackEnabled:false",
    "0:staticHlsAvailability:undefined",
    "0:returned:Promise",
    "2:after:useDistributedOutput:undefined",
    "4:public:fulfilled:undefined",
  ],
  "audio:null": [
    "0:before:useDistributedOutput",
    "0:audioIndex:undefined",
    '0:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    '0:mode:"auto"',
    "0:advancedCapabilities:undefined",
    "0:advancedFacts:undefined",
    "0:toneMapHdr:false",
    "0:burnInSubtitleIndex:undefined",
    "0:localHlsLadderEnabled:false",
    "0:ladderCapabilities:undefined",
    "0:ladderFacts:undefined",
    '0:ladderQuality:"auto"',
    "0:ladderSelected:undefined",
    "0:ladderManual:false",
    "0:staticHlsFallbackEnabled:false",
    "0:staticHlsAvailability:undefined",
    "0:returned:Promise",
    "2:after:useDistributedOutput:undefined",
    "4:public:fulfilled:undefined",
  ],
  "audio:zero": [
    "0:before:useDistributedOutput",
    "0:audioIndex:0",
    '0:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    '0:mode:"auto"',
    "0:advancedCapabilities:undefined",
    "0:advancedFacts:undefined",
    "0:toneMapHdr:false",
    "0:burnInSubtitleIndex:undefined",
    "0:localHlsLadderEnabled:false",
    "0:ladderCapabilities:undefined",
    "0:ladderFacts:undefined",
    '0:ladderQuality:"auto"',
    "0:ladderSelected:undefined",
    "0:ladderManual:false",
    "0:staticHlsFallbackEnabled:false",
    "0:staticHlsAvailability:undefined",
    "0:returned:Promise",
    "2:after:useDistributedOutput:undefined",
    "4:public:fulfilled:undefined",
  ],
  "audio:negative": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:原片音轨编号无效",
    "5:public:rejected:Error:原片音轨编号无效",
  ],
  "audio:fraction": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:原片音轨编号无效",
    "5:public:rejected:Error:原片音轨编号无效",
  ],
  "audio:overflow": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:原片音轨编号无效",
    "5:public:rejected:Error:原片音轨编号无效",
  ],
  "audio:NaN": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:原片音轨编号无效",
    "5:public:rejected:Error:原片音轨编号无效",
  ],
  "audio:string": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:原片音轨编号无效",
    "5:public:rejected:Error:原片音轨编号无效",
  ],
  "invalid-intent": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:NAS 产物绑定无效",
    "5:public:rejected:Error:NAS 产物绑定无效",
  ],
  "original-retained-drafts": [
    "0:before:useOriginalSource",
    "0:distributedIntent:undefined",
    "0:returned:Promise",
    "2:after:useOriginalSource:undefined",
    "4:public:fulfilled:undefined",
  ],
  "load-accessor-failed:useDistributedOutput": [
    "0:before:useDistributedOutput",
    "0:audioIndex:0",
    '0:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    '0:mode:"auto"',
    "0:advancedCapabilities:undefined",
    "0:advancedFacts:undefined",
    "0:toneMapHdr:false",
    "0:burnInSubtitleIndex:undefined",
    "0:localHlsLadderEnabled:false",
    "0:ladderCapabilities:undefined",
    "0:ladderFacts:undefined",
    '0:ladderQuality:"auto"',
    "0:ladderSelected:undefined",
    "0:ladderManual:false",
    "0:staticHlsFallbackEnabled:false",
    "0:staticHlsAvailability:undefined",
    "0:returned:Promise",
    "2:error:useDistributedOutput:Error:synthetic-source-read-failed",
    "5:public:rejected:Error:synthetic-source-read-failed",
  ],
  "load-accessor-failed:useOriginalSource": [
    "0:before:useOriginalSource",
    "0:distributedIntent:undefined",
    "0:returned:Promise",
    "2:error:useOriginalSource:Error:synthetic-source-read-failed",
    "5:public:rejected:Error:synthetic-source-read-failed",
  ],
  "successful-actions": {
    loaded: [
      "0:before:useDistributedOutput",
      "0:returned:Promise",
      "37:after:useDistributedOutput:undefined",
      "39:public:fulfilled:undefined",
    ],
    started: [
      "0:before:startPeerSharing",
      "0:returned:Promise",
      "19:after:startPeerSharing:undefined",
      "21:public:fulfilled:undefined",
    ],
    stopped: [
      "0:before:stopPeerSharing",
      "0:returned:Promise",
      "11:after:stopPeerSharing:undefined",
      "13:public:fulfilled:undefined",
    ],
    switched: [
      "0:before:useOriginalSource",
      "0:returned:Promise",
      "56:after:useOriginalSource:undefined",
      "58:public:fulfilled:undefined",
    ],
  },
  "grant-failed:useDistributedOutput": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "35:error:useDistributedOutput:Error:synthetic-grant-failed",
    "38:public:rejected:Error:synthetic-grant-failed",
  ],
  "grant-failed:useOriginalSource": [
    "0:before:useOriginalSource",
    "0:returned:Promise",
    "54:error:useOriginalSource:Error:synthetic-grant-failed",
    "57:public:rejected:Error:synthetic-grant-failed",
  ],
  "missing-consent:acknowledge_peer_addresses": [
    "0:before:startPeerSharing",
    "0:returned:Promise",
    "4:error:startPeerSharing:Error:启用前请确认上传与网络地址披露",
    "7:public:rejected:Error:启用前请确认上传与网络地址披露",
  ],
  "missing-consent:confirm_current_network": [
    "0:before:startPeerSharing",
    "0:returned:Promise",
    "4:error:startPeerSharing:Error:启用前请确认上传与网络地址披露",
    "7:public:rejected:Error:启用前请确认上传与网络地址披露",
  ],
  "missing-consent:upload_allowed": [
    "0:before:startPeerSharing",
    "0:returned:Promise",
    "4:error:startPeerSharing:Error:启用前请确认上传与网络地址披露",
    "7:public:rejected:Error:启用前请确认上传与网络地址披露",
  ],
  "stop-environment-failure": [
    "0:before:stopPeerSharing",
    "0:returned:Promise",
    "3:error:stopPeerSharing:Error:synthetic-remove-listener-failed",
    "6:public:rejected:Error:synthetic-remove-listener-failed",
  ],
  "raw-scope-stop": [
    "0:distributed:undefined",
    "0:state-write-returned",
    "6:sharing:false",
  ],
  "successful-audio:omitted": [
    'draft:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    'draft:mode:"auto"',
    "draft:advancedCapabilities:undefined",
    "draft:advancedFacts:undefined",
    "draft:toneMapHdr:false",
    "draft:burnInSubtitleIndex:undefined",
    "draft:localHlsLadderEnabled:false",
    "draft:ladderCapabilities:undefined",
    "draft:ladderFacts:undefined",
    'draft:ladderQuality:"auto"',
    "draft:ladderSelected:undefined",
    "draft:ladderManual:false",
    "draft:staticHlsFallbackEnabled:false",
    "draft:staticHlsAvailability:undefined",
    'draft:preparation:{"phase":"preparing","generation":1}',
    "media:pause",
    "media:remove:src",
    "media:load",
    "http:POST:/playback-sessions/distributed-compute",
    'draft:preparation:{"phase":"preparing","generation":1,"sessionId":"00000000-0000-0000-0000-000000000100","deliveryMode":"transcode"}',
    'draft:preparation:{"phase":"ready","generation":1,"sessionId":"00000000-0000-0000-0000-000000000100","deliveryMode":"transcode"}',
  ],
  "successful-audio:null": [
    "draft:audioIndex:undefined",
    'draft:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    'draft:mode:"auto"',
    "draft:advancedCapabilities:undefined",
    "draft:advancedFacts:undefined",
    "draft:toneMapHdr:false",
    "draft:burnInSubtitleIndex:undefined",
    "draft:localHlsLadderEnabled:false",
    "draft:ladderCapabilities:undefined",
    "draft:ladderFacts:undefined",
    'draft:ladderQuality:"auto"',
    "draft:ladderSelected:undefined",
    "draft:ladderManual:false",
    "draft:staticHlsFallbackEnabled:false",
    "draft:staticHlsAvailability:undefined",
    'draft:preparation:{"phase":"preparing","generation":1}',
    "media:pause",
    "media:remove:src",
    "media:load",
    "http:POST:/playback-sessions/distributed-compute",
    'draft:preparation:{"phase":"preparing","generation":1,"sessionId":"00000000-0000-0000-0000-000000000100","deliveryMode":"transcode"}',
    'draft:preparation:{"phase":"ready","generation":1,"sessionId":"00000000-0000-0000-0000-000000000100","deliveryMode":"transcode"}',
  ],
  "successful-audio:zero": [
    "draft:audioIndex:0",
    'draft:distributedIntent:{"schema_version":1,"job_id":"00000000-0000-0000-0000-000000000010","output_generation":"00000000-0000-0000-0000-000000000011"}',
    'draft:mode:"auto"',
    "draft:advancedCapabilities:undefined",
    "draft:advancedFacts:undefined",
    "draft:toneMapHdr:false",
    "draft:burnInSubtitleIndex:undefined",
    "draft:localHlsLadderEnabled:false",
    "draft:ladderCapabilities:undefined",
    "draft:ladderFacts:undefined",
    'draft:ladderQuality:"auto"',
    "draft:ladderSelected:undefined",
    "draft:ladderManual:false",
    "draft:staticHlsFallbackEnabled:false",
    "draft:staticHlsAvailability:undefined",
    'draft:preparation:{"phase":"preparing","generation":1}',
    "media:pause",
    "media:remove:src",
    "media:load",
    "http:POST:/playback-sessions/distributed-compute",
    'draft:preparation:{"phase":"preparing","generation":1,"sessionId":"00000000-0000-0000-0000-000000000100","deliveryMode":"transcode"}',
    'draft:preparation:{"phase":"ready","generation":1,"sessionId":"00000000-0000-0000-0000-000000000100","deliveryMode":"transcode"}',
  ],
  "plan-mismatch": [
    "0:before:useDistributedOutput",
    "0:returned:Promise",
    "37:error:useDistributedOutput:RequestFailure:请求失败，请稍后重试",
    "40:public:rejected:RequestFailure:请求失败，请稍后重试",
  ],
  "original-during-peer-join": [
    "0:before:startPeerSharing",
    "0:original-click",
    "0:before:useOriginalSource",
    "0:after:useOriginalSource:undefined",
    "0:original-caller:fulfilled",
    "0:late-join-release",
    "0:error:startPeerSharing:AbortError:Aborted",
    "0:start-caller:AbortError:Aborted",
  ],
  "original-during-grant": [
    "0:before:useDistributedOutput",
    "0:original-click",
    "0:before:useOriginalSource",
    "0:late-grant-release",
    "0:after:useDistributedOutput:undefined",
    "0:distributed-caller:fulfilled",
    "0:after:useOriginalSource:undefined",
    "0:original-caller:fulfilled",
  ],
};

async function actualRoomPage() {
  const env = environment();
  const f = roomPiniaFixture(env);
  await f.ready();
  const prewarm = vi.fn((value: any, mode: string) =>
    prewarmNativeDash(value, mode),
  );
  const mounted = mountPage(
    {
      runtime: f.runtime,
      session: f.session,
      catalog: useMediaCatalog(),
      prewarm,
    },
    env,
    roomPiniaId(2),
  );
  await ticks(20);
  return { ...f, env, m: mounted, prewarm };
}
function renderedActionProbe(f: Awaited<ReturnType<typeof actualRoomPage>>) {
  const events: string[] = [];
  const calls: string[] = [];
  let tick = 0;
  const names = new Set([
    "useDistributedOutput",
    "useOriginalSource",
    "startPeerSharing",
    "stopPeerSharing",
    "runPlayback",
  ]);
  const stop = f.runtime.$onAction(({ name, after, onError, store }) => {
    if (!names.has(name)) return;
    expect(store).toBe(f.runtime);
    calls.push(name);
    events.push(`${tick}:before:${name}`);
    after((value) => events.push(`${tick}:after:${name}:${String(value)}`));
    onError((error) =>
      events.push(`${tick}:error:${name}:${(error as Error).message}`),
    );
  });
  roomPiniaCleanups.push(stop);
  return {
    calls,
    async observe(label: string, count = 200) {
      tick = 0;
      events.length = 0;
      calls.length = 0;
      const samples: unknown[] = [];
      let previous = "";
      const sample = () => {
        const button = f.m
          .all()
          .find(
            (node) => node.tag === "button" && f.m.text(node).trim() === label,
          );
        const fieldset = f.m.all().find((node) => node.tag === "fieldset");
        const state = [
          button ? !!button.props.disabled : "absent",
          fieldset ? !!fieldset.props.disabled : "absent",
          f.m
            .all()
            .filter((node) => node.props.role === "alert")
            .map((node) => f.m.text(node))
            .join("|"),
          f.runtime.busy,
          f.runtime.error,
          f.owner.peerSharing.value,
        ];
        const encoded = JSON.stringify(state);
        if (encoded !== previous) {
          samples.push([tick, ...state]);
          previous = encoded;
        }
      };
      const pending = f.m.button(label).props.onClick();
      expect(pending).toBeInstanceOf(Promise);
      events.push("0:return:Promise");
      pending.then(
        (value: unknown) =>
          events.push(`${tick}:public:fulfilled:${String(value)}`),
        (error: Error) =>
          events.push(`${tick}:public:rejected:${error.message}`),
      );
      sample();
      for (tick = 1; tick <= count; tick++) {
        await Promise.resolve();
        sample();
      }
      await pending;
      return { events: [...events], samples, calls: [...calls] };
    },
  };
}

it("RoomPage real compiled child preserves all four original Pinia chains through successful source and sharing changes", async () => {
  const f = await actualRoomPage();
  await f.m.openManagement();
  const props = f.m.panel().props;
  expect(props.activate).toBe(roomPlayback(f.runtime).useDistributedOutput);
  expect(props.original).toBe(roomPlayback(f.runtime).useOriginalSource);
  expect(props.share).toBe(roomPlayback(f.runtime).startPeerSharing);
  expect(props.stopSharing).toBe(roomPlayback(f.runtime).stopPeerSharing);
  for (const name of [
    "useDistributedOutput",
    "useOriginalSource",
    "startPeerSharing",
    "stopPeerSharing",
  ] as const)
    expect(roomPlayback(f.runtime)[name]).not.toBe(f.owner[name]);
  f.m.select("房间内计算产物", roomPiniaIntent.job_id);
  await ticks();
  const probe = renderedActionProbe(f);
  const activate = await probe.observe("用于房间主播放器");
  expect(f.runtime.playbackHost.sessionId).toBe(f.grants[0].session_id);
  expect(f.grants[0].distributed_compute).toBeDefined();
  expect(f.owner.audioIndex.value).toBe(0);
  expect(f.m.panel().props.stats).toBe(f.owner.peerStats.value);
  for (let index = 0; index < 3; index++) f.m.checkbox(index, true);
  await ticks();
  const share = await probe.observe("启用主播放器分片共享");
  expect(f.owner.peerSharing.value).toBe(true);
  const stop = await probe.observe("立即退出共享，继续 HTTP 播放");
  expect(f.owner.peerSharing.value).toBe(false);
  expect(
    f.m
      .all()
      .filter((node) => node.tag === "input" && node.props.type === "checkbox")
      .map((node) => node.checked),
  ).toEqual([false, false, false]);
  const original = await probe.observe("主播放器改回原片源");
  expect(f.grants.at(-1)?.distributed_compute).toBeUndefined();
  expect(f.owner.audioIndex.value).toBe(0);
  expect(f.m.all().filter((node) => node.tag === "test-anchor")).toHaveLength(
    1,
  );
  expect({ activate, share, stop, original }).toEqual(
    roomRenderedBaseline.SUCCESS,
  );
});

it("RoomPage real compiled panel catches the original Pinia grant rejection after its existing Promise layers", async () => {
  const f = await actualRoomPage();
  await f.m.openManagement();
  f.m.select("房间内计算产物", roomPiniaIntent.job_id);
  await ticks();
  f.control.failGrant = Error("Original grant failure");
  const probe = renderedActionProbe(f);
  const result = await probe.observe("用于房间主播放器");
  expect(result.calls).toEqual(["useDistributedOutput"]);
  expect(f.m.text(f.m.root)).toContain("Original grant failure");
  expect(f.runtime.busy).toBe(false);
  expect(f.runtime.playbackHost.sessionId).toBeNull();
  expect(result).toEqual(roomRenderedBaseline.REJECT);
});

it("RoomPage real compiled panel leaves the original no-plan peer rejection at the owner", async () => {
  const f = await actualRoomPage();
  await f.m.openManagement();
  await roomPiniaUntil(
    () =>
      f.m
        .all()
        .filter(
          (node) => node.tag === "input" && node.props.type === "checkbox",
        ).length === 3,
    "original compute response rendered sharing consent",
  );
  for (let index = 0; index < 3; index++) f.m.checkbox(index, true);
  await ticks();
  const probe = renderedActionProbe(f);
  const result = await probe.observe("启用主播放器分片共享");
  expect(result.calls).toEqual(["startPeerSharing"]);
  expect(f.m.text(f.m.root)).toContain("当前主播放器不能启用 P2P 分片共享");
  expect(f.requests.some((request) => request.path.endsWith("/p2p"))).toBe(
    false,
  );
  expect(result).toEqual(roomRenderedBaseline.PEER_REJECT);
});

it("RoomPage real compiled panel discards an old peer action after login retirement", async () => {
  const f = await actualRoomPage();
  await f.m.openManagement();
  f.m.select("房间内计算产物", roomPiniaIntent.job_id);
  await ticks();
  await f.m.button("用于房间主播放器").props.onClick();
  await ticks();
  for (let index = 0; index < 3; index++) f.m.checkbox(index, true);
  await ticks();
  const gate = roomPiniaDeferred<Response>();
  f.control.peerGate = gate;
  const oldPlan = f.grants[0];
  const old = f.m.button("启用主播放器分片共享").props.onClick();
  await roomPiniaUntil(
    () =>
      f.requests.some((request) => request.path.endsWith("/distributed/p2p")),
    "compiled share entered real peer",
  );
  f.session.clear();
  await ticks();
  expect(f.m.panel()).toBeUndefined();
  f.runtime.error = "Successor notice";
  gate.resolve(Response.json(f.peerReply(oldPlan)));
  await expect(old).resolves.toBeUndefined();
  await ticks();
  expect(f.runtime.error).toBe("Successor notice");
  expect(f.owner.peerSharing.value).toBe(false);
  expect(f.runtime.playbackHost.sessionId).toBeNull();
});

it("RoomPage real compiled queue button returns the original choose Promise and retains command authority", async () => {
  const f = await actualRoomPage();
  f.control.playlist = [
    {
      id: roomPiniaId(30),
      media_id: roomPiniaId(4),
      title: "Queued",
      added_by: roomPiniaId(1),
    },
  ];
  await f.runtime.refreshPlaylist();
  await ticks();
  const play = f.m.find(
    (node) =>
      node.tag === "button" &&
      String(node.props["aria-label"]).startsWith("播放 "),
  );
  const events: string[] = [];
  let tick = 0;
  const stop = f.runtime.$onAction(({ name, after, onError }) => {
    events.push(`${tick}:before:${name}`);
    after((value) => events.push(`${tick}:after:${name}:${String(value)}`));
    onError((error) =>
      events.push(`${tick}:error:${name}:${(error as Error).message}`),
    );
  });
  roomPiniaCleanups.push(stop);
  const warm = f.prewarm.getMockImplementation()!;
  f.prewarm.mockImplementation((...args) => {
    events.push(`${tick}:prewarm`);
    return warm(...args);
  });
  const observe = async () => {
    tick = 0;
    events.length = 0;
    const pending = play.props.onClick();
    expect(pending).toBeInstanceOf(Promise);
    const warmAtReturn = f.prewarm.mock.calls.length;
    events.push("0:return:Promise");
    pending.then((value: unknown) =>
      events.push(`${tick}:public:fulfilled:${String(value)}`),
    );
    for (tick = 1; tick <= 30; tick++) await Promise.resolve();
    return { value: await pending, warmAtReturn, events: [...events] };
  };
  f.prewarm.mockClear();
  const allowed = await observe();
  expect(allowed.value).toBe(true);
  expect(allowed.warmAtReturn).toBe(1);
  f.runtime.connected = false;
  await ticks();
  f.prewarm.mockClear();
  const disconnected = await observe();
  expect(disconnected.value).toBe(false);
  expect(disconnected.warmAtReturn).toBe(0);
  expect(f.prewarm).not.toHaveBeenCalled();
  expect({ allowed, disconnected }).toEqual(roomRenderedBaseline.QUEUE);
});

// Recorded from exact 69dc4bc compiled RoomPage/DistributedComputePanel and actual
// Pinia actions before any finite-port implementation. Ticks are Promise-loop
// observations, not elapsed time or real-browser scheduling guarantees.
const roomRenderedBaseline = {
  SUCCESS: {
    activate: {
      events: [
        "0:before:useDistributedOutput",
        "0:return:Promise",
        "38:after:useDistributedOutput:undefined",
        "43:public:fulfilled:undefined",
      ],
      samples: [
        [0, false, false, "", false, "", false],
        [1, true, true, "", false, "", false],
        [42, false, false, "", false, "", false],
      ],
      calls: ["useDistributedOutput"],
    },
    share: {
      events: [
        "0:before:startPeerSharing",
        "0:return:Promise",
        "19:after:startPeerSharing:undefined",
        "24:public:fulfilled:undefined",
      ],
      samples: [
        [0, false, false, "", false, "", false],
        [1, false, true, "", false, "", false],
        [18, false, true, "", false, "", true],
        [19, true, true, "", false, "", true],
        [23, true, false, "", false, "", true],
      ],
      calls: ["startPeerSharing"],
    },
    stop: {
      events: [
        "0:before:stopPeerSharing",
        "0:return:Promise",
        "11:after:stopPeerSharing:undefined",
        "14:public:fulfilled:undefined",
      ],
      samples: [
        [0, false, false, "", false, "", true],
        [1, false, true, "", false, "", true],
        [9, false, true, "", false, "", false],
        [10, true, true, "", false, "", false],
        [14, true, false, "", false, "", false],
      ],
      calls: ["stopPeerSharing"],
    },
    original: {
      events: [
        "0:before:useOriginalSource",
        "0:return:Promise",
        "57:after:useOriginalSource:undefined",
        "60:public:fulfilled:undefined",
      ],
      samples: [
        [0, false, false, "", false, "", false],
        [1, "absent", true, "", false, "", false],
        [60, "absent", false, "", false, "", false],
      ],
      calls: ["useOriginalSource"],
    },
  },
  REJECT: {
    events: [
      "0:before:useDistributedOutput",
      "0:return:Promise",
      "35:error:useDistributedOutput:Original grant failure",
      "41:public:fulfilled:undefined",
    ],
    samples: [
      [0, false, false, "", false, "", false],
      [1, true, true, "", false, "", false],
      [40, false, false, "Original grant failure", false, "", false],
    ],
    calls: ["useDistributedOutput"],
  },
  PEER_REJECT: {
    events: [
      "0:before:startPeerSharing",
      "0:return:Promise",
      "2:error:startPeerSharing:当前主播放器不能启用 P2P 分片共享",
      "8:public:fulfilled:undefined",
    ],
    samples: [
      [0, true, false, "", false, "", false],
      [1, true, true, "", false, "", false],
      [7, true, false, "当前主播放器不能启用 P2P 分片共享", false, "", false],
    ],
    calls: ["startPeerSharing"],
  },
  QUEUE: {
    allowed: {
      value: true,
      warmAtReturn: 1,
      events: [
        "0:before:can",
        "0:after:can:true",
        "0:prewarm",
        "0:before:choose",
        "0:return:Promise",
        "1:prewarm",
        "1:before:can",
        "1:after:can:true",
        "1:before:can",
        "1:after:can:true",
        "1:before:can",
        "1:after:can:true",
        "1:before:queuePending",
        "1:after:queuePending:false",
        "1:before:queuePending",
        "1:after:queuePending:false",
        "1:after:choose:true",
        "3:public:fulfilled:true",
      ],
    },
    disconnected: {
      value: false,
      warmAtReturn: 0,
      events: [
        "0:before:choose",
        "0:return:Promise",
        "1:after:choose:false",
        "3:public:fulfilled:false",
      ],
    },
  },
};
