<script setup lang="ts">
import { ref } from "vue";
import LibraryBrowser from "../library/LibraryBrowser.vue";
import QueueFeedback from "../rooms/QueueFeedback.vue";
import type { Media } from "../../shared/api/types";
import type { LibraryDetail } from "./private-library.api";
import type { LibrarySharingDraft } from "./use-library-settings";
import type { LibraryRuntime } from "./library-workflow";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
defineProps<{
  selected: LibraryDetail;
  busy: boolean;
  media: Media[];
  mediaBusy: boolean;
  mediaError: string;
  hasMore: boolean;
  canQueue: boolean;
  runtime: LibraryRuntime;
}>();
const emit = defineEmits<{
  (event: "load", next: boolean): void;
  (event: "choose", id: string): void;
}>();
const loadMedia = (next: boolean) => emit("load", next);
const choose = (id: string) => emit("choose", id);
const libraryBrowser = ref<InstanceType<typeof LibraryBrowser>>();
async function refresh() {
  await libraryBrowser.value?.refresh();
}
defineExpose({ refresh });
const form = defineModel<{ search: string; appliedQuery: string }>("form", {
  required: true,
});
const shareForm = defineModel<LibrarySharingDraft>("shareForm", {
  required: true,
});
</script>
<template>
  <section
    v-if="selected.permissions.browse"
    class="surface-card page-stack library-media"
  >
    <div class="section-heading">
      <div class="section-heading__copy">
        <h2>库内影片</h2>
        <p class="helper">
          已加载 {{ media.length }} 部影片{{ hasMore ? "，可继续加载" : "" }}
        </p>
      </div>
      <span v-if="runtime.room" class="status-badge"
        >当前房间 · {{ runtime.room.name }}</span
      >
    </div>
    <form
      class="library-inline-form"
      role="search"
      @submit.prevent="loadMedia(false)"
    >
      <label
        ><span class="sr-only">搜索当前库</span
        ><input
          v-model="form.search"
          type="search"
          placeholder="搜索当前库的影片标题"
      /></label>
      <button :disabled="mediaBusy"><AppIcon name="search" />搜索</button>
    </form>
    <div v-if="mediaError">
      <Notice :message="mediaError" error />
      <button :disabled="mediaBusy" @click="loadMedia(false)">
        重新加载影片
      </button>
    </div>
    <LibraryBrowser
      v-if="!form.appliedQuery"
      :key="selected.id"
      ref="libraryBrowser"
      :library-id="selected.id"
    >
      <template #actions="{ media: item }">
        <button
          v-if="selected.permissions.share_to_room"
          :aria-pressed="shareForm.shareMedia === item.id"
          :disabled="busy"
          @click="shareForm.shareMedia = item.id"
        >
          {{ shareForm.shareMedia === item.id ? "已选择分享" : "选择分享" }}
        </button>
        <button
          :disabled="busy || !canQueue || runtime.queuePending('add', item.id)"
          :aria-busy="runtime.queuePending('add', item.id)"
          @click="choose(item.id)"
        >
          <AppIcon name="plus" />加入当前房间待播
        </button>
        <QueueFeedback :media-id="item.id" />
      </template>
    </LibraryBrowser>
    <p
      v-if="mediaBusy && form.appliedQuery"
      class="loading-state loading-state--inline"
      role="status"
    >
      正在加载当前库的影片…
    </p>
    <p
      v-if="media.length && (form.search !== form.appliedQuery || mediaError)"
      class="helper"
      role="status"
    >
      仍显示{{
        form.appliedQuery ? `“${form.appliedQuery}”搜索` : "全部影片"
      }}的已加载结果。 输入新关键词后点击搜索；加载更多沿用当前结果的查询。
    </p>
    <div
      v-if="form.appliedQuery && !mediaBusy && !mediaError && !media.length"
      class="empty-state empty-state--compact"
    >
      <span class="empty-state__icon"
        ><AppIcon :name="form.appliedQuery ? 'search' : 'movie'" :size="28"
      /></span>
      <h3>
        {{ form.appliedQuery ? "没有找到匹配影片" : "这个媒体库还没有影片" }}
      </h3>
      <p>
        {{
          form.appliedQuery
            ? "换个标题关键词再试，或清除搜索查看全部影片。"
            : selected.permissions.manage
              ? "添加片源并完成扫描后，影片会出现在这里。"
              : "请库管理者确认片源和扫描结果。"
        }}
      </p>
      <button
        v-if="form.appliedQuery"
        @click="
          form.search = '';
          loadMedia(false);
        "
      >
        清除搜索
      </button>
    </div>
    <p v-if="media.length && !runtime.room" class="helper">
      先进入放映室，再将影片加入待播或分享到房间。<RouterLink to="/rooms"
        >选择放映室</RouterLink
      >
    </p>
    <ul
      v-if="form.appliedQuery"
      class="private-media-list data-list"
      :aria-busy="mediaBusy"
    >
      <li v-for="item in media" :key="item.id" class="data-row">
        <div class="data-row__body">
          <strong>{{ item.title }}</strong>
          <p class="helper">{{ item.kind }}</p>
          <QueueFeedback :media-id="item.id" />
        </div>
        <div class="data-row__actions">
          <button
            v-if="selected.permissions.share_to_room"
            :aria-pressed="shareForm.shareMedia === item.id"
            :disabled="busy"
            @click="shareForm.shareMedia = item.id"
          >
            {{ shareForm.shareMedia === item.id ? "已选择分享" : "选择分享" }}
          </button>
          <button
            :disabled="
              busy || !canQueue || runtime.queuePending('add', item.id)
            "
            :aria-busy="runtime.queuePending('add', item.id)"
            @click="choose(item.id)"
          >
            <AppIcon name="plus" />加入当前房间待播
          </button>
        </div>
      </li>
    </ul>
    <button
      v-if="hasMore && form.appliedQuery"
      :disabled="mediaBusy"
      @click="loadMedia(true)"
    >
      加载更多
    </button>
  </section>
</template>
