import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import * as Vue from "vue";
import type { MediaTrack } from "../packages/protocol";
import { SubtitleLoadState } from "../apps/web/src/features/playback/subtitle-load-state";
import { useRoomNotice } from "../apps/web/src/features/playback/room-notice";
import { createPlaybackHostPort } from "../apps/web/src/features/playback/playback-host-port";
import {
  describePlaybackPreparation,
  preparationFailure,
  type PlaybackPreparationState,
} from "../apps/web/src/features/playback/playback-preparation";

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
    subtitles: [] as MediaTrack[],
    sessionId: undefined as string | undefined,
    subtitleIndex: undefined as number | undefined,
    connected: true,
    connectionStopped: false,
    owner: true,
    can(_permission: string): boolean {
      return this.owner && this.roomActive;
    },
    roomActive: true,
    preparation: { phase: "idle" } as PlaybackPreparationState,
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
    subtitleFailureIndex?: number;
    shortViewport?: boolean;
  } = {},
) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-height: 500px)" && !!options.shortViewport,
  }));
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
  function load(
    name:
      | "PlaybackHost.vue"
      | "PlaybackInformation.vue"
      | "PlaybackPreparation.vue"
      | "PlaybackStartupDiagnostics.vue",
  ) {
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
        case "./room-notice":
          return { useRoomNotice };
        case "./subtitle-load-state":
          return {
            SubtitleLoadState: class extends SubtitleLoadState {
              sync(...args: Parameters<SubtitleLoadState["sync"]>) {
                const resources = super.sync(...args);
                const failed = resources.find(
                  (resource) => resource.index === options.subtitleFailureIndex,
                );
                if (failed) this.settle(failed, 3);
                return resources;
              }
            },
          };
        case "./PlaybackInformation.vue":
          return { __esModule: true, default: load("PlaybackInformation.vue") };
        case "./PlaybackPreparation.vue":
          return { __esModule: true, default: load("PlaybackPreparation.vue") };
        case "./PlaybackStartupDiagnostics.vue":
          return {
            __esModule: true,
            default: load("PlaybackStartupDiagnostics.vue"),
          };
        case "./playback-preparation":
          return { describePlaybackPreparation };
        case "./PlaybackControls.vue":
          return { __esModule: true, default: controls };
        case "./PlaybackSettings.vue":
        case "./PlatformDanmaku.vue":
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
  type HostContext = Parameters<typeof createPlaybackHostPort>[0];
  const raw = runtime as unknown as Record<string, any>;
  const required = (name: string) => () => { throw Error(`Unexpected ${name} in recovery SSR fixture`); };
  const hostPort = createPlaybackHostPort({
    timeline: Object.fromEntries(["room", "state", "connected", "connectionStopped", "roomActive", "currentTitle"].map(key => [key, Vue.toRef(raw, key)])) as HostContext["timeline"],
    playback: Object.fromEntries(["waiting", "blocked", "dragging", "duration", "live", "nativePlatform", "platformDanmakuEnabled", "platformDanmakuCues", "subtitles", "subtitleIndex", "sessionId", "preparation", "loadingStage", "startupDiagnostics", "recoveryState", "recoveryLabel"].map(key => [key, Vue.toRef(raw, key)])) as HostContext["playback"],
    notice: { error: Vue.toRef(raw, "error"), errorNotice: Vue.toRef(raw, "errorNotice") },
    actions: {
      can: permission => runtime.can(permission),
      attach: runtime.attach,
      enablePlayback: runtime.enablePlayback,
      runPlayback: required("runPlayback"), loadMedia: required("loadMedia"),
      cancelPreparation: required("cancelPreparation"), applySubtitles: required("applySubtitles"), send: required("send"),
      dismissError: () => { runtime.error = ""; },
    },
    playbackControls: raw.playbackControls, playbackSettings: raw.playbackSettings,
  });
  const props = options.information
    ? {
        information: hostPort.information,
        title: runtime.currentTitle,
        room: runtime.room.name,
        connected: runtime.connected,
        stopped: runtime.connectionStopped,
        owner: runtime.owner,
      }
    : { playback: hostPort, full: options.full ?? true };
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

it.each(
  [
    { name: "full", full: true, fullscreen: false },
    { name: "mini", full: false, fullscreen: false },
    { name: "fullscreen", full: true, fullscreen: true },
  ].flatMap((surface) =>
    [
      { phase: "queued", label: "正在排队" },
      { phase: "transcoding", label: "正在转码" },
      { phase: "cancelled", label: "播放准备已取消" },
      { phase: "failed", label: "播放失败" },
    ].map((status) => ({ ...surface, ...status })),
  ),
)(
  "$name exposes exactly one $phase announcement outside hidden controls",
  async (surface) => {
    const runtime = fixture(labels.catchingUp);
    runtime.preparation = {
      phase: surface.phase as PlaybackPreparationState["phase"],
      failure:
        surface.phase === "failed"
          ? { message: "媒体处理失败", retryable: true }
          : undefined,
    };
    const html = await renderPlayer(runtime, surface);
    const tree = elements(html);
    const announcements = tree.filter((element) =>
      ["status", "alert"].includes(element.attributes.role),
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0].text).toContain(surface.label);
    for (const element of [announcements[0], ...announcements[0].ancestors]) {
      expect(hasClass(element, "player-chrome")).toBe(false);
      expect(element.attributes.style ?? "").not.toMatch(/display:\s*none/);
    }
    const buttons = tree
      .filter((element) => element.tag === "button")
      .map((element) => element.text);
    expect(buttons).toContain(
      surface.phase === "queued" || surface.phase === "transcoding"
        ? "取消准备"
        : "重新发起播放",
    );
    expect(html).not.toMatch(/role="progressbar"|\d+%|预计完成/);
  },
);

