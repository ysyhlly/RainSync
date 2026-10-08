<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useSession } from "../auth/session.store";
import type { Source } from "../../shared/api/types";
import { RequestFailure } from "../../errors";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import Notice from "../../shared/ui/Notice.vue";
import { parseHttpAssetAssociation } from "./http-asset-association";
import {
  settingsDraft,
  reconcileSettingsDraft,
  type SourceSettings,
  type SourceSettingsSaved,
  type SourceSettingsDraft,
} from "./source-settings";

const props = withDefaults(
  defineProps<{
    source?: Source;
    apiBase?: string;
    requireAdmin?: boolean;
  }>(),
  { requireAdmin: true },
);
const emit = defineEmits<{ close: []; saved: [SourceSettingsSaved] }>();
const session = useSession();
const selectedSource = ref<Source>(),
  detail = ref<SourceSettings>(),
  draft = ref(settingsDraft()),
  baseline = ref(settingsDraft()),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  message = ref(""),
  invalidField = ref(""),
  conflict = ref(false),
  unavailable = ref(false),
  advancedOpen = ref(false),
  discardOpen = ref(false),
  discardAction = ref<"close" | "reload">("close");
const open = computed(() => !!selectedSource.value);
const dirty = computed(
  () =>
    !!detail.value &&
    JSON.stringify(draft.value) !== JSON.stringify(baseline.value),
);
const disabled = computed(() => saving.value || unavailable.value);
const canEditAdvanced = computed(() => session.user?.admin === true);
const apiBase = computed(() => props.apiBase ?? "/sources");
const permitted = computed(
  () => !!session.user && (props.requireAdmin === false || session.user.admin),
);
const kindLabel = computed(
  () =>
    ({
      local: "本地目录",
      http: "HTTP 媒体",
      jellyfin: "Jellyfin",
      emby: "Emby",
    })[selectedSource.value?.kind ?? ""] ?? selectedSource.value?.kind,
);
let alive = true;
let generation = 0;
let pendingLeave: ((discard: boolean) => void) | undefined;
let editingField: HTMLElement | null = null;

