<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useMediaCatalog } from "./media-catalog.store";
import { useVisiblePreviews } from "./use-visible-previews";
import MediaRenameDialog from "./MediaRenameDialog.vue";
import { useLibrary } from "./library.store";
import { useRoomRuntime } from "../rooms/room-runtime";
import { useSession } from "../auth/session.store";
import { useRouter } from "vue-router";
import AppIcon from "../../shared/ui/AppIcon.vue";
import MediaThumbnail from "./MediaThumbnail.vue";
import Notice from "../../shared/ui/Notice.vue";
import { formatTime } from "../../shared/use-action";
const library = useLibrary(),
  runtime = useRoomRuntime(),
  session = useSession(),
  router = useRouter(),
  search = ref(library.query);
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
    await router.push("/rooms");
    return;
  }
  runtime.choose(id);
  await router.push("/rooms/" + runtime.room.id);
}
onMounted(() => {
  window.addEventListener("focus", refresh);
  // Preserve navigation context, but refresh records changed by source scans.
  void library.load(library.page, library.query);
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
      @click="submit"
    >
      重新加载
    </button>
    <p v-if="library.busy" role="status">正在加载影片…</p>
    <div
      v-else-if="!library.items.length && !library.error"
      class="empty-state"
    >
      <AppIcon name="movie" :size="40" />
      <h2>{{ library.query ? "没有找到匹配影片" : "媒体库暂无影片" }}</h2>
      <p>
        {{
          library.query
            ? "换个标题关键词再试。"
            : session.user?.admin
              ? "在片源管理中添加片源并扫描。"
              : "请管理员添加并扫描片源。"
        }}
      </p>
      <RouterLink
        v-if="!library.query && session.user?.admin"
        class="button primary"
        to="/admin/sources"
        >添加片源</RouterLink
      >
    </div>
    <p v-if="library.items.length && !runtime.room" class="notice">
      先选择一个放映室，再播放影片。<RouterLink to="/rooms"
        >选择放映室</RouterLink
      >
    </p>
    <p v-else-if="runtime.room && !runtime.owner" class="helper">
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
            :disabled="!!runtime.room && (!runtime.owner || !runtime.connected)"
            :aria-label="'播放 ' + item.title"
            @click="choose(item.id)"
          >
            <AppIcon name="play" />{{
              runtime.room ? "播放" : "选择房间"
            }}</button
          ><button
            class="icon-button"
            :aria-label="'加入待播 ' + item.title"
            :disabled="!runtime.room || !runtime.owner || !runtime.connected"
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
        :disabled="library.busy || library.page === 0"
        @click="library.load(library.page - 1)"
      >
        <AppIcon name="back" />上一页</button
      ><span
        >第 {{ library.page + 1 }} 页 · 本页 {{ library.items.length }} 部</span
      ><button
        :disabled="library.busy || !library.hasMore"
        @click="library.load(library.page + 1)"
      >
        下一页<AppIcon name="next" />
      </button>
    </nav>
    <MediaRenameDialog :media-id="renaming" @close="renaming = null" />
  </section>
</template>
