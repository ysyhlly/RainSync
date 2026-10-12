<script setup lang="ts">
import type { PlaybackInformationView } from "./playback-host-port";
defineProps<{
  information: PlaybackInformationView;
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
      <span v-if="information.recoveryLabel" aria-hidden="true">
        · {{ information.recoveryLabel }}</span
      >
      · {{ owner ? "你可以控制房间播放。" : "观看者 · 播放由房间控制者同步。" }}
    </p>
  </header>
</template>
