import { createPlaybackSettingsPort } from "../apps/web/src/features/playback/playback-settings-port";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { compileScript, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import * as Vue from "vue";
import * as selections from "../apps/web/src/features/playback/playback-selections";

const directory = fileURLToPath(
  new URL("../apps/web/src/features/playback/", import.meta.url),
);
const compiled = new Map<string, string>();
afterEach(() => vi.unstubAllGlobals());

async function renderSettings(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("document", {
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  const runtime = Vue.reactive({
    state: { media_id: "movie" },
    nativePlatform: true,
    live: true,
    platformTextLive: true,
    nativeQualityOptions: [],
    platformSubtitleTracks: [],
    platformSubtitleId: null,
    platformSubtitleStatus: "none",
    platformDanmakuStatus: "unsupported",
    platformDanmakuEnabled: false,
    platformTextError: "",
    tracks: [],
    subtitles: [],
    ...overrides,
  });
  const select = Vue.defineComponent({
    props: ["options", "label", "disabled"],
    setup: (props) => () =>
      Vue.h(
        "select",
        { "aria-label": props.label, disabled: props.disabled },
        (props.options ?? []).map((option: { label: string; value: unknown }) =>
          Vue.h("option", { value: option.value }, option.label),
        ),
      ),
  });
  const placeholder = Vue.defineComponent({ setup: () => () => Vue.h("span") });
  const loaded = new Map<string, Vue.Component>();
  function load(name: string): Vue.Component {
    if (loaded.has(name)) return loaded.get(name)!;
    const filename = resolve(directory, name);
    if (!compiled.has(name)) {
      const { descriptor, errors } = parse(readFileSync(filename, "utf8"), {
        filename,
      });
      if (errors.length) throw errors[0];
      const source = compileScript(descriptor, {
        id: `settings-wiring-${basename(name)}`,
        inlineTemplate: true,
      });
      compiled.set(
        name,
        ts.transpileModule(source.content, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
          },
        }).outputText,
      );
    }
    const require = (specifier: string) => {
      if (specifier === "vue") return Vue;
      if (specifier === "./playback-selections") return selections;
      if (
        specifier === "./PlatformTextSettings.vue" ||
        specifier === "./PlaybackSelections.vue" ||
        specifier === "./PlaybackStartupDiagnostics.vue"
      )
        return { __esModule: true, default: load(specifier.slice(2)) };
      if (specifier === "../../shared/ui/AppSelect.vue")
        return { __esModule: true, default: select };
      if (specifier.endsWith(".vue"))
        return { __esModule: true, default: placeholder };
      throw Error(`Unexpected settings import: ${specifier}`);
    };
    const module = { exports: {} as { default: Vue.Component } };
    new Function("require", "module", "exports", compiled.get(name)!)(
      require,
      module,
      module.exports,
    );
    loaded.set(name, module.exports.default);
    return module.exports.default;
  }
  const settings = createPlaybackSettingsPort({
    playback: new Proxy(
      {},
      {
        get: (_target, key) =>
          Vue.toRef(runtime as Record<string, any>, key as string),
      },
    ) as Parameters<typeof createPlaybackSettingsPort>[0]["playback"],
    actions: runtime as any,
    hasMedia: () => !!runtime.state?.media_id,
  });
  return renderToString(
    Vue.createSSRApp(load("PlaybackSettings.vue"), { active: true, settings }),
  );
}

it("mounts observed CEA subtitle choices in the real live settings parent", async () => {
  const html = await renderSettings({
    platformSubtitleStatus: "available",
    platformSubtitleTracks: [
      { id: "cea-en", label: "English CC", language: "en", automatic: false },
    ],
  });
  expect(html).toContain("已观察到的直播内嵌字幕");
  expect(html).toContain("English CC (en)");
  expect(html).toMatch(/<select aria-label="平台字幕语言">/);
  expect(html).not.toContain("当前直播源尚未观察到");
});

it.each(["none", "unsupported"])(
  "a live %s status cannot invent a subtitle choice",
  async (platformSubtitleStatus) => {
    const html = await renderSettings({ platformSubtitleStatus });
    expect(html).toContain("当前直播源尚未观察到带时间的内嵌字幕");
    expect(html).toMatch(/<select aria-label="平台字幕语言" disabled>/);
    expect(html).not.toContain("English CC");
  },
);

it("ordinary playback does not contradict its separately supplied HLS quality controls", async () => {
  const html = await renderSettings({
    nativePlatform: false,
    live: false,
    platformTextLive: false,
  });
  expect(html).toContain("清晰度切换仅在当前方案提供可选档位时显示");
  expect(html).not.toContain("当前方案不提供画质切换");
});
