<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from "vue";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "./room-runtime";
import { createLibraryState } from "../library/library.store";
import { useMediaCatalog } from "../library/media-catalog.store";
import LibraryHierarchy from "../library/LibraryHierarchy.vue";
import { libraryPageSummary } from "../library/library-summary";
import { mediaEpisodeLabel } from "../library/media-label";
import { prewarmNativeDash } from "../playback/dash-prewarm";
import MediaThumbnail from "../library/MediaThumbnail.vue";
import QueueFeedback from "./QueueFeedback.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
import { formatTime } from "../../shared/use-action";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();
const session = useSession(),
  runtime = useRoomRuntime(),
  catalog = useMediaCatalog();
// This is deliberately not useLibrary(): visiting the picker cannot reset the
// independent library page's directory, query, pagination or in-flight read.
const browser = reactive(createLibraryState());
const search = ref("");
const pickerDialog = ref<InstanceType<typeof AppDialog>>();
const allowed = computed(
  () =>
    !!session.user &&
    !session.user.guest &&
    !!runtime.room &&
    runtime.roomActive &&
    (runtime.can("change_media") || runtime.can("queue")),
);
const visible = computed(() => props.modelValue && allowed.value);
const items = computed(() =>
  browser.items.map((item) => catalog.records[item.id] ?? item),
);
function prewarmItem(id: string) {
  if (!visible.value || !runtime.connected || !runtime.can("change_media"))
    return;
  void prewarmNativeDash(
    items.value.find((item) => item.id === id),
    runtime.playbackRoom.nativePlaybackMode,
  );
}
const queryChanged = computed(
  () =>
    search.value !== browser.query ||
    browser.requestedQuery !== browser.query ||
    browser.requestedMode !== browser.mode ||
    browser.requestedNode !== browser.node,
);
let debounce: ReturnType<typeof setTimeout> | undefined;
function submit() {
  clearTimeout(debounce);
  if (!visible.value) return;
  if (search.value.trim()) void browser.load(0, search.value);
  else void browser.browse();
}
function input() {
  clearTimeout(debounce);
  debounce = setTimeout(submit, 250);
}
function navigate(node: string | null) {
  clearTimeout(debounce);
  if (!visible.value) return;
  search.value = "";
  void browser.browse(node);
}
function clearSearch() {
  search.value = "";
  submit();
}
function close() {
  emit("update:modelValue", false);
}
function resetBrowser() {
  clearTimeout(debounce);
  search.value = "";
  browser.reset();
}
let dialogContext = 0;
watch(
  visible,
  (open) => {
    ++dialogContext;
    resetBrowser();
    if (open) void browser.browse(null);
  },
  { immediate: true, flush: "sync" },
);

type Receipt = { message: string; error?: boolean };
const playReceipts = ref<Record<string, Receipt>>({}),
  queueErrors = ref<Record<string, string>>({});
