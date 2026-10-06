<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePlaybackPlacement } from "./playback-placement";
const props = defineProps<{ editing: boolean }>();
const anchor = ref<HTMLElement>();
const placement = usePlaybackPlacement();
onMounted(() => {
  if (placement && anchor.value) {
    placement.anchor.value = anchor.value;
    placement.editing.value = props.editing;
  }
});
watch(
  () => props.editing,
  (editing) => {
    if (placement && placement.anchor.value === anchor.value)
      placement.editing.value = editing;
  },
);
onBeforeUnmount(() => {
  if (placement && placement.anchor.value === anchor.value) {
    placement.anchor.value = null;
    placement.editing.value = false;
  }
});
</script>
<template>
  <div
    ref="anchor"
    class="room-player-anchor"
    data-testid="room-player-anchor"
    aria-hidden="true"
  />
</template>
