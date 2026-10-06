<script setup lang="ts">
import {
  computed,
  ref,
  shallowRef,
  nextTick,
  onMounted,
  onBeforeUnmount,
  watch,
} from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import PlaybackControls from "./PlaybackControls.vue";
import PlatformDanmaku from "./PlatformDanmaku.vue";
import PlaybackInformation from "./PlaybackInformation.vue";
import PlaybackSettings from "./PlaybackSettings.vue";
import PlaybackPreparation from "./PlaybackPreparation.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import { createPlayerChrome } from "./use-player-chrome";
import {
  SubtitleLoadState,
  type SubtitleResource,
} from "./subtitle-load-state";
const props = defineProps<{ full: boolean }>();
const emit = defineEmits<{ miniResize: [height: number] }>();
const r = useRoomRuntime(),
  element = ref<HTMLVideoElement>(),
  host = ref<HTMLElement>(),
  fullscreenError = ref("");
const miniCollapsed = ref(false);
const shortViewport = matchMedia("(max-height: 500px)");
function adaptMini() {
  if (
    !props.full &&
    r.room &&
    r.state &&
    (shortViewport.matches || !r.state.media_id)
  )
    miniCollapsed.value = true;
}
let miniObserver: ResizeObserver | undefined;
function measureMini() {
  emit(
    "miniResize",
    !props.full && !fullscreen.value && r.room
      && !emptyRoom.value
      ? Math.ceil(host.value?.getBoundingClientRect().height ?? 0)
      : 0,
  );
}
const chrome = createPlayerChrome(matchMedia("(pointer: coarse)").matches);
const { visible, fullscreen, hideCursor } = chrome;
const emptyRoom = computed(() =>
  !!r.state && !r.state.media_id && r.connected &&
  !preparationVisible.value && !r.waiting && !r.blocked && !r.error && !r.recoveryLabel,
);
const preparationVisible = computed(
  () =>
    !!r.preparation &&
    r.preparation.phase !== "idle" &&
    !(
      r.preparation.phase === "preparing" && r.recoveryState === "calibrating"
    ) &&
    (r.preparation.phase !== "ready" || r.waiting),
);
watch(
  () => r.preparation?.phase,
  (phase) => {
    if (phase === "failed") miniCollapsed.value = true;
  },
  { immediate: true },
);
watch(
  () => [props.full, fullscreen.value, r.room?.id, r.state?.media_id],
  adaptMini,
  { immediate: true },
);
watch(
  () => [props.full, fullscreen.value, miniCollapsed.value, r.room?.id, emptyRoom.value],
  () => {
    void nextTick().then(measureMini);
  },
);
const subtitleLoads = new SubtitleLoadState(),
  subtitleResources = shallowRef<readonly SubtitleResource[]>([]),
  subtitleFailure = shallowRef<SubtitleResource>();
