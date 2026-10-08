import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";
import { StaleIdentity } from "../apps/web/src/shared/api/client";
import { formatDate } from "../apps/web/src/shared/use-action";
import {
  agentConnectionLabel,
  agentReadinessLabel,
  agentDrainLabel,
} from "../apps/web/src/features/admin/agent-readiness";

const duration = "metadata.duration-badge",
  note = "metadata.viewer-note";
const catalog = [duration, note].map((id) => ({
  id,
  name: id,
  description: "合成测试目录",
  versions: [{ version: "1.0.0", artifact_digest: "synthetic" }],
}));
const plugin = (id: string, revision = "7", overrides = {}) => ({
  id,
  version: "1.0.0",
  enabled: true,
  config: id === duration ? { format: "minutes" } : { label: "saved note" },
  revision,
  granted_permissions: ["metadata:read"],
  can_rollback: true,
  ...overrides,
});
const agent = {
  id: "nas-one",
  name: "合成设备",
  revoked: false,
  connected: true,
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((unmount) => unmount());
});
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function panel(file: "PluginsPage" | "AgentsPage", api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "fixture",
    username: "fixture",
    admin: true,
    csrf: "fixture",
  });
  session.api = api;
  const mounted = mountSetup(
    new URL(
      `../apps/web/src/features/${file === "PluginsPage" ? "plugins" : "admin"}/${file}.vue`,
      import.meta.url,
    ),
    {
      useSession,
      StaleIdentity,
      formatDate,
      agentConnectionLabel,
      agentReadinessLabel,
      agentDrainLabel,
      ComputePolicyPanel: {},
      AppDialog: {},
      AppSelect: {},
      AppIcon: {},
      Notice: {},
      CopyField: {},
    },
  );
  cleanup.push(mounted.unmount);
  return { c: mounted.controls, session, unmount: mounted.unmount };
}
async function ready(c: any) {
  await vi.waitFor(() => {
    expect(c.busy.value).toBe(c.catalog ? "" : false);
    if (c.refreshing) expect(c.refreshing.value).toBe(false);
  });
}
const mutations = (api: any, method: string) =>
  api.mock.calls.filter((call: any[]) => call[1] === method);

it("rollback preserves another plugin's dirty draft and its original revision after concurrent server edits", async () => {
  const rollback = deferred(),
    refresh = deferred();
  const restored = plugin(duration, "8", {
    config: { format: "clock" },
    can_rollback: false,
  });
  let reads = 0;
  const api = vi.fn(async (path: string, method = "GET", body?: any) => {
    if (path === "/media") return [];
    if (method === "POST") return rollback.promise;
    if (method === "PUT") {
      expect(body.expected_revision).toBe("7");
      throw Error("plugin_revision_conflict");
    }
    if (++reads === 1)
      return { catalog, installed: [plugin(duration), plugin(note)] };
    return refresh.promise;
  });
  const { c } = panel("PluginsPage", api);
  await ready(c);
  c.draft.value[note].label = "keep this unsaved note";
  c.draft.value[duration].format = "unsaved target";
  const work = c.run(duration, () => c.rollback(duration));
  await c.run(duration, () => c.rollback(duration));
  expect(mutations(api, "POST")).toHaveLength(1);
  rollback.resolve(restored);
  await vi.waitFor(() => expect(reads).toBe(2));
  expect(c.message.value).toContain("已恢复");
  expect(c.draft.value[duration].format).toBe("clock");
  expect(c.draft.value[note].label).toBe("keep this unsaved note");
  refresh.resolve({
    catalog,
    installed: [
      restored,
      plugin(note, "9", { config: { label: "concurrent server edit" } }),
    ],
  });
  await work;
  expect(c.installed.value[note].revision).toBe("9");
  expect(c.draft.value[note].label).toBe("keep this unsaved note");
  expect(c.draftRevision.value[note]).toBe("7");
  await c.run(note, () => c.save(note));
  expect(mutations(api, "PUT")[0][2]).toMatchObject({
    expected_revision: "7",
    config: { label: "keep this unsaved note" },
    granted_permissions: ["metadata:read"],
  });
  expect(c.error.value).toBe("plugin_revision_conflict");
  expect(c.draft.value[note].label).toBe("keep this unsaved note");
  c.resetDraft(note);
  expect(c.draft.value[note].label).toBe("concurrent server edit");
  expect(c.draftRevision.value[note]).toBe("9");
});

