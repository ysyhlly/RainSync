import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import * as Vue from "vue";

const playerDirectory = fileURLToPath(
  new URL("../apps/web/src/features/playback/", import.meta.url),
);
const compiled = new Map<string, string>();
const labels = {
  calibrating: "正在重新校准房间时间…",
  catchingUp: "正在追赶房间进度…",
  unsupportedRate: "本地播放器不支持此速率",
  blocked: "等待点击加入播放",
  reconnecting: "正在重连，连接后重新校准…",
};

afterEach(() => vi.unstubAllGlobals());

function fixture(recoveryLabel = "") {
  return Vue.reactive({
    room: { id: "room", name: "放映室" },
    state: { media_id: "movie" as string | null },
    currentTitle: "测试影片",
    subtitles: [],
    connected: true,
    connectionStopped: false,
    owner: true,
    dragging: false,
    waiting: false,
    blocked: false,
    error: "",
    recoveryLabel,
    attach: vi.fn(),
    run: vi.fn(),
    enablePlayback: vi.fn(),
  });
}

/** Compile the real SFCs through the project's existing compiler dependencies.
 * SSR skips mounted browser effects. Only the store, chrome, and unrelated
 * controls are replaced; the Host and Information templates stay intact. */
async function renderPlayer(
  runtime: ReturnType<typeof fixture>,
  options: {
    information?: boolean;
    full?: boolean;
    fullscreen?: boolean;
  } = {},
) {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const noop = () => {};
  const chrome = {
    visible: Vue.ref(false),
    fullscreen: Vue.ref(options.fullscreen ?? false),
    hideCursor: Vue.ref(false),
    activity: noop,
    setMenuOpen: noop,
    setKeyboardFocus: noop,
    setDragging: noop,
    pointerEnter: noop,
    pointerLeave: noop,
    toggleFromSurface: noop,
    setFullscreen: noop,
    setPageHidden: noop,
    dispose: noop,
  };
  const controls = Vue.defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        Vue.h("div", { class: "test-controls" }, slots.default?.()),
  });
  const placeholder = Vue.defineComponent({
    setup: () => () => Vue.h("span"),
  });
  const routerLink = Vue.defineComponent({
    props: ["to"],
    setup:
      (props, { slots }) =>
      () =>
        Vue.h("a", { href: props.to }, slots.default?.()),
  });
  const components = new Map<string, Vue.Component>();
  function load(name: "PlaybackHost.vue" | "PlaybackInformation.vue") {
    const filename = resolve(playerDirectory, name);
    if (components.has(filename)) return components.get(filename)!;
    if (!compiled.has(filename)) {
      const { descriptor, errors } = parse(readFileSync(filename, "utf8"), {
        filename,
      });
      if (errors.length) throw errors[0];
      const script = compileScript(descriptor, {
        id: `recovery-test-${basename(filename)}`,
        inlineTemplate: true,
      });
      compiled.set(
        filename,
        ts.transpileModule(script.content, {
          fileName: filename.replace(/\.vue$/, ".ts"),
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
        }).outputText,
      );
    }
    const require = (specifier: string) => {
      switch (specifier) {
        case "vue":
          return Vue;
        case "../rooms/room-runtime":
          return { useRoomRuntime: () => runtime };
        case "./use-player-chrome":
          return { createPlayerChrome: () => chrome };
        case "./PlaybackInformation.vue":
          return { __esModule: true, default: load("PlaybackInformation.vue") };
        case "./PlaybackControls.vue":
          return { __esModule: true, default: controls };
        case "./PlaybackSettings.vue":
        case "../../shared/ui/AppIcon.vue":
          return { __esModule: true, default: placeholder };
        default:
          throw new Error(`Unexpected player UI test import: ${specifier}`);
      }
    };
    const module = { exports: {} as { default?: Vue.Component } };
    new Function("require", "module", "exports", compiled.get(filename)!)(
      require,
      module,
      module.exports,
    );
    if (!module.exports.default)
      throw new Error(`SFC did not export a component: ${filename}`);
    components.set(filename, module.exports.default);
    return module.exports.default;
  }
  const props = options.information
    ? {
        title: runtime.currentTitle,
        room: runtime.room.name,
        connected: runtime.connected,
        stopped: runtime.connectionStopped,
        owner: runtime.owner,
      }
    : { full: options.full ?? true };
  const app = Vue.createSSRApp(
    load(options.information ? "PlaybackInformation.vue" : "PlaybackHost.vue"),
    props,
  );
  app.component("RouterLink", routerLink);
  return renderToString(app);
}

