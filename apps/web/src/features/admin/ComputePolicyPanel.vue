<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
interface Node {
  id: string;
  name: string;
  enabled: boolean;
  healthy: boolean;
  slots: number | null;
  output_budget_bytes: number | null;
  capabilities: string[] | null;
  running: number;
}
const session = useSession(),
  nodes = ref<Node[]>([]),
  enabled = ref(false),
  loaded = ref(false),
  loading = ref(false),
  busy = ref(false),
  error = ref("");
const recipeLabels: Record<string, string> = {
  remux_hls_v1: "HLS 转封装（最高 1080p）",
  h264_480p_hls_v1: "480p H.264",
  h264_720p_hls_v1: "720p H.264",
  h264_1080p_hls_v1: "1080p H.264",
  h264_2160p_hls_v1: "4K H.264（2160p / UHD）",
};
function capabilityLabels(node: Node) {
  return (
    node.capabilities?.map((recipe) => recipeLabels[recipe] ?? recipe) ?? []
  );
}
function missingHdRecipes(node: Node) {
  return ["h264_720p_hls_v1", "h264_1080p_hls_v1", "h264_2160p_hls_v1"]
    .filter((recipe) => !node.capabilities?.includes(recipe))
    .map((recipe) => recipeLabels[recipe]);
}
function budgetLabel(node: Node) {
  const bytes = node.output_budget_bytes ?? 67108864;
  return `${Number((bytes / 1048576).toFixed(2))} MiB`;
}
let live = true;
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const result = await session.api<{ enabled: boolean; nodes: Node[] }>(
      "/agents/compute",
    );
    if (live) {
      nodes.value = result.nodes;
      enabled.value = result.enabled;
      loaded.value = true;
    }
  } catch (e) {
    if (live) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (live) loading.value = false;
  }
}
async function change(node: Node) {
  busy.value = true;
  error.value = "";
  try {
    await session.api(`/agents/${node.id}/compute-policy`, "POST", {
      enabled: !node.enabled,
      slots: node.slots ?? 1,
      output_budget_bytes: node.output_budget_bytes ?? 67108864,
    });
    await load();
  } catch (e) {
    if (live) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (live) busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  live = false;
});
</script>
<template>
  <details class="compute-policy-panel surface-card surface-card--compact">
    <summary>NAS 本地计算（需单独授权）</summary>
    <div class="compute-policy-body" :aria-busy="loading || busy">
      <p class="helper">
        授权目录读取与允许执行 FFmpeg 是两个权限。配套计算进程仅执行固定的 HLS
        转封装和 480p、720p、1080p、 4K（2160p / UHD）H.264
        配方，保留原片比例、不放大原片。默认一个任务槽、 64 MiB
        产物上限；选择更高清配方不会自动增加配额。
      </p>
      <p class="helper">
        仅能调度节点实测并上报的配方；旧节点未上报 4K
        能力时不会被当作可执行节点。
        编码能力、空闲任务槽、产物预算、源时长与执行超时都可能阻止任务。
        调整预算需单独配置，启用授权只沿用当前配额。
      </p>
      <p v-if="loaded && !enabled" class="helper">
        服务器尚未配置专用计算产物目录，本地计算保持关闭。
      </p>
      <div class="button-row">
        <button :disabled="busy || loading" @click="load">
          <AppIcon name="refresh" />{{
            loading ? "正在刷新节点…" : "刷新计算节点"
          }}
        </button>
      </div>
      <Notice :message="error" error />
      <p
        v-if="loading && !loaded"
        class="loading-state loading-state--inline"
        role="status"
      >
        正在加载计算节点…
      </p>
      <p
        v-else-if="loaded && !error && !nodes?.length"
        class="helper"
        role="status"
      >
        暂无计算节点。设备连接并上报计算能力后，可在这里单独授权。
      </p>
      <div v-if="nodes?.length" class="data-list">
        <article v-for="node in nodes" :key="node.id" class="admin-row">
          <div class="row-main">
            <div class="section-heading">
              <h3>{{ node.name }}</h3>
              <span
                class="status-badge"
                :class="{ 'status-badge--success': node.enabled }"
              >
                {{ node.enabled ? "已允许计算" : "未允许计算" }}
              </span>
            </div>
            <p class="helper">
              {{ node.healthy ? "最近心跳正常" : "没有有效计算心跳" }} · 执行中
              {{ node.running }}
              <span v-if="node.capabilities?.length">
                · 已上报：{{ capabilityLabels(node).join("、") }}</span
              >
            </p>
            <p class="helper">
              当前配额：{{ node.slots ?? 1 }} 个任务槽 ·
              {{ budgetLabel(node) }} 产物上限
            </p>
            <p v-if="!node.capabilities?.length" class="helper">
              尚未上报可执行配方。请先确认配套进程版本、FFmpeg
              编码能力与计算心跳。
            </p>
            <p v-else-if="missingHdRecipes(node).length" class="helper">
              尚未上报：{{
                missingHdRecipes(node).join("、")
              }}。授权不会补齐这些能力。
            </p>
            <p
              v-if="(node.output_budget_bytes ?? 67108864) <= 67108864"
              class="helper"
            >
              当前产物预算不超过默认 64 MiB，高清任务尤其是较长的 4K
              产物可能无法容纳。
            </p>
          </div>
          <button :disabled="busy || loading || !enabled" @click="change(node)">
            {{ node.enabled ? "停止计算授权" : "允许固定配方计算" }}
          </button>
        </article>
      </div>
    </div>
  </details>
</template>
<style scoped>
.compute-policy-body {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-3);
}
</style>