function clearDraft() {
  detail.value = undefined;
  draft.value = settingsDraft();
  baseline.value = settingsDraft();
  error.value = message.value = invalidField.value = "";
  conflict.value =
    unavailable.value =
    advancedOpen.value =
    discardOpen.value =
      false;
  loading.value = saving.value = false;
}
function dismiss() {
  ++generation;
  // Dismissal retires the draft, including when permission changes while a
  // route guard is waiting for its discard confirmation.
  pendingLeave?.(true);
  pendingLeave = undefined;
  selectedSource.value = undefined;
  clearDraft();
  emit("close");
}
function focusDiscardDecision() {
  void nextTick(() => {
    const decision = document.getElementById("source-settings-continue");
    decision?.focus({ preventScroll: true });
    // Native focus scrolling does not account for the sticky action footer.
    decision?.scrollIntoView({ block: "center" });
  });
}
function canClose() {
  if (saving.value) return false;
  if (!dirty.value) return true;
  if (!discardOpen.value) editingField = document.activeElement as HTMLElement;
  discardAction.value = "close";
  discardOpen.value = true;
  focusDiscardDecision();
  return false;
}
function closeDraft() {
  if (canClose()) dismiss();
}
function continueEditing() {
  discardOpen.value = false;
  pendingLeave?.(false);
  pendingLeave = undefined;
  void nextTick(() => editingField?.focus());
}
function discardDraft() {
  if (saving.value) return;
  const reload = discardAction.value === "reload";
  discardOpen.value = false;
  if (reload) void load();
  else dismiss();
  pendingLeave?.(!reload);
  pendingLeave = undefined;
}
function requestReload() {
  if (saving.value || loading.value) return;
  if (!dirty.value) return void load();
  editingField = document.activeElement as HTMLElement;
  discardAction.value = "reload";
  discardOpen.value = true;
  focusDiscardDecision();
}
function reportFailure(cause: unknown) {
  const code = cause instanceof RequestFailure ? cause.code : "";
  const adminOnlySetting =
    code === "ADMIN_REQUIRED" && props.requireAdmin === false && !!detail.value;
  conflict.value = code === "SOURCE_CHANGED";
  unavailable.value =
    !adminOnlySetting &&
    [
      "ADMIN_REQUIRED",
      "LIBRARY_ADMIN_REQUIRED",
      "FORBIDDEN",
      "SOURCE_MANAGED_ELSEWHERE",
      "SOURCE_NOT_FOUND",
      "LIBRARY_NOT_FOUND",
      "NOT_FOUND",
    ].includes(code);
  error.value = conflict.value
    ? "片源设置已被其他操作修改。你的输入已保留，请重新载入最新设置后再修改。"
    : code === "SOURCE_CREDENTIALS_ORIGIN_CHANGED"
      ? "更换服务域名时，请明确替换或清除已保存请求头，以免将凭据发送到新地址。"
      : adminOnlySetting
        ? "此项设置仅管理员可修改。你仍可修改有权限的片源设置。"
        : ["ADMIN_REQUIRED", "LIBRARY_ADMIN_REQUIRED", "FORBIDDEN"].includes(
              code,
            )
          ? "你已没有管理片源的权限，请联系管理员。"
          : code === "SOURCE_MANAGED_ELSEWHERE"
            ? "此片源需在所属媒体库或 NAS 设备中管理。"
            : ["SOURCE_NOT_FOUND", "LIBRARY_NOT_FOUND", "NOT_FOUND"].includes(
                  code,
                )
              ? "此片源或所属媒体库已不存在，或你已无权访问。请关闭设置并刷新列表。"
              : cause instanceof Error
                ? cause.message
                : "片源设置暂时无法保存，请重试。";
  if (code === "SOURCE_CREDENTIALS_ORIGIN_CHANGED") advancedOpen.value = true;
}
async function load() {
  const target = selectedSource.value;
  if (!target || saving.value) return;
  const current = ++generation;
  clearDraft();
  if (!permitted.value) {
    unavailable.value = true;
    error.value = "只有管理员可以查看和修改片源设置。";
    return;
  }
  loading.value = true;
  try {
    const value = await session.api<SourceSettings>(
      `${apiBase.value}/${target.id}`,
    );
    if (!alive || generation !== current) return;
    if (value.id !== target.id || value.kind !== target.kind || !value.revision)
      throw Error("片源设置响应不完整，请重新加载。");
    if (!["local", "http", "jellyfin", "emby"].includes(value.kind)) {
      unavailable.value = true;
      error.value = "请在此片源的专用管理入口修改设置。";
      return;
    }
    detail.value = value;
    baseline.value = settingsDraft(value);
    draft.value = settingsDraft(value);
    await nextTick();
    if (alive && generation === current)
      document.getElementById("source-settings-name")?.focus();
  } catch (cause) {
    if (alive && generation === current) reportFailure(cause);
  } finally {
    if (alive && generation === current) loading.value = false;
  }
}
function invalid(field: string, text: string): never {
  invalidField.value = field;
  if (["headers", "assets"].includes(field)) advancedOpen.value = true;
  throw Error(text);
}
function patchConfig(snapshot: SourceSettingsDraft, saved: SourceSettings) {
  if (!snapshot.name.trim()) invalid("name", "请填写片源名称。");
  if (snapshot.name.trim().length > 100)
    invalid("name", "片源名称最多 100 个字符。");
  const config: Record<string, unknown> = {};
  if (saved.kind === "local") {
    if (!snapshot.root.trim()) invalid("root", "请填写容器内路径。");
    if (snapshot.root !== baseline.value.root)
      config.root = snapshot.root.trim();
  } else {
    if (!saved.credentials.url_redacted || snapshot.urlMode === "replace") {
      try {
        const value = new URL(snapshot.url.trim());
        if (
          !["http:", "https:"].includes(value.protocol) ||
          value.username ||
          value.password
        )
          throw Error();
      } catch {
        invalid(
          "url",
          "请填写有效的 HTTP 或 HTTPS 地址，不要在地址中包含用户名或密码。",
        );
      }
      if (snapshot.url !== baseline.value.url || saved.credentials.url_redacted)
        config.url = snapshot.url.trim();
    }
    if (saved.kind === "http") {
      if (snapshot.headersMode === "clear") config.headers = {};
      else if (snapshot.headersMode === "replace") {
        try {
          const value = JSON.parse(snapshot.headers);
          if (
            !value ||
            Array.isArray(value) ||
            typeof value !== "object" ||
            Object.values(value).some((item) => typeof item !== "string")
          )
            throw Error();
          config.headers = value;
        } catch {
          invalid("headers", "请求头须为 JSON 对象，名称和值都须为字符串。");
        }
      }
      if (
        canEditAdvanced.value &&
        snapshot.advancedAssets !== baseline.value.advancedAssets
      ) {
        try {
          config.advanced_assets =
            parseHttpAssetAssociation(snapshot.advancedAssets) ?? null;
        } catch (cause) {
          invalid(
            "assets",
            cause instanceof Error
              ? cause.message
              : "外部字幕/字体声明格式不正确。",
          );
        }
      }
    } else {
      if (!snapshot.userId.trim())
        invalid("user-id", "请填写专用账户 User ID。");
      if (snapshot.userId !== baseline.value.userId)
        config.user_id = snapshot.userId.trim();
      if (snapshot.tokenMode === "replace") {
        if (!snapshot.token.trim())
          invalid("token", "请输入新的访问令牌，或选择保持原令牌。");
        config.token = snapshot.token;
      } else if (snapshot.tokenMode === "clear") config.token = "";
    }
  }
  return config;
}
async function save() {
  if (
    saving.value ||
    loading.value ||
    discardOpen.value ||
    unavailable.value ||
    conflict.value ||
    !detail.value ||
    !dirty.value
  )
    return;
  if (!permitted.value) {
    unavailable.value = true;
    error.value = "你已没有管理片源的权限，请联系管理员。";
    return;
  }
  const original = detail.value;
  const submitted = { ...draft.value };
  const current = generation;
  error.value = message.value = invalidField.value = "";
  let config: Record<string, unknown>;
  try {
    config = patchConfig(submitted, original);
  } catch (cause) {
    reportFailure(cause);
    await nextTick();
    document.getElementById(`source-settings-${invalidField.value}`)?.focus();
    return;
  }
  saving.value = true;
  try {
    const result = await session.api<SourceSettingsSaved>(
      `${apiBase.value}/${original.id}`,
      "PATCH",
      {
        expected_revision: original.revision,
        name: submitted.name.trim(),
        ...(Object.keys(config).length ? { config } : {}),
      },
    );
    if (!alive || generation !== current) return;
    if (
      result.id !== original.id ||
      result.kind !== original.kind ||
      !result.revision
    )
      throw Error("服务器未返回完整保存结果，请重新载入设置以确认结果。");
    const saved = settingsDraft(result);
    draft.value = reconcileSettingsDraft(draft.value, submitted, saved);
    baseline.value = saved;
    detail.value = result;
    emit("saved", result);
    if (!dirty.value) dismiss();
    else message.value = "本次设置已保存，新的修改尚未保存。";
  } catch (cause) {
    if (alive && generation === current) reportFailure(cause);
  } finally {
    if (alive && generation === current) saving.value = false;
  }
}
onBeforeRouteLeave(() => {
  if (!open.value) return true;
  if (saving.value) return false;
  if (canClose()) return true;
  pendingLeave?.(false);
  return new Promise<boolean>((resolve) => {
    pendingLeave = resolve;
  });
});
function beforeUnload(event: BeforeUnloadEvent) {
  if (!open.value || (!dirty.value && !saving.value)) return;
  event.preventDefault();
  event.returnValue = "";
}
watch(
  [() => props.source, apiBase],
  ([value]) => {
    ++generation;
    pendingLeave?.(false);
    pendingLeave = undefined;
    clearDraft();
    selectedSource.value = value;
    if (value) void load();
  },
  { immediate: true },
);
watch(
  [() => session.epoch, () => session.user?.id, () => session.user?.csrf],
  () => {
    if (open.value) dismiss();
    pendingLeave?.(true);
    pendingLeave = undefined;
  },
  { flush: "sync" },
);
watch(
  permitted,
  (value) => {
    if (!value && open.value) dismiss();
  },
  { flush: "sync" },
);
watch(
  () => JSON.stringify(draft.value),
  () => {
    invalidField.value = "";
  },
  { flush: "sync" },
);
onMounted(() => window.addEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => {
  alive = false;
  ++generation;
  pendingLeave?.(false);
  window.removeEventListener("beforeunload", beforeUnload);
  clearDraft();
});
</script>
<template>
  <AppDialog
    :model-value="open"
    title="片源设置"
    drawer
    :busy="saving"
    :can-close="canClose"
    @update:model-value="dismiss"
  >
    <p v-if="loading" class="loading-state loading-state--inline" role="status">
      正在加载片源设置…
    </p>
    <template v-else-if="!detail">
      <Notice :message="error" error />
      <div class="dialog-actions">
        <button type="button" @click="closeDraft">关闭</button>
        <button v-if="!unavailable" type="button" class="primary" @click="load">
          重新加载设置
        </button>
      </div>
    </template>
    <form
      v-else
      class="source-settings-form"
      :aria-busy="saving"
      @submit.prevent="save"
    >
      <p class="helper source-settings-summary">
        修改后会保留此片源及已关联影片，无需删除重建。
      </p>
      <fieldset class="source-settings-group">
        <legend>片源信息</legend>
        <label for="source-settings-name"
          >名称
          <input
            id="source-settings-name"
            v-model="draft.name"
            :disabled="disabled"
            required
            maxlength="100"
            :aria-invalid="invalidField === 'name'"
          />
        </label>
        <div class="source-settings-kind">
          <span>类型</span><span class="status-badge">{{ kindLabel }}</span>
          <p class="helper">类型保持不变，可直接修改下方连接设置。</p>
        </div>
      </fieldset>
      <fieldset class="source-settings-group">
        <legend>连接信息</legend>
        <label v-if="detail.kind === 'local'" for="source-settings-root"
          >容器内路径
          <input
            id="source-settings-root"
            v-model="draft.root"
            :disabled="disabled"
            required
            :aria-invalid="invalidField === 'root'"
          />
        </label>
        <template v-else>
          <label v-if="detail.credentials.url_redacted"
            >已保存的地址
            <AppSelect
              v-model="draft.urlMode"
              :disabled="disabled"
              label="已保存的地址"
              :options="[
                { value: 'keep', label: '保持已保存的地址' },
                { value: 'replace', label: '替换地址' },
              ]"
            />
            <span class="helper"
              >地址含有查询参数，可能包含签名或凭据，因此不会回显。</span
            >
          </label>
          <label
            v-if="
              !detail.credentials.url_redacted || draft.urlMode === 'replace'
            "
            for="source-settings-url"
            >{{ detail.kind === "http" ? "媒体 URL" : "服务 URL" }}
            <input
              id="source-settings-url"
              v-model="draft.url"
              :disabled="disabled"
              type="url"
              required
              autocomplete="off"
              :aria-invalid="invalidField === 'url'"
            />
          </label>
          <template v-if="detail.kind === 'jellyfin' || detail.kind === 'emby'">
            <label for="source-settings-user-id"
              >专用账户 User ID
              <input
                id="source-settings-user-id"
                v-model="draft.userId"
                :disabled="disabled"
                required
                autocomplete="off"
                :aria-invalid="invalidField === 'user-id'"
              />
            </label>
            <label
              >访问令牌
              <AppSelect
                v-model="draft.tokenMode"
                :disabled="disabled"
                label="访问令牌处理方式"
                :options="[
                  {
                    value: 'keep',
                    label: detail.credentials.token_configured
                      ? '保持已保存的令牌'
                      : '保持未配置',
                  },
                  { value: 'replace', label: '替换访问令牌' },
                  { value: 'clear', label: '清除已保存的令牌' },
                ]"
              />
              <span class="helper">{{
                detail.credentials.token_configured
                  ? "已保存令牌，出于安全考虑不回显。"
                  : "尚未配置访问令牌。"
              }}</span>
            </label>
            <label
              v-if="draft.tokenMode === 'replace'"
              for="source-settings-token"
              >新的访问令牌
              <input
                id="source-settings-token"
                v-model="draft.token"
                :disabled="disabled"
                type="password"
                autocomplete="new-password"
                required
                :aria-invalid="invalidField === 'token'"
              />
            </label>
            <p v-if="draft.tokenMode === 'clear'" class="helper">
              保存后将移除访问令牌，可能无法连接此服务。
            </p>
          </template>
        </template>
      </fieldset>
      <details
        v-if="detail.kind === 'http'"
        :open="advancedOpen"
        @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>
          高级选项：请求头与外部字幕{{
            detail.credentials.headers_configured || draft.advancedAssets
              ? "（已配置）"
              : ""
          }}
        </summary>
        <div class="source-settings-advanced">
          <label
            >请求头
            <AppSelect
              v-model="draft.headersMode"
              :disabled="disabled"
              label="请求头处理方式"
              :options="[
                {
                  value: 'keep',
                  label: detail.credentials.headers_configured
                    ? '保持已保存的请求头'
                    : '保持未配置',
                },
                { value: 'replace', label: '替换全部请求头' },
                { value: 'clear', label: '清除全部请求头' },
              ]"
            />
            <span class="helper">{{
              detail.credentials.headers_configured
                ? "已保存请求头，凭据值不会回显。替换时请填写完整的新请求头。"
                : "未配置请求头，可按需添加。"
            }}</span>
          </label>
          <label
            v-if="draft.headersMode === 'replace'"
            for="source-settings-headers"
            >新的请求头 JSON
            <textarea
              id="source-settings-headers"
              v-model="draft.headers"
              :disabled="disabled"
              spellcheck="false"
              required
              placeholder='{"Authorization":"Bearer …"}'
              :aria-invalid="invalidField === 'headers'"
            />
          </label>
          <p v-if="draft.headersMode === 'clear'" class="helper">
            保存后将清除全部请求头，需要鉴权的媒体可能无法播放。
          </p>
          <label v-if="canEditAdvanced" for="source-settings-assets"
            >外部字幕/字体关联 JSON（可选）
            <textarea
              id="source-settings-assets"
              v-model="draft.advancedAssets"
              :disabled="disabled"
              spellcheck="false"
              maxlength="32768"
              placeholder='{"schema_version":1,"subtitles":["ass"],"fonts":["body.ttf"]}'
              :aria-invalid="invalidField === 'assets'"
              aria-describedby="source-settings-assets-help"
            />
          </label>
          <p
            v-if="canEditAdvanced"
            id="source-settings-assets-help"
            class="helper"
          >
            留空会移除此关联声明。支持同名 ASS、SSA、PGS 字幕及同名 .fonts
            目录内的字体。
          </p>
          <p v-else class="helper">
            外部字幕/字体关联仅管理员可修改，保存其他设置时会保留现有关联。
          </p>
        </div>
      </details>
      <p class="source-settings-impact helper">
        修改连接信息会中断此片源正在进行的播放，并可能需要重新检测扫描；仅修改名称不会中断播放。
      </p>
      <div
        v-if="discardOpen"
        class="confirm-panel"
        role="group"
        aria-label="放弃未保存的片源设置"
      >
        <p>
          {{
            discardAction === "reload"
              ? "重新载入会放弃当前未保存的修改，包括新输入的凭据。"
              : "片源设置尚未保存。放弃后会清除本次修改，包括新输入的凭据。"
          }}
        </p>
        <button
          id="source-settings-continue"
          type="button"
          @click="continueEditing"
        >
          继续编辑
        </button>
        <button class="danger" type="button" @click="discardDraft">
          {{
            discardAction === "reload" ? "放弃修改并重新载入" : "放弃未保存内容"
          }}
        </button>
      </div>
      <div class="source-settings-actions">
        <Notice :message="error" error /><Notice :message="message" />
        <button
          v-if="conflict"
          type="button"
          :disabled="saving || discardOpen"
          @click="requestReload"
        >
          重新载入已保存设置
        </button>
        <div class="dialog-actions">
          <button type="button" :disabled="saving" @click="closeDraft">
            取消
          </button>
          <button
            class="primary"
            :disabled="disabled || conflict || discardOpen || !dirty"
          >
            {{ saving ? "正在保存…" : "保存设置" }}
          </button>
        </div>
      </div>
    </form>
  </AppDialog>
</template>
<style scoped>
.source-settings-form,
.source-settings-group,
.source-settings-advanced {
  display: grid;
  gap: var(--space-4);
}
.source-settings-group legend {
  margin-bottom: var(--space-3);
  font-weight: 700;
}
.source-settings-summary {
  margin-top: 0;
}
.source-settings-kind {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.source-settings-kind p {
  margin: 0;
}
.source-settings-form summary {
  cursor: pointer;
  padding-block: var(--space-3);
}
.source-settings-advanced {
  padding-top: var(--space-3);
}
.source-settings-impact {
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-small);
}
.source-settings-actions {
  position: sticky;
  bottom: 0;
  padding-block: var(--space-4);
  background: var(--surface-panel);
  border-top: 1px solid var(--border-subtle);
  z-index: 1;
}
</style>
