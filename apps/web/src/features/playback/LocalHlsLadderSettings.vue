<script setup lang="ts">
import type {
  LocalHlsLadderCapabilities,
  LocalHlsLadderFacts,
} from "../../../../../packages/protocol";
import AppSelect from "../../shared/ui/AppSelect.vue";
import { validLocalHlsLadderCapabilities } from "./local-hls-ladder-intent";
defineProps<{
  capabilities?: LocalHlsLadderCapabilities;
  facts?: LocalHlsLadderFacts;
  enabled: boolean;
  quality: string;
  selected?: string;
  manual: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  enabledChange: [value: boolean];
  qualityChange: [value: string];
}>();
</script>
<template>
  <fieldset
    v-if="validLocalHlsLadderCapabilities(capabilities)"
    class="ladder-settings"
    :disabled="disabled"
  >
    <legend>本地多清晰度 HLS</legend>
    <label
      ><input
        type="checkbox"
        :checked="enabled"
        :disabled="disabled || !capabilities?.renditions.length"
        @change="
          emit('enabledChange', ($event.target as HTMLInputElement).checked)
        "
      />启用自动清晰度（更改后重新加载）</label
    >
    <label v-if="facts && manual"
      >清晰度<AppSelect
        :model-value="quality"
        :options="[
          { value: 'auto', label: '自动适应带宽' },
          ...facts.renditions.map((r) => ({
            value: r.id,
            label: `${r.height}p · ${r.width}×${r.height}`,
          })),
        ]"
        label="本地 HLS 清晰度"
        @change="
          (value) => {
            if (typeof value === 'string') emit('qualityChange', value);
          }
        "
    /></label>
    <p v-if="facts && selected" class="helper">
      当前播放清晰度：{{
        facts.renditions.find((r) => r.id === selected)?.height
      }}p。手动选择会在已有缓冲播放后生效。
    </p>
    <p v-if="facts && !manual" class="helper">
      浏览器原生 HLS 自动选择清晰度；此播放器无法读取或手动切换原生清晰度。
    </p>
    <p class="helper">
      使用本地软件转码，最多三档且不放大原片。满足高级配方要求时可一起启用 HDR
      色调映射和字幕烧录。Worker 会校验所有清晰度的同步片段后提供播放。
    </p>
    <p v-if="!capabilities?.renditions.length" class="helper">
      当前片源不满足多清晰度方案的要求。
    </p>
  </fieldset>
</template>
<style scoped>
.ladder-settings {
  grid-column: 1/-1;
  display: grid;
  gap: 0.6rem;
  min-width: 0;
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--border, #666);
  border-radius: 0.5rem;
}
</style>
