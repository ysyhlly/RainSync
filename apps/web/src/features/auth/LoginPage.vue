<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from "vue";
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
  <section class="auth-page">
    <RouterLink class="brand" to="/">RainSync</RouterLink>
    <div class="auth-panel">
      <h1>登录</h1>
      <p>使用登录账号和密码进入 RainSync。</p>
      <Notice
        v-if="expired"
        message="登录状态已过期，请重新登录后继续原页面。未保存的内容需要重新填写。"
      />
      <p v-if="returnTo.startsWith('/rooms/')" class="helper">
        登录后返回房间页面，请确认后再加入房间。
      </p>
      <form @submit.prevent="run(login)">
        <label
          >登录账号<input
            v-model="username"
            autocomplete="username"
            required
            autofocus
            :disabled="busy"
        /></label>
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
            /><button type="button" :aria-pressed="show" @click="show = !show">
              {{ show ? "隐藏" : "显示" }}
            </button>
          </div>
        </div>
        <Notice :message="error" error /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在登录…" : "登录" }}
        </button>
      </form>
      <p class="auth-link">
        <RouterLink :to="registration">使用邀请码注册</RouterLink>
      </p>
    </div>
  </section>
</template>
