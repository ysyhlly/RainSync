<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { RegistrationConfirmationRequired, useSession } from "./session.store";
import { useRegistrationPolicy } from "./registration-policy";
import { RequestFailure } from "../../errors";
import { validateAccount } from "./account-rules";
import Notice from "../../shared/ui/Notice.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import { authenticationLocation, safeRedirect } from "../../app/navigation";
const session = useSession(),
  router = useRouter(),
  route = useRoute(),
  step = ref(1),
  code = ref(""),
  username = ref(""),
  nickname = ref(""),
  password = ref(""),
  confirm = ref(""),
  show = ref(false),
  busy = ref(false),
  error = ref(""),
  uncertain = ref(false),
  expires = ref<number>(),
  retrySeconds = ref(0);
const registrationReceipt = ref<{ id: string; username: string }>();
const {
  policy,
  loading: policyLoading,
  error: policyError,
  reload: reloadPolicy,
} = useRegistrationPolicy(session);
const registrationMode = computed(() => policy.value?.registration_mode);
watch(
  registrationMode,
  (mode, before) => {
    if (mode === before) return;
    step.value = mode === "open" ? 2 : 1;
    expires.value = undefined;
    code.value = password.value = confirm.value = "";
  },
  { flush: "sync" },
);
const fieldError = ref<{ field: string; message: string } | null>(null);
watch([code, username, nickname, password, confirm], (values, previous) => {
  if (!fieldError.value) return;
  const index = [
    "code",
    "username",
    "display_name",
    "password",
    "confirm",
  ].indexOf(fieldError.value.field);
  if (values[index] !== previous[index]) {
    if (error.value === fieldError.value.message) error.value = "";
    fieldError.value = null;
  }
});
const returnTo = computed(() => safeRedirect(route.query.redirect));
const loginLocation = computed(() =>
  authenticationLocation(
    "/login",
    returnTo.value,
    route.query.notice === "session-expired" || session.expired,
  ),
);
let retryAt = 0,
  alive = true;
