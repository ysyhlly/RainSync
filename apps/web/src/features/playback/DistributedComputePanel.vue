<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from "vue";
import { supportsHlsPlayback } from "./browser-mse";
import AppSelect from "../../shared/ui/AppSelect.vue";
import { useSession } from "../auth/session.store";
import type { DistributedComputePlaybackIntent } from "../../../../../packages/protocol";
import type { PeerStats } from "./room-p2p";
const props = defineProps<{
  roomId: string;
  mediaGeneration: number;
  audioIndex?: number;
  activeJob?: string;
  sharing: boolean;
  stats?: PeerStats;
  activate: (
    intent: DistributedComputePlaybackIntent,
    audioIndex?: number | null,
  ) => Promise<void>;
  original: () => Promise<void>;
  share: (consent: {
    acknowledge_peer_addresses: boolean;
    confirm_current_network: boolean;
    upload_allowed: boolean;
  }) => Promise<void>;
  stopSharing: () => Promise<void>;
}>();
type Job = {
  id: string;
  status: string;
  recipe: string;
  attempt: number;
  output_generation?: string;
  primary_qualified: boolean;
  selected_audio_index: number | null;
  error?: string | null;
};
const session = useSession(),
  jobs = ref<Job[]>([]),
  enabled = ref(false),
  p2pEnabled = ref(false),
  busy = ref(false),
  error = ref(""),
  selected = ref(""),
  recipe = ref("h264_480p_hls_v1"),
  addresses = ref(false),
  network = ref(false),
  upload = ref(false);
const recipeOptions = [
  { value: "h264_480p_hls_v1", label: "480p H.264 转码（默认）" },
  { value: "h264_720p_hls_v1", label: "720p H.264 转码" },
  { value: "h264_1080p_hls_v1", label: "1080p H.264 转码" },
  { value: "h264_2160p_hls_v1", label: "4K H.264 转码（2160p / UHD）" },
  { value: "remux_hls_v1", label: "HLS 转封装（合格 H.264/AAC，最高 1080p）" },
];
const loaded = ref(false);
const sourceProbeReady = ref(false),
  sourceAudioTracks = ref<{ index: number; label: string; language: string }[]>(
    [],
  ),
  audioChoice = ref("current");
const audioOptions = computed(() => [
  { value: "current", label: "当前主播放器音轨 / 首个已探测音轨" },
  ...sourceAudioTracks.value.map((track) => ({
    value: String(track.index),
    label: `${track.label} · ${track.language} · #${track.index}`,
  })),
]);
const jobOptions = computed(() => [
  { value: "", label: "选择产物" },
  ...jobs.value.map((job) => ({
    value: job.id,
    label: `${recipeOptions.find((option) => option.value === job.recipe)?.label ?? job.recipe} · ${job.status} · 第 ${job.attempt} 次 · ${job.id.slice(0, 8)}`,
  })),
]);
const jobErrorMessages = new Map<string, string>([
  [
    "compute_output_budget_insufficient",
    "产物预算不足，任务暂不能执行。请管理员核对当前配额，或改用较低分辨率配方重新生成。",
  ],
  [
    "compute_output_budget_exceeded",
    "实际产物超出节点预算，任务未完成。请选择较低分辨率配方，或由管理员调整配额后重新生成。",
  ],
  [
    "compute_global_budget_exceeded",
    "服务器计算产物空间不足，任务未完成。请管理员检查存储空间与总量限制。",
  ],
  [
    "compute_source_too_large",
    "原片超过计算输入大小限制。请选择符合限制的原片。",
  ],
  [
    "compute_source_duration_unsupported",
    "原片时长未通过计算检查或超过 30 分钟。请重新探测，或选择符合限制的原片。",
  ],
  [
    "node_execution_failed",
    "节点计算失败。请检查计算进程、编码能力与任务限制后重新生成。",
  ],
]);
const selectedJobDiagnostic = computed(() => {
  const job = jobs.value.find((item) => item.id === selected.value);
  if (!job?.error || job.status === "ready") return "";
  return (
    jobErrorMessages.get(job.error) ??
    "计算任务未完成。请检查节点状态与任务限制。"
  );
});
let timer: ReturnType<typeof setTimeout> | undefined,
  alive = true,
  serial = 0;
