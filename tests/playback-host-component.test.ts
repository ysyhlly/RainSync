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
import { useRoomNotice } from "../apps/web/src/features/playback/room-notice";
import { createPlayerChrome } from "../apps/web/src/features/playback/use-player-chrome";
import { SubtitleLoadState } from "../apps/web/src/features/playback/subtitle-load-state";
import {
  describePlaybackPreparation,
  preparationFailure,
} from "../apps/web/src/features/playback/playback-preparation";
import { usePersistentPlaybackHost } from "../apps/web/src/app/playback-host";

import * as navigation from "../apps/web/src/app/navigation";
import * as globalErrors from "../apps/web/src/app/global-errors";
import * as navigationProgress from "../apps/web/src/app/navigation-progress";
import * as keyboardViewport from "../apps/web/src/shared/keyboard-viewport";
import * as placement from "../apps/web/src/features/playback/playback-placement";
import { guestRoomPath } from "../apps/web/src/features/auth/guest-session";
import { useAction } from "../apps/web/src/shared/use-action";

// Only observe the existing factory result. Its original action bodies, scope
// watchers and Pinia wrappers are never replaced by this fixture hook.
const viewingProbe = vi.hoisted(() => ({ playback: undefined as any }));
vi.mock("../apps/web/src/app/viewing-runtime", async (original) => {
  const actual =
    await original<typeof import("../apps/web/src/app/viewing-runtime")>();
  return {
    ...actual,
    createViewingRuntime: (
      ...args: Parameters<typeof actual.createViewingRuntime>
    ) => {
      const value = actual.createViewingRuntime(...args);
      viewingProbe.playback = value.playback;
      return value;
    },
  };
});
const directory = fileURLToPath(
  new URL("../apps/web/src/features/playback/", import.meta.url),
);
const compiled = new Map<string, string>();
const stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  // Dispose starts original asynchronous media cleanup. Keep all original
  // synthetic fetch/storage globals available through that cleanup as well.
  await ticks(30);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function compile(name: string) {
  const file = resolve(directory, name);
  if (!compiled.has(file)) {
    const { descriptor, errors } = parse(readFileSync(file, "utf8"), {
      filename: file,
    });
    if (errors.length) throw errors[0];
    const script = compileScript(descriptor, {
      id: `host-caller-${name}`,
      inlineTemplate: true,
    });
    compiled.set(
      file,
      ts.transpileModule(script.content, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
    );
  }
  return compiled.get(file)!;
}
function environment() {
  vi.useFakeTimers();
  const effects: string[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0,
    observer = 0;
  class Target extends EventTarget {
    constructor(readonly label: string) {
      super();
      Vue.markRaw(this);
    }
    addEventListener(type: string, callback: any, options?: any) {
      effects.push(`add:${this.label}:${type}:${options === true}`);
      super.addEventListener(type, callback, options);
    }
    removeEventListener(type: string, callback: any, options?: any) {
      effects.push(`remove:${this.label}:${type}:${options === true}`);
      super.removeEventListener(type, callback, options);
    }
  }
  class TreeNode extends Target {
    props: Record<string, any> = {};
    dataset: Record<string, string> = {};
    children: TreeNode[] = [];
    parent?: TreeNode;
    text = "";
    style: Record<string, any> = {
      setProperty: (key: string, value: string) => {
        this.style[key] = value;
      },
      removeProperty: (key: string) => {
        delete this.style[key];
      },
    };
    src = "";
    currentTime = 0;
    duration = 120;
    playbackRate = 1;
    paused = true;
    ended = false;
    readyState = 1;
    volume = 1;
    muted = false;
    seekable = { length: 0 };
    buffered = { length: 0 };
    textTracks: any[] = [];
    track = { mode: "disabled" };
    scrollLeft = 0;
    scrollTop = 0;
    clientLeft = 0;
    clientTop = 0;
    clientWidth = 600;
    clientHeight = 150;
    videoWidth = 600;
    videoHeight = 150;
    connected = true;
    constructor(readonly tag: string) {
      super(tag);
    }
    get parentElement() {
      return this.parent;
    }
    get offsetParent() {
      return this.parent;
    }
    get isConnected() {
      return this.connected;
    }
    contains(other: TreeNode | null): boolean {
      return (
        !!other &&
        (other === this || this.children.some((child) => child.contains(other)))
      );
    }
    matches(_selector: string) {
      return false;
    }
    closest(selector: string): TreeNode | null {
      if (
        selector === ".room-layout-canvas" &&
        String(this.props.class).includes("room-layout-canvas")
      )
        return this;
      return this.parent?.closest(selector) ?? null;
    }
    getBoundingClientRect() {
      effects.push(`measure:${this.tag}`);
      return {
        left: 10,
        top: 20,
        width: this.clientWidth,
        height: this.clientHeight,
      };
    }
    getAttribute(name: string) {
      return name === "src" ? this.src || null : (this.props[name] ?? null);
    }
    setAttribute(name: string, value: string) {
      this.props[name] = value;
      if (name === "src") this.src = value;
    }
    removeAttribute(name: string) {
      delete this.props[name];
      if (name === "src") this.src = "";
      effects.push(`attribute-remove:${this.tag}:${name}`);
    }
    querySelectorAll(selector: string): TreeNode[] {
      return this.children.flatMap((child) => [
        ...(child.tag === selector ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    canPlayType() {
      return "probably";
    }
    pause() {
      effects.push(`pause:${this.tag}`);
      this.paused = true;
    }
    play() {
      effects.push(`play:${this.tag}`);
      this.paused = false;
      return Promise.resolve();
    }
    load() {
      effects.push(`load:${this.tag}`);
    }
    blur() {
      effects.push(`blur:${this.tag}`);
      document.activeElement = null;
    }
    requestFullscreen() {
      effects.push(
        `fullscreen-request:${this.tag}:${this instanceof TreeNode}`,
      );
      return Promise.resolve();
    }
  }
  const document: any = Object.assign(new Target("document"), {
    fullscreenElement: null,
    fullscreenEnabled: true,
    activeElement: null,
    hidden: false,
    visibilityState: "visible",
    documentElement: new TreeNode("html"),
    exitFullscreen() {
      effects.push(`fullscreen-exit:${this === document}`);
      return Promise.resolve();
    },
  });
  const visualViewport = Object.assign(new Target("viewport"), {
    height: 800,
    scale: 1,
  });
  const window = Object.assign(new Target("window"), {
    visualViewport,
    innerHeight: 800,
  });
  const media = new Map<string, any>();
  function matchMedia(query: string) {
    if (!media.has(query))
      media.set(
        query,
        Object.assign(new Target(`media:${query}`), { matches: false }),
      );
    return media.get(query);
  }
  class ResizeObserver {
    readonly id = ++observer;
    constructor(readonly callback: (...args: any[]) => void) {
      effects.push(`new:resize:${this.id}`);
    }
    observe(value: TreeNode) {
      effects.push(`observe:resize:${this.id}:${value.tag}`);
    }
    disconnect() {
      effects.push(`disconnect:resize:${this.id}`);
    }
  }
  class MutationObserver {
    readonly id = ++observer;
    constructor(readonly callback: (...args: any[]) => void) {
      effects.push(`new:mutation:${this.id}`);
    }
    observe(value: TreeNode) {
      effects.push(`observe:mutation:${this.id}:${value.tag}`);
    }
    disconnect() {
      effects.push(`disconnect:mutation:${this.id}`);
    }
  }
  for (const [key, value] of Object.entries({
    document,
    window,
    Element: TreeNode,
    HTMLElement: TreeNode,
    HTMLVideoElement: TreeNode,
    matchMedia,
    ResizeObserver,
    MutationObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frame, callback);
      effects.push(`raf:${frame}`);
      return frame;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
      effects.push(`cancel-raf:${id}`);
    },
    location: {
      protocol: "http:",
      host: "localhost",
      href: "http://localhost/rooms/room",
    },
    sessionStorage: {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    navigator: {},
    fetch: vi.fn(async () => Response.json([])),
  }))
    vi.stubGlobal(key, value);
  return {
    effects,
    frames,
    TreeNode,
    document,
    window,
    media,
    matchMedia,
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
}
type Environment = ReturnType<typeof environment>;
type TreeNode = InstanceType<Environment["TreeNode"]>;
function fakeRuntime(env: Environment, overrides: Record<string, any> = {}) {
  const events: string[] = [];
  let armed = false;
  const methods: Record<string, (...args: any[]) => any> = {
    can: (permission) => {
      if (armed) events.push(`can:${permission}`);
      return true;
    },
    send: (command, payload) => {
      events.push(`send:${command}:${JSON.stringify(payload)}`);
      return true;
    },
    attach: (element) => {
      env.effects.push(`attach:${element.tag}`);
    },
    runPlayback: (action) => {
      events.push("runner");
      return action();
    },
    enablePlayback: () => {
      events.push("join");
      return Promise.resolve();
    },
    loadMedia: () => {
      events.push("reload");
      return Promise.resolve();
    },
    cancelPreparation: () => {
      events.push("cancel");
      return Promise.resolve();
    },
    applySubtitles: () => {
      events.push("apply");
    },
  };
  const plain: Record<string, any> = {
    room: { id: "room", name: "Room" },
    state: { media_id: "movie" },
    currentTitle: "Movie",
    connected: true,
    connectionStopped: false,
    roomActive: true,
    duration: 120,
    waiting: false,
    blocked: false,
    dragging: false,
    live: false,
    nativePlatform: false,
    platformDanmakuEnabled: false,
    platformDanmakuCues: [],
    recoveryLabel: "",
    recoveryState: "idle",
    error: "",
    errorNotice: undefined,
    preparation: { phase: "idle" },
    loadingStage: "playing",
    startupDiagnostics: undefined,
    sessionId: "subtitle-session",
    subtitleIndex: 4,
    subtitles: [
      {
        index: 4,
        label: "English",
        language: "en",
        codec: "webvtt",
        url: "/subtitle.vtt",
      },
    ],
    playbackControls: {},
    playbackSettings: {},
    ...overrides,
  };
  for (const key of Object.keys(methods))
    Object.defineProperty(plain, key, {
      configurable: true,
      enumerable: true,
      get() {
        if (armed) events.push(`lookup:${key}`);
        return methods[key];
      },
    });
  const raw = Vue.reactive(plain);
  return {
    raw,
    methods,
    events,
    spyReads(keys: string[]) {
      for (const key of keys) {
        let value = plain[key];
        Object.defineProperty(plain, key, {
          configurable: true,
          enumerable: true,
          get() {
            if (armed) events.push(`read:${key}`);
            return value;
          },
          set(next) {
            value = next;
          },
        });
      }
    },
    arm() {
      armed = true;
      events.length = 0;
    },
    disarm() {
      armed = false;
    },
  };
}
// Test binding only: original source uses the injected store, while the new
// consumer receives the production finite port over the same controlled refs.
// No action body, expectation, Promise or owner is replaced by this adapter.
const hostPortFile = resolve(directory, "playback-host-port.ts");
const hasHostPort = existsSync(hostPortFile);
function suppliedHostPort(raw: Record<string, any>) {
  if (!hasHostPort) return undefined;
  if (raw.playbackHost) return raw.playbackHost;
  const output = ts.transpileModule(readFileSync(hostPortFile, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", output)(
    (name: string) => {
      throw Error(`Unexpected Host port runtime dependency: ${name}`);
    },
    module,
    module.exports,
  );
  const keys = [
    "waiting",
    "blocked",
    "dragging",
    "duration",
    "live",
    "nativePlatform",
    "platformDanmakuEnabled",
    "platformDanmakuCues",
    "subtitles",
    "subtitleIndex",
    "sessionId",
    "preparation",
    "loadingStage",
    "startupDiagnostics",
    "recoveryState",
    "recoveryLabel",
  ];
  const timeline = Object.fromEntries(
    [
      "room",
      "state",
      "connected",
      "connectionStopped",
      "roomActive",
      "currentTitle",
    ].map((key) => [key, Vue.toRef(raw, key)]),
  );
  const playback = Object.fromEntries(
    keys.map((key) => [key, Vue.toRef(raw, key)]),
  );
  const actions: Record<string, any> = {};
  for (const key of [
    "attach",
    "runPlayback",
    "enablePlayback",
    "loadMedia",
    "cancelPreparation",
    "applySubtitles",
    "can",
    "send",
  ])
    Object.defineProperty(actions, key, { get: () => raw[key].bind(raw) });
  Object.defineProperty(actions, "dismissError", {
    get: () =>
      raw.dismissError?.bind(raw) ??
      (() => {
        raw.error = "";
      }),
  });
  return module.exports.createPlaybackHostPort({
    timeline,
    playback,
    actions,
    notice: {
      error: Vue.toRef(raw, "error"),
      errorNotice: Vue.toRef(raw, "errorNotice"),
    },
    playbackControls: raw.playbackControls,
    playbackSettings: raw.playbackSettings,
  });
}

function mountHost(
  raw: Record<string, any>,
  env: Environment,
  options: Record<string, any> = {},
) {
  let chrome!: ReturnType<typeof createPlayerChrome>;
  const notices: {
    input: any;
    action?: Vue.Ref<string>;
    value: ReturnType<typeof useRoomNotice>;
  }[] = [];
  const loaded = new Map<string, Vue.Component>();
  const placeholder = (
    tag: string,
    props: string[] = [],
    emits: string[] = [],
  ) =>
    Vue.defineComponent({
      props,
      emits,
      setup:
        (values, { emit, slots }) =>
        () =>
          Vue.h(
            tag,
            {
              ...values,
              onSeek: (value: number) => emit("seek", value),
              onFullscreen: () => emit("fullscreen"),
              onMenuOpen: (value: boolean) => emit("menu-open", value),
              onDragging: (value: boolean) => emit("dragging", value),
              onOpenChange: (value: boolean) => emit("open-change", value),
            },
            slots.default?.(),
          ),
    });
  function load(name: string): Vue.Component {
    if (loaded.has(name)) return loaded.get(name)!;
    const require = (specifier: string): any => {
      if (specifier === "vue") return Vue;
      if (specifier === "../rooms/room-runtime")
        return { useRoomRuntime: () => raw };
      if (
        specifier === "./room-notice" ||
        specifier === "../features/playback/room-notice"
      )
        return {
          useRoomNotice: (input: any, action?: Vue.Ref<string>) => {
            const value = useRoomNotice(input, action);
            notices.push({ input, action, value });
            return value;
          },
        };
      if (specifier === "vue-router")
        return {
          useRoute: () =>
            Vue.reactive({
              meta: { public: true, room: true },
              params: { id: "room" },
              path: "/rooms/room",
              fullPath: "/rooms/room",
              query: {},
            }),
          useRouter: () => ({ replace: vi.fn() }),
        };
      if (specifier === "../features/auth/session.store") return { useSession };
      if (specifier === "../features/rooms/room-runtime")
        return { useRoomRuntime: () => raw };
      if (specifier === "../features/auth/guest-session")
        return { guestRoomPath };
      if (specifier === "../shared/use-action") return { useAction };
      if (specifier === "./global-errors") return globalErrors;
      if (specifier === "./navigation") return navigation;
      if (specifier === "./navigation-progress") return navigationProgress;
      if (specifier === "../shared/keyboard-viewport") return keyboardViewport;
      if (specifier === "../features/playback/playback-placement")
        return placement;
      if (specifier === "./playback-host")
        return {
          usePersistentPlaybackHost: (read: () => boolean) =>
            usePersistentPlaybackHost(read, () =>
              Promise.resolve(load("PlaybackHost.vue")),
            ),
        };
      if (
        [
          "./AnimatedNavigation.vue",
          "./ThemeControl.vue",
          "../shared/ui/AppIcon.vue",
          "../shared/ui/UserAvatar.vue",
          "../shared/ui/Notice.vue",
        ].includes(specifier)
      )
        return { __esModule: true, default: placeholder("test-shell-child") };
      if (specifier === "./subtitle-load-state") return { SubtitleLoadState };
      if (specifier === "./playback-preparation")
        return { describePlaybackPreparation };
      if (specifier === "./use-player-chrome")
        return {
          createPlayerChrome: (coarse: boolean) => {
            chrome = createPlayerChrome(coarse);
            const dispose = chrome.dispose;
            chrome.dispose = () => {
              env.effects.push("chrome:dispose");
              dispose();
            };
            return chrome;
          },
        };
      if (
        [
          "./PlaybackInformation.vue",
          "./PlaybackPreparation.vue",
          "./PlaybackStartupDiagnostics.vue",
        ].includes(specifier)
      )
        return { __esModule: true, default: load(specifier.slice(2)) };
      if (specifier === "./PlaybackControls.vue")
        return {
          __esModule: true,
          default: placeholder(
            "test-controls",
            ["controls", "mini", "fullscreen"],
            ["fullscreen", "menu-open", "dragging"],
          ),
        };
      if (specifier === "./PlaybackSettings.vue")
        return {
          __esModule: true,
          default: placeholder(
            "test-settings",
            ["settings", "active"],
            ["open-change"],
          ),
        };
      if (specifier === "./PlatformDanmaku.vue")
        return {
          __esModule: true,
          default: placeholder(
            "test-danmaku",
            ["cues", "enabled", "video", "canSeek"],
            ["seek"],
          ),
        };
      if (specifier === "../../shared/ui/AppIcon.vue")
        return { __esModule: true, default: placeholder("test-icon") };
      throw Error(`Unexpected Host caller import: ${specifier}`);
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
      if (key.startsWith("data-")) node.dataset[key.slice(5)] = value;
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
      if (index >= 0) parent.children.splice(index, 0, node);
      else parent.children.push(node);
    },
    remove,
    createElement: (tag) => new env.TreeNode(tag),
    createText: (text) => Object.assign(new env.TreeNode("text"), { text }),
    createComment: (text) =>
      Object.assign(new env.TreeNode("comment"), { text }),
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
  const props = Vue.shallowReactive({
    full: true,
    playback: suppliedHostPort(raw),
    ...options,
  });
  const host = load("PlaybackHost.vue");
  let loadedHost: (() => void) | undefined;
  const loader = vi.fn(
    () =>
      new Promise<Vue.Component>((resolve) => {
        loadedHost = () => resolve(host);
      }),
  );
  const rootComponent = options.appShell
    ? load("../../app/AppShell.vue")
    : options.persistent
      ? Vue.defineComponent({
          setup() {
            const persistent = usePersistentPlaybackHost(
              () => !!raw.room,
              loader,
            );
            return () =>
              persistent.shown.value
                ? Vue.h(persistent.component, props)
                : null;
          },
        })
      : { render: () => Vue.h(host, props) };
  const app = renderer.createApp(rootComponent);
  app.component(
    "RouterView",
    Vue.defineComponent({
      setup:
        (_p, { slots }) =>
        () =>
          slots.default?.({ Component: undefined }),
    }),
  );
  app.component(
    "RouterLink",
    Vue.defineComponent({
      props: ["to"],
      setup:
        (p, { slots }) =>
        () =>
          Vue.h("a", { href: p.to }, slots.default?.()),
    }),
  );
  const root = new env.TreeNode("root");
  const resize: number[] = [];
  props.onMiniResize = (height: number) => {
    resize.push(height);
    env.effects.push(`mini:${height}`);
  };
  const vm = app.mount(root);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      app.unmount();
    }
  };
  stops.push(unmount);
  const all = (node = root): TreeNode[] => [
    node,
    ...node.children.flatMap((child) => all(child)),
  ];
  const text = (node: TreeNode): string =>
    node.text + node.children.map(text).join("");
  const find = (predicate: (node: TreeNode) => boolean) => {
    const value = all().find(predicate);
    expect(value).toBeDefined();
    return value!;
  };
  return {
    all,
    text,
    find,
    root,
    props,
    resize,
    unmount,
    loader,
    notices,
    resolveHost: () => loadedHost!(),
    chrome: () => chrome,
    button: (label: string) =>
      find((node) => node.tag === "button" && text(node).trim() === label),
    video: () => find((node) => node.tag === "video"),
    controls: () => find((node) => node.tag === "test-controls"),
    section: () => find((node) => node.tag === "section"),
    childHandler(name: string, event: string) {
      const visit = (vnode: any): any => {
        if (!vnode) return;
        if (vnode.type?.__name === name) return vnode.props[event];
        if (vnode.component) {
          const found = visit(vnode.component.subTree);
          if (found) return found;
        }
        if (Array.isArray(vnode.children))
          for (const child of vnode.children) {
            const found = visit(child);
            if (found) return found;
          }
      };
      const handler = visit(vm.$.subTree);
      expect(handler).toBeTypeOf("function");
      return handler;
    },
  };
}
function actualRuntime(env: Environment) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({
    id: "viewer",
    username: "viewer",
    admin: false,
    csrf: "synthetic-host",
  });
  const runtime = useRoomRuntime();
  stops.push(async () => {
    await runtime.leave();
    disposePinia(pinia);
  });
  return { runtime, owner: viewingProbe.playback, session };
}
async function ticks(count = 5) {
  for (let index = 0; index < count; index++) await Vue.nextTick();
}

it("Host original mounted ordering and cleanup preserve one exact video", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    m = mountHost(f.raw, env, { full: false });
  const video = m.video();
  expect(env.effects).toEqual([
    "add:document:transitionend:true",
    "add:document:transitioncancel:true",
    "add:document:animationend:true",
    "add:document:animationcancel:true",
    "add:window:resize:false",
    "add:window:scroll:true",
    "add:viewport:resize:false",
    "add:media:(max-height: 500px):change:false",
    "new:resize:1",
    "observe:resize:1:section",
    "measure:section",
    "mini:150",
    "attach:video",
    "add:document:fullscreenchange:false",
    "add:document:visibilitychange:false",
    "add:document:keydown:true",
    "add:document:pointerdown:true",
  ]);
  expect(env.effects.indexOf("measure:section")).toBeLessThan(
    env.effects.indexOf("attach:video"),
  );
  expect(env.effects.indexOf("attach:video")).toBeLessThan(
    env.effects.indexOf("add:document:fullscreenchange:false"),
  );
  m.props.full = true;
  await ticks();
  f.raw.room = null;
  await ticks();
  f.raw.room = { id: "second", name: "Second" };
  m.props.full = false;
  await ticks();
  expect(m.video()).toBe(video);
  expect(env.effects.filter((value) => value === "attach:video")).toHaveLength(
    1,
  );
  expect(env.effects.filter((value) => value === "load:video")).toEqual([]);
  env.effects.length = 0;
  m.unmount();
  expect(env.effects).toEqual([
    "cancel-raf:0",
    "remove:document:transitionend:true",
    "remove:document:transitioncancel:true",
    "remove:document:animationend:true",
    "remove:document:animationcancel:true",
    "remove:window:resize:false",
    "remove:window:scroll:true",
    "remove:viewport:resize:false",
    "remove:media:(max-height: 500px):change:false",
    "disconnect:resize:1",
    "mini:0",
    "chrome:dispose",
    "remove:document:fullscreenchange:false",
    "remove:document:visibilitychange:false",
    "remove:document:keydown:true",
    "remove:document:pointerdown:true",
  ]);
});

it("Host original lazy arrival and anchor transitions retain its only video", async () => {
  const env = environment(),
    f = fakeRuntime(env, { room: null });
  const canvas = new env.TreeNode("canvas");
  canvas.props.class = "room-layout-canvas";
  const anchor = new env.TreeNode("anchor");
  anchor.parent = canvas;
  canvas.children.push(anchor);
  const m = mountHost(f.raw, env, { persistent: true, anchor });
  expect(m.loader).not.toHaveBeenCalled();
  f.raw.room = { id: "room", name: "Room" };
  await ticks();
  expect(m.loader).toHaveBeenCalledOnce();
  m.props.full = false;
  f.raw.room = null;
  await ticks();
  m.resolveHost();
  await ticks(12);
  const video = m.video();
  f.raw.room = { id: "again", name: "Again" };
  m.props.full = true;
  await ticks();
  expect(m.video()).toBe(video);
  expect(env.effects.filter((value) => value === "attach:video")).toHaveLength(
    1,
  );
  expect(m.section().style.visibility).not.toBe("hidden");
  expect(env.effects).toContain("observe:resize:2:anchor");
});

it.each([
  ["join", "点击加入播放", "enablePlayback", "join", { blocked: true }],
  [
    "retry",
    "重新发起播放",
    "loadMedia",
    "reload",
    {
      preparation: {
        phase: "failed",
        failure: { message: "Failed", retryable: true },
      },
    },
  ],
  [
    "cancel",
    "取消准备",
    "cancelPreparation",
    "cancel",
    { preparation: { phase: "preparing", generation: 7 } },
  ],
] as const)(
  "Host original %s handler preserves runner lookup, parent promise and emitted button return",
  async (_name, label, action, entry, facts) => {
    const env = environment(),
      f = fakeRuntime(env, facts),
      m = mountHost(f.raw, env);
    const result = Promise.resolve("original result");
    f.methods[action] = () => {
      f.events.push(entry);
      return result;
    };
    f.arm();
    expect(m.button(label).props.onClick()).toBe(
      _name === "join" ? result : undefined,
    );
    expect(f.events).toEqual([
      "lookup:runPlayback",
      `lookup:${action}`,
      "runner",
      entry,
    ]);
    if (_name !== "join") {
      f.events.length = 0;
      expect(
        m.childHandler(
          "PlaybackPreparation",
          _name === "retry" ? "onRetry" : "onCancel",
        )(),
      ).toBe(result);
      expect(f.events).toEqual([
        "lookup:runPlayback",
        `lookup:${action}`,
        "runner",
        entry,
      ]);
    }
    await result;
  },
);

it("Host original media events write waiting synchronously without runner or notice clearing", async () => {
  const env = environment(),
    f = fakeRuntime(env, { error: "keep notice" }),
    m = mountHost(f.raw, env);
  const observed: string[] = [];
  stops.push(
    Vue.watch(
      () => f.raw.waiting,
      (value) => observed.push(`waiting:${value}`),
      { flush: "sync" },
    ),
  );
  f.arm();
  m.video().props.onWaiting();
  expect(f.raw.waiting).toBe(true);
  m.video().props.onCanplay();
  expect(f.raw.waiting).toBe(false);
  m.video().props.onWaiting();
  m.video().props.onPlaying();
  expect(observed).toEqual([
    "waiting:true",
    "waiting:false",
    "waiting:true",
    "waiting:false",
  ]);
  expect(f.events).toEqual([]);
  expect(f.raw.error).toBe("keep notice");
});

it("Host original subtitle close writes draft and sync watcher before current apply lookup", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    m = mountHost(f.raw, env);
  const track = m.find((node) => node.tag === "track");
  track.readyState = 3;
  track.props.onError({ currentTarget: track });
  await ticks();
  const trace: string[] = [];
  stops.push(
    Vue.watch(
      () => f.raw.subtitleIndex,
      (value) => trace.push(`selection:${value}`),
      { flush: "sync" },
    ),
  );
  f.methods.applySubtitles = () => trace.push("apply");
  f.arm();
  m.button("关闭字幕").props.onClick();
  expect(trace).toEqual(["selection:undefined", "apply"]);
  expect(f.events).toEqual(["lookup:applySubtitles"]);
  expect(f.raw.subtitleIndex).toBeUndefined();
});

it("Host original subtitle retry remounts the same URL and resolves latest selection/apply after nextTick", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    m = mountHost(f.raw, env);
  const oldTrack = m.find((node) => node.tag === "track");
  oldTrack.readyState = 3;
  oldTrack.props.onError({ currentTarget: oldTrack });
  await ticks();
  f.arm();
  const pending = m.button("重试字幕").props.onClick();
  expect(f.events).toEqual([]);
  f.raw.subtitleIndex = undefined;
  f.methods.applySubtitles = () => {
    f.events.push(`latest:${f.raw.subtitleIndex}`);
  };
  await pending;
  expect(f.events).toEqual(["lookup:applySubtitles", "latest:undefined"]);
  const nextTrack = m.find((node) => node.tag === "track");
  expect(nextTrack).not.toBe(oldTrack);
  expect(nextTrack.props.src).toBe(oldTrack.props.src);
  expect(env.effects.filter((value) => value.startsWith("load:"))).toEqual([]);
  oldTrack.props.onError({ currentTarget: oldTrack });
  await ticks();
  expect(m.all().some((node) => node.props.class === "subtitle-error")).toBe(
    false,
  );
});

it.each([
  "denied",
  "disconnected",
  "live",
  "no media",
  "past end",
  "negative",
  "valid",
])(
  "Host original danmaku seek keeps event-time qualification: %s",
  async (scenario) => {
    const env = environment(),
      f = fakeRuntime(env, { nativePlatform: true }),
      m = mountHost(f.raw, env);
    const danmaku = m.find((node) => node.tag === "test-danmaku");
    expect(danmaku.props.canSeek).toBe(true);
    if (scenario === "denied")
      f.methods.can = (permission) => {
        f.events.push(`can:${permission}`);
        return false;
      };
    if (scenario === "disconnected") f.raw.connected = false;
    if (scenario === "live") f.raw.live = true;
    if (scenario === "no media") f.raw.state.media_id = null;
    f.spyReads(["connected", "live", "state", "duration"]);
    f.arm();
    const at =
      scenario === "negative" ? -1 : scenario === "past end" ? 120000 : 1500;
    expect(danmaku.props.onSeek(at)).toBeUndefined();
    const prefix = ["lookup:can", "can:seek"];
    if (scenario !== "denied") prefix.push("read:connected");
    if (!["denied", "disconnected"].includes(scenario))
      prefix.push("read:live");
    if (!["denied", "disconnected", "live"].includes(scenario))
      prefix.push("read:state");
    if (!["denied", "disconnected", "live", "no media"].includes(scenario))
      prefix.push("read:duration");
    expect(
      f.events.filter(
        (value) =>
          !value.startsWith("lookup:send") && !value.startsWith("send:"),
      ),
    ).toEqual(prefix);
    const sent = f.events.filter((value) => value.startsWith("send:"));
    expect(sent).toEqual(
      ["valid", "negative"].includes(scenario)
        ? [`send:SEEK:{"position_ms":${at}}`]
        : [],
    );
  },
);

it("Host original fullscreen lookup and synchronous invocation precede promise settlement", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    m = mountHost(f.raw, env);
  const node = m.section(),
    trace: string[] = [];
  let resolve!: () => void;
  Object.defineProperty(node, "requestFullscreen", {
    configurable: true,
    get() {
      trace.push("lookup request");
      return function (this: unknown) {
        trace.push(`request:${this === node}`);
        return new Promise<void>((done) => {
          resolve = done;
        });
      };
    },
  });
  m.controls().props.onFullscreen();
  expect(trace).toEqual(["lookup request", "lookup request", "request:true"]);
  resolve();
  await ticks();
  env.document.fullscreenElement = node;
  env.document.dispatchEvent(new Event("fullscreenchange"));
  await ticks();
  expect(m.controls().props.fullscreen).toBe(true);
  m.controls().props.onFullscreen();
  expect(env.effects).toContain("fullscreen-exit:true");
});

it("Host original unsupported and rejected fullscreen actions retain local error and clear before retry", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    m = mountHost(f.raw, env);
  env.document.fullscreenEnabled = false;
  m.controls().props.onFullscreen();
  await ticks();
  expect(m.text(m.root)).toContain("此设备不支持标准播放器全屏");
  env.document.fullscreenEnabled = true;
  m.section().requestFullscreen = () =>
    Promise.reject(Error("synthetic fullscreen"));
  m.controls().props.onFullscreen();
  await ticks();
  expect(m.text(m.root)).toContain("无法进入全屏");
  expect(m.text(m.root)).not.toContain("此设备不支持标准播放器全屏");
  m.section().requestFullscreen = () => Promise.resolve();
  m.controls().props.onFullscreen();
  await ticks();
  expect(m.text(m.root)).not.toContain("无法进入全屏");
  expect(f.raw.error).toBe("");
});

