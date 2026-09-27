<script setup lang="ts">
import { ref } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useSession } from "./session.store";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
import { safeRedirect } from "../../app/navigation";
const session = useSession(),
  router = useRouter(),
  route = useRoute(),
  username = ref(""),
  password = ref(""),
  show = ref(false);
const { busy, error, run } = useAction();
async function login() {
  await session.login(username.value, password.value);
  password.value = "";
  await router.replace(safeRedirect(route.query.redirect));
}
</script>
<template>
  <section class="auth-page">
    <RouterLink class="brand" to="/">RainSync</RouterLink>
    <div class="auth-panel">
      <h1>登录</h1>
      <p>使用登录账号和密码进入 RainSync。</p>
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
        <RouterLink to="/register">使用邀请码注册</RouterLink>
      </p>
    </div>
  </section>
</template>
