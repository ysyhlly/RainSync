import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { formatTime } from "../apps/web/src/shared/use-action";
import type { PlaybackControlsPort } from "../apps/web/src/features/playback/playback-controls-port";

type Node = {
  tag: string;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
  text?: string;
};
const stops: (() => void)[] = [];
afterEach(() =>
  stops
    .splice(0)
    .reverse()
    .forEach((stop) => stop()),
);
const source = readFileSync(
  new URL(
    "../apps/web/src/features/playback/PlaybackControls.vue",
    import.meta.url,
  ),
  "utf8",
);
const script = compileScript(parse(source).descriptor, {
  id: "controls-port-caller",
  inlineTemplate: true,
});
const compiled = ts.transpileModule(script.content, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;

function fixture() {
  const events: [string, unknown][] = [];
  const raw = Vue.reactive({
    state: {
      media_id: "movie" as string | null,
      playback_status: "paused" as "paused" | "playing",
      playback_rate: 1,
    },
    connected: true,
    duration: 120,
    position: 10,
    dragging: false,
    live: false,
    preparation: { phase: "idle" as "idle" | "failed" },
    loadingStage: "playing" as "playing" | "loading_media",
    video: { volume: 1, muted: false } as
      { volume: number; muted: boolean } | undefined,
    permissions: { play: true, pause: true, seek: true, set_rate: true },
    can(permission: "play" | "pause" | "seek" | "set_rate") {
      return raw.permissions[permission];
    },
    send: vi.fn((type: string, payload?: unknown) => {
      events.push([type, payload]);
      return true;
    }),
    seek(event: Event) {
      raw.position = Number((event.target as HTMLInputElement).value);
      raw.dragging = false;
      raw.send("SEEK", { position_ms: raw.position * 1000 });
    },
  });
  // Test-only adapter permits the identical real-SFC caller cases to run on
  // the old store wiring and the new prop wiring. The production port and
  // actual command owner are covered separately in playback-controls-port.
  const port: PlaybackControlsPort = {
    get state() {
      return raw.state;
    },
    get connected() {
      return raw.connected;
    },
    get duration() {
      return raw.duration;
    },
    get position() {
      return raw.position;
    },
    get dragging() {
      return raw.dragging;
    },
    get live() {
      return raw.live;
    },
    get preparationPhase() {
      return raw.preparation.phase;
    },
    get loadingStage() {
      return raw.loadingStage;
    },
    can: raw.can,
    togglePlayback: () =>
      raw.send(raw.state.playback_status === "playing" ? "PAUSE" : "PLAY"),
    setRate: (rate) => raw.send("SET_RATE", { rate }),
    seek: raw.seek,
    setDragging: (value) => {
      raw.dragging = value;
    },
    previewSeek: (value) => {
      raw.position = value;
    },
    setLocalVolume: (value) => {
      if (raw.video) raw.video.volume = value;
    },
    setLocalMuted: (value) => {
      if (raw.video) raw.video.muted = value;
    },
  };
  return { raw, port, events };
}
function mountControls(
  f: ReturnType<typeof fixture>,
  props: Record<string, unknown> = {},
) {
  const select = Vue.defineComponent({
    props: ["modelValue", "label", "disabled"],
    emits: ["change", "open-change"],
    setup:
      (p, { emit }) =>
      () =>
        Vue.h("select", {
          "aria-label": p.label,
          disabled: p.disabled,
          value: p.modelValue,
          onChange: (value: number) => emit("change", value),
        }),
  });
  const icon = Vue.defineComponent({ setup: () => () => Vue.h("i") });
  const module = { exports: {} as { default: Vue.Component } };
  const require = (name: string) => {
    if (name === "vue") return Vue;
    if (name === "../rooms/room-runtime")
      return { useRoomRuntime: () => f.raw };
    if (name === "../../shared/use-action") return { formatTime };
    if (name === "../../shared/ui/AppSelect.vue")
      return { __esModule: true, default: select };
    if (name === "../../shared/ui/AppIcon.vue")
      return { __esModule: true, default: icon };
    throw Error(`Unexpected controls import: ${name}`);
  };
  new Function("require", "module", "exports", compiled)(
    require,
    module,
    module.exports,
  );
  const node = (tag: string): Node => ({ tag, props: {}, children: [] });
  const remove = (item: Node) => {
    if (item.parent) {
      const siblings = item.parent.children,
        index = siblings.indexOf(item);
      if (index >= 0) siblings.splice(index, 1);
      item.parent = undefined;
    }
  };
  const renderer = Vue.createRenderer<Node, Node>({
    patchProp(item, key, _old, value) {
      item.props[key] = value;
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
    createText: (text) => ({ ...node("text"), text }),
    createComment: (text) => ({ ...node("comment"), text }),
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
  const currentProps = Vue.shallowReactive({ controls: f.port, ...props });
  const app = renderer.createApp({
    render: () => Vue.h(module.exports.default, currentProps),
  });
  const root = node("root");
  app.mount(root);
  stops.push(() => app.unmount());
  function all(item = root): Node[] {
    return [item, ...item.children.flatMap((child) => all(child))];
  }
  function get(label: string) {
    const found = all().find((item) => item.props["aria-label"] === label);
    expect(found, label).toBeDefined();
    return found!;
  }
  return {
    get,
    all,
    setPort: (port: PlaybackControlsPort) => {
      currentProps.controls = port;
    },
  };
}

it("controls preserve local volume and mute independently of room controls", async () => {
  const f = fixture();
  f.raw.connected = false;
  f.raw.permissions.play = f.raw.permissions.pause = false;
  const m = mountControls(f),
    element = f.raw.video!;
  m.get("本机音量").props.onInput({ target: { value: "0.35" } });
  m.get("本机静音").props.onClick();
  await Vue.nextTick();
  expect(element.volume).toBe(0.35);
  expect(element.muted).toBe(true);
  expect(m.get("取消本机静音").props["aria-pressed"]).toBe(true);
  expect(f.events).toEqual([]);
});

it("controls preserve no-element audio preferences and use the later current element", async () => {
  const f = fixture();
  const old = f.raw.video!;
  f.raw.video = undefined;
  const m = mountControls(f);
  m.get("本机音量").props.onInput({ target: { value: "0.4" } });
  m.get("本机静音").props.onClick();
  await Vue.nextTick();
  expect(old).toEqual({ volume: 1, muted: false });
  f.raw.video = { volume: 1, muted: true };
  m.get("本机音量").props.onInput({ target: { value: "0.2" } });
  m.get("取消本机静音").props.onClick();
  expect(f.raw.video).toEqual({ volume: 0.2, muted: false });
  expect(old).toEqual({ volume: 1, muted: false });
  expect(f.events).toEqual([]);
});

it("controls preserve pointer capture, draft input, seek commit and release order", () => {
  const f = fixture(),
    order: string[] = [];
  const m = mountControls(f, {
    onDragging: (value: boolean) => order.push(`emit:${value}`),
  });
  stops.push(
    Vue.watch(
      () => f.raw.dragging,
      (value) => order.push(`drag:${value}`),
      { flush: "sync" },
    ),
  );
  stops.push(
    Vue.watch(
      () => f.raw.position,
      (value) => order.push(`position:${value}`),
      { flush: "sync" },
    ),
  );
  const seek = m.get("房间播放进度");
  seek.props.onPointerdown({
    pointerId: 7,
    target: { setPointerCapture: (id: number) => order.push(`capture:${id}`) },
  });
  expect(order).toEqual(["capture:7", "drag:true", "emit:true"]);
  seek.props.onPointercancel();
  order.length = 0;
  seek.props.onInput({
    target: {
      get value() {
        order.push(`read:${f.raw.dragging}`);
        return "25";
      },
    },
  });
  expect(order).toEqual(["drag:true", "read:true", "position:25"]);
  f.raw.send.mockImplementation((type, payload) => {
    order.push(`send:${f.raw.position}:${f.raw.dragging}`);
    f.events.push([type, payload]);
    return true;
  });
  order.length = 0;
  seek.props.onChange({ target: { value: "30" } });
  expect(order).toEqual(["position:30", "drag:false", "send:30:false"]);
  expect(f.events).toEqual([["SEEK", { position_ms: 30000 }]]);
  for (const name of ["onPointerup", "onPointercancel", "onBlur"]) {
    f.raw.dragging = true;
    order.length = 0;
    seek.props[name]();
    expect(order).toEqual(["drag:false", "emit:false"]);
  }
  expect(f.events).toHaveLength(1);
});

it("controls preserve current-status play/pause and unmodified rate commands", async () => {
  const f = fixture(),
    m = mountControls(f),
    captured = m.get("播放房间").props.onClick;
  f.raw.state.playback_status = "playing";
  f.raw.permissions.play = false;
  await Vue.nextTick();
  expect(m.get("暂停房间播放").props.disabled).toBe(false);
  captured();
  m.get("房间倍速").props.onChange(1.5);
  expect(f.events).toEqual([
    ["PAUSE", undefined],
    ["SET_RATE", { rate: 1.5 }],
  ]);
  f.raw.connected = false;
  await Vue.nextTick();
  expect(m.get("暂停房间播放").props.disabled).toBe(true);
  expect(m.get("房间播放进度").props.disabled).toBe(true);
});

it("controls preserve live, unknown-duration and unavailable-local presentation", async () => {
  const f = fixture();
  f.raw.duration = 0;
  f.raw.loadingStage = "loading_media";
  f.raw.preparation.phase = "failed";
  const m = mountControls(f);
  expect(m.get("房间播放进度").props.disabled).toBe(true);
  expect(m.get("播放房间").props.disabled).toBe(false);
  expect(m.get("播放房间").props.title).toContain("本机播放尚未就绪");
  f.raw.live = true;
  await Vue.nextTick();
  expect(
    m.all().some((item) => item.props["aria-label"] === "房间播放进度"),
  ).toBe(false);
  expect(m.all().some((item) => item.props["aria-label"] === "房间倍速")).toBe(
    false,
  );
});

it("controls follow a replacement port even from an earlier rendered callback", async () => {
  const first = fixture(),
    second = fixture();
  second.raw.state.playback_status = "playing";
  const m = mountControls(first),
    oldCallback = m.get("播放房间").props.onClick;
  m.setPort(second.port);
  await Vue.nextTick();
  oldCallback();
  expect(first.events).toEqual([]);
  expect(second.events).toEqual([["PAUSE", undefined]]);
});
