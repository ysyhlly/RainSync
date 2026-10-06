import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { useAction } from "../apps/web/src/shared/use-action";
import { parseHttpAssetAssociation } from "../apps/web/src/features/admin/http-asset-association";
afterEach(() => vi.unstubAllGlobals());
function panel(api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "fixture",
    username: "fixture",
    admin: true,
    csrf: "fixture",
  });
  session.api = api;
  const focus = vi.fn();
  vi.stubGlobal("document", {
    activeElement: { focus },
    getElementById: () => ({ focus }),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  let leave!: () => boolean | Promise<boolean>;
  const instance = mountSetup(
    new URL("../apps/web/src/features/admin/SourcesPage.vue", import.meta.url),
    {
      useSession,
      useAction,
      parseHttpAssetAssociation,
      onBeforeRouteLeave: (guard: any) => {
        leave = guard;
      },
      useSourceScans: () => ({ results: {} }),
      AppSelect: {},
      AppDialog: {},
      AppIcon: {},
      Notice: {},
      ScanAllSources: {},
    },
  );
  return { ...instance, session, focus, leave: () => leave() };
}
it("retires sensitive source drafts when the RainSync identity changes", async () => {
  const p = panel(vi.fn(async () => [])),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(false));
  c.beginCreate();
  c.token.value = "synthetic-token";
  c.headers.value = '{"Authorization":"synthetic-header"}';
  p.session.clear();
  expect(c.open.value).toBe(false);
  expect(c.token.value).toBe("");
  expect(c.headers.value).toBe("{}");
  expect(p.leave()).toBe(true);
  p.unmount();
});
it("all dismissal paths preserve a dirty draft until discard, then reset every field", async () => {
  const p = panel(vi.fn(async () => []));
  const c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(false));
  c.beginCreate();
  expect(c.canClose()).toBe(true);
  Object.assign(c.name, { value: "fixture" });
  c.kind.value = "emby";
  c.url.value = "https://fixture.test";
  c.userId.value = "synthetic-user";
  c.token.value = "synthetic-token";
  c.headers.value = '{"X-Fixture":"synthetic"}';
  c.advancedAssets.value = '{"schema_version":1}';
  expect(c.canClose()).toBe(false);
  expect(c.token.value).toBe("synthetic-token");
  c.continueEditing();
  c.closeDraft();
  expect(c.open.value).toBe(true);
  c.continueEditing();
  const leave = p.leave();
  c.continueEditing();
  expect(await leave).toBe(false);
  expect(c.headers.value).toContain("X-Fixture");
  const discardLeave = p.leave();
  c.discardDraft();
  expect(await discardLeave).toBe(true);
  expect(c.open.value).toBe(false);
  expect([
    c.name.value,
    c.url.value,
    c.userId.value,
    c.token.value,
    c.advancedAssets.value,
  ]).toEqual(["", "", "", "", ""]);
  expect(c.headers.value).toBe("{}");
  expect(c.kind.value).toBe("local");
  expect(c.root.value).toBe("/media");
  p.unmount();
});
it("advanced errors expand the hidden fields, focus them and do not send a mutation", async () => {
  const api = vi.fn(async () => []);
  const p = panel(api),
    c = p.controls;
  await nextTick();
  c.beginCreate();
  c.kind.value = "http";
  c.headers.value = '{"Authorization":3}';
  await nextTick();
  await expect(c.create()).rejects.toThrow("请求头");
  expect(c.advancedOpen.value).toBe(true);
  expect(c.headersError.value).toContain("请求头");
  expect(p.focus).toHaveBeenCalled();
  c.headers.value = "{}";
  await nextTick();
  expect(c.headersError.value).toBe("");
  c.advancedAssets.value = '{"schema_version":1,"fonts":["../unsafe.ttf"]}';
  await nextTick();
  c.advancedOpen.value = false;
  await expect(c.create()).rejects.toThrow();
  expect(c.advancedOpen.value).toBe(true);
  expect(c.assetsError.value).not.toBe("");
  expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(
    0,
  );
  p.unmount();
});
it("a confirmed source POST followed by failed list GET still reports added and retries only reading", async () => {
  let reads = 0;
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "POST") return { id: "added" };
    if (++reads === 2) throw Error("synthetic read failure");
    return [];
  });
  const p = panel(api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(false));
  c.beginCreate();
  c.name.value = "fixture";
  c.kind.value = "http";
  c.url.value = "https://fixture.test/video.mp4";
  await c.run(c.create);
  expect(c.message.value).toContain("片源已添加");
  expect(c.error.value).toContain("片源已添加，但列表暂未更新");
  expect(c.open.value).toBe(false);
  await c.run(c.load);
  expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(
    1,
  );
  expect(api.mock.calls.find(([, method]) => method === "POST")?.[2]).toEqual({
    name: "fixture",
    kind: "http",
    config: { url: "https://fixture.test/video.mp4", headers: {} },
  });
  p.unmount();
});

