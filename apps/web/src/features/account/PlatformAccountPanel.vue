<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import QRCode from "qrcode";
import { useSession } from "../auth/session.store";
import { usePlatformAccount } from "./platform-account.store";
import { platformAccountApi } from "./platform-account.api";
import { platformAccountCheckMessage } from "./platform-account-check";
import {
  createPlatformLoginFlow,
  type PlatformLoginFlowState,
} from "./platform-login-flow";
import {
  bilibiliRenewalApi,
  validateBilibiliRenewal,
  type BilibiliRenewalStatus,
} from "./platform-renewal.api";
import Notice from "../../shared/ui/Notice.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
const session = useSession(),
  account = usePlatformAccount(),
  api = platformAccountApi(session.api);
const open = ref(false),
  consent = ref(false),
  renew = ref(false),
  renewal = ref<BilibiliRenewalStatus | null>(null),
  renewalPhase = ref<"loading" | "ready" | "error">("loading"),
  unlinkOpen = ref(false),
  busy = ref(false),
  error = ref(""),
  image = ref("");
const login = ref<PlatformLoginFlowState>({ phase: "idle" });
let flow: ReturnType<typeof createPlatformLoginFlow> | undefined,
  alive = true,
  qrSerial = 0,
  actionSerial = 0,
  renewalSerial = 0;
