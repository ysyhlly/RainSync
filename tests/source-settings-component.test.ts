import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { readFileSync } from "node:fs";
import { parse } from "@vue/compiler-sfc";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { RequestFailure } from "../apps/web/src/errors";
import { parseHttpAssetAssociation } from "../apps/web/src/features/admin/http-asset-association";
import {
  settingsDraft,
  reconcileSettingsDraft,
  type SourceSettings,
  type SourceSettingsSaved,
} from "../apps/web/src/features/admin/source-settings";

afterEach(() => vi.unstubAllGlobals());
const local: SourceSettings = {
  id: "source-one",
  name: "电影目录",
  kind: "local",
  library_id: "shared-library",
  revision: "7",
  access_policy_revision: 2,
  config: { root: "/media/films" },
  credentials: {
    token_configured: false,
    headers_configured: false,
    header_names: [],
    url_configured: false,
    url_redacted: false,
  },
};
function fixture(kind = "local"): SourceSettings {
  const value = structuredClone(local);
  value.kind = kind;
  if (kind !== "local")
    value.config = {
      url: "https://media.example.test",
      user_id: "service-user",
    };
  if (["emby", "jellyfin"].includes(kind))
    value.credentials.token_configured = true;
  if (kind === "http") {
    value.credentials.headers_configured = true;
    value.credentials.header_names = ["Authorization"];
    value.config.advanced_assets = {
      schema_version: 1,
      subtitles: ["ass"],
      fonts: ["body.ttf"],
    };
  }
  return value;
}
function saved(
  value: SourceSettings,
  patch: Partial<SourceSettings> = {},
): SourceSettingsSaved {
  return {
    ...value,
    revision: "8",
    config_changed: false,
    rescan_required: false,
    ...patch,
  };
}
function panel(
  value: SourceSettings,
  api = vi.fn(async () => value),
  options: Record<string, unknown> = {},
) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "fixture",
    username: "fixture",
    admin: options.admin !== false,
    csrf: "fixture",
  });
  session.api = api;
  const focus = vi.fn(),
    scrollIntoView = vi.fn();
  vi.stubGlobal("document", {
    activeElement: { focus },
    getElementById: () => ({ focus, scrollIntoView }),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  let leave!: () => boolean | Promise<boolean>;
  const close = vi.fn(),
    onSaved = vi.fn();
  const instance = mountSetup(
    new URL(
      "../apps/web/src/features/admin/SourceSettingsDialog.vue",
      import.meta.url,
    ),
    {
      useSession,
      RequestFailure,
      parseHttpAssetAssociation,
      settingsDraft,
      reconcileSettingsDraft,
      onBeforeRouteLeave: (guard: any) => {
        leave = guard;
      },
      AppSelect: {},
      AppDialog: {},
      Notice: {},
    },
    {
      source: {
        id: value.id,
        name: value.name,
        kind: value.kind,
        library_id: value.library_id,
      },
      onClose: close,
      onSaved,
      ...options,
    },
  );
  return {
    ...instance,
    session,
    api,
    focus,
    scrollIntoView,
    close,
    onSaved,
    leave: () => leave(),
  };
}
async function ready(p: ReturnType<typeof panel>) {
  await vi.waitFor(() => expect(p.controls.loading.value).toBe(false));
}
function mutationCalls(api: any) {
  return api.mock.calls.filter(([, method]: any[]) => method === "PATCH");
}

it.each(["local", "http", "jellyfin", "emby"])(
  "prefills %s settings and never populates stored credentials",
  async (kind) => {
    const value = fixture(kind),
      p = panel(value),
      c = p.controls;
    await ready(p);
    expect(c.draft.value.name).toBe(value.name);
    expect(c.draft.value.root).toBe(value.config.root ?? "");
    expect(c.draft.value.url).toBe(value.config.url ?? "");
    expect(c.draft.value.userId).toBe(value.config.user_id ?? "");
    expect(c.draft.value.token).toBe("");
    expect(c.draft.value.headers).toBe("");
    expect(c.draft.value.tokenMode).toBe("keep");
    expect(c.draft.value.headersMode).toBe("keep");
    expect(c.dirty.value).toBe(false);
    expect(c.canClose()).toBe(true);
    await c.save();
    expect(mutationCalls(p.api)).toHaveLength(0);
    p.unmount();
  },
);

it("updates the existing ID with optimistic revision and preserves omitted credentials", async () => {
  const value = fixture("jellyfin");
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? saved(value, { name: "新的名称" }) : value,
  );
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "新的名称";
  await c.save();
  expect(mutationCalls(api)).toEqual([
    [
      "/sources/source-one",
      "PATCH",
      { expected_revision: "7", name: "新的名称" },
    ],
  ]);
  expect(
    api.mock.calls.some(
      ([, method]) => method === "DELETE" || method === "POST",
    ),
  ).toBe(false);
  expect(c.open.value).toBe(false);
  expect(c.draft.value.token).toBe("");
  expect(p.onSaved).toHaveBeenCalledWith(
    expect.objectContaining({ id: value.id, name: "新的名称" }),
  );
  p.unmount();
});

