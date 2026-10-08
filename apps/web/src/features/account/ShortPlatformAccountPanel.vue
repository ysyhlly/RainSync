<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import { usePlatformAccount } from "./platform-account.store";
import type { ShortPlatformProvider } from "./platform-account.api";
import {
  createShortAccountFlow,
  shortAccountCookieFields,
  type ShortAccountFlowState,
} from "./short-account-flow";
import { platformProviderLabels } from "../rooms/platform-import";
import OfficialPlatformAccountPanel from "./OfficialPlatformAccountPanel.vue";
import Notice from "../../shared/ui/Notice.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";

const props = defineProps<{ provider: ShortPlatformProvider }>();
const session = useSession(),
  account = usePlatformAccount();
const label = computed(() => platformProviderLabels[props.provider]),
  cookieFields = computed(() =>
    shortAccountCookieFields(props.provider).join("、"),
  ),
  status = computed(() => account.shortStatuses[props.provider]),
  open = ref(false),
  consent = ref(false),
  cookie = ref(""),
  ready = ref(false),
  unlinkOpen = ref(false),
  unlinkBusy = ref(false),
  error = ref(""),
  message = ref(""),
  expectedRevision = ref<string | null>(null),
  unlinkRevision = ref<string | null>(null),
  state = ref<ShortAccountFlowState>({ phase: "idle" });
let alive = true,
  serial = 0,
  flow: ReturnType<typeof createShortAccountFlow> | undefined;

async function refresh() {
  const epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf,
    provider = props.provider;
  error.value = "";
  try {
    await account.refreshShort(props.provider, true);
  } catch {
    if (
      alive &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf &&
      props.provider === provider
    )
      error.value = "无法读取此平台的会话状态，请重试";
  }
}
async function showImport() {
  if (unlinkBusy.value) return;
  flow?.close();
  flow = undefined;
  const generation = ++serial,
    epoch = session.epoch,
    provider = props.provider;
  open.value = true;
  cookie.value = "";
  consent.value = ready.value = false;
  error.value = message.value = "";
  state.value = { phase: "idle" };
  try {
    const value = await account.refreshShort(provider, true);
    if (
      !alive ||
      !open.value ||
      serial !== generation ||
      session.epoch !== epoch ||
      props.provider !== provider
    )
      return;
    expectedRevision.value = value.revision;
    ready.value = true;
  } catch {
    if (alive && open.value && serial === generation && session.epoch === epoch)
      error.value = "无法确认账号状态，请关闭后刷新重试";
  }
}
async function submit() {
  if (
    !ready.value ||
    !consent.value ||
    !cookie.value.trim() ||
    state.value.phase !== "idle"
  )
    return;
  const origin = location.origin,
    epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf,
    generation = serial,
    provider = props.provider;
  flow = createShortAccountFlow({
    provider,
    current: () =>
      alive &&
      open.value &&
      serial === generation &&
      props.provider === provider &&
      location.origin === origin &&
      session.epoch === epoch &&
      session.user?.id === user &&
      session.user?.csrf === csrf,
    submit: (value, revision, signal) =>
      account.importShort(provider, value, revision, signal),
    clearSecret: () => {
      cookie.value = "";
    },
    change: (value) => {
      state.value = value;
    },
  });
  await flow.submit(cookie.value, expectedRevision.value, consent.value);
}
function close() {
  const uncertain =
    state.value.phase === "submitting" || state.value.phase === "uncertain";
  ++serial;
  flow?.close();
  flow = undefined;
  open.value = false;
  cookie.value = "";
  consent.value = ready.value = false;
  state.value = { phase: "idle" };
  if (uncertain && alive) {
    message.value =
      "已停止等待并清空输入。已提交的会话仍可能保存，请刷新状态确认结果。";
    void refresh();
  }
}
function showUnlink() {
  if (!status.value?.id) return;
  unlinkRevision.value = status.value.revision;
  unlinkOpen.value = true;
}
async function unlink() {
  if (unlinkBusy.value) return;
  const epoch = session.epoch,
    provider = props.provider,
    user = session.user?.id,
    csrf = session.user?.csrf,
    generation = serial;
  const current = () =>
    alive &&
    epoch === session.epoch &&
    props.provider === provider &&
    user === session.user?.id &&
    csrf === session.user?.csrf &&
    generation === serial;
  unlinkBusy.value = true;
  error.value = message.value = "";
  try {
    await account.unlinkShort(provider, unlinkRevision.value);
    if (current()) unlinkOpen.value = false;
  } catch {
    if (current())
      error.value =
        "解除连接结果尚未确认，或账号已被替换。请关闭并刷新状态后重试。";
  } finally {
    if (current()) unlinkBusy.value = false;
  }
}
watch(
  [
    () => session.epoch,
    () => session.user?.id,
    () => session.user?.csrf,
    () => props.provider,
  ],
  () => {
    close();
    unlinkOpen.value = false;
    unlinkBusy.value = false;
    error.value = message.value = "";
  },
  { flush: "sync" },
);
onMounted(refresh);
onBeforeUnmount(() => {
  alive = false;
  close();
});
</script>

