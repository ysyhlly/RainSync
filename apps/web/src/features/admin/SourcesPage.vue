<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useSession } from "../auth/session.store";
import type { Source } from "../../shared/api/types";
import { useAction } from "../../shared/use-action";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
import ScanAllSources from "./ScanAllSources.vue";
import { useSourceScans } from "./source-scans.store";
import { parseHttpAssetAssociation } from "./http-asset-association";
const scans = useSourceScans();
const session = useSession(),
  { busy, error, message, run } = useAction();
const rows = ref<Source[]>([]),
  loaded = ref(false),
  open = ref(false),
  name = ref(""),
  kind = ref("local"),
  root = ref("/media"),
  url = ref(""),
  userId = ref(""),
  token = ref(""),
  headers = ref("{}"),
  advancedAssets = ref("");
let alive = true;
async function load() {
  const value = await session.api<Source[]>("/sources");
  if (alive) {
    rows.value = value;
    loaded.value = true;
  }
}
async function create() {
  let parsed: Record<string, string> = {};
  if (kind.value === "http") {
    try {
      const value = JSON.parse(headers.value || "{}");
      if (
        !value ||
        Array.isArray(value) ||
        typeof value !== "object" ||
        Object.values(value).some((v) => typeof v !== "string")
      )
        throw Error();
      parsed = value;
    } catch {
      throw Error("请求头须为JSON对象，名称和值都须为字符串");
    }
  }
  const association =
    kind.value === "http"
      ? parseHttpAssetAssociation(advancedAssets.value)
      : undefined;
  const config =
    kind.value === "local"
      ? { root: root.value }
      : kind.value === "http"
        ? {
            url: url.value,
            headers: parsed,
            ...(association ? { advanced_assets: association } : {}),
          }
        : { url: url.value, user_id: userId.value, token: token.value };
  await session.api<{ id: string }>("/sources", "POST", {
    name: name.value,
    kind: kind.value,
    config,
  });
  if (!alive) return;
  token.value = "";
  headers.value = "{}";
  advancedAssets.value = "";
  open.value = false;
  name.value = "";
  await load();
  message.value = "片源已添加，可检测并扫描影片";
}
watch(open, (value) => {
  if (!value) {
    token.value = "";
    headers.value = "{}";
    advancedAssets.value = "";
  }
});
onMounted(() => run(load));
onBeforeUnmount(() => {
  alive = false;
  token.value = "";
  headers.value = "{}";
  advancedAssets.value = "";
});
</script>
<template>
  <section class="page">
    <div class="page-title">
      <div>
        <p class="section-label">管理</p>
        <h1>片源管理</h1>
        <p>连接媒体目录或服务，检测并扫描可用影片。</p>
      </div>
      <button class="primary" @click="open = true">
        <AppIcon name="plus" />添加片源
      </button>
    </div>
    <Notice v-if="!open" :message="error" error /><Notice :message="message" />
    <ScanAllSources />
    <p v-if="busy && !loaded" role="status">正在加载片源…</p>
    <button v-if="error && !open" @click="run(load)">重新加载</button>
    <div v-if="loaded && !rows.length" class="empty-state">
      <AppIcon name="movie" :size="40" />
      <h2>暂无片源</h2>
      <p>添加本地目录、HTTP视频链接或Jellyfin/Emby服务。</p>
      <button @click="open = true">添加第一个片源</button>
    </div>
    <div class="admin-list">
      <article v-for="row in rows" :key="row.id" class="admin-row">
        <div class="row-main">
          <h2>{{ row.name }}</h2>
          <span class="helper">{{ row.kind }}</span>
        </div>
        <button
          :disabled="scans.running || scans.results[row.id]?.busy"
          @click="scans.scan(row)"
        >
          <AppIcon name="refresh" />{{
            scans.results[row.id]?.busy ? "正在检测扫描…" : "检测并扫描"
          }}
        </button>
        <Notice
          class="row-result"
          :message="scans.results[row.id]?.message"
          :error="scans.results[row.id]?.failed"
        />
      </article>
    </div>
    <AppDialog v-model="open" title="添加片源" drawer :busy="busy"
      ><form @submit.prevent="run(create)">
        <label
          >名称<input
            v-model="name"
            required
            maxlength="120"
            autofocus /></label
        ><label
          >类型<AppSelect
            v-model="kind"
            label="类型"
            :options="[
              { value: 'local', label: '本地挂载目录' },
              { value: 'http', label: 'HTTP MP4 / HLS' },
              { value: 'jellyfin', label: 'Jellyfin' },
              { value: 'emby', label: 'Emby' },
            ]" /></label
        ><label v-if="kind === 'local'"
          >容器内路径<input v-model="root" required /></label
        ><label v-else
          >媒体或服务 URL<input v-model="url" type="url" required /></label
        ><template v-if="kind === 'jellyfin' || kind === 'emby'"
          ><label
            >专用账户 User ID<input
              v-model="userId"
              required
              autocomplete="off" /></label
          ><label
            >访问令牌<input
              v-model="token"
              type="password"
              autocomplete="off"
              required /></label></template
        ><label v-if="kind === 'http'"
          >请求头 JSON（可选）<textarea
            v-model="headers"
            spellcheck="false"
          /></label
        ><label v-if="kind === 'http'"
          >外部字幕/字体关联 JSON（可选）<textarea
            v-model="advancedAssets"
            spellcheck="false"
            maxlength="32768"
            placeholder='{"schema_version":1,"subtitles":["ass"],"fonts":["body.ttf"]}'
          /><span class="helper"
            >关联同名 ASS、SSA、SUP 和同名 .fonts 目录内的指定字体文件</span
          ></label
        ><Notice :message="error" error /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在添加…" : "保存片源" }}
        </button>
      </form></AppDialog
    >
  </section>
</template>
