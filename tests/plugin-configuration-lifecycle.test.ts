import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";

const id = "metadata.duration-badge";
const catalog = [
  { id, name: "时长标签", versions: [{ version: "1.0.0" }] },
  {
    id: "metadata.title-label",
    name: "影片说明标签",
    versions: [{ version: "1.0.0" }],
  },
];
const saved = {
  id,
  version: "1.0.0",
  enabled: true,
  config: { format: "clock" },
  revision: "7",
  granted_permissions: ["metadata:read"],
  can_rollback: true,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function panel(
  mutate?: (path: string, method: string, body: any) => any,
) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "admin",
    username: "admin",
    admin: true,
    csrf: "synthetic",
  });
  const api = vi.fn(async (path: string, method = "GET", body?: any) => {
    if (path === "/media") return [];
    if (mutate) {
      const value = await mutate(path, method, body);
      if (value !== undefined) return value;
    }
    return {
      catalog,
      installed: [saved],
      configuration_revisions: { [id]: "7" },
    };
  });
  session.api = api;
  const mounted = mountSetup(
    new URL(
      "../apps/web/src/features/plugins/PluginsPage.vue",
      import.meta.url,
    ),
    {
      useSession,
      AppDialog: {},
      AppSelect: {},
      AppIcon: {},
      Notice: {},
    },
  );
  cleanups.push(mounted.unmount);
  await vi.waitFor(() => expect(mounted.controls.busy.value).toBe(""));
  return { c: mounted.controls, api, session, unmount: mounted.unmount };
}
it("opens an explicit revision-bound confirmation, and cancel preserves saved and draft configuration", async () => {
  const { c, api } = await panel();
  c.draft.value[id].format = "minutes";
  c.askRemove(id);
  expect(c.removal.value).toEqual({ id, name: "时长标签", revision: "7" });
  expect(api.mock.calls.some(([, method]) => method === "DELETE")).toBe(false);
  c.closeRemoval();
  expect(c.removal.value).toBeNull();
  expect(c.draft.value[id].format).toBe("minutes");
  expect(c.installed.value[id]).toEqual(saved);
  await c.removeConfiguration();
  expect(api.mock.calls.some(([, method]) => method === "DELETE")).toBe(false);
});
it("deletes only the confirmed revision, resets the form and consumes the receipt without another catalog read", async () => {
  const { c, api } = await panel((_path, method) =>
    method === "DELETE" ? { id, removed: true, revision: "8" } : undefined,
  );
  c.extensions.value = [{ plugin_id: id, label: "旧结果" }];
  c.previewLoaded.value = c.auditLoaded.value = true;
  c.audits.value = [{ id: "old" }];
  c.askRemove(id);
  await c.removeConfiguration();
  expect(
    api.mock.calls.filter(([, method]) => method === "DELETE")[0].slice(0, 3),
  ).toEqual([`/admin/plugins/${id}`, "DELETE", { expected_revision: "7" }]);
  expect(c.installed.value[id]).toBeUndefined();
  expect(c.catalog.value).toHaveLength(2);
  expect(c.draftRevision.value[id]).toBe("8");
  expect(c.draft.value[id]).toMatchObject({
    format: "minutes",
    enabled: false,
    grant: false,
  });
  expect(c.removal.value).toBeNull();
  expect(c.extensions.value).toEqual([]);
  expect(c.audits.value).toEqual([]);
  expect(c.previewLoaded.value).toBe(false);
  expect(c.auditLoaded.value).toBe(false);
  expect(c.message.value).toContain("已删除");
  expect(
    api.mock.calls.filter(
      ([path, method]) => path === "/admin/plugins" && method === undefined,
    ),
  ).toHaveLength(0);
  expect(
    api.mock.calls.filter(([path]) => path === "/admin/plugins"),
  ).toHaveLength(1);
});
it("retains a tombstone revision across refresh and requires a new explicit grant before reinstall", async () => {
  let removed = false;
  const { c, api } = await panel((_path, method, body) => {
    if (method === "DELETE") {
      removed = true;
      return { id, removed: true, revision: "8" };
    }
    if (method === "PUT") return { ...saved, revision: "9", ...body };
    if (removed)
      return { catalog, installed: [], configuration_revisions: { [id]: "8" } };
  });
  c.askRemove(id);
  await c.removeConfiguration();
  await c.run("load", c.load);
  await expect(c.save(id)).rejects.toThrow("metadata:read");
  c.draft.value[id].grant = true;
  await c.run(id, () => c.save(id));
  expect(
    api.mock.calls.find(([, method]) => method === "PUT")?.[2],
  ).toMatchObject({ expected_revision: "8", enabled: false });
});
it("does not authorize a stale dirty draft after another administrator removes the config", async () => {
  let removed = false;
  const { c, api } = await panel((_path, method) => {
    if (method === "PUT") throw Error("plugin_revision_conflict");
    if (removed)
      return { catalog, installed: [], configuration_revisions: { [id]: "8" } };
  });
  c.draft.value[id].format = "minutes";
  removed = true;
  await c.run("load", c.load);
  expect(c.draftRevision.value[id]).toBe("7");
  expect(c.currentRevision(id)).toBe("8");
  await c.run(id, () => c.save(id));
  expect(
    api.mock.calls.find(([, method]) => method === "PUT")?.[2]
      .expected_revision,
  ).toBe("7");
  expect(c.error.value).toContain("plugin_revision_conflict");
  c.resetDraft(id);
  expect(c.draftRevision.value[id]).toBe("8");
  expect(c.draft.value[id].grant).toBe(false);
});
it("blocks repeated delete, cancellation, and retargeting while a mutation is pending", async () => {
  const response = deferred<any>();
  const { c, api } = await panel((_path, method) =>
    method === "DELETE" ? response.promise : undefined,
  );
  c.askRemove(id);
  const pending = c.removeConfiguration();
  await vi.waitFor(() => expect(c.busy.value).toBe(id));
  c.closeRemoval();
  c.askRemove(catalog[1].id);
  await c.removeConfiguration();
  expect(c.removal.value.id).toBe(id);
  expect(
    api.mock.calls.filter(([, method]) => method === "DELETE"),
  ).toHaveLength(1);
  response.resolve({ id, removed: true, revision: "8" });
  await pending;
});
it("shows a failed removal in the confirmation without losing configuration or drafts", async () => {
  const { c } = await panel((_path, method) => {
    if (method === "DELETE") throw Error("plugin_revision_conflict");
  });
  c.draft.value[id].format = "minutes";
  c.askRemove(id);
  await c.removeConfiguration();
  expect(c.removal.value.revision).toBe("7");
  expect(c.removalError.value).toContain("plugin_revision_conflict");
  expect(c.installed.value[id]).toEqual(saved);
  expect(c.draft.value[id].format).toBe("minutes");
  expect(c.message.value).toBe("");
  expect(c.busy.value).toBe("");
});
it("does not report a malformed delete response as successful", async () => {
  const { c } = await panel((_path, method) =>
    method === "DELETE"
      ? { id: "other", removed: true, revision: "8" }
      : undefined,
  );
  c.askRemove(id);
  await c.removeConfiguration();
  expect(c.installed.value[id]).toEqual(saved);
  expect(c.removalError.value).toContain("删除结果未确认");
  expect(c.message.value).toBe("");
});
it("ignores deletion receipts after an authentication scope change", async () => {
  const response = deferred<any>();
  const { c, session } = await panel((_path, method) =>
    method === "DELETE" ? response.promise : undefined,
  );
  c.askRemove(id);
  const pending = c.removeConfiguration();
  session.accept({
    id: "another",
    username: "another",
    admin: true,
    csrf: "new",
  });
  await nextTick();
  response.resolve({ id, removed: true, revision: "8" });
  await pending;
  expect(c.removal.value).toBeNull();
  expect(c.configurationRevisions.value).toEqual({});
  expect(c.message.value).toBe("");
});
it("ignores deletion receipts after unmount", async () => {
  const response = deferred<any>();
  const { c, unmount } = await panel((_path, method) =>
    method === "DELETE" ? response.promise : undefined,
  );
  c.askRemove(id);
  const pending = c.removeConfiguration();
  unmount();
  cleanups.pop();
  response.resolve({ id, removed: true, revision: "8" });
  await pending;
  expect(c.installed.value[id]).toEqual(saved);
  expect(c.message.value).toBe("");
});
