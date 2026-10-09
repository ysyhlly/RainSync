import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useRoomRuntime } from "../apps/web/src/features/rooms/room-runtime";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useMediaCatalog } from "../apps/web/src/features/library/media-catalog.store";
import { createLibraryState } from "../apps/web/src/features/library/library.store";
import { libraryPageSummary } from "../apps/web/src/features/library/library-summary";
import { mediaEpisodeLabel } from "../apps/web/src/features/library/media-label";
import { roomsApi } from "../apps/web/src/features/rooms/rooms.api";
import { createRoomSubmission } from "../apps/web/src/features/rooms/room-creation";
import { parseGuestInvitation } from "../apps/web/src/features/auth/guest-session";
import * as ppLifecycle from "../apps/web/src/features/rooms/room-lifecycle";
import { useAction, formatTime } from "../apps/web/src/shared/use-action";
import { prewarmNativeDash } from "../apps/web/src/features/playback/dash-prewarm";
import * as timeline from "../apps/web/src/features/rooms/timeline-chat";
import * as timelineView from "../apps/web/src/features/rooms/timeline-view-state";
import { useTransientMessage } from "../apps/web/src/shared/use-transient-message";
import { mountSetup } from "./helpers/mount-setup";

// prewarm-dev: exact-original caller characterization.
// Baseline source: 2ffcccfb9a39f6449c1b6a525eae0031e9a63b5b. All production
// SFCs and existing tests are unmodified. This renderer runs compileScript's
// original inline template and event handlers; DOM widgets, transport replies
// and optional SDK acquisition are explicitly synthetic boundaries.
const ppSdk = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../packages/player-core/dash/loader", () => ({
  loadDashJs: (...args: unknown[]) => ppSdk.load(...args),
}));
const ppDirectory = fileURLToPath(
  new URL("../apps/web/src/features/rooms/", import.meta.url),
);
const ppCompiled = new Map<string, string>();
const ppCleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  if (!ppCleanups.length) return;
  for (const cleanup of ppCleanups.splice(0).reverse()) await cleanup();
  await ppTicks(80);
  expect(
    vi.getTimerCount(),
    "Page characterization releases its original timers",
  ).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function ppTicks(count = 20) {
  for (let index = 0; index < count; index++) await Vue.nextTick();
}
function ppDeferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ppObserve(label: string, actual: unknown) {
  expect(
    Object.hasOwn(ppBaseline, label),
    `Frozen observation exists: ${label}`,
  ).toBe(true);
  expect(actual, label).toEqual(ppBaseline[label]);
}
function ppCompile(name: string) {
  const path = resolve(ppDirectory, name);
  if (!ppCompiled.has(path)) {
    const { descriptor, errors } = parse(readFileSync(path, "utf8"), {
      filename: path,
    });
    if (errors.length) throw errors[0];
    const script = compileScript(descriptor, {
      id: `page-playback-facts-${name}`,
      inlineTemplate: true,
    });
    ppCompiled.set(
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
  return ppCompiled.get(path)!;
}
function ppEnvironment() {
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
  ppSdk.load.mockReset().mockResolvedValue({});
  const events: string[] = [];
  class Node extends EventTarget {
    props: Record<string, any> = {};
    children: Node[] = [];
    parent?: Node;
    text = "";
    value: any = "";
    style: Record<string, any> = {};
    constructor(readonly tag: string) {
      super();
      Vue.markRaw(this);
    }
    get tagName() {
      return this.tag.toUpperCase();
    }
    getAttribute(key: string) {
      return this.props[key] ?? null;
    }
    setAttribute(key: string, value: unknown) {
      this.props[key] = value;
    }
    removeAttribute(key: string) {
      delete this.props[key];
    }
    focus() {}
  }
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    visibilityState: "visible",
    documentElement: new Node("html"),
    querySelector: () => null,
  });
  const window = Object.assign(new EventTarget(), {
    location: { origin: "http://localhost" },
  });
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
    HTMLElement: Node,
    Element: Node,
    localStorage: storage,
    sessionStorage: storage,
    self: { MediaSource: source },
    navigator: {},
    location: {
      origin: "http://localhost",
      protocol: "http:",
      host: "localhost",
      href: "http://localhost/rooms",
    },
  }))
    vi.stubGlobal(key, value);
  return { Node, document, window, events, source };
}
type ppEnvironmentType = ReturnType<typeof ppEnvironment>;
type ppNode = InstanceType<ppEnvironmentType["Node"]>;
const ppMedia = (id = "film") => ({
  id,
  title: `Film ${id}`,
  kind: "native_platform",
  duration_ms: 90000,
  platform: { version: 1, provider: "bilibili" },
});
const ppRoom = {
  id: "room",
  name: "Room",
  owner_id: "viewer",
  lifecycle: "active",
};
function ppBrowse() {
  return {
    node: null,
    breadcrumbs: [{ id: null, name: "全部片源" }],
    entries: [{ type: "media", media: ppMedia() }],
    next_cursor: null,
    total_media: 1,
  };
}

function ppFixture(actual = true) {
  const env = ppEnvironment();
  const events = env.events;
  const requests: { path: string; method: string; body: any }[] = [];
  const sockets: any[] = [];
  const control = {
    playlistGate: undefined as
      ReturnType<typeof ppDeferred<Response>> | undefined,
    playlistError: undefined as Error | undefined,
    sendError: undefined as Error | undefined,
    onChange: undefined as ((value: any) => void) | undefined,
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    readonly close = vi.fn();
    readonly send = vi.fn((raw: string) => {
      const value = JSON.parse(raw);
      if (value.type === "CHANGE_MEDIA") {
        events.push(`socket:${value.type}:${value.payload.media_id}`);
        if (control.sendError) throw control.sendError;
        control.onChange?.(value);
      }
    });
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api\/v1/, ""),
        method = init.method ?? "GET";
      const body =
        init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ path, method, body });
      if (path === "/rooms") return Response.json([ppRoom]);
      if (path.startsWith("/media/browse?")) return Response.json(ppBrowse());
      if (path.endsWith("/playlist")) {
        events.push(`http:playlist:${method}`);
        if (control.playlistError) throw control.playlistError;
        return control.playlistGate?.promise ?? Response.json([]);
      }
      if (path.includes("/media/"))
        return Response.json(ppMedia(path.split("/").at(-1)));
      if (path.endsWith("/permissions"))
        return Response.json({ permissions: [] });
      if (path.includes("playback-sessions"))
        throw Error("Unexpected playback grant in page fact characterization");
      return Response.json([]);
    }),
  );
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({
    id: "viewer",
    username: "viewer",
    csrf: "synthetic-page-test",
    admin: false,
  });
  const catalog = useMediaCatalog();
  const rights = Vue.reactive({ change_media: true, queue: true });
  const base = Vue.reactive<any>({
    room: { ...ppRoom },
    state: { media_id: "current", controller_user_id: "viewer" },
    roomActive: true,
    connected: true,
    error: "",
    nativePlaybackMode: "auto",
    playlist: [],
    playlistError: "",
    queuePending: () => false,
    queueReceipt: () => "",
    can: (key: keyof typeof rights) => {
      events.push(`can:${key}`);
      return rights[key];
    },
    choose: vi.fn(async (id: string) => {
      events.push(`choose:${id}`);
      return true;
    }),
    enter: vi.fn(async (room: any) => {
      events.push(`enter:${room.id}`);
    }),
    addQueue: vi.fn(async () => {}),
  });
  const reads = new Set<string>();
  const synthetic = new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === "string" && reads.has(key)) events.push(`read:${key}`);
      return Reflect.get(target, key, receiver);
    },
  });
  // Candidate fixture routing only: the same original late getter, not a copy.
  Object.defineProperty(base, "playbackRoom", {
    configurable: true,
    value: Object.defineProperty({}, "nativePlaybackMode", {
      enumerable: true,
      get: () => synthetic.nativePlaybackMode,
    }),
  });
  // End candidate fixture routing.
  const runtime = actual ? useRoomRuntime() : synthetic;
  const prewarm = vi.fn((selected: any, mode: string | undefined) => {
    // Observe the received object without invoking a synthetic item getter an
    // extra time. The accessor case is exercised separately below.
    const descriptor =
      selected && Object.getOwnPropertyDescriptor(Vue.toRaw(selected), "id");
    const id = descriptor?.get ? "<accessor>" : descriptor?.value;
    events.push(`prewarm:${id}:${String(mode)}`);
    return prewarmNativeDash(selected, mode);
  });
  let catalogEffect: (() => void) | undefined;
  const callerCatalog = new Proxy(catalog, {
    get(target, key, receiver) {
      if (key === "roomRecord")
        return (room: string, id: string) => {
          events.push(`catalog:${room}:${id}`);
          catalogEffect?.();
          return target.roomRecord(room, id);
        };
      return Reflect.get(target, key, receiver);
    },
  });
  ppCleanups.push(async () => {
    control.playlistGate?.resolve(Response.json([]));
    control.playlistError = undefined;
    control.sendError = undefined;
    control.onChange = undefined;
    if (actual) await runtime.leave();
    disposePinia(pinia);
  });
  function frame(value: any) {
    sockets.at(-1).onmessage({ data: JSON.stringify(value) });
  }
  function confirm(id: string) {
    frame({
      type: "EVENT",
      control_epoch: { id: "control" },
      state: {
        ...runtime.state,
        media_id: id,
        revision: runtime.state.revision + 1,
      },
    });
  }
  async function ready(media = "current") {
    if (actual) {
      await runtime.enter({ ...ppRoom });
      sockets.at(-1).onopen();
      frame({
        type: "SNAPSHOT",
        control_epoch: { id: "control" },
        state: {
          room_id: "room",
          revision: 1,
          media_id: null,
          media_generation: 1,
          playback_status: "paused",
          anchor_position_ms: 0,
          anchor_server_time_ms: 0,
          playback_rate: 1,
          controller_user_id: "viewer",
          duration_ms: 90000,
          clock_epoch: "epoch",
        },
      });
      await ppTicks(100);
      runtime.state = { ...runtime.state, media_id: media };
      await ppTicks(80);
    }
    catalog.rememberRoom("room", [ppMedia(media) as any]);
    events.length = requests.length = 0;
  }
  return {
    env,
    events,
    requests,
    sockets,
    control,
    pinia,
    session,
    catalog,
    callerCatalog,
    runtime,
    base,
    rights,
    reads,
    prewarm,
    ready,
    frame,
    confirm,
    setCatalogEffect: (effect?: () => void) => {
      catalogEffect = effect;
    },
  };
}
type ppFixtureType = ReturnType<typeof ppFixture>;

