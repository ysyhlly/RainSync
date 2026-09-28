<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount, watch } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
const props=defineProps<{active:boolean}>();
const r = useRoomRuntime();
const emit = defineEmits<{ openChange: [value: boolean] }>();
const panel = ref<HTMLElement>(),
  details = ref<HTMLDetailsElement>();
watch(()=>props.active,value=>{if(!value&&details.value)details.value.open=false});
function escape(event:KeyboardEvent){if(event.key==="Escape"&&details.value?.open){event.preventDefault();event.stopPropagation();details.value.open=false;details.value.querySelector("summary")?.focus()}}
async function toggle() {
  const open = !!details.value?.open;
  emit("openChange", open);
  await nextTick();
  const p = panel.value;
  if (!p) return;
  if (open) {
    if (p.showPopover && !p.matches(":popover-open")) p.showPopover();
    place();
  } else if (p.hidePopover && p.matches(":popover-open")) p.hidePopover();
}
function place() {
  const p = panel.value,
    d = details.value;
  if (!p || !d?.open) return;
  const r = d.getBoundingClientRect(),
    top = document.fullscreenElement ? 12 : 72;
  const width = Math.min(480, innerWidth - 24);
  p.style.width = width + "px";
  p.style.left = Math.max(12, Math.min(r.left, innerWidth - width - 12)) + "px";
  p.style.top =
    Math.max(
      top,
      Math.min(r.top - p.offsetHeight - 4, innerHeight - p.offsetHeight - 12),
    ) + "px";
}
function outside(e: PointerEvent) {
  if (details.value?.open && !details.value.contains(e.target as Node))
    details.value.open = false;
}
document.addEventListener("pointerdown", outside);
window.addEventListener("resize", place);
window.addEventListener("scroll", place, true);
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", place, true);
});
</script>
<template>
  <details @keydown="escape" ref="details" @toggle="toggle" class="playback-options">
    <summary>播放选项</summary>
    <div ref="panel" popover="manual" class="settings-panel">
      <p class="helper">更改播放方式后点击重新加载。</p>
      <div class="option-fields">
        <label
          >播放方式<AppSelect
            v-model="r.mode"
            label="播放方式"
            :options="[
              { value: 'auto', label: '自动适配' },
              { value: 'direct', label: '直接播放' },
              { value: 'remux', label: '转封装' },
              { value: 'transcode', label: '兼容转码' },
            ]" /></label
        ><button :disabled="!r.state?.media_id" @click="r.run(r.loadMedia)">
          <AppIcon name="refresh" />重新加载</button
        ><label v-if="r.tracks.length > 1"
          >音轨<AppSelect
            :model-value="r.audioIndex ?? null"
            label="音轨"
            :options="
              r.tracks.map((track) => ({
                value: track.index,
                label: track.label + ' · ' + track.language,
              }))
            "
            @update:model-value="r.audioIndex = $event as number"
            @change="r.run(r.loadMedia)" /></label
        ><label v-if="r.subtitles.length"
          >字幕<AppSelect
            :model-value="r.subtitleIndex ?? null"
            label="字幕"
            :options="[
              { value: null, label: '关闭' },
              ...r.subtitles.map((track) => ({
                value: track.index,
                label: track.label + ' · ' + track.language,
              })),
            ]"
            @update:model-value="
              r.subtitleIndex = $event === null ? undefined : ($event as number)
            "
            @change="r.applySubtitles"
        /></label>
      </div>
    </div>
  </details>
</template>
