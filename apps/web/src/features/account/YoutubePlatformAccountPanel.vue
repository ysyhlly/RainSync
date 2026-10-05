<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import { usePlatformAccount } from "./platform-account.store";
import {
  createYoutubeAccountFlow,
  type YoutubeAccountPhase,
} from "./youtube-account-flow";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";

const session = useSession(),
  account = usePlatformAccount();
const status = computed(() => account.youtubeStatus),
  open = ref(false),
  consent = ref(false),
  ready = ref(false),
  secret = ref(""),
  filename = ref(""),
  fileInput = ref<HTMLInputElement>(),
  error = ref(""),
  phase = ref<YoutubeAccountPhase>("idle"),
  unlinkOpen = ref(false),
  busy = ref(false);
let alive = true,
  generation = 0,
  expected: string | null = null,
  unlinkRevision: string | null = null,
  flow: ReturnType<typeof createYoutubeAccountFlow> | undefined;
function clearSecret() {
  secret.value = filename.value = "";
  if (fileInput.value) fileInput.value.value = "";
}
function close() {
  ++generation;
  flow?.close();
  flow = undefined;
  open.value = false;
  consent.value = ready.value = false;
  clearSecret();
  phase.value = "idle";
}
async function refresh() {
  const epoch = session.epoch;
  error.value = "";
  try {
    await account.refreshYoutube(true);
  } catch {
    if (alive && epoch === session.epoch)
      error.value = "无法读取 YouTube 会话状态，请重试";
  }
}
async function showImport() {
  if (busy.value) return;
  close();
  open.value = true;
  const serial = generation,
    epoch = session.epoch;
  error.value = "";
  try {
    const value = await account.refreshYoutube(true);
    if (
      !alive ||
      !open.value ||
      generation !== serial ||
      epoch !== session.epoch
    )
      return;
    expected = value.revision;
    ready.value = value.account_import_available;
  } catch {
    if (alive && open.value && generation === serial && epoch === session.epoch)
      error.value = "无法确认会话状态，请关闭后刷新重试";
  }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  clearSecret();
  if (!file || !ready.value || phase.value !== "idle") return;
  const serial = ++generation,
    epoch = session.epoch;
  if (file.size > 32768 || file.size === 0) {
    error.value = "请选择不超过 32 KiB 的 YouTube Cookie 文本文件";
    return;
  }
  try {
    const value = await file.text();
    if (
      !alive ||
      !open.value ||
      generation !== serial ||
      epoch !== session.epoch
    )
      return;
    secret.value = value;
    filename.value = file.name;
    error.value = "";
  } catch {
    if (alive && open.value && generation === serial && epoch === session.epoch)
      error.value = "无法读取此文件，请重新选择";
  }
}
async function submit() {
  if (!ready.value || !consent.value || !secret.value || phase.value !== "idle")
    return;
  const serial = generation,
    epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf,
    origin = location.origin;
  flow = createYoutubeAccountFlow({
    current: () =>
      alive &&
      open.value &&
      serial === generation &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf &&
      origin === location.origin,
    submit: (value, revision, signal) =>
      account.importYoutube(value, revision, signal),
    clearSecret,
    change: (value) => {
      phase.value = value;
    },
  });
  await flow.submit(secret.value, expected, consent.value);
}
async function unlink() {
  if (busy.value || !status.value) return;
  busy.value = true;
  const epoch = session.epoch,
    serial = generation,
    revision = unlinkRevision;
  try {
    await account.unlinkYoutube(revision);
    if (alive && epoch === session.epoch && serial === generation)
      unlinkOpen.value = false;
  } catch {
    if (alive && epoch === session.epoch && serial === generation)
      error.value = "解除连接结果尚未确认，请刷新会话状态检查";
  } finally {
    if (alive && epoch === session.epoch && serial === generation)
      busy.value = false;
  }
}
function showUnlink() {
  if (busy.value || !status.value?.id) return;
  unlinkRevision = status.value.revision;
  unlinkOpen.value = true;
}
watch(
  [() => session.epoch, () => session.user?.id, () => session.user?.csrf],
  () => {
    close();
    unlinkOpen.value = busy.value = false;
    error.value = "";
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
    <h2>YouTube 账号会话</h2>
    <p>
      每位观众只能使用自己导入的 YouTube
      会话。会话不会共享给房主或其他观众，视频权限仍由平台决定。
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
      此路径仅支持原有公开或不公开的普通视频；登录不会启用私人、付费、年龄限制或
      DRM 视频，也不会自动续期。
    </p>
    <p
      v-if="status && !status.account_import_available"
      class="helper"
      role="status"
    >
      服务器尚未启用独立的观众会话提取权限，请联系服务器管理员。此时不能导入新会话。
    </p>
    <div class="button-row">
      <button
        class="primary"
        :disabled="busy || !status?.account_import_available"
        @click="showImport"
      >
        {{
          status?.state === "connected" ? "替换自己的会话" : "导入自己的会话"
        }}
      </button>
      <button :disabled="busy" @click="refresh">刷新保存状态</button>
      <button
        v-if="status?.id && status.state !== 'revoked'"
        class="danger"
        :disabled="busy"
        @click="showUnlink"
      >
        解除连接
      </button>
    </div>
    <Notice :message="error" error />
    <AppDialog
      :model-value="open"
      title="导入自己的 YouTube 会话"
      @update:model-value="
        (value) => {
          if (!value) close();
        }
      "
    >
      <p>
        请在 YouTube 官网自行登录，只选择你自己的 youtube.com Cookie 的 Netscape
        格式文本导出文件。不要上传包含 Google 或其他网站 Cookie
        的文件，也不要填写密码或 OAuth 令牌。
      </p>
      <p>
        登录字段至少需要 LOGIN_INFO，以及 SAPISID、__Secure-1PAPISID 或
        __Secure-3PAPISID 中的一项。SID 单独存在不代表可用的提取会话。
        服务器会仅保留允许的 YouTube 登录字段，并强制仅通过 HTTPS 使用。
      </p>
      <p>
        文件会在同意后加密保存在当前 RainSync
        服务器。每次提取只将当前观众的会话写入临时私有文件，提取结束后清除。提取程序仍具有服务器进程权限，服务器管理员必须信任该程序。
      </p>
      <p>
        平台可能轮换会话或限制账号；使用提取程序存在账号暂时或永久被封禁的风险。请仅在需要时导入。保存成功不代表平台登录有效。
      </p>
      <form v-if="phase === 'idle'" autocomplete="off" @submit.prevent="submit">
        <label
          >自己的 YouTube Cookie 文件（最多 32 KiB）<input
            ref="fileInput"
            type="file"
            accept=".txt,.cookies,text/plain"
            :disabled="!ready"
            @change="choose"
        /></label>
        <p v-if="filename">已在本机读取：{{ filename }}</p>
        <label
          ><input
            v-model="consent"
            type="checkbox"
            :disabled="!ready"
          />我了解账号和程序风险，并同意在此服务器保存自己的 YouTube 会话</label
        >
        <button class="primary" :disabled="!ready || !consent || !secret">
          加密保存自己的会话
        </button>
      </form>
      <p v-if="phase === 'submitting'" role="status">
        正在加密保存，文件内容已从输入中清除…
      </p>
      <p v-if="phase === 'stored'" role="status">
        已保存自己的会话，平台登录和视频权限尚未验证
      </p>
      <p v-if="phase === 'invalid'" role="status">
        文件格式不符合要求，内容已清除。请关闭后重新选择 Netscape 格式文件。
      </p>
      <p v-if="phase === 'uncertain'" role="status">
        保存结果尚未确认，内容已清除。请关闭后刷新保存状态，再决定是否重新导入。
      </p>
      <button @click="close">
        {{ phase === "submitting" ? "关闭并停止等待" : "关闭" }}
      </button>
      <p class="helper">
        关闭不能撤回服务器已接收的保存请求；可刷新状态后解除连接。
      </p>
    </AppDialog>
    <AppDialog v-model="unlinkOpen" title="解除 YouTube 会话连接">
      <p>
        服务器会清除保存的会话，并使使用旧会话的播放请求失效。这不会退出你浏览器中的
        YouTube 账号。
      </p>
      <button class="danger" :disabled="busy" @click="unlink">
        确认解除连接
      </button>
      <button :disabled="busy" @click="unlinkOpen = false">取消</button>
    </AppDialog>
  </section>
</template>
