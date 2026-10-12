<script setup lang="ts">
import LoginPanel from "./LoginPanel.vue";
</script>
<template>
  <section class="auth-page login-page" aria-labelledby="login-title">
    <RouterLink class="brand" to="/">RainSync</RouterLink>
    <LoginPanel />
  </section>
</template>
