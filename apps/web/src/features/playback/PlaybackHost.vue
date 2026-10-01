<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import PlaybackControls from "./PlaybackControls.vue";
import PlaybackInformation from "./PlaybackInformation.vue";
import PlaybackSettings from "./PlaybackSettings.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import { createPlayerChrome } from "./use-player-chrome";
const props = defineProps<{ full: boolean }>();
const r = useRoomRuntime(),
  element = ref<HTMLVideoElement>(),
  host = ref<HTMLElement>(),
  fullscreenError = ref("");
const chrome = createPlayerChrome(matchMedia("(pointer: coarse)").matches);
const { visible, fullscreen, hideCursor } = chrome;
let keyboard = false,
  settingsOpen = false,
  selectOpen = false;
function menu(kind: "settings" | "select", value: boolean) {
  if (kind === "settings") settingsOpen = value;
  else selectOpen = value;
  chrome.setMenuOpen(settingsOpen || selectOpen);
}
function pointer() {
  keyboard = false;
  chrome.setKeyboardFocus(false);
}
function key(event: KeyboardEvent) {
  if (event.key === "Tab" || event.key.startsWith("Arrow")) {
    keyboard = true;
    chrome.activity();
  }
}
function focus() {
  if (keyboard) chrome.setKeyboardFocus(true);
}
function blur(event: FocusEvent) {
  if (!host.value?.contains(event.relatedTarget as Node))
    chrome.setKeyboardFocus(false);
}
function moved(event: PointerEvent) {
  if (event.pointerType !== "touch") chrome.activity();
}
function surface(event: MouseEvent) {
  if (event.target === element.value) chrome.toggleFromSurface();
}
function changed() {
  chrome.setFullscreen(document.fullscreenElement === host.value);
}
function visibility() {
  chrome.setPageHidden(document.hidden);
}
async function toggleFullscreen() {
  fullscreenError.value = "";
  try {
    if (document.fullscreenElement === host.value)
      await document.exitFullscreen();
    else if (document.fullscreenEnabled && host.value?.requestFullscreen)
      await host.value.requestFullscreen();
    else
      fullscreenError.value =
        "此设备不支持标准播放器全屏，请使用浏览器或系统的视频全屏功能。";
  } catch {
    fullscreenError.value = "无法进入全屏，请检查浏览器权限后重试。";
  }
}
watch(
  () => r.dragging,
  (value) => chrome.setDragging(value),
);
watch(
  () => props.full,
  () => {
    chrome.setKeyboardFocus(false);
    chrome.pointerLeave();
  },
);
onMounted(() => {
  if (element.value) r.attach(element.value);
  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("keydown", key, true);
  document.addEventListener("pointerdown", pointer, true);
});
onBeforeUnmount(() => {
  chrome.dispose();
  document.removeEventListener("fullscreenchange", changed);
  document.removeEventListener("visibilitychange", visibility);
  document.removeEventListener("keydown", key, true);
  document.removeEventListener("pointerdown", pointer, true);
});
</script>
<template>
  <section
    ref="host"
    v-show="!!r.room"
    class="playback-host"
    :class="[
      full ? 'full-player' : 'mini-player',
      { 'chrome-visible': visible, 'cursor-hidden': hideCursor },
    ]"
    aria-label="房间播放器"
    @focusin="focus"
    @focusout="blur"
  >
    <div
      class="video-frame"
      :class="{ 'has-media': !!r.state?.media_id }"
      @pointerenter="chrome.pointerEnter"
      @pointerleave="chrome.pointerLeave"
      @pointermove="moved"
    >
      <video
        @click="surface"
        ref="element"
        playsinline
        @waiting="r.waiting = true"
        @canplay="r.waiting = false"
        @playing="r.waiting = false"
      >
        <track
          v-for="track in r.subtitles"
          :key="track.index"
          :data-index="track.index"
          kind="subtitles"
          :src="track.url ?? undefined"
          :srclang="track.language"
          :label="track.label"
        />
      </video>
      <div v-if="!r.state?.media_id" class="player-empty">
        <AppIcon name="movie" :size="40" />
        <p>尚未选择影片</p>
        <RouterLink v-if="full" to="/library">前往媒体库</RouterLink>
      </div>
      <button
        v-if="r.blocked"
        class="primary autoplay"
        @click="r.run(r.enablePlayback)"
      >
        点击加入播放</button
      ><span
        v-if="
          ((full || fullscreen) && r.recoveryLabel) ||
          (!r.recoveryLabel && r.waiting && r.state?.media_id)
        "
        class="buffering"
        role="status"
        >{{ r.recoveryLabel || "正在准备影片…" }}</span
      >

      <PlaybackInformation
        v-if="fullscreen"
        class="fullscreen-information"
        :class="{ 'chrome-shown': visible }"
        :title="r.currentTitle"
        :room="r.room?.name ?? ''"
        :connected="r.connected"
        :stopped="r.connectionStopped"
        :owner="r.owner"
      />
      <div
        class="player-chrome"
        :class="{ 'chrome-shown': visible || !full }"
        @click.stop="chrome.activity"
        @keydown="chrome.activity"
      >
        <PlaybackControls
          :mini="!full && !fullscreen"
          @menu-open="menu('select', $event)"
          @dragging="chrome.setDragging"
          @fullscreen="toggleFullscreen"
        >
          <PlaybackSettings
            :active="full || fullscreen"
            v-show="full || fullscreen"
            @open-change="menu('settings', $event)"
          />
        </PlaybackControls>
      </div>
      <p v-if="fullscreen && r.error" class="fullscreen-error" role="alert">
        {{ r.error }} <button @click="r.error = ''">关闭提示</button>
      </p>
      <p v-if="fullscreenError" class="fullscreen-error" role="alert">
        {{ fullscreenError }}
      </p>
    </div>
    <div v-show="!full && !fullscreen" class="player-caption">
      <div>
        <h2>{{ r.currentTitle }}</h2>
        <p>{{ r.room?.name }}</p>
        <span v-if="!full && !fullscreen && r.recoveryLabel" role="status">{{
          r.recoveryLabel
        }}</span>
      </div>
      <RouterLink class="button return-room" :to="'/rooms/' + r.room?.id"
        >返回房间<AppIcon name="next"
      /></RouterLink>
    </div>
  </section>
</template>
