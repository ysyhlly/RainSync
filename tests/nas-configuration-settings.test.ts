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
const node = (patch = {}) => ({
  id: "nas-one",
  name: "合成 NAS",
  revoked: false,
  connected: true,
  enabled: false,
  slots: 1,
  output_budget_bytes: 67108864,
  revision: 4,
  healthy: true,
  running: 0,
  capabilities: ["h264_480p_hls_v1"],
  ...patch,
});
const limits = {
  min_slots: 1,
  max_slots: 4,
  min_output_budget_bytes: 1048576,
  max_output_budget_bytes: 1073741824,
  total_output_budget_bytes: 536870912,
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: any) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function mount(file: "AgentsPage" | "ComputePolicyPanel", api: any) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "owner",
    username: "owner",
    csrf: "fixture",
    admin: true,
  });
  session.api = api;
  const p = mountSetup(
    new URL(`../apps/web/src/features/admin/${file}.vue`, import.meta.url),
    {
      useSession,
      StaleIdentity,
      formatDate,
      agentConnectionLabel,
      agentReadinessLabel,
      agentDrainLabel,
      AppDialog: {},
      AppIcon: {},
      Notice: {},
      CopyField: {},
      ComputePolicyPanel: {},
    },
  );
  cleanup.push(p.unmount);
  return { c: p.controls, session, unmount: p.unmount };
}
async function ready(c: any) {
  await vi.waitFor(() => expect((c.loading ?? c.refreshing).value).toBe(false));
}
const writes = (api: any) =>
  api.mock.calls.filter((x: any[]) => x[1] && x[1] !== "GET");