const pendingPlay = ref("");
let context = 0;
let playTimer: ReturnType<typeof setTimeout> | undefined;
let playDialogContext: number | undefined;
function finishPlay(id: string, receipt: Receipt) {
  clearTimeout(playTimer);
  playReceipts.value[id] = receipt;
  pendingPlay.value = "";
  const confirmedHere =
    !receipt.error && visible.value && playDialogContext === dialogContext;
  playDialogContext = undefined;
  if (confirmedHere) close();
}
function invalidate() {
  ++context;
  clearTimeout(playTimer);
  pendingPlay.value = "";
  playReceipts.value = {};
  queueErrors.value = {};
  resetBrowser();
  close();
}
// A new account, room or grant must not keep the old catalog or action receipts.
watch(
  [
    () => session.epoch,
    () => session.user?.guest,
    () => session.user?.admin,
    () => runtime.room?.id,
    () => runtime.room?.owner_id,
    () => runtime.state?.controller_user_id,
    () => runtime.can("change_media"),
    () => runtime.can("queue"),
  ],
  invalidate,
  { flush: "sync" },
);
watch(
  () => runtime.state?.media_id,
  (id) => {
    if (id && id === pendingPlay.value)
      finishPlay(id, { message: "已切换为当前影片" });
  },
  { flush: "sync" },
);
watch(
  () => runtime.error,
  (error) => {
    if (error && pendingPlay.value)
      finishPlay(pendingPlay.value, {
        message: `播放请求未确认：${error}`,
        error: true,
      });
  },
);
async function play(id: string) {
  if (
    !visible.value ||
    !runtime.connected ||
    !runtime.can("change_media") ||
    pendingPlay.value ||
    runtime.state?.media_id === id ||
    !items.value.some((item) => item.id === id)
  )
    return;
  const stamp = context;
  prewarmItem(id);
  pendingPlay.value = id;
  playDialogContext = dialogContext;
  playReceipts.value[id] = { message: "正在发送播放请求…" };
  try {
    const sent = await runtime.choose(id);
    if (stamp !== context) return;
    if (!sent) {
      finishPlay(id, {
        message: "播放请求未发送，请等待房间连接恢复后再操作",
        error: true,
      });
    } else if (runtime.state?.media_id === id) {
      finishPlay(id, { message: "已切换为当前影片" });
    } else {
      playReceipts.value[id] = { message: "已发送播放请求，等待房间确认…" };
      playTimer = setTimeout(() => {
        if (stamp === context && pendingPlay.value === id)
          finishPlay(id, {
            message: "播放请求尚未确认，请检查当前影片后再操作",
            error: true,
          });
      }, 10000);
    }
  } catch (error) {
    if (stamp === context)
      finishPlay(id, {
        message: error instanceof Error ? error.message : String(error),
        error: true,
      });
  }
}
function queued(id: string) {
  return (
    runtime.playlist.some((item) => item.media_id === id) ||
    (!!runtime.queueReceipt("add", id) && !!runtime.playlistError)
  );
}
async function add(id: string) {
  if (
    !visible.value ||
    !runtime.connected ||
    !runtime.can("queue") ||
    runtime.queuePending("add", id) ||
    queued(id) ||
    !items.value.some((item) => item.id === id)
  )
    return;
  const stamp = context;
  delete queueErrors.value[id];
  try {
    await runtime.addQueue(id);
  } catch (error) {
    if (stamp === context)
      queueErrors.value[id] =
        error instanceof Error ? error.message : String(error);
  }
}
onBeforeUnmount(() => {
  ++context;
  clearTimeout(debounce);
  clearTimeout(playTimer);
});
</script>
<template>
  <AppDialog
    ref="pickerDialog"
    :model-value="visible"
    title="选择影片"
    drawer
    class="room-media-picker"
    @update:model-value="close"
  >
    <template v-if="visible">
      <div class="picker-intro">
        <span class="status-badge">{{ runtime.room?.name }}</span>
        <p class="helper">从可访问的片源中选片，当前播放会继续。</p>
        <p v-if="!runtime.connected" class="notice" role="status">
          房间正在重连，可以继续浏览，连接恢复后可播放或加入待播。
        </p>
        <p v-else-if="!runtime.can('change_media')" class="helper">
          你可以加入待播，当前没有更换影片权限。
        </p>
        <p v-else-if="!runtime.can('queue')" class="helper">
          你可以更换影片，当前没有管理待播权限。
        </p>
      </div>
      <form
        class="search-form picker-search"
        role="search"
        @submit.prevent="submit"
      >
        <AppIcon name="search" />
        <input
          v-model="search"
          type="search"
          aria-label="搜索影片"
          placeholder="跨目录搜索影片标题"
          @input="input"
          @keydown.esc.prevent.stop="pickerDialog?.close()"
        />
        <button type="submit">搜索</button>
      </form>
      <LibraryHierarchy
        v-if="browser.mode === 'browse'"
        :folders="browser.folders"
        :breadcrumbs="browser.breadcrumbs"
        :busy="browser.busy"
        :total-media="browser.loaded ? browser.totalMedia : undefined"
        @navigate="navigate"
      />
      <p v-else class="helper">
        搜索范围：全部可访问片源与目录
        <button class="text-button" @click="clearSearch">返回目录浏览</button>
      </p>
      <div v-if="browser.error" class="picker-load-error">
        <Notice :message="browser.error" error />
        <button :disabled="browser.busy" @click="browser.retry()">
          重试本次加载
        </button>
      </div>
      <p v-if="browser.busy" class="helper" role="status">正在加载影片…</p>
      <p
        v-if="browser.loaded && (browser.busy || browser.error || queryChanged)"
        class="helper"
        role="status"
      >
        仍显示上次成功加载的{{
          browser.query ? `“${browser.query}”搜索` : "目录"
        }}结果，第 {{ browser.page + 1 }} 页。
      </p>
      <div
        v-if="
          browser.loaded &&
          !browser.busy &&
          !browser.error &&
          !browser.entryCount
        "
        class="empty-state surface-card"
      >
        <AppIcon name="movie" :size="28" />
        <h3>
          {{ browser.query ? "没有找到匹配影片" : "当前没有可浏览的影片" }}
        </h3>
        <p class="helper">
          {{
            browser.query
              ? "换个标题关键词再试。"
              : "片源完成索引后，影片会显示在这里。"
          }}
        </p>
        <button v-if="browser.query" @click="clearSearch">清除搜索</button>
      </div>
      <div class="picker-media-list" :aria-busy="browser.busy">
        <article
          v-for="media in items"
          :key="media.id"
          :data-media-id="media.id"
          class="picker-media-row surface-card surface-card--compact"
        >
          <MediaThumbnail
            small
            :cover="media.cover"
            :alt="media.title"
            :refresh-key="browser.refreshKey"
          />
          <div class="picker-media-copy">
            <h3 :title="media.title">{{ media.title }}</h3>
            <p v-if="mediaEpisodeLabel(media)" class="helper">
              {{ mediaEpisodeLabel(media) }}
            </p>
            <p class="helper">
              {{ media.kind }} ·
              {{
                media.duration_ms != null
                  ? formatTime(media.duration_ms / 1000)
                  : "时长未知"
              }}
            </p>
          </div>
          <div class="picker-media-actions">
            <button
              v-if="runtime.can('change_media')"
              class="primary"
              :aria-label="'立即播放 ' + media.title"
              @pointerenter="prewarmItem(media.id)"
              @focus="prewarmItem(media.id)"
              :aria-busy="pendingPlay === media.id"
              :disabled="
                !runtime.connected ||
                !!pendingPlay ||
                runtime.state?.media_id === media.id
              "
              @click="play(media.id)"
            >
              <AppIcon name="play" />{{
                runtime.state?.media_id === media.id
                  ? "当前影片"
                  : pendingPlay === media.id
                    ? "等待确认…"
                    : "立即播放"
              }}
            </button>
            <button
              v-if="runtime.can('queue')"
              :aria-label="'加入待播 ' + media.title"
              :aria-busy="runtime.queuePending('add', media.id)"
              :disabled="
                !runtime.connected ||
                runtime.queuePending('add', media.id) ||
                queued(media.id)
              "
              @click="add(media.id)"
            >
              <AppIcon name="plus" />{{
                queued(media.id)
                  ? "已在待播"
                  : runtime.queuePending("add", media.id)
                    ? "正在加入…"
                    : "加入待播"
              }}
            </button>
          </div>
          <div
            v-if="playReceipts[media.id] || queueErrors[media.id]"
            class="picker-receipts"
          >
            <Notice
              v-if="playReceipts[media.id]"
              :message="playReceipts[media.id].message"
              :error="playReceipts[media.id].error"
            />
            <Notice :message="queueErrors[media.id]" error />
          </div>
          <QueueFeedback :media-id="media.id" class="picker-queue-feedback" />
        </article>
      </div>
      <nav
        v-if="browser.entryCount || browser.page"
        class="pagination"
        aria-label="选片分页"
      >
        <button
          :disabled="browser.busy || queryChanged || browser.page === 0"
          @click="browser.loadPage(browser.page - 1)"
        >
          上一页
        </button>
        <span
          >第 {{ browser.page + 1 }} 页 · 本页
          {{ libraryPageSummary(browser.folders, items.length) }}</span
        >
        <button
          :disabled="browser.busy || queryChanged || !browser.hasMore"
          @click="browser.loadPage(browser.page + 1)"
        >
          下一页
        </button>
      </nav>
      <div class="picker-footer">
        <p v-if="pendingPlay || runtime.queuePendingCount" class="helper">
          已提交的操作会继续完成，关闭不会重复提交。
        </p>
        <button @click="close">返回放映</button>
      </div>
    </template>
  </AppDialog>
