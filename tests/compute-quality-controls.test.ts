import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { mountSetup } from "./helpers/mount-setup";
import { useSession } from "../apps/web/src/features/auth/session.store";

const playbackUrl = new URL(
  "../apps/web/src/features/playback/DistributedComputePanel.vue",
  import.meta.url,
);
const policyUrl = new URL(
  "../apps/web/src/features/admin/ComputePolicyPanel.vue",
  import.meta.url,
);
const recipeIds = [
  "h264_480p_hls_v1",
  "h264_720p_hls_v1",
  "h264_1080p_hls_v1",
  "h264_2160p_hls_v1",
  "remux_hls_v1",
];
const computeReply = (patch = {}) => ({
  enabled: true,
  p2p_enabled: true,
  jobs: [],
  source_probe_ready: true,
  source_audio_tracks: [{ index: 3, label: "中文", language: "zho" }],
  ...patch,
});
const node = (patch = {}) => ({
  id: "node-one",
  name: "合成节点",
  enabled: false,
  healthy: true,
  slots: null,
  output_budget_bytes: null,
  capabilities: ["h264_480p_hls_v1", "remux_hls_v1"],
  running: 0,
  ...patch,
});
function fixture(url: URL, api: any, patch = {}) {
  setActivePinia(createPinia());
  const session = useSession();
  session.accept({
    id: "owner",
    username: "owner",
    admin: true,
    csrf: "fixture",
  });
  session.api = api;
  const callbacks = {
    activate: vi.fn(async () => {}),
    original: vi.fn(async () => {}),
    share: vi.fn(async () => {}),
    stopSharing: vi.fn(async () => {}),
  };
  const panel = mountSetup(
    url,
    {
      useSession,
      AppSelect: {},
      AppDialog: {},
      AppIcon: {},
      Notice: {},
      Hls: { isSupported: () => true },
    },
    url === playbackUrl
      ? {
          roomId: "room-one",
          mediaGeneration: 7,
          sharing: false,
          ...callbacks,
          ...patch,
        }
      : {},
  );
  return { ...panel, ...callbacks, session };
}

async function playback(api: any, props = {}) {
  const p = fixture(playbackUrl, api, props);
  await vi.waitFor(() => expect(p.controls.loaded.value).toBe(true));
  return p;
}

async function policy(api: any) {
  const p = fixture(policyUrl, api);
  await vi.waitFor(() => expect(p.controls.loading.value).toBe(false));
  return p;
}

