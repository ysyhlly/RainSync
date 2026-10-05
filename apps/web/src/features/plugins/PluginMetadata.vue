<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
const props = defineProps<{ mediaId: string; refreshKey?: number }>(),
  session = useSession(),
  labels = ref<{ plugin_id: string; label: string }[]>([]);
let serial = 0,
  controller: AbortController | undefined;
watch(
  () => [props.mediaId, session.epoch, props.refreshKey] as const,
  async ([id]) => {
    const request = ++serial;
    controller?.abort();
    labels.value = [];
    if (!id || !session.user) return;
    controller = new AbortController();
    try {
      const result = await session.api<{
        media_id: string;
        extensions: { plugin_id: string; label: string }[];
      }>(
        `/media/${encodeURIComponent(id)}/plugin-metadata`,
        "GET",
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      );
      if (request !== serial || result.media_id !== id) return;
      if (Array.isArray(result.extensions) && result.extensions.length <= 2)
        labels.value = result.extensions.filter(
          (v) => typeof v.label === "string" && v.label.length <= 100,
        );
    } catch {
      /* Optional metadata cannot interrupt library or playback. */
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++serial;
  controller?.abort();
});
</script>
<template>
  <div v-if="labels.length" class="plugin-metadata" aria-label="插件元信息">
    <span v-for="label in labels" :key="label.plugin_id">{{
      label.label
    }}</span>
  </div>
</template>
<style scoped>
.plugin-metadata {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.plugin-metadata span {
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--surface-muted, #eee);
  overflow-wrap: anywhere;
}
</style>
