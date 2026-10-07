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
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
import {
  adminSettingFields,
  adminSettingKeys,
  settingsDraft,
  changedSettings,
  invalidSetting,
  checkedSettings,
  olderSettings,
  type AdminSettingsSnapshot,
  type AdminSettingKey,
} from "./admin-settings";

const session = useSession();
const detail = ref<AdminSettingsSnapshot>(),
  draft = ref(settingsDraft()),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  refreshError = ref(""),
  message = ref(""),
  navigationMessage = ref(""),
  invalidField = ref<AdminSettingKey>(),
  conflict = ref(false),
  uncertain = ref(false),
  unavailable = ref(false),
  decision = ref<"" | "discard" | "reload" | "leave" | "reset" | "access">("");
const permitted = computed(() => session.user?.admin === true);
const dirty = computed(
  () =>
    !!detail.value &&
    Object.keys(changedSettings(draft.value, detail.value)).length > 0,
);
const changedCount = computed(() =>
  detail.value
    ? Object.keys(changedSettings(draft.value, detail.value)).length
    : 0,
);
const disabled = computed(
  () => saving.value || loading.value || !permitted.value || unavailable.value,
);
const saveStatus = computed(() =>
  saving.value
    ? "正在保存，请稍候…"
    : dirty.value
      ? `${changedCount.value} 项修改待保存`
      : refreshError.value
        ? message.value.startsWith("设置已保存")
          ? "已保存，状态待刷新"
          : "状态待刷新"
        : "管理员设置已同步",
);
const hasOverrides = computed(
  () =>
    detail.value &&
    adminSettingKeys.some((key) => draft.value[key].mode === "override"),
);
const decisionOpen = computed({
  get: () => !!decision.value,
  set: (open) => {
    if (!open) continueEditing();
  },
});
const decisionTitle = computed(
  () =>
    ({
      discard: "放弃未保存的修改？",
      reload: "重新载入最新设置？",
      leave: "离开管理员设置？",
      reset: "恢复部署默认值？",
      access: "确认开放访问入口？",
    })[decision.value || "discard"],
);
const groups = [
  {
    id: "playback",
    title: "播放与队列",
    description: "控制新增播放请求与全站媒体准备任务容量，保护共享资源。",
    icon: "play",
  },
  {
    id: "registration",
    title: "注册限流",
    description: "管理注册入口的请求频率，与所选注册方式共同生效。",
    icon: "key",
  },
] as const;
const modeOptions = [
  { value: "default", label: "继承部署默认" },
  { value: "override", label: "自定义设置" },
];
const registrationOptions = [
  { value: "closed", label: "关闭注册" },
  { value: "invite_only", label: "仅邀请码注册" },
  { value: "open", label: "开放自行注册" },
];
const guestOptions = [
  { value: "false", label: "禁用访客" },
  { value: "true", label: "允许受限访客" },
];
function registrationLabel(value: unknown) {
  return (
    registrationOptions.find((option) => option.value === value)?.label ??
    "未知"
  );
}
const openingRegistration = computed(
  () =>
    detail.value &&
    (draft.value.registration_mode.mode === "default"
      ? detail.value.defaults.registration_mode
      : draft.value.registration_mode.value) === "open" &&
    detail.value.values.registration_mode !== "open",
);
const enablingGuests = computed(
  () =>
    detail.value &&
    (draft.value.guests_enabled.mode === "default"
      ? detail.value.defaults.guests_enabled
      : draft.value.guests_enabled.value) === true &&
    !detail.value.values.guests_enabled,
);
function setGuestValue(value: string | number | null) {
  if (!disabled.value) draft.value.guests_enabled.value = value === "true";
}
const managementLinks = [
  {
    to: "/admin/sources",
    title: "片源管理",
    text: "编辑片源、访问策略与扫描设置",
    icon: "movie",
  },
  {
    to: "/admin/agents",
    title: "NAS 设备",
    text: "管理配对、目录授权与计算配额",
    icon: "server",
  },
  {
    to: "/admin/plugins",
    title: "插件管理",
    text: "配置插件、权限与版本回退",
    icon: "settings",
  },
  {
    to: "/admin/registration-invites",
    title: "账号与注册",
    text: "管理邀请码并创建账号",
    icon: "key",
  },
] as const;
let alive = true,
  scope = 0,
  loadSerial = 0;