function ppMount(
  f: ppFixtureType,
  name: "RoomsPage.vue" | "RoomMediaPicker.vue",
) {
  const refs: Vue.Ref<any>[] = [],
    actions: ReturnType<typeof useAction>[] = [],
    browsers: ReturnType<typeof createLibraryState>[] = [];
  const props = Vue.reactive({ modelValue: true });
  const closed = vi.fn((value: boolean) => {
    f.events.push(`close:${value}`);
  });
  const router = {
    push: vi.fn(async (path: string) => {
      f.events.push(`router:${path}`);
    }),
  };
  // Passthrough setup observation: every ref and useAction object is the real
  // original object; no action or Promise is replaced to obtain settlement.
  const vue = {
    ...Vue,
    ref: (...args: any[]) => {
      const value = (Vue.ref as any)(...args);
      refs.push(value);
      return value;
    },
  };
  const placeholder = Vue.defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        Vue.h("test-child", {}, slots.default?.()),
  });
  const notice = Vue.defineComponent({
    props: ["message", "error"],
    setup: (p) => () =>
      Vue.h("test-notice", { error: p.error }, p.message ?? ""),
  });
  const dialog = Vue.defineComponent({
    props: ["modelValue", "title", "busy", "drawer"],
    emits: ["update:modelValue"],
    setup(p, { slots, emit }) {
      return () =>
        p.modelValue
          ? Vue.h(
              "test-dialog",
              {
                title: p.title,
                onClose: () => emit("update:modelValue", false),
              },
              slots.default?.(),
            )
          : null;
    },
  });
  const require = (specifier: string): any => {
    if (specifier === "vue") return vue;
    if (specifier === "vue-router") return { useRouter: () => router };
    if (specifier === "./room-runtime")
      return { useRoomRuntime: () => f.runtime };
    if (specifier === "../auth/session.store")
      return { useSession: () => f.session };
    if (specifier === "../library/media-catalog.store")
      return { useMediaCatalog: () => f.callerCatalog };
    if (specifier === "./rooms.api") return { roomsApi };
    if (specifier === "./room-creation") return { createRoomSubmission };
    if (specifier === "../auth/guest-session") return { parseGuestInvitation };
    if (specifier === "./room-lifecycle") return ppLifecycle;
    if (specifier === "../../shared/use-action")
      return {
        formatTime,
        useAction: () => {
          const action = useAction();
          actions.push(action);
          return action;
        },
      };
    if (specifier === "../library/library.store")
      return {
        createLibraryState: () => {
          const browser = createLibraryState();
          browsers.push(browser);
          return browser;
        },
      };
    if (specifier === "../library/library-summary")
      return { libraryPageSummary };
    if (specifier === "../library/media-label") return { mediaEpisodeLabel };
    if (specifier === "../playback/dash-prewarm")
      return { prewarmNativeDash: f.prewarm };
    if (specifier.endsWith("AppDialog.vue"))
      return { __esModule: true, default: dialog };
    if (specifier.endsWith("Notice.vue"))
      return { __esModule: true, default: notice };
    if (specifier.endsWith(".vue"))
      return { __esModule: true, default: placeholder };
    throw Error(`Unexpected page characterization import: ${specifier}`);
  };
  const module = { exports: {} as { default: Vue.Component } };
  new Function("require", "module", "exports", ppCompile(name))(
    require,
    module,
    module.exports,
  );
  const remove = (node: ppNode) => {
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) node.parent.children.splice(index, 1);
      node.parent = undefined;
    }
  };
  const renderer = Vue.createRenderer<ppNode, ppNode>({
    patchProp(node, key, old, value) {
      node.props[key] = value;
      if (key === "value") node.value = value;
      if (key === "type") (node as any).type = value;
    },
    insert(node, parent, anchor) {
      remove(node);
      node.parent = parent;
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at < 0) parent.children.push(node);
      else parent.children.splice(at, 0, node);
    },
    remove,
    createElement: (tag) => new f.env.Node(tag),
    createText: (text) => Object.assign(new f.env.Node("text"), { text }),
    createComment: (text) => Object.assign(new f.env.Node("comment"), { text }),
    setText: (node, text) => {
      node.text = text;
    },
    setElementText: (node, text) => {
      node.text = text;
      node.children = [];
    },
    parentNode: (node) => node.parent ?? null,
    nextSibling: (node) =>
      node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  });
  const app = renderer.createApp({
    setup: () => () =>
      Vue.h(module.exports.default, {
        ...props,
        "onUpdate:modelValue": closed,
      }),
  });
  app.use(f.pinia);
  const root = new f.env.Node("root");
  app.mount(root);
  let active = true;
  const unmount = () => {
    if (active) {
      active = false;
      app.unmount();
    }
  };
  ppCleanups.push(unmount);
  const all = (node = root): ppNode[] => [
    node,
    ...node.children.flatMap((child) => all(child)),
  ];
  const text = (node = root): string =>
    node.tag === "comment"
      ? ""
      : node.text + node.children.map((child) => text(child)).join("");
  const find = (predicate: (node: ppNode) => boolean) => {
    const node = all().find(predicate);
    if (!node) throw Error(`Page node not found; text=${text()}`);
    return node;
  };
  const button = (label: string) =>
    find((node) => node.tag === "button" && text(node).includes(label));
  const play = () =>
    find(
      (node) =>
        node.tag === "button" &&
        String(node.props["aria-label"]).startsWith("立即播放 "),
    );
  return {
    root,
    props,
    refs,
    actions,
    browsers,
    closed,
    router,
    unmount,
    all,
    text,
    find,
    button,
    play,
    receipt: () => refs[2].value.film,
    pending: () => refs[4].value,
  };
}
type ppMountType = ReturnType<typeof ppMount>;
function ppActionProbe(f: ppFixtureType, names = ["enter", "choose"]) {
  const calls: { name: string; sameStore: boolean; args: unknown[] }[] = [];
  const stop = f.runtime.$onAction(
    ({ name, args, store, after, onError }: any) => {
      if (!names.includes(name)) return;
      calls.push({ name, sameStore: store === f.runtime, args });
      f.events.push(`action:before:${name}`);
      after((value: unknown) =>
        f.events.push(`action:after:${name}:${String(value)}`),
      );
      onError((error: Error) =>
        f.events.push(`action:error:${name}:${error.message}`),
      );
    },
  );
  ppCleanups.push(stop);
  return calls;
}
function ppWatchPicker(f: ppFixtureType, m: ppMountType) {
  const stops = [
    Vue.watch(m.refs[4], (value) => f.events.push(`pending:${value}`), {
      flush: "sync",
    }),
    Vue.watch(
      m.refs[2],
      (value) => f.events.push(`receipt:${value.film?.message ?? "empty"}`),
      { flush: "sync", deep: true },
    ),
  ];
  ppCleanups.push(() => stops.forEach((stop) => stop()));
}

it("RoomsPage actual Pinia enter ignores a pending optional SDK and preserves useAction/hook/router timing", async () => {
  const f = ppFixture();
  await f.ready("film");
  const m = ppMount(f, "RoomsPage.vue");
  await ppTicks(100);
  const calls = ppActionProbe(f),
    sdk = ppDeferred(),
    playlist = ppDeferred<Response>();
  ppSdk.load.mockReturnValueOnce(sdk.promise);
  f.control.playlistGate = playlist;
  f.events.length = 0;
  const click = m.button("返回房间").props.onClick();
  const immediate = {
    events: [...f.events],
    busy: m.actions[0].busy.value,
    error: m.actions[0].error.value,
    roomBusy: f.runtime.busy,
    promise: click instanceof Promise,
  };
  await ppTicks(50);
  const pending = {
    busy: m.actions[0].busy.value,
    pushed: m.router.push.mock.calls.length,
    hooks: calls,
  };
  playlist.resolve(Response.json([]));
  await click;
  await ppTicks();
  const settled = {
    events: [...f.events],
    busy: m.actions[0].busy.value,
    error: m.actions[0].error.value,
    pushed: m.router.push.mock.calls.length,
  };
  sdk.reject(Error("Optional SDK failure"));
  await ppTicks();
  ppObserve("rooms-actual-pending", {
    immediate,
    pending,
    settled,
    sdkError: m.actions[0].error.value,
    grants: f.requests.filter((r) => r.path.includes("playback-sessions")),
  });
});

it.each(["reject", "intent", "unmount"])(
  "RoomsPage actual Pinia enter baseline settlement: %s",
  async (variant) => {
    const f = ppFixture();
    await f.ready("film");
    const m = ppMount(f, "RoomsPage.vue");
    await ppTicks(100);
    ppActionProbe(f);
    const playlist = ppDeferred<Response>();
    f.control.playlistGate = playlist;
    f.events.length = 0;
    const click = m.button("返回房间").props.onClick();
    await ppTicks();
    if (variant === "intent") {
      m.button("通过邀请加入").props.onClick();
      await ppTicks();
    }
    if (variant === "unmount") m.unmount();
    if (variant === "reject")
      playlist.reject(Error("Original playlist failure"));
    else playlist.resolve(Response.json([]));
    const result = await click;
    await ppTicks();
    ppObserve(`rooms-actual-${variant}`, {
      events: f.events,
      result: String(result),
      busy: m.actions[0].busy.value,
      error: m.actions[0].error.value,
      roomBusy: f.runtime.busy,
      pushes: m.router.push.mock.calls,
    });
  },
);

it.each(["same", "other", "no-media", "no-state", "no-room", "unmounted"])(
  "RoomsPage synthetic getter caller preserves same-room repeated-read short circuits: %s",
  async (variant) => {
    const f = ppFixture(false);
    await f.ready("film");
    f.base.state = { media_id: "film", controller_user_id: "viewer" };
    const m = ppMount(f, "RoomsPage.vue");
    await ppTicks(100);
    const button = m.button("返回房间");
    if (variant === "other") f.base.room.id = "other";
    if (variant === "no-media") f.base.state.media_id = null;
    if (variant === "no-state") f.base.state = null;
    if (variant === "no-room") f.base.room = null;
    if (variant === "unmounted") m.unmount();
    await ppTicks();
    f.reads.add("room");
    f.reads.add("state");
    f.reads.add("nativePlaybackMode");
    f.reads.add("enter");
    f.events.length = 0;
    const click = button.props.onClick();
    const immediate = [...f.events];
    await click;
    ppObserve(`rooms-short-${variant}`, {
      immediate,
      final: f.events.filter((s) => !s.startsWith("read:room")),
      modeCalls: f.prewarm.mock.calls.map((c) => c[1]),
      sdk: ppSdk.load.mock.calls.length,
    });
  },
);