type RenderedElement = {
  tag: string;
  attributes: Record<string, string>;
  ancestors: RenderedElement[];
  text: string;
  contentStart: number;
};

/** Inspect rendered HTML without adding a DOM package or reproducing templates. */
function elements(html: string) {
  const result: RenderedElement[] = [],
    stack: RenderedElement[] = [];
  const voidTags = new Set(["input", "track", "br", "img"]);
  for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/gi)) {
    const [markup, closing, tag, rawAttributes] = match;
    if (closing) {
      const element = stack.pop();
      if (element?.tag !== tag)
        throw new Error(`Unexpected SSR element nesting at ${markup}`);
      element.text = html
        .slice(element.contentStart, match.index)
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of rawAttributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g))
      attributes[attribute[1]] = attribute[2] ?? "";
    const element: RenderedElement = {
      tag,
      attributes,
      ancestors: [...stack],
      text: "",
      contentStart: match.index! + markup.length,
    };
    result.push(element);
    if (!voidTags.has(tag) && !markup.endsWith("/>")) stack.push(element);
  }
  expect(stack).toHaveLength(0);
  return result;
}
const hasClass = (element: RenderedElement, value: string) =>
  (element.attributes.class ?? "").split(/\s+/).includes(value);

it.each(
  [
    { name: "full player", full: true, fullscreen: false },
    { name: "mini player", full: false, fullscreen: false },
    { name: "fullscreen player", full: true, fullscreen: true },
  ].flatMap((surface) =>
    [labels.calibrating, labels.catchingUp].map((label) => ({
      ...surface,
      label,
    })),
  ),
)("$name keeps $label outside hidden controls", async (surface) => {
  const runtime = fixture(surface.label);
  const tree = elements(await renderPlayer(runtime, surface));
  expect(runtime.attach).not.toHaveBeenCalled();
  const statuses = tree.filter(
    (element) => element.attributes.role === "status",
  );
  expect(statuses).toHaveLength(1);
  expect(statuses[0].text).toBe(surface.label);
  if (!surface.full && !surface.fullscreen) {
    expect(statuses[0].tag).toBe("span");
    expect(hasClass(statuses[0], "buffering")).toBe(false);
    expect(statuses[0].ancestors.some((element) => element.tag === "p")).toBe(
      false,
    );
    expect(
      statuses[0].ancestors.some((element) =>
        hasClass(element, "player-caption"),
      ),
    ).toBe(true);
  } else {
    expect(hasClass(statuses[0], "buffering")).toBe(true);
    expect(
      statuses[0].ancestors.some((element) => hasClass(element, "video-frame")),
    ).toBe(true);
  }
  for (const element of [statuses[0], ...statuses[0].ancestors]) {
    expect(hasClass(element, "player-chrome")).toBe(false);
    expect(hasClass(element, "fullscreen-information")).toBe(false);
    expect(element.attributes["aria-hidden"]).not.toBe("true");
    expect(element.attributes.style ?? "").not.toMatch(/display:\s*none/);
  }
  if (surface.full) {
    const controls = tree.find((element) =>
      hasClass(element, "player-chrome"),
    )!;
    expect(hasClass(controls, "chrome-shown")).toBe(false);
  }
  if (surface.fullscreen) {
    const information = tree.find((element) =>
      hasClass(element, "fullscreen-information"),
    )!;
    expect(hasClass(information, "chrome-shown")).toBe(false);
    expect(
      tree.find(
        (element) =>
          element.attributes["aria-hidden"] === "true" &&
          element.text.includes(surface.label),
      ),
    ).toBeDefined();
  }
});