it.each([
  "join",
  "retry",
  "cancel",
  "disposed",
  "rejected load",
  "raw rejected load",
])("Host original actual Pinia hooks and settlement: %s", async (scenario) => {
  const env = environment(),
    { runtime, owner } = actualRuntime(env);
  let reject = false;
  if (scenario.includes("rejected")) {
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
          throw Error("host-load-rejected");
        }
        return "movie";
      },
    } as any;
  }
  owner.blocked.value = true;
  owner.preparation.value = {
    phase: "failed",
    failure: { message: "Failed", retryable: true },
  };
  const m = mountHost(runtime as any, env);
  // Capture the original rendered retry callback before selecting a cancel UI.
  const retry = m.button("重新发起播放").props.onClick;
  if (scenario === "cancel") {
    owner.preparation.value = { phase: "preparing", generation: 1 };
    await ticks();
  }
  if (scenario === "disposed") runtime.$dispose();
  let tick = 0,
    settled = false;
  const events: string[] = [];
  runtime.$onAction(({ name, store, after, onError }) => {
    expect(store).toBe(runtime);
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
      (value) => events.push(`${tick}:error:${value}`),
      { flush: "sync" },
    ),
  );
  reject = scenario.includes("rejected");
  const result =
    scenario === "join"
      ? m.button("点击加入播放").props.onClick()
      : scenario === "cancel"
        ? m.button("取消准备").props.onClick()
        : scenario === "raw rejected load"
          ? runtime.loadMedia()
          : retry();
  result?.then(
    () => {
      settled = true;
      events.push(`${tick}:resolved`);
    },
    (error: Error) => {
      settled = true;
      events.push(`${tick}:rejected:${error.message}`);
    },
  );
  const states = [`${+runtime.busy}/${+!!runtime.error}/${+settled}`];
  for (tick = 1; tick <= 14; tick++) {
    await Promise.resolve();
    states.push(`${+runtime.busy}/${+!!runtime.error}/${+settled}`);
  }
  expect({
    scenario,
    returned: result === undefined ? "void" : "promise",
    states,
    events,
  }).toEqual(originalPiniaTraces.find((value) => value.scenario === scenario));
  expect(settled).toBe(result !== undefined);
  expect(
    events.some((event) =>
      event.includes(
        scenario === "raw rejected load"
          ? "error:loadMedia"
          : "after:runPlayback",
      ),
    ),
  ).toBe(true);
});

