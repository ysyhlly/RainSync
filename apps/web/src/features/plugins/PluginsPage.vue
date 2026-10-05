<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import type { Media } from "../../shared/api/types";
interface Manifest {
  id: string;
  name: string;
  description: string;
  versions: { version: string; artifact_digest: string }[];
}
interface Installed {
  id: string;
  version: string;
  enabled: boolean;
  config: { format?: string; label?: string };
  revision: string;
  granted_permissions: string[];
  can_rollback: boolean;
}
interface Draft {
  version: string;
  enabled: boolean;
  grant: boolean;
  format: string;
  label: string;
}
const session = useSession(),
  catalog = ref<Manifest[]>([]),
  installed = ref<Record<string, Installed>>({}),
  draft = ref<Record<string, Draft>>({}),
  busy = ref(""),
  error = ref(""),
  message = ref(""),
  media = ref<Media[]>([]),
  selectedMedia = ref(""),
  extensions = ref<
    {
      plugin_id: string;
      label: string;
      revision: string;
      extension_version: string;
    }[]
  >([]),
  audits = ref<
    { id: string; plugin_id: string; action: string; revision: string }[]
  >([]);
let alive = true,
  serial = 0;
async function load() {
  const request = ++serial;
  const result = await session.api<{
    catalog: Manifest[];
    installed: Installed[];
  }>("/admin/plugins", "GET", undefined, AbortSignal.timeout(15000));
  if (!alive || request !== serial) return;
  if (
    !Array.isArray(result.catalog) ||
    result.catalog.length !== 2 ||
    !Array.isArray(result.installed) ||
    result.installed.length > 2
  )
    throw new TypeError("插件目录无效");
  catalog.value = result.catalog;
  installed.value = Object.fromEntries(result.installed.map((p) => [p.id, p]));
  draft.value = Object.fromEntries(
    result.catalog.map((m) => {
      const p = installed.value[m.id];
      return [
        m.id,
        {
          version: p?.version ?? m.versions[0].version,
          enabled: p?.enabled ?? false,
          grant: p?.granted_permissions.includes("metadata:read") ?? false,
          format: p?.config.format ?? "minutes",
          label: p?.config.label ?? "",
        },
      ];
    }),
  );
}
async function run(id: string, operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = id;
  error.value = "";
  message.value = "";
  try {
    await operation();
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (alive) busy.value = "";
  }
}
async function save(id: string) {
  const d = draft.value[id],
    p = installed.value[id];
  if (!d.grant) throw new Error("请明确授予 metadata:read 权限");
  const result = await session.api<Installed>(
    `/admin/plugins/${id}`,
    "PUT",
    {
      version: d.version,
      enabled: d.enabled,
      config:
        id === "metadata.duration-badge"
          ? { format: d.format }
          : { label: d.label },
      granted_permissions: ["metadata:read"],
      expected_revision: p?.revision ?? "0",
    },
    AbortSignal.timeout(15000),
  );
  if (!alive) return;
  installed.value[id] = result;
  message.value = "插件设置已保存，新请求使用此配置版本";
  extensions.value = [];
}
async function rollback(id: string) {
  const p = installed.value[id];
  if (!p) return;
  await session.api(
    `/admin/plugins/${id}/rollback`,
    "POST",
    { expected_revision: p.revision },
    AbortSignal.timeout(15000),
  );
  if (!alive) return;
  await load();
  message.value = "已恢复上一次配置，修订号继续递增";
  extensions.value = [];
}
async function preview() {
  if (!selectedMedia.value) return;
  const selected = selectedMedia.value,
    result = await session.api<{
      media_id: string;
      extensions: typeof extensions.value;
    }>(
      `/media/${selected}/plugin-metadata`,
      "GET",
      undefined,
      AbortSignal.timeout(15000),
    );
  if (!alive || selectedMedia.value !== selected) return;
  if (
    result.media_id !== selected ||
    !Array.isArray(result.extensions) ||
    result.extensions.length > 2
  )
    throw new TypeError("插件输出无效");
  extensions.value = result.extensions;
}
async function audit() {
  const result = await session.api<{ items: typeof audits.value }>(
    "/admin/plugins/audit",
  );
  if (alive) audits.value = result.items;
}
onMounted(
  () =>
    void run("load", async () => {
      await load();
      const result = await session.api<Media[]>("/media");
      if (alive) media.value = result.slice(0, 100);
    }),
);
onBeforeUnmount(() => {
  alive = false;
  ++serial;
});
</script>
<template>
  <section class="page plugin-page">
    <div class="page-title">
      <div>
        <p class="section-label">管理区</p>
        <h1>插件管理</h1>
        <p>从受控目录安装声明式元数据扩展，显式授予权限并保留版本回退记录</p>
      </div>
    </div>
    <p class="notice">
      当前只支持应用内封闭插件目录。扩展不加载远程脚本，不访问网络、文件、凭据或数据库，不改写影片或播放授权。第三方进程宿主尚未开放。
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <button :disabled="!!busy" @click="run('load', load)">
      刷新目录与状态
    </button>
    <article
      v-for="plugin in catalog"
      :key="plugin.id"
      class="panel plugin-card"
    >
      <h2>{{ plugin.name }}</h2>
      <p>{{ plugin.description }}</p>
      <p class="helper">
        {{ plugin.id }} · API 1.0 ·
        {{ installed[plugin.id] ? "已安装" : "未安装" }} · 封闭声明式
      </p>
      <form
        v-if="draft[plugin.id]"
        @submit.prevent="run(plugin.id, () => save(plugin.id))"
      >
        <label
          >目录版本<select
            v-model="draft[plugin.id].version"
            :disabled="!!busy"
          >
            <option
              v-for="version in plugin.versions"
              :key="version.version"
              :value="version.version"
            >
              {{ version.version }}
            </option>
          </select></label
        >
        <label v-if="plugin.id === 'metadata.duration-badge'"
          >时长格式<select v-model="draft[plugin.id].format" :disabled="!!busy">
            <option value="minutes">分钟</option>
            <option value="clock">时:分:秒</option>
          </select></label
        >
        <label v-else
          >纯文字说明<input
            v-model="draft[plugin.id].label"
            maxlength="40"
            :disabled="!!busy"
            placeholder="例如：优先观看完整版"
        /></label>
        <label
          ><input
            v-model="draft[plugin.id].grant"
            type="checkbox"
            :disabled="!!busy"
          />授予 metadata:read，只读取当前用户有权查看的影片元信息</label
        >
        <label
          ><input
            v-model="draft[plugin.id].enabled"
            type="checkbox"
            :disabled="!!busy"
          />启用此插件</label
        >
        <p class="helper">
          制品摘要
          {{
            plugin.versions.find((v) => v.version === draft[plugin.id].version)
              ?.artifact_digest
          }}
        </p>
        <p v-if="installed[plugin.id]" class="helper">
          当前修订 {{ installed[plugin.id].revision }} ·
          {{ installed[plugin.id].enabled ? "运行中" : "已停用" }}
        </p>
        <div class="button-row">
          <button class="primary" :disabled="!!busy || !draft[plugin.id].grant">
            {{
              busy === plugin.id
                ? "保存中…"
                : installed[plugin.id]
                  ? "保存配置与版本"
                  : "安装插件"
            }}</button
          ><button
            v-if="installed[plugin.id]?.can_rollback"
            type="button"
            :disabled="!!busy"
            @click="run(plugin.id, () => rollback(plugin.id))"
          >
            恢复上一次配置
          </button>
        </div>
      </form>
    </article>
    <section class="panel plugin-preview">
      <h2>验证实际插件输出</h2>
      <label
        >可访问的影片<select v-model="selectedMedia">
          <option value="">选择影片</option>
          <option v-for="m in media" :key="m.id" :value="m.id">
            {{ m.title }}
          </option>
        </select></label
      ><button
        :disabled="!!busy || !selectedMedia"
        @click="run('preview', preview)"
      >
        读取元数据扩展
      </button>
      <p v-if="!extensions.length" class="helper">
        没有可显示的扩展。请启用插件并选择有对应元信息的影片。
      </p>
      <ul v-else>
        <li v-for="e in extensions" :key="e.plugin_id">
          {{ e.label }} · {{ e.plugin_id }} {{ e.extension_version }} / 修订{{
            e.revision
          }}
        </li>
      </ul>
    </section>
    <section class="panel">
      <button :disabled="!!busy" @click="run('audit', audit)">
        查看安装、升级与回退记录
      </button>
      <ul v-if="audits.length">
        <li v-for="a in audits" :key="a.id">
          {{ a.plugin_id }} · {{ a.action }} · 修订{{ a.revision }}
        </li>
      </ul>
    </section>
  </section>
</template>
<style scoped>
.plugin-card,
.plugin-preview {
  padding: 20px;
  margin-top: 16px;
  min-width: 0;
}
.plugin-page label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.plugin-page select,
.plugin-page input:not([type="checkbox"]) {
  min-width: 0;
  max-width: 100%;
  flex: 1;
}
.plugin-card .helper {
  overflow-wrap: anywhere;
}
.error {
  color: #973b32;
}
.plugin-page .panel:last-child {
  margin-top: 16px;
}
</style>
