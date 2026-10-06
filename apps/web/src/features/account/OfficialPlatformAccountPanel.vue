<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import QRCode from "qrcode";
import { useSession } from "../auth/session.store";
import type { ShortPlatformProvider } from "./platform-account.api";
import {
  platformOAuthApi,
  oauthPrerequisiteLabels,
  type OAuthStatus,
} from "./platform-oauth.api";
import {
  createOAuthFlow,
  validateOAuthStatus,
  type OAuthFlowState,
} from "./platform-oauth-flow";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
const props = defineProps<{ provider: ShortPlatformProvider }>();
const session = useSession();
const label = computed(() => (props.provider === "douyin" ? "抖音" : "TikTok")),
  status = ref<OAuthStatus | null>(null),
  open = ref(false),
  unlinkOpen = ref(false),
  consent = ref(false),
  renew = ref(false),
  ready = ref(false),
  busy = ref(false),
  error = ref(""),
  image = ref(""),
  state = ref<OAuthFlowState>({ phase: "idle" });
let alive = true,
  serial = 0,
  imageSerial = 0,
  flow: ReturnType<typeof createOAuthFlow> | undefined;
const controller = new AbortController();
function snapshot() {
  const epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf,
    provider = props.provider,
    origin = location.origin;
  return () =>
    alive &&
    epoch === session.epoch &&
    user === session.user?.id &&
    csrf === session.user?.csrf &&
    provider === props.provider &&
    origin === location.origin;
}
async function refresh() {
  const current = snapshot(),
    generation = ++serial;
  try {
    const value = validateOAuthStatus(
      await platformOAuthApi(session.api, props.provider).status(
        controller.signal,
      ),
      props.provider,
    );
    if (current() && generation === serial) status.value = value;
  } catch {
    if (current() && generation === serial)
      error.value = "无法确认开放平台授权状态，请刷新重试";
  }
}
async function show() {
  if (busy.value) return;
  await close();
  const current = snapshot();
  open.value = true;
  consent.value = renew.value = ready.value = false;
  error.value = "";
  await refresh();
  if (current() && open.value) ready.value = !!status.value?.available;
}
async function begin() {
  if (
    !open.value ||
    !ready.value ||
    !consent.value ||
    busy.value ||
    !status.value
  )
    return;
  const current = snapshot(),
    api = platformOAuthApi(session.api, props.provider),
    revision = status.value.revision,
    renewal = renew.value;
  busy.value = true;
  error.value = "";
  flow ??= createOAuthFlow({
    provider: props.provider,
    current: () => current() && open.value,
    start: (id, signal) => api.start(id, revision, renewal, signal),
    read: api.read,
    poll: api.poll,
    cancel: api.cancel,
    change: (value) => {
      state.value = value;
    },
    confirmed: () => {
      void refresh();
    },
  });
  try {
    await flow.start();
  } finally {
    if (current()) busy.value = false;
  }
}
async function close() {
  const previous = flow,
    current = snapshot();
  // Capture cancellation while the dialog still represents this exact active
  // authorization. Hiding it first would make flow.current() reject cleanup.
  const closing = previous?.close();
  flow = undefined;
  open.value = false;
  image.value = "";
  ++imageSerial;
  consent.value = renew.value = ready.value = false;
  state.value = { phase: "idle" };
  try {
    await closing;
  } catch {
    if (current())
      error.value = "停止授权尚未确认，请刷新状态。到期后此授权请求会失效";
  }
}
async function disable() {
  if (busy.value || !status.value) return;
  const current = snapshot();
  busy.value = true;
  error.value = "";
  try {
    const v = validateOAuthStatus(
      await platformOAuthApi(session.api, props.provider).disableRenewal(
        status.value.revision,
        controller.signal,
      ),
      props.provider,
    );
    if (current()) status.value = v;
  } catch {
    if (current()) error.value = "停止自动续期的结果未确认，请刷新状态";
  } finally {
    if (current()) busy.value = false;
  }
}
async function unlink() {
  if (busy.value || !status.value) return;
  const current = snapshot();
  busy.value = true;
  error.value = "";
  try {
    const v = validateOAuthStatus(
      await platformOAuthApi(session.api, props.provider).unlink(
        status.value.revision,
        controller.signal,
      ),
      props.provider,
    );
    if (current()) {
      status.value = v;
      unlinkOpen.value = false;
    }
  } catch {
    if (current()) error.value = "解除开放平台授权的结果未确认，请刷新状态";
  } finally {
    if (current()) busy.value = false;
  }
}
watch(
  () => state.value.login?.qr_payload,
  async (payload) => {
    const generation = ++imageSerial;
    image.value = "";
    if (!payload || !open.value) return;
    try {
      const rendered = await QRCode.toDataURL(payload, {
        width: 256,
        margin: 4,
        errorCorrectionLevel: "M",
      });
      if (alive && open.value && generation === imageSerial)
        image.value = rendered;
    } catch {
      if (alive && generation === imageSerial)
        error.value = "授权二维码无法显示，请取消后重试";
    }
  },
);
watch(
  [
    () => session.epoch,
    () => session.user?.id,
    () => session.user?.csrf,
    () => props.provider,
  ],
  () => {
    void close();
    status.value = null;
    unlinkOpen.value = false;
    busy.value = false;
    error.value = "";
    ++serial;
  },
  { flush: "sync" },
);
onMounted(refresh);
onBeforeUnmount(() => {
  void close();
  alive = false;
  controller.abort();
  ++serial;
});
</script>
<template>
  <section class="platform-oauth-panel">
    <h3>{{ label }} 官方开放平台授权</h3>
    <p class="helper">
      此授权只保存已批准的开放平台用户资料接口令牌，不会生成网页播放
      Cookie，也不会增加视频、会员或地区访问权限
    </p>
    <p v-if="status && !status.available" role="status">
      服务器尚未配置可用的开放平台应用。仅安装手机 App 无法完成这项授权
    </p>
    <details v-if="status && !status.available" class="oauth-setup-details">
      <summary>查看 {{ label }} 开放平台配置要求</summary>
      <p class="helper">
        需要服务器运营者拥有审核通过的应用，并配置应用密钥和 HTTPS 回调地址。
      </p>
      <ul>
        <li v-for="item in status.missing_prerequisites" :key="item">
          {{ oauthPrerequisiteLabels[item] ?? item }}
        </li>
      </ul>
    </details>
    <p v-else-if="status" role="status">
      {{
        status.state === "connected"
          ? "开放平台授权已保存"
          : status.state === "expired"
            ? "开放平台授权需要重新确认"
            : "尚未授权"
      }}；{{ status.auto_renew ? "已同意自动续期" : "自动续期未启用" }}
    </p>
    <p v-if="status?.renewal_state === 'uncertain'" role="status">
      续期结果不确定，已停止继续刷新。请重新授权或解除连接
    </p>
    <div class="button-row">
      <button :disabled="!status?.available || busy" @click="show">
        {{
          status?.authorization_mode === "qr"
            ? "官方扫码授权"
            : "打开官方扫码授权页"
        }}
      </button>
      <button :disabled="busy" @click="refresh">刷新授权状态</button>
      <button v-if="status?.auto_renew" :disabled="busy" @click="disable">
        停止自动续期
      </button>
      <button
        v-if="status?.id && status.state !== 'revoked'"
        class="danger"
        :disabled="busy"
        @click="unlinkOpen = true"
      >
        解除开放平台连接
      </button>
    </div>
    <Notice :message="error" error />
    <AppDialog
      :model-value="open"
      :title="`${label} 官方开放平台授权`"
      @update:model-value="
        (v) => {
          if (!v) void close();
        }
      "
    >
      <p>
        用户资料授权范围：{{
          props.provider === "douyin" ? "user_info" : "user.info.basic"
        }}。令牌只加密保存在当前服务器，不提供给其他观众，不用于消费网页的视频播放
      </p>
      <template v-if="state.phase === 'idle'">
        <label
          ><input
            v-model="consent"
            type="checkbox"
            :disabled="!ready"
          />我确认授权自己的账号，并同意此服务器保存开放平台令牌</label
        >
        <label
          ><input
            v-model="renew"
            type="checkbox"
            :disabled="!ready"
          />我另外同意服务器自动刷新此账号已授予的接口令牌；我可以随时停止</label
        >
      </template>
      <p class="helper">
        自动续期只在本次 RainSync
        登录仍有效时运行，不扩大授权范围。停止会阻止后续刷新；已发给平台的请求可能已经完成。刷新令牌到期、权限撤回或结果不确定时需要重新授权
      </p>
      <p v-if="state.phase === 'starting'" role="status">正在准备官方授权…</p>
      <template v-if="state.phase === 'pending' && state.login">
        <img
          v-if="image"
          :src="image"
          width="256"
          height="256"
          :alt="`${label} 开放平台授权二维码`"
        />
        <a
          v-if="state.login.authorization_url"
          :href="state.login.authorization_url"
          target="_blank"
          rel="noopener noreferrer"
          >进入平台官方授权页，在那里扫码或登录确认</a
        >
        <p role="status">
          {{
            state.login.stage === "scanned"
              ? "已扫码，请在手机 App 确认授权"
              : "等待平台授权确认；此请求到期后不会自动新建二维码"
          }}
        </p>
      </template>
      <p v-if="state.phase === 'confirmed'" role="status">
        开放平台授权已保存。网页播放会话仍需单独确认
      </p>
      <p
        v-if="state.phase === 'expired' || state.phase === 'failed'"
        role="status"
      >
        此授权请求已结束。请关闭后重新确认授权
      </p>
      <p v-if="state.phase === 'uncertain'" role="status">
        授权结果尚未确认。可查询同一请求，不会自动重新授权
      </p>
      <button
        v-if="state.phase === 'idle' || state.phase === 'uncertain'"
        :disabled="!ready || !consent || busy"
        @click="begin"
      >
        {{ state.phase === "uncertain" ? "查询同一授权结果" : "准备官方授权" }}
      </button>
      <button @click="close">
        {{ state.phase === "confirmed" ? "完成" : "取消并关闭" }}
      </button>
    </AppDialog>
    <AppDialog
      v-model="unlinkOpen"
      :title="`解除 ${label} 开放平台连接`"
      :busy="busy"
    >
      <p>
        删除此服务器保存的开放平台令牌，停止本服务器自动续期。不删除平台账号。你还可以在平台
        App 的授权管理中撤销该应用权限
      </p>
      <button class="danger" :disabled="busy" @click="unlink">
        确认解除开放平台连接</button
      ><button :disabled="busy" @click="unlinkOpen = false">取消</button>
    </AppDialog>
  </section>
</template>

<style scoped>
.platform-oauth-panel {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-4);
  margin-top: var(--space-1);
  border-top: 1px solid var(--border-subtle);
}
.oauth-setup-details ul {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}
</style>