it("leaves signed URL inputs blank and does not replace them during a rename", async () => {
  const value = fixture("http");
  delete value.config.url;
  value.credentials.url_configured = true;
  value.credentials.url_redacted = true;
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? saved(value, { name: "新名称" }) : value,
  );
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  expect(c.draft.value.url).toBe("");
  expect(c.draft.value.urlMode).toBe("keep");
  c.draft.value.name = "新名称";
  await c.save();
  expect(mutationCalls(api)[0][2]).toEqual({
    expected_revision: "7",
    name: "新名称",
  });
  p.unmount();
});

it("replaces signed URLs only with an explicitly supplied new valid address", async () => {
  const value = fixture("http");
  delete value.config.url;
  value.credentials.url_redacted = true;
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? saved(value) : value,
  );
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.urlMode = "replace";
  await c.save();
  expect(c.error.value).toContain("HTTP");
  expect(mutationCalls(api)).toHaveLength(0);
  c.draft.value.url = "https://media.example.test/new.mp4?signature=synthetic";
  await c.save();
  expect(mutationCalls(api)[0][2]).toEqual({
    expected_revision: "7",
    name: value.name,
    config: { url: "https://media.example.test/new.mp4?signature=synthetic" },
  });
  expect(c.draft.value.url).toBe("");
  p.unmount();
});

it.each(["replace", "clear"])(
  "supports explicit token %s without returning a secret",
  async (mode) => {
    const value = fixture("emby");
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "PATCH" ? saved(value) : value,
    );
    const p = panel(value, api),
      c = p.controls;
    await ready(p);
    c.draft.value.tokenMode = mode;
    c.draft.value.token = "new-synthetic-token";
    await c.save();
    expect(mutationCalls(api)[0][2]).toEqual({
      expected_revision: "7",
      name: value.name,
      config: { token: mode === "clear" ? "" : "new-synthetic-token" },
    });
    expect(c.draft.value.token).toBe("");
    p.unmount();
  },
);

it.each(["replace", "clear"])(
  "supports explicit headers %s without changing associations",
  async (mode) => {
    const value = fixture("http");
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "PATCH" ? saved(value) : value,
    );
    const p = panel(value, api),
      c = p.controls;
    await ready(p);
    c.draft.value.headersMode = mode;
    c.draft.value.headers = '{"Authorization":"synthetic"}';
    await c.save();
    expect(mutationCalls(api)[0][2]).toEqual({
      expected_revision: "7",
      name: value.name,
      config: {
        headers: mode === "clear" ? {} : { Authorization: "synthetic" },
      },
    });
    expect(c.draft.value.headers).toBe("");
    p.unmount();
  },
);

it("can explicitly remove an existing subtitle/font association", async () => {
  const value = fixture("http");
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH"
      ? saved(value, { config: { url: value.config.url } })
      : value,
  );
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.advancedAssets = "";
  await c.save();
  expect(mutationCalls(api)[0][2]).toEqual({
    expected_revision: "7",
    name: value.name,
    config: { advanced_assets: null },
  });
  p.unmount();
});

