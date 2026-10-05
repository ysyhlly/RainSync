<script setup lang="ts">
import { computed } from "vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import type {
  PlatformSubtitleTrack,
  PlatformTextStatus,
} from "./platform-text";
const props = defineProps<{
  tracks: PlatformSubtitleTrack[];
  subtitleId: string | null;
  subtitleStatus: PlatformTextStatus;
  danmakuStatus: PlatformTextStatus;
  danmakuEnabled: boolean;
  error: string;
  live?: boolean;
  liveMode?: "off" | "history" | "realtime";
}>();
const emit = defineEmits<{
  subtitleChange: [id: string | null];
  danmakuChange: [enabled: boolean];
  liveDanmakuChange: [mode: "off" | "history" | "realtime"];
}>();
const options = computed(() => [
  { value: null, label: "关闭字幕" },
  ...props.tracks.map((track) => ({
    value: track.id,
    label: `${track.label} (${track.language})${track.automatic ? " · 自动生成" : ""}`,
  })),
]);
const statuses: Partial<Record<PlatformTextStatus, string>> = {
  loading: "正在获取平台字幕…",
  none: "此影片没有可用的平台字幕",
  login_required: "平台字幕需要自己的已连接账号，请切换平台账号后重新加载",
  unsupported: "此平台暂不支持字幕或原站弹幕",
  failed: "平台字幕获取失败，可重新加载播放后重试",
};
</script>
<template>
  <label
    >{{ live ? "已观察到的直播内嵌字幕" : "平台字幕 / 语言"
    }}<AppSelect
      :model-value="subtitleId"
      label="平台字幕语言"
      :options="options"
      :disabled="subtitleStatus !== 'available'"
      @update:model-value="emit('subtitleChange', $event)"
  /></label>
  <p v-if="!live && statuses[subtitleStatus]" class="helper" role="status">
    {{ statuses[subtitleStatus] }}
  </p>
  <p v-if="live && subtitleStatus !== 'available'" class="helper">
    当前直播源尚未观察到带时间的内嵌字幕；仅在实际接收到 CEA
    字幕时显示可选轨道，不生成或猜测字幕
  </p>
  <label
    v-if="!live && danmakuStatus === 'available'"
    class="platform-danmaku-toggle"
    ><input
      type="checkbox"
      :checked="danmakuEnabled"
      @change="
        emit('danmakuChange', ($event.target as HTMLInputElement).checked)
      "
    />原站弹幕</label
  >
  <p v-if="!live && danmakuStatus === 'available'" class="helper">
    原站弹幕按播放进度获取有限分段；支持受限颜色、字号与归一化定位/透明度/二维移动。复杂路径或透视降为纯文字，不执行脚本或 BAS
  </p>
  <div v-if="live && danmakuStatus === 'available'">
    <label
      >直播原站弹幕<AppSelect
        :model-value="liveMode ?? 'off'"
        label="直播弹幕模式"
        :options="[
          { value: 'off', label: '关闭' },
          { value: 'history', label: '近期文字快照（每 5 秒）' },
          { value: 'realtime', label: '实时文字弹幕（本次播放）' },
        ]"
        @update:model-value="
          emit('liveDanmakuChange', $event as 'off' | 'history' | 'realtime')
        "
    /></label>
    <p class="helper">
      开启实时弹幕会向哔哩哔哩获取临时客户端标识，仅用于本次播放，不保存或跨用户复用。平台拒绝连接时会停止；不会自动切换到快照
    </p>
  </div>
  <p v-if="live && danmakuStatus === 'unsupported'" class="helper">
    此平台直播尚无已核对的原站弹幕接口；不会借用其他平台、账号或猜测消息时间
  </p>
  <p v-if="error" class="helper" role="alert">{{ error }}</p>
</template>
<style scoped>
.platform-danmaku-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
