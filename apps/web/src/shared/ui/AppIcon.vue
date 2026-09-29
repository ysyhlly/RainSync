<script setup lang="ts">
import {
  IconPlayerPlay,
  IconPlayerPause,
  IconVolume,
  IconVolumeOff,
  IconMaximize,
  IconMinimize,
  IconMovie,
  IconDoor,
  IconSearch,
  IconPlus,
  IconX,
  IconArrowLeft,
  IconArrowRight,
  IconSettings,
  IconServer,
  IconKey,
  IconUser,
  IconLogout,
  IconRefresh,
  IconCopy,
  IconTrash,
  IconSend,
  IconChevronDown,
  IconPhoto,
  IconCheck,
  IconAlertCircle,
} from "@tabler/icons-vue";
const icons = {
  play: IconPlayerPlay,
  pause: IconPlayerPause,
  volume: IconVolume,
  mute: IconVolumeOff,
  maximize: IconMaximize,
  minimize: IconMinimize,
  movie: IconMovie,
  rooms: IconDoor,
  search: IconSearch,
  plus: IconPlus,
  close: IconX,
  back: IconArrowLeft,
  next: IconArrowRight,
  settings: IconSettings,
  server: IconServer,
  key: IconKey,
  user: IconUser,
  logout: IconLogout,
  refresh: IconRefresh,
  copy: IconCopy,
  trash: IconTrash,
  send: IconSend,
  down: IconChevronDown,
  photo: IconPhoto,
  check: IconCheck,
  error: IconAlertCircle,
};
defineProps<{ name: keyof typeof icons; size?: number }>();
</script>
<template>
  <component
    :is="icons[name]"
    :size="size ?? 20"
    stroke="1.7"
    aria-hidden="true"
  />
</template>
