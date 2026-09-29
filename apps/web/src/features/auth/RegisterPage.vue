<script setup lang="ts">
import { ref, onBeforeUnmount, nextTick } from "vue";
import { useRouter } from "vue-router";
import { useSession } from "./session.store";
import { RequestFailure } from "../../errors";
import { validateAccount } from "./account-rules";
import Notice from "../../shared/ui/Notice.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
const session = useSession(),
  router = useRouter(),
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
  if (busy.value || retrySeconds.value) return;
  busy.value = true;
  error.value = "";
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
    if (alive) failure(e);
  } finally {
    busy.value = false;
  }
}
async function complete() {
  password.value = "";
  confirm.value = "";
  code.value = "";
  await router.replace("/rooms");
}
async function confirmSession() {
  try {
    const user = await session.load();
    if (!alive) return false;
    if (user.username === username.value) {
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
  if (busy.value || retrySeconds.value || uncertain.value) return;
  error.value = "";
  const invalid = validateAccount(
    username.value,
    password.value,
    nickname.value,
  );
  if (invalid) {
    error.value = invalid.message;
    await focus("register-" + invalid.field);
    return;
  }
  if (password.value !== confirm.value) {
    error.value = "两次输入的密码不一致";
    await focus("register-confirm");
    return;
  }
  busy.value = true;
  try {
    await session.register(
      {
        code: code.value,
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
    if (e instanceof RequestFailure) {
      failure(e);
      if (e.code === "USERNAME_TAKEN") await focus("register-username");
      else if (e.code === "REGISTRATION_INVITE_INVALID") {
        step.value = 1;
        password.value = "";
        confirm.value = "";
        await focus("register-code");
      } else if (e.code === "ALREADY_AUTHENTICATED") {
        uncertain.value = true;
        await confirmSession();
      }
    } else {
      uncertain.value = true;
      if (!(await confirmSession()) && !session.user)
        error.value =
          "注册结果尚未确认。请使用刚设置的登录账号和密码登录确认，不要重复提交注册。";
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
    await session.login(username.value, password.value, authentication.signal);
    if (alive) await complete();
  } catch (e) {
    if (alive) failure(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="auth-page registration-page">
    <div class="auth-top">
      <RouterLink class="brand" to="/">RainSync</RouterLink
      ><RouterLink to="/login">返回登录</RouterLink>
    </div>
    <div class="registration-panel">
      <aside class="registration-steps">
        <h1>邀请码注册</h1>
        <ol>
          <li :class="{ current: step === 1 }">
            <span>1</span>
            <div>验证邀请码<small>由管理员提供</small></div>
          </li>
          <li :class="{ current: step === 2 }">
            <span>2</span>
            <div>设置账号<small>注册普通观看账号</small></div>
          </li>
        </ol>
        <p>注册邀请码与房间邀请相互独立。</p>
      </aside>
      <div class="registration-form">
        <form v-if="step === 1" @submit.prevent="validate">
          <h2>验证邀请码</h2>
          <p>验证不会消耗或预留名额，注册成功后才使用。</p>
          <label for="register-code">注册邀请码</label
          ><input
            id="register-code"
            v-model="code"
            autocomplete="off"
            placeholder="RS-…"
            required
            :disabled="busy"
          /><Notice :message="error" error /><button
            class="primary"
            :disabled="busy || retrySeconds > 0"
          >
            {{
              busy
                ? "正在验证…"
                : retrySeconds
                  ? retrySeconds + "秒后重试"
                  : "验证并继续"
            }}<AppIcon name="next" />
          </button>
        </form>
        <form v-else @submit.prevent="register">
          <h2>设置账号</h2>
          <p class="helper">
            邀请码已验证，有效期至
            {{
              expires
                ? new Date(expires).toLocaleString("zh-CN")
                : "服务端指定时间"
            }}；最终以提交时状态为准。
          </p>
          <label for="register-username">登录账号</label
          ><input
            id="register-username"
            v-model="username"
            autocomplete="username"
            required
            maxlength="80"
            :disabled="busy || uncertain"
            aria-describedby="account-help"
          />
          <p id="account-help" class="helper">
            唯一且注册后不可修改。支持字母、数字、_、- 和 .。
          </p>
          <label for="register-display_name">昵称（可选）</label
          ><input
            id="register-display_name"
            v-model="nickname"
            autocomplete="nickname"
            :disabled="busy || uncertain"
            aria-describedby="nickname-help"
          />
          <p id="nickname-help" class="helper">
            最多50个字符，支持中文与Emoji，可以重复或稍后修改。留空显示登录账号。
          </p>
          <label for="register-password">密码</label>
          <div class="password-field">
            <input
              id="register-password"
              v-model="password"
              :type="show ? 'text' : 'password'"
              autocomplete="new-password"
              required
              :disabled="busy || uncertain"
              aria-describedby="password-help"
            /><button type="button" :aria-pressed="show" @click="show = !show">
              {{ show ? "隐藏" : "显示" }}
            </button>
          </div>
          <p id="password-help" class="helper">
            至少8个英文字符、数字、英文符号或空格，不支持中文。空格将保留。
          </p>
          <label for="register-confirm">确认密码</label
          ><input
            id="register-confirm"
            v-model="confirm"
            :type="show ? 'text' : 'password'"
            autocomplete="new-password"
            required
            :disabled="busy || uncertain"
          /><Notice :message="error" error /><button
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
            }}</button
          ><button
            v-else
            type="button"
            class="primary"
            :disabled="busy"
            @click="recover"
          >
            {{ busy ? "正在确认…" : "使用刚设置的账号登录确认" }}</button
          ><button
            v-if="!uncertain"
            type="button"
            class="text-button"
            :disabled="busy"
            @click="
              step = 1;
              password = '';
              confirm = '';
            "
          >
            返回修改邀请码
          </button>
        </form>
      </div>
    </div>
  </section>
</template>
