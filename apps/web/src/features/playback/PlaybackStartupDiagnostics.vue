<script setup lang="ts">
import type { PlaybackMetricsSnapshot } from "./playback-metrics";
defineProps<{ diagnostics?: PlaybackMetricsSnapshot }>();
function elapsed(value: number | undefined) {
  return value != null && Number.isFinite(value) && value >= 0
    ? `${(value / 1000).toFixed(1)} 秒`
    : "尚未确认";
}
</script>
<template>
  <details class="startup-diagnostics">
    <summary>播放耗时</summary>
    <template v-if="diagnostics">
      <dl>
        <dt>准备资源与播放器</dt>
        <dd>{{ elapsed(diagnostics.startup_phases.preparation_ms) }}</dd>
        <dt>加载音视频与首帧</dt>
        <dd>{{ elapsed(diagnostics.startup_phases.loading_ms) }}</dd>
        <dt>首帧信号</dt>
        <dd>{{ elapsed(diagnostics.first_frame?.elapsed_ms) }}</dd>
      </dl>
      <p
        v-if="diagnostics.first_frame?.evidence === 'video_frame_callback'"
        class="helper"
      >
        浏览器帧回调：视频帧已提交合成；此数值不是实测屏幕显示时间。
      </p>
      <p
        v-else-if="diagnostics.first_frame?.evidence === 'playing_time_advance'"
        class="helper"
      >
        播放进度推进估计：根据开始播放后的媒体时间推进确认，是近似观测。
      </p>
      <p v-else class="helper">
        尚未收到首帧信号；播放器就绪或可播放事件不代表画面已经显示。
      </p>
      <p v-if="diagnostics.startup_phases.unobserved_ms > 0" class="helper">
        其中
        {{ elapsed(diagnostics.startup_phases.unobserved_ms) }} 未能连续测量。
      </p>
      <p class="helper">
        本机每 5
        秒更新观测。首帧信号从本次播放意图开始计时；暂停和后台时间可能不计入准备、加载分项。
      </p>
    </template>
    <p v-else class="helper">暂无本地耗时观测；开始播放后等待首次采样。</p>
  </details>
</template>
<style scoped>
.startup-diagnostics {
  margin-top: 8px;
}
.startup-diagnostics summary {
  cursor: pointer;
}
.startup-diagnostics dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  margin: 8px 0;
}
.startup-diagnostics dd {
  margin: 0;
}
.startup-diagnostics p {
  margin: 6px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