it.each(["catalog", "mse", "capability", "sdk-sync"])(
  "RoomsPage real prewarm distinguishes synchronous %s failure from ignored Promise rejection",
  async (variant) => {
    const f = ppFixture();
    await f.ready("film");
    const m = ppMount(f, "RoomsPage.vue");
    await ppTicks(100);
    ppActionProbe(f);
    if (variant === "catalog")
      f.setCatalogEffect(() => {
        throw Error("Synchronous catalog failure");
      });
    if (variant === "mse")
      vi.stubGlobal("self", {
        get ManagedMediaSource() {
          throw Error("Synchronous MSE getter failure");
        },
      });
    if (variant === "capability")
      f.env.source.isTypeSupported.mockImplementation(() => {
        throw Error("Capability check failure");
      });
    if (variant === "sdk-sync")
      ppSdk.load.mockImplementation(() => {
        throw Error("Synchronous SDK acquisition failure");
      });
    f.events.length = 0;
    await m.button("返回房间").props.onClick();
    await ppTicks();
    ppObserve(`rooms-sync-${variant}`, {
      events: f.events,
      error: m.actions[0].error.value,
      busy: m.actions[0].busy.value,
      pushes: m.router.push.mock.calls.length,
      sdk: ppSdk.load.mock.calls.length,
    });
  },
);

it.each(["auto", "native", "adaptive", "compatibility"])(
  "page prewarm reads the staged real owner mode only at the original caller: %s",
  async (mode) => {
    const f = ppFixture();
    await f.ready("film");
    const m = ppMount(f, "RoomsPage.vue");
    await ppTicks(100);
    f.runtime.playbackSettings.stageNativePlaybackMode(mode);
    await ppTicks();
    expect(f.prewarm).not.toHaveBeenCalled();
    await m.button("返回房间").props.onClick();
    ppObserve(`rooms-mode-${mode}`, {
      passed: f.prewarm.mock.calls.map((c) => c[1]),
      sdk: ppSdk.load.mock.calls.length,
      fact: f.runtime.playbackRoom.nativePlaybackMode,
    });
  },
);

it("RoomsPage resolves catalog before reading a synchronously restaged native mode", async () => {
  const f = ppFixture();
  await f.ready("film");
  const m = ppMount(f, "RoomsPage.vue");
  await ppTicks(100);
  f.setCatalogEffect(() => {
    f.runtime.playbackSettings.stageNativePlaybackMode("native");
    f.events.push("stage:native");
  });
  f.events.length = 0;
  await m.button("返回房间").props.onClick();
  ppObserve("rooms-catalog-stage", {
    events: f.events,
    passed: f.prewarm.mock.calls.map((c) => c[1]),
    sdk: ppSdk.load.mock.calls.length,
  });
});

it.each(["success", "false", "sync-confirm", "throw"])(
  "RoomMediaPicker compiled click uses original actual Pinia choose: %s",
  async (variant) => {
    const f = ppFixture();
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    const calls = ppActionProbe(f);
    ppWatchPicker(f, m);
    const sdk = ppDeferred();
    ppSdk.load.mockReturnValueOnce(sdk.promise);
    if (variant === "false") f.sockets.at(-1).readyState = 0;
    if (variant === "sync-confirm")
      f.control.onChange = () => f.confirm("film");
    if (variant === "throw")
      f.control.sendError = Error("Original socket failure");
    f.events.length = 0;
    const click = m.play().props.onClick();
    const immediate = {
      events: [...f.events],
      pending: m.pending(),
      receipt: m.receipt(),
      promise: click instanceof Promise,
      runtimeBusy: f.runtime.busy,
    };
    await click;
    await ppTicks();
    ppObserve(`picker-actual-${variant}`, {
      immediate,
      settled: {
        events: f.events,
        pending: m.pending(),
        receipt: m.receipt(),
        closes: m.closed.mock.calls,
        runtimeBusy: f.runtime.busy,
        runtimeError: f.runtime.error,
      },
      calls,
      sdk: ppSdk.load.mock.calls.length,
      grants: f.requests.filter((r) => r.path.includes("playback-sessions")),
    });
    sdk.reject(Error("Optional picker SDK failure"));
    await ppTicks();
  },
);

it.each([
  "allowed",
  "hidden",
  "no-user",
  "guest",
  "no-room",
  "inactive",
  "disconnected",
  "queue-only",
  "no-permission",
  "missing-item",
])(
  "RoomMediaPicker synthetic caller hover/focus preserve visible and permission admission: %s",
  async (variant) => {
    const f = ppFixture(false);
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    const button = m.play();
    if (variant === "hidden") m.props.modelValue = false;
    if (variant === "no-user") f.session.user = null;
    if (variant === "guest") f.session.user!.guest = true;
    if (variant === "no-room") f.base.room = null;
    if (variant === "inactive") f.base.roomActive = false;
    if (variant === "disconnected") f.base.connected = false;
    if (variant === "queue-only") f.rights.change_media = false;
    if (variant === "no-permission")
      f.rights.change_media = f.rights.queue = false;
    if (variant === "missing-item") m.browsers[0].items.value = [];
    await ppTicks();
    for (const key of [
      "room",
      "roomActive",
      "connected",
      "can",
      "nativePlaybackMode",
      "choose",
    ])
      f.reads.add(key);
    const traces = [];
    const requestCount = f.requests.length;
    for (const event of ["onPointerenter", "onFocus"]) {
      f.events.length = 0;
      const result = button.props[event]();
      traces.push({ event, result: String(result), events: [...f.events] });
    }
    ppObserve(`picker-hover-${variant}`, {
      traces,
      choose: f.runtime.choose.mock.calls.length,
      sdk: ppSdk.load.mock.calls.length,
      requests: f.requests.length - requestCount,
    });
  },
);

it.each(["auto", "native", "adaptive", "compatibility"])(
  "RoomMediaPicker actual owner stage alone is idle and hover/focus use the current %s mode",
  async (mode) => {
    const f = ppFixture();
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    const calls = ppActionProbe(f);
    const requestCount = f.requests.length;
    f.runtime.playbackSettings.stageNativePlaybackMode(mode);
    await ppTicks();
    expect(f.prewarm).not.toHaveBeenCalled();
    const button = m.play();
    const hover = button.props.onPointerenter(),
      focus = button.props.onFocus();
    await ppTicks();
    ppObserve(`picker-mode-${mode}`, {
      returns: [String(hover), String(focus)],
      modes: f.prewarm.mock.calls.map((c) => c[1]),
      sdk: ppSdk.load.mock.calls.length,
      actions: calls,
      requests: f.requests.length - requestCount,
      pending: m.pending(),
      receipt: m.receipt() ?? null,
    });
  },
);

it("RoomMediaPicker original undefined mode input retains helper default auto", async () => {
  const f = ppFixture(false);
  await f.ready();
  f.base.nativePlaybackMode = undefined;
  const m = ppMount(f, "RoomMediaPicker.vue");
  await ppTicks(100);
  m.play().props.onPointerenter();
  await m.play().props.onClick();
  ppObserve("picker-undefined-mode", {
    modes: f.prewarm.mock.calls.map((c) => String(c[1])),
    sdk: ppSdk.load.mock.calls.length,
    choose: f.runtime.choose.mock.calls,
    receipt: m.receipt(),
  });
});

it("RoomMediaPicker cached catalog item lookup can synchronously restage the actual owner before the mode read", async () => {
  const f = ppFixture();
  await f.ready();
  const m = ppMount(f, "RoomMediaPicker.vue");
  await ppTicks(100);
  let armed = false;
  const item = Vue.markRaw({
    ...ppMedia(),
    get id() {
      if (armed) {
        f.events.push("item:id");
        f.runtime.playbackSettings.stageNativePlaybackMode("native");
      }
      return "film";
    },
  });
  f.catalog.records.film = item as any;
  await ppTicks();
  armed = true;
  f.events.length = 0;
  m.play().props.onFocus();
  armed = false;
  ppObserve("picker-item-stage", {
    events: f.events,
    modes: f.prewarm.mock.calls.map((c) => c[1]),
    sameItem: f.prewarm.mock.calls[0][0] === item,
    sdk: ppSdk.load.mock.calls.length,
  });
});

it("RoomMediaPicker synthetic caller repeats prewarm admissions and writes pending/receipt before choose lookup", async () => {
  const f = ppFixture(false);
  await f.ready();
  const m = ppMount(f, "RoomMediaPicker.vue");
  await ppTicks(100);
  const choice = ppDeferred<boolean>();
  f.runtime.choose.mockImplementationOnce((id: string) => {
    f.events.push(`choose:${id}`);
    return choice.promise;
  });
  ppWatchPicker(f, m);
  for (const key of [
    "connected",
    "can",
    "state",
    "nativePlaybackMode",
    "choose",
  ])
    f.reads.add(key);
  f.events.length = 0;
  const click = m.play().props.onClick();
  const immediate = [...f.events];
  const duplicate = m.play().props.onClick();
  const repeated = f.events.slice(immediate.length);
  choice.resolve(true);
  await click;
  await duplicate;
  ppObserve("picker-double-admission", {
    immediate,
    repeated,
    pending: m.pending(),
    receipt: m.receipt(),
    choose: f.runtime.choose.mock.calls,
  });
});

it.each(["current", "missing-item", "disconnected", "queue-only", "hidden"])(
  "RoomMediaPicker compiled retained click keeps its original %s guard",
  async (variant) => {
    const f = ppFixture(false);
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    const button = m.play();
    if (variant === "current") f.base.state.media_id = "film";
    if (variant === "missing-item") m.browsers[0].items.value = [];
    if (variant === "disconnected") f.base.connected = false;
    if (variant === "queue-only") f.rights.change_media = false;
    if (variant === "hidden") m.props.modelValue = false;
    await ppTicks();
    for (const key of [
      "connected",
      "can",
      "state",
      "nativePlaybackMode",
      "choose",
    ])
      f.reads.add(key);
    f.events.length = 0;
    await button.props.onClick();
    ppObserve(`picker-click-guard-${variant}`, {
      events: [...f.events],
      choose: f.runtime.choose.mock.calls,
      prewarm: f.prewarm.mock.calls.length,
      pending: m.pending(),
      receipt: m.receipt() ?? null,
    });
  },
);

it.each(["mse", "capability", "sdk-sync"])(
  "RoomMediaPicker original prewarm failure boundary at %s remains before pending and try/choose",
  async (variant) => {
    const f = ppFixture();
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    ppActionProbe(f);
    ppWatchPicker(f, m);
    if (variant === "mse")
      vi.stubGlobal("self", {
        get ManagedMediaSource() {
          throw Error("Synchronous MSE getter failure");
        },
      });
    if (variant === "capability")
      f.env.source.isTypeSupported.mockImplementation(() => {
        throw Error("Capability check failure");
      });
    if (variant === "sdk-sync")
      ppSdk.load.mockImplementation(() => {
        throw Error("Synchronous SDK acquisition failure");
      });
    f.events.length = 0;
    let hoverError = "",
      clickError = "";
    try {
      m.play().props.onPointerenter();
    } catch (error) {
      hoverError = (error as Error).message;
    }
    const afterHover = [...f.events];
    f.events.length = 0;
    try {
      await m.play().props.onClick();
    } catch (error) {
      clickError = (error as Error).message;
    }
    await ppTicks();
    ppObserve(`picker-sync-${variant}`, {
      hoverError,
      afterHover,
      clickError,
      events: f.events,
      pending: m.pending(),
      receipt: m.receipt() ?? null,
      closes: m.closed.mock.calls,
      sdk: ppSdk.load.mock.calls.length,
    });
  },
);