it.each([
  ["name", "New source draft"],
  ["kind", "local"],
  ["root", "/new-media"],
  ["url", "https://fixture.test/second.mp4"],
  ["userId", "new-user"],
  ["token", "synthetic-new-token"],
  ["headers", '{"X-Fixture":"new"}'],
  ["advancedAssets", '{"schema_version":1}'],
])(
  "preserves a newer source %s after an older creation completes",
  async (field, value) => {
    let finish!: (value: { id: string }) => void;
    const request = new Promise((resolve) => {
      finish = resolve;
    });
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "POST" ? request : [],
    );
    const p = panel(api),
      c = p.controls;
    await vi.waitFor(() => expect(c.busy.value).toBe(false));
    c.beginCreate();
    c.name.value = "Submitted source";
    c.kind.value = "http";
    c.url.value = "https://fixture.test/first.mp4";
    const pending = c.submitCreate();
    c[field].value = value;
    finish({ id: "created-source" });
    await pending;
    expect(api.mock.calls.find(([, method]) => method === "POST")?.[2]).toEqual(
      {
        name: "Submitted source",
        kind: "http",
        config: { url: "https://fixture.test/first.mp4", headers: {} },
      },
    );
    expect(c[field].value).toBe(value);
    expect(c.open.value).toBe(true);
    p.unmount();
  },
);

it.each([
  ["local", { root: "/fixture-media" }],
  [
    "http",
    { url: "https://fixture.test/media", headers: { "X-Fixture": "value" } },
  ],
  [
    "jellyfin",
    {
      url: "https://fixture.test/media",
      user_id: "fixture-user",
      token: "synthetic-token",
    },
  ],
  [
    "emby",
    {
      url: "https://fixture.test/media",
      user_id: "fixture-user",
      token: "synthetic-token",
    },
  ],
])(
  "blocks repeated %s source submissions and resets only after success",
  async (kind, config) => {
    let finish!: (value: { id: string }) => void;
    const request = new Promise((resolve) => {
      finish = resolve;
    });
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "POST" ? request : [],
    );
    const p = panel(api),
      c = p.controls;
    await vi.waitFor(() => expect(c.busy.value).toBe(false));
    c.beginCreate();
    c.name.value = "Submitted source";
    c.kind.value = kind;
    c.root.value = "/fixture-media";
    c.url.value = "https://fixture.test/media";
    c.userId.value = "fixture-user";
    c.token.value = "synthetic-token";
    c.headers.value = '{"X-Fixture":"value"}';
    const pending = c.submitCreate();
    await c.submitCreate();
    expect(api.mock.calls.filter(([, method]) => method === "POST")).toEqual([
      ["/sources", "POST", { name: "Submitted source", kind, config }],
    ]);
    expect(c.busy.value).toBe(true);
    expect(p.leave()).toBe(false);
    expect(c.canClose()).toBe(false);
    finish({ id: "created-source" });
    await pending;
    expect(c.open.value).toBe(false);
    expect(c.dirty.value).toBe(false);
    expect(c.token.value).toBe("");
    expect(c.busy.value).toBe(false);
    expect(c.message.value).toContain("片源已添加");
    p.unmount();
  },
);