it("catalog refresh updates clean drafts but retains an uninstalled dirty draft's zero revision", async () => {
  const refresh = deferred();
  let reads = 0;
  const api = vi.fn(async (path: string, method = "GET") => {
    if (path === "/media") return [];
    if (method === "PUT") throw Error("plugin_revision_conflict");
    if (++reads === 1) return { catalog, installed: [plugin(duration)] };
    return refresh.promise;
  });
  const { c } = panel("PluginsPage", api);
  await ready(c);
  c.draft.value[note].grant = true;
  c.draft.value[note].label = "new local plugin";
  const work = c.run("load", c.load);
  refresh.resolve({
    catalog,
    installed: [
      plugin(duration, "8", { config: { format: "clock" } }),
      plugin(note, "1"),
    ],
  });
  await work;
  expect(c.draft.value[duration].format).toBe("clock");
  expect(c.draftRevision.value[duration]).toBe("8");
  expect(c.draftRevision.value[note]).toBe("0");
  await c.run(note, () => c.save(note));
  expect(mutations(api, "PUT")[0][2].expected_revision).toBe("0");
});

it("accepted rollback retains its receipt on failed refresh and retry reads without repeating rollback", async () => {
  const refresh = deferred();
  const restored = plugin(duration, "8", {
    config: { format: "clock" },
    can_rollback: false,
  });
  let reads = 0;
  const api = vi.fn(async (path: string, method = "GET") => {
    if (path === "/media") return [];
    if (method === "POST") return restored;
    if (++reads === 1)
      return { catalog, installed: [plugin(duration), plugin(note)] };
    if (reads === 2) return refresh.promise;
    return { catalog, installed: [restored, plugin(note)] };
  });
  const { c } = panel("PluginsPage", api);
  await ready(c);
  const work = c.run(duration, () => c.rollback(duration));
  await vi.waitFor(() => expect(reads).toBe(2));
  refresh.reject(Error("catalog refresh failed"));
  await work;
  expect(c.message.value).toContain("已恢复");
  expect(c.error.value).toContain("目录刷新失败");
  expect(c.installed.value[duration]).toEqual(restored);
  await c.rollback(duration);
  await c.run("load", c.load);
  expect(c.message.value).toContain("已恢复");
  expect(c.error.value).toBe("");
  expect(mutations(api, "POST")).toHaveLength(1);
  expect(reads).toBe(3);
});

it("plugin permission and account changes retire drafts and ignore deferred old-account rollback", async () => {
  const rollback = deferred();
  const api = vi.fn(async (path: string, method = "GET") => {
    if (path === "/media") return [];
    if (method === "POST") return rollback.promise;
    return { catalog, installed: [plugin(duration), plugin(note)] };
  });
  const { c, session } = panel("PluginsPage", api);
  await ready(c);
  c.draft.value[note].grant = false;
  await expect(c.save(note)).rejects.toThrow("metadata:read");
  expect(mutations(api, "PUT")).toHaveLength(0);
  const work = c.run(duration, () => c.rollback(duration));
  session.accept({
    id: "fixture",
    username: "fixture",
    admin: false,
    csrf: "fixture",
  });
  expect(c.draft.value).toEqual({});
  rollback.resolve(plugin(duration, "8"));
  await work;
  expect(c.installed.value).toEqual({});
  expect(c.message.value).toBe("");
  expect(
    api.mock.calls.filter(([path]) => path === "/admin/plugins"),
  ).toHaveLength(1);
});