const fixtureApi = (
  initial = node(),
  options: { enabled?: boolean; failRefresh?: boolean } = {},
) => {
  let saved = initial,
    reads = 0;
  return vi.fn(async (_path: string, method = "GET", body?: any) => {
    if (method === "POST") {
      saved = { ...saved, ...body, revision: saved.revision + 1 };
      return saved;
    }
    if (++reads > 1 && options.failRefresh) throw Error("读取暂不可用");
    return { enabled: options.enabled ?? true, nodes: [saved], limits };
  });
};
it("renames an existing NAS in place with its original expected name and keeps the confirmed receipt after a refresh failure", async () => {
  let reads = 0;
  const api = vi.fn(async (_path: string, method = "GET", body?: any) => {
    if (method === "PUT") return { id: "nas-one", name: body.name };
    if (++reads > 1) throw Error("refresh failed");
    return [node()];
  });
  const { c } = mount("AgentsPage", api);
  await ready(c);
  c.edit(c.rows.value[0]);
  c.editName.value = "  新名称  ";
  await c.run(c.saveSettings);
  expect(writes(api)).toEqual([
    ["/agents/nas-one", "PUT", { name: "新名称", expected_name: "合成 NAS" }],
  ]);
  expect(c.rows.value[0].name).toBe("新名称");
  expect(c.settingsOpen.value).toBe(false);
  expect(c.message.value).toContain("名称已保存");
  expect(c.refreshError.value).toContain("无需重复");
});
it("preserves a failed rename draft and cannot overwrite a concurrent administrator's name", async () => {
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "PUT")
      throw Object.assign(Error("conflict"), {
        code: "AGENT_SETTINGS_CONFLICT",
      });
    return [node()];
  });
  const { c } = mount("AgentsPage", api);
  await ready(c);
  c.edit(c.rows.value[0]);
  c.editName.value = "保留草稿";
  await c.run(c.saveSettings);
  expect(c.settingsOpen.value).toBe(true);
  expect(c.editName.value).toBe("保留草稿");
  expect(c.error.value).toContain("其他管理员");
});
it.each(["  ", "x".repeat(121), "a\nb"])(
  "rejects an invalid NAS name before a mutation: %s",
  async (name) => {
    const api = vi.fn(async () => [node()]);
    const { c } = mount("AgentsPage", api);
    await ready(c);
    c.edit(c.rows.value[0]);
    c.editName.value = name;
    await c.run(c.saveSettings);
    expect(writes(api)).toHaveLength(0);
    expect(c.error.value).toContain("1–120");
  },
);
it("suppresses duplicate NAS saves and clears the edit when the session changes", async () => {
  const pending = deferred();
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "PUT" ? pending.promise : [node()],
  );
  const { c, session } = mount("AgentsPage", api);
  await ready(c);
  c.edit(c.rows.value[0]);
  c.editName.value = "pending";
  const work = c.run(c.saveSettings);
  await c.run(c.saveSettings);
  expect(writes(api)).toHaveLength(1);
  session.accept({
    id: "other",
    username: "other",
    csrf: "other",
    admin: true,
  });
  pending.resolve({ id: "nas-one", name: "pending" });
  await work;
  expect(c.rows.value).toEqual([]);
  expect(c.editing.value).toBe(null);
  expect(c.message.value).toBe("");
});
it("quota editing is explicit, uses server bounds and preserves disabled FFmpeg consent", async () => {
  const api = fixtureApi();
  const { c } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(c.nodes.value[0]);
  c.draftSlots.value = "3";
  c.draftBudgetMiB.value = "256";
  expect(writes(api)).toHaveLength(0);
  await c.saveQuota();
  expect(writes(api)).toEqual([
    [
      "/agents/nas-one/compute-policy",
      "POST",
      {
        enabled: false,
        slots: 3,
        output_budget_bytes: 268435456,
        expected_revision: 4,
      },
    ],
  ]);
  expect(c.nodes.value[0].enabled).toBe(false);
  expect(c.nodes.value[0].revision).toBe(5);
  expect(c.message.value).toContain("FFmpeg 授权状态保持不变");
});
it.each([
  [0, 64],
  [5, 64],
  [1.5, 64],
  [1, 0.5],
  [1, 1025],
  ["", 64],
  [1, ""],
  [1, "NaN"],
])(
  "rejects invalid quotas without raising bounds: %s slots/%s MiB",
  async (slots, budget) => {
    const api = fixtureApi();
    const { c } = mount("ComputePolicyPanel", api);
    await ready(c);
    c.openSettings(c.nodes.value[0]);
    c.draftSlots.value = slots;
    c.draftBudgetMiB.value = budget;
    await c.saveQuota();
    expect(writes(api)).toHaveLength(0);
    expect(c.dialogOpen.value).toBe(true);
    expect(c.error.value).toContain("允许范围");
  },
);
it("reset requires confirmation, disables compute, restores defaults and preserves history", async () => {
  const api = fixtureApi(
    node({ enabled: true, slots: 3, output_budget_bytes: 268435456 }),
  );
  const { c } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(c.nodes.value[0]);
  c.mode.value = "reset";
  expect(writes(api)).toHaveLength(0);
  await c.confirm();
  expect(writes(api)[0][2]).toEqual({
    enabled: false,
    slots: 1,
    output_budget_bytes: 67108864,
    expected_revision: 4,
  });
  expect(c.message.value).toContain("任务历史已保留");
});
it("permission changes require a separate review and never inherit unsaved quota edits", async () => {
  const api = fixtureApi();
  const { c } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(c.nodes.value[0]);
  c.draftBudgetMiB.value = 512;
  c.dialogOpen.value = false;
  c.requestChange(c.nodes.value[0]);
  expect(c.mode.value).toBe("authorize");
  expect(writes(api)).toHaveLength(0);
  await c.confirm();
  expect(writes(api)[0][2]).toEqual({
    enabled: true,
    slots: 1,
    output_budget_bytes: 67108864,
    expected_revision: 4,
  });
});
it("retains saved quota after failed refresh and fences stale snapshots using policy revision", async () => {
  const api = fixtureApi(node(), { failRefresh: true });
  const { c } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(c.nodes.value[0]);
  c.draftBudgetMiB.value = 256;
  await c.saveQuota();
  expect(c.nodes.value[0].output_budget_bytes).toBe(268435456);
  expect(c.message.value).toContain("已保存");
  expect(c.error.value).toBe("");
  expect(c.refreshError.value).toContain("无需重复提交");
  api.mockImplementation(async () => ({
    enabled: true,
    nodes: [node()],
    limits,
  }));
  await c.load();
  expect(c.nodes.value[0].output_budget_bytes).toBe(268435456);
  expect(c.nodes.value[0].revision).toBe(5);
});
it("keeps quota drafts and original revision when a concurrent policy update conflicts", async () => {
  const api = vi.fn(async (_path: string, method = "GET") => {
    if (method === "POST")
      throw Object.assign(Error("conflict"), {
        code: "COMPUTE_POLICY_CONFLICT",
      });
    return { enabled: true, nodes: [node()], limits };
  });
  const { c } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(c.nodes.value[0]);
  c.draftBudgetMiB.value = 256;
  await c.saveQuota();
  expect(c.dialogOpen.value).toBe(true);
  expect(c.draftBudgetMiB.value).toBe(256);
  expect(c.selected.value.revision).toBe(4);
  expect(c.error.value).toContain("其他管理员");
});
it("can stop authorization with globally disabled compute and blocks revoked node edits", async () => {
  const api = fixtureApi(node({ enabled: true }), { enabled: false });
  const { c } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(node({ revoked: true }));
  expect(c.dialogOpen.value).toBe(false);
  await c.change(node({ revoked: true }));
  expect(writes(api)).toHaveLength(0);
  c.requestChange(c.nodes.value[0]);
  await c.confirm();
  expect(writes(api)[0][2].enabled).toBe(false);
});
it("suppresses repeated quota submits and ignores mutation/refresh responses after identity change", async () => {
  const pending = deferred();
  const api = vi.fn(async (_path: string, method = "GET") =>
    method === "POST"
      ? pending.promise
      : { enabled: true, nodes: [node()], limits },
  );
  const { c, session } = mount("ComputePolicyPanel", api);
  await ready(c);
  c.openSettings(c.nodes.value[0]);
  c.draftSlots.value = 2;
  const work = c.saveQuota();
  await c.saveQuota();
  expect(writes(api)).toHaveLength(1);
  session.accept({
    id: "other",
    username: "other",
    csrf: "other",
    admin: true,
  });
  pending.resolve({ revision: 5 });
  await work;
  expect(c.nodes.value).toEqual([]);
  expect(c.dialogOpen.value).toBe(false);
  expect(c.message.value).toBe("");
  expect(api.mock.calls).toHaveLength(2);
});
it("revocation copy explicitly preserves records and does not claim a historical delete", () => {
  const source = readFileSync(
    new URL("../apps/web/src/features/admin/AgentsPage.vue", import.meta.url),
    "utf8",
  );
  expect(source).toContain("保留设备记录、媒体索引和任务历史");
  expect(source.replace(/\s+/g, " ")).toContain("不会删除 NAS 上的原文件");
});
