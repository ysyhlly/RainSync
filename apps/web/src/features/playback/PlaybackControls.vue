<script setup lang="ts">
import { ref } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
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
async function fullscreen() {
  const host = r.video?.closest(".playback-host");
  if (!host) return;
  if (document.fullscreenElement) await document.exitFullscreen();
  else await host.requestFullscreen();
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
      @pointerdown="r.dragging = true"
      @input="
        r.dragging = true;
        r.position = Number(($event.target as HTMLInputElement).value);
      "
      @change="r.seek"
      @pointerup="r.dragging = false"
      @pointercancel="r.dragging = false"
      @blur="r.dragging = false"
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
      @input="setVolume"
    /><select
      v-if="!mini"
      class="rate-control"
      aria-label="房间倍速"
      :disabled="!r.owner || !r.connected"
      :value="r.state?.playback_rate ?? 1"
      @change="
        r.send('SET_RATE', {
          rate: Number(($event.target as HTMLSelectElement).value),
        })
      "
    >
      <option :value="0.5">0.5×</option>
      <option :value="1">1×</option>
      <option :value="1.5">1.5×</option>
      <option :value="2">2×</option></select
    ><button
      v-if="!mini"
      class="icon-button"
      aria-label="全屏"
      @click="r.run(fullscreen)"
    >
      <AppIcon name="maximize" />
    </button>
  </div>
</template>
