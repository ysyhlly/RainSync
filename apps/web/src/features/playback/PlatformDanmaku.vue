<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import {
  visiblePlatformDanmaku,
  type PlatformDanmakuCue,
} from "./platform-text";
const props = defineProps<{
  cues: readonly PlatformDanmakuCue[];
  enabled: boolean;
  video?: HTMLVideoElement;
}>();
const current = ref(0);
const drawBox = ref<Record<string, string>>({});
let resize: ResizeObserver | undefined;
function measure() {
  const video = props.video;
  if (
    !video ||
    !video.clientWidth ||
    !video.clientHeight ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    drawBox.value = {};
    return;
  }
  const scale = Math.min(
      video.clientWidth / video.videoWidth,
      video.clientHeight / video.videoHeight,
    ),
    width = video.videoWidth * scale,
    height = video.videoHeight * scale;
  drawBox.value = {
    left: `${video.offsetLeft + (video.clientWidth - width) / 2}px`,
    top: `${video.offsetTop + (video.clientHeight - height) / 2}px`,
    width: `${width}px`,
    height: `${height}px`,
    right: "auto",
    bottom: "auto",
  };
}
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const reducedMotion = ref(motionPreference.matches);
function motionChanged(event: MediaQueryListEvent) {
  reducedMotion.value = event.matches;
}
motionPreference.addEventListener("change", motionChanged);
let frame: number | undefined;
function sample() {
  current.value = (props.video?.currentTime ?? 0) * 1000;
  if (
    props.enabled &&
    props.video &&
    !props.video.paused &&
    !props.video.ended &&
    !document.hidden
  )
    frame = requestAnimationFrame(sample);
  else frame = undefined;
}
function refresh() {
  measure();
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  if (props.enabled) sample();
}
watch(
  () => [props.video, props.enabled] as const,
  ([video], previousValue) => {
    const previous = previousValue?.[0];
    resize?.disconnect();
    if (video) {
      resize = new ResizeObserver(measure);
      resize.observe(video);
    }
    for (const name of [
      "loadedmetadata",
      "timeupdate",
      "seeked",
      "play",
      "pause",
      "ended",
    ] as const) {
      previous?.removeEventListener(name, refresh);
      video?.addEventListener(name, refresh);
    }
    refresh();
  },
  { immediate: true },
);
document.addEventListener("visibilitychange", refresh);
onBeforeUnmount(() => {
  resize?.disconnect();
  motionPreference.removeEventListener("change", motionChanged);
  if (frame !== undefined) cancelAnimationFrame(frame);
  for (const name of [
    "loadedmetadata",
    "timeupdate",
    "seeked",
    "play",
    "pause",
    "ended",
  ] as const)
    props.video?.removeEventListener(name, refresh);
  document.removeEventListener("visibilitychange", refresh);
});
const visible = computed(() =>
  props.enabled ? visiblePlatformDanmaku(props.cues, current.value) : [],
);
function position(item: ReturnType<typeof visiblePlatformDanmaku>[number]) {
  const style = item.cue.style
    ? {
        color: `#${item.cue.style.color_rgb.toString(16).padStart(6, "0")}`,
        fontSize: `clamp(12px, ${item.cue.style.font_size_px}px, 6vw)`,
      }
    : {};
  const p = item.cue.position;
  if (p) {
    const elapsed = Math.max(0, current.value - item.cue.at_ms),
      move = reducedMotion.value
        ? 0
        : p.move_duration_ms === 0
          ? elapsed >= p.move_delay_ms
            ? 1
            : 0
          : Math.max(
              0,
              Math.min(1, (elapsed - p.move_delay_ms) / p.move_duration_ms),
            ),
      opacity =
        p.opacity_from_permille +
        (p.opacity_to_permille - p.opacity_from_permille) * item.progress;
    return {
      ...style,
      left: `${(p.x_permyriad + (p.to_x_permyriad - p.x_permyriad) * move) / 100}%`,
      top: `${(p.y_permyriad + (p.to_y_permyriad - p.y_permyriad) * move) / 100}%`,
      opacity: opacity / 1000,
      transform: `rotate(${p.rotation_z_deg}deg)`,
      transformOrigin: "left top",
    };
  }
  if (item.cue.mode === "scroll")
    return {
      ...style,
      top: `${64 + item.lane * 26}px`,
      left: reducedMotion.value ? "50%" : `${100 - item.progress * 140}%`,
      transform: reducedMotion.value
        ? "translateX(-50%)"
        : `translateX(-${item.progress * 100}%)`,
    };
  return item.cue.mode === "top"
    ? {
        ...style,
        top: `${12 + item.lane * 26}px`,
        left: "50%",
        transform: "translateX(-50%)",
      }
    : {
        ...style,
        bottom: `${76 + item.lane * 26}px`,
        left: "50%",
        transform: "translateX(-50%)",
      };
}
</script>
<template>
  <div
    v-if="enabled"
    class="platform-danmaku"
    :style="drawBox"
    aria-hidden="true"
  >
    <span v-for="item in visible" :key="item.key" :style="position(item)">{{
      item.cue.text
    }}</span>
    <small
      v-if="visible.some((item) => item.cue.advanced_unsupported)"
      class="unsupported-style"
      >复杂定位样式暂不支持，已显示纯文字</small
    >
  </div>
</template>
<style scoped>
.platform-danmaku {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  contain: layout paint;
}
.unsupported-style {
  position: absolute;
  bottom: 6px;
  left: 6px;
  color: white;
  background: rgba(0, 0, 0, 0.6);
  padding: 3px;
  font-size: 11px;
  max-width: 90%;
}
.platform-danmaku span {
  position: absolute;
  color: white;
  font: 500 clamp(14px, 2vw, 20px)/1.2 sans-serif;
  white-space: nowrap;
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow:
    -1px -1px 1px #000,
    1px 1px 1px #000;
}
@media (prefers-reduced-motion: reduce) {
  .platform-danmaku span {
    font-size: 16px;
  }
}
</style>