it("shows diagnostics and server retry advice, and blocks retry without server authority or a connection", async () => {
  const runtime = fixture();
  runtime.preparation = {
    phase: "failed",
    failure: {
      message: "当前账号没有播放权限",
      retryable: false,
      requestId: "00000000-0000-4000-8000-000000000000",
      retryAfterMs: 3200,
    },
  };
  let html = await renderPlayer(runtime);
  expect(html).toContain("诊断编号");
  expect(html).toContain("等待 4 秒");
  expect(html).not.toContain("重新发起播放");
  runtime.preparation.failure!.retryable = true;
  runtime.connected = false;
  html = await renderPlayer(runtime);
  const retry = elements(html).find(
    (element) => element.tag === "button" && element.text === "重新发起播放",
  );
  expect(retry?.attributes).toHaveProperty("disabled");
});

it("only describes playable resources while the browser is still loading them", async () => {
  const runtime = fixture();
  runtime.preparation = { phase: "ready" };
  runtime.waiting = true;
  let html = await renderPlayer(runtime);
  expect(html).toContain("可播放");
  expect(html).toContain("画面仍需由播放器加载");
  runtime.waiting = false;
  html = await renderPlayer(runtime);
  expect(
    elements(html).filter((element) => element.attributes.role === "status"),
  ).toHaveLength(0);
});

it("fullscreen preparation failures replace their own generic error banner with one safe alert", async () => {
  const runtime = fixture();
  runtime.error = "https://private.invalid/media?token=secret";
  runtime.preparation = {
    phase: "failed",
    failure: {
      ...preparationFailure(new Error(runtime.error)),
      message: "媒体处理失败，请稍后重试。",
    },
  };
  const html = await renderPlayer(runtime, { fullscreen: true });
  expect(
    elements(html).filter((element) => element.attributes.role === "alert"),
  ).toHaveLength(1);
  expect(html).toContain("媒体处理失败");
  expect(html).not.toContain("token=secret");
});

it("fullscreen keeps an unrelated room error alongside a playback preparation failure", async () => {
  const runtime = fixture();
  runtime.error = "房间连接已停止，请重新加入";
  runtime.preparation = {
    phase: "failed",
    failure: preparationFailure(new TypeError("Failed to fetch playback")),
  };
  const alerts = elements(
    await renderPlayer(runtime, { fullscreen: true }),
  ).filter((element) => element.attributes.role === "alert");
  expect(alerts).toHaveLength(2);
  expect(alerts[0].text).toContain(runtime.preparation.failure!.message);
  expect(alerts[1].text).toContain(runtime.error);
  expect(alerts[1].text).toContain("关闭提示");
});

