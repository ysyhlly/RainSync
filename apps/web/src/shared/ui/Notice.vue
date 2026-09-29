<script setup lang="ts">
defineProps<{ message?: string; error?: boolean }>();
</script>
<template>
  <p
    v-if="message"
    class="notice"
    :class="{ error }"
    :role="error ? 'alert' : 'status'"
  >
    {{ message }}<slot />
  </p>
</template>