</template>
<style scoped>
.room-media-picker.app-dialog.drawer {
  width: min(38rem, 100vw);
}
.room-media-picker :deep(.dialog-body) {
  gap: var(--space-4);
}
.picker-intro,
.picker-media-copy {
  min-width: 0;
}
.picker-intro .status-badge {
  max-width: 100%;
  overflow-wrap: anywhere;
}
.picker-intro .helper {
  margin-top: var(--space-2);
}
.picker-search {
  width: 100%;
  max-width: none;
  margin: 0;
}
.picker-search input {
  min-width: 0;
}
.picker-media-list {
  display: grid;
  gap: var(--space-3);
  overflow-anchor: none;
}
.picker-media-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
}
.picker-media-copy h3 {
  font-size: var(--font-size-base);
  overflow-wrap: anywhere;
}
.picker-media-copy .helper {
  margin-top: var(--space-1);
}
.picker-media-actions {
  grid-column: 1 / -1;
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.picker-media-actions button {
  flex: 1;
}
.picker-receipts,
.picker-queue-feedback {
  grid-column: 1 / -1;
  min-width: 0;
}
.picker-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
}
.picker-footer .helper {
  flex: 1 1 16rem;
}
@media (max-width: 767px) {
  .room-media-picker.app-dialog.drawer {
    width: 100%;
  }
  .picker-media-row {
    grid-template-columns: 84px minmax(0, 1fr);
  }
}
</style>