it.each([
  ["name", "", "name"],
  ["root", "  ", "root"],
])("validates %s before sending", async (field, value, invalid) => {
  const p = panel(fixture()),
    c = p.controls;
  await ready(p);
  c.draft.value[field] = value;
  await c.save();
  expect(c.invalidField.value).toBe(invalid);
  expect(p.focus).toHaveBeenCalled();
  expect(mutationCalls(p.api)).toHaveLength(0);
  expect(c.saving.value).toBe(false);
  p.unmount();
});

it.each([
  ["headers", '{"Authorization":3}', "headersMode", "headers"],
  [
    "advancedAssets",
    '{"schema_version":1,"subtitles":[],"fonts":["../unsafe.ttf"]}',
    "headersMode",
    "assets",
  ],
])(
  "reveals and focuses invalid %s without sending",
  async (field, value, mode, invalid) => {
    const p = panel(fixture("http")),
      c = p.controls;
    await ready(p);
    if (field === "headers") c.draft.value[mode] = "replace";
    c.draft.value[field] = value;
    await c.save();
    expect(c.invalidField.value).toBe(invalid);
    expect(c.advancedOpen.value).toBe(true);
    expect(mutationCalls(p.api)).toHaveLength(0);
    expect(p.focus).toHaveBeenCalled();
    p.unmount();
  },
);

it("dirty cancel, escape/backdrop guard and route leave preserve edits until discard", async () => {
  const p = panel(fixture("emby")),
    c = p.controls;
  await ready(p);
  c.draft.value.tokenMode = "replace";
  c.draft.value.token = "unsaved-token";
  expect(c.canClose()).toBe(false);
  c.continueEditing();
  c.closeDraft();
  expect(c.open.value).toBe(true);
  expect(c.draft.value.token).toBe("unsaved-token");
  c.continueEditing();
  const stayed = p.leave();
  c.continueEditing();
  expect(await stayed).toBe(false);
  const leaving = p.leave();
  c.discardDraft();
  expect(await leaving).toBe(true);
  expect(c.open.value).toBe(false);
  expect(c.draft.value.token).toBe("");
  expect(mutationCalls(p.api)).toHaveLength(0);
  p.unmount();
});

it.each(["close", "reload"])(
  "centers the dirty %s decision above sticky drawer actions",
  async (action) => {
    const p = panel(fixture("http")),
      c = p.controls;
    await ready(p);
    p.focus.mockClear();
    c.draft.value.name = "未保存名称";
    if (action === "close") expect(c.canClose()).toBe(false);
    else c.requestReload();
    await nextTick();
    expect(c.discardOpen.value).toBe(true);
    expect(p.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(p.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(mutationCalls(p.api)).toHaveLength(0);
    p.unmount();
  },
);

it("blocks duplicate saves and dismissal until the pending PATCH settles", async () => {
  const value = fixture();
  let finish!: (result: SourceSettingsSaved) => void;
  const pending = new Promise<SourceSettingsSaved>((resolve) => {
    finish = resolve;
  });
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? pending : value,
  );
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "保存的名称";
  const work = c.save();
  await c.save();
  c.closeDraft();
  expect(c.open.value).toBe(true);
  expect(c.saving.value).toBe(true);
  expect(c.canClose()).toBe(false);
  expect(p.leave()).toBe(false);
  expect(mutationCalls(api)).toHaveLength(1);
  finish(saved(value, { name: "保存的名称" }));
  await work;
  expect(c.open.value).toBe(false);
  p.unmount();
});

it.each([
  ["name", "后续名称"],
  ["root", "/new-root"],
  ["url", "https://new.example.test"],
  ["userId", "new-user"],
  ["token", "newer-secret"],
  ["headers", '{"X-New":"newer-secret"}'],
  ["advancedAssets", "newer-association"],
])(
  "preserves a newer %s while acknowledging only the submitted draft",
  async (field, nextValue) => {
    const value = fixture("emby");
    let finish!: (result: SourceSettingsSaved) => void;
    const pending = new Promise<SourceSettingsSaved>((resolve) => {
      finish = resolve;
    });
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "PATCH" ? pending : value,
    );
    const p = panel(value, api),
      c = p.controls;
    await ready(p);
    c.draft.value.name = "已提交名称";
    c.draft.value.tokenMode = "replace";
    c.draft.value.token = "submitted-token";
    const work = c.save();
    c.draft.value[field] = nextValue;
    finish(saved(value, { name: "已提交名称" }));
    await work;
    expect(c.open.value).toBe(true);
    expect(c.draft.value[field]).toBe(nextValue);
    expect(c.detail.value.revision).toBe("8");
    expect(c.dirty.value).toBe(true);
    expect(c.saving.value).toBe(false);
    expect(c.message.value).toContain("新的修改尚未保存");
    if (field === "token") expect(c.draft.value.tokenMode).toBe("replace");
    p.unmount();
  },
);

