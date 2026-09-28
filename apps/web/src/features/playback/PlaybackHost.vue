<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoomRuntime } from "../rooms/room-runtime";
import AppSelect from "../../shared/ui/AppSelect.vue";
import PlaybackControls from "./PlaybackControls.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
defineProps<{ full: boolean }>();
const r = useRoomRuntime(),
  element = ref<HTMLVideoElement>();
onMounted(() => {
  if (element.value) r.attach(element.value);
});
</script>
<template>
  <section
    v-show="!!r.room"
    class="playback-host"
    :class="full ? 'full-player' : 'mini-player'"
    aria-label="房间播放器"
  >
    <header v-show="full" class="watch-title">
      <div>
        <p class="section-label">放映室</p>
        <h1>{{ r.room?.name }}</h1>
      </div>
      <span class="connection-status" role="status">{{
        r.connected ? "已连接" : r.connectionStopped ? "连接已停止" : "正在重连"
      }}</span>
    </header>
    <div class="video-frame">
      <video
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
        v-if="r.waiting && r.state?.media_id"
        class="buffering"
        role="status"
        >正在准备影片…</span
      >
    </div>
    <div class="player-caption">
      <div>
        <h2>{{ r.currentTitle }}</h2>
        <p v-if="!full">{{ r.room?.name }}</p>
        <p v-else class="helper">
          {{
            r.owner ? "你可以控制房间播放。" : "观看者 · 播放由房间控制者同步。"
          }}
        </p>
      </div>
      <RouterLink
        v-if="!full"
        class="button return-room"
        :to="'/rooms/' + r.room?.id"
        >返回房间<AppIcon name="next"
      /></RouterLink>
    </div>
    <PlaybackControls :mini="!full" />
    <details v-show="full" class="playback-options">
      <summary>播放选项</summary>
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
    </details>
  </section>
</template>