// Recorded from the exact original compiled Host and actual Pinia in probe-03.
const originalPiniaTraces = [
  {
    scenario: "join",
    returned: "promise",
    states: [
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:enablePlayback",
      "1:after:enablePlayback",
      "3:busy:false",
      "4:after:runPlayback",
      "6:resolved",
    ],
  },
  {
    scenario: "retry",
    returned: "void",
    states: [
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:loadMedia",
      "2:after:loadMedia",
      "4:busy:false",
      "5:after:runPlayback",
    ],
  },
  {
    scenario: "cancel",
    returned: "void",
    states: [
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:cancelPreparation",
      "1:start:can",
      "1:after:can",
      "8:start:can",
      "8:after:can",
      "8:after:cancelPreparation",
      "10:busy:false",
      "11:after:runPlayback",
    ],
  },
  {
    scenario: "disposed",
    returned: "void",
    states: [
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
    ],
    events: [
      "0:start:runPlayback",
      "1:start:can",
      "1:after:can",
      "1:after:runPlayback",
    ],
  },
  {
    scenario: "rejected load",
    returned: "void",
    states: [
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "1/0/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
      "0/1/0",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:loadMedia",
      "2:error:loadMedia",
      "5:error:host-load-rejected",
      "5:busy:false",
      "6:after:runPlayback",
    ],
  },
  {
    scenario: "raw rejected load",
    returned: "promise",
    states: [
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/0",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
      "0/0/1",
    ],
    events: [
      "0:start:loadMedia",
      "2:error:loadMedia",
      "5:rejected:host-load-rejected",
    ],
  },
];