const authentication = new AbortController();
const timer = setInterval(
  () =>
    (retrySeconds.value = Math.max(
      0,
      Math.ceil((retryAt - Date.now()) / 1000),
    )),
  1000,
);
onBeforeUnmount(() => {
  alive = false;
  authentication.abort();
  clearInterval(timer);
  password.value = "";
  confirm.value = "";
  code.value = "";
});
async function focus(id: string) {
  busy.value = false;
  await nextTick();
  document.getElementById(id)?.focus();
}
function failure(e: unknown) {
  error.value = e instanceof Error ? e.message : String(e);
  if (e instanceof RequestFailure && e.code === "RATE_LIMITED") {
    retryAt = Date.now() + (e.retryAfterMs ?? 60000);
    retrySeconds.value = Math.ceil((retryAt - Date.now()) / 1000);
  }
}
async function validate() {
  if (
    busy.value ||
    retrySeconds.value ||
    policyLoading.value ||
    registrationMode.value !== "invite_only"
  )
    return;
  if (!code.value.trim()) {
    error.value = "请填写注册邀请码。";
    fieldError.value = { field: "code", message: error.value };
    await focus("register-code");
    return;
  }
  busy.value = true;
  error.value = "";
  fieldError.value = null;
  try {
    const value = await session.api<{ expires_at: number }>(
      "/auth/registration-invites/validate",
      "POST",
      { code: code.value },
      AbortSignal.timeout(15000),
    );
    if (!alive) return;
    expires.value = value.expires_at;
    step.value = 2;
    await focus("register-username");
  } catch (e) {
    if (!alive) return;
    failure(e);
    if (e instanceof RequestFailure && e.code === "REGISTRATION_CLOSED")
      await reloadPolicy();
    if (
      e instanceof RequestFailure &&
      e.code === "REGISTRATION_INVITE_INVALID"
    ) {
      fieldError.value = { field: "code", message: error.value };
      await focus("register-code");
    }
  } finally {
    busy.value = false;
  }
}
async function changeInvite() {
  if (busy.value || uncertain.value || registrationMode.value !== "invite_only")
    return;
  step.value = 1;
  password.value = "";
  confirm.value = "";
  error.value = "";
  fieldError.value = null;
  await focus("register-code");
}
async function complete() {
  password.value = "";
  confirm.value = "";
  code.value = "";
  registrationReceipt.value = undefined;
  await router.replace(returnTo.value);
}
async function confirmSession() {
  try {
    const user = await session.load();
    if (!alive) return false;
    if (
      user.username === username.value &&
      (!registrationReceipt.value || user.id === registrationReceipt.value.id)
    ) {
      await complete();
      return true;
    }
    error.value =
      "当前浏览器已登录其他账号，请先退出当前账号，再使用刚设置的登录账号确认注册结果。";
    return false;
  } catch {
    return false;
  }
}
async function register() {
  if (
    busy.value ||
    retrySeconds.value ||
    uncertain.value ||
    policyLoading.value ||
    !["open", "invite_only"].includes(registrationMode.value ?? "")
  )
    return;
  error.value = "";
  fieldError.value = null;
  const invalid = validateAccount(
    username.value,
    password.value,
    nickname.value,
  );
  if (invalid) {
    error.value = invalid.message;
    fieldError.value = invalid;
    await focus("register-" + invalid.field);
    return;
  }
  if (password.value !== confirm.value) {
    error.value = confirm.value ? "两次输入的密码不一致" : "请再次输入密码。";
    fieldError.value = { field: "confirm", message: error.value };
    await focus("register-confirm");
    return;
  }
  busy.value = true;
  try {
    await session.register(
      {
        ...(registrationMode.value === "invite_only"
          ? { code: code.value }
          : {}),
        username: username.value,
        password: password.value,
        display_name: nickname.value,
      },
      authentication.signal,
    );
    if (!alive) return;
    await complete();
  } catch (e) {
    if (!alive) return;
    if (e instanceof RegistrationConfirmationRequired)
      registrationReceipt.value = e.receipt;
    // Only explicit pre-commit denials make another signup safe. A structured
    // server/transport failure can also follow an already-committed account.
    const definite =
      e instanceof RequestFailure &&
      [
        "REGISTRATION_CLOSED",
        "USERNAME_TAKEN",
        "REGISTRATION_INVITE_INVALID",
        "USERNAME_OR_PASSWORD_INVALID",
        "INVALID_REQUEST",
        "RATE_LIMITED",
        "FORBIDDEN",
        "CSRF_REJECTED",
        "ORIGIN_REJECTED",
        "UNSUPPORTED_MEDIA_TYPE",
        "GUEST_RESTRICTED",
      ].includes(e.code);
    if (definite) {
      failure(e);
      if (e.code === "REGISTRATION_CLOSED") {
        password.value = confirm.value = "";
        await reloadPolicy();
      } else if (e.code === "USERNAME_TAKEN") {
        fieldError.value = { field: "username", message: error.value };
        await focus("register-username");
      } else if (e.code === "REGISTRATION_INVITE_INVALID") {
        await reloadPolicy();
        step.value = 1;
        password.value = "";
        confirm.value = "";
        fieldError.value = { field: "code", message: error.value };
        await focus("register-code");
      }
    } else {
      uncertain.value = true;
      if (!(await confirmSession()) && !session.user)
        error.value = registrationReceipt.value
          ? "账号已创建，登录状态尚未确认。请使用刚设置的账号登录确认，不要重复提交注册。"
          : "注册结果尚未确认。请使用刚设置的登录账号和密码登录确认，不要重复提交注册。";
    }
  } finally {
    busy.value = false;
  }
}
async function recover() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (await confirmSession()) return;
    if (session.user) {
      error.value = "当前已登录其他账号，请先退出该账号。";
      return;
    }
    const user = await session.login(
      username.value,
      password.value,
      authentication.signal,
    );
    if (registrationReceipt.value && user.id !== registrationReceipt.value.id)
      throw new Error("当前登录账号与本次注册结果不一致，请先退出当前账号。");
    if (alive) await complete();
  } catch (e) {
    if (alive) failure(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section
    class="auth-page registration-page"
    aria-labelledby="registration-title"
  >
    <div class="auth-top">
      <RouterLink class="brand" to="/">RainSync</RouterLink>
      <RouterLink :to="loginLocation">返回登录</RouterLink>
    </div>
    <div
      class="registration-panel"
      :class="{
        'registration-panel--simple': registrationMode !== 'invite_only',
      }"
    >
      <aside class="registration-steps">
        <h1 id="registration-title">
          {{
            registrationMode === "open"
              ? "创建账号"
              : registrationMode === "closed"
                ? "注册已关闭"
                : "账号注册"
          }}
        </h1>
        <ol
          v-if="registrationMode === 'invite_only' && !policyLoading"
          aria-label="注册步骤"
        >
          <li
            :class="{ current: step === 1 }"
            :aria-current="step === 1 ? 'step' : undefined"
          >
            <span
              ><AppIcon v-if="step === 2" name="check" :size="16" /><template
                v-else
                >1</template
              ></span
            >
            <div>验证邀请码<small>由管理员提供</small></div>
          </li>
          <li
            :class="{ current: step === 2 }"
            :aria-current="step === 2 ? 'step' : undefined"
          >
            <span>2</span>
            <div>设置账号<small>注册普通观看账号</small></div>
          </li>
        </ol>
        <p v-else-if="registrationMode === 'open'" class="helper">
          设置普通观看账号，注册成功后自动登录。
        </p>
      </aside>
      <div class="registration-form">
        <p
          v-if="policyLoading"
          class="loading-state loading-state--inline"
          role="status"
        >
          正在读取注册方式…
        </p>
        <div v-else-if="policyError">
          <Notice :message="policyError" error /><button @click="reloadPolicy">
            重试读取注册方式
          </button>
        </div>
        <div v-else-if="registrationMode === 'closed'" class="page-stack">
          <h2>当前暂停新账号注册</h2>
          <p class="helper">已有账号仍可登录。若需要访问，请联系站点管理员。</p>
          <RouterLink class="button primary" :to="loginLocation"
            >返回登录</RouterLink
          >
        </div>
        <form
          v-else-if="step === 1 && registrationMode === 'invite_only'"
          :aria-busy="busy"
          novalidate
          @submit.prevent="validate"
        >
          <header class="auth-step-heading">
            <p class="page-eyebrow">第 1 步，共 2 步</p>
            <h2>验证邀请码</h2>
            <p class="helper">验证不会消耗或预留名额，注册成功后才使用。</p>
          </header>
          <div class="form-field">
            <label for="register-code">注册邀请码</label>
            <input
              id="register-code"
              v-model="code"
              autocomplete="off"
              autocapitalize="none"
              :spellcheck="false"
              placeholder="RS-…"
              required
              :disabled="busy"
              :aria-invalid="fieldError?.field === 'code'"
              :aria-describedby="
                fieldError?.field === 'code' ? 'register-error' : undefined
              "
            />
          </div>
          <Notice id="register-error" :message="error" error />
          <button class="primary" :disabled="busy || retrySeconds > 0">
            {{
              busy
                ? "正在验证…"
                : retrySeconds
                  ? retrySeconds + "秒后重试"
                  : "验证并继续"
            }}
            <AppIcon name="next" />
          </button>
        </form>
        <form
          v-else-if="
            registrationMode === 'open' || registrationMode === 'invite_only'
          "
          :aria-busy="busy"
          novalidate
          @submit.prevent="register"
        >
          <header class="auth-step-heading">
            <p v-if="registrationMode === 'invite_only'" class="page-eyebrow">
              第 2 步，共 2 步
            </p>
            <h2>设置账号</h2>
            <p v-if="registrationMode === 'invite_only'" class="helper">
              邀请码已验证，有效期至
              {{
                expires
                  ? new Date(expires).toLocaleString("zh-CN")
                  : "服务端指定时间"
              }}；最终以提交时状态为准。
            </p>
            <p v-else class="helper">
              当前开放自行注册，无需注册邀请码。注册方式以提交时的服务器设置为准。
            </p>
          </header>
          <div class="form-field">
            <label for="register-username">登录账号</label>
            <input
              id="register-username"
              v-model="username"
              autocomplete="username"
              autocapitalize="none"
              :spellcheck="false"
              required
              maxlength="80"
              :disabled="busy || uncertain"
              :aria-invalid="fieldError?.field === 'username'"
              :aria-describedby="
                fieldError?.field === 'username'
                  ? 'account-help register-error'
                  : 'account-help'
              "
            />
            <p id="account-help" class="helper field-hint">
              唯一且注册后不可修改。支持字母、数字、_、- 和 .。
            </p>
            <p
              v-if="fieldError?.field === 'username'"
              id="register-error"
              class="field-error"
              role="alert"
            >
              {{ fieldError.message }}
            </p>
          </div>
          <div class="form-field">
            <label for="register-display_name">昵称（可选）</label>
            <input
              id="register-display_name"
              v-model="nickname"
              autocomplete="nickname"
              :disabled="busy || uncertain"
              :aria-invalid="fieldError?.field === 'display_name'"
              :aria-describedby="
                fieldError?.field === 'display_name'
                  ? 'nickname-help register-error'
                  : 'nickname-help'
              "
            />
            <p id="nickname-help" class="helper field-hint">
              最多 50 个字符，支持中文与
              Emoji，可以重复或稍后修改。留空显示登录账号。
            </p>
            <p
              v-if="fieldError?.field === 'display_name'"
              id="register-error"
              class="field-error"
              role="alert"
            >
              {{ fieldError.message }}
            </p>
          </div>
          <div class="form-field">
            <label for="register-password">密码</label>
            <div class="password-field">
              <input
                id="register-password"
                v-model="password"
                :type="show ? 'text' : 'password'"
                autocomplete="new-password"
                required
                :disabled="busy || uncertain"
                :aria-invalid="fieldError?.field === 'password'"
                :aria-describedby="
                  fieldError?.field === 'password'
                    ? 'password-help register-error'
                    : 'password-help'
                "
              />
              <button
                type="button"
                :aria-pressed="show"
                aria-controls="register-password register-confirm"
                :disabled="busy"
                @click="show = !show"
              >
                {{ show ? "隐藏" : "显示" }}
              </button>
            </div>
            <p id="password-help" class="helper field-hint">
              至少 8 个英文字符、数字、英文符号或空格，不支持中文。空格将保留。
            </p>
            <p
              v-if="fieldError?.field === 'password'"
              id="register-error"
              class="field-error"
              role="alert"
            >
              {{ fieldError.message }}
            </p>
          </div>
          <div class="form-field">
            <label for="register-confirm">确认密码</label>
            <input
              id="register-confirm"
              v-model="confirm"
              :type="show ? 'text' : 'password'"
              autocomplete="new-password"
              required
              :disabled="busy || uncertain"
              :aria-invalid="fieldError?.field === 'confirm'"
              :aria-describedby="
                fieldError?.field === 'confirm' ? 'register-error' : undefined
              "
            />
            <p
              v-if="fieldError?.field === 'confirm'"
              id="register-error"
              class="field-error"
              role="alert"
            >
              {{ fieldError.message }}
            </p>
          </div>
          <Notice
            id="register-server-error"
            :message="fieldError ? '' : error"
            error
          />
          <button
            v-if="!uncertain"
            class="primary"
            :disabled="busy || retrySeconds > 0"
          >
            {{
              busy
                ? "正在注册…"
                : retrySeconds
                  ? retrySeconds + "秒后重试"
                  : "注册并登录"
            }}
          </button>
          <button
            v-else
            type="button"
            class="primary"
            :disabled="busy"
            @click="recover"
          >
            {{ busy ? "正在确认…" : "使用刚设置的账号登录确认" }}
          </button>
          <button
            v-if="!uncertain && registrationMode === 'invite_only'"
            type="button"
            class="text-button"
            :disabled="busy"
            @click="changeInvite"
          >
            返回修改邀请码
          </button>
        </form>
        <div class="registration-context">
          <p v-if="registrationMode === 'invite_only'" class="helper">
            注册邀请码与房间邀请相互独立。
          </p>
          <p v-if="returnTo.startsWith('/rooms/')" class="helper">
            注册后返回房间页面，请确认后再加入房间。
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.auth-step-heading {
  display: grid;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.registration-form form {
  gap: var(--space-5);
}
.registration-form .form-field label {
  margin-top: 0;
}
.registration-context {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-6);
}
</style>
