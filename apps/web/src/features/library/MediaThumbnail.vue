<script setup lang="ts">
import AppIcon from "../../shared/ui/AppIcon.vue";
import { ref, watch } from "vue";
import type { MediaCover } from "../../shared/api/types";
const props = defineProps<{
  small?: boolean;
  stalled?: boolean;
  cover?: MediaCover;
  alt?: string;
}>();
const failed = ref(false);
watch(
  () => props.cover?.revision,
  () => (failed.value = false),
);
</script>
<template>
  <div
    class="media-thumbnail"
    :class="{ small }"
    role="img"
    :aria-label="alt || '暂无影片封面'"
  >
    <img
      v-if="cover?.status === 'ready' && cover.url && !failed"
      :src="cover.url"
      :alt="alt || '影片封面'"
      loading="lazy"
      @error="failed = true"
    />
    <template v-else
      ><AppIcon name="movie" :size="small ? 24 : 34" /><span v-if="!small">{{
        stalled || failed || cover?.status === "unavailable"
          ? "暂无法生成预览"
          : ["queued", "running"].includes(cover?.status ?? "")
            ? "正在生成预览…"
            : "暂无封面"
      }}</span></template
    >
  </div>
</template>