it.each(["confirm", "timeout", "reopen-confirm", "reopen-timeout"])(
  "RoomMediaPicker actual choose preserves duplicate guard, dialog scope and exact 10000ms confirmation: %s",
  async (variant) => {
    const f = ppFixture();
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    const calls = ppActionProbe(f);
    await m.play().props.onClick();
    await m.play().props.onClick();
    if (variant.startsWith("reopen")) {
      m.props.modelValue = false;
      await ppTicks();
      m.props.modelValue = true;
      await ppTicks(100);
      await m.play().props.onClick();
    }
    vi.advanceTimersByTime(9999);
    await ppTicks();
    const before = {
      pending: m.pending(),
      receipt: m.receipt(),
      closes: m.closed.mock.calls.length,
    };
    if (variant.endsWith("confirm")) f.confirm("film");
    else vi.advanceTimersByTime(1);
    await ppTicks();
    const after = {
      pending: m.pending(),
      receipt: m.receipt(),
      closes: m.closed.mock.calls.length,
    };
    if (variant.endsWith("confirm")) await m.play().props.onClick();
    ppObserve(`picker-confirmation-${variant}`, {
      before,
      after,
      choose: calls.filter((c) => c.name === "choose").length,
      grants: f.requests.filter((r) => r.path.includes("playback-sessions")),
    });
  },
);

it.each(["account", "room", "role", "guest", "unmount"])(
  "RoomMediaPicker actual pending choose suppresses stale settlement after %s invalidation",
  async (variant) => {
    const f = ppFixture();
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    ppActionProbe(f);
    ppWatchPicker(f, m);
    f.events.length = 0;
    const click = m.play().props.onClick();
    if (variant === "account")
      f.session.accept({
        id: "successor",
        username: "successor",
        csrf: "synthetic-successor",
        admin: false,
      });
    if (variant === "room") f.runtime.room = { ...ppRoom, id: "successor" };
    if (variant === "role")
      f.runtime.state = { ...f.runtime.state, controller_user_id: "successor" };
    if (variant === "guest") f.session.user!.guest = true;
    if (variant === "unmount") m.unmount();
    await click;
    await ppTicks(100);
    vi.advanceTimersByTime(10000);
    await ppTicks();
    ppObserve(`picker-stale-${variant}`, {
      events: f.events,
      pending: m.pending(),
      receipt: m.receipt() ?? null,
      closes: m.closed.mock.calls,
      sdk: ppSdk.load.mock.calls.length,
    });
  },
);

it("RoomsPage same-room prewarm retains its admission even when picker-only conditions are false", async () => {
  const f = ppFixture(false);
  await f.ready("film");
  f.base.state.media_id = "film";
  f.base.connected = f.base.roomActive = false;
  f.rights.change_media = f.rights.queue = false;
  f.session.user!.guest = true;
  for (const key of ["nativePlaybackMode", "connected", "roomActive", "can"])
    f.reads.add(key);
  const m = ppMount(f, "RoomsPage.vue");
  await ppTicks(100);
  const setup = f.events.filter((event) => event.startsWith("read:"));
  f.events.length = 0;
  await m.button("返回房间").props.onClick();
  ppObserve("rooms-own-admission", {
    setup,
    events: f.events,
    sdk: ppSdk.load.mock.calls.length,
    modes: f.prewarm.mock.calls.map((c) => c[1]),
  });
});

it.each(["RoomsPage.vue", "RoomMediaPicker.vue"] as const)(
  "%s consumes an already rejected optional SDK Promise without changing original owner settlement",
  async (name) => {
    const f = ppFixture();
    await f.ready(name === "RoomsPage.vue" ? "film" : "current");
    const m = ppMount(f, name);
    await ppTicks(100);
    ppActionProbe(f);
    ppSdk.load.mockImplementationOnce(() =>
      Promise.reject(Error("Already rejected optional SDK")),
    );
    f.events.length = 0;
    await (
      name === "RoomsPage.vue" ? m.button("返回房间") : m.play()
    ).props.onClick();
    await ppTicks();
    ppObserve(`sdk-rejected-${name}`, {
      events: f.events,
      ownerError: f.runtime.error,
      pageError: name === "RoomsPage.vue" ? m.actions[0].error.value : null,
      receipt: name === "RoomMediaPicker.vue" ? m.receipt() : null,
      sdk: ppSdk.load.mock.calls.length,
    });
  },
);

it.each(["connection", "permission"])(
  "RoomMediaPicker repeats %s admission inside prewarm without adding a new choose guard",
  async (variant) => {
    const f = ppFixture(false);
    await f.ready();
    const m = ppMount(f, "RoomMediaPicker.vue");
    await ppTicks(100);
    const button = m.play();
    let reads = 0,
      armed = false;
    if (variant === "connection")
      Object.defineProperty(f.base, "connected", {
        configurable: true,
        get: () => {
          const allowed = !armed || ++reads === 1;
          f.events.push(`connection:${allowed}`);
          return allowed;
        },
      });
    if (variant === "permission")
      f.base.can = (permission: string) => {
        const allowed =
          !armed || permission !== "change_media" || ++reads === 1;
        f.events.push(`permission:${permission}:${allowed}`);
        return allowed;
      };
    // Establish the synthetic getter while it still admits ordinary render and
    // watcher reads; only the event's nested admission is then staged to differ.
    await ppTicks();
    armed = true;
    f.events.length = 0;
    const click = button.props.onClick();
    const immediate = [...f.events];
    armed = false;
    await click;
    ppObserve(`picker-second-${variant}`, {
      immediate,
      prewarm: f.prewarm.mock.calls.length,
      choose: f.base.choose.mock.calls,
      pending: m.pending(),
      receipt: m.receipt() ?? null,
    });
  },
);

it("RoomsPage synthetic nested getters preserve repeated state/media observation instead of caching the guard value", async () => {
  const f = ppFixture(false);
  await f.ready("film");
  let armed = false,
    stateReads = 0;
  f.base.room = Vue.markRaw({
    ...ppRoom,
    get id() {
      if (armed) f.events.push("room:id");
      return "room";
    },
  });
  f.base.state = Vue.markRaw({
    controller_user_id: "viewer",
    get media_id() {
      const id = armed && ++stateReads === 1 ? "guard-film" : "film";
      if (armed) f.events.push(`state:media:${id}`);
      return id;
    },
  });
  const m = ppMount(f, "RoomsPage.vue");
  await ppTicks(100);
  for (const key of ["room", "state", "nativePlaybackMode", "enter"])
    f.reads.add(key);
  const button = m.button("返回房间");
  armed = true;
  f.events.length = 0;
  const click = button.props.onClick();
  const immediate = [...f.events];
  armed = false;
  await click;
  ppObserve("rooms-nested-getters", {
    immediate,
    selected: f.prewarm.mock.calls.map((c) => c[0]?.id),
    modes: f.prewarm.mock.calls.map((c) => c[1]),
    sdk: ppSdk.load.mock.calls.length,
  });
});

it("RoomMediaPicker synchronous catalog observation failure propagates before original pending/choose", async () => {
  const f = ppFixture();
  await f.ready();
  const m = ppMount(f, "RoomMediaPicker.vue");
  await ppTicks(100);
  const button = m.play();
  const calls = ppActionProbe(f);
  ppWatchPicker(f, m);
  const prior = f.catalog.records;
  const throwing = () =>
    Vue.markRaw({
      get film() {
        f.events.push("catalog:item");
        throw Error("Synchronous item observation failure");
      },
    });
  f.events.length = 0;
  let hoverError = "",
    clickError = "";
  f.catalog.records = throwing() as any;
  try {
    button.props.onFocus();
  } catch (error) {
    hoverError = (error as Error).message;
  }
  f.catalog.records = prior;
  const hover = [...f.events];
  f.events.length = 0;
  f.catalog.records = throwing() as any;
  const click = button.props.onClick();
  f.catalog.records = prior;
  try {
    await click;
  } catch (error) {
    clickError = (error as Error).message;
  }
  await ppTicks();
  ppObserve("picker-catalog-throw", {
    hover,
    hoverError,
    events: f.events,
    clickError,
    calls,
    prewarm: f.prewarm.mock.calls.length,
    pending: m.pending(),
    receipt: m.receipt() ?? null,
    sdk: ppSdk.load.mock.calls.length,
  });
});