it("keeps failed saves editable and retains their draft", async () => {
  const value = fixture("emby");
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "PATCH") throw Error("连接暂时不可用");
    return value;
  });
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.tokenMode = "replace";
  c.draft.value.token = "unsaved-secret";
  await c.save();
  expect(c.error.value).toBe("连接暂时不可用");
  expect(c.draft.value.token).toBe("unsaved-secret");
  expect(c.open.value).toBe(true);
  expect(c.saving.value).toBe(false);
  expect(c.unavailable.value).toBe(false);
  p.unmount();
});

it("preserves conflicting edits and requires explicit discard before reloading", async () => {
  const value = fixture();
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "PATCH")
      throw new RequestFailure({ error: "source_changed" });
    return value;
  });
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "冲突名称";
  await c.save();
  expect(c.conflict.value).toBe(true);
  expect(c.draft.value.name).toBe("冲突名称");
  await c.save();
  expect(mutationCalls(api)).toHaveLength(1);
  c.requestReload();
  expect(c.discardOpen.value).toBe(true);
  expect(api).toHaveBeenCalledTimes(2);
  c.continueEditing();
  expect(c.draft.value.name).toBe("冲突名称");
  c.requestReload();
  c.discardDraft();
  await ready(p);
  expect(c.draft.value.name).toBe(value.name);
  expect(c.dirty.value).toBe(false);
  expect(c.conflict.value).toBe(false);
  p.unmount();
});

it("does not read settings without admin permission and handles permission loss on save", async () => {
  const value = fixture();
  const blocked = panel(
    value,
    vi.fn(async () => value),
    { admin: false },
  );
  await ready(blocked);
  expect(blocked.api).not.toHaveBeenCalled();
  expect(blocked.controls.unavailable.value).toBe(true);
  blocked.unmount();
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "PATCH")
      throw new RequestFailure({ error: "admin_required" });
    return value;
  });
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "禁止保存";
  await c.save();
  expect(c.unavailable.value).toBe(true);
  expect(c.error.value).toContain("权限");
  await c.save();
  expect(mutationCalls(api)).toHaveLength(1);
  p.unmount();
});

it("supports the same editor for authorized private library sources", async () => {
  const value = fixture("http");
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? saved(value, { name: "私有名称" }) : value,
  );
  const p = panel(value, api, {
      admin: false,
      requireAdmin: false,
      apiBase: "/libraries/private-one/sources",
    }),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "私有名称";
  await c.save();
  expect(api.mock.calls[0][0]).toBe(
    "/libraries/private-one/sources/source-one",
  );
  expect(mutationCalls(api)[0][0]).toBe(
    "/libraries/private-one/sources/source-one",
  );
  p.unmount();
});

it("hides privileged associations and omits them from private-manager URL/header edits", async () => {
  const value = fixture("http");
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? saved(value) : value,
  );
  const p = panel(value, api, {
      admin: false,
      requireAdmin: false,
      apiBase: "/libraries/private-one/sources",
    }),
    c = p.controls;
  await ready(p);
  expect(c.canEditAdvanced.value).toBe(false);
  c.draft.value.url = "https://media.example.test/new.mp4";
  c.draft.value.headersMode = "replace";
  c.draft.value.headers = '{"X-Access":"synthetic"}';
  // Even a stale/programmatically changed privileged field must not leak into PATCH.
  c.draft.value.advancedAssets = "invalid privileged draft";
  await c.save();
  expect(mutationCalls(api)[0][2]).toEqual({
    expected_revision: "7",
    name: value.name,
    config: {
      url: "https://media.example.test/new.mp4",
      headers: { "X-Access": "synthetic" },
    },
  });
  expect(c.error.value).toBe("");
  const source = readFileSync(
    new URL(
      "../apps/web/src/features/admin/SourceSettingsDialog.vue",
      import.meta.url,
    ),
    "utf8",
  );
  const template = parse(source).descriptor.template!;
  let label: any;
  function visit(node: any) {
    if (
      node.type === 1 &&
      node.tag === "label" &&
      node.props.some(
        (prop: any) =>
          prop.name === "for" &&
          prop.value?.content === "source-settings-assets",
      )
    )
      label = node;
    node.children?.forEach(visit);
  }
  visit(template.ast);
  expect(
    label.props.find((prop: any) => prop.name === "if")?.exp?.content,
  ).toBe("canEditAdvanced");
  p.unmount();
});