let pendingLeave: ((discard: boolean) => void) | undefined;
let readController: AbortController | undefined,
  writeController: AbortController | undefined;
let confirmed: AdminSettingsSnapshot | undefined;
function ignored(cause: unknown) {
  return (
    cause instanceof Error &&
    ["StaleIdentity", "AbortError"].includes(cause.name)
  );
}
function code(cause: unknown) {
  return String((cause as { code?: string })?.code ?? "").toLowerCase();
}
function denyAccess(reason = "管理员权限已失效，请重新确认登录身份。") {
  ++scope;
  ++loadSerial;
  readController?.abort();
  writeController?.abort();
  detail.value = undefined;
  confirmed = undefined;
  draft.value = settingsDraft();
  loading.value = saving.value = false;
  conflict.value = uncertain.value = false;
  unavailable.value = true;
  message.value = refreshError.value = navigationMessage.value = "";
  error.value = reason;
  decision.value = "";
  pendingLeave?.(true);
  pendingLeave = undefined;
}
function resume() {
  if (!permitted.value || saving.value) return;
  unavailable.value = false;
  error.value = "";
  void load();
}
function setMode(key: AdminSettingKey, mode: string | number | null) {
  if (disabled.value || !detail.value) return;
  draft.value[key].mode = mode === "default" ? "default" : "override";
  if (mode === "default") draft.value[key].value = detail.value.defaults[key];
}
async function load() {
  if (!alive || saving.value || !permitted.value || unavailable.value) return;
  const context = scope,
    request = ++loadSerial;
  readController?.abort();
  const controller = (readController = new AbortController());
  loading.value = true;
  refreshError.value = "";
  if (!detail.value) error.value = "";
  try {
    const value = checkedSettings(
      await session.api<AdminSettingsSnapshot>(
        "/admin/settings",
        "GET",
        undefined,
        controller.signal,
      ),
    );
    if (!alive || context !== scope || request !== loadSerial) return;
    if (detail.value && olderSettings(value, detail.value)) {
      refreshError.value = confirmed
        ? "服务器读到了较早版本，已保留最近确认的保存结果。请稍后重试刷新，无需重复保存。"
        : "服务器读到了较早版本，已保留当前设置。请稍后重试刷新。";
      return;
    }
    detail.value = value;
    draft.value = settingsDraft(value);
    confirmed = undefined;
    error.value = "";
    invalidField.value = undefined;
    conflict.value = uncertain.value = false;
  } catch (cause) {
    if (!alive || context !== scope || request !== loadSerial || ignored(cause))
      return;
    if (["admin_required", "forbidden"].includes(code(cause)))
      return denyAccess();
    const text = "设置读取失败，请检查连接后重试。";
    if (!detail.value) error.value = text;
    else
      refreshError.value = confirmed
        ? "已确认的修改已保存，但状态刷新失败。请重试刷新，无需重复保存。"
        : `${text}当前输入已保留。`;
  } finally {
    if (alive && context === scope && request === loadSerial)
      loading.value = false;
  }
}
async function save(allowAccessChange = false) {
  if (
    disabled.value ||
    decision.value ||
    conflict.value ||
    uncertain.value ||
    !detail.value ||
    !dirty.value
  )
    return;
  invalidField.value = invalidSetting(draft.value, detail.value);
  if (invalidField.value) {
    error.value = `请输入 ${detail.value.bounds.min}–${detail.value.bounds.max} 范围内的整数。`;
    await nextTick();
    document.getElementById(`setting-${invalidField.value}`)?.focus();
    return;
  }
  if (
    !allowAccessChange &&
    (openingRegistration.value || enablingGuests.value)
  ) {
    decision.value = "access";
    return;
  }
  const snapshot = detail.value,
    changes = changedSettings(draft.value, snapshot),
    context = scope;
  const controller = (writeController = new AbortController());
  saving.value = true;
  error.value =
    refreshError.value =
    message.value =
    navigationMessage.value =
      "";
  try {
    const result = await session.api<AdminSettingsSnapshot>(
      "/admin/settings",
      "PATCH",
      {
        expected_revision: snapshot.revision,
        changes,
      },
      controller.signal,
    );
    if (!alive || context !== scope) return;
    let value: AdminSettingsSnapshot;
    try {
      value = checkedSettings(result);
      if (
        olderSettings(value, snapshot) ||
        value.revision === snapshot.revision ||
        Object.entries(changes).some(
          ([key, number]) => value.overrides[key as AdminSettingKey] !== number,
        )
      )
        throw Error("invalid receipt");
    } catch {
      uncertain.value = true;
      error.value =
        "保存响应不完整，暂时无法确认结果。请先刷新核对，避免重复提交。";
      return;
    }
    confirmed = value;
    detail.value = value;
    draft.value = settingsDraft(value);
    message.value =
      "设置已保存，无需重启。新上限用于后续请求；注册与访客入口按当前策略执行。";
    // Read failure is separate from the accepted write receipt.
    saving.value = false;
    await load();
  } catch (cause) {
    if (!alive || context !== scope || ignored(cause)) return;
    if (["admin_required", "forbidden"].includes(code(cause)))
      return denyAccess();
    conflict.value = code(cause) === "settings_revision_conflict";
    if (conflict.value)
      error.value =
        "设置已被其他管理员修改。你的输入已保留，请重新载入最新版本，再决定修改内容。";
    else if (code(cause) === "invalid_admin_settings")
      error.value = "服务器未接受此设置，请检查整数范围后再保存。";
    else {
      uncertain.value = true;
      error.value =
        "保存请求未能确认结果。请先刷新核对服务器当前值，避免重复提交。";
    }
  } finally {
    if (alive && context === scope) {
      saving.value = false;
      navigationMessage.value = "";
    }
  }
}
function requestDecision(action: "discard" | "reload" | "reset") {
  if (disabled.value || decision.value) return;
  navigationMessage.value = "";
  if (action === "reload" && !dirty.value) return void load();
  if (action === "discard" && !dirty.value) return;
  if (action === "reset" && (!detail.value || !hasOverrides.value)) return;
  decision.value = action;
}
function continueEditing() {
  decision.value = "";
  pendingLeave?.(false);
  pendingLeave = undefined;
}
function confirmDecision() {
  if (disabled.value || !decision.value) return;
  const action = decision.value;
  decision.value = "";
  if (action === "access") void save(true);
  else if (action === "reload") void load();
  else if (action === "reset" && detail.value) {
    draft.value = settingsDraft(detail.value);
    for (const key of adminSettingKeys) {
      draft.value[key] = { mode: "default", value: detail.value.defaults[key] };
    }
    error.value = "";
    invalidField.value = undefined;
    message.value =
      "已将全部设置调整为继承部署默认。注册恢复为仅邀请码、访客恢复为禁用；点击“保存修改”后生效。";
  } else {
    draft.value = settingsDraft(detail.value);
    error.value = "";
    invalidField.value = undefined;
  }
  pendingLeave?.(action === "leave");
  pendingLeave = undefined;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value && !saving.value) return;
  event.preventDefault();
  event.returnValue = "";
}
onBeforeRouteLeave(() => {
  if (!permitted.value || unavailable.value) return true;
  if (saving.value) {
    navigationMessage.value = "正在保存设置，请等待结果后再离开。";
    return false;
  }
  if (!dirty.value) return true;
  pendingLeave?.(false);
  decision.value = "leave";
  return new Promise<boolean>((resolve) => {
    pendingLeave = resolve;
  });
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
    denyAccess("登录身份或管理员权限已变化，请重新载入当前身份的设置。");
  },
  { flush: "sync" },
);
onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void load();
});
onBeforeUnmount(() => {
  alive = false;
  ++scope;
  ++loadSerial;
  readController?.abort();
  writeController?.abort();
  pendingLeave?.(false);
  pendingLeave = undefined;
  window.removeEventListener("beforeunload", beforeUnload);
});
function bytes(value: number) {
  return `${Number((value / 1048576).toFixed(2))} MiB`;
}
</script>