it("Host original actual attach/can/send/dismiss keep named synchronous action hooks", async () => {
  const env = environment(),
    { runtime, owner } = actualRuntime(env);
  const events: string[] = [];
  runtime.$onAction(({ name, store, after, onError }) => {
    expect(store).toBe(runtime);
    events.push(`start:${name}`);
    after((value) => events.push(`after:${name}:${String(value)}`));
    onError(() => events.push(`error:${name}`));
  });
  const m = mountHost(runtime as any, env);
  expect(owner.video.value).toBe(m.video());
  expect(events).toContain("start:attach");
  expect(events).toContain("after:attach:undefined");
  events.length = 0;
  runtime.attach(m.video() as unknown as HTMLVideoElement);
  expect(() =>
    runtime.attach(
      new env.TreeNode("other-video") as unknown as HTMLVideoElement,
    ),
  ).toThrow("播放器已绑定");
  expect(runtime.can("seek")).toBe(false);
  expect(runtime.send("SEEK", { position_ms: 10 })).toBe(false);
  owner.playbackError.value = "owned notice";
  runtime.dismissError(runtime.errorNotice);
  expect(events).toEqual([
    "start:attach",
    "after:attach:undefined",
    "start:attach",
    "error:attach",
    "start:can",
    "after:can:false",
    "start:send",
    "after:send:false",
    "start:dismissError",
    "after:dismissError:undefined",
  ]);
  expect(runtime.error).toBe("");
  expect(owner.video.value).toBe(m.video());
});

