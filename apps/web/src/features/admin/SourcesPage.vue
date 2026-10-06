<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  onMounted,
  onBeforeUnmount,
  watch,
} from "vue";
import { onBeforeRouteLeave } from "vue-router";
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
  removeOpen = ref(false),
  removing = ref<Source>(),
  name = ref(""),
  kind = ref("local"),
  root = ref("/media"),
  url = ref(""),
  userId = ref(""),
  token = ref(""),
  headers = ref("{}"),
  advancedAssets = ref(""),
  advancedOpen = ref(false),
  discardOpen = ref(false),
  headersError = ref(""),
  assetsError = ref("");
const dirty = computed(
  () =>
    name.value !== "" ||
    kind.value !== "local" ||
    root.value !== "/media" ||
    url.value !== "" ||
    userId.value !== "" ||
    token.value !== "" ||
    headers.value !== "{}" ||
    advancedAssets.value !== "",
);
const advancedConfigured = computed(
  () =>
    (headers.value.trim() !== "{}" && headers.value.trim() !== "") ||
    advancedAssets.value.trim() !== "",
);
let alive = true;
let pendingLeave: ((discard: boolean) => void) | undefined;
let editingField: HTMLElement | null = null;
function resetDraft() {
  name.value = "";
  kind.value = "local";
  root.value = "/media";
  url.value = "";
  userId.value = "";
  token.value = "";
  headers.value = "{}";
  advancedAssets.value = "";
  advancedOpen.value = false;
  discardOpen.value = false;
  headersError.value = "";
  assetsError.value = "";
}
function beginCreate() {
  error.value = "";
  open.value = true;
}
function canClose() {
  if (busy.value) return false;
  if (!dirty.value) return true;
  if (!discardOpen.value) editingField = document.activeElement as HTMLElement;
  discardOpen.value = true;
  void nextTick(() =>
    document.getElementById("source-continue-editing")?.focus(),
  );
  return false;
}
function closeDraft() {
  if (canClose()) open.value = false;
}
function continueEditing() {
  discardOpen.value = false;
  pendingLeave?.(false);
  pendingLeave = undefined;
  void nextTick(() => editingField?.focus());
}
function discardDraft() {
  resetDraft();
  open.value = false;
  pendingLeave?.(true);
  pendingLeave = undefined;
}
onBeforeRouteLeave(() => {
  if (!open.value) return true;
  if (busy.value) return false;
  if (canClose()) return true;
  pendingLeave?.(false);
  return new Promise<boolean>((resolve) => {
    pendingLeave = resolve;
  });
});
function beforeUnload(event: BeforeUnloadEvent) {
  if (!open.value || !dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}
async function fieldFailure(field: "headers" | "assets", message: string) {
  if (field === "headers") headersError.value = message;
  else assetsError.value = message;
  advancedOpen.value = true;
  await nextTick();
  document
    .getElementById(field === "headers" ? "source-headers" : "source-assets")
    ?.focus();
  throw Error(message);
}
async function load() {
  const value = await session.api<Source[]>("/sources");
  if (alive) {
    rows.value = value;
    loaded.value = true;
  }
}
function managedElsewhere(source: Source) {
  return (
    source.kind === "agent" ||
    source.kind === "s3" ||
    (!!source.library_id &&
      source.library_id !== "00000000-0000-0000-0000-000000000001")
  );
}
function beginRemove(source: Source) {
  error.value = "";
  message.value = "";
  removing.value = source;
  removeOpen.value = true;
}
async function remove() {
  const source = removing.value;
  if (!source) return;
  await session.api(`/sources/${source.id}`, "DELETE");
  if (!alive) return;
  rows.value = rows.value.filter((row) => row.id !== source.id);
  delete scans.results[source.id];
  removeOpen.value = false;
  removing.value = undefined;
  message.value = "片源已删除，关联影片已从媒体库移除";
}
async function create() {
  headersError.value = "";
  assetsError.value = "";
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
      await fieldFailure("headers", "请求头须为JSON对象，名称和值都须为字符串");
    }
  }
  let association: ReturnType<typeof parseHttpAssetAssociation>;
  try {
    association =
      kind.value === "http"
        ? parseHttpAssetAssociation(advancedAssets.value)
        : undefined;
  } catch (e) {
    await fieldFailure(
      "assets",
      e instanceof Error ? e.message : "外部字幕/字体声明格式不正确",
    );
    return;
  }
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
  resetDraft();
  open.value = false;
  message.value = "片源已添加，可检测并扫描影片";
  try {
    await load();
  } catch {
    if (alive)
      error.value =
        "片源已添加，但列表暂未更新。请重新加载列表，避免重复添加。";
  }
}
watch(open, (value) => {
  if (!value) resetDraft();
});
watch(
  [() => session.epoch, () => session.user?.id, () => session.user?.csrf],
  () => {
    resetDraft();
    open.value = false;
    removeOpen.value = false;
    removing.value = undefined;
    pendingLeave?.(true);
    pendingLeave = undefined;
  },
  { flush: "sync" },
);
watch(headers, () => {
  if (headersError.value) {
    headersError.value = "";
    error.value = "";
  }
});
watch(advancedAssets, () => {
  if (assetsError.value) {
    assetsError.value = "";
    error.value = "";
  }
});
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void run(load);
});
onBeforeUnmount(() => {
  alive = false;
  window.removeEventListener("beforeunload", beforeUnload);
  pendingLeave?.(false);
  resetDraft();
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
      <button class="primary" :disabled="busy" @click="beginCreate">
        <AppIcon name="plus" />添加片源
      </button>
    </div>
    <Notice v-if="!open && !removeOpen" :message="error" error /><Notice
      :message="message"
    />
    <ScanAllSources />
    <p v-if="busy && !loaded" role="status">正在加载片源…</p>
    <button
      v-if="error && !open && !removeOpen"
      :disabled="busy"
      @click="run(load)"
    >
      重新加载列表
    </button>
    <div v-if="loaded && !rows.length" class="empty-state">
      <AppIcon name="movie" :size="40" />
      <h2>暂无片源</h2>
      <p>添加本地目录、HTTP视频链接或Jellyfin/Emby服务。</p>
      <button @click="beginCreate">添加第一个片源</button>
    </div>
    <div class="admin-list">
      <article v-for="row in rows" :key="row.id" class="admin-row">
        <div class="row-main">
          <h2>{{ row.name }}</h2>
          <span class="helper">{{ row.kind }}</span>
        </div>
        <button
          :disabled="busy || scans.running || scans.results[row.id]?.busy"
          @click="scans.scan(row)"
        >
          <AppIcon name="refresh" />{{
            scans.results[row.id]?.busy ? "正在检测扫描…" : "检测并扫描"
          }}
        </button>
        <RouterLink v-if="row.kind === 'agent'" to="/admin/agents">
          管理 NAS 设备
        </RouterLink>
        <span v-else-if="managedElsewhere(row)" class="helper">
          请在所属媒体库中管理
        </span>
        <button
          v-else
          class="danger"
          :aria-label="`删除片源 ${row.name}`"
          :disabled="busy || scans.busy"
          @click="beginRemove(row)"
        >
          删除
        </button>
        <Notice
          class="row-result"
          :message="scans.results[row.id]?.message"
          :error="scans.results[row.id]?.failed"
        />
      </article>
    </div>
    <AppDialog
      v-model="open"
      title="添加片源"
      drawer
      :busy="busy"
      :can-close="canClose"
      ><form class="source-form" @submit.prevent="run(create)">
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
              required /></label
        ></template>
        <details
          v-if="kind === 'http'"
          :open="advancedOpen"
          @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            高级选项：请求头与外部字幕{{
              advancedConfigured ? "（已配置）" : ""
            }}
          </summary>
          <div class="source-advanced-fields">
            <label for="source-headers">请求头 JSON（可选）</label
            ><textarea
              id="source-headers"
              v-model="headers"
              spellcheck="false"
              :aria-invalid="!!headersError"
              :aria-describedby="
                headersError ? 'source-headers-error' : undefined
              "
            /><Notice id="source-headers-error" :message="headersError" error />
            <label for="source-assets">外部字幕/字体关联 JSON（可选）</label
            ><textarea
              id="source-assets"
              v-model="advancedAssets"
              spellcheck="false"
              maxlength="32768"
              placeholder='{"schema_version":1,"subtitles":["ass"],"fonts":["body.ttf"]}'
              :aria-invalid="!!assetsError"
              :aria-describedby="
                assetsError
                  ? 'source-assets-help source-assets-error'
                  : 'source-assets-help'
              "
            />
            <p id="source-assets-help" class="helper">
              占位内容是示例，不会自动应用。关联同名 ASS、SSA、PGS（.sup）和同名
              .fonts 目录内的指定字体文件。
            </p>
            <Notice id="source-assets-error" :message="assetsError" error />
          </div>
        </details>
        <div
          v-if="discardOpen"
          class="confirm-panel"
          role="group"
          aria-label="放弃未保存内容"
        >
          <p>片源尚未保存。放弃后会清除全部输入，包括请求头和访问令牌。</p>
          <button
            id="source-continue-editing"
            type="button"
            @click="continueEditing"
          >
            继续编辑
          </button>
          <button class="danger" type="button" @click="discardDraft">
            放弃未保存内容
          </button>
        </div>
        <div class="source-form-actions">
          <Notice :message="headersError || assetsError ? '' : error" error />
          <div class="dialog-actions">
            <button type="button" :disabled="busy" @click="closeDraft">
              取消
            </button>
            <button class="primary" :disabled="busy || discardOpen">
              {{ busy ? "正在添加…" : "保存片源" }}
            </button>
          </div>
        </div>
      </form></AppDialog
    >
    <AppDialog v-model="removeOpen" title="删除片源" :busy="busy">
      <p>
        确认删除「{{
          removing?.name
        }}」？关联影片将从媒体库移除，房间历史记录会保留，不会删除原始媒体文件。
      </p>
      <p class="helper">若片源正在播放或准备播放，请先停止相关播放后再删除。</p>
      <Notice :message="error" error />
      <div class="dialog-actions">
        <button :disabled="busy" autofocus @click="removeOpen = false">
          取消
        </button>
        <button class="danger" :disabled="busy" @click="run(remove)">
          {{ busy ? "正在删除…" : "确认删除片源" }}
        </button>
      </div>
    </AppDialog>
  </section>
</template>
<style scoped>
.source-advanced-fields {
  display: grid;
  gap: 10px;
  padding-top: 16px;
}
.source-form summary {
  cursor: pointer;
  padding-block: 10px;
}
.source-form-actions {
  position: sticky;
  bottom: -24px;
  padding-block: 16px;
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
  z-index: 1;
}
</style>
