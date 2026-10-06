<script setup lang="ts">
import { ref } from "vue";
import { useSession } from "../auth/session.store";
import { validateAccount } from "../auth/account-rules";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
import AccountTabs from "./AccountTabs.vue";
const session = useSession(),
  { busy, error, message, run } = useAction(),
  username = ref(""),
  nickname = ref(""),
  password = ref("");
async function create() {
  const invalid = validateAccount(
    username.value,
    password.value,
    nickname.value,
  );
  if (invalid) throw Error(invalid.message);
  await session.api<{ id: string }>("/users", "POST", {
    username: username.value,
    password: password.value,
    display_name: nickname.value,
  });
  message.value = "普通账号 " + username.value + " 已创建";
  password.value = "";
  username.value = "";
  nickname.value = "";
}
</script>
<template>
  <section class="page">
    <div class="page-title">
      <div class="page-intro">
        <p class="section-label">管理</p>
        <h1>账号与注册</h1>
        <p>管理注册邀请，或手动创建普通观看账号。</p>
      </div>
    </div>
    <AccountTabs />
    <section class="panel narrow-panel surface-card">
      <h2>手动创建账号</h2>
      <form :aria-busy="busy" @submit.prevent="run(create)">
        <div class="form-field">
          <label
            >登录账号<input
              v-model="username"
              required
              maxlength="80"
              autocomplete="off"
              aria-describedby="new-account-help"
          /></label>
          <p id="new-account-help" class="helper">
            唯一且不可修改，支持英文字母、数字、_、- 和 .。
          </p>
        </div>
        <div class="form-field">
          <label
            >昵称（可选）<input
              v-model="nickname"
              autocomplete="off"
              aria-describedby="new-nickname-help"
          /></label>
          <p id="new-nickname-help" class="helper">
            最多50个字符，支持中文、Emoji和重名。
          </p>
        </div>
        <div class="form-field">
          <label
            >密码<input
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
              aria-describedby="new-password-help"
          /></label>
          <p id="new-password-help" class="helper">
            至少8个英文字符、数字、英文符号或空格，不支持中文，空格保留。
          </p>
        </div>
        <Notice :message="error" error /><Notice :message="message" /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在创建…" : "创建普通账号" }}
        </button>
      </form>
    </section>
  </section>
</template>