describe("NAS compute recipe controls", () => {
  it("offers the five exact recipes and preserves the 480p default and explicit room activation", async () => {
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "POST" ? { id: "job-one" } : computeReply(),
    );
    const p = await playback(api);
    try {
      const c = p.controls;
      expect(c.recipe.value).toBe("h264_480p_hls_v1");
      expect(c.recipeOptions.map((option: any) => option.value)).toEqual(
        recipeIds,
      );
      expect(
        c.recipeOptions.find((option: any) => option.value === recipeIds[3])
          .label,
      ).toContain("2160p / UHD");
      for (const recipe of recipeIds) {
        c.recipe.value = recipe;
        await c.prepare();
        expect(api).toHaveBeenCalledWith("/rooms/room-one/compute", "POST", {
          media_generation: 7,
          recipe,
          audio_index: 3,
        });
      }
      expect(p.activate).not.toHaveBeenCalled();
      expect(p.share).not.toHaveBeenCalled();
      expect(
        api.mock.calls.filter(([path]) => path.includes("compute-policy")),
      ).toHaveLength(0);
    } finally {
      p.unmount();
    }
  });

  it("keeps disabled compute closed without sending a prepare or source-probe request", async () => {
    const api = vi.fn(async () => computeReply({ enabled: false }));
    const p = await playback(api);
    try {
      p.controls.recipe.value = "h264_2160p_hls_v1";
      await p.controls.prepare();
      await p.controls.act(p.controls.probeSource);
      expect(p.controls.enabled.value).toBe(false);
      expect(p.controls.error.value).toBe("服务器未开启 NAS 本地计算");
      expect(
        api.mock.calls.filter(([, method]) => method === "POST"),
      ).toHaveLength(0);
    } finally {
      p.unmount();
    }
  });

  it.each([
    "当前节点未上报所选计算配方",
    "计算产物超出节点预算",
    "计算节点没有空闲任务槽",
  ])(
    "shows server admission failure without silently selecting a lower recipe: %s",
    async (message) => {
      const api = vi.fn(async (_path: string, method = "GET") => {
        if (method === "POST") throw Error(message);
        return computeReply();
      });
      const p = await playback(api);
      try {
        p.controls.recipe.value = "h264_2160p_hls_v1";
        await p.controls.prepare();
        expect(p.controls.recipe.value).toBe("h264_2160p_hls_v1");
        expect(p.controls.error.value).toBe(message);
        expect(p.controls.selected.value).toBe("");
        expect(p.activate).not.toHaveBeenCalled();
      } finally {
        p.unmount();
      }
    },
  );

  it("preserves explicit source audio and output-generation qualification for every resolution", async () => {
    const job = {
      id: "job-ready",
      status: "ready",
      recipe: "h264_2160p_hls_v1",
      attempt: 1,
      output_generation: "generation-one",
      primary_qualified: true,
      selected_audio_index: 0,
    };
    const api = vi.fn(async (_path: string, method = "GET") =>
      method === "POST" ? { id: job.id } : computeReply({ jobs: [job] }),
    );
    const p = await playback(api);
    try {
      const c = p.controls;
      c.audioChoice.value = "0";
      c.recipe.value = "h264_2160p_hls_v1";
      await c.prepare();
      expect(api).toHaveBeenCalledWith("/rooms/room-one/compute", "POST", {
        media_generation: 7,
        recipe: "h264_2160p_hls_v1",
        audio_index: 0,
      });
      expect(c.jobOptions.value[1].label).toContain("2160p / UHD");
      c.jobs.value[0].primary_qualified = false;
      await c.activate();
      expect(p.activate).not.toHaveBeenCalled();
      c.jobs.value[0].primary_qualified = true;
      await c.activate();
      expect(p.activate).toHaveBeenCalledWith(
        {
          schema_version: 1,
          job_id: job.id,
          output_generation: "generation-one",
        },
        0,
      );
    } finally {
      p.unmount();
    }
  });

  it("still requires all three P2P consents and resets them when sharing stops", async () => {
    const p = await playback(
      vi.fn(async () => computeReply()),
      { activeJob: "job-one", sharing: true },
    );
    try {
      const c = p.controls;
      expect([c.addresses.value, c.network.value, c.upload.value]).toEqual([
        false,
        false,
        false,
      ]);
      for (const bits of [
        [false, true, true],
        [true, false, true],
        [true, true, false],
      ]) {
        [c.addresses.value, c.network.value, c.upload.value] = bits;
        await c.share();
        expect(p.share).not.toHaveBeenCalled();
      }
      c.addresses.value = c.network.value = c.upload.value = true;
      await c.share();
      expect(p.share).toHaveBeenCalledExactlyOnceWith({
        acknowledge_peer_addresses: true,
        confirm_current_network: true,
        upload_allowed: true,
      });
      p.setProps({ sharing: false });
      await nextTick();
      expect([c.addresses.value, c.network.value, c.upload.value]).toEqual([
        false,
        false,
        false,
      ]);
    } finally {
      p.unmount();
    }
  });

  it.each(["identity", "room", "media"])(
    "clears consent and rejects a stale prepare result after %s changes",
    async (change) => {
      let finish!: (value: unknown) => void;
      const api = vi.fn(async (_path: string, method = "GET") => {
        if (method === "POST")
          return await new Promise((resolve) => {
            finish = resolve;
          });
        return computeReply();
      });
      const p = await playback(api);
      try {
        const c = p.controls;
        c.addresses.value = c.network.value = c.upload.value = true;
        const preparation = c.prepare();
        await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
        if (change === "identity")
          p.session.accept({
            id: "other",
            username: "other",
            admin: true,
            csrf: "new",
          });
        else
          p.setProps(
            change === "room" ? { roomId: "room-two" } : { mediaGeneration: 8 },
          );
        await nextTick();
        finish({ id: "stale-job" });
        await preparation;
        expect(c.selected.value).toBe("");
        expect([c.addresses.value, c.network.value, c.upload.value]).toEqual([
          false,
          false,
          false,
        ]);
        expect(p.activate).not.toHaveBeenCalled();
      } finally {
        p.unmount();
      }
    },
  );

  it("uses accessible shared selectors and explains capability, budget and disabled limits", () => {
    const source = readFileSync(playbackUrl, "utf8").replace(/\s+/g, " ");
    expect(source.match(/<AppSelect/g)).toHaveLength(3);
    for (const label of ["计算配方", "原片音轨", "房间内计算产物"])
      expect(source).toContain(`label="${label}"`);
    expect(source).toContain('v-if="loaded && !enabled"');
    expect(source).toContain('v-if="error" role="alert"');
    expect(source).toContain("用于房间主播放器");
    expect(source).toContain("不放大小尺寸原片");
    expect(source).toContain("默认 1 个任务槽、64 MiB");
    expect(source).toContain("尚未上报的旧节点不能执行 4K");
    expect(source).toContain("源时长与执行超时限制");
    expect(source.match(/type="checkbox"/g)).toHaveLength(3);
  });
});