it("Host original scoped fullscreen notices ignore stale dismissal and preserve unrelated owner", async () => {
  const env = environment(),
    { runtime, owner } = actualRuntime(env),
    m = mountHost(runtime as any, env);
  env.document.fullscreenElement = m.section();
  env.document.dispatchEvent(new Event("fullscreenchange"));
  owner.playbackError.value = "same notice";
  await ticks();
  const stale = m.button("关闭提示").props.onClick;
  runtime.roomError = "same notice";
  stale();
  expect(runtime.errorNotice?.owner).toBe("room");
  await ticks();
  const calls: string[] = [];
  runtime.$onAction(({ name }) => calls.push(name));
  m.button("关闭提示").props.onClick();
  expect(calls).toEqual(["dismissError"]);
  expect(runtime.errorNotice?.owner).toBe("playback");
  owner.preparation.value = {
    phase: "failed",
    failure: preparationFailure(Error("same notice")),
  };
  await ticks();
  expect(
    m
      .all()
      .some(
        (node) => node.tag === "button" && m.text(node).trim() === "关闭提示",
      ),
  ).toBe(false);
  runtime.roomError = "different room notice";
  await ticks();
  expect(m.text(m.root)).toContain("different room notice");
});

it("AppShell original indirect notice input uses actual store and keeps action/runtime scopes separate", async () => {
  const env = environment(),
    { runtime, owner } = actualRuntime(env),
    m = mountHost(runtime as any, env, { appShell: true });
  const shell = m.notices.find((value) => value.action)!;
  expect(shell).toBeDefined();
  expect(shell.input).toBe((runtime as any).playbackHost?.notice ?? runtime);
  owner.playbackError.value = "same notice";
  shell.action!.value = "same notice";
  const stale = shell.value.value!.dismiss;
  shell.action!.value = "new action";
  stale();
  expect(shell.action!.value).toBe("new action");
  expect(runtime.error).toBe("same notice");
  shell.value.value!.dismiss();
  expect(shell.action!.value).toBe("");
  expect(shell.value.value?.source).toBe("runtime");
  owner.preparation.value = {
    phase: "failed",
    failure: preparationFailure(Error("same notice")),
  };
  expect(shell.value.value).toBeUndefined();
  runtime.roomError = "room notice";
  expect(shell.value.value?.message).toBe("room notice");
  shell.value.value!.dismiss();
  expect(runtime.errorNotice?.owner).toBe("playback");
  expect(shell.value.value).toBeUndefined();
});