it("accepted NAS revoke applies immediately, survives failed list refresh, and retries only reads", async () => {
  const revoke = deferred(),
    refresh = deferred(),
    retry = deferred();
  let reads = 0;
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "DELETE") return revoke.promise;
    if (++reads === 1) return [agent];
    return reads === 2 ? refresh.promise : retry.promise;
  });
  const { c } = panel("AgentsPage", api);
  await ready(c);
  c.revoking.value = c.rows.value[0];
  c.revokeOpen.value = true;
  const work = c.run(c.revoke);
  await c.run(c.revoke);
  expect(mutations(api, "DELETE")).toHaveLength(1);
  revoke.resolve({ ok: true });
  await vi.waitFor(() => expect(reads).toBe(2));
  expect(c.rows.value[0].revoked).toBe(true);
  expect(agentConnectionLabel(c.rows.value[0])).toBe("已撤销");
  expect(c.revoking.value).toBeNull();
  expect(c.revokeOpen.value).toBe(false);
  expect(c.message.value).toContain("设备已撤销");
  refresh.reject(Error("device refresh failed"));
  await work;
  expect(c.error.value).toBe("");
  expect(c.refreshError.value).toContain("device refresh failed");
  await c.run(c.revoke);
  expect(c.message.value).toContain("设备已撤销");
  const read = c.load();
  expect(c.message.value).toContain("设备已撤销");
  retry.resolve([agent]); // Even a stale replica cannot reactivate confirmed revocation.
  await read;
  expect(c.rows.value[0].revoked).toBe(true);
  expect(c.rows.value[0].connected).toBe(false);
  expect(c.refreshError.value).toBe("");
  expect(mutations(api, "DELETE")).toHaveLength(1);
  expect(reads).toBe(3);
});

it("failed revoke preserves confirmation without claiming success and cancellation prevents a write", async () => {
  const mutation = deferred();
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "DELETE" ? mutation.promise : [agent],
  );
  const { c } = panel("AgentsPage", api);
  await ready(c);
  c.revoking.value = c.rows.value[0];
  c.revokeOpen.value = false;
  await c.run(c.revoke);
  expect(mutations(api, "DELETE")).toHaveLength(0);
  c.revokeOpen.value = true;
  const work = c.run(c.revoke);
  mutation.reject(Error("revoke failed"));
  await work;
  expect(c.revokeOpen.value).toBe(true);
  expect(c.rows.value[0].revoked).toBe(false);
  expect(c.message.value).toBe("");
  expect(c.error.value).toBe("revoke failed");
  expect(api.mock.calls.filter(([, method]) => !method)).toHaveLength(1);
});

it("generated NAS code and success stay visible alongside refresh failure and read-only retry", async () => {
  const creation = deferred(),
    refresh = deferred(),
    retry = deferred();
  let reads = 0;
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "POST") return creation.promise;
    if (++reads === 1) return [];
    return reads === 2 ? refresh.promise : retry.promise;
  });
  const { c } = panel("AgentsPage", api);
  await ready(c);
  c.open.value = true;
  c.name.value = "合成 NAS";
  const work = c.run(c.create);
  await c.run(c.create);
  expect(mutations(api, "POST")).toHaveLength(1);
  creation.resolve({ id: agent.id, pair_code: "SYNTHETIC-CODE" });
  await vi.waitFor(() => expect(reads).toBe(2));
  expect(c.code.value).toBe("SYNTHETIC-CODE");
  expect(c.message.value).toContain("配对码已生成");
  refresh.reject(Error("device refresh failed"));
  await work;
  expect(c.open.value).toBe(true);
  expect(c.refreshError.value).toContain("device refresh failed");
  expect(c.error.value).toBe("");
  expect(c.remaining.value).toBeGreaterThan(0);
  await c.run(c.create);
  expect(c.message.value).toContain("配对码已生成");
  const read = c.load();
  retry.resolve([agent]);
  await read;
  expect(c.code.value).toBe("SYNTHETIC-CODE");
  expect(c.message.value).toContain("配对码已生成");
  expect(c.refreshError.value).toBe("");
  expect(mutations(api, "POST")).toHaveLength(1);
  expect(mutations(api, "POST")[0].slice(0, 3)).toEqual([
    "/agents",
    "POST",
    { name: "合成 NAS" },
  ]);
  c.open.value = false;
  expect(c.code.value).toBe("");
  expect(c.remaining.value).toBe(0);
  expect(c.name.value).toBe("");
});

it("pairing drawer puts refresh error and read-only retry outside both result branches", () => {
  const source = readFileSync(
    new URL("../apps/web/src/features/admin/AgentsPage.vue", import.meta.url),
    "utf8",
  );
  const drawer = source.slice(source.indexOf('<AppDialog v-model="open"'));
  const codeBranch = drawer.indexOf('<template v-if="code"');
  expect(codeBranch).toBeGreaterThan(0);
  expect(drawer.slice(0, codeBranch)).toContain(
    '<Notice :message="refreshError" error />',
  );
  expect(drawer.slice(0, codeBranch)).toContain(
    '<Notice :message="message" />',
  );
  expect(drawer.slice(0, codeBranch)).toContain('@click="load"');
});

