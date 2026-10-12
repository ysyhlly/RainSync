<script setup lang="ts">
import { computed } from "vue";
import type { PlaybackMetricsSnapshot } from "./playback-metrics";
import PlaybackStartupDiagnostics from "./PlaybackStartupDiagnostics.vue";
import {
  describePlaybackPreparation,
  type PlaybackPreparationState,
} from "./playback-preparation";

const props = withDefaults(
  defineProps<{
    state: PlaybackPreparationState;
    compact?: boolean;
    canRetry?: boolean;
    loadingStage?: string;
    diagnostics?: PlaybackMetricsSnapshot;
  }>(),
  { compact: false, canRetry: true },
);
const emit = defineEmits<{ cancel: []; retry: [] }>();
const view = computed(() =>
  describePlaybackPreparation(props.state, props.loadingStage),
);
</script>

<template>
  <div
    v-if="state.phase !== 'idle'"
    class="playback-preparation"
    :class="{ compact }"
    :data-phase="state.phase"
  >
    <div
      :role="state.phase === 'failed' ? 'alert' : 'status'"
      aria-atomic="true"
    >
      <strong>{{ view.label }}</strong>
      <p v-if="!compact || state.phase === 'failed'">{{ view.detail }}</p>
      <p v-if="state.failure?.requestId" class="diagnostic">
        诊断编号：{{ state.failure.requestId }}
      </p>
      <p
        v-if="
          state.failure?.retryAfterMs != null && state.failure.retryAfterMs > 0
        "
      >
        服务端建议等待
        {{ Math.ceil(state.failure.retryAfterMs / 1000) }} 秒后重试。
      </p>
    </div>
    <p
      v-if="state.phase === 'ready' && loadingStage === 'waiting_frame'"
      class="helper"
    >
      有数据不代表画面已显示；等待过久时会提供重新加载入口。
    </p>
    <PlaybackStartupDiagnostics v-if="diagnostics" :diagnostics="diagnostics" />
    <div
      v-if="view.cancel || view.retry || view.account || view.chooseMedia"
      class="preparation-actions"
    >
      <RouterLink v-if="view.account" class="button" to="/account/profile"
        >检查平台账号</RouterLink
      >
      <RouterLink v-if="view.chooseMedia" class="button" to="/library"
        >选择其他影片</RouterLink
      >
      <button v-if="view.cancel" type="button" @click="emit('cancel')">
        取消准备
      </button>
      <button
        v-if="view.retry"
        type="button"
        :disabled="!canRetry"
        @click="emit('retry')"
      >
        重新发起播放
      </button>
    </div>
  </div>
</template>

<style scoped>
.playback-preparation {
  padding: 12px;
  border: 1px solid var(--border-control);
  border-radius: 10px;
  background: var(--surface-panel);
  color: var(--text-primary);
}
.playback-preparation p {
  margin: 6px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.preparation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.preparation-actions button {
  min-height: 44px;
}
.compact {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 12px;
  max-height: min(240px, 32vh);
  overflow: auto;
}
.playback-preparation.compact p {
  display: block;
}
.compact .preparation-actions {
  margin-top: 4px;
}
.compact .preparation-actions button {
  padding: 4px 8px;
  font-size: 12px;
}
.preparation-overlay {
  position: absolute;
  z-index: 5;
  top: 12px;
  left: 12px;
  right: 12px;
  max-width: 440px;
  max-height: calc(100% - 88px);
  overflow: auto;
  background: rgb(0 0 0 / 0.88);
  color: #fff;
  border-color: rgb(255 255 255 / 0.3);
}
.preparation-overlay p {
  color: #fff;
}
.preparation-overlay button {
  color: #fff;
  background: rgb(255 255 255 / 0.12);
  border-color: rgb(255 255 255 / 0.4);
}
.preparation-overlay button:focus-visible {
  outline: 2px solid var(--player-progress, #eed9b5);
  outline-offset: 2px;
}
</style>