it("Host original lazy recovery/error reads retain their fullscreen render order", async () => {
  const env = environment(),
    f = fakeRuntime(env, {
      recoveryLabel: "recovering",
      error: "room failure",
    });
  f.spyReads(["recoveryLabel", "error", "preparation"]);
  const m = mountHost(f.raw, env);
  await ticks();
  f.arm();
  env.document.fullscreenElement = m.section();
  env.document.dispatchEvent(new Event("fullscreenchange"));
  await ticks();
  expect(f.events).toEqual([
    "read:recoveryLabel",
    "read:recoveryLabel",
    "lookup:can",
    "can:play",
    "read:error",
    "read:preparation",
    "read:recoveryLabel",
    "read:recoveryLabel",
  ]);
  expect(m.text(m.root)).toContain("recovering");
});

async function grantedHost() {
  const env = environment();
  let grants = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, request: RequestInit = {}) => {
      if (url.endsWith("/playback-candidates"))
        return Response.json({
          schema_version: 1,
          binding: null,
          candidates: [],
          decision_reason: "legacy_transport_fallback",
        });
      if (url.endsWith("/playback-sessions") && request.method === "POST")
        return Response.json({
          session_id: `host-session-${++grants}`,
          media_id: "media",
          media_generation: 1,
          plan_generation: JSON.parse(String(request.body)).plan_generation,
          transport: "progressive",
          delivery_mode: "direct",
          playback_url: "/authorized-host.mp4",
          timeline_origin_ms: 0,
          duration_ms: 120000,
          rebuild_on_seek: false,
          expires_in_seconds: 1800,
          audio_tracks: [],
          subtitle_tracks: [
            {
              index: 4,
              label: "English",
              language: "en",
              codec: "webvtt",
              url: "/subtitle.vtt",
            },
          ],
        });
      return Response.json(
        url.includes("/media/") ? { id: "media", title: "Media" } : [],
      );
    }),
  );
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const f = actualRuntime(env),
    m = mountHost(f.runtime as any, env),
    video = m.video();
  video.readyState = 4;
  video.buffered = video.seekable = {
    length: 1,
    start: () => 0,
    end: () => 120,
  } as any;
  await f.runtime.enter({
    id: "room",
    name: "Room",
    owner_id: "viewer",
    lifecycle: "active",
    lifecycle_epoch: 0,
  });
  const socket = sockets[0];
  socket.onopen();
  const frame = (value: unknown) =>
    socket.onmessage({ data: JSON.stringify(value) });
  const state = {
    room_id: "room",
    revision: 1,
    media_id: "media",
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 0,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: "viewer",
    duration_ms: 120000,
    clock_epoch: "clock",
  };
  frame({
    type: "SNAPSHOT",
    state,
    lifecycle: "active",
    lifecycle_epoch: 0,
    control_epoch: { id: "control" },
  });
  const sample = socket.send.mock.calls
    .map(([data]: [string]) => JSON.parse(data))
    .find((value: any) => value.type === "CLOCK_SYNC");
  expect(sample).toBeDefined();
  frame({
    type: "CLOCK_SYNC_REPLY",
    t1: sample.t1,
    t2: 0,
    t3: 0,
    clock_epoch: "clock",
  });
  await vi.waitFor(() => expect(video.src).toBe("/authorized-host.mp4"));
  await ticks(15);
  return { ...f, env, m, video, state, frame, grants: () => grants };
}

