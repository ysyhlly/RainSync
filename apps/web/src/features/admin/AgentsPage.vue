<script setup lang="ts">
import ComputePolicyPanel from "./ComputePolicyPanel.vue";
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useSession } from "../auth/session.store";
import type { Agent } from "../../shared/api/types";
import { StaleIdentity } from "../../shared/api/client";
import { formatDate } from "../../shared/use-action";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
import CopyField from "../../shared/ui/CopyField.vue";
import {
  agentConnectionLabel,
  agentReadinessLabel,
  agentDrainLabel,
} from "./agent-readiness";
const session = useSession(),
  busy = ref(false),
  refreshing = ref(false),
  error = ref(""),
  refreshError = ref(""),
  message = ref(""),
  rows = ref<Agent[]>([]),
  loaded = ref(false),
  open = ref(false),
  name = ref(""),
  code = ref(""),
  remaining = ref(0),
  revoking = ref<Agent | null>(null),
  revokeOpen = ref(false),
  settingsOpen = ref(false),
  editing = ref<Agent | null>(null),
  editName = ref(""),
  computeRefresh = ref(0);
let expires = 0,
  alive = true,
  scope = 0,
  loadSerial = 0,
  dialogSerial = 0;
const revokedIds = new Set<string>();
function edit(row: Agent) {
  if (
    row.revoked ||
    busy.value ||
    refreshing.value ||
    open.value ||
    revokeOpen.value ||
    settingsOpen.value
  )
    return;
  editing.value = { ...row };
  editName.value = row.name;
  error.value = "";
  settingsOpen.value = true;
}
async function saveSettings() {
  const target = editing.value,
    context = scope;
  if (!settingsOpen.value || !target || target.revoked) return;
  const trimmed = editName.value.trim();
  if (
    !trimmed ||
    [...trimmed].length > 120 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)
  )
    throw Error("设备名称需为 1–120 个字符，不能包含控制字符");
  let result: { id: string; name: string };
  try {
    result = await session.api<{ id: string; name: string }>(
      `/agents/${target.id}`,
      "PUT",
      {
        name: trimmed,
        expected_name: target.name,
      },
    );
  } catch (e) {
    if ((e as { code?: string })?.code === "AGENT_SETTINGS_CONFLICT")
      throw Error("设备名称已被其他管理员修改。请取消并刷新设备状态后重新编辑");
    throw e;
  }
  if (!alive || context !== scope) return;
  rows.value = rows.value.map((row) =>
    row.id === target.id ? { ...row, name: result.name } : row,
  );
  message.value = "设备名称已保存，现有配对、目录和媒体索引保持不变";
  ++computeRefresh.value;
  if (editing.value?.id === target.id) settingsOpen.value = false;
  await load();
}
function ignoredFailure(e: unknown) {
  return (
    e instanceof StaleIdentity ||
    (e instanceof DOMException && e.name === "AbortError")
  );
}
const timer = setInterval(
  () =>
    (remaining.value = Math.max(0, Math.ceil((expires - Date.now()) / 1000))),
  1000,
);
async function load() {
  const request = ++loadSerial,
    context = scope;
  refreshing.value = true;
  refreshError.value = "";
  try {
    const value = await session.api<Agent[]>("/agents");
    if (!alive || context !== scope || request !== loadSerial) return;
    // A confirmed revocation cannot be undone by a stale list snapshot.
    rows.value = value.map((row) =>
      revokedIds.has(row.id)
        ? { ...row, revoked: true, connected: false }
        : row,
    );
    loaded.value = true;
  } catch (e) {
    if (
      alive &&
      context === scope &&
      request === loadSerial &&
      !ignoredFailure(e)
    )
      refreshError.value = `设备状态刷新失败：${e instanceof Error ? e.message : String(e)}。请重试刷新，无需重复已完成的操作。`;
  } finally {
    if (alive && context === scope && request === loadSerial)
      refreshing.value = false;
  }
}
async function run(operation: () => Promise<void>) {
  if (busy.value || refreshing.value) return;
  const context = scope;
  busy.value = true;
  error.value = "";
  try {
    await operation();
  } catch (e) {
    if (alive && context === scope && !ignoredFailure(e))
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (alive && context === scope) busy.value = false;
  }
}
async function create() {
  if (!open.value || code.value) return;
  const context = scope,
    dialog = dialogSerial;
  message.value = "";
  const result = await session.api<{ id: string; pair_code: string }>(
    "/agents",
    "POST",
    { name: name.value },
  );
  if (!alive || context !== scope) return;
  if (open.value && dialog === dialogSerial) {
    code.value = result.pair_code;
    expires = Date.now() + 600000;
    remaining.value = 600;
  }
  message.value = "设备已添加，配对码已生成";
  ++computeRefresh.value;
  await load();
}
async function revoke() {
  const target = revoking.value,
    context = scope;
  if (
    !revokeOpen.value ||
    !target ||
    target.revoked ||
    revokedIds.has(target.id)
  )
    return;
  message.value = "";
  await session.api("/agents/" + target.id, "DELETE");
  if (!alive || context !== scope) return;
  revokedIds.add(target.id);
  rows.value = rows.value.map((row) =>
    row.id === target.id ? { ...row, revoked: true, connected: false } : row,
  );
  revoking.value = null;
  revokeOpen.value = false;
  message.value = "设备已撤销，后续连接将被拒绝";
  ++computeRefresh.value;
  await load();
}
watch(
  settingsOpen,
  (value) => {
    if (!value) {
      editing.value = null;
      editName.value = "";
    }
  },
  { flush: "sync" },
);
watch(
  open,
  (value) => {
    ++dialogSerial;
    if (!value) {
      code.value = name.value = "";
      expires = remaining.value = 0;
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
    busy.value = refreshing.value = loaded.value = false;
    error.value = refreshError.value = message.value = "";
    rows.value = [];
    revokedIds.clear();
    open.value = revokeOpen.value = settingsOpen.value = false;
    code.value = name.value = "";
    expires = remaining.value = 0;
    revoking.value = null;
  },
  { flush: "sync" },
);
onMounted(load);
onBeforeUnmount(() => {
  alive = false;
  ++scope;
  ++loadSerial;
  clearInterval(timer);
  code.value = "";
});
</script>
<template>
  <section class="page">
    <div class="page-title">
      <div class="page-intro">
        <p class="section-label">管理</p>
        <h1>NAS 设备</h1>
        <p>设备主动连接服务器，无需开放NAS入站端口。</p>
      </div>
      <div class="button-row">
        <button
          v-if="!open && !revokeOpen && !settingsOpen"
          :disabled="busy || refreshing"
          @click="load"
        >
          <AppIcon name="refresh" />{{
            refreshing ? "正在刷新…" : "刷新设备状态"
          }}
        </button>
        <button
          class="primary"
          :disabled="busy || refreshing || open || revokeOpen || settingsOpen"
          @click="
            code = '';
            name = '';
            error = '';
            message = '';
            open = true;
          "
        >
          <AppIcon name="plus" />添加设备
        </button>
      </div>
    </div>
    <template v-if="!open && !revokeOpen && !settingsOpen">
      <Notice :message="message" />
      <Notice :message="error" error />
      <Notice :message="refreshError" error />
      <button v-if="refreshError" :disabled="busy || refreshing" @click="load">
        {{ refreshing ? "正在刷新…" : "重试刷新设备状态" }}
      </button>
    </template>
    <p
      v-if="refreshing && !loaded"
      class="loading-state loading-state--inline"
      role="status"
    >
      正在加载设备…
    </p>
    <div
      v-if="
        loaded &&
        !busy &&
        !refreshing &&
        !error &&
        !refreshError &&
        !rows.length
      "
      class="empty-state surface-card"
    >
      <span class="empty-state__icon"
        ><AppIcon name="server" :size="28"
      /></span>
      <h2>暂无NAS设备</h2>
      <p>生成配对码后，在NAS Agent中完成连接。</p>
    </div>
    <div class="admin-list" :aria-busy="busy || refreshing">
      <article v-for="row in rows" :key="row.id" class="admin-row">
        <div class="row-main">
          <div class="section-heading">
            <h2>{{ row.name }}</h2>
            <span
              class="status-badge"
              :class="{
                'status-badge--success': !row.revoked && row.connected === true,
                'status-badge--danger': row.revoked,
              }"
              >{{ agentConnectionLabel(row) }}</span
            >
          </div>
          <p class="helper">最后联系：{{ formatDate(row.last_seen) }}</p>
          <p class="helper">{{ agentReadinessLabel(row) }}</p>
          <p v-if="agentDrainLabel(row)" class="helper">
            {{ agentDrainLabel(row) }}
          </p>
        </div>
        <div class="button-row">
          <button
            :disabled="
              row.revoked ||
              busy ||
              refreshing ||
              open ||
              revokeOpen ||
              settingsOpen
            "
            @click="edit(row)"
          >
            <AppIcon name="settings" />设备设置
          </button>
          <button
            class="danger"
            :disabled="
              row.revoked ||
              busy ||
              refreshing ||
              open ||
              revokeOpen ||
              settingsOpen
            "
            @click="
              revoking = row;
              revokeOpen = true;
            "
          >
            撤销设备
          </button>
        </div>
      </article>
    </div>
    <p v-if="rows.length" class="helper">
      连接状态以最近一次刷新为准；文件版本索引就绪不代表设备当前在线或所有影片均可播放。
    </p>
    <ComputePolicyPanel :key="computeRefresh" class="agent-compute" />
    <AppDialog v-model="settingsOpen" title="NAS 设备设置" :busy="busy">
      <p class="helper">
        修改显示名称会同步更新对应片源名称，不需要重新配对。目录路径和 Agent
        连接配置需在设备上修改。
      </p>
      <form @submit.prevent="run(saveSettings)">
        <label
          >设备名称<input
            v-model="editName"
            required
            maxlength="120"
            :disabled="busy"
            autofocus
        /></label>
        <Notice :message="error" error />
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="settingsOpen = false">
            取消
          </button>
          <button
            class="primary"
            :disabled="busy || refreshing || !editName.trim()"
          >
            {{ busy ? "正在保存…" : "保存设备设置" }}
          </button>
        </div>
      </form>
    </AppDialog>
    <AppDialog v-model="open" title="添加NAS设备" drawer :busy="busy"
      ><Notice :message="message" />
      <Notice :message="error" error />
      <Notice :message="refreshError" error />
      <button v-if="refreshError" :disabled="busy || refreshing" @click="load">
        {{ refreshing ? "正在刷新…" : "重试刷新设备状态" }}
      </button>
      <template v-if="code"
        ><CopyField label="配对码" :value="code" />
        <p role="status">
          {{
            remaining > 0
              ? "预计剩余 " +
                Math.floor(remaining / 60) +
                " 分 " +
                (remaining % 60) +
                " 秒"
              : "预计已到期，请重新生成设备配对码"
          }}
        </p>
        <p class="helper">
          配对码生成后约10分钟有效，以服务端校验为准。在NAS
          Agent中设置SERVER_URL、PAIR_CODE和MEDIA_PATH。
        </p></template
      >
      <form v-else @submit.prevent="run(create)">
        <label
          >设备名称<input
            v-model="name"
            required
            maxlength="120"
            autofocus /></label
        ><button class="primary" :disabled="busy || refreshing">
          {{ busy ? "正在生成…" : "生成配对码" }}
        </button>
      </form></AppDialog
    ><AppDialog v-model="revokeOpen" title="撤销设备" :busy="busy"
      ><p>
        撤销
        {{ revoking?.name }}
        后，设备凭据失效，无法继续同步和读取设备片源，依赖它的播放与本地计算也会失效。此操作不能恢复；再次连接需要添加并配对新设备。
        保留设备记录、媒体索引和任务历史，不会删除 NAS
        上的原文件。现有账号不受影响。
      </p>
      <Notice :message="error" error />
      <div class="dialog-actions">
        <button :disabled="busy" @click="revokeOpen = false">取消</button
        ><button class="danger" :disabled="busy" @click="run(revoke)">
          确认撤销设备
        </button>
      </div></AppDialog
    >
  </section>
</template>
<style scoped>
.agent-compute {
  margin-top: var(--space-6);
}
</style>
