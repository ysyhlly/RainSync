<script setup lang="ts">
import { ref, computed, watch, useId } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import { formatTime } from "../../shared/use-action";
defineProps<{ mini?: boolean; fullscreen?: boolean }>();
const r = useRoomRuntime(),
  volume = ref(1),
  muted = ref(false);
const availabilityId = useId();
const controlDescription = computed(() => {
  if (!r.state?.media_id) return "尚未选择影片，暂不能控制房间播放。";
  if (!r.connected) return "房间连接尚未就绪，暂不能控制房间播放。";
  if (!r.can(r.state?.playback_status === "playing" ? "pause" : "play"))
    return "你可以观看影片；房间播放由有控制权限的成员操作。本机静音只影响自己。";
  return "播放、进度和倍速影响房间所有观众；音量和静音只影响本机。";
});
const animateProgress = ref(false);
watch(
  () => r.position,
  (value, old) => {
    animateProgress.value = !r.dragging && value >= old && value - old < 2;
  },
);
const progress = computed(() =>
  Number.isFinite(r.duration) && r.duration > 0
    ? Math.max(0, Math.min(100, (r.position / r.duration) * 100))
    : 0,
);
const durationKnown = computed(
  () => Number.isFinite(r.duration) && r.duration > 0,
);
const localUnavailable = computed(() =>
  ["failed", "cancelled"].includes(r.preparation?.phase ?? ""),
);
function setVolume(event: Event) {
  volume.value = Number((event.target as HTMLInputElement).value);
  if (r.video) r.video.volume = volume.value;
}
function mute() {
  muted.value = !muted.value;
  if (r.video) r.video.muted = muted.value;
}
const emit = defineEmits<{
  fullscreen: [];
  menuOpen: [value: boolean];
  dragging: [value: boolean];
}>();
function drag(event: PointerEvent) {
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  r.dragging = true;
  emit("dragging", true);
}
function end() {
  r.dragging = false;
  emit("dragging", false);
}
</script>
<template>
  <div
    class="playback-controls"
    :class="{
      compact: mini,
      'animate-progress': animateProgress && !r.dragging,
    }"
  >
    <span :id="availabilityId" class="sr-only">{{ controlDescription }}</span>
    <button
      class="icon-button control-play"
      :aria-label="
        r.state?.playback_status === 'playing' ? '暂停房间播放' : '播放房间'
      "
      :aria-describedby="availabilityId"
      :title="
        localUnavailable ? '控制房间共同播放，本机播放尚未就绪' : undefined
      "
      :disabled="
        !r.can(r.state?.playback_status === 'playing' ? 'pause' : 'play') ||
        !r.connected ||
        !r.state?.media_id
      "
      @click="r.send(r.state?.playback_status === 'playing' ? 'PAUSE' : 'PLAY')"
    >
      <AppIcon
        :name="r.state?.playback_status === 'playing' ? 'pause' : 'play'"
      /></button
    ><span v-if="r.live" class="playback-time" role="status"
      >直播边缘 · 控制同步</span
    ><span v-else class="playback-time"
      >{{
        durationKnown
          ? formatTime(r.position) + " / " + formatTime(r.duration)
          : r.loadingStage &&
              [
                "preparing",
                "initializing",
                "loading_media",
                "waiting_frame",
              ].includes(r.loadingStage)
            ? "正在读取时长…"
            : "时长未知"
      }}<template v-if="localUnavailable"> · 房间控制</template></span
    ><input
      v-if="!r.live"
      class="seek-control"
      aria-label="房间播放进度"
      :aria-describedby="availabilityId"
      type="range"
      min="0"
      :max="Number.isFinite(r.duration) ? r.duration : 0"
      step="0.1"
      :value="r.position"
      :style="{ '--range-progress': progress + '%' }"
      :disabled="
        !r.can('seek') || !r.connected || !r.state?.media_id || !durationKnown
      "
      @pointerdown="drag"
      @input="
        r.dragging = true;
        r.position = Number(($event.target as HTMLInputElement).value);
      "
      @change="r.seek"
      @pointerup="end"
      @pointercancel="end"
      @blur="end"
    /><span class="volume-group"
      ><button
        class="icon-button volume-toggle"
        :aria-label="muted ? '取消本机静音' : '本机静音'"
        :aria-pressed="muted"
        @click="mute"
      >
        <AppIcon :name="muted ? 'mute' : 'volume'" /></button
      ><input
        v-if="!mini"
        class="volume-control"
        aria-label="本机音量"
        type="range"
        min="0"
        max="1"
        step="0.05"
        :value="volume"
        :style="{ '--range-progress': volume * 100 + '%' }"
        @pointerdown="
          ($event.target as HTMLElement).setPointerCapture($event.pointerId);
          emit('dragging', true);
        "
        @pointerup="emit('dragging', false)"
        @pointercancel="emit('dragging', false)"
        @blur="emit('dragging', false)"
        @input="setVolume" /></span
    ><AppSelect
      v-if="!mini && !r.live"
      class="rate-control"
      label="房间倍速"
      @open-change="emit('menuOpen', $event)"
      :disabled="!r.can('set_rate') || !r.connected"
      :model-value="r.state?.playback_rate ?? 1"
      :options="
        [0.5, 1, 1.5, 2].map((value) => ({ value, label: value + '×' }))
      "
      @change="r.send('SET_RATE', { rate: $event })"
    /><slot /><button
      v-if="!mini"
      class="icon-button"
      :aria-label="fullscreen ? '退出仅视频全屏' : '仅视频全屏'"
      :title="fullscreen ? '退出仅视频全屏' : '仅视频全屏'"
      @click="emit('fullscreen')"
    >
      <AppIcon :name="fullscreen ? 'minimize' : 'maximize'" />
    </button>
  </div>
</template>
