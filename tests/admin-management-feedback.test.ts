import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";

const catalog = [
  {
    id: "metadata.duration-badge",
    name: "时长标记",
    description: "合成测试目录",
    versions: [{ version: "1.0.0", artifact_digest: "synthetic-duration" }],
  },
  {
    id: "metadata.viewer-note",
    name: "观看说明",
    description: "合成测试目录",
    versions: [{ version: "1.0.0", artifact_digest: "synthetic-note" }],
  },
];

function panel(file: "PluginsPage" | "ComputePolicyPanel", api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "fixture",
    username: "fixture",
    admin: true,
    csrf: "fixture",
  });
  session.api = api;
  return mountSetup(
    new URL(
      `../apps/web/src/features/${file === "PluginsPage" ? "plugins" : "admin"}/${file}.vue`,
      import.meta.url,
    ),
    { useSession, AppSelect: {}, AppIcon: {}, Notice: {} },
  );
}

it("distinguishes a failed plugin catalog load from a successfully loaded catalog", async () => {
  let fail = true;
  const api = vi.fn(async () => {
    if (fail) throw Error("目录暂时不可用");
    return { catalog, installed: [] };
  });
  const p = panel("PluginsPage", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(""));
  expect(c.catalogLoaded.value).toBe(false);
  expect(c.error.value).toBe("目录暂时不可用");
  fail = false;
  await c.run("load", c.load);
  expect(c.catalogLoaded.value).toBe(true);
  expect(c.catalog.value).toEqual(catalog);
  expect(c.error.value).toBe("");
  p.unmount();
});

it("keeps explicit plugin permission and optimistic revision semantics when saving", async () => {
  const id = catalog[0].id;
  const installed = {
    id,
    version: "1.0.0",
    enabled: false,
    config: { format: "minutes" },
    revision: "7",
    granted_permissions: [],
    can_rollback: true,
  };
  const api = vi.fn(async (path: string, method = "GET") => {
    if (path === "/media") return [];
    if (method === "PUT") return { ...installed, revision: "8" };
    return { catalog, installed: [installed] };
  });
  const p = panel("PluginsPage", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(""));
  await expect(c.save(id)).rejects.toThrow("metadata:read");
  expect(api.mock.calls.filter(([, method]) => method === "PUT")).toHaveLength(
    0,
  );
  c.draft.value[id].grant = true;
  c.draft.value[id].enabled = true;
  c.draft.value[id].format = "clock";
  c.extensions.value = [{ plugin_id: id, label: "旧结果" }];
  c.previewLoaded.value = true;
  await c.run(id, () => c.save(id));
  expect(
    api.mock.calls.find(([, method]) => method === "PUT")?.slice(0, 3),
  ).toEqual([
    `/admin/plugins/${id}`,
    "PUT",
    {
      version: "1.0.0",
      enabled: true,
      config: { format: "clock" },
      granted_permissions: ["metadata:read"],
      expected_revision: "7",
    },
  ]);
  expect(c.extensions.value).toEqual([]);
  expect(c.previewLoaded.value).toBe(false);
  expect(c.message.value).toContain("插件设置已保存");
  p.unmount();
});

it("distinguishes an empty preview result and clears it when the selected film changes", async () => {
  const api = vi.fn(async (path: string) => {
    if (path === "/admin/plugins") return { catalog, installed: [] };
    if (path === "/media") return [];
    return { media_id: "film-one", extensions: [] };
  });
  const p = panel("PluginsPage", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(""));
  expect(c.previewLoaded.value).toBe(false);
  c.selectedMedia.value = "film-one";
  await nextTick();
  await c.run("preview", c.preview);
  expect(c.previewLoaded.value).toBe(true);
  expect(c.extensions.value).toEqual([]);
  c.selectedMedia.value = "film-two";
  await nextTick();
  expect(c.previewLoaded.value).toBe(false);
  expect(c.extensions.value).toEqual([]);
  p.unmount();
});

it("reports an empty plugin audit only after a successful request", async () => {
  const api = vi.fn(async (path: string) => {
    if (path === "/admin/plugins") return { catalog, installed: [] };
    if (path === "/media") return [];
    return { items: [] };
  });
  const p = panel("PluginsPage", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(""));
  expect(c.auditLoaded.value).toBe(false);
  await c.run("audit", c.audit);
  expect(c.auditLoaded.value).toBe(true);
  expect(c.audits.value).toEqual([]);
  p.unmount();
});

it("retries a failed media read without changing installed plugin configuration", async () => {
  let mediaReads = 0;
  const api = vi.fn(async (path: string) => {
    if (path === "/admin/plugins") return { catalog, installed: [] };
    if (++mediaReads === 1) throw Error("影片列表暂时不可用");
    return [{ id: "film-one", title: "合成影片" }];
  });
  const p = panel("PluginsPage", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.busy.value).toBe(""));
  expect(c.catalogLoaded.value).toBe(true);
  expect(c.mediaLoaded.value).toBe(false);
  expect(c.error.value).toBe("影片列表暂时不可用");
  await c.run("media", c.loadMedia);
  expect(c.mediaLoaded.value).toBe(true);
  expect(c.media.value).toHaveLength(1);
  expect(c.error.value).toBe("");
  expect(api.mock.calls.map(([path]) => path)).toEqual([
    "/admin/plugins",
    "/media",
    "/media",
  ]);
  p.unmount();
});

it("retries compute status without confusing a load error with disabled compute", async () => {
  let fail = true;
  const api = vi.fn(async () => {
    if (fail) throw Error("节点暂时不可用");
    return { enabled: false, nodes: [] };
  });
  const p = panel("ComputePolicyPanel", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.loading.value).toBe(false));
  expect(c.loaded.value).toBe(false);
  expect(c.error.value).toBe("节点暂时不可用");
  fail = false;
  await c.load();
  expect(c.loaded.value).toBe(true);
  expect(c.enabled.value).toBe(false);
  expect(c.error.value).toBe("");
  p.unmount();
});

it("preserves compute authorization payloads and refreshes the actual node state", async () => {
  const node = {
    id: "node-one",
    name: "合成节点",
    enabled: false,
    healthy: true,
    slots: null,
    output_budget_bytes: null,
    capabilities: [],
    running: 0,
  };
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "POST") return { ok: true };
    return { enabled: true, nodes: [node] };
  });
  const p = panel("ComputePolicyPanel", api),
    c = p.controls;
  await vi.waitFor(() => expect(c.loading.value).toBe(false));
  await c.change(node);
  expect(
    api.mock.calls.find(([, method]) => method === "POST")?.slice(0, 3),
  ).toEqual([
    "/agents/node-one/compute-policy",
    "POST",
    { enabled: true, slots: 1, output_budget_bytes: 67108864 },
  ]);
  expect(c.busy.value).toBe(false);
  expect(c.loaded.value).toBe(true);
  p.unmount();
});