<template>
  <div class="page admin-settings-page">
    <header class="page-title">
      <div class="page-intro">
        <p class="page-eyebrow">全局配置</p>
        <h1>管理员设置</h1>
        <p>集中管理运行上限与部署状态，按对象进入片源、NAS 和插件配置。</p>
      </div>
      <button
        :disabled="disabled || !!decision"
        @click="requestDecision('reload')"
      >
        <AppIcon name="refresh" />{{ loading ? "正在刷新…" : "刷新设置" }}
      </button>
    </header>

    <Notice :message="message" />
    <Notice :message="refreshError" error />
    <Notice :message="error" error />
    <Notice :message="navigationMessage" />
    <button v-if="unavailable && permitted" @click="resume">
      重新载入当前身份的设置
    </button>
    <p v-if="!permitted" class="notice error" role="alert">
      只有管理员可以查看和修改全局设置。
    </p>
    <div
      v-if="loading && !detail"
      class="surface-card loading-state"
      role="status"
    >
      正在加载管理员设置…
    </div>
    <div
      v-else-if="!detail && !unavailable && permitted"
      class="surface-card empty-state empty-state--compact"
    >
      <AppIcon name="settings" :size="32" />
      <h2>暂时无法读取设置</h2>
      <p class="helper">连接恢复后可重试，尚未加载任何配置。</p>
      <button class="primary" :disabled="loading" @click="load">
        重试加载
      </button>
    </div>

    <template v-if="detail && permitted && !unavailable">
      <div class="settings-overview surface-card surface-card--compact">
        <div>
          <span class="status-badge">管理员专用</span>
          <p>运行上限保存后生效，部署项由服务部署负责人维护。</p>
        </div>
        <p class="helper">
          当前版本 {{ detail.revision
          }}<span v-if="dirty"> · {{ changedCount }} 项待保存</span
          ><span v-else-if="refreshError"> · 待刷新确认</span>
          <span v-else> · 已与服务器同步</span>
        </p>
      </div>
      <nav class="settings-sections" aria-label="设置分类">
        <a href="#settings-access">注册与访客</a
        ><a href="#settings-playback">播放与队列</a
        ><a href="#settings-registration">注册限流</a
        ><a href="#settings-deployment">部署状态</a
        ><a href="#settings-management">管理入口</a>
      </nav>

      <form
        class="page-stack"
        :aria-busy="saving || loading"
        novalidate
        @submit.prevent="save()"
      >
        <section
          id="settings-access"
          class="surface-card settings-section"
          aria-labelledby="settings-heading-access"
        >
          <header class="section-heading">
            <div class="settings-heading">
              <span class="settings-icon"><AppIcon name="user" /></span>
              <div class="section-heading__copy">
                <h2 id="settings-heading-access">注册与访客</h2>
                <p>
                  选择账号注册方式与受限访客入口。默认仅邀请码注册，访客禁用。
                </p>
              </div>
            </div>
            <span class="status-badge">保存后生效</span>
          </header>
          <div class="settings-field">
            <div class="settings-field-copy">
              <h3 class="settings-field-label">注册方式</h3>
              <p id="setting-registration_mode-help" class="helper">
                关闭注册会停止新账号自助注册；仅邀请码要求有效邀请；开放注册允许访客自行创建普通账号。已有账号仍可登录。
              </p>
              <p class="settings-current">
                当前生效
                <strong>{{
                  registrationLabel(detail.values.registration_mode)
                }}</strong>
              </p>
            </div>
            <div class="settings-field-control">
              <AppSelect
                :model-value="draft.registration_mode.mode"
                :options="modeOptions"
                label="注册方式的配置方式"
                :disabled="disabled"
                @update:model-value="setMode('registration_mode', $event)"
              /><AppSelect
                :model-value="String(draft.registration_mode.value)"
                @update:model-value="
                  draft.registration_mode.value = String($event)
                "
                :options="registrationOptions"
                label="注册方式"
                :disabled="
                  disabled || draft.registration_mode.mode === 'default'
                "
                described-by="setting-registration_mode-help setting-registration_mode-risk"
              />
              <p class="field-hint">
                部署默认：{{
                  registrationLabel(detail.defaults.registration_mode)
                }}
              </p>
            </div>
          </div>
          <p id="setting-registration_mode-risk" class="notice warning">
            开放注册会扩大账号与存储资源使用范围，也会增加滥用风险。请先确认部署的网络访问范围和下方注册限流，再保存启用。
          </p>
          <div class="settings-field">
            <div class="settings-field-copy">
              <h3 class="settings-field-label">访客访问</h3>
              <p id="setting-guests_enabled-help" class="helper">
                允许无需创建普通账号的受限访客访问。访客须持有效的非定向观看邀请，且房间单独允许访客；不能管理或控制播放。关闭会立即中断现有访客会话，再次开启也不会恢复旧会话，访客需重新受邀进入。
              </p>
              <p class="settings-current">
                当前生效
                <strong>{{
                  detail.values.guests_enabled ? "允许受限访客" : "禁用访客"
                }}</strong>
              </p>
            </div>
            <div class="settings-field-control">
              <AppSelect
                :model-value="draft.guests_enabled.mode"
                :options="modeOptions"
                label="访客访问的配置方式"
                :disabled="disabled"
                @update:model-value="setMode('guests_enabled', $event)"
              /><AppSelect
                :model-value="String(draft.guests_enabled.value)"
                :options="guestOptions"
                label="访客访问"
                :disabled="disabled || draft.guests_enabled.mode === 'default'"
                described-by="setting-guests_enabled-help"
                @update:model-value="setGuestValue"
              />
              <p class="field-hint">部署默认：禁用访客</p>
            </div>
          </div>
        </section>
        <section
          v-for="group in groups"
          :id="`settings-${group.id}`"
          :key="group.id"
          class="surface-card settings-section"
          :aria-labelledby="`settings-heading-${group.id}`"
        >
          <header class="section-heading">
            <div class="settings-heading">
              <span class="settings-icon"><AppIcon :name="group.icon" /></span>
              <div class="section-heading__copy">
                <h2 :id="`settings-heading-${group.id}`">{{ group.title }}</h2>
                <p>{{ group.description }}</p>
              </div>
            </div>
            <span class="status-badge">保存后生效</span>
          </header>
          <div
            v-for="field in adminSettingFields.filter(
              (field) => field.group === group.id,
            )"
            :key="field.key"
            class="settings-field"
          >
            <div class="settings-field-copy">
              <label
                :for="`setting-${field.key}`"
                class="settings-field-label"
                >{{ field.label }}</label
              >
              <p :id="`setting-${field.key}-help`" class="helper">
                {{ field.description }}
              </p>
              <p class="settings-current">
                当前生效 <strong>{{ detail.values[field.key] }}</strong>
                {{ field.unit }}
                <span
                  >·
                  {{
                    detail.overrides[field.key] === null
                      ? "继承部署默认"
                      : "管理员自定义"
                  }}</span
                >
              </p>
            </div>
            <div class="settings-field-control">
              <AppSelect
                :model-value="draft[field.key].mode"
                @update:model-value="setMode(field.key, $event)"
                :options="modeOptions"
                :label="`${field.label}的配置方式`"
                :disabled="disabled"
                :described-by="`setting-${field.key}-help setting-${field.key}-bounds`"
              />
              <div class="settings-number">
                <input
                  :id="`setting-${field.key}`"
                  v-model="draft[field.key].value"
                  type="number"
                  inputmode="numeric"
                  :min="detail.bounds.min"
                  :max="detail.bounds.max"
                  step="1"
                  required
                  :disabled="disabled || draft[field.key].mode === 'default'"
                  :aria-label="field.label"
                  :aria-invalid="invalidField === field.key || undefined"
                  :aria-describedby="`setting-${field.key}-help setting-${field.key}-bounds`"
                /><span>{{ field.unit }}</span>
              </div>
              <p :id="`setting-${field.key}-bounds`" class="field-hint">
                允许 {{ detail.bounds.min }}–{{ detail.bounds.max }}；部署默认
                {{ detail.defaults[field.key]
                }}<span v-if="draft[field.key].mode === 'default'"
                  >（保存后使用此默认值）</span
                >
              </p>
            </div>
          </div>
        </section>

        <div class="settings-savebar surface-card surface-card--compact">
          <div>
            <strong>{{ saveStatus }}</strong>
            <p class="helper">
              恢复默认会清除全部管理员覆盖值，关闭开放注册与访客。
            </p>
          </div>
          <div class="button-row">
            <button
              type="button"
              :disabled="
                disabled || !hasOverrides || conflict || uncertain || !!decision
              "
              @click="requestDecision('reset')"
            >
              恢复部署默认…
            </button>
            <button
              type="button"
              :disabled="disabled || !dirty || !!decision"
              @click="requestDecision('discard')"
            >
              取消修改
            </button>
            <button
              class="primary"
              :disabled="
                disabled || !dirty || conflict || uncertain || !!decision
              "
            >
              {{ saving ? "正在保存…" : "保存修改" }}
            </button>
          </div>
          <div v-if="refreshError" class="settings-recovery" role="status">
            <p class="helper">
              {{
                message.startsWith("设置已保存")
                  ? "修改已确认保存，服务器状态暂未刷新，无需重复保存。"
                  : "服务器状态未能刷新，当前输入已保留。"
              }}
            </p>
            <button
              type="button"
              :disabled="disabled || !!decision"
              @click="requestDecision('reload')"
            >
              重试刷新状态
            </button>
          </div>
          <div v-if="conflict || uncertain" class="settings-recovery">
            <p class="helper">先载入服务器当前设置，确认后再重新编辑。</p>
            <button
              type="button"
              :disabled="disabled || !!decision"
              @click="requestDecision('reload')"
            >
              重新载入最新设置…
            </button>
          </div>
        </div>
      </form>

      <section
        id="settings-deployment"
        class="surface-card settings-section"
        aria-labelledby="settings-heading-deployment"
      >
        <header class="section-heading">
          <div class="settings-heading">
            <span class="settings-icon"><AppIcon name="server" /></span>
            <div class="section-heading__copy">
              <h2 id="settings-heading-deployment">部署状态</h2>
              <p>
                以下为当前部署配置状态，不代表运行健康检查。由部署负责人修改部署配置并重启相关服务后生效。
              </p>
            </div>
          </div>
          <span class="status-badge">只读</span>
        </header>
        <dl class="settings-deployment-grid">
          <div>
            <dt>私有媒体库</dt>
            <dd>
              {{
                detail.deployment.private_libraries_enabled
                  ? "已启用"
                  : "未启用"
              }}
            </dd>
            <p class="helper">开启后仍需按媒体库授予访问权限。</p>
          </div>
          <div>
            <dt>NAS 本地计算</dt>
            <dd>
              {{
                detail.deployment.nas_compute_enabled
                  ? "服务端已配置"
                  : "服务端未配置"
              }}
            </dd>
            <p class="helper">每台设备仍需单独授权计算能力和配额。</p>
          </div>
          <div>
            <dt>点对点传输</dt>
            <dd>{{ detail.deployment.p2p_enabled ? "已启用" : "未启用" }}</dd>
            <p class="helper">实际传输方式取决于播放与连接条件。</p>
          </div>
          <div>
            <dt>其他直播平台</dt>
            <dd>
              {{ detail.deployment.other_live_enabled ? "已启用" : "未启用" }}
            </dd>
            <p class="helper">平台解析能力由当前部署提供。</p>
          </div>
        </dl>
        <div class="settings-preview">
          <h3>媒体预览资源</h3>
          <dl>
            <div>
              <dt>并发任务</dt>
              <dd>{{ detail.deployment.preview.concurrency }}</dd>
            </div>
            <div>
              <dt>任务超时</dt>
              <dd>{{ detail.deployment.preview.timeout_seconds }} 秒</dd>
            </div>
            <div>
              <dt>预览缓存</dt>
              <dd>{{ bytes(detail.deployment.preview.cache_bytes) }}</dd>
            </div>
            <div>
              <dt>等待队列</dt>
              <dd>{{ detail.deployment.preview.queue_limit }}</dd>
            </div>
            <div>
              <dt>单次输入上限</dt>
              <dd>{{ bytes(detail.deployment.preview.input_bytes) }}</dd>
            </div>
          </dl>
        </div>
        <p class="helper settings-ownership">
          数据库连接、加密密钥、服务地址、存储路径与第三方凭据由部署负责人或对应对象设置维护。此页不显示这些值，也不会修改部署文件。
        </p>
      </section>
    </template>

    <section
      v-if="permitted && !unavailable"
      id="settings-management"
      class="settings-section"
      aria-labelledby="settings-heading-management"
    >
      <header class="section-heading">
        <div class="section-heading__copy">
          <h2 id="settings-heading-management">按对象管理</h2>
          <p>每个片源、设备与插件保留独立的配置、权限和变更记录。</p>
        </div>
      </header>
      <div class="settings-management-grid">
        <RouterLink
          v-for="link in managementLinks"
          :key="link.to"
          :to="link.to"
          class="surface-card settings-management-link"
          ><AppIcon :name="link.icon" /><span
            ><strong>{{ link.title }}</strong
            ><small>{{ link.text }}</small></span
          ><AppIcon name="next"
        /></RouterLink>
      </div>
    </section>

    <AppDialog v-model="decisionOpen" :title="decisionTitle" :busy="saving">
      <p v-if="decision === 'reset'">
        将全部设置切换为继承部署默认值，注册恢复为仅邀请码，访客恢复为禁用。已有输入会被替换；确认后仍需点击“保存修改”才会生效。
      </p>
      <div v-else-if="decision === 'access'">
        <p v-if="openingRegistration">
          开放注册将允许可访问此站点的人自行创建普通账号。请确认账号滥用和资源增长风险。
        </p>
        <p v-if="enablingGuests">
          允许受限访客后，持有有效的非定向观看邀请的人可以进入单独允许访客的房间，访客不能跨房间、控制播放或执行管理操作。
        </p>
        <p class="helper">此操作会同时保存本页其他待保存修改。</p>
      </div>
      <p v-else-if="decision === 'reload'">
        读取服务器最新设置并替换当前输入。如果刷新失败，会继续保留你的输入。尚未保存的修改不会提交。
      </p>
      <p v-else-if="decision === 'leave'">
        你有尚未保存的设置，离开会放弃这些输入。
      </p>
      <p v-else>放弃当前输入，恢复为上次从服务器读取的设置？</p>
      <div class="dialog-actions">
        <button type="button" :disabled="saving" @click="continueEditing">
          {{
            decision === "reset" || decision === "access" ? "取消" : "继续编辑"
          }}</button
        ><button
          type="button"
          class="primary"
          :disabled="saving"
          @click="confirmDecision"
        >
          {{
            decision === "access"
              ? "确认开放并保存"
              : decision === "reset"
                ? "使用部署默认值"
                : decision === "reload"
                  ? "放弃输入并重新载入"
                  : decision === "leave"
                    ? "放弃修改并离开"
                    : "放弃修改"
          }}
        </button>
      </div>
    </AppDialog>
  </div>