// Frozen from exact original 2ffcccf probe-04.log before any production migration.
// Earlier probes are retained externally; this is an immutable caller baseline.
const ppBaseline: Record<string, unknown> = {
  "rooms-actual-pending": {
    immediate: {
      events: ["catalog:room:film", "prewarm:film:auto", "action:before:enter"],
      busy: true,
      error: "",
      roomBusy: false,
      promise: true,
    },
    pending: {
      busy: true,
      pushed: 0,
      hooks: [
        {
          name: "enter",
          sameStore: true,
          args: [
            {
              id: "room",
              name: "Room",
              owner_id: "viewer",
              lifecycle: "active",
            },
          ],
        },
      ],
    },
    settled: {
      events: [
        "catalog:room:film",
        "prewarm:film:auto",
        "action:before:enter",
        "http:playlist:GET",
        "action:after:enter:undefined",
        "router:/rooms/room",
      ],
      busy: false,
      error: "",
      pushed: 1,
    },
    sdkError: "",
    grants: [],
  },
  "rooms-actual-reject": {
    events: [
      "catalog:room:film",
      "prewarm:film:auto",
      "action:before:enter",
      "http:playlist:GET",
      "action:error:enter:Original playlist failure",
    ],
    result: "undefined",
    busy: false,
    error: "Original playlist failure",
    roomBusy: false,
    pushes: [],
  },
  "rooms-actual-intent": {
    events: [
      "catalog:room:film",
      "prewarm:film:auto",
      "action:before:enter",
      "http:playlist:GET",
      "action:after:enter:undefined",
    ],
    result: "undefined",
    busy: false,
    error: "",
    roomBusy: false,
    pushes: [],
  },
  "rooms-actual-unmount": {
    events: [
      "catalog:room:film",
      "prewarm:film:auto",
      "action:before:enter",
      "http:playlist:GET",
      "action:after:enter:undefined",
    ],
    result: "undefined",
    busy: true,
    error: "",
    roomBusy: false,
    pushes: [],
  },
  "rooms-short-same": {
    immediate: [
      "read:room",
      "read:state",
      "read:state",
      "catalog:room:film",
      "read:nativePlaybackMode",
      "prewarm:film:auto",
      "read:enter",
      "enter:room",
    ],
    final: [
      "read:state",
      "read:state",
      "catalog:room:film",
      "read:nativePlaybackMode",
      "prewarm:film:auto",
      "read:enter",
      "enter:room",
      "router:/rooms/room",
    ],
    modeCalls: ["auto"],
    sdk: 1,
  },
  "rooms-short-other": {
    immediate: ["read:room", "read:enter", "enter:room"],
    final: ["read:enter", "enter:room", "router:/rooms/room"],
    modeCalls: [],
    sdk: 0,
  },
  "rooms-short-no-media": {
    immediate: ["read:room", "read:state", "read:enter", "enter:room"],
    final: ["read:state", "read:enter", "enter:room", "router:/rooms/room"],
    modeCalls: [],
    sdk: 0,
  },
  "rooms-short-no-state": {
    immediate: ["read:room", "read:state", "read:enter", "enter:room"],
    final: ["read:state", "read:enter", "enter:room", "router:/rooms/room"],
    modeCalls: [],
    sdk: 0,
  },
  "rooms-short-no-room": {
    immediate: ["read:room", "read:enter", "enter:room"],
    final: ["read:enter", "enter:room", "router:/rooms/room"],
    modeCalls: [],
    sdk: 0,
  },
  "rooms-short-unmounted": { immediate: [], final: [], modeCalls: [], sdk: 0 },
  "rooms-sync-catalog": {
    events: ["catalog:room:film"],
    error: "Synchronous catalog failure",
    busy: false,
    pushes: 0,
    sdk: 0,
  },
  "rooms-sync-mse": {
    events: ["catalog:room:film", "prewarm:film:auto"],
    error: "Synchronous MSE getter failure",
    busy: false,
    pushes: 0,
    sdk: 0,
  },
  "rooms-sync-capability": {
    events: [
      "catalog:room:film",
      "prewarm:film:auto",
      "action:before:enter",
      "http:playlist:GET",
      "action:after:enter:undefined",
      "router:/rooms/room",
    ],
    error: "",
    busy: false,
    pushes: 1,
    sdk: 0,
  },
  "rooms-sync-sdk-sync": {
    events: ["catalog:room:film", "prewarm:film:auto"],
    error: "Synchronous SDK acquisition failure",
    busy: false,
    pushes: 0,
    sdk: 1,
  },
  "rooms-mode-auto": { passed: ["auto"], sdk: 1, fact: "auto" },
  "rooms-mode-native": { passed: ["native"], sdk: 1, fact: "native" },
  "rooms-mode-adaptive": { passed: ["adaptive"], sdk: 0, fact: "adaptive" },
  "rooms-mode-compatibility": {
    passed: ["compatibility"],
    sdk: 0,
    fact: "compatibility",
  },
  "rooms-catalog-stage": {
    events: [
      "catalog:room:film",
      "stage:native",
      "prewarm:film:native",
      "http:playlist:GET",
      "router:/rooms/room",
    ],
    passed: ["native"],
    sdk: 1,
  },
  "picker-actual-success": {
    immediate: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "socket:CHANGE_MEDIA:film",
      ],
      pending: "film",
      receipt: { message: "正在发送播放请求…" },
      promise: true,
      runtimeBusy: false,
    },
    settled: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "socket:CHANGE_MEDIA:film",
        "action:after:choose:true",
        "receipt:已发送播放请求，等待房间确认…",
      ],
      pending: "film",
      receipt: { message: "已发送播放请求，等待房间确认…" },
      closes: [],
      runtimeBusy: false,
      runtimeError: "",
    },
    calls: [{ name: "choose", sameStore: true, args: ["film"] }],
    sdk: 1,
    grants: [],
  },
  "picker-actual-false": {
    immediate: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
      ],
      pending: "film",
      receipt: { message: "正在发送播放请求…" },
      promise: true,
      runtimeBusy: false,
    },
    settled: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "action:after:choose:false",
        "receipt:播放请求未发送，请等待房间连接恢复后再操作",
        "pending:",
      ],
      pending: "",
      receipt: {
        message: "播放请求未发送，请等待房间连接恢复后再操作",
        error: true,
      },
      closes: [],
      runtimeBusy: false,
      runtimeError: "",
    },
    calls: [{ name: "choose", sameStore: true, args: ["film"] }],
    sdk: 1,
    grants: [],
  },
  "picker-actual-sync-confirm": {
    immediate: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "socket:CHANGE_MEDIA:film",
        "receipt:已切换为当前影片",
        "pending:",
        "close:false",
      ],
      pending: "",
      receipt: { message: "已切换为当前影片" },
      promise: true,
      runtimeBusy: false,
    },
    settled: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "socket:CHANGE_MEDIA:film",
        "receipt:已切换为当前影片",
        "pending:",
        "close:false",
        "action:after:choose:true",
        "receipt:已切换为当前影片",
      ],
      pending: "",
      receipt: { message: "已切换为当前影片" },
      closes: [[false]],
      runtimeBusy: false,
      runtimeError: "",
    },
    calls: [{ name: "choose", sameStore: true, args: ["film"] }],
    sdk: 1,
    grants: [],
  },
  "picker-actual-throw": {
    immediate: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "socket:CHANGE_MEDIA:film",
      ],
      pending: "film",
      receipt: { message: "正在发送播放请求…" },
      promise: true,
      runtimeBusy: false,
    },
    settled: {
      events: [
        "prewarm:film:auto",
        "pending:film",
        "receipt:正在发送播放请求…",
        "action:before:choose",
        "socket:CHANGE_MEDIA:film",
        "action:error:choose:Original socket failure",
        "receipt:Original socket failure",
        "pending:",
      ],
      pending: "",
      receipt: { message: "Original socket failure", error: true },
      closes: [],
      runtimeBusy: false,
      runtimeError: "",
    },
    calls: [{ name: "choose", sameStore: true, args: ["film"] }],
    sdk: 1,
    grants: [],
  },
  "picker-hover-allowed": {
    traces: [
      {
        event: "onPointerenter",
        result: "undefined",
        events: [
          "read:connected",
          "read:can",
          "can:change_media",
          "read:nativePlaybackMode",
          "prewarm:film:auto",
        ],
      },
      {
        event: "onFocus",
        result: "undefined",
        events: [
          "read:connected",
          "read:can",
          "can:change_media",
          "read:nativePlaybackMode",
          "prewarm:film:auto",
        ],
      },
    ],
    choose: 0,
    sdk: 2,
    requests: 0,
  },
  "picker-hover-hidden": {
    traces: [
      { event: "onPointerenter", result: "undefined", events: [] },
      { event: "onFocus", result: "undefined", events: [] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-no-user": {
    traces: [
      { event: "onPointerenter", result: "undefined", events: [] },
      { event: "onFocus", result: "undefined", events: [] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-guest": {
    traces: [
      { event: "onPointerenter", result: "undefined", events: [] },
      { event: "onFocus", result: "undefined", events: [] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-no-room": {
    traces: [
      { event: "onPointerenter", result: "undefined", events: [] },
      { event: "onFocus", result: "undefined", events: [] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-inactive": {
    traces: [
      { event: "onPointerenter", result: "undefined", events: [] },
      { event: "onFocus", result: "undefined", events: [] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-disconnected": {
    traces: [
      {
        event: "onPointerenter",
        result: "undefined",
        events: ["read:connected"],
      },
      { event: "onFocus", result: "undefined", events: ["read:connected"] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-queue-only": {
    traces: [
      {
        event: "onPointerenter",
        result: "undefined",
        events: ["read:connected", "read:can", "can:change_media"],
      },
      {
        event: "onFocus",
        result: "undefined",
        events: ["read:connected", "read:can", "can:change_media"],
      },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-no-permission": {
    traces: [
      { event: "onPointerenter", result: "undefined", events: [] },
      { event: "onFocus", result: "undefined", events: [] },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-hover-missing-item": {
    traces: [
      {
        event: "onPointerenter",
        result: "undefined",
        events: [
          "read:connected",
          "read:can",
          "can:change_media",
          "read:nativePlaybackMode",
          "prewarm:undefined:auto",
        ],
      },
      {
        event: "onFocus",
        result: "undefined",
        events: [
          "read:connected",
          "read:can",
          "can:change_media",
          "read:nativePlaybackMode",
          "prewarm:undefined:auto",
        ],
      },
    ],
    choose: 0,
    sdk: 0,
    requests: 0,
  },
  "picker-mode-auto": {
    returns: ["undefined", "undefined"],
    modes: ["auto", "auto"],
    sdk: 2,
    actions: [],
    requests: 0,
    pending: "",
    receipt: null,
  },
  "picker-mode-native": {
    returns: ["undefined", "undefined"],
    modes: ["native", "native"],
    sdk: 2,
    actions: [],
    requests: 0,
    pending: "",
    receipt: null,
  },
  "picker-mode-adaptive": {
    returns: ["undefined", "undefined"],
    modes: ["adaptive", "adaptive"],
    sdk: 0,
    actions: [],
    requests: 0,
    pending: "",
    receipt: null,
  },
  "picker-mode-compatibility": {
    returns: ["undefined", "undefined"],
    modes: ["compatibility", "compatibility"],
    sdk: 0,
    actions: [],
    requests: 0,
    pending: "",
    receipt: null,
  },
  "picker-undefined-mode": {
    modes: ["undefined", "undefined"],
    sdk: 2,
    choose: [["film"]],
    receipt: { message: "已发送播放请求，等待房间确认…" },
  },
  "picker-item-stage": {
    events: ["item:id", "item:id", "prewarm:<accessor>:native"],
    modes: ["native"],
    sameItem: true,
    sdk: 1,
  },
  "picker-double-admission": {
    immediate: [
      "read:connected",
      "read:can",
      "can:change_media",
      "read:state",
      "read:connected",
      "read:can",
      "can:change_media",
      "read:nativePlaybackMode",
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "read:choose",
      "choose:film",
    ],
    repeated: ["read:connected", "read:can", "can:change_media"],
    pending: "film",
    receipt: { message: "已发送播放请求，等待房间确认…" },
    choose: [["film"]],
  },
  "picker-click-guard-current": {
    events: ["read:connected", "read:can", "can:change_media", "read:state"],
    choose: [],
    prewarm: 0,
    pending: "",
    receipt: null,
  },
  "picker-click-guard-missing-item": {
    events: ["read:connected", "read:can", "can:change_media", "read:state"],
    choose: [],
    prewarm: 0,
    pending: "",
    receipt: null,
  },
  "picker-click-guard-disconnected": {
    events: ["read:connected"],
    choose: [],
    prewarm: 0,
    pending: "",
    receipt: null,
  },
  "picker-click-guard-queue-only": {
    events: ["read:connected", "read:can", "can:change_media"],
    choose: [],
    prewarm: 0,
    pending: "",
    receipt: null,
  },
  "picker-click-guard-hidden": {
    events: [],
    choose: [],
    prewarm: 0,
    pending: "",
    receipt: null,
  },
  "picker-sync-mse": {
    hoverError: "Synchronous MSE getter failure",
    afterHover: ["prewarm:film:auto"],
    clickError: "Synchronous MSE getter failure",
    events: ["prewarm:film:auto"],
    pending: "",
    receipt: null,
    closes: [],
    sdk: 0,
  },
  "picker-sync-capability": {
    hoverError: "",
    afterHover: ["prewarm:film:auto"],
    clickError: "",
    events: [
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "action:after:choose:true",
      "receipt:已发送播放请求，等待房间确认…",
    ],
    pending: "film",
    receipt: { message: "已发送播放请求，等待房间确认…" },
    closes: [],
    sdk: 0,
  },
  "picker-sync-sdk-sync": {
    hoverError: "Synchronous SDK acquisition failure",
    afterHover: ["prewarm:film:auto"],
    clickError: "Synchronous SDK acquisition failure",
    events: ["prewarm:film:auto"],
    pending: "",
    receipt: null,
    closes: [],
    sdk: 2,
  },
  "picker-confirmation-confirm": {
    before: {
      pending: "film",
      receipt: { message: "已发送播放请求，等待房间确认…" },
      closes: 0,
    },
    after: { pending: "", receipt: { message: "已切换为当前影片" }, closes: 1 },
    choose: 1,
    grants: [],
  },
  "picker-confirmation-timeout": {
    before: {
      pending: "film",
      receipt: { message: "已发送播放请求，等待房间确认…" },
      closes: 0,
    },
    after: {
      pending: "",
      receipt: {
        message: "播放请求尚未确认，请检查当前影片后再操作",
        error: true,
      },
      closes: 0,
    },
    choose: 1,
    grants: [],
  },
  "picker-confirmation-reopen-confirm": {
    before: {
      pending: "film",
      receipt: { message: "已发送播放请求，等待房间确认…" },
      closes: 0,
    },
    after: { pending: "", receipt: { message: "已切换为当前影片" }, closes: 0 },
    choose: 1,
    grants: [],
  },
  "picker-confirmation-reopen-timeout": {
    before: {
      pending: "film",
      receipt: { message: "已发送播放请求，等待房间确认…" },
      closes: 0,
    },
    after: {
      pending: "",
      receipt: {
        message: "播放请求尚未确认，请检查当前影片后再操作",
        error: true,
      },
      closes: 0,
    },
    choose: 1,
    grants: [],
  },
  "picker-stale-account": {
    events: [
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "pending:",
      "receipt:empty",
      "close:false",
      "action:after:choose:true",
    ],
    pending: "",
    receipt: null,
    closes: [[false]],
    sdk: 1,
  },
  "picker-stale-room": {
    events: [
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "pending:",
      "receipt:empty",
      "close:false",
      "action:after:choose:true",
    ],
    pending: "",
    receipt: null,
    closes: [[false]],
    sdk: 1,
  },
  "picker-stale-role": {
    events: [
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "pending:",
      "receipt:empty",
      "close:false",
      "action:after:choose:true",
    ],
    pending: "",
    receipt: null,
    closes: [[false]],
    sdk: 1,
  },
  "picker-stale-guest": {
    events: [
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "pending:",
      "receipt:empty",
      "close:false",
      "action:after:choose:true",
    ],
    pending: "",
    receipt: null,
    closes: [[false]],
    sdk: 1,
  },
  "picker-stale-unmount": {
    events: [
      "prewarm:film:auto",
      "pending:film",
      "receipt:正在发送播放请求…",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "action:after:choose:true",
    ],
    pending: "film",
    receipt: { message: "正在发送播放请求…" },
    closes: [],
    sdk: 1,
  },
  "rooms-own-admission": {
    setup: [],
    events: [
      "catalog:room:film",
      "read:nativePlaybackMode",
      "prewarm:film:auto",
      "enter:room",
      "router:/rooms/room",
    ],
    sdk: 1,
    modes: ["auto"],
  },
  "sdk-rejected-RoomsPage.vue": {
    events: [
      "catalog:room:film",
      "prewarm:film:auto",
      "action:before:enter",
      "http:playlist:GET",
      "action:after:enter:undefined",
      "router:/rooms/room",
    ],
    ownerError: "",
    pageError: "",
    receipt: null,
    sdk: 1,
  },
  "sdk-rejected-RoomMediaPicker.vue": {
    events: [
      "prewarm:film:auto",
      "action:before:choose",
      "socket:CHANGE_MEDIA:film",
      "action:after:choose:true",
    ],
    ownerError: "",
    pageError: null,
    receipt: { message: "已发送播放请求，等待房间确认…" },
    sdk: 1,
  },
  "picker-second-connection": {
    immediate: [
      "connection:true",
      "can:change_media",
      "connection:false",
      "choose:film",
    ],
    prewarm: 0,
    choose: [["film"]],
    pending: "film",
    receipt: { message: "已发送播放请求，等待房间确认…" },
  },
  "picker-second-permission": {
    immediate: [
      "permission:change_media:true",
      "permission:change_media:false",
      "choose:film",
    ],
    prewarm: 0,
    choose: [["film"]],
    pending: "film",
    receipt: { message: "已发送播放请求，等待房间确认…" },
  },
  "rooms-nested-getters": {
    immediate: [
      "read:room",
      "room:id",
      "read:state",
      "state:media:guard-film",
      "read:state",
      "state:media:film",
      "catalog:room:film",
      "read:nativePlaybackMode",
      "prewarm:film:auto",
      "read:enter",
      "enter:room",
    ],
    selected: ["film"],
    modes: ["auto"],
    sdk: 1,
  },
  "picker-catalog-throw": {
    hover: ["catalog:item"],
    hoverError: "Synchronous item observation failure",
    events: ["catalog:item"],
    clickError: "Synchronous item observation failure",
    calls: [],
    prewarm: 0,
    pending: "",
    receipt: null,
    sdk: 0,
  },
};

// timeline-dev: exact-original caller characterization.
const tlCleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  if (!tlCleanup.length) return;
  for (const cleanup of tlCleanup.splice(0).reverse()) await cleanup();
  await tlTicks(40);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const tlId = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function tlTicks(count = 1) {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
function tlDeferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tlActivity = (n = 3) => ({
  id: tlId(n),
  media_id: tlId(4),
  media_generation: 1,
  lifecycle_epoch: 1,
  versioned: true,
});
const tlComment = (n: number, position: number, activity = tlId(3)) => ({
  id: tlId(n),
  user_id: tlId(1),
  activity_id: activity,
  body: `comment-${n}`,
  username: "viewer",
  display_name: "Viewer",
  created_at: n,
  media_time_ms: position,
  anchor_source: "client_reported",
  deleted: false,
});
function tlEnvironment() {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "performance",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  const effects: string[] = [];
  class Target extends EventTarget {
    constructor(readonly name: string) {
      super();
      Vue.markRaw(this);
    }
    addEventListener(type: string, fn: any, options?: any) {
      effects.push(`listen:${this.name}:${type}`);
      super.addEventListener(type, fn, options);
    }
    removeEventListener(type: string, fn: any, options?: any) {
      effects.push(`unlisten:${this.name}:${type}`);
      super.removeEventListener(type, fn, options);
    }
  }
  class Node extends Target {
    props: Record<string, any> = {};
    children: Node[] = [];
    parent?: Node;
    text = "";
    value: any = "";
    checked = false;
    selected = false;
    selectedIndex = -1;
    multiple = false;
    composing = false;
    style: Record<string, unknown> = {};
    constructor(readonly tag: string) {
      super(tag);
    }
    get tagName() {
      return this.tag.toUpperCase();
    }
    getRootNode(): Node {
      return this.parent?.getRootNode() ?? this;
    }
    get options(): Node[] {
      return this.children.filter((n) => n.tag === "option");
    }
    getAttribute(name: string) {
      return this.props[name] ?? null;
    }
    setAttribute(name: string, value: any) {
      this.props[name] = value;
    }
    removeAttribute(name: string) {
      delete this.props[name];
    }
  }
  const document = Object.assign(new Target("document"), {
    hidden: false,
    visibilityState: "visible",
    activeElement: null,
    querySelector: () => null,
  });
  const window = new Target("window");
  const storage = new Map<string, string>();
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
  }
  for (const [name, value] of Object.entries({
    document,
    window,
    localStorage: store,
    sessionStorage: store,
    navigator: {},
    self: { MediaSource: { isTypeSupported: () => true } },
    location: {
      protocol: "http:",
      host: "localhost",
      origin: "http://localhost",
      href: "http://localhost/rooms/room",
    },
    WebSocket: Socket,
    HTMLElement: Node,
    Element: Node,
    Document: class {},
    ShadowRoot: class {},
  }))
    vi.stubGlobal(name, value);
  return { Node, document, window, effects };
}
type TlEnvironment = ReturnType<typeof tlEnvironment>;
type TlNode = InstanceType<TlEnvironment["Node"]>;

async function tlFixture() {
  const env = tlEnvironment();
  const requests: {
    path: string;
    method: string;
    body: any;
    signal: AbortSignal | undefined;
  }[] = [];
  const http = {
    comments: [tlComment(10, 1000), tlComment(11, 2000), tlComment(12, 3000)],
    response: undefined as ReturnType<typeof tlDeferred<Response>> | undefined,
    failNext: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace(/^\/api\/v1/, "");
      const method = init.method ?? "GET";
      const body =
        init.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({
        path,
        method,
        body,
        signal: init.signal as AbortSignal | undefined,
      });
      if (path.endsWith("/timeline/current"))
        return Response.json({
          activity: tlActivity(),
          can_moderate: false,
          can_assign_moderator: false,
        });
      if (path.endsWith("/timeline/activities"))
        return Response.json({ items: [tlActivity(), tlActivity(5)] });
      if (path.includes("/timeline/messages?") && method === "GET") {
        const activity = new URL(path, "http://localhost").searchParams.get(
          "activity_id",
        )!;
        return Response.json({
          items: http.comments.map((m) => ({ ...m, activity_id: activity })),
          next_before: null,
          next_after: null,
        });
      }
      if (path.includes("/timeline/reactions?"))
        return Response.json({ items: [], server_now_ms: Date.now() });
      if (path.endsWith("/timeline/messages") && method === "POST") {
        if (http.failNext) {
          http.failNext = false;
          throw new Error("synthetic-unconfirmed-send");
        }
        return (
          http.response?.promise ??
          Response.json({
            message: {
              ...tlComment(30, body.media_time_ms ?? 9000, body.activity_id),
              body: body.body,
              anchor_source: body.anchor_source,
            },
          })
        );
      }
      if (path.includes("/media/"))
        return Response.json({ id: tlId(4), title: "Movie", kind: "local" });
      if (path.endsWith("/permissions"))
        return Response.json({ delegated: false, permissions: [] });
      return Response.json([]);
    }),
  );
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.accept({
    id: tlId(1),
    username: "viewer",
    admin: false,
    csrf: "synthetic-page-facts",
  });
  const runtime = useRoomRuntime();
  runtime.room = {
    id: tlId(2),
    name: "Room",
    owner_id: tlId(1),
    lifecycle: "active",
    lifecycle_epoch: 1,
  };
  runtime.state = {
    room_id: tlId(2),
    revision: 1,
    media_id: tlId(4),
    media_generation: 1,
    playback_status: "paused",
    anchor_position_ms: 88000,
    anchor_server_time_ms: 0,
    playback_rate: 1,
    controller_user_id: tlId(1),
    duration_ms: 90000,
    clock_epoch: "clock",
  } as any;
  await tlTicks(40);
  runtime.playbackControls.previewSeek(1.2345);
  const reads: string[] = [];
  // Candidate observation routing only; the actual owner/port stays unchanged.
  const observedControls = new Proxy(runtime.playbackControls, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "position") reads.push(`position:${value}`);
      return value;
    },
  });
  // End candidate observation routing.
  const observed = new Proxy(runtime, {
    get(target, key) {
      if (key === "playbackControls") return observedControls;
      const value = Reflect.get(target, key, target);
      if (key === "position") reads.push(`position:${value}`);
      return value;
    },
  });
  // No real store fields/actions are overwritten. The proxy only records the
  // original getter reads; all mutations use the existing owner/room ports.
  tlCleanup.push(async () => {
    http.response?.resolve(Response.json({ message: tlComment(30, 0) }));
    await runtime.leave();
    disposePinia(pinia);
  });
  requests.length = 0;
  return { env, pinia, runtime, observed, session, reads, requests, http };
}
type TlFixture = Awaited<ReturnType<typeof tlFixture>>;
const tlUrl = new URL(
  "../apps/web/src/features/rooms/TimelineChatPanel.vue",
  import.meta.url,
);
let tlCompiled: string | undefined;
function tlMount(f: TlFixture) {
  if (!tlCompiled) {
    const { descriptor, errors } = parse(readFileSync(tlUrl, "utf8"), {
      filename: fileURLToPath(tlUrl),
    });
    expect(errors).toEqual([]);
    tlCompiled = ts.transpileModule(
      compileScript(descriptor, {
        id: "page-facts-timeline-original",
        inlineTemplate: true,
      }).content,
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      },
    ).outputText;
  }
  const require = (name: string): unknown => {
    if (name === "vue") return Vue;
    if (name === "./room-runtime") return { useRoomRuntime: () => f.observed };
    if (name === "../auth/session.store")
      return { useSession: () => f.session };
    if (name === "./timeline-chat") return timeline;
    if (name === "./timeline-view-state") return timelineView;
    if (name === "../../shared/use-transient-message")
      return { useTransientMessage };
    throw Error(`Unexpected timeline caller import ${name}`);
  };
  const module = { exports: {} as { default: Vue.Component } };
  new Function("require", "module", "exports", tlCompiled)(
    require,
    module,
    module.exports,
  );
  const remove = (node: TlNode) => {
    if (!node.parent) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = undefined;
  };
  const renderer = Vue.createRenderer<TlNode, TlNode>({
    patchProp(node, key, _previous, value) {
      node.props[key] = value;
      if (["value", "checked", "selected", "multiple", "type"].includes(key))
        (node as any)[key] = value;
    },
    insert(node, parent, anchor) {
      remove(node);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node);
      else parent.children.splice(index, 0, node);
    },
    remove,
    createElement: (tag) => new f.env.Node(tag),
    createText: (text) => Object.assign(new f.env.Node("text"), { text }),
    createComment: (text) => Object.assign(new f.env.Node("comment"), { text }),
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
  const props = Vue.reactive({ visible: true });
  const app = renderer.createApp({
    render: () => Vue.h(module.exports.default, props),
  });
  const root = new f.env.Node("root");
  app.mount(root);
  let mounted = true;
  const unmount = () => {
    if (mounted) {
      mounted = false;
      app.unmount();
    }
  };
  tlCleanup.push(unmount);
  const all = (node = root): TlNode[] => [
    node,
    ...node.children.flatMap((child) => all(child)),
  ];
  const text = (node: TlNode): string =>
    node.tag === "comment" ? "" : node.text + node.children.map(text).join("");
  const find = (fn: (node: TlNode) => boolean) => {
    const found = all().find(fn);
    expect(found).toBeDefined();
    return found!;
  };
  const button = (label: string) =>
    find((n) => n.tag === "button" && text(n).trim() === label);
  const click = (node: TlNode) =>
    node.props.onClick({
      target: node,
      preventDefault() {},
      stopPropagation() {},
    });
  const input = () =>
    find((n) => n.tag === "input" && n.props.placeholder === "评论当前画面");
  const type = (value: string) => {
    const node = input();
    node.value = value;
    node.dispatchEvent(new Event("input"));
  };
  const send = () => {
    const form = find((n) => n.tag === "form");
    return form.props.onSubmit({ preventDefault() {}, target: form });
  };
  return {
    root,
    all,
    text,
    find,
    button,
    click,
    input,
    type,
    send,
    props,
    unmount,
    async open() {
      click(button("时间轴评论与表情"));
      await tlTicks(80);
    },
    updatePosition(value: number) {
      f.runtime.playbackControls.previewSeek(value);
    },
  };
}
function tlSetup(f: TlFixture) {
  const m = mountSetup(
    tlUrl,
    {
      document: f.env.document,
      useRoomRuntime: () => f.observed,
      useSession: () => f.session,
      ...timeline,
      ...timelineView,
      useTransientMessage,
    },
    { visible: true },
  );
  tlCleanup.push(m.unmount);
  return m;
}
function tlObserveApi(f: TlFixture) {
  let tick = 0;
  const events: string[] = [];
  const bodies: any[] = [];
  const remove = f.session.$onAction(
    ({ name, args, store, after, onError }) => {
      if (name !== "api" || args[1] !== "POST") return;
      expect(store).toBe(f.session);
      bodies.push(args[2]);
      events.push(`${tick}:before:api:${args[1]}`);
      after(() => events.push(`${tick}:after:api`));
      onError((error) =>
        events.push(`${tick}:error:api:${(error as Error).message}`),
      );
    },
  );
  tlCleanup.push(remove);
  return {
    events,
    bodies,
    record: (label: string) => events.push(`${tick}:${label}`),
    async advance(count: number) {
      for (let index = 0; index < count; index++) {
        ++tick;
        await Promise.resolve();
      }
    },
  };
}

// Recorded from exact-original probe-02 before candidate wiring.
const tlObservedTiming: Record<string, string[]> = {
  resolve: [
    "0:busy:true",
    "0:before:api:POST",
    "0:returned:Promise",
    "8:after:api",
    "10:text:",
    "10:busy:false",
    "11:public:fulfilled",
  ],
  reject: [
    "0:busy:true",
    "0:before:api:POST",
    "0:returned:Promise",
    "5:error:api:synthetic-pending-failure",
    "8:failed:true",
    "8:error:synthetic-pending-failure",
    "8:busy:false",
    "9:public:fulfilled",
  ],
};
const tlObservedStale: Record<string, unknown> = {
  media: {
    aborted: true,
    text: "",
    failed: false,
    busy: false,
    selected: "",
    commentIds: [],
    error: "",
  },
  login: {
    aborted: true,
    text: "",
    failed: false,
    busy: false,
    selected: "",
    commentIds: [],
    error: "",
  },
  lifecycle: {
    aborted: true,
    text: "",
    failed: false,
    busy: false,
    selected: "",
    commentIds: [],
    error: "",
  },
  selection: {
    aborted: false,
    text: "",
    failed: false,
    busy: false,
    selected: "00000000-0000-0000-0000-000000000005",
    commentIds: [
      "00000000-0000-0000-0000-000000000010",
      "00000000-0000-0000-0000-000000000011",
      "00000000-0000-0000-0000-000000000012",
    ],
    error: "",
  },
  hidden: {
    aborted: false,
    text: "",
    failed: false,
    busy: false,
    selected: "00000000-0000-0000-0000-000000000003",
    commentIds: [
      "00000000-0000-0000-0000-000000000010",
      "00000000-0000-0000-0000-000000000011",
      "00000000-0000-0000-0000-000000000012",
      "00000000-0000-0000-0000-000000000030",
    ],
    error: "",
  },
  unmount: {
    aborted: true,
    text: "",
    failed: false,
    busy: false,
    selected: "",
    commentIds: [],
    error: "",
  },
};

it("Timeline original compiled render lazily uses the actual owner seek draft for label and future cutoff", async () => {
  const f = await tlFixture(),
    m = tlMount(f);
  expect(f.reads).toEqual([]);
  await m.open();
  expect(f.reads).toEqual(["position:1.2345"]);
  expect(m.text(m.root)).toContain("当前画面 0:01");
  expect(m.text(m.root)).toContain("comment-10");
  expect(m.text(m.root)).not.toContain("comment-11");
  expect(f.runtime.state!.anchor_position_ms).toBe(88000);
  m.updatePosition(2.0004);
  expect(f.reads).toHaveLength(1);
  await Vue.nextTick();
  expect(f.reads).toEqual(["position:1.2345", "position:2.0004"]);
  expect(m.text(m.root)).toContain("当前画面 0:02");
  expect(m.text(m.root)).toContain("comment-11");
  expect(m.text(m.root)).not.toContain("comment-12");
  m.updatePosition(-1);
  await Vue.nextTick();
  expect(m.text(m.root)).toContain("当前画面 0:00");
  expect(m.text(m.root)).not.toContain("comment-10");
  expect(f.requests.filter((r) => r.method === "POST")).toEqual([]);
});

it("Timeline original historical rendering has independent cutoff and does not consume dirty playback position", async () => {
  const f = await tlFixture(),
    m = tlMount(f);
  await m.open();
  const selection = m.find(
    (n) =>
      n.tag === "select" && n.children.some((c) => c.props.value === tlId(5)),
  );
  selection.props["onUpdate:modelValue"](tlId(5));
  await tlTicks(40);
  const before = f.reads.length;
  m.updatePosition(59);
  await Vue.nextTick();
  expect(f.reads).toHaveLength(before);
  expect(m.text(m.root)).not.toContain("当前画面");
  const cutoff = m.find(
    (n) =>
      n.tag === "input" && n.props.placeholder === "填写此场次已观看的秒数",
  );
  cutoff.props["onUpdate:modelValue"](2);
  await Vue.nextTick();
  expect(m.text(m.root)).toContain("浏览截止 0:02");
  expect(m.text(m.root)).toContain("comment-11");
  expect(m.text(m.root)).not.toContain("comment-12");
  expect(f.reads).toHaveLength(before);
  selection.props["onUpdate:modelValue"](tlId(3));
  await tlTicks(40);
  expect(f.reads.at(-1)).toBe("position:59");
  expect(m.text(m.root)).toContain("当前画面 0:59");
});

it.each([
  [-1, 0],
  [1.2344, 1234],
  [1.2345, 1235],
  [1.9996, 2000],
])(
  "Timeline original first send reads untouched lazy computed at %s seconds",
  async (position, expected) => {
    const f = await tlFixture(),
      m = tlSetup(f),
      c = m.controls;
    f.runtime.playbackControls.previewSeek(position);
    c.current.value = tlActivity();
    c.selected.value = tlId(3);
    c.text.value = "first-frame";
    await tlTicks(20);
    expect(f.reads).toEqual([]);
    const result = c.send();
    expect(result).toBeInstanceOf(Promise);
    expect(f.reads).toEqual([`position:${position}`]);
    const post = f.requests.find((r) => r.method === "POST")!;
    expect(post.body).toMatchObject({
      body: "first-frame",
      anchor_source: "client_reported",
      media_time_ms: expected,
    });
    await result;
    expect(c.failed.value).toBe(false);
    expect(c.text.value).toBe("");
    expect(f.reads).toHaveLength(1);
  },
);

it("Timeline original rendered cached position is reused by the compiled submit handler", async () => {
  const f = await tlFixture(),
    m = tlMount(f);
  await m.open();
  expect(f.reads).toEqual(["position:1.2345"]);
  m.type("cached frame");
  await Vue.nextTick();
  const result = m.send();
  expect(result).toBeInstanceOf(Promise);
  expect(f.reads).toEqual(["position:1.2345"]);
  expect(f.requests.find((r) => r.method === "POST")?.body.media_time_ms).toBe(
    1235,
  );
  await result;
  await Vue.nextTick();
  expect(m.input().value).toBe("");
});

it("Timeline original immediate submit evaluates a dirty computed before its queued render", async () => {
  const f = await tlFixture(),
    m = tlMount(f);
  await m.open();
  m.type("before render");
  await Vue.nextTick();
  m.updatePosition(2.3456);
  expect(f.reads).toEqual(["position:1.2345"]);
  const result = m.send();
  expect(f.reads).toEqual(["position:1.2345", "position:2.3456"]);
  expect(f.requests.find((r) => r.method === "POST")?.body.media_time_ms).toBe(
    2346,
  );
  await result;
  await Vue.nextTick();
  expect(f.reads).toHaveLength(2);
});

it("Timeline original server-received first send omits position and preserves lazy zero reads", async () => {
  const f = await tlFixture(),
    m = tlSetup(f),
    c = m.controls;
  c.current.value = tlActivity();
  c.selected.value = tlId(3);
  c.text.value = "server anchor";
  c.anchor.value = "server_received";
  await tlTicks(20);
  await c.send();
  expect(f.reads).toEqual([]);
  const post = f.requests.find((r) => r.method === "POST")!;
  expect(post.body.anchor_source).toBe("server_received");
  expect("media_time_ms" in post.body).toBe(false);
});

it("Timeline original retry preserves exact pending object and timestamp while rendered position advances", async () => {
  const f = await tlFixture(),
    m = tlMount(f);
  await m.open();
  const probe = tlObserveApi(f);
  f.http.failNext = true;
  m.type("original pending");
  await Vue.nextTick();
  await m.send();
  await Vue.nextTick();
  expect(m.text(m.root)).toContain("synthetic-unconfirmed-send");
  expect(m.button("用原编号重试").props.disabled).toBe(false);
  expect(probe.bodies).toHaveLength(1);
  const pending = probe.bodies[0];
  expect(pending.media_time_ms).toBe(1235);
  m.updatePosition(30);
  await Vue.nextTick();
  expect(m.text(m.root)).toContain("当前画面 0:30");
  const reads = f.reads.length;
  await m.send();
  await Vue.nextTick();
  expect(probe.bodies[1]).toBe(pending);
  expect(probe.bodies[1]).toEqual(pending);
  expect(f.reads).toHaveLength(reads);
  const posts = f.requests.filter((r) => r.method === "POST");
  expect(posts[1].body).toEqual(posts[0].body);
  expect(posts[1].body.media_time_ms).toBe(1235);
  expect(m.input().value).toBe("");
  expect(m.text(m.root)).not.toContain("synthetic-unconfirmed-send");
});

it("Timeline original retry skips a dirty atMs read even before the next display render", async () => {
  const f = await tlFixture(),
    m = tlSetup(f),
    c = m.controls;
  c.current.value = tlActivity();
  c.selected.value = tlId(3);
  c.text.value = "retained";
  await tlTicks(20);
  f.http.failNext = true;
  await c.send();
  const probe = tlObserveApi(f);
  const original = f.requests.find((r) => r.method === "POST")!.body;
  f.runtime.playbackControls.previewSeek(75);
  c.text.value = "synthetic changed draft";
  c.anchor.value = "server_received";
  expect(f.reads).toEqual(["position:1.2345"]);
  await c.send();
  expect(f.reads).toEqual(["position:1.2345"]);
  expect(probe.bodies[0]).toEqual(original);
  expect(probe.bodies[0]).toMatchObject({
    body: "retained",
    media_time_ms: 1235,
    anchor_source: "client_reported",
  });
  expect(c.atMs.value).toBe(75000);
  expect(f.reads).toEqual(["position:1.2345", "position:75"]);
});

it.each(["resolve", "reject"])(
  "Timeline original actual API %s records local busy and Promise settlement",
  async (outcome) => {
    const f = await tlFixture(),
      m = tlSetup(f),
      c = m.controls;
    c.current.value = tlActivity();
    c.selected.value = tlId(3);
    c.text.value = "timing";
    await tlTicks(20);
    f.http.response = tlDeferred<Response>();
    const probe = tlObserveApi(f);
    const stops = [
      Vue.watch(c.busy, (v) => probe.record(`busy:${v}`), { flush: "sync" }),
      Vue.watch(c.error, (v) => probe.record(`error:${v}`), { flush: "sync" }),
      Vue.watch(c.failed, (v) => probe.record(`failed:${v}`), {
        flush: "sync",
      }),
      Vue.watch(c.text, (v) => probe.record(`text:${v}`), { flush: "sync" }),
    ];
    tlCleanup.push(() => stops.forEach((stop) => stop()));
    const result = c.send();
    probe.record("returned:Promise");
    result.then(
      () => probe.record("public:fulfilled"),
      (e: Error) => probe.record(`public:rejected:${e.message}`),
    );
    expect(c.busy.value).toBe(true);
    expect(f.runtime.busy).toBe(false);
    if (outcome === "resolve")
      f.http.response.resolve(
        Response.json({ message: { ...tlComment(30, 1235), body: "timing" } }),
      );
    else f.http.response.reject(new Error("synthetic-pending-failure"));
    await probe.advance(24);
    await result;
    expect(c.busy.value).toBe(false);
    expect(f.runtime.busy).toBe(false);
    expect(probe.events).toEqual(tlObservedTiming[outcome]);
  },
);

it.each(["media", "login", "lifecycle", "selection", "hidden", "unmount"])(
  "Timeline original pending result after %s preserves its actual invalidation boundary",
  async (change) => {
    const f = await tlFixture(),
      m = tlSetup(f),
      c = m.controls;
    c.current.value = tlActivity();
    c.selected.value = tlId(3);
    c.text.value = "original";
    await tlTicks(20);
    f.http.response = tlDeferred<Response>();
    const result = c.send();
    const signal = f.requests.find((r) => r.method === "POST")!.signal!;
    if (change === "media")
      f.runtime.state = { ...f.runtime.state!, media_generation: 2 };
    else if (change === "login")
      f.session.accept({
        id: tlId(8),
        username: "new",
        admin: false,
        csrf: "synthetic-new",
      });
    else if (change === "lifecycle")
      f.runtime.room = { ...f.runtime.room!, lifecycle_epoch: 2 };
    else if (change === "selection") c.selected.value = tlId(5);
    else if (change === "hidden") {
      f.env.document.hidden = true;
      f.env.document.dispatchEvent(new Event("visibilitychange"));
    } else m.unmount();
    await tlTicks(40);
    const aborted = signal.aborted;
    f.http.response.resolve(
      Response.json({ message: { ...tlComment(30, 1235), body: "original" } }),
    );
    await result;
    expect({
      aborted,
      text: c.text.value,
      failed: c.failed.value,
      busy: c.busy.value,
      selected: c.selected.value,
      commentIds: c.comments.value.map((v: any) => v.id),
      error: c.error.value,
    }).toEqual(tlObservedStale[change]);
  },
);

it("Timeline original inactive send guards return a fulfilled Promise before any position/API read", async () => {
  const f = await tlFixture(),
    m = tlSetup(f),
    c = m.controls;
  for (const condition of ["selection", "inactive", "blank", "busy"]) {
    c.current.value = tlActivity();
    c.selected.value = condition === "selection" ? tlId(5) : tlId(3);
    f.runtime.room = {
      ...f.runtime.room!,
      lifecycle: condition === "inactive" ? "closed" : "active",
    };
    c.text.value = condition === "blank" ? "  " : "draft";
    c.busy.value = condition === "busy";
    const result = c.send();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  }
  expect(f.reads).toEqual([]);
  expect(f.requests.filter((r) => r.method === "POST")).toEqual([]);
});

it.each(["prop", "document"])(
  "Timeline original rendered %s hiding pauses polling while the pending send still settles",
  async (boundary) => {
    const f = await tlFixture(),
      m = tlMount(f);
    await m.open();
    m.type("visible submission");
    await Vue.nextTick();
    f.http.response = tlDeferred<Response>();
    const result = m.send();
    const signal = f.requests.find((r) => r.method === "POST")!.signal!;
    if (boundary === "prop") m.props.visible = false;
    else {
      f.env.document.hidden = true;
      f.env.document.dispatchEvent(new Event("visibilitychange"));
    }
    await Vue.nextTick();
    expect(signal.aborted).toBe(false);
    const readCount = f.requests.filter((r) => r.method === "GET").length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.requests.filter((r) => r.method === "GET")).toHaveLength(
      readCount,
    );
    f.http.response.resolve(
      Response.json({
        message: { ...tlComment(30, 1235), body: "visible submission" },
      }),
    );
    await result;
    await Vue.nextTick();
    expect(m.input().value).toBe("");
    expect(m.text(m.root)).toContain("visible submission");
    expect(m.button("发送评论").props.disabled).toBe(true);
  },
);