<template>
  <section class="panel platform-account-panel">
    <h3>{{ label }} 账号会话</h3>
    <p>
      抖音与 TikTok
      是独立平台，账号会话不能混用。每位观众只能使用自己导入的会话，会员、年龄和地区限制仍由平台决定。
    </p>
    <p role="status">
      {{
        status?.state === "connected"
          ? "已保存会话，平台登录尚未验证"
          : status?.state === "expired"
            ? "保存的会话已过期"
            : status
              ? "未保存会话"
              : "正在读取状态…"
      }}
    </p>
    <p class="helper">
      网页播放会话不提供直接扫码登录；下方的官方开放平台授权需要单独配置。导入成功只表示会话已加密保存，不能保证仍已登录或具有视频访问权限。
    </p>
    <OfficialPlatformAccountPanel :provider="props.provider" />
    <div class="button-row">
      <button class="primary" :disabled="unlinkBusy" @click="showImport">
        {{
          status?.state === "connected" ? "替换自己的会话" : "导入自己的会话"
        }}
      </button>
      <button :disabled="unlinkBusy" @click="refresh">刷新状态</button>
      <button
        v-if="status?.id && status.state !== 'revoked'"
        class="danger"
        :disabled="unlinkBusy"
        @click="showUnlink"
      >
        解除连接
      </button>
    </div>
    <Notice :message="error" error />
    <Notice :message="message" />
    <AppDialog
      :model-value="open"
      :title="`导入自己的 ${label} 会话`"
      @update:model-value="
        (value) => {
          if (!value) close();
        }
      "
    >
      <p>
        请先在 {{ label }} 官网自行登录，再从浏览器开发者工具中读取你自己的登录
        Cookie。 只填写支持的登录字段，不要直接粘贴完整 Cookie
        请求头，也不要填写密码或其他平台凭据。
      </p>
      <p>
        至少需要 sessionid、sessionid_ss 或 sid_tt 中的一项，值不少于 16
        个字符。格式示例：sessionid=YOUR_SESSION_VALUE（占位符，请替换为自己的值）。多个字段用分号分隔，总长度最多
        8192 个字符。
      </p>
      <details>
        <summary>支持的登录字段</summary>
        <p>{{ cookieFields }}</p>
        <p>
          不接受其他字段、重复字段、挑战或指纹字段，以及 JSON、Netscape
          导出文件或 Set-Cookie 响应头。
        </p>
      </details>
      <p>
        此会话将加密保存在当前 RainSync
        服务器，仅用于你的平台视频导入和播放请求。房主和其他观众不能使用你的凭据。你可以随时解除连接。
      </p>
      <form
        v-if="state.phase === 'idle'"
        autocomplete="off"
        @submit.prevent="submit"
      >
        <label
          >自己的 {{ label }} 登录 Cookie 字段<input
            v-model="cookie"
            type="password"
            autocomplete="off"
            :spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            maxlength="8192"
            :disabled="!ready"
        /></label>
        <label
          ><input
            v-model="consent"
            type="checkbox"
            :disabled="!ready"
          />我确认这是自己的
          {{ label }}
          账号，并同意在此服务器保存会话用于自己的视频导入和播放</label
        >
        <p v-if="!ready" role="status">正在确认账号状态…</p>
        <button
          class="primary"
          :disabled="!ready || !consent || !cookie.trim()"
        >
          保存自己的会话
        </button>
      </form>
      <p v-if="state.phase === 'submitting'" role="status">
        正在保存会话，输入已清空。关闭会停止等待；已发送的请求仍可能完成，请刷新状态确认。
      </p>
      <p v-if="state.phase === 'stored'" role="status">
        自己的会话已加密保存。平台登录和视频权限尚未验证，请通过播放结果确认。
      </p>
      <p v-if="state.phase === 'uncertain'" role="status">
        保存结果尚未确认，或会话格式不受支持。输入已清空，请关闭并刷新状态；需要重试时重新确认并粘贴自己的会话。
      </p>
      <p v-if="state.phase === 'invalid'" role="status">
        会话格式不受支持，尚未提交且输入已清空。请关闭后重新确认，仅填写所列登录字段，并提供有效长度的会话字段。
      </p>
      <Notice :message="error" error />
      <button type="button" @click="close">
        {{
          state.phase === "stored"
            ? "完成"
            : state.phase === "submitting"
              ? "停止等待并关闭"
              : "取消并关闭"
        }}
      </button>
    </AppDialog>
    <AppDialog
      v-model="unlinkOpen"
      :title="`解除 ${label} 连接`"
      :busy="unlinkBusy"
    >
      <p>
        将删除此服务器保存的
        {{ label }}
        会话，并撤销使用它的导入和播放授权。此操作不会删除你的平台账号。
      </p>
      <Notice :message="error" error />
      <button class="danger" :disabled="unlinkBusy" @click="unlink">
        确认解除连接
      </button>
      <button :disabled="unlinkBusy" @click="unlinkOpen = false">取消</button>
    </AppDialog>
  </section>
</template>
