<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { createLibraryState } from "./library.store";
import { useMediaCatalog } from "./media-catalog.store";
import { useVisiblePreviews } from "./use-visible-previews";
import LibraryHierarchy from "./LibraryHierarchy.vue";
import LibraryLoading from "./LibraryLoading.vue";
import { libraryPageSummary } from "./library-summary";
import { mediaEpisodeLabel } from "./media-label";
import MediaThumbnail from "./MediaThumbnail.vue";
import Notice from "../../shared/ui/Notice.vue";
import { formatTime } from "../../shared/use-action";
const props = defineProps<{ libraryId?: string }>();
const browser = reactive(createLibraryState(() => props.libraryId));
const catalog = useMediaCatalog(),
  grid = ref<HTMLElement>();
const items = computed(() =>
  browser.items.map((item) => catalog.records[item.id] ?? item),
);
const previews = useVisiblePreviews(grid, () =>
  items.value.map((item) => item.id),
);
onMounted(() => void browser.browse());
watch(
  () => props.libraryId,
  () => void browser.browse(),
);
defineExpose({ refresh: browser.refresh });
</script>
<template>
  <section
    class="page-stack library-browser"
    :class="{ 'library-browser--scoped': libraryId }"
    aria-label="按目录浏览媒体"
    :aria-busy="browser.busy"
  >
    <LibraryHierarchy
      :folders="browser.folders"
      :breadcrumbs="browser.breadcrumbs"
      :busy="browser.busy"
      :total-media="browser.loaded ? browser.totalMedia : undefined"
      @navigate="browser.browse($event)"
    />
    <LibraryLoading v-if="!browser.loaded && !browser.error" />
    <p v-else-if="browser.busy" role="status">正在加载目录…</p>
    <Notice v-if="browser.error" :message="browser.error" error />
    <button
      v-if="browser.error"
      :disabled="browser.busy"
      @click="browser.retry()"
    >
      重试本次加载
    </button>
    <p v-if="browser.loaded && (browser.busy || browser.error)" class="helper">
      仍显示上次成功加载的目录
    </p>
    <div
      v-if="
        browser.loaded && !browser.busy && !browser.error && !browser.entryCount
      "
      class="empty-state"
    >
      当前没有可浏览的影片
    </div>
    <div ref="grid" class="media-grid">
      <article
        v-for="media in items"
        :key="media.id"
        :data-media-id="media.id"
        class="media-card surface-card surface-card--compact"
      >
        <MediaThumbnail
          :small="!!libraryId"
          :cover="media.cover"
          :alt="media.title"
          :refresh-key="browser.refreshKey"
          :stalled="previews.stalled.value.has(media.id)"
        />
        <div class="browser-media-copy">
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
        <div class="browser-media-actions">
          <slot name="actions" :media="media" />
        </div>
      </article>
    </div>
    <nav
      v-if="browser.entryCount || browser.page"
      class="pagination"
      aria-label="目录分页"
    >
      <button
        :disabled="browser.busy || browser.page === 0"
        @click="browser.loadPage(browser.page - 1)"
      >
        上一页
      </button>
      <span
        >第 {{ browser.page + 1 }} 页 · 本页
        {{ libraryPageSummary(browser.folders, items.length) }}</span
      >
      <button
        :disabled="browser.busy || !browser.hasMore"
        @click="browser.loadPage(browser.page + 1)"
      >
        下一页
      </button>
    </nav>
  </section>
</template>

<style scoped>
.browser-media-copy {
  min-width: 0;
}
.browser-media-copy h3 {
  overflow-wrap: anywhere;
}
.browser-media-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.library-browser--scoped .media-grid {
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
}
.library-browser--scoped .media-card {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3);
}
.library-browser--scoped .browser-media-actions {
  grid-column: 1 / -1;
}
@media (min-width: 1100px) {
  .library-browser {
    gap: var(--space-3);
  }
  .library-browser--scoped .media-card {
    grid-template-columns: 84px minmax(0, 1fr) auto;
  }
  .library-browser--scoped .browser-media-actions {
    grid-column: auto;
    justify-content: flex-end;
    max-width: 22rem;
  }
}
</style>