it("keeps legitimate private settings editable after an admin-only-field rejection", async () => {
  const value = fixture("http");
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "PATCH")
      throw new RequestFailure({ error: "admin_required" });
    return value;
  });
  const p = panel(value, api, { admin: false, requireAdmin: false }),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "可修改的名称";
  await c.save();
  expect(c.error.value).toContain("此项设置仅管理员可修改");
  expect(c.unavailable.value).toBe(false);
  expect(c.disabled.value).toBe(false);
  expect(c.draft.value.name).toBe("可修改的名称");
  p.unmount();
});

it("explains cross-origin credential replacement and keeps the draft editable", async () => {
  const value = fixture("http");
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "PATCH")
      throw new RequestFailure({ error: "source_credentials_origin_changed" });
    return value;
  });
  const p = panel(value, api, { admin: false, requireAdmin: false }),
    c = p.controls;
  await ready(p);
  c.draft.value.url = "https://other.example.test/media.mp4";
  await c.save();
  expect(c.error.value).toContain("替换或清除已保存请求头");
  expect(c.advancedOpen.value).toBe(true);
  expect(c.unavailable.value).toBe(false);
  expect(c.draft.value.url).toBe("https://other.example.test/media.mp4");
  p.unmount();
});

it("marks an inaccessible library unavailable without permitting a settings save", async () => {
  const value = fixture("http");
  const api = vi.fn(async () => {
    throw new RequestFailure({ error: "library_not_found" });
  });
  const p = panel(value, api, { admin: false, requireAdmin: false }),
    c = p.controls;
  await ready(p);
  expect(c.unavailable.value).toBe(true);
  expect(c.error.value).toContain("已无权访问");
  await c.save();
  expect(mutationCalls(api)).toHaveLength(0);
  p.unmount();
});

it("clears credentials on identity change and ignores the old pending response", async () => {
  const value = fixture("emby");
  let finish!: (result: SourceSettingsSaved) => void;
  const pending = new Promise<SourceSettingsSaved>((resolve) => {
    finish = resolve;
  });
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PATCH" ? pending : value,
  );
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  c.draft.value.tokenMode = "replace";
  c.draft.value.token = "unsaved-secret";
  const work = c.save();
  p.session.clear();
  expect(c.open.value).toBe(false);
  expect(c.draft.value.token).toBe("");
  finish(saved(value));
  await work;
  expect(c.detail.value).toBeUndefined();
  expect(p.onSaved).not.toHaveBeenCalled();
  p.unmount();
});

it("allows cancelling a pending detail read without a stale response reopening the editor", async () => {
  let finish!: (result: SourceSettings) => void;
  const pending = new Promise<SourceSettings>((resolve) => {
    finish = resolve;
  });
  const p = panel(
      fixture(),
      vi.fn(async () => pending),
    ),
    c = p.controls;
  expect(c.loading.value).toBe(true);
  c.closeDraft();
  finish(fixture());
  await nextTick();
  await nextTick();
  expect(c.open.value).toBe(false);
  expect(c.detail.value).toBeUndefined();
  expect(p.close).toHaveBeenCalledTimes(1);
  p.unmount();
});

