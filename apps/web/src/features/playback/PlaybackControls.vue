<script setup lang="ts">
import { ref } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import { formatTime } from "../../shared/use-action";
defineProps<{ mini?: boolean }>();
const r = useRoomRuntime(),
  volume = ref(1),
  muted = ref(false);
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
  <div class="playback-controls" :class="{ compact: mini }">
    <button
      class="icon-button control-play"
      :aria-label="r.state?.playback_status === 'playing' ? '暂停' : '播放'"
      :disabled="!r.owner || !r.connected || !r.state?.media_id"
      @click="r.send(r.state?.playback_status === 'playing' ? 'PAUSE' : 'PLAY')"
    >
      <AppIcon
        :name="r.state?.playback_status === 'playing' ? 'pause' : 'play'"
      /></button
    ><span class="playback-time"
      >{{ formatTime(r.position) }} / {{ formatTime(r.duration) }}</span
    ><input
      class="seek-control"
      aria-label="播放进度"
      type="range"
      min="0"
      :max="Number.isFinite(r.duration) ? r.duration : 0"
      step="0.1"
      :value="r.position"
      :disabled="!r.owner || !r.connected || !r.state?.media_id"
      @pointerdown="drag"
      @input="
        r.dragging = true;
        r.position = Number(($event.target as HTMLInputElement).value);
      "
      @change="r.seek"
      @pointerup="end"
      @pointercancel="end"
      @blur="end"
    /><button
      class="icon-button volume-toggle"
      :aria-label="muted ? '取消静音' : '静音'"
      :aria-pressed="muted"
      @click="mute"
    >
      <AppIcon :name="muted ? 'mute' : 'volume'" /></button
    ><input
      v-if="!mini"
      class="volume-control"
      aria-label="音量"
      type="range"
      min="0"
      max="1"
      step="0.05"
      :value="volume"
      @pointerdown="emit('dragging', true)"
      @pointerup="emit('dragging', false)"
      @pointercancel="emit('dragging', false)"
      @blur="emit('dragging', false)"
      @input="setVolume"
    /><AppSelect
      v-if="!mini"
      class="rate-control"
      label="房间倍速"
      @open-change="emit('menuOpen', $event)"
      :disabled="!r.owner || !r.connected"
      :model-value="r.state?.playback_rate ?? 1"
      :options="
        [0.5, 1, 1.5, 2].map((value) => ({ value, label: value + '×' }))
      "
      @change="r.send('SET_RATE', { rate: $event })"
    /><button
      v-if="!mini"
      class="icon-button"
      aria-label="全屏"
      @click="emit('fullscreen')"
    >
      <AppIcon name="maximize" />
    </button>
  </div>
</template>
