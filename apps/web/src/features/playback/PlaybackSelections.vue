<script setup lang="ts">
import { computed } from "vue";
import type { MediaTrack } from "../../../../../packages/protocol";
import AppSelect from "../../shared/ui/AppSelect.vue";
import type { SelectValue } from "../../shared/ui/select";
import {
  audioSelectionOptions,
  subtitleSelectionOptions,
  buildPlaybackSelectionParameters,
  describePlaybackQuality,
  PlaybackSelectionError,
  type PlaybackQualityPlan,
} from "./playback-selections";

const props = defineProps<{
  audioTracks: readonly MediaTrack[];
  subtitleTracks: readonly MediaTrack[];
  audioIndex?: number;
  subtitleIndex?: number;
  qualityPlan?: PlaybackQualityPlan;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  audioChange: [value: number | undefined];
  subtitleChange: [value: number | undefined];
}>();
const audioOptions = computed(() => audioSelectionOptions(props.audioTracks));
const subtitleOptions = computed(() =>
  subtitleSelectionOptions(props.subtitleTracks),
);
const quality = computed(() => describePlaybackQuality(props.qualityPlan));
const availability = () => ({
  audio_tracks: [...props.audioTracks],
  subtitle_tracks: [...props.subtitleTracks],
});

function audioChanged(value: SelectValue) {
  if (props.disabled) return;
  // A list can change while its popup is open. Validate against current props.
  try {
    const parameters = buildPlaybackSelectionParameters(
      { audioIndex: value },
      availability(),
    );
    emit("audioChange", parameters.request.audio_index ?? undefined);
  } catch (error) {
    if (!(error instanceof PlaybackSelectionError)) throw error;
    /* A removed or ambiguous track cannot become a new selection. */
  }
}
function subtitleChanged(value: SelectValue) {
  if (props.disabled) return;
  try {
    const parameters = buildPlaybackSelectionParameters(
      { subtitleIndex: value },
      availability(),
    );
    emit("subtitleChange", parameters.subtitleIndex);
  } catch (error) {
    if (!(error instanceof PlaybackSelectionError)) throw error;
    /* Keep the parent selection until it supplies the latest plan. */
  }
}
</script>

<template>
  <div class="playback-selections">
    <label v-if="audioOptions.length">
      音轨<AppSelect
        :model-value="audioIndex ?? null"
        :options="audioOptions"
        :disabled="disabled"
        label="音轨"
        @change="audioChanged"
      />
    </label>
    <p v-else class="helper">当前方案未提供可选音轨。</p>
    <label v-if="subtitleOptions.length">
      字幕<AppSelect
        :model-value="subtitleIndex ?? null"
        :options="subtitleOptions"
        :disabled="disabled"
        label="字幕"
        @change="subtitleChanged"
      />
    </label>
    <p v-else class="helper">当前方案未提供可选字幕。</p>
    <p class="helper playback-quality">
      画质：{{ quality ?? "由当前播放方案确定" }}。清晰度切换仅在当前方案提供可选档位时显示。
    </p>
  </div>
</template>

<style scoped>
.playback-selections {
  display: contents;
}
.playback-quality {
  grid-column: 1 / -1;
}
</style>
