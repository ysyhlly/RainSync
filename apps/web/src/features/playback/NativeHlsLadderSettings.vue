<script setup lang="ts">
import type { LocalHlsRendition } from "../../../../../packages/protocol";
import AppSelect from "../../shared/ui/AppSelect.vue";
import { validLocalHlsRenditions } from "./local-hls-ladder-intent";
defineProps<{
  enabled: boolean;
  compatibility: boolean;
  renditions?: readonly LocalHlsRendition[];
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
  <fieldset class="native-ladder-settings" :disabled="disabled">
    <legend>平台兼容 HLS 多清晰度</legend>
    <label
      ><input
        type="checkbox"
        :checked="enabled"
        :disabled="disabled || !compatibility"
        @change="
          emit('enabledChange', ($event.target as HTMLInputElement).checked)
        "
      />生成最多三档自动清晰度（更改后重新加载）</label
    >
    <label v-if="validLocalHlsRenditions(renditions) && manual"
      >输出清晰度<AppSelect
        :model-value="quality"
        :options="[
          { value: 'auto', label: '自动适应带宽' },
          ...renditions!.map((r) => ({
            value: r.id,
            label: `${r.height}p · ${r.width}×${r.height}`,
          })),
        ]"
        label="平台兼容 HLS 输出清晰度"
        @change="
          (value) => {
            if (typeof value === 'string') emit('qualityChange', value);
          }
        "
    /></label>
    <p v-if="validLocalHlsRenditions(renditions) && selected" class="helper">
      当前播放输出：{{
        renditions!.find((r) => r.id === selected)?.height
      }}p。手动选择会在已有缓冲播放后生效。
    </p>
    <p
      v-else-if="validLocalHlsRenditions(renditions) && !manual"
      class="helper"
    >
      浏览器原生 HLS 自动选择输出档位，当前播放器无法读取或手动切换实际档位。
    </p>
    <p class="helper">
      需要有限媒体兼容播放。源清晰度决定转码输入；输出各档只在同一尝试的同步片段完成校验后提供，且不会放大原片。
    </p>
  </fieldset>
</template>
<style scoped>
.native-ladder-settings {
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
