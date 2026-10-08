<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useSession } from "../auth/session.store";
import type { Media } from "../../shared/api/types";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import Notice from "../../shared/ui/Notice.vue";
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
  catalogLoaded = ref(false),
  installed = ref<Record<string, Installed>>({}),
  configurationRevisions = ref<Record<string, string>>({}),
  removal = ref<{ id: string; name: string; revision: string } | null>(null),
  removalError = ref(""),
  draft = ref<Record<string, Draft>>({}),
  draftBase = ref<Record<string, Draft>>({}),
  draftRevision = ref<Record<string, string>>({}),
  busy = ref(""),
  error = ref(""),
  message = ref(""),
  media = ref<Media[]>([]),
  mediaLoaded = ref(false),
  selectedMedia = ref(""),
  previewLoaded = ref(false),
  auditLoaded = ref(false),
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
  serial = 0,
  scope = 0;
function pluginDraft(m: Manifest, p?: Installed): Draft {
  return {
    version: p?.version ?? m.versions[0].version,
    enabled: p?.enabled ?? false,
    grant: p?.granted_permissions.includes("metadata:read") ?? false,
    format: p?.config.format ?? "minutes",
    label: p?.config.label ?? "",
  };
}
function dirty(id: string) {
  return (
    !!draft.value[id] &&
    JSON.stringify(draft.value[id]) !== JSON.stringify(draftBase.value[id])
  );
}
function currentRevision(id: string) {
  return (
    configurationRevisions.value[id] ?? installed.value[id]?.revision ?? "0"
  );
}
function resetDraft(id: string) {
  const m = catalog.value.find((item) => item.id === id);
  if (!m) return;
  const value = pluginDraft(m, installed.value[id]);
  draft.value[id] = value;
  draftBase.value[id] = { ...value };
  draftRevision.value[id] = currentRevision(id);
}
async function load() {
  const request = ++serial,
    context = scope;
  const result = await session.api<{
    catalog: Manifest[];
    installed: Installed[];
    configuration_revisions?: Record<string, string>;
  }>("/admin/plugins", "GET", undefined, AbortSignal.timeout(15000));
  if (!alive || context !== scope || request !== serial) return;
  if (
    !Array.isArray(result.catalog) ||
    result.catalog.length !== 2 ||
    !Array.isArray(result.installed) ||
    result.installed.length > 2
  )
    throw new TypeError("插件目录无效");
  catalog.value = result.catalog;
  installed.value = Object.fromEntries(result.installed.map((p) => [p.id, p]));
  configurationRevisions.value =
    result.configuration_revisions ??
    Object.fromEntries(result.installed.map((p) => [p.id, p.revision]));
  // A dirty draft stays attached to the revision it was edited from. Merely
  // reading a newer server revision must not authorize overwriting it.
  for (const m of result.catalog) {
    if (!dirty(m.id)) resetDraft(m.id);
  }
  catalogLoaded.value = true;
}
async function run(id: string, operation: () => Promise<void>) {
  if (busy.value) return;
  const context = scope;
  busy.value = id;
  error.value = "";
  if (id !== "load") message.value = "";
  try {
    await operation();
  } catch (e) {
    if (alive && context === scope)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (alive && context === scope) busy.value = "";
  }
}
async function save(id: string) {
  const d = draft.value[id],
    context = scope;
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
      expected_revision: draftRevision.value[id],
    },
    AbortSignal.timeout(15000),
  );
  if (!alive || context !== scope) return;
  ++serial;
  installed.value[id] = result;
  configurationRevisions.value[id] = result.revision;
  resetDraft(id);
  message.value = "插件设置已保存，新请求使用此配置版本";
  extensions.value = [];
  previewLoaded.value = false;
}
async function rollback(id: string) {
  const p = installed.value[id],
    context = scope;
  if (!p?.can_rollback) return;
  const result = await session.api<Installed>(
    `/admin/plugins/${id}/rollback`,
    "POST",
    { expected_revision: p.revision },
    AbortSignal.timeout(15000),
  );
  if (!alive || context !== scope) return;
  ++serial;
  installed.value[id] = result;
  configurationRevisions.value[id] = result.revision;
  resetDraft(id);
  message.value = "已恢复上一次配置，修订号继续递增";
  extensions.value = [];
  previewLoaded.value = false;
  try {
    await load();
  } catch (e) {
    if (alive && context === scope)
      error.value = `配置已恢复，但目录刷新失败：${e instanceof Error ? e.message : String(e)}。请刷新目录与状态，无需再次恢复。`;
  }
}
function askRemove(id: string) {
  const plugin = catalog.value.find((item) => item.id === id),
    saved = installed.value[id];
  if (busy.value || !plugin || !saved) return;
  removalError.value = "";
  removal.value = { id, name: plugin.name, revision: saved.revision };
}
function closeRemoval() {
  if (busy.value) return;
  removal.value = null;
  removalError.value = "";
}
async function removeConfiguration() {
  const target = removal.value,
    context = scope;
  if (!target || busy.value) return;
  await run(target.id, async () => {
    removalError.value = "";
    try {
      const result = await session.api<{
        id: string;
        removed: boolean;
        revision: string;
      }>(
        `/admin/plugins/${target.id}`,
        "DELETE",
        { expected_revision: target.revision },
        AbortSignal.timeout(15000),
      );
      if (!alive || context !== scope) return;
      if (
        result.id !== target.id ||
        result.removed !== true ||
        !/^[1-9]\d*$/.test(result.revision) ||
        result.revision !== (BigInt(target.revision) + 1n).toString()
      )
        throw new Error("删除结果未确认，请刷新目录与状态后核对");
      ++serial;
      delete installed.value[target.id];
      configurationRevisions.value[target.id] = result.revision;
      resetDraft(target.id);
      removal.value = null;
      message.value =
        "插件配置和上一次配置已删除，权限已撤销。新请求不再输出此扩展；内置目录及变更记录仍保留，可重新配置安装。";
      extensions.value = [];
      previewLoaded.value = false;
      audits.value = [];
      auditLoaded.value = false;
    } catch (e) {
      if (alive && context === scope)
        removalError.value = `删除未完成或结果尚未确认：${e instanceof Error ? e.message : String(e)}。可取消并刷新目录核对；配置冲突时请重新确认当前修订。`;
    }
  });
}
async function preview() {
  if (!selectedMedia.value) return;
  const selected = selectedMedia.value,
    context = scope,
    result = await session.api<{
      media_id: string;
      extensions: typeof extensions.value;
    }>(
      `/media/${selected}/plugin-metadata`,
      "GET",
      undefined,
      AbortSignal.timeout(15000),
    );
  if (!alive || context !== scope || selectedMedia.value !== selected) return;
  if (
    result.media_id !== selected ||
    !Array.isArray(result.extensions) ||
    result.extensions.length > 2
  )
    throw new TypeError("插件输出无效");
  extensions.value = result.extensions;
  previewLoaded.value = true;
}
async function audit() {
  const context = scope;
  const result = await session.api<{ items: typeof audits.value }>(
    "/admin/plugins/audit",
  );
  if (alive && context === scope) {
    audits.value = result.items;
    auditLoaded.value = true;
  }
}
async function loadMedia() {
  const context = scope;
  const result = await session.api<Media[]>("/media");
  if (alive && context === scope) {
    media.value = result.slice(0, 100);
    mediaLoaded.value = true;
  }
}
watch(selectedMedia, () => {
  extensions.value = [];
  previewLoaded.value = false;
});
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
    ++serial;
    catalog.value = [];
    installed.value = {};
    configurationRevisions.value = {};
    removal.value = null;
    removalError.value = "";
    draft.value = {};
    draftBase.value = {};
    draftRevision.value = {};
    catalogLoaded.value = false;
    busy.value = error.value = message.value = "";
    media.value = [];
    mediaLoaded.value = previewLoaded.value = auditLoaded.value = false;
    selectedMedia.value = "";
    extensions.value = [];
    audits.value = [];
  },
  { flush: "sync" },
);
onMounted(
  () =>
    void run("load", async () => {
      const context = scope;
      await load();
      if (alive && context === scope) await loadMedia();
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
      <div class="page-intro">
        <p class="section-label">管理</p>
        <h1>插件管理</h1>
        <p>从受控目录安装声明式元数据扩展，显式授予权限并保留版本回退记录。</p>
      </div>
      <button :disabled="!!busy" @click="run('load', load)">
        <AppIcon name="refresh" />{{
          busy === "load" ? "正在刷新…" : "刷新目录与状态"
        }}
      </button>
    </div>
    <p class="notice">
      当前只支持应用内封闭插件目录。扩展不加载远程脚本，不访问网络、文件、凭据或数据库，不改写影片或播放授权。第三方进程宿主尚未开放。
    </p>
    <Notice :message="error" error />
    <Notice :message="message" />
    <p
      v-if="busy === 'load' && !catalogLoaded"
      class="loading-state loading-state--inline"
      role="status"
    >
      正在加载插件目录…
    </p>
    <div class="content-grid plugin-catalog" :aria-busy="busy === 'load'">
      <article
        v-for="plugin in catalog"
        :key="plugin.id"
        class="panel surface-card plugin-card"
      >
        <header class="section-heading">
          <h2>{{ plugin.name }}</h2>
          <span
            class="status-badge"
            :class="{ 'status-badge--success': installed[plugin.id]?.enabled }"
          >
            {{
              !installed[plugin.id]
                ? "未安装"
                : installed[plugin.id].enabled
                  ? "已启用"
                  : "已停用"
            }}
          </span>
        </header>
        <p>{{ plugin.description }}</p>
        <p class="helper">{{ plugin.id }} · API 1.0 · 封闭声明式</p>
        <form
          v-if="draft[plugin.id]"
          :aria-busy="busy === plugin.id"
          @submit.prevent="run(plugin.id, () => save(plugin.id))"
        >
          <label>
            目录版本
            <AppSelect
              v-model="draft[plugin.id].version"
              label="目录版本"
              :disabled="!!busy"
              :options="
                plugin.versions.map((version) => ({
                  value: version.version,
                  label: version.version,
                }))
              "
            />
          </label>
          <label v-if="plugin.id === 'metadata.duration-badge'">
            时长格式
            <AppSelect
              v-model="draft[plugin.id].format"
              label="时长格式"
              :disabled="!!busy"
              :options="[
                { value: 'minutes', label: '分钟' },
                { value: 'clock', label: '时:分:秒' },
              ]"
            />
          </label>
          <label v-else>
            纯文字说明
            <input
              v-model="draft[plugin.id].label"
              maxlength="40"
              :disabled="!!busy"
              placeholder="例如：优先观看完整版"
            />
          </label>
          <fieldset class="plugin-permissions">
            <legend>运行与权限</legend>
            <label class="plugin-check">
              <input
                v-model="draft[plugin.id].grant"
                type="checkbox"
                :disabled="!!busy"
              />
              <span
                >授予 metadata:read，只读取当前用户有权查看的影片元信息</span
              >
            </label>
            <label class="plugin-check">
              <input
                v-model="draft[plugin.id].enabled"
                type="checkbox"
                :disabled="!!busy"
              />
              <span>启用此插件</span>
            </label>
          </fieldset>
          <details class="plugin-version">
            <summary>版本与制品信息</summary>
            <p class="helper">
              制品摘要
              {{
                plugin.versions.find(
                  (v) => v.version === draft[plugin.id].version,
                )?.artifact_digest
              }}
            </p>
            <p v-if="installed[plugin.id]" class="helper">
              当前修订 {{ installed[plugin.id].revision }} ·
              {{ installed[plugin.id].enabled ? "运行中" : "已停用" }}
            </p>
          </details>
          <p
            v-if="draftRevision[plugin.id] !== currentRevision(plugin.id)"
            class="helper"
            role="status"
          >
            服务端配置已更新；未保存草稿仍基于修订
            {{ draftRevision[plugin.id] }}，不会覆盖新的修订。
          </p>
          <div class="button-row">
            <button
              class="primary"
              :disabled="!!busy || !draft[plugin.id].grant"
            >
              {{
                busy === plugin.id
                  ? "处理中…"
                  : installed[plugin.id]
                    ? "保存配置与版本"
                    : "安装插件"
              }}
            </button>
            <button
              v-if="installed[plugin.id]?.can_rollback"
              type="button"
              :disabled="!!busy"
              @click="run(plugin.id, () => rollback(plugin.id))"
            >
              恢复上一次配置
            </button>
            <button
              v-if="installed[plugin.id]"
              type="button"
              class="danger"
              :disabled="!!busy"
              @click="askRemove(plugin.id)"
            >
              删除配置并停用
            </button>
            <button
              v-if="draftRevision[plugin.id] !== currentRevision(plugin.id)"
              type="button"
              :disabled="!!busy"
              @click="resetDraft(plugin.id)"
            >
              放弃草稿并载入当前配置
            </button>
          </div>
        </form>
      </article>
    </div>
    <div class="content-grid plugin-tools">
      <section
        class="panel surface-card plugin-preview"
        :aria-busy="busy === 'preview'"
      >
        <div class="section-heading__copy">
          <h2>验证实际插件输出</h2>
          <p class="helper">选取你有权查看的影片，读取当前配置的实际结果。</p>
        </div>
        <label>
          可访问的影片
          <AppSelect
            v-model="selectedMedia"
            label="可访问的影片"
            :disabled="!!busy || !media.length"
            :options="[
              { value: '', label: '选择影片' },
              ...media.map((m) => ({ value: m.id, label: m.title })),
            ]"
          />
        </label>
        <div class="button-row">
          <button
            :disabled="!!busy || !selectedMedia"
            @click="run('preview', preview)"
          >
            {{ busy === "preview" ? "正在读取扩展…" : "读取元数据扩展" }}
          </button>
          <button
            v-if="catalogLoaded && !mediaLoaded"
            :disabled="!!busy"
            @click="run('media', loadMedia)"
          >
            {{ busy === "media" ? "正在加载影片…" : "重新加载影片" }}
          </button>
        </div>
        <p v-if="!previewLoaded" class="helper">
          {{
            !catalogLoaded
              ? "加载插件目录后可验证输出。"
              : !mediaLoaded
                ? "影片列表尚未加载，请重新加载影片后再试。"
                : !media.length
                  ? "暂无可访问的影片，请先在媒体库添加影片。"
                  : "选择影片后，读取元数据扩展以查看结果。"
          }}
        </p>
        <p v-else-if="!extensions.length" class="helper" role="status">
          没有可显示的扩展。请启用插件并选择有对应元信息的影片。
        </p>
        <ul v-else class="plugin-results" aria-live="polite">
          <li v-for="extension in extensions" :key="extension.plugin_id">
            <strong>{{ extension.label }}</strong>
            <p class="helper">
              {{ extension.plugin_id }} {{ extension.extension_version }} /
              修订{{ extension.revision }}
            </p>
          </li>
        </ul>
      </section>
      <section
        class="panel surface-card plugin-audit"
        :aria-busy="busy === 'audit'"
      >
        <div class="section-heading__copy">
          <h2>变更记录</h2>
          <p class="helper">查看插件安装、版本升级、配置回退与删除记录。</p>
        </div>
        <div class="button-row">
          <button :disabled="!!busy" @click="run('audit', audit)">
            {{
              busy === "audit"
                ? "正在读取记录…"
                : "查看安装、升级、回退与删除记录"
            }}
          </button>
        </div>
        <p v-if="!auditLoaded" class="helper">
          按需读取记录，核对插件与配置修订。
        </p>
        <p v-else-if="!audits.length" class="helper" role="status">
          暂无插件变更记录。
        </p>
        <ul v-else class="plugin-results">
          <li v-for="entry in audits" :key="entry.id">
            <strong>{{ entry.plugin_id }}</strong>
            <p class="helper">{{ entry.action }} · 修订{{ entry.revision }}</p>
          </li>
        </ul>
      </section>
    </div>
    <AppDialog
      :model-value="!!removal"
      title="删除插件配置"
      :busy="!!busy"
      @update:model-value="
        (open) => {
          if (!open) closeRemoval();
        }
      "
    >
      <template v-if="removal">
        <p>删除“{{ removal.name }}”的配置（修订 {{ removal.revision }}）？</p>
        <p class="helper">
          将停用此插件、撤销权限，并删除已保存配置和上一次可回退的配置。此插件的未保存草稿也会清空，不能通过“恢复上一次配置”撤销。
        </p>
        <p class="helper">
          新的元数据请求将不再输出此扩展；已显示的标签需刷新后消失。内置目录和变更记录保留，可重新配置安装，原媒体与播放不受影响。
        </p>
        <Notice :message="removalError" error />
        <div class="button-row">
          <button type="button" :disabled="!!busy" @click="closeRemoval">
            取消
          </button>
          <button
            type="button"
            class="danger"
            :disabled="!!busy"
            @click="removeConfiguration"
          >
            {{ busy ? "正在删除…" : "确认删除配置并停用" }}
          </button>
        </div>
      </template>
    </AppDialog>
  </section>
</template>
<style scoped>
.plugin-catalog,
.plugin-tools {
  margin-top: var(--space-6);
  align-items: start;
}
.plugin-card,
.plugin-preview,
.plugin-audit {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.plugin-permissions {
  display: grid;
  gap: var(--space-3);
}
.plugin-permissions legend {
  margin-bottom: var(--space-3);
  font-weight: 700;
}
.plugin-check {
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--control-height);
  font-weight: 400;
}
.plugin-check input {
  flex-shrink: 0;
  margin-block: var(--space-1);
}
.plugin-card .helper,
.plugin-results {
  overflow-wrap: anywhere;
}
.plugin-results {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding-left: var(--space-5);
}
</style>
