<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useMediaCatalog } from "./media-catalog.store";
import { useVisiblePreviews } from "./use-visible-previews";
import MediaRenameDialog from "./MediaRenameDialog.vue";
import { useLibrary } from "./library.store";
import { usePendingMedia } from "./pending-media.store";
import { useRoomRuntime } from "../rooms/room-runtime";
import { useSession } from "../auth/session.store";
import { useRouter } from "vue-router";
import AppIcon from "../../shared/ui/AppIcon.vue";
import MediaThumbnail from "./MediaThumbnail.vue";
import PluginMetadata from "../plugins/PluginMetadata.vue";
import Notice from "../../shared/ui/Notice.vue";
import { formatTime } from "../../shared/use-action";
import ScanAllSources from "../admin/ScanAllSources.vue";
const library = useLibrary(),
  runtime = useRoomRuntime(),
  session = useSession(),
  router = useRouter(),
  pendingMedia = usePendingMedia(),
  search = ref(library.requestedQuery);
const queryChanged = computed(
  () =>
    search.value !== library.query || library.requestedQuery !== library.query,
);
const catalog = useMediaCatalog(),
  grid = ref<HTMLElement>(),
  renaming = ref<string | null>(null);
const items = computed(() =>
  library.items.map((item) => catalog.records[item.id] ?? item),
);
const previews = useVisiblePreviews(grid, () =>
  items.value.map((item) => item.id),
);
function refresh() {
  if (!library.busy && !library.error)
    void library.load(library.page, library.query);
}
let debounce: ReturnType<typeof setTimeout> | undefined;
function submit() {
  clearTimeout(debounce);
  void library.load(0, search.value);
}
function input() {
  clearTimeout(debounce);
  debounce = setTimeout(submit, 250);
}
async function choose(id: string) {
  if (!runtime.room) {
    const item = items.value.find((item) => item.id === id);
    if (!item) return;
    pendingMedia.select(item.id, item.title);
    await router.push("/rooms");
    return;
  }
  runtime.choose(id);
  await router.push("/rooms/" + runtime.room.id);
}
onMounted(() => {
  window.addEventListener("focus", refresh);
  // Preserve navigation context, but refresh records changed by source scans.
  refresh();
});
onBeforeUnmount(() => {
  clearTimeout(debounce);
  window.removeEventListener("focus", refresh);
});
</script>
<template>
  <section class="page library-page">
    <div class="page-title">
      <div>
        <p class="section-label">观看区</p>
        <h1>媒体库</h1>
        <p>浏览片源中的影片，在当前房间播放或加入待播。</p>
      </div>
    </div>
    <RouterLink class="button" to="/libraries">我的媒体库与共享授权</RouterLink>
    <ScanAllSources v-if="session.user?.admin" @complete="refresh" />
    <form class="search-form" role="search" @submit.prevent="submit">
      <AppIcon name="search" /><input
        v-model="search"
        aria-label="搜索影片"
        placeholder="搜索影片标题"
        type="search"
        @input="input"
      /><button type="submit">搜索</button>
    </form>
    <Notice :message="library.error" error /><button
      v-if="library.error"
      @click="library.retry()"
    >
      重试本次加载
    </button>
    <p v-if="library.busy" role="status">正在加载影片…</p>
    <p
      v-if="library.loaded && (library.busy || library.error || queryChanged)"
      class="helper"
      role="status"
    >
      仍显示上次成功加载的{{
        library.query ? `“${library.query}”搜索` : "全部影片"
      }}结果， 第 {{ library.page + 1 }} 页。
    </p>
    <div
      v-if="!library.busy && !library.items.length && !library.error"
      class="empty-state"
    >
      <AppIcon name="movie" :size="40" />
      <h2>{{ library.query ? "没有找到匹配影片" : "当前没有可浏览的影片" }}</h2>
      <p>
        {{
          library.query
            ? "换个标题关键词再试。"
            : session.user?.admin
              ? "检查现有片源与扫描结果，确认是否已完成索引。"
              : "可以检查自己可访问的媒体库，或联系管理员确认片源与扫描结果。"
        }}
      </p>
      <RouterLink
        v-if="!library.query && session.user?.admin"
        class="button primary"
        to="/admin/sources"
        >检查片源与扫描结果</RouterLink
      >
      <RouterLink v-else-if="!library.query" class="button" to="/libraries">
        查看我的媒体库
      </RouterLink>
    </div>
    <p v-if="library.items.length && !runtime.room" class="notice">
      选择影片后可继续选择放映室，入房后确认播放。<RouterLink to="/rooms"
        >选择放映室</RouterLink
      >
    </p>
    <p v-else-if="runtime.room && !runtime.can('change_media')" class="helper">
      当前为观看者，选片与待播由控制者操作。
    </p>
    <div ref="grid" class="media-grid">
      <article
        v-for="item in items"
        :data-media-id="item.id"
        :key="item.id"
        class="media-card"
      >
        <MediaThumbnail
          :cover="item.cover"
          :refresh-key="library.refreshKey"
          :stalled="previews.stalled.value.has(item.id)"
          :alt="item.title"
        />
        <h2 :title="item.title">{{ item.title }}</h2>
        <p class="media-meta">
          {{ item.kind }} ·
          {{
            item.duration_ms != null
              ? formatTime(item.duration_ms / 1000)
              : "时长未知"
          }}
        </p>
        <PluginMetadata :media-id="item.id" :refresh-key="library.refreshKey" />
        <div class="media-actions">
          <button
            :aria-label="'重命名 ' + item.title"
            @click="renaming = item.id"
          >
            重命名</button
          ><button
            v-if="
              item.cover?.status === 'unavailable' ||
              previews.stalled.value.has(item.id)
            "
            @click="previews.retry(item.id)"
          >
            重试预览
          </button>
          <button
            :disabled="
              !!runtime.room &&
              (!runtime.can('change_media') || !runtime.connected)
            "
            :aria-label="'播放 ' + item.title"
            @click="choose(item.id)"
          >
            <AppIcon name="play" />{{
              runtime.room ? "播放" : "选择房间"
            }}</button
          ><button
            class="icon-button"
            :aria-label="'加入待播 ' + item.title"
            :disabled="
              !runtime.room || !runtime.can('queue') || !runtime.connected
            "
            @click="runtime.run(() => runtime.addQueue(item.id))"
          >
            <AppIcon name="plus" />
          </button>
        </div>
      </article>
    </div>
    <nav
      v-if="library.items.length || library.page"
      class="pagination"
      aria-label="影片分页"
    >
      <button
        :disabled="library.busy || queryChanged || library.page === 0"
        @click="library.load(library.page - 1)"
      >
        <AppIcon name="back" />上一页</button
      ><span
        >第 {{ library.page + 1 }} 页 · 本页 {{ library.items.length }} 部</span
      ><button
        :disabled="library.busy || queryChanged || !library.hasMore"
        @click="library.load(library.page + 1)"
      >
        下一页<AppIcon name="next" />
      </button>
    </nav>
    <MediaRenameDialog :media-id="renaming" @close="renaming = null" />
  </section>
</template>