</template>

<style scoped>
.admin-settings-page {
  display: grid;
  gap: var(--space-6);
}
.admin-settings-page > .page-title,
.admin-settings-page > .notice {
  margin-bottom: 0;
}
.settings-overview,
.settings-savebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-4);
}
.settings-overview > div {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.settings-overview p {
  margin: 0;
}
.settings-sections {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.settings-sections a {
  display: inline-flex;
  align-items: center;
  min-height: var(--control-height);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
  text-decoration: none;
  background: var(--surface-panel);
}
.settings-sections a:hover {
  background: var(--accent-soft);
}
.settings-section {
  scroll-margin-top: var(--space-6);
}
.settings-heading {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 280px;
  min-width: 0;
}
.settings-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 40px;
  height: 40px;
  border-radius: var(--radius-widget);
  background: var(--surface-muted);
}
.settings-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
  gap: var(--space-8);
  align-items: start;
  padding-block: var(--space-5);
  border-top: 1px solid var(--border-subtle);
}
.settings-field:last-child {
  padding-bottom: 0;
}
.settings-field-copy {
  min-width: 0;
}
.settings-field-label {
  font-weight: 650;
  margin-bottom: var(--space-2);
}
.settings-field-copy > .helper {
  margin: 0 0 var(--space-3);
  max-width: 62ch;
}
.settings-current {
  font-size: var(--font-size-sm);
  margin: 0;
}
.settings-current strong {
  font-size: var(--font-size-lg);
  padding-inline: var(--space-1);
}
.settings-current > span {
  color: var(--text-secondary);
}
.settings-field-control {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
}
.settings-number {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.settings-number input {
  min-width: 0;
  width: 100%;
}
.settings-number span {
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}
.settings-field-control > .field-hint {
  margin: 0;
}
.settings-savebar {
  position: sticky;
  bottom: var(--space-4);
  z-index: 2;
  box-shadow: var(--shadow-floating);
}
.settings-savebar .helper {
  margin: var(--space-1) 0 0;
}
.settings-recovery {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-3);
}
.settings-deployment-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-5);
  margin: 0;
}
.settings-deployment-grid > div {
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-4);
  min-width: 0;
}
.settings-deployment-grid dt,
.settings-preview dt {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}
.settings-deployment-grid dd {
  margin: var(--space-2) 0;
  font-weight: 650;
}
.settings-deployment-grid p {
  margin: 0;
}
.settings-preview {
  border-top: 1px solid var(--border-subtle);
  margin-top: var(--space-5);
  padding-top: var(--space-5);
}
.settings-preview h3 {
  font-size: var(--font-size-base);
  margin-bottom: var(--space-4);
}
.settings-preview dl {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-4);
  margin: 0;
}
.settings-preview dd {
  margin: var(--space-2) 0 0;
  font-weight: 650;
}
.settings-ownership {
  margin: var(--space-5) 0 0;
  padding: var(--space-4);
  border-radius: var(--radius-widget);
  background: var(--surface-muted);
}
.settings-management-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}
.settings-management-link {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  text-decoration: none;
}
.settings-management-link:hover {
  border-color: var(--border-control);
}
.settings-management-link > span {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}
.settings-management-link small {
  color: var(--text-secondary);
}
@media (max-width: 1100px) {
  .settings-field {
    grid-template-columns: minmax(0, 1fr) minmax(240px, 300px);
    gap: var(--space-5);
  }
  .settings-deployment-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .settings-preview dl {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 767px) {
  .settings-field,
  .settings-deployment-grid,
  .settings-management-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .settings-preview dl {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .settings-savebar {
    position: static;
  }
  .settings-field {
    gap: var(--space-4);
  }
  .settings-savebar .button-row {
    width: 100%;
  }
  .settings-sections a {
    flex: 1 1 130px;
    justify-content: center;
  }
}
</style>
