<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useSession } from "../auth/session.store";
import AppIcon from "../../shared/ui/AppIcon.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
interface Node {
  id: string;
  name: string;
  enabled: boolean;
  revoked?: boolean;
  revision?: number;
  healthy: boolean;
  slots: number | null;
  output_budget_bytes: number | null;
  capabilities: string[] | null;
  running: number;
}
interface Limits {
  min_slots: number;
  max_slots: number;
  min_output_budget_bytes: number;
  max_output_budget_bytes: number;
  total_output_budget_bytes?: number;
}
const defaults: Limits = {
  min_slots: 1,
  max_slots: 4,
  min_output_budget_bytes: 1048576,
  max_output_budget_bytes: 1073741824,
};
const session = useSession(),
  nodes = ref<Node[]>([]),
  limits = ref<Limits>({ ...defaults }),
  enabled = ref(false),
  loaded = ref(false),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  refreshError = ref(""),
  message = ref(""),
  dialogOpen = ref(false),
  mode = ref<"quota" | "authorize" | "revoke" | "reset">("quota"),
  selected = ref<Node | null>(null),
  draftSlots = ref<number | string>(1),
  draftBudgetMiB = ref<number | string>(64);
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
let live = true,
  scope = 0,
  loadSerial = 0;
const receipts = new Map<string, Node>();
function ignoredFailure(e: unknown) {
  return e instanceof Error && ["StaleIdentity", "AbortError"].includes(e.name);
}
function failureMessage(e: unknown) {
  if ((e as { code?: string })?.code === "COMPUTE_POLICY_CONFLICT")
    return "计算配置已被其他管理员修改。请取消并刷新节点后重新编辑";
  return e instanceof Error ? e.message : String(e);
}
async function load() {
  const request = ++loadSerial,
    context = scope;
  loading.value = true;
  refreshError.value = "";
  if (!dialogOpen.value) error.value = "";
  try {
    const result = await session.api<{
      enabled: boolean;
      nodes: Node[];
      limits?: Limits;
    }>("/agents/compute");
    if (!live || context !== scope || request !== loadSerial) return;
    nodes.value = result.nodes.map((node) => {
      const receipt = receipts.get(node.id);
      if (
        receipt?.revision !== undefined &&
        (node.revision ?? 0) < receipt.revision
      )
        return {
          ...node,
          enabled: !node.revoked && receipt.enabled,
          slots: receipt.slots,
          output_budget_bytes: receipt.output_budget_bytes,
          revision: receipt.revision,
        };
      receipts.delete(node.id);
      return node;
    });
    enabled.value = result.enabled;
    limits.value = result.limits ?? { ...defaults };
    loaded.value = true;
  } catch (e) {
    if (
      live &&
      context === scope &&
      request === loadSerial &&
      !ignoredFailure(e)
    ) {
      if (!loaded.value) error.value = failureMessage(e);
      else
        refreshError.value = `节点状态刷新失败：${failureMessage(e)}。已确认的操作无需重复提交，可重试刷新。`;
    }
  } finally {
    if (live && context === scope && request === loadSerial)
      loading.value = false;
  }
}
function openSettings(node: Node, nextMode: typeof mode.value = "quota") {
  if (busy.value || loading.value || node.revoked || dialogOpen.value) return;
  selected.value = { ...node };
  draftSlots.value = node.slots ?? 1;
  draftBudgetMiB.value = (node.output_budget_bytes ?? 67108864) / 1048576;
  mode.value = nextMode;
  error.value = "";
  dialogOpen.value = true;
}
function requestChange(node: Node) {
  if (!enabled.value && !node.enabled) return;
  openSettings(node, node.enabled ? "revoke" : "authorize");
}
async function persist(
  node: Node,
  permission: boolean,
  slots: number,
  bytes: number,
) {
  if (
    busy.value ||
    loading.value ||
    node.revoked ||
    (!enabled.value && permission)
  )
    return;
  if (
    !Number.isInteger(slots) ||
    slots < limits.value.min_slots ||
    slots > limits.value.max_slots ||
    !Number.isSafeInteger(bytes) ||
    bytes < limits.value.min_output_budget_bytes ||
    bytes > limits.value.max_output_budget_bytes
  ) {
    error.value = "请输入服务器允许范围内的整数任务槽与有效产物配额";
    return;
  }
  const context = scope;
  busy.value = true;
  error.value = message.value = "";
  try {
    const result = await session.api<{ revision?: number }>(
      `/agents/${node.id}/compute-policy`,
      "POST",
      {
        enabled: permission,
        slots,
        output_budget_bytes: bytes,
        ...(node.revision === undefined
          ? {}
          : { expected_revision: node.revision }),
      },
    );
    if (!live || context !== scope) return;
    const receipt = {
      ...node,
      enabled: permission,
      slots,
      output_budget_bytes: bytes,
      revision: result.revision ?? node.revision,
    };
    receipts.set(node.id, receipt);
    nodes.value = nodes.value.map((value) =>
      value.id === node.id ? { ...value, ...receipt } : value,
    );
    message.value =
      permission !== node.enabled
        ? permission
          ? "已单独允许此设备执行固定配方计算，配额未自动提高"
          : "计算授权已停止，设备上未完成的计算任务已取消"
        : "计算配额已保存，FFmpeg 授权状态保持不变";
    if (mode.value === "reset" && selected.value?.id === node.id)
      message.value =
        "计算配置已重置为未授权、1 个任务槽、64 MiB；任务历史已保留";
    if (selected.value?.id === node.id) dialogOpen.value = false;
    await load();
  } catch (e) {
    if (live && context === scope && !ignoredFailure(e))
      error.value = failureMessage(e);
  } finally {
    if (live && context === scope) busy.value = false;
  }
}
async function change(node: Node) {
  await persist(
    node,
    !node.enabled,
    node.slots ?? 1,
    node.output_budget_bytes ?? 67108864,
  );
}
async function saveQuota() {
  if (!dialogOpen.value || mode.value !== "quota" || !selected.value) return;
  await persist(
    selected.value,
    selected.value.enabled,
    Number(draftSlots.value),
    Number(draftBudgetMiB.value) * 1048576,
  );
}
async function confirm() {
  if (!dialogOpen.value || !selected.value) return;
  if (mode.value === "reset") await persist(selected.value, false, 1, 67108864);
  else if (mode.value === "authorize" || mode.value === "revoke")
    await change(selected.value);
}
watch(
  dialogOpen,
  (value) => {
    if (!value) {
      selected.value = null;
      draftSlots.value = 1;
      draftBudgetMiB.value = 64;
      error.value = "";
    }
  },
  { flush: "sync" },
);
watch(
  () => [
    session.epoch,
    session.user?.id,
    session.user?.csrf,
    session.user?.admin,
  ],
  (current, previous) => {
    if (current.every((value, index) => value === previous[index])) return;
    ++scope;
    ++loadSerial;
    busy.value = loading.value = loaded.value = enabled.value = false;
    error.value = refreshError.value = message.value = "";
    nodes.value = [];
    receipts.clear();
    dialogOpen.value = false;
    limits.value = { ...defaults };
  },
  { flush: "sync" },
);
onMounted(load);
onBeforeUnmount(() => {
  live = false;
  ++scope;
  ++loadSerial;
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
        在“计算配额设置”中单独调整预算，启用授权只沿用当前配额。
      </p>
      <p v-if="loaded && !enabled" class="helper">
        服务器尚未配置专用计算产物目录，本地计算保持关闭。
      </p>
      <p v-if="loaded" class="helper">
        服务器允许 {{ limits.min_slots }}–{{ limits.max_slots }} 个任务槽、
        {{ limits.min_output_budget_bytes / 1048576 }}–{{
          limits.max_output_budget_bytes / 1048576
        }}
        MiB 单任务产物配额。
        <span v-if="limits.total_output_budget_bytes"
          >所有节点共享
          {{
            Number((limits.total_output_budget_bytes / 1048576).toFixed(2))
          }}
          MiB 服务器产物总量限制；可用空间可能更少。</span
        >
      </p>
      <div class="button-row">
        <button :disabled="busy || loading || dialogOpen" @click="load">
          <AppIcon name="refresh" />{{
            loading ? "正在刷新节点…" : "刷新计算节点"
          }}
        </button>
      </div>
      <Notice :message="message" />
      <Notice :message="refreshError" error />
      <Notice v-if="!dialogOpen" :message="error" error />
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
                {{
                  node.revoked
                    ? "设备已撤销"
                    : node.enabled
                      ? "已允许计算"
                      : "未允许计算"
                }}
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
          <div class="button-row">
            <button
              :disabled="busy || loading || dialogOpen || node.revoked"
              @click="openSettings(node)"
            >
              计算配额设置
            </button>
            <button
              :disabled="
                busy ||
                loading ||
                dialogOpen ||
                node.revoked ||
                (!enabled && !node.enabled)
              "
              @click="requestChange(node)"
            >
              {{ node.enabled ? "停止计算授权" : "允许固定配方计算" }}
            </button>
          </div>
        </article>
      </div>
    </div>
    <AppDialog
      v-model="dialogOpen"
      :title="
        mode === 'quota'
          ? 'NAS 计算配额设置'
          : mode === 'authorize'
            ? '单独授权 FFmpeg 计算'
            : mode === 'reset'
              ? '重置计算配置'
              : '停止计算授权'
      "
      :busy="busy"
    >
      <p>{{ selected?.name }}</p>
      <Notice :message="error" error />
      <form v-if="mode === 'quota'" @submit.prevent="saveQuota">
        <label
          >并发任务槽<input
            v-model="draftSlots"
            type="number"
            required
            :min="limits.min_slots"
            :max="limits.max_slots"
            step="1"
            :disabled="busy"
        /></label>
        <label
          >单任务产物上限（MiB）<input
            v-model="draftBudgetMiB"
            type="number"
            required
            :min="limits.min_output_budget_bytes / 1048576"
            :max="limits.max_output_budget_bytes / 1048576"
            step="any"
            :disabled="busy"
        /></label>
        <p class="helper">
          只调整配额，当前 FFmpeg 计算授权保持{{
            selected?.enabled ? "开启" : "关闭"
          }}。新配额用于后续领取的任务；已经运行的任务沿用领取时的产物预算。减少任务槽不会中断已运行的任务。
        </p>
        <p v-if="!enabled && selected?.enabled" class="helper">
          服务器计算功能已关闭，请先停止授权或重置配置后再调整配额。
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            :disabled="busy"
            @click="
              mode = 'reset';
              error = '';
            "
          >
            重置计算配置…
          </button>
          <button type="button" :disabled="busy" @click="dialogOpen = false">
            取消
          </button>
          <button
            class="primary"
            :disabled="busy || (!enabled && selected?.enabled)"
          >
            {{ busy ? "正在保存…" : "保存配额" }}
          </button>
        </div>
      </form>
      <template v-else>
        <p v-if="mode === 'authorize'">
          允许此设备的配套进程执行固定配方 FFmpeg 计算？这会使用 NAS 的
          CPU、内存与磁盘，独立于目录读取权限。沿用
          {{ selected?.slots ?? 1 }} 个任务槽和
          {{
            selected ? budgetLabel(selected) : "64 MiB"
          }}
          产物上限，不会因为高清配方自动提高配额。
        </p>
        <p v-else-if="mode === 'reset'">
          将计算配置恢复为未授权、1 个任务槽、64
          MiB。会停止此设备的计算授权并取消其未完成任务，保留设备配对、目录读取和任务历史。
        </p>
        <p v-else>
          停止此设备的 FFmpeg
          计算授权并取消其未完成任务？设备配对和目录读取权限保持不变，任务历史会保留。
        </p>
        <div class="dialog-actions">
          <button
            :disabled="busy"
            @click="mode === 'reset' ? (mode = 'quota') : (dialogOpen = false)"
          >
            取消
          </button>
          <button
            :class="mode === 'authorize' ? 'primary' : 'danger'"
            :disabled="busy"
            @click="confirm"
          >
            {{
              busy
                ? "正在提交…"
                : mode === "authorize"
                  ? "确认允许固定配方计算"
                  : mode === "reset"
                    ? "确认重置计算配置"
                    : "确认停止计算授权"
            }}
          </button>
        </div>
      </template>
    </AppDialog>
  </details>
</template>
<style scoped>
.compute-policy-body {
  display: grid;
  gap: var(--space-4);
  padding-top: var(--space-3);
}
</style>