function updateSubtitleFailure() {
  subtitleFailure.value = subtitleLoads.failure(r.subtitleIndex);
}
watch(
  () => [r.sessionId, r.subtitles] as const,
  () => {
    subtitleResources.value = subtitleLoads.sync(r.sessionId, r.subtitles);
    updateSubtitleFailure();
  },
  { immediate: true, deep: true },
);
watch(() => r.subtitleIndex, updateSubtitleFailure);
function subtitleSettled(resource: SubtitleResource, event: Event) {
  const track = event.currentTarget as HTMLTrackElement | null;
  if (track && subtitleLoads.settle(resource, track.readyState))
    updateSubtitleFailure();
}
async function retrySubtitle() {
  const failure = subtitleFailure.value;
  if (
    !failure ||
    !r.sessionId ||
    !r.state?.media_id ||
    !subtitleLoads.retry(failure)
  )
    return;
  subtitleResources.value = subtitleLoads.resources;
  updateSubtitleFailure();
  await nextTick();
  // Only apply the latest local selection, even if a plan/selection changed
  // while the failed track was being remounted. No playback URL is changed.
  r.applySubtitles();
}
function closeSubtitles() {
  r.subtitleIndex = undefined;
  r.applySubtitles();
}
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
  shortViewport.addEventListener("change", adaptMini);
  if (host.value) {
    miniObserver = new ResizeObserver(measureMini);
    miniObserver.observe(host.value);
    measureMini();
  }
  if (element.value) r.attach(element.value);
  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("keydown", key, true);
  document.addEventListener("pointerdown", pointer, true);
});
onBeforeUnmount(() => {
  shortViewport.removeEventListener("change", adaptMini);
  miniObserver?.disconnect();
  emit("miniResize", 0);
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
      {
        'chrome-visible': visible,
        'cursor-hidden': hideCursor,
        'mini-collapsed': !full && !fullscreen && miniCollapsed,
        'empty-room': emptyRoom,
        'has-room-media': !!r.state?.media_id,
      },
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
          v-for="track in subtitleResources"
          :key="track.key"
          :data-index="track.index"
          kind="subtitles"
          :src="track.url ?? undefined"
          :srclang="track.language"
          :label="track.label"
          @load="subtitleSettled(track, $event)"
          @error="subtitleSettled(track, $event)"
        />
      </video>
      <PlatformDanmaku
        v-if="r.nativePlatform"
        :cues="r.platformDanmakuCues"
        :enabled="r.platformDanmakuEnabled"
        :video="element"
        :can-seek="r.can('seek') && r.connected && !r.live && !!r.state?.media_id"
        @seek="
          (at) => {
            if (
              r.can('seek') &&
              r.connected &&
              !r.live &&
              r.state?.media_id &&
              at < r.duration * 1000
            )
              r.send('SEEK', { position_ms: at });
          }
        "
      />
      <div v-if="!r.state?.media_id" class="player-empty">
        <AppIcon name="movie" :size="40" />
        <p>{{ !r.state ? '正在读取房间内容…' : !r.roomActive ? '房间当前为只读状态' : '尚未选择影片' }}</p>
        <p v-if="full && r.state && r.roomActive" class="helper">
          {{ r.can('change_media') ? '选择一部影片，开始一起观看。' : '等待有控制权限的成员选择影片。' }}
        </p>
        <RouterLink v-if="full && r.can('change_media')" class="button primary" to="/library">从媒体库选片</RouterLink>
      </div>
      <button
        v-if="r.blocked"
        class="primary autoplay"
        @click="r.run(r.enablePlayback)"
      >
        点击加入播放
      </button>
      <PlaybackPreparation
        v-if="(full || fullscreen) && preparationVisible"
        class="preparation-overlay"
        :state="r.preparation"
        :can-retry="r.connected && r.roomActive"
        @cancel="r.run(r.cancelPreparation)"
        @retry="r.run(r.loadMedia)"
      />
      <span
        v-if="
          !preparationVisible &&
          (((full || fullscreen) && r.recoveryLabel) ||
            (!r.recoveryLabel && r.waiting && r.state?.media_id))
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
        :owner="r.can('play') || r.can('pause') || r.can('seek') || r.can('set_rate') || r.can('change_media')"
      />
      <div
        class="player-chrome"
        :class="{ 'chrome-shown': visible || !full }"
        @click.stop="chrome.activity"
        @keydown="chrome.activity"
      >
        <PlaybackControls
          :mini="!full && !fullscreen"
          :fullscreen="fullscreen"
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
      <p
        v-if="fullscreen && r.error && r.preparation?.phase !== 'failed'"
        class="fullscreen-error"
        role="alert"
      >
        {{ r.error }} <button @click="r.error = ''">关闭提示</button>
      </p>
      <p v-if="fullscreenError" class="fullscreen-error" role="alert">
        {{ fullscreenError }}
      </p>
    </div>
    <p v-if="subtitleFailure" class="subtitle-error" role="alert">
      字幕“{{
        subtitleFailure.label.trim() || `字幕 ${subtitleFailure.index}`
      }}”加载失败。
      <span>
        可重试或关闭字幕；若仍失败，{{
          full || fullscreen
            ? "请在播放选项中重新加载。"
            : "请返回房间，在播放选项中重新加载。"
        }}
      </span>
      <button @click="retrySubtitle">重试字幕</button>
      <button @click="closeSubtitles">关闭字幕</button>
    </p>
    <div v-show="!full && !fullscreen" class="player-caption">
      <div>
        <h2>{{ emptyRoom ? r.room?.name : r.currentTitle }}</h2>
        <p v-if="!miniCollapsed && !emptyRoom">{{ r.room?.name }}</p>
        <PlaybackPreparation
          v-if="!full && !fullscreen && preparationVisible"
          compact
          :state="r.preparation"
          :can-retry="r.connected && r.roomActive"
          @cancel="r.run(r.cancelPreparation)"
          @retry="r.run(r.loadMedia)"
        />
        <span
          v-else-if="!full && !fullscreen && (r.recoveryLabel || miniCollapsed || emptyRoom)"
          class="mini-status"
          role="status"
        >{{ emptyRoom ? '尚未选择影片' : r.recoveryLabel || r.room?.name }}</span>
      </div>
      <RouterLink class="button return-room" :to="'/rooms/' + r.room?.id"
        >返回房间<AppIcon name="next"
      /></RouterLink>
    </div>
    <button
      v-if="!full && !fullscreen && !emptyRoom"
      class="icon-button mini-toggle"
      :aria-label="miniCollapsed ? '展开播放器' : '折叠播放器'"
      :aria-expanded="!miniCollapsed"
      @click="miniCollapsed = !miniCollapsed"
    >
      <AppIcon :name="miniCollapsed ? 'maximize' : 'minimize'" />
    </button>
  </section>
</template>

<style scoped>
.subtitle-error {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px;
  background: var(--surface-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
}
.playback-host:fullscreen .subtitle-error {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 80px;
  z-index: 5;
}
</style>
