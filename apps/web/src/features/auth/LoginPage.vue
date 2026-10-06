<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useSession } from "./session.store";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
import { authenticationLocation, safeRedirect } from "../../app/navigation";
const session = useSession(),
  router = useRouter(),
  route = useRoute(),
  username = ref(""),
  password = ref(""),
  show = ref(false);
const { busy, error, run } = useAction();
watch([username, password], () => {
  if (!busy.value) error.value = "";
});
async function submitLogin() {
  if (busy.value) return;
  await run(login);
}
const returnTo = computed(() => safeRedirect(route.query.redirect));
const expired = computed(
  () => route.query.notice === "session-expired" || session.expired,
);
const registration = computed(() =>
  authenticationLocation("/register", returnTo.value, expired.value),
);
const authentication = new AbortController();
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  authentication.abort();
  password.value = "";
});
async function login() {
  await session.login(username.value, password.value, authentication.signal);
  if (!alive) return;
  password.value = "";
  await router.replace(returnTo.value);
}
</script>
<template>
  <section class="auth-page login-page" aria-labelledby="login-title">
    <RouterLink class="brand" to="/">RainSync</RouterLink>
    <div class="auth-panel surface-card">
      <header class="page-intro auth-intro">
        <p class="page-eyebrow">欢迎回来</p>
        <h1 id="login-title">登录</h1>
        <p>使用登录账号和密码进入 RainSync。</p>
      </header>
      <Notice
        v-if="expired"
        message="登录状态已过期，请重新登录后继续原页面。未保存的内容需要重新填写。"
      />
      <p v-if="returnTo.startsWith('/rooms/')" class="helper auth-return-note">
        登录后返回房间页面，请确认后再加入房间。
      </p>
      <form :aria-busy="busy" @submit.prevent="submitLogin">
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
          />
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
        </div>
        <Notice id="login-error" :message="error" error />
        <button class="primary" :disabled="busy">
          {{ busy ? "正在登录…" : "登录" }}
        </button>
      </form>
      <p class="auth-link">
        <RouterLink :to="registration">使用邀请码注册</RouterLink>
      </p>
    </div>
  </section>
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
</style>