async function load() {
  if (timer) clearTimeout(timer);
  const version = serial;
  try {
    const reply = await session.api<{
      enabled: boolean;
      p2p_enabled: boolean;
      jobs: Job[];
      source_probe_ready: boolean;
      source_audio_tracks: typeof sourceAudioTracks.value;
    }>(`/rooms/${props.roomId}/compute`);
    if (!alive || version !== serial) return;
    loaded.value = true;
    enabled.value = reply.enabled;
    p2pEnabled.value = reply.p2p_enabled;
    jobs.value = reply.jobs;
    sourceProbeReady.value = reply.source_probe_ready === true;
    sourceAudioTracks.value = Array.isArray(reply.source_audio_tracks)
      ? reply.source_audio_tracks
      : [];
  } catch (e) {
    if (alive && version === serial)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (alive && version === serial)
      timer = setTimeout(() => void load(), 2000);
  }
}
async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const version = serial;
  try {
    await action();
  } catch (e) {
    if (alive && version === serial)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (alive && version === serial) busy.value = false;
  }
}
async function probeSource() {
  if (!enabled.value) throw Error("服务器未开启 NAS 本地计算");
  const version = serial;
  await session.api("/playback-candidates", "POST", {
    room_id: props.roomId,
    media_generation: props.mediaGeneration,
    audio_index: props.audioIndex ?? null,
    position_ms: 0,
  });
  if (!alive || serial !== version) return;
  await load();
  if (!sourceProbeReady.value)
    throw Error("原片音轨尚未完成版本校验，请重新探测或重载原片源");
}
async function prepare() {
  await act(async () => {
    if (!enabled.value) throw Error("服务器未开启 NAS 本地计算");
    const version = serial;
    if (
      !sourceProbeReady.value &&
      audioChoice.value === "current" &&
      props.audioIndex === undefined
    )
      await probeSource();
    if (!alive || serial !== version) return;
    const chosen =
      audioChoice.value === "current"
        ? (props.audioIndex ?? sourceAudioTracks.value[0]?.index ?? null)
        : Number(audioChoice.value);
    const result = await session.api<{ id: string }>(
      `/rooms/${props.roomId}/compute`,
      "POST",
      {
        media_generation: props.mediaGeneration,
        recipe: recipe.value,
        audio_index: chosen,
      },
    );
    if (!alive || serial !== version) return;
    selected.value = result.id;
    await load();
  });
}
async function activateOutput() {
  await act(async () => {
    const job = jobs.value.find(
      (j) =>
        j.id === selected.value && j.status === "ready" && j.primary_qualified,
    );
    if (!job?.output_generation) throw Error("完整产物尚未通过主播放资格校验");
    await props.activate(
      {
        schema_version: 1,
        job_id: job.id,
        output_generation: job.output_generation,
      },
      job.selected_audio_index,
    );
  });
}
async function shareOutput() {
  await act(async () => {
    if (!addresses.value || !network.value || !upload.value)
      throw Error("请先确认当前网络、上传与地址披露");
    await props.share({
      acknowledge_peer_addresses: addresses.value,
      confirm_current_network: network.value,
      upload_allowed: upload.value,
    });
  });
}
watch(
  () => [props.roomId, props.mediaGeneration, session.epoch],
  () => {
    serial++;
    if (timer) clearTimeout(timer);
    selected.value = "";
    jobs.value = [];
    loaded.value = false;
    enabled.value = false;
    p2pEnabled.value = false;
    sourceProbeReady.value = false;
    sourceAudioTracks.value = [];
    audioChoice.value = "current";
    addresses.value = network.value = upload.value = false;
    busy.value = false;
    error.value = "";
    void load();
  },
);
watch(
  () => props.sharing,
  (sharing, previous) => {
    if (previous && !sharing)
      addresses.value = network.value = upload.value = false;
  },
);
onMounted(load);
onBeforeUnmount(() => {
  alive = false;
  serial++;
  if (timer) clearTimeout(timer);
});
</script>
<template>
  <details class="distributed-compute-panel surface-card surface-card--compact">
    <summary>NAS 本地计算与主播放器分片共享</summary>
    <p class="helper">
      NAS
      生成完整产物后，服务器独立校验编码、原片时间轴和音轨。选择合格产物会替换主播放器输入，继续跟随房间播放、暂停、速率与跳转；默认使用
      HTTP。
    </p>
    <p v-if="!loaded && !error" class="helper" role="status">
      正在读取 NAS 计算状态…
    </p>
    <p v-if="loaded && !enabled" class="helper" role="status">
      服务器未开启 NAS 本地计算。选择配方不会开启计算或更改全局播放画质。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <label class="compute-field"
      >计算配方
      <AppSelect
        v-model="recipe"
        :options="recipeOptions"
        label="计算配方"
        :disabled="busy"
    /></label>
    <p class="helper">
      720p、1080p 与 4K（2160p /
      UHD）是输出尺寸上限，保留原片比例，不放大小尺寸原片。生成产物后，仍需手动选择用于房间主播放器。
    </p>
    <p class="helper">
      可选配方不代表节点已具备能力：当前原片或副本所在的已授权节点必须实测并上报相应编码配方。尚未上报的旧节点不能执行
      4K。
    </p>
    <p class="helper">
      执行还受空闲任务槽、产物字节预算、源时长与执行超时限制。默认 1
      个任务槽、64 MiB
      产物上限不会随画质提高；高清长片可能超出预算，需要管理员另行配置。
    </p>
    <label class="compute-field"
      >原片音轨
      <AppSelect
        v-model="audioChoice"
        :options="audioOptions"
        label="原片音轨"
        :disabled="busy"
    /></label>
    <button :disabled="busy || !enabled" @click="act(probeSource)">
      探测并读取原片音轨
    </button>
    <p v-if="!sourceProbeReady" class="helper">
      索引不代表音轨已探测。未选定音轨时会先探测当前原片，再生成；探测失败请重试或重载原片源，不会静默丢弃声音。
    </p>
    <p v-else-if="sourceAudioTracks.length === 0" class="helper">
      已核对当前原片：没有音轨。
    </p>
    <button :disabled="busy || !enabled" @click="prepare">
      按当前原片音轨生成产物
    </button>
    <label class="compute-field"
      >房间内计算产物
      <AppSelect
        v-model="selected"
        :options="jobOptions"
        label="房间内计算产物"
        :disabled="busy"
    /></label>
    <p v-if="selectedJobDiagnostic" class="helper" role="status">
      {{ selectedJobDiagnostic }}
    </p>
    <button
      :disabled="
        busy ||
        !jobs.some(
          (j) =>
            j.id === selected && j.status === 'ready' && j.primary_qualified,
        )
      "
      @click="activateOutput"
    >
      用于房间主播放器
    </button>
    <button v-if="activeJob" :disabled="busy" @click="act(original)">
      主播放器改回原片源
    </button>
    <p v-if="activeJob" class="helper" role="status">
      主播放器使用合格 NAS 产物 {{ activeJob.slice(0, 8) }}，时间轴仍属于原片。
    </p>
    <fieldset v-if="p2pEnabled" :disabled="busy">
      <legend>主播放器 P2P 上传默认关闭</legend>
      <p class="helper">
        仅共享相同房间、相同产物代次的已校验分片。直连可能让参与者获知对方网络地址，已下载的数据无法撤回。未配置
        STUN/TURN；启动、缓冲不足、超时或坏片使用
        HTTP。后台、网络变化、离开或撤销授权会停止共享，重新分享需再次确认。
      </p>
      <label
        ><input
          v-model="addresses"
          type="checkbox"
        />我了解对方可能获知我的网络地址</label
      ><br />
      <label
        ><input
          v-model="network"
          type="checkbox"
        />我确认当前网络允许上传</label
      ><br />
      <label
        ><input v-model="upload" type="checkbox" />允许本次上传，合计上限 2
        Mbps</label
      ><br />
      <button
        :disabled="
          !addresses ||
          !network ||
          !upload ||
          !activeJob ||
          sharing ||
          !supportsHlsPlayback()
        "
        @click="shareOutput"
      >
        启用主播放器分片共享
      </button>
      <button :disabled="!sharing" @click="act(stopSharing)">
        立即退出共享，继续 HTTP 播放
      </button>
      <p v-if="stats" role="status">
        Peer 接收 {{ stats.peerBytes }} B · HTTP {{ stats.httpBytes }} B · 上传
        {{ stats.uploadedBytes }} B · 回退 {{ stats.fallbacks }} 次 · 坏片
        {{ stats.badHashes }} 次 · 重复 {{ stats.duplicateBytes }} B
      </p>
    </fieldset>
  </details>
</template>

<style scoped>
.distributed-compute-panel > :not(summary) {
  margin-top: var(--space-3);
}
.compute-field {
  display: grid;
  gap: var(--space-2);
  max-width: 42rem;
}
</style>
