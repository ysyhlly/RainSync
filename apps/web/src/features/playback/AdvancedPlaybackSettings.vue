<script setup lang="ts">
import { computed } from "vue";
import type {
  AdvancedPlaybackCapabilities,
  AdvancedPlaybackFacts,
} from "../../../../../packages/protocol";
import AppSelect from "../../shared/ui/AppSelect.vue";
import type { SelectValue } from "../../shared/ui/select";
import { validAdvancedPlaybackCapabilities } from "./advanced-playback-intent";

const props = defineProps<{
  capabilities?: AdvancedPlaybackCapabilities;
  facts?: AdvancedPlaybackFacts;
  toneMapHdr: boolean;
  subtitleStreamIndex?: number;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  toneMapChange: [value: boolean];
  subtitleChange: [value: number | undefined];
}>();
const caps = computed(() =>
  validAdvancedPlaybackCapabilities(props.capabilities)
    ? props.capabilities
    : undefined,
);
const options = computed(() => [
  { value: null, label: "不烧录字幕" },
  ...(caps.value?.subtitle_streams ?? []).map((track) => ({
    value: track.index,
    label: `${track.label} · ${track.language} · ${track.codec.toUpperCase()}（烧录）`,
  })),
]);
function toneChanged(event: Event) {
  if (props.disabled || !caps.value?.tone_map_hdr) return;
  const checked = (event.target as HTMLInputElement).checked;
  if (!checked && props.subtitleStreamIndex !== undefined)
    emit("subtitleChange", undefined);
  emit("toneMapChange", checked);
}
function subtitleChanged(value: SelectValue) {
  if (props.disabled) return;
  if (value === null) {
    emit("subtitleChange", undefined);
    return;
  }
  if (
    typeof value !== "number" ||
    !caps.value?.subtitle_streams.some((track) => track.index === value)
  )
    return;
  if (caps.value.tone_map_hdr) emit("toneMapChange", true);
  emit("subtitleChange", value);
}
const recipeDescription = computed(() => {
  const request = props.facts?.request;
  if (!request) return;
  return [
    request.tone_map_hdr ? "HDR 转 SDR" : undefined,
    request.subtitle_stream_index !== null
      ? `${props.facts?.subtitle_codec?.toUpperCase() ?? ""} 字幕烧录`
      : undefined,
  ]
    .filter(Boolean)
    .join("，");
});
</script>

<template>
  <fieldset v-if="caps" class="advanced-playback-settings" :disabled="disabled">
    <legend>高级播放</legend>
    <p v-if="caps.dolby_vision" class="helper">
      Dolby Vision 优先保留原生输出。设备不支持时自动转为
      SDR；勾选下方选项也可使用 SDR 播放。
    </p>
    <label v-if="caps.tone_map_hdr" class="advanced-tone-map">
      <input type="checkbox" :checked="toneMapHdr" @change="toneChanged" />
      HDR 转 SDR（色调映射）
    </label>
    <label v-if="caps.subtitle_streams.length">
      字幕烧录<AppSelect
        :model-value="subtitleStreamIndex ?? null"
        :options="options"
        :disabled="disabled"
        label="关联字幕烧录"
        @change="subtitleChanged"
      />
    </label>
    <p
      v-if="!caps.tone_map_hdr && !caps.subtitle_streams.length"
      class="helper"
    >
      当前片源未提供可用的 HDR 色调映射或 ASS/SSA/PGS 烧录选项。
    </p>
    <p v-else class="helper">
      更改后重新加载。普通高级方案使用最高 720p
      H.264，多档方案使用已显示的各档目标；烧录字幕成为画面的一部分，关闭或切换需重新准备播放。
      本地可使用已关联的外部字幕和字体；HTTP/NAS
      当前支持片源内嵌字幕，并先作有界缓存。片源资格已检查，Worker
      会再次核对实际 FFmpeg 能力。硬件编码由部署配置选择，无法从浏览器强制启用。
    </p>
    <p v-if="recipeDescription" class="helper">
      当前方案编码目标：{{ recipeDescription }}。编码结果仍由 Worker 校验。
    </p>
  </fieldset>
</template>

<style scoped>
.advanced-playback-settings {
  grid-column: 1 / -1;
  display: grid;
  gap: 0.6rem;
  min-width: 0;
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--border, #666);
  border-radius: 0.5rem;
}
.advanced-tone-map {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
