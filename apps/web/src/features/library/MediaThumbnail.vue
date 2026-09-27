<script setup lang="ts">
import AppIcon from "../../shared/ui/AppIcon.vue";
defineProps<{ small?: boolean }>();
</script>
<template>
  <div
    class="media-thumbnail"
    :class="{ small }"
    role="img"
    aria-label="暂无影片封面"
  >
    <AppIcon name="movie" :size="small ? 24 : 34" /><span v-if="!small"
      >暂无封面</span
    >
  </div>
</template>
