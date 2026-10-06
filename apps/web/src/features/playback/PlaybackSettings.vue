<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount, watch } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import AppSelect from "../../shared/ui/AppSelect.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import PlaybackSelections from "./PlaybackSelections.vue";
import PlatformTextSettings from "./PlatformTextSettings.vue";
import LocalHlsLadderSettings from "./LocalHlsLadderSettings.vue";
import NativeHlsLadderSettings from "./NativeHlsLadderSettings.vue";
import AdvancedPlaybackSettings from "./AdvancedPlaybackSettings.vue";
const props = defineProps<{ active: boolean }>();
const r = useRoomRuntime();
const emit = defineEmits<{ openChange: [value: boolean] }>();
const panel = ref<HTMLElement>(),
  details = ref<HTMLDetailsElement>();
function audioChanged(value: number | undefined) {
  r.audioIndex = value;
  r.run(r.loadMedia);
}
function subtitleChanged(value: number | undefined) {
  r.subtitleIndex = value;
  r.applySubtitles();
}
watch(
  () => props.active,
  (value) => {
    if (!value && details.value) details.value.open = false;
  },
);
function escape(event: KeyboardEvent) {
  if (event.key === "Escape" && details.value?.open) {
    event.preventDefault();
    event.stopPropagation();
    details.value.open = false;
    details.value.querySelector("summary")?.focus();
  }
}
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
  const frame = d.closest(".video-frame")?.getBoundingClientRect();
  const left = Math.max(12, (frame?.left ?? 0) + 12);
  const right = Math.min(innerWidth - 12, (frame?.right ?? innerWidth) - 12);
  const width = Math.min(480, right - left);
  p.style.width = width + "px";
  p.style.left =
    Math.max(left, Math.min(r.right - width, right - width)) + "px";
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
  <details
    @keydown="escape"
    ref="details"
    @toggle="toggle"
    class="playback-options"
  >
    <summary
      role="button"
      aria-label="播放选项"
      title="播放选项"
      class="settings-trigger"
    >
      <AppIcon name="settings" /><span class="sr-only">播放选项</span>
    </summary>
    <div ref="panel" popover="manual" class="settings-panel">
      <p class="helper">
        {{
          r.live
            ? "直播同步播放/暂停控制；恢复播放会回到直播边缘，不保证逐帧对齐。"
            : r.nativePlatform
              ? "平台链接由服务端解析，使用本地视频时钟同步。"
              : "更改播放方式后点击重新加载。"
        }}
      </p>
      <p v-if="r.playbackSummary" class="helper">
        当前方式：{{ r.playbackSummary.mode
        }}<span v-if="r.playbackSummary.reason">
          · {{ r.playbackSummary.reason }}</span
        >
      </p>
      <div class="option-fields">
        <p v-if="r.upstreamMeasuredOutput" class="helper">
          上游同会话抽样输出：{{ r.upstreamMeasuredOutput.video.codec }}
          {{ r.upstreamMeasuredOutput.video.profile }}，
          {{ r.upstreamMeasuredOutput.video.width }}×{{ r.upstreamMeasuredOutput.video.height }}
          <template v-if="r.upstreamMeasuredOutput.audio">，音频 {{ r.upstreamMeasuredOutput.audio.sample_rate }} Hz</template>。
          仅验证本次有限样本，不代表整部影片
          <span v-if="r.upstreamMeasuredMatchesRequested === false">；观察值与请求参数存在差异</span>
        </p>
        <label v-if="r.nativePlatform"
          >平台播放方式<AppSelect
            v-model="r.nativePlaybackMode"
            label="平台播放方式"
            :options="[
              { value: 'auto', label: '自动适配浏览器' },
              { value: 'native', label: '原生播放' },
              { value: 'compatibility', label: '兼容转码（HLS）' },
              { value: 'adaptive', label: '服务端自适应码率（HLS）' },
            ]"
        /></label>
        <p v-if="r.nativePlatform && !r.live" class="helper">
          更改方式后重新加载。兼容转码仅适用于已获授权的有限、无 DRM 媒体，需要
          HLS 支持和服务器工作进程；失败后保留所选方式。
        </p>
        <NativeHlsLadderSettings
          v-if="r.nativePlatform && !r.live && ['compatibility', 'adaptive'].includes(r.nativePlaybackMode)"
          :enabled="r.nativePlaybackMode === 'adaptive'"
          :compatibility="true"
          :renditions="r.nativeLadderRenditions"
          :quality="r.ladderQuality"
          :selected="r.ladderSelected"
          :manual="r.ladderManual"
          :disabled="!r.state?.media_id"
          @enabled-change="r.nativePlaybackMode = $event ? 'adaptive' : 'compatibility'"
          @quality-change="r.selectLadderQuality"
        />
        <label v-if="r.nativePlatform && r.nativeQualityOptions.length"
          >清晰度<AppSelect
            :model-value="r.nativeQualityMaxHeight"
            label="清晰度"
            :options="[
              { value: 'auto', label: '自动选择兼容清晰度' },
              ...r.nativeQualityOptions.map((option) => ({
                value: option.max_height,
                label: `${option.height}p`,
              })),
            ]"
            @update:model-value="
              (value) => r.run(() => r.selectNativeQuality(value))
            "
        /></label>
        <p
          v-if="r.nativePlatform && r.nativeQualitySelectedHeight"
          class="helper"
        >
          {{ r.nativeEncodedHeight || r.nativeLadderRenditions ? "平台源清晰度" : "当前清晰度" }}：{{
            r.nativeQualitySelectedHeight
          }}p。手动选择设置分辨率上限，实际以平台返回的兼容视频为准。
        </p>
        <p v-if="r.nativePlatform && r.nativeEncodedHeight" class="helper">
          已验证转码输出：{{ r.nativeEncodedHeight }}p
          AVC/AAC。源清晰度与编码输出分别显示。
        </p>
        <label v-if="!r.nativePlatform"
          >播放方式<AppSelect
            v-model="r.mode"
            label="播放方式"
            :options="[
              { value: 'auto', label: '自动适配' },
              { value: 'direct', label: '直接播放' },
              { value: 'remux', label: '转封装' },
              { value: 'transcode', label: '兼容转码' },
              { value: 'finite_hls', label: '有限 HLS 时间线转码' },
            ]"
        /></label>
        <p v-if="!r.nativePlatform && r.mode === 'finite_hls'" class="helper">
          仅用于已登记的 HTTP 有限、无 DRM HLS。单一 AVC/AAC 片源或选定的主列表，
          最多 300 秒、64 段、128 MiB，先验证实际帧时钟再转码；可证明的时间戳重置会归一化，
          变化初始化、直播、多音轨及无法连续映射的音频会拒绝。选择后点击重新加载。
          不能同时启用高级处理、多档、分布式产物或回退。
        </p>
        <label v-if="r.nativePlatform"
          >平台账号<AppSelect
            v-model="r.nativeCredentialMode"
            label="平台账号"
            :options="[
              { value: 'own_or_anonymous', label: '自己的账号或匿名' },
              { value: 'anonymous', label: '仅匿名' },
            ]"
        /></label>
        <p
          v-if="r.nativePlatform && r.nativeProvider === 'bilibili'"
          class="helper"
        >
          可在个人资料中扫码连接自己的 Bilibili
          账号。平台权限、会员及地区限制仍适用。
        </p>
        <p
          v-else-if="
            r.nativePlatform &&
            (r.nativeProvider === 'douyin' || r.nativeProvider === 'tiktok')
          "
          class="helper"
        >
          可在个人资料中导入自己的对应平台会话，抖音与 TikTok 账号不能混用。
          已保存会话尚未验证平台登录；视频权限、会员、年龄和地区限制仍适用。
        </p>
        <p
          v-if="r.nativePlatform && r.nativeProvider === 'youtube'"
          class="helper"
        >
          YouTube 观众会话需由服务器单独启用，并在个人资料中导入自己的会话。
          保存会话不保证登录有效；私人、付费、年龄限制和 DRM 视频仍不受支持。
        </p>
        <button :disabled="!r.state?.media_id" @click="r.run(r.loadMedia)">
          <AppIcon name="refresh" />重新加载
        </button>
        <PlaybackSelections
          v-if="!r.nativePlatform"
          :audio-tracks="r.tracks"
          :subtitle-tracks="r.subtitles"
          :audio-index="r.audioIndex"
          :subtitle-index="r.subtitleIndex"
          :disabled="!r.state?.media_id"
          @audio-change="audioChanged"
          @subtitle-change="subtitleChanged"
        />
        <PlatformTextSettings
          v-if="r.nativePlatform"
          :tracks="r.platformSubtitleTracks"
          :subtitle-id="r.platformSubtitleId"
          :subtitle-status="r.platformSubtitleStatus"
          :danmaku-status="r.platformDanmakuStatus"
          :danmaku-enabled="r.platformDanmakuEnabled"
          :error="r.platformTextError"
          :live="r.live || r.platformTextLive"
          :live-mode="r.platformLiveDanmakuMode"
          @live-danmaku-change="r.setPlatformLiveDanmaku"
          @subtitle-change="r.selectPlatformSubtitle"
          @danmaku-change="r.setPlatformDanmaku"
        />
        <fieldset
          v-if="!r.nativePlatform && r.staticHlsAvailability"
          class="static-hls-settings"
        >
          <legend>静态 HLS 兼容回退</legend>
          <label
            ><input
              type="checkbox"
              v-model="r.staticHlsFallbackEnabled"
              :disabled="
                !r.state?.media_id ||
                !r.staticHlsAvailability.available ||
                r.localHlsLadderEnabled ||
                r.toneMapHdr ||
                r.burnInSubtitleIndex !== undefined ||
                !['auto', 'direct'].includes(r.mode)
              "
            />
            启用有限片源兼容方案（更改后重新加载）</label
          >
          <p class="helper">
            {{
              r.staticHlsAvailabilityText
            }}。父播放发生解码错误后，最多尝试一次服务端兼容转码；不支持直播、DRM
            或任意 HLS。
          </p>
        </fieldset>
        <LocalHlsLadderSettings
          v-if="!r.nativePlatform"
          :capabilities="r.ladderCapabilities"
          :facts="r.ladderFacts"
          :enabled="r.localHlsLadderEnabled"
          :quality="r.ladderQuality"
          :selected="r.ladderSelected"
          :manual="r.ladderManual"
          :disabled="!r.state?.media_id"
          @enabled-change="r.localHlsLadderEnabled = $event"
          @quality-change="r.selectLadderQuality"
        />
        <AdvancedPlaybackSettings
          v-if="!r.nativePlatform"
          :capabilities="r.advancedCapabilities"
          :facts="r.advancedFacts"
          :tone-map-hdr="r.toneMapHdr"
          :subtitle-stream-index="r.burnInSubtitleIndex"
          :disabled="!r.state?.media_id"
          @tone-map-change="r.toneMapHdr = $event"
          @subtitle-change="r.burnInSubtitleIndex = $event"
        />
      </div>
    </div>
  </details>
</template>
