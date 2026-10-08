<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useSession } from "./session.store";
import { guestRoomPath, parseGuestInvitation } from "./guest-session";
import { validateNickname } from "./account-rules";
import { RequestFailure } from "../../errors";
import { useRegistrationPolicy } from "./registration-policy";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
import { authenticationLocation, safeRedirect } from "../../app/navigation";
import { clearInvitation } from "./invitation-intent";
const props = defineProps<{
  invitation?: { room_id: string; token: string };
  returnPath?: string;
}>();
const session = useSession(),
  router = useRouter(),
  route = useRoute(),
  username = ref(""),
  password = ref(""),
  show = ref(false),
  guestInvite = ref(""),
  guestName = ref(""),
  guestUncertain = ref(false),
  guestNeedsLogout = ref(false);
const { busy: loginBusy, error, message, run } = useAction();
const {
  busy: guestBusy,
  error: guestError,
  message: guestMessage,
  run: runGuest,
} = useAction();
const busy = computed(() => loginBusy.value || guestBusy.value);
const guestOpen = ref(false);
const loginField = ref<"username" | "password" | "">("");
const guestField = ref<"invitation" | "name" | "">("");
watch(
  () => props.invitation,
  (invitation) => {
    if (!invitation) return;
    guestInvite.value = JSON.stringify(invitation);
    guestOpen.value = true;
  },
  { immediate: true },
);
watch([guestInvite, guestName], () => {
  if (!busy.value) {
    guestError.value = "";
    guestField.value = "";
  }
});
const {
  policy,
  loading: policyLoading,
  error: policyError,
  reload: reloadPolicy,
} = useRegistrationPolicy(session);
watch([username, password], () => {
  if (!busy.value) {
    error.value = "";
    loginField.value = "";
  }
});
async function submitLogin() {
  if (busy.value) return;
  loginField.value = !username.value.trim()
    ? "username"
    : !password.value
      ? "password"
      : "";
  if (loginField.value) {
    error.value =
      loginField.value === "username" ? "请填写登录账号。" : "请填写密码。";
    await nextTick();
    document.getElementById(`login-${loginField.value}`)?.focus();
    return;
  }
  await run(login);
}
const returnTo = computed(() =>
  safeRedirect(props.returnPath ?? route.query.redirect),
);
const expired = computed(
  () => route.query.notice === "session-expired" || session.expired,
);
const registration = computed(() =>
  authenticationLocation(
    "/register",
    props.invitation ? `/invite/${props.invitation.room_id}` : returnTo.value,
    expired.value,
  ),
);
const authentication = new AbortController();
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  authentication.abort();
  password.value = guestInvite.value = guestName.value = "";
});
async function submitGuest() {
  if (
    busy.value ||
    policyLoading.value ||
    !policy.value?.guests_enabled ||
    session.user ||
    guestUncertain.value ||
    guestNeedsLogout.value
  )
    return;
  guestOpen.value = true;
  guestField.value = "";
  await runGuest(async () => {
    if (!guestInvite.value.trim()) {
      guestField.value = "invitation";
      throw Error("请粘贴房间邀请链接或邀请数据。");
    }
    const invitation = parseGuestInvitation(
      guestInvite.value,
      window.location.origin,
    );
    const invalid = guestName.value.trim()
      ? validateNickname(guestName.value.trim())
      : null;
    if (invalid) {
      guestField.value = "name";
      throw Error(invalid);
    }
    try {
      const user = await session.guest(
        invitation.room_id,
        invitation.token,
        guestName.value,
        authentication.signal,
      );
      if (!alive) return;
      guestInvite.value = guestName.value = "";
      clearInvitation();
      await router.replace(guestRoomPath(user)!);
    } catch (cause) {
      if (!alive) return;
      if (
        cause instanceof RequestFailure &&
        ["FORBIDDEN", "INVALID_INVITE", "GUEST_ACCESS_DISABLED"].includes(
          cause.code,
        )
      ) {
        clearInvitation();
        await reloadPolicy();
        throw Error(
          "暂时无法通过此邀请进入。请确认站点和房间均允许访客，且邀请为有效的非定向观看邀请。",
          { cause },
        );
      }
      if (
        cause instanceof RequestFailure &&
        cause.code === "ALREADY_AUTHENTICATED"
      ) {
        try {
          await session.load();
          if (alive && session.user)
            await router.replace(guestRoomPath(session.user) ?? returnTo.value);
        } catch (readError) {
          if (
            readError instanceof RequestFailure &&
            ["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(readError.code)
          ) {
            guestNeedsLogout.value = true;
            throw Error(
              "浏览器保留着已结束的访客会话。请先退出旧会话，再确认邀请后重新进入。",
              { cause: readError },
            );
          }
          guestUncertain.value = true;
          throw Error(
            "当前登录会话尚未确认，请先确认会话状态，不要重复使用邀请。",
            { cause: readError },
          );
        }
        return;
      }
      if (
        !(cause instanceof RequestFailure) ||
        cause.retryable ||
        [
          "DATABASE_ERROR",
          "COMMIT_FAILED",
          "INTERNAL_ERROR",
          "SERVICE_UNAVAILABLE",
          "REQUEST_TIMEOUT",
          "INVALID_RESPONSE",
        ].includes(cause.code)
      ) {
        guestUncertain.value = true;
        throw Error(
          "访客进入结果尚未确认。请先确认当前会话，不要重复使用邀请。",
          { cause },
        );
      }
      throw cause;
    }
  });
}
async function recoverGuest() {
  if (busy.value || !guestUncertain.value) return;
  await runGuest(async () => {
    try {
      const user = await session.load();
      if (alive) await router.replace(guestRoomPath(user) ?? returnTo.value);
    } catch (cause) {
      if (
        cause instanceof RequestFailure &&
        ["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(cause.code)
      ) {
        guestUncertain.value = false;
        guestNeedsLogout.value = true;
        throw Error("未发现有效访客会话，请向房主确认邀请仍有效后重新进入。", {
          cause,
        });
      }
      throw Error("仍无法确认访客会话，请稍后重试确认。", { cause });
    }
  });
}
async function clearOldGuestSession() {
  if (busy.value || !guestNeedsLogout.value || session.user) return;
  await runGuest(async () => {
    // Another tab may have signed into a registered account since the error.
    try {
      const current = await session.load();
      if (alive) await router.replace(guestRoomPath(current) ?? returnTo.value);
      return;
    } catch (cause) {
      if (
        !(cause instanceof RequestFailure) ||
        !["LOGIN_REQUIRED", "SESSION_EXPIRED"].includes(cause.code)
      )
        throw Error("暂时无法确认旧会话状态，请稍后重试退出。", { cause });
    }
    if (!alive || session.user) return;
    await session.logout();
    if (!alive) return;
    guestNeedsLogout.value = guestUncertain.value = false;
    guestMessage.value = "旧会话已退出，请确认邀请仍有效后再点击进入。";
  });
}
async function login() {
  await session.login(username.value, password.value, authentication.signal);
  if (!alive) return;
  password.value = "";
  await router.replace(returnTo.value);
}
</script>
<template>
  <div class="auth-panel surface-card">
    <header class="page-intro auth-intro">
      <p class="page-eyebrow">欢迎回来</p>
      <h1 id="login-title">{{ invitation ? "加入受邀房间" : "登录" }}</h1>
      <p>
        {{
          invitation
            ? "登录后确认加入，也可以使用下方访客入口。"
            : "使用登录账号和密码进入 RainSync。"
        }}
      </p>
    </header>
    <Notice
      v-if="expired"
      message="登录状态已过期，请重新登录后继续原页面。未保存的内容需要重新填写。"
    />
    <p v-if="returnTo.startsWith('/rooms/')" class="helper auth-return-note">
      登录后返回房间页面，请确认后再加入房间。
    </p>
    <form novalidate :aria-busy="busy" @submit.prevent="submitLogin">
      <div class="form-field">
        <label for="login-username">登录账号</label>
        <input
          id="login-username"
          v-model="username"
          autocomplete="username"
          autocapitalize="none"
          :spellcheck="false"
          required
          autofocus
          :disabled="busy"
          :aria-invalid="loginField === 'username'"
          :aria-describedby="
            loginField === 'username' ? 'login-username-error' : undefined
          "
        />
        <p
          v-if="loginField === 'username'"
          id="login-username-error"
          class="field-error"
          role="alert"
        >
          {{ error }}
        </p>
      </div>
      <div class="form-field">
        <label for="login-password">密码</label>
        <div class="password-field">
          <input
            id="login-password"
            v-model="password"
            :type="show ? 'text' : 'password'"
            autocomplete="current-password"
            required
            :disabled="busy"
            :aria-invalid="loginField === 'password'"
            :aria-describedby="
              loginField === 'password' ? 'login-password-error' : undefined
            "
          />
          <button
            type="button"
            :aria-pressed="show"
            aria-controls="login-password"
            :disabled="busy"
            @click="show = !show"
          >
            {{ show ? "隐藏" : "显示" }}
          </button>
        </div>
        <p
          v-if="loginField === 'password'"
          id="login-password-error"
          class="field-error"
          role="alert"
        >
          {{ error }}
        </p>
      </div>
      <Notice id="login-error" :message="loginField ? '' : error" error />
      <Notice :message="message" />
      <button class="primary" :disabled="busy">
        {{ busy ? "正在登录…" : "登录" }}
      </button>
    </form>
    <p v-if="policyLoading" class="helper" role="status">正在读取注册入口…</p>
    <div v-else-if="policyError">
      <Notice :message="policyError" error /><button
        type="button"
        @click="reloadPolicy"
      >
        重试读取入口
      </button>
    </div>
    <p v-else-if="policy?.registration_mode === 'closed'" class="helper">
      当前已关闭新账号注册。已有账号可继续登录。
    </p>
    <p v-else-if="policy" class="auth-link">
      <RouterLink :to="registration">{{
        policy.registration_mode === "open" ? "创建账号" : "使用邀请码注册"
      }}</RouterLink>
    </p>
    <details
      v-if="
        (policy?.guests_enabled ||
          guestUncertain ||
          guestNeedsLogout ||
          guestError ||
          guestInvite) &&
        !policyLoading &&
        !session.user
      "
      class="guest-entry"
      :open="guestOpen"
      @toggle="guestOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary>
        <span class="guest-chevron" aria-hidden="true">›</span
        >使用房间邀请作为访客进入
      </summary>
      <form novalidate :aria-busy="busy" @submit.prevent="submitGuest">
        <p class="helper">
          房主开启访客入口后，可凭观看邀请进入。访客可观看和聊天，会话最长 2
          小时。
        </p>
        <div class="form-field">
          <label for="guest-invitation">房间邀请 JSON 或本站邀请链接</label
          ><textarea
            id="guest-invitation"
            v-model="guestInvite"
            required
            autocomplete="off"
            autocapitalize="none"
            :spellcheck="false"
            :disabled="busy || guestUncertain"
            rows="3"
            :aria-invalid="guestField === 'invitation'"
            aria-describedby="guest-error"
          />
        </div>
        <div class="form-field">
          <label for="guest-name">访客昵称（可选）</label
          ><input
            id="guest-name"
            v-model="guestName"
            autocomplete="nickname"
            :disabled="busy || guestUncertain"
            maxlength="100"
            :aria-invalid="guestField === 'name'"
            aria-describedby="guest-error"
          />
          <p class="field-hint">最多 50 个字符，留空使用系统访客名称。</p>
        </div>
        <Notice id="guest-error" :message="guestError" error />
        <Notice :message="guestMessage" />
        <p v-if="!policy?.guests_enabled" class="helper">
          本站暂未开放访客入口，请使用账号登录。
        </p>
        <button
          v-if="!guestUncertain && !guestNeedsLogout"
          class="primary"
          :disabled="busy || !policy?.guests_enabled"
        >
          {{ busy ? "正在进入…" : "作为受限访客进入" }}
        </button>
        <button
          v-else-if="guestNeedsLogout"
          type="button"
          :disabled="busy"
          @click="clearOldGuestSession"
        >
          退出旧访客会话
        </button>
        <button v-else type="button" :disabled="busy" @click="recoverGuest">
          确认当前访客会话
        </button>
      </form>
    </details>
  </div>
</template>
<style scoped>
.auth-intro {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
}
.auth-return-note {
  margin-bottom: var(--space-4);
}
.guest-entry {
  margin-top: var(--space-6);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
.guest-entry summary {
  cursor: pointer;
  min-height: var(--control-height);
  display: flex;
  align-items: center;
  font-weight: 650;
  gap: var(--space-2);
}
.guest-chevron {
  font-size: 24px;
  transition: transform 160ms;
}
.guest-entry[open] .guest-chevron {
  transform: rotate(90deg);
}
.guest-entry form {
  margin-top: var(--space-4);
}
</style>