it.each(["create", "revoke"])(
  "account replacement fences deferred NAS %s results and follow-up reads",
  async (operation) => {
    const mutation = deferred();
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "GET" ? [agent] : mutation.promise,
    );
    const { c, session } = panel("AgentsPage", api);
    await ready(c);
    c.open.value = operation === "create";
    c.name.value = "old-account draft";
    c.revoking.value = c.rows.value[0];
    c.revokeOpen.value = operation === "revoke";
    const work = c.run(c[operation]);
    session.accept({
      id: "other",
      username: "other",
      admin: true,
      csrf: "other",
    });
    expect(c.rows.value).toEqual([]);
    expect(c.name.value).toBe("");
    expect(c.revoking.value).toBeNull();
    mutation.resolve({ id: agent.id, pair_code: "OLD-ACCOUNT-CODE" });
    await work;
    expect(c.code.value).toBe("");
    expect(c.rows.value).toEqual([]);
    expect(c.message.value).toBe("");
    expect(c.open.value).toBe(false);
    expect(c.revokeOpen.value).toBe(false);
    expect(api.mock.calls).toHaveLength(2);
  },
);

it("NAS refresh is latest-request-wins and an old account's failed read stays silent", async () => {
  const old = deferred(),
    newer = deferred(),
    oldAccount = deferred();
  let reads = 0;
  const api = vi.fn(async () => {
    if (++reads === 1) return [];
    return reads === 2
      ? old.promise
      : reads === 3
        ? newer.promise
        : oldAccount.promise;
  });
  const { c, session } = panel("AgentsPage", api);
  await ready(c);
  const first = c.load(),
    second = c.load();
  newer.resolve([{ ...agent, name: "newer" }]);
  await second;
  old.resolve([{ ...agent, name: "older" }]);
  await first;
  expect(c.rows.value[0].name).toBe("newer");
  const third = c.load();
  session.clear();
  oldAccount.reject(Error("old-account read failed"));
  await third;
  expect(c.rows.value).toEqual([]);
  expect(c.refreshError.value).toBe("");
});

it("closing a pairing drawer during a deferred creation cannot restore its sensitive code", async () => {
  const creation = deferred();
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "POST" ? creation.promise : [],
  );
  const { c } = panel("AgentsPage", api);
  await ready(c);
  c.open.value = true;
  c.name.value = "synthetic";
  const work = c.run(c.create);
  c.open.value = false;
  c.open.value = true;
  creation.resolve({ id: agent.id, pair_code: "OLD-DIALOG-CODE" });
  await work;
  expect(c.code.value).toBe("");
  expect(c.remaining.value).toBe(0);
});

it("profile edits preserve a pairing code but rotating the same account's login clears it", async () => {
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "POST" ? { id: agent.id, pair_code: "SYNTHETIC-CODE" } : [],
  );
  const { c, session } = panel("AgentsPage", api);
  await ready(c);
  c.open.value = true;
  c.name.value = "synthetic";
  await c.run(c.create);
  session.updateProfile(
    { display_name: "new nickname", custom_display_name: "new nickname" },
    "fixture",
  );
  expect(c.code.value).toBe("SYNTHETIC-CODE");
  session.accept({
    id: "fixture",
    username: "fixture",
    admin: true,
    csrf: "different-login",
  });
  expect(c.code.value).toBe("");
  expect(c.open.value).toBe(false);
  expect(c.message.value).toBe("");
});

it.each(["create", "revoke"])(
  "unmount fences late NAS %s completion without additional reads",
  async (operation) => {
    const mutation = deferred();
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "GET" ? [agent] : mutation.promise,
    );
    const { c, unmount } = panel("AgentsPage", api);
    await ready(c);
    c.open.value = operation === "create";
    c.name.value = "synthetic";
    c.revoking.value = c.rows.value[0];
    c.revokeOpen.value = operation === "revoke";
    const work = c.run(c[operation]);
    cleanup.splice(cleanup.indexOf(unmount), 1);
    unmount();
    mutation.resolve({ id: agent.id, pair_code: "LATE-CODE" });
    await work;
    expect(c.code.value).toBe("");
    expect(c.message.value).toBe("");
    expect(api.mock.calls).toHaveLength(2);
  },
);
