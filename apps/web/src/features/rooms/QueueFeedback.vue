<script setup lang="ts">
import { computed } from "vue";
import { useRoomRuntime } from "./room-runtime";
import Notice from "../../shared/ui/Notice.vue";
const props = defineProps<{ mediaId?: string }>();
const runtime = useRoomRuntime();
const receipt = computed(() =>
  props.mediaId
    ? runtime.queueReceipt("add", props.mediaId)
    : runtime.queueNotice,
);
const pending = computed(() =>
  props.mediaId
    ? runtime.queuePending("add", props.mediaId)
    : runtime.queuePendingCount > 0,
);
const visible = computed(
  () =>
    !!runtime.room &&
    (receipt.value ||
      pending.value ||
      (!props.mediaId && runtime.playlistError)),
);
async function reload() {
  // Only repeat the read. Successful queue mutations are never replayed here.
  await runtime.refreshPlaylist().catch(() => {});
}
</script>
<template>
  <div
    v-if="visible"
    class="queue-feedback"
    :class="{ 'queue-feedback--inline': mediaId }"
  >
    <template v-if="mediaId">
      <div class="queue-feedback__summary">
        <p class="helper" :role="runtime.playlistError ? 'alert' : 'status'">
          {{ receipt ? "已加入" : "正在加入…" }}
          <span v-if="runtime.playlistError" class="sr-only"
            >，待播列表未能更新，当前显示的内容可能不是最新。{{
              runtime.playlistError
            }}</span
          >
        </p>
        <button
          v-if="runtime.playlistError"
          class="text-button"
          :disabled="runtime.playlistLoading"
          @click="reload"
        >
          {{ runtime.playlistLoading ? "正在重新加载…" : "重新加载待播列表" }}
        </button>
      </div>
      <details v-if="runtime.playlistError" class="queue-feedback__details">
        <summary>待播列表未更新 · 查看原因</summary>
        <p class="helper">
          {{
            runtime.playlistError
          }}。当前显示的内容可能不是最新，重新加载不会重复加入影片。
        </p>
      </details>
    </template>
    <template v-else>
      <Notice :message="receipt" />
      <p v-if="pending" class="helper" role="status">正在更新待播…</p>
      <Notice
        v-if="runtime.playlistError"
        :message="`待播列表未能更新，当前显示的内容可能不是最新。${runtime.playlistError}`"
        error
      >
        <button :disabled="runtime.playlistLoading" @click="reload">
          {{ runtime.playlistLoading ? "正在重新加载…" : "重新加载待播列表" }}
        </button>
      </Notice>
    </template>
  </div>
</template>
<style scoped>
.queue-feedback--inline {
  min-width: 0;
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-2);
}
.queue-feedback__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.queue-feedback__summary .helper {
  margin: 0;
  color: var(--success);
}
.queue-feedback__summary .text-button {
  padding-inline: var(--space-1);
  flex-shrink: 0;
}
.queue-feedback__details {
  margin-top: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--warning);
  overflow-wrap: anywhere;
}
.queue-feedback__details summary {
  cursor: pointer;
}
</style>
