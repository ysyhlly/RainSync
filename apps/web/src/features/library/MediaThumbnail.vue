<script setup lang="ts">
import AppIcon from "../../shared/ui/AppIcon.vue";
import { ref, watch } from "vue";
import type { MediaCover } from "../../shared/api/types";
const props = defineProps<{
  small?: boolean;
  stalled?: boolean;
  cover?: MediaCover;
  alt?: string;
  refreshKey?: number;
}>();
const failed = ref(false);
watch(
  [() => props.cover?.revision, () => props.cover?.url, () => props.refreshKey],
  () => (failed.value = false),
);
</script>
<template>
  <div
    class="media-thumbnail"
    :class="{ small, 'image-failed': failed }"
    role="group"
    :aria-label="alt || '影片封面'"
  >
    <img
      v-if="cover?.status === 'ready' && cover.url && !failed"
      :src="cover.url"
      :alt="alt || '影片封面'"
      loading="lazy"
      @error="failed = true"
    />
    <template v-else
      ><AppIcon
        v-if="!failed || !small"
        name="movie"
        :size="small ? 24 : 34"
      /><span v-if="!small">{{
        failed
          ? "封面加载失败"
          : stalled || cover?.status === "unavailable"
            ? "暂无法生成预览"
            : ["queued", "running"].includes(cover?.status ?? "")
              ? "正在生成预览…"
              : "暂无封面"
      }}</span></template
    >
    <button
      v-if="failed"
      type="button"
      :class="{ 'icon-button': small }"
      aria-label="重新加载封面"
      title="重新加载封面"
      @click.stop="failed = false"
    >
      <AppIcon v-if="small" name="refresh" /><template v-else
        >重新加载封面</template
      >
    </button>
  </div>
</template>
<style scoped>
/* Keep a 44px retry target inside the 16:9 compact placeholder on phones. */
.small.image-failed {
  min-width: 84px;
}
</style>