it("removes both recovery prompt and information copy after the shared label clears", async () => {
  const runtime = fixture(labels.catchingUp);
  expect(await renderPlayer(runtime, { fullscreen: true })).toContain(
    labels.catchingUp,
  );
  runtime.recoveryLabel = "";
  const html = await renderPlayer(runtime, { fullscreen: true });
  expect(
    elements(html).filter((element) => element.attributes.role === "status"),
  ).toHaveLength(0);
  expect(html).not.toContain(labels.catchingUp);
});

it("unsupported rate stays accurate alongside the existing error and autoplay button", async () => {
  const runtime = fixture(labels.unsupportedRate);
  runtime.error = "媒体加载失败，请重试";
  runtime.blocked = true;
  const tree = elements(await renderPlayer(runtime, { fullscreen: true }));
  expect(
    tree
      .filter((element) => element.attributes.role === "status")
      .map((element) => element.text),
  ).toEqual([labels.unsupportedRate]);
  expect(
    tree.find((element) => element.attributes.role === "alert")?.text,
  ).toContain(runtime.error);
  expect(tree.find((element) => hasClass(element, "autoplay"))?.text).toBe(
    "点击加入播放",
  );
});

it("information distinguishes a healthy connection from pending calibration without duplicate live announcements", async () => {
  const runtime = fixture(labels.calibrating);
  const html = await renderPlayer(runtime, { information: true });
  const tree = elements(html);
  expect(
    tree.find((element) => hasClass(element, "connection-status"))?.text,
  ).toBe("房间连接正常");
  const copy = tree.find(
    (element) => element.attributes["aria-hidden"] === "true",
  )!;
  expect(copy.text).toContain(labels.calibrating);
  expect(copy.attributes.role).toBeUndefined();
  expect(copy.attributes["aria-live"]).toBeUndefined();
  expect(
    tree.filter((element) => element.attributes.role === "status"),
  ).toHaveLength(0);
  expect(html).not.toMatch(/已同步|同步完成/);
});

it.each([
  { stopped: false, connection: "正在重连" },
  { stopped: true, connection: "连接已停止" },
])(
  "information preserves $connection separately from recovery",
  async ({ stopped, connection }) => {
    const runtime = fixture(labels.reconnecting);
    runtime.connected = false;
    runtime.connectionStopped = stopped;
    const tree = elements(await renderPlayer(runtime, { information: true }));
    expect(
      tree.find((element) => hasClass(element, "connection-status"))?.text,
    ).toBe(connection);
    expect(
      tree.find((element) => element.attributes["aria-hidden"] === "true")
        ?.text,
    ).toContain(labels.reconnecting);
  },
);

it("keeps the original preparation text and autoplay action when no recovery label is set", async () => {
  const runtime = fixture();
  runtime.waiting = runtime.blocked = true;
  let tree = elements(await renderPlayer(runtime));
  expect(
    tree.find((element) => element.attributes.role === "status")?.text,
  ).toBe("正在准备影片…");
  expect(tree.find((element) => hasClass(element, "autoplay"))?.text).toBe(
    "点击加入播放",
  );
  runtime.recoveryLabel = labels.blocked;
  tree = elements(await renderPlayer(runtime));
  expect(
    tree
      .filter((element) => element.attributes.role === "status")
      .map((element) => element.text),
  ).toEqual([labels.blocked]);
  expect(tree.find((element) => hasClass(element, "autoplay"))?.text).toBe(
    "点击加入播放",
  );
});