it("preserves the complete failed source draft and the existing discard choice", async () => {
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "POST") throw Error("synthetic save failure");
    return [];
  });
  const p = panel(api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(false));
  c.beginCreate();
  const draft = {
    name: "Fixture",
    kind: "emby",
    root: "/fixture-media",
    url: "https://fixture.test",
    userId: "fixture-user",
    token: "synthetic-token",
    headers: '{"X-Fixture":"value"}',
    advancedAssets: '{"schema_version":1}',
  };
  for (const [key, value] of Object.entries(draft)) c[key].value = value;
  await c.submitCreate();
  for (const [key, value] of Object.entries(draft))
    expect(c[key].value).toBe(value);
  expect(c.open.value).toBe(true);
  expect(c.busy.value).toBe(false);
  expect(c.error.value).toBe("synthetic save failure");
  expect(c.message.value).toBe("");
  expect(c.canClose()).toBe(false);
  expect(c.discardOpen.value).toBe(true);
  await c.submitCreate();
  expect(api.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(
    1,
  );
  c.continueEditing();
  expect(c.token.value).toBe("synthetic-token");
  c.closeDraft();
  c.discardDraft();
  expect(c.open.value).toBe(false);
  expect(c.dirty.value).toBe(false);
  p.unmount();
});

it("binds every source draft field to pending state and submits through the guard", () => {
  const template = parse(
    readFileSync(
      new URL(
        "../apps/web/src/features/admin/SourcesPage.vue",
        import.meta.url,
      ),
      "utf8",
    ),
  ).descriptor.template!;
  const elements: any[] = [];
  function visit(node: any) {
    if (node.type === 1) elements.push(node);
    node.children?.forEach(visit);
  }
  visit(template.ast);
  const fields = elements.filter((node) =>
    ["input", "textarea", "AppSelect"].includes(node.tag),
  );
  expect(fields).toHaveLength(8);
  for (const field of fields) {
    const model = field.props.find((prop: any) => prop.name === "model")?.exp
      ?.content;
    const expected =
      model === "headers"
        ? "busy && !headersError"
        : model === "advancedAssets"
          ? "busy && !assetsError"
          : "busy";
    expect(
      field.props.find(
        (prop: any) => prop.name === "bind" && prop.arg?.content === "disabled",
      )?.exp?.content,
    ).toBe(expected);
  }
  const form = elements.find((node) => node.tag === "form");
  expect(
    form.props.find(
      (prop: any) => prop.name === "on" && prop.arg?.content === "submit",
    )?.exp?.content,
  ).toBe("submitCreate");
});

it.each([
  ["headers", "headersError", '{"X-Fixture":3}'],
  [
    "advancedAssets",
    "assetsError",
    '{"schema_version":1,"fonts":["../unsafe.ttf"]}',
  ],
])(
  "keeps invalid %s focusable for correction after guarded validation",
  async (field, error, value) => {
    const api = vi.fn(async () => []);
    const p = panel(api),
      c = p.controls;
    await vi.waitFor(() => expect(c.busy.value).toBe(false));
    c.beginCreate();
    c.kind.value = "http";
    c.name.value = "Fixture";
    c.url.value = "https://fixture.test/media";
    c[field].value = value;
    await nextTick();
    p.focus.mockImplementation(() => {
      expect(c.busy.value && !c[error].value).toBe(false);
    });
    await c.submitCreate();
    expect(c[error].value).not.toBe("");
    expect(c[field].value).toBe(value);
    expect(c.advancedOpen.value).toBe(true);
    expect(p.focus).toHaveBeenCalled();
    expect(c.busy.value).toBe(false);
    expect(
      api.mock.calls.filter(([, method]) => method === "POST"),
    ).toHaveLength(0);
    p.unmount();
  },
);