describe("NAS compute node capability and budget guidance", () => {
  it("reports only advertised capabilities and explicitly identifies missing HD/4K support", async () => {
    const old = node(),
      missing = node({ capabilities: null }),
      capable = node({ capabilities: recipeIds });
    const p = await policy(
      vi.fn(async () => ({ enabled: true, nodes: [old, missing, capable] })),
    );
    try {
      const c = p.controls;
      expect(c.capabilityLabels(old)).toEqual([
        "480p H.264",
        "HLS 转封装（最高 1080p）",
      ]);
      expect(c.missingHdRecipes(old)).toEqual([
        "720p H.264",
        "1080p H.264",
        "4K H.264（2160p / UHD）",
      ]);
      expect(c.capabilityLabels(missing)).toEqual([]);
      expect(c.missingHdRecipes(capable)).toEqual([]);
    } finally {
      p.unmount();
    }
  });

  it.each([
    {
      slots: null,
      output_budget_bytes: null,
      expectedSlots: 1,
      expectedBytes: 67108864,
      label: "64 MiB",
    },
    {
      slots: 2,
      output_budget_bytes: 268435456,
      expectedSlots: 2,
      expectedBytes: 268435456,
      label: "256 MiB",
    },
  ])(
    "shows the current budget and never silently expands it when authorizing: $label",
    async (quota) => {
      const current = node(quota);
      const api = vi.fn(async (_path: string, method = "GET") =>
        method === "POST" ? { ok: true } : { enabled: true, nodes: [current] },
      );
      const p = await policy(api);
      try {
        expect(p.controls.budgetLabel(current)).toBe(quota.label);
        await p.controls.change(current);
        expect(api).toHaveBeenCalledWith(
          "/agents/node-one/compute-policy",
          "POST",
          {
            enabled: true,
            slots: quota.expectedSlots,
            output_budget_bytes: quota.expectedBytes,
          },
        );
      } finally {
        p.unmount();
      }
    },
  );

  it("keeps disabled policy actions and missing capability/budget warnings in the rendered template", () => {
    const source = readFileSync(policyUrl, "utf8").replace(/\s+/g, " ");
    expect(source).toContain("node.revoked || (!enabled && !node.enabled)");
    expect(source).toContain('@click="requestChange(node)"');
    expect(source).toContain('v-if="!node.capabilities?.length"');
    expect(source).toContain('v-else-if="missingHdRecipes(node).length"');
    expect(source).toContain("当前配额：");
    expect(source).toContain("选择更高清配方不会自动增加配额");
    expect(source).toContain("启用授权只沿用当前配额");
    expect(source).toContain("当前产物预算不超过默认 64 MiB");
  });
});

describe("bounded NAS compute job diagnostics", () => {
  it.each([
    ["compute_output_budget_insufficient", "queued", "产物预算不足"],
    ["compute_output_budget_exceeded", "failed", "实际产物超出节点预算"],
    ["compute_global_budget_exceeded", "failed", "服务器计算产物空间不足"],
    ["compute_source_too_large", "failed", "原片超过计算输入大小限制"],
    ["compute_source_duration_unsupported", "failed", "超过 30 分钟"],
    ["node_execution_failed", "failed", "节点计算失败"],
  ])(
    "explains %s only for the selected job",
    async (error, status, expected) => {
      const job = {
        id: "job-blocked",
        recipe: "h264_2160p_hls_v1",
        status,
        error,
        attempt: 1,
        primary_qualified: false,
        selected_audio_index: 3,
      };
      const p = await playback(
        vi.fn(async () => computeReply({ jobs: [job] })),
      );
      try {
        expect(p.controls.selectedJobDiagnostic.value).toBe("");
        p.controls.selected.value = job.id;
        expect(p.controls.selectedJobDiagnostic.value).toContain(expected);
        expect(p.controls.selectedJobDiagnostic.value).not.toContain(error);
        p.controls.selected.value = "other-job";
        expect(p.controls.selectedJobDiagnostic.value).toBe("");
      } finally {
        p.unmount();
      }
    },
  );

  it("never displays raw unknown errors or inherited object keys, and tolerates old responses", async () => {
    const job = {
      id: "job-one",
      recipe: "h264_2160p_hls_v1",
      status: "failed",
      attempt: 1,
      primary_qualified: false,
      selected_audio_index: null,
    };
    const p = await playback(vi.fn(async () => computeReply({ jobs: [job] })));
    try {
      const c = p.controls;
      c.selected.value = job.id;
      expect(c.selectedJobDiagnostic.value).toBe("");
      for (const error of [
        "raw stderr with private file path",
        "__proto__",
        "constructor",
        "toString",
      ]) {
        c.jobs.value[0].error = error;
        expect(c.selectedJobDiagnostic.value).toBe(
          "计算任务未完成。请检查节点状态与任务限制。",
        );
        expect(c.jobOptions.value[1].label).not.toContain(error);
      }
      c.jobs.value[0].error = null;
      expect(c.selectedJobDiagnostic.value).toBe("");
      c.jobs.value[0].error = "compute_output_budget_insufficient";
      c.jobs.value[0].status = "ready";
      expect(c.selectedJobDiagnostic.value).toBe("");
      const source = readFileSync(playbackUrl, "utf8").replace(/\s+/g, " ");
      expect(source).toContain(
        'v-if="selectedJobDiagnostic" class="helper" role="status"',
      );
    } finally {
      p.unmount();
    }
  });
});