it("Host original granted subtitle handler writes draft, synchronous watcher and wrapped apply in order", async () => {
  const f = await grantedHost();
  f.owner.subtitleIndex.value = 4;
  await ticks();
  const track = f.m.find((node) => node.tag === "track");
  track.readyState = 3;
  track.props.onError({ currentTarget: track });
  await ticks();
  const events: string[] = [];
  f.runtime.$onAction(({ name, after }) => {
    events.push(`start:${name}`);
    after(() => events.push(`after:${name}`));
  });
  stops.push(
    Vue.watch(
      f.owner.subtitleIndex,
      (value: number | undefined) => events.push(`watch:${value}`),
      { flush: "sync" },
    ),
  );
  f.m.button("关闭字幕").props.onClick();
  expect(events).toEqual([
    "watch:undefined",
    "start:applySubtitles",
    "after:applySubtitles",
  ]);
  expect(track.track.mode).toBe("disabled");
  expect(f.grants()).toBe(1);
  expect(f.video.src).toBe("/authorized-host.mp4");
});

it.each(["resolve", "sync throw", "reject", "late identity"])(
  "Host original granted gesture through real Pinia preserves %s",
  async (scenario) => {
    const f = await grantedHost();
    f.runtime.state = { ...f.state, playback_status: "playing" } as any;
    f.owner.blocked.value = true;
    await ticks();
    let reject!: (reason: Error) => void;
    const denied = new DOMException("synthetic autoplay", "NotAllowedError");
    f.video.play = () => {
      if (scenario === "sync throw") throw denied;
      if (scenario === "reject") return Promise.reject(denied);
      if (scenario === "late identity")
        return new Promise<void>((_done, fail) => {
          reject = fail;
        });
      f.video.paused = false;
      return Promise.resolve();
    };
    let tick = 0,
      settled = false;
    const events: string[] = [];
    f.runtime.$onAction(({ name, after, onError }) => {
      events.push(`${tick}:start:${name}`);
      after(() => events.push(`${tick}:after:${name}`));
      onError(() => events.push(`${tick}:error:${name}`));
    });
    stops.push(
      Vue.watch(
        () => f.runtime.busy,
        (value) => events.push(`${tick}:busy:${value}`),
        { flush: "sync" },
      ),
    );
    stops.push(
      Vue.watch(
        () => f.runtime.error,
        (value) => events.push(`${tick}:notice:${value}`),
        { flush: "sync" },
      ),
    );
    const result = f.m.button("点击加入播放").props.onClick();
    expect(result).toBeInstanceOf(Promise);
    result.then(() => {
      settled = true;
      events.push(`${tick}:resolved`);
    });
    if (scenario === "late identity") {
      f.session.accept({
        id: "successor",
        username: "successor",
        admin: false,
        csrf: "synthetic-successor",
      });
      f.owner.playbackError.value = "successor notice";
      reject(denied);
    }
    const states = [
      `${+f.runtime.busy}/${+f.owner.blocked.value}/${+!!f.runtime.error}/${+settled}`,
    ];
    for (tick = 1; tick <= 18; tick++) {
      await Promise.resolve();
      states.push(
        `${+f.runtime.busy}/${+f.owner.blocked.value}/${+!!f.runtime.error}/${+settled}`,
      );
    }
    expect({ scenario, states, events }).toEqual(
      originalGrantedTraces.find((value) => value.scenario === scenario),
    );
    expect(settled).toBe(true);
    if (scenario === "late identity")
      expect(f.runtime.error).toBe("successor notice");
    if (scenario === "sync throw" || scenario === "reject")
      expect(f.owner.blocked.value).toBe(true);
  },
);

