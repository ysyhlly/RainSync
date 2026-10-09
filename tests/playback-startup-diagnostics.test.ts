import { createPlaybackSettingsPort } from "../apps/web/src/features/playback/playback-settings-port";
import { readFileSync } from "node:fs";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import * as SSR from "@vue/server-renderer";
import { afterEach, expect, it, vi } from "vitest";

/** Render the actual SFC templates: no duplicated formatter or fake markup. */
function component(file: string, imports: Record<string, unknown> = {}) {
  const descriptor = parse(
    readFileSync(
      new URL(`../apps/web/src/features/playback/${file}`, import.meta.url),
      "utf8",
    ),
  ).descriptor;
  const script = compileScript(descriptor, {
    id: file,
    inlineTemplate: true,
    templateOptions: { ssr: true },
  }).content;
  const js = ts
    .transpileModule(script, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/import[\s\S]*?from\s+["'][^"']+["'];?\s*/g, "")
    .replace("export default", "return");
  const bindings = {
    ...Object.fromEntries(
      Object.entries(Vue).filter(
        ([key]) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== "default",
      ),
    ),
    ...Object.fromEntries(
      Object.entries(Vue)
        .filter(([key]) => /^[A-Za-z_$][\w$]*$/.test(key))
        .map(([key, value]) => [`_${key}`, value]),
    ),
    ...Object.fromEntries(
      Object.entries(SSR).map(([key, value]) => [`_${key}`, value]),
    ),
    ...imports,
  };
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const diagnostics = component("PlaybackStartupDiagnostics.vue");
const render = (props: object) =>
  SSR.renderToString(Vue.createSSRApp(diagnostics, props));
const snapshot = (evidence?: string) => ({
  source: "client_reported",
  startup_phases: {
    preparation_ms: 1200,
    loading_ms: 2300,
    unobserved_ms: 400,
  },
  ...(evidence
    ? {
        first_frame: { elapsed_ms: 3500, confirmed_elapsed_ms: 3600, evidence },
      }
    : {}),
});
afterEach(() => vi.unstubAllGlobals());
it("keeps the folded entry visible before sampling and never invents a zero first frame", async () => {
  const html = await render({});
  expect(html).toContain("播放耗时");
  expect(html).toContain("暂无本地耗时观测");
  expect(html).not.toContain("0.0 秒");
  const pending = await render({ diagnostics: snapshot() });
  expect(pending).toContain("尚未确认");
  expect(pending).toContain("尚未收到首帧信号");
});
it.each(["video_frame_callback", "playing_time_advance"])(
  "states the confidence of %s evidence and renders only public observations",
  async (evidence) => {
    const html = await render({
      diagnostics: {
        ...snapshot(evidence),
        fence: { token: "DO_NOT_RENDER_TOKEN", identity: "PRIVATE_IDENTITY" },
      },
    });
    expect(html).toContain("1.2 秒");
    expect(html).toContain("2.3 秒");
    expect(html).toContain("3.5 秒");
    expect(html).toContain("0.4 秒");
    expect(html).toContain(
      evidence === "video_frame_callback"
        ? "不是实测屏幕显示时间"
        : "是近似观测",
    );
    expect(html).not.toContain("DO_NOT_RENDER_TOKEN");
    expect(html).not.toContain("PRIVATE_IDENTITY");
  },
);
it("completed playback can still inspect a later meter sample through Settings", async () => {
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", new EventTarget());
  const empty = Vue.defineComponent({ render: () => null });
  const r = Vue.reactive({
    nativePlatform: true,
    nativeQualityOptions: [],
    nativePlatformMode: "native",
    state: { media_id: "movie" },
    loadingStage: "playing",
    preparation: { phase: "ready" },
    startupDiagnostics: undefined as unknown,
  });
  const settings = component("PlaybackSettings.vue", {
    PlaybackStartupDiagnostics: diagnostics,
    AppSelect: empty,
    AppIcon: empty,
    PlaybackSelections: empty,
    PlatformTextSettings: empty,
    LocalHlsLadderSettings: empty,
    NativeHlsLadderSettings: empty,
    AdvancedPlaybackSettings: empty,
  });
  const settingsPort = createPlaybackSettingsPort({
    playback: new Proxy(
      {},
      {
        get: (_target, key) =>
          Vue.toRef(r as Record<string, any>, key as string),
      },
    ) as Parameters<typeof createPlaybackSettingsPort>[0]["playback"],
    actions: r as any,
    hasMedia: () => !!r.state?.media_id,
  });
  const before = await SSR.renderToString(
    Vue.createSSRApp(settings, { active: true, settings: settingsPort }),
  );
  expect(before).toContain("暂无本地耗时观测");
  r.startupDiagnostics = snapshot("video_frame_callback");
  const after = await SSR.renderToString(
    Vue.createSSRApp(settings, { active: true, settings: settingsPort }),
  );
  expect(after).toContain("首帧信号");
  expect(after).toContain("3.5 秒");
  expect(after).toContain("不是实测屏幕显示时间");
});