let renewalPending: { key: string; work: Promise<void> } | undefined;
const checkController = new AbortController();
const accountKey = computed(() =>
  JSON.stringify([
    session.epoch,
    session.user?.id,
    session.user?.csrf,
    account.status?.id,
    account.status?.revision,
    account.status?.state,
  ]),
);
function matchingRenewal(value: BilibiliRenewalStatus) {
  return (
    value.account.id === account.status?.id &&
    value.account.revision === account.status?.revision &&
    value.account.state === account.status?.state &&
    (!value.enabled || value.account.state === "connected")
  );
}
const currentRenewal = computed(() =>
  renewalPhase.value === "ready" &&
  renewal.value &&
  matchingRenewal(renewal.value)
    ? renewal.value
    : null,
);
async function readRenewal() {
  if (!session.user || !account.status) return;
  if (currentRenewal.value) return;
  const key = accountKey.value;
  if (renewalPending?.key === key) return renewalPending.work;
  const serial = ++renewalSerial;
  renewal.value = null;
  renewalPhase.value = "loading";
  const current = () =>
    alive && serial === renewalSerial && key === accountKey.value;
  const work = (async () => {
    try {
      const value = validateBilibiliRenewal(
        await bilibiliRenewalApi(session.api).status(checkController.signal),
      );
      if (!current()) return;
      if (!matchingRenewal(value)) throw Error("续期状态与当前账号版本不一致");
      renewal.value = value;
      renewalPhase.value = "ready";
    } catch {
      if (current()) renewalPhase.value = "error";
    }
  })();
  renewalPending = { key, work };
  await work;
  if (renewalPending?.work === work) renewalPending = undefined;
}
async function refresh() {
  const epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf;
  error.value = "";
  ++renewalSerial;
  renewalPending = undefined;
  renewal.value = null;
  renewalPhase.value = "loading";
  try {
    await account.refresh(true);
    if (
      alive &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf
    )
      await readRenewal();
  } catch {
    if (
      alive &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf
    ) {
      error.value = "无法读取平台账号状态，请重试";
      renewal.value = null;
      renewalPhase.value = "error";
    }
  }
}
function createFlow() {
  const origin = location.origin,
    epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf;
  const current = () =>
    alive &&
    open.value &&
    location.origin === origin &&
    session.epoch === epoch &&
    session.user?.id === user &&
    session.user?.csrf === csrf;
  const renewalConsent = renew.value;
  return createPlatformLoginFlow({
    current,
    start: (key, signal) => api.start(key, signal, renewalConsent),
    poll: api.poll,
    cancel: api.cancel,
    change: (value) => {
      login.value = value;
    },
    confirmed: () => {
      void refresh();
    },
  });
}
async function begin() {
  if (!consent.value || busy.value) return;
  busy.value = true;
  const serial = ++actionSerial;
  error.value = "";
  flow ??= createFlow();
  try {
    await flow.start();
  } finally {
    if (alive && serial === actionSerial) busy.value = false;
  }
}
async function close() {
  const previous = flow,
    epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf,
    serial = ++actionSerial;
  flow = undefined;
  open.value = false;
  consent.value = false;
  renew.value = false;
  busy.value = false;
  image.value = "";
  ++qrSerial;
  login.value = { phase: "idle" };
  try {
    await previous?.close();
  } catch {
    if (
      alive &&
      serial === actionSerial &&
      session.epoch === epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf
    )
      error.value = "停止登录尚未确认，请刷新账号状态检查。二维码到期后失效。";
  }
}
async function disableRenewal() {
  if (busy.value || !currentRenewal.value?.enabled) return;
  const observed = currentRenewal.value,
    key = accountKey.value,
    serial = ++renewalSerial;
  const epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf;
  busy.value = true;
  error.value = "";
  renewal.value = null;
  renewalPhase.value = "loading";
  try {
    const value = validateBilibiliRenewal(
      await bilibiliRenewalApi(session.api).disable(
        observed.account.revision,
        checkController.signal,
      ),
    );
    if (
      alive &&
      serial === renewalSerial &&
      key === accountKey.value &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf
    ) {
      if (!matchingRenewal(value)) throw Error("续期状态与当前账号版本不一致");
      renewal.value = value;
      renewalPhase.value = "ready";
    }
  } catch {
    if (
      alive &&
      serial === renewalSerial &&
      key === accountKey.value &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf
    ) {
      error.value = "停止自动续期结果尚未确认，请刷新状态";
      renewalPhase.value = "error";
    }
  } finally {
    if (
      alive &&
      epoch === session.epoch &&
      user === session.user?.id &&
      csrf === session.user?.csrf
    )
      busy.value = false;
  }
}
async function unlink() {
  if (busy.value) return;
  busy.value = true;
  const serial = ++actionSerial,
    epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf;
  const current = () =>
    alive &&
    serial === actionSerial &&
    epoch === session.epoch &&
    user === session.user?.id &&
    csrf === session.user?.csrf;
  error.value = "";
  try {
    await account.unlink();
    if (current()) {
      unlinkOpen.value = false;
      await readRenewal();
    }
  } catch {
    if (current()) error.value = "解除连接结果尚未确认，请刷新账号状态检查";
  } finally {
    if (current()) busy.value = false;
  }
}
async function checkLogin() {
  if (busy.value || !account.status) return;
  busy.value = true;
  const serial = ++actionSerial,
    epoch = session.epoch,
    user = session.user?.id,
    csrf = session.user?.csrf;
  const current = () =>
    alive &&
    serial === actionSerial &&
    session.epoch === epoch &&
    session.user?.id === user &&
    session.user?.csrf === csrf;
  error.value = "";
  try {
    await account.checkLogin(checkController.signal);
    if (current()) await readRenewal();
  } catch {
    if (current()) error.value = "登录检查结果尚未确认，请刷新保存状态后重试";
  } finally {
    if (current()) busy.value = false;
  }
}
watch(
  () => login.value.payload,
  async (payload) => {
    const serial = ++qrSerial;
    image.value = "";
    if (!payload) return;
    try {
      // Encode locally. The login capability is never sent to an image service.
      const rendered = await QRCode.toDataURL(payload, {
        width: 256,
        margin: 4,
        errorCorrectionLevel: "M",
      });
      if (alive && open.value && serial === qrSerial) image.value = rendered;
    } catch {
      if (serial === qrSerial)
        error.value = "二维码无法显示，请停止此登录后重试";
    }
  },
);
watch(
  accountKey,
  () => {
    ++renewalSerial;
    renewal.value = null;
    renewalPhase.value = "loading";
    renewalPending = undefined;
    if (session.user && account.status) void readRenewal();
  },
  { flush: "sync" },
);
watch(
  [() => session.epoch, () => session.user?.id, () => session.user?.csrf],
  () => {
    void close();
    unlinkOpen.value = false;
    renewal.value = null;
    renewalPhase.value = "loading";
    error.value = "";
  },
  { flush: "sync" },
);
onMounted(refresh);
onBeforeUnmount(() => {
  alive = false;
  checkController.abort();
  void close();
});
</script>
<template>
  <section id="bilibili-account" class="panel platform-account-panel">
    <h2>Bilibili 账号</h2>
    <p>
      每位观众使用自己的账号权限。未连接时可尝试匿名播放，会员和地区限制仍由平台决定。
    </p>
    <p role="status">
      {{
        account.status?.state === "connected"
          ? "已保存扫码登录会话"
          : account.status?.state === "expired"
            ? "登录已过期"
            : account.status
              ? "未连接"
              : "正在读取状态…"
      }}
    </p>
    <p class="helper" role="status">
      {{ platformAccountCheckMessage(account.lastCheck) }}
    </p>
    <p class="helper" role="status">
      {{
        renewalPhase === "loading"
          ? "正在确认自动续期状态…"
          : !currentRenewal
            ? "续期状态暂未确认，请刷新状态重试"
            : account.status?.state === "revoked"
              ? "此服务器已解除连接，自动续期已停止"
              : currentRenewal.enabled
                ? "已同意后台自动续期，仅在本次 RainSync 登录有效时运行"
                : currentRenewal.state === "uncertain"
                  ? "续期结果不确定，已停止继续刷新，请重新扫码确认"
                  : "自动续期未启用；须在新的扫码登录时另外同意保留刷新令牌"
      }}
    </p>
    <button
      v-if="currentRenewal?.enabled"
      :disabled="busy"
      @click="disableRenewal"
    >
      停止自动续期
    </button>
    <div class="button-row">
      <button class="primary" :disabled="busy" @click="open = true">
        {{
          account.status?.state === "connected" ? "重新扫码连接" : "扫码连接"
        }}
      </button>
      <button :disabled="busy" @click="refresh">刷新状态</button>
      <button
        v-if="account.status?.state === 'connected'"
        :disabled="busy"
        @click="checkLogin"
      >
        检查平台登录
      </button>
      <button
        v-if="account.status?.id"
        class="danger"
        :disabled="busy"
        @click="unlinkOpen = true"
      >
        解除连接
      </button>
    </div>
    <Notice :message="error" error />
    <AppDialog
      :model-value="open"
      title="连接 Bilibili 账号"
      @update:model-value="
        (value) => {
          if (!value) void close();
        }
      "
    >
      <p>
        扫码后，你的平台登录凭据会加密保存在这台 RainSync
        服务器，仅用于你自己的播放请求。房主和其他观众无法使用。你可以随时解除连接。
      </p>
      <label v-if="login.phase === 'idle' || login.phase === 'uncertain'"
        ><input
          v-model="consent"
          type="checkbox"
        />我同意在此服务器保存自己的平台登录凭据</label
      >
      <label v-if="login.phase === 'idle'"
        ><input
          v-model="renew"
          type="checkbox"
        />我另外同意此服务器保存刷新令牌，自动续期自己的 Bilibili 会话</label
      >
      <p class="helper">
        默认不启用自动续期。平台必须在这次登录中返回刷新令牌才能启用；旧会话无法补造令牌。停止或解除连接会删除刷新材料并阻止后续请求，已发送的请求可能已经完成。续期更换会话后，旧播放授权会失效，需要重新播放
      </p>
      <p v-if="login.phase === 'starting'" role="status">正在准备二维码…</p>
      <template
        v-if="
          login.phase === 'pending' ||
          (login.phase === 'uncertain' && login.payload)
        "
      >
        <img
          v-if="image"
          :src="image"
          width="256"
          height="256"
          alt="Bilibili 账号连接二维码"
        />
        <p role="status">
          {{
            login.stage === "scanned"
              ? "已扫码，请在 Bilibili 中确认"
              : "请用 Bilibili App 扫码，连接你自己的账号"
          }}
        </p>
      </template>
      <p v-if="login.message" role="status">{{ login.message }}</p>
      <p v-if="login.code" class="helper">错误码：{{ login.code }}</p>
      <p v-if="login.requestId" class="helper">
        诊断编号：{{ login.requestId }}
      </p>
      <button
        v-if="login.phase === 'idle' || login.phase === 'uncertain'"
        class="primary"
        :disabled="!consent || busy || !!login.retryAfterSeconds"
        @click="begin"
      >
        {{
          login.retryAfterSeconds
            ? `等待 ${login.retryAfterSeconds} 秒后重试`
            : login.phase === "uncertain"
              ? "重试同一登录"
              : "生成登录二维码"
        }}
      </button>
      <button
        v-if="login.phase === 'expired' || login.phase === 'failed'"
        @click="close"
      >
        关闭后重新确认登录
      </button>
      <button @click="close">
        {{ login.phase === "confirmed" ? "完成" : "停止并关闭" }}
      </button>
    </AppDialog>
    <AppDialog v-model="unlinkOpen" title="解除 Bilibili 连接" :busy="busy">
      <p>
        将删除此服务器保存的平台登录凭据，并撤销使用它的播放授权。平台账号本身不会被删除。匿名播放仍取决于平台权限。
      </p>
      <button class="danger" :disabled="busy" @click="unlink">
        确认解除连接
      </button>
      <button :disabled="busy" @click="unlinkOpen = false">取消</button>
    </AppDialog>
  </section>
</template>