it("Host original information permission checks short circuit only after the first allowed action", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    m = mountHost(f.raw, env);
  f.methods.can = (permission) => {
    f.events.push(`can:${permission}`);
    return permission === "change_media";
  };
  f.arm();
  env.document.fullscreenElement = m.section();
  env.document.dispatchEvent(new Event("fullscreenchange"));
  await ticks();
  expect(f.events.filter((value) => value.startsWith("can:"))).toEqual([
    "can:play",
    "can:pause",
    "can:seek",
    "can:set_rate",
    "can:change_media",
  ]);
  expect(m.text(m.root)).toContain("你可以控制房间播放。");
});

it("Host original chrome event wiring retains menus, dragging, hidden state and layout focus cleanup", async () => {
  const env = environment(),
    f = fakeRuntime(env),
    anchor = new env.TreeNode("anchor"),
    m = mountHost(f.raw, env, { anchor });
  env.document.fullscreenElement = m.section();
  env.document.dispatchEvent(new Event("fullscreenchange"));
  await ticks();
  m.controls().props.onMenuOpen(true);
  await vi.advanceTimersByTimeAsync(2100);
  expect(m.chrome().visible.value).toBe(true);
  m.controls().props.onMenuOpen(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(m.chrome().visible.value).toBe(false);
  f.raw.dragging = true;
  await ticks();
  await vi.advanceTimersByTimeAsync(2100);
  expect(m.chrome().visible.value).toBe(true);
  f.raw.dragging = false;
  await ticks();
  env.document.hidden = true;
  env.document.dispatchEvent(new Event("visibilitychange"));
  expect(m.chrome().hideCursor.value).toBe(false);
  env.document.hidden = false;
  env.document.dispatchEvent(new Event("visibilitychange"));
  expect(m.chrome().visible.value).toBe(true);
  env.document.fullscreenElement = null;
  env.document.dispatchEvent(new Event("fullscreenchange"));
  await ticks();
  env.document.activeElement = m.video();
  m.props.layoutEditing = true;
  await ticks();
  expect(env.effects).toContain("blur:video");
  expect(m.section().props.inert).toBe(true);
  expect(env.document.activeElement).toBeNull();
});

// Original real-grant gesture observations, captured before production wiring.
const originalGrantedTraces = [
  {
    scenario: "resolve",
    states: [
      "1/0/0/0",
      "1/0/0/0",
      "1/0/0/0",
      "1/0/0/0",
      "1/0/0/0",
      "1/0/0/0",
      "0/0/0/0",
      "0/0/0/0",
      "0/0/0/0",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
      "0/0/0/1",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:enablePlayback",
      "4:after:enablePlayback",
      "6:busy:false",
      "7:after:runPlayback",
      "9:resolved",
    ],
  },
  {
    scenario: "sync throw",
    states: [
      "1/1/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "0/1/1/0",
      "0/1/1/0",
      "0/1/1/0",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:enablePlayback",
      "2:error:enablePlayback",
      "5:notice:synthetic autoplay",
      "5:busy:false",
      "6:after:runPlayback",
      "8:resolved",
    ],
  },
  {
    scenario: "reject",
    states: [
      "1/0/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "1/1/0/0",
      "0/1/1/0",
      "0/1/1/0",
      "0/1/1/0",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
      "0/1/1/1",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:enablePlayback",
      "3:error:enablePlayback",
      "6:notice:synthetic autoplay",
      "6:busy:false",
      "7:after:runPlayback",
      "9:resolved",
    ],
  },
  {
    scenario: "late identity",
    states: [
      "0/0/1/0",
      "0/0/1/0",
      "0/0/1/0",
      "0/0/1/0",
      "0/0/1/0",
      "0/0/1/0",
      "0/0/1/0",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
      "0/0/1/1",
    ],
    events: [
      "0:start:runPlayback",
      "0:busy:true",
      "0:start:enablePlayback",
      "0:busy:false",
      "0:notice:successor notice",
      "1:start:can",
      "1:after:can",
      "2:after:enablePlayback",
      "5:after:runPlayback",
      "7:resolved",
    ],
  },
];

it.each(["no session", "no media", "selection retired", "grant changed"])(
  "Host original held subtitle retry retains current guard and resource ownership: %s",
  async (scenario) => {
    const env = environment(),
      f = fakeRuntime(env),
      m = mountHost(f.raw, env);
    const track = m.find((node) => node.tag === "track");
    track.readyState = 3;
    track.props.onError({ currentTarget: track });
    await ticks();
    const retry = m.button("重试字幕").props.onClick;
    f.spyReads(["sessionId", "state"]);
    if (scenario === "no session") f.raw.sessionId = undefined;
    if (scenario === "no media") f.raw.state.media_id = null;
    if (scenario === "selection retired") {
      f.raw.subtitleIndex = undefined;
      await ticks();
    }
    f.arm();
    const result = retry();
    const immediate = [...f.events];
    f.disarm();
    if (scenario === "grant changed") {
      f.raw.sessionId = "successor-session";
      f.raw.subtitleIndex = undefined;
    }
    await result;
    expect(immediate).toEqual(
      scenario === "selection retired"
        ? []
        : scenario === "no session"
          ? ["read:sessionId"]
          : ["read:sessionId", "read:state"],
    );
    expect(f.events.filter((value) => value === "apply")).toHaveLength(
      scenario === "grant changed" ? 1 : 0,
    );
    expect(f.events.some((value) => value === "reload")).toBe(false);
    expect(env.effects.some((value) => value === "load:video")).toBe(false);
    if (scenario === "grant changed") {
      expect(m.find((node) => node.tag === "track")).not.toBe(track);
      expect(f.raw.sessionId).toBe("successor-session");
    }
  },
);

it("Host original pending placement cleanup observes only the current anchor after nextTick", async () => {
  const env = environment(),
    f = fakeRuntime(env);
  const old = new env.TreeNode("old-anchor"),
    current = new env.TreeNode("current-anchor");
  const m = mountHost(f.raw, env, { anchor: old });
  const video = m.video();
  m.props.anchor = current;
  old.connected = false;
  await ticks();
  expect(env.effects.some((value) => value.endsWith(":old-anchor"))).toBe(
    false,
  );
  expect(env.effects.some((value) => value.endsWith(":current-anchor"))).toBe(
    true,
  );
  expect(m.video()).toBe(video);
  expect(env.effects.filter((value) => value === "attach:video")).toHaveLength(
    1,
  );
  m.unmount();
  expect(env.frames.size).toBe(0);
});
