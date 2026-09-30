<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import type { Agent } from "../../shared/api/types";
import { useAction, formatDate } from "../../shared/use-action";
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
  { busy, error, message, run } = useAction(),
  rows = ref<Agent[]>([]),
  loaded = ref(false),
  open = ref(false),
  name = ref(""),
  code = ref(""),
  remaining = ref(0),
  revoking = ref<Agent | null>(null),
  revokeOpen = ref(false);
let expires = 0,
  alive = true;
const timer = setInterval(
  () =>
    (remaining.value = Math.max(0, Math.ceil((expires - Date.now()) / 1000))),
  1000,
);
async function load() {
  const value = await session.api<Agent[]>("/agents");
  if (alive) {
    rows.value = value;
    loaded.value = true;
  }
}
async function create() {
  const result = await session.api<{ id: string; pair_code: string }>(
    "/agents",
    "POST",
    { name: name.value },
  );
  if (!alive) return;
  code.value = result.pair_code;
  expires = Date.now() + 600000;
  remaining.value = 600;
  await load();
}
async function revoke() {
  if (!revoking.value) return;
  await session.api("/agents/" + revoking.value.id, "DELETE");
  revokeOpen.value = false;
  await load();
  message.value = "设备已撤销，后续连接将被拒绝";
}
onMounted(() => run(load));
onBeforeUnmount(() => {
  alive = false;
  clearInterval(timer);
  code.value = "";
});
</script>
<template>
  <section class="page">
    <div class="page-title">
      <div>
        <p class="section-label">管理</p>
        <h1>NAS 设备</h1>
        <p>设备主动连接服务器，无需开放NAS入站端口。</p>
      </div>
      <button
        class="primary"
        @click="
          code = '';
          name = '';
          open = true;
        "
      >
        <AppIcon name="plus" />添加设备
      </button>
    </div>
    <Notice v-if="!open && !revokeOpen" :message="error" error /><Notice
      :message="message"
    />
    <p v-if="busy && !loaded" role="status">正在加载设备…</p>
    <button v-if="!open && !revokeOpen" :disabled="busy" @click="run(load)">
      {{ busy ? "正在刷新…" : "刷新设备状态" }}
    </button>
    <div v-if="loaded && !rows.length" class="empty-state">
      <AppIcon name="server" :size="40" />
      <h2>暂无NAS设备</h2>
      <p>生成配对码后，在NAS Agent中完成连接。</p>
    </div>
    <div class="admin-list">
      <article v-for="row in rows" :key="row.id" class="admin-row">
        <div class="row-main">
          <h2>{{ row.name }}</h2>
          <p class="helper">
            {{ agentConnectionLabel(row) }}
            · 最后联系：{{ formatDate(row.last_seen) }}
          </p>
          <p class="helper">{{ agentReadinessLabel(row) }}</p>
          <p v-if="agentDrainLabel(row)" class="helper">
            {{ agentDrainLabel(row) }}
          </p>
        </div>
        <button
          class="danger"
          :disabled="row.revoked || busy"
          @click="
            revoking = row;
            revokeOpen = true;
          "
        >
          撤销设备
        </button>
      </article>
    </div>
    <p v-if="rows.length" class="helper">
      连接状态以最近一次刷新为准；文件版本索引就绪不代表设备当前在线或所有影片均可播放。
    </p>
    <AppDialog v-model="open" title="添加NAS设备" drawer :busy="busy"
      ><template v-if="code"
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
        ><Notice :message="error" error /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在生成…" : "生成配对码" }}
        </button>
      </form></AppDialog
    ><AppDialog v-model="revokeOpen" title="撤销设备" :busy="busy"
      ><p>
        撤销
        {{ revoking?.name }}
        后，设备凭据失效，无法继续同步和读取设备片源。现有账号不受影响。
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
