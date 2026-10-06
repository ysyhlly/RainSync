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
        授权目录读取与允许执行 FFmpeg
        是两个权限。开启后，配套计算进程只执行固定的 HLS 转封装或 480p H.264
        配方；默认一个任务槽、64 MiB 产物上限。
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
                · {{ node.capabilities.join("、") }}</span
              >
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