it("ignores an older detail read when a different source is selected", async () => {
  const first = fixture();
  const second = { ...fixture(), id: "source-two", name: "另一个片源" };
  let finish!: (value: SourceSettings) => void;
  const pending = new Promise<SourceSettings>((resolve) => {
    finish = resolve;
  });
  const api = vi.fn(async (path: string) =>
    path.endsWith("source-one") ? pending : second,
  );
  const p = panel(first, api),
    c = p.controls;
  p.setProps({ source: second });
  await nextTick();
  await ready(p);
  expect(c.detail.value.id).toBe(second.id);
  finish(first);
  await nextTick();
  await nextTick();
  expect(c.detail.value.id).toBe(second.id);
  expect(c.draft.value.name).toBe(second.name);
  p.unmount();
});

it("retires a draft immediately if the same account loses its admin role", async () => {
  const p = panel(fixture("emby")),
    c = p.controls;
  await ready(p);
  c.draft.value.tokenMode = "replace";
  c.draft.value.token = "unsaved-token";
  p.session.accept({
    id: "fixture",
    username: "fixture",
    admin: false,
    csrf: "fixture",
  });
  expect(c.open.value).toBe(false);
  expect(c.draft.value.token).toBe("");
  expect(c.detail.value).toBeUndefined();
  p.unmount();
});

it.each(["admin role", "required permission"])(
  "settles a pending route leave when the %s changes",
  async (change) => {
    const p = panel(
        fixture("emby"),
        undefined,
        change === "required permission"
          ? { admin: false, requireAdmin: false }
          : {},
      ),
      c = p.controls;
    await ready(p);
    c.draft.value.tokenMode = "replace";
    c.draft.value.token = "unsaved-token";
    const settled = vi.fn();
    const leaving = Promise.resolve(p.leave()).then(settled);
    expect(c.discardOpen.value).toBe(true);
    if (change === "required permission") p.setProps({ requireAdmin: true });
    else
      p.session.accept({
        id: "fixture",
        username: "fixture",
        admin: false,
        csrf: "fixture",
      });
    await nextTick();
    await nextTick();
    expect(c.open.value).toBe(false);
    expect(c.draft.value.token).toBe("");
    expect(settled).toHaveBeenCalledWith(true);
    await leaving;
    expect(mutationCalls(p.api)).toHaveLength(0);
    p.unmount();
  },
);

it("permission dismissal resolves only the latest pending route leave", async () => {
  const p = panel(fixture()),
    c = p.controls;
  await ready(p);
  c.draft.value.name = "unsaved";
  const first = p.leave();
  const second = p.leave();
  expect(await first).toBe(false);
  p.session.accept({
    id: "fixture",
    username: "fixture",
    admin: false,
    csrf: "fixture",
  });
  expect(await second).toBe(true);
  p.unmount();
});

it("retries a failed settings read without allowing a mutation", async () => {
  let fail = true;
  const value = fixture();
  const api = vi.fn(async () => {
    if (fail) throw Error("读取失败");
    return value;
  });
  const p = panel(value, api),
    c = p.controls;
  await ready(p);
  expect(c.error.value).toBe("读取失败");
  expect(c.detail.value).toBeUndefined();
  await c.save();
  expect(mutationCalls(api)).toHaveLength(0);
  fail = false;
  await c.load();
  expect(c.detail.value.id).toBe(value.id);
  expect(c.error.value).toBe("");
  p.unmount();
});

it("uses unified dialog/select controls, locks fields and discloses playback impact", () => {
  const text = readFileSync(
    new URL(
      "../apps/web/src/features/admin/SourceSettingsDialog.vue",
      import.meta.url,
    ),
    "utf8",
  );
  const template = parse(text).descriptor.template!;
  const elements: any[] = [];
  const visit = (node: any) => {
    if (node.type === 1) elements.push(node);
    node.children?.forEach(visit);
  };
  visit(template.ast);
  expect(elements.some((node) => node.tag === "AppDialog")).toBe(true);
  expect(elements.some((node) => node.tag === "AppSelect")).toBe(true);
  for (const field of elements.filter((node) =>
    ["input", "textarea", "AppSelect"].includes(node.tag),
  )) {
    expect(
      field.props.find(
        (prop: any) => prop.name === "bind" && prop.arg?.content === "disabled",
      )?.exp?.content,
    ).toBe("disabled");
  }
  expect(text).toContain("会中断此片源正在进行的播放");
  expect(text).toContain("仅修改名称不会中断播放");
});
