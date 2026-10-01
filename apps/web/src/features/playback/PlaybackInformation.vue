<script setup lang="ts">
import { useRoomRuntime } from "../rooms/room-runtime";
const r = useRoomRuntime();
defineProps<{
  title: string;
  room: string;
  connected: boolean;
  stopped: boolean;
  owner: boolean;
}>();
</script>
<template>
  <header class="playback-information">
    <h1>{{ room }}</h1>
    <h2>{{ title }}</h2>
    <p>
      <span class="connection-status">{{
        connected ? "房间连接正常" : stopped ? "连接已停止" : "正在重连"
      }}</span>
      <span v-if="r.recoveryLabel" aria-hidden="true">
        · {{ r.recoveryLabel }}</span
      >
      · {{ owner ? "你可以控制房间播放。" : "观看者 · 播放由房间控制者同步。" }}
    </p>
  </header>
</template>