it.each([
  { full: true, fullscreen: false },
  { full: false, fullscreen: false },
  { full: true, fullscreen: true },
])(
  "offers subtitle-only recovery in the real player template: %j",
  async (options) => {
    const runtime = fixture();
    runtime.sessionId = "plan-a";
    runtime.subtitles = [
      {
        index: 31,
        label: "中文 <img src=x>",
        language: "zho",
        url: "/authorized.vtt?ticket=opaque",
      },
      { index: 17, label: "无交付路线", language: "eng", url: null },
    ];
    runtime.subtitleIndex = 31;
    const html = await renderPlayer(runtime, {
      ...options,
      subtitleFailureIndex: 31,
    });
    const tree = elements(html);
    const failure = tree.find((element) => hasClass(element, "subtitle-error"));
    expect(failure?.attributes.role).toBe("alert");
    expect(failure?.text).toContain("加载失败");
    expect(failure?.text).not.toContain("ticket=opaque");
    expect(tree.filter((element) => element.tag === "track")).toHaveLength(1);
    expect(tree.filter((element) => element.tag === "img")).toHaveLength(0);
    expect(html).toContain("中文 &lt;img src=x&gt;");
    expect(
      tree.find(
        (element) => element.tag === "button" && element.text === "重试字幕",
      ),
    ).toBeDefined();
    expect(
      tree.find(
        (element) => element.tag === "button" && element.text === "关闭字幕",
      ),
    ).toBeDefined();
    runtime.subtitleIndex = undefined;
    const closed = await renderPlayer(runtime, {
      ...options,
      subtitleFailureIndex: 31,
    });
    expect(closed).not.toContain("重试字幕");
    expect(closed).not.toContain("关闭字幕");
  },
);

it("a moderator with only pause permission is described as able to control playback", async () => {
  const runtime = fixture();
  runtime.owner = false;
  runtime.can = (permission: string) => permission === "pause";
  const html = await renderPlayer(runtime, { fullscreen: true });
  expect(html).toContain("你可以控制房间播放。");
  runtime.can = () => false;
  expect(await renderPlayer(runtime, { fullscreen: true })).toContain(
    "观看者 · 播放由房间控制者同步。",
  );
});

it.each([
  "preparing",
  "queued",
  "transcoding",
  "cancelling",
  "cancelled",
  "failed",
] as const)(
  "collapsed mini keeps the shared %s preparation feedback outside playback controls",
  async (phase) => {
    const runtime = fixture(labels.catchingUp);
    runtime.preparation = {
      phase,
      failure:
        phase === "failed"
          ? { message: "处理失败", retryable: true }
          : undefined,
    };
    const html = await renderPlayer(runtime, {
      full: false,
      shortViewport: true,
    });
    const tree = elements(html);
    const announcements = tree.filter((element) =>
      ["status", "alert"].includes(element.attributes.role),
    );
    expect(announcements).toHaveLength(1);
    expect(announcements[0].text).toContain(
      describePlaybackPreparation(runtime.preparation).label,
    );
    expect(
      announcements[0].ancestors.some((element) =>
        hasClass(element, "player-caption"),
      ),
    ).toBe(true);
    const buttons = tree
      .filter((element) => element.tag === "button")
      .map((element) => element.text);
    expect(buttons.includes("取消准备")).toBe(
      ["preparing", "queued", "transcoding"].includes(phase),
    );
    expect(html).toContain("mini-collapsed");
    expect(tree.filter((element) => element.tag === "video")).toHaveLength(1);
  },
);

it("only a connected empty room without an active task uses the compact return presentation", async () => {
  const runtime = fixture();
  runtime.state.media_id = null;
  let tree = elements(await renderPlayer(runtime, { full: false }));
  expect(hasClass(tree[0], "empty-room")).toBe(true);
  expect(tree.filter((element) => element.tag === "video")).toHaveLength(1);
  expect(tree.some((element) => element.text === "返回房间")).toBe(true);
  runtime.preparation = { phase: "cancelling" };
  tree = elements(await renderPlayer(runtime, { full: false }));
  expect(hasClass(tree[0], "empty-room")).toBe(false);
  expect(
    tree.some((element) => element.text.includes("正在取消播放准备")),
  ).toBe(true);
  runtime.preparation = { phase: "idle" };
  runtime.connected = false;
  tree = elements(await renderPlayer(runtime, { full: false }));
  expect(hasClass(tree[0], "empty-room")).toBe(false);
});
