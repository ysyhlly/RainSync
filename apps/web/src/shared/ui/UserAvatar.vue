<script setup lang="ts">
import { computed, ref, watch } from "vue";
const props = defineProps<{
  name: string;
  url?: string | null;
  size?: number;
}>();
const failed = ref(false);
watch(
  () => props.url,
  () => (failed.value = false),
);
const initial = computed(() => [...props.name.trim()][0] || "?");
</script>
<template>
  <span
    class="user-avatar"
    :style="{ width: (size ?? 40) + 'px', height: (size ?? 40) + 'px' }"
    ><img
      v-if="url && !failed"
      :src="url"
      :alt="name + '的头像'"
      @error="failed = true"
    /><span v-else aria-hidden="true">{{ initial }}</span></span
  >
</template>
