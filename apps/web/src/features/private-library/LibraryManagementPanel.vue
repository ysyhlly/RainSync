<script setup lang="ts">
import type { Library, LibraryDetail } from "./private-library.api";
import type { LibraryBasicsDraft } from "./use-library-settings";
import AppIcon from "../../shared/ui/AppIcon.vue";
defineProps<{
  enabled: boolean;
  busy: boolean;
  libraries: Library[];
  selected: LibraryDetail | null;
  selectedId: string;
  userId?: string;
}>();
const emit = defineEmits<{
  (event: "create"): void;
  (event: "select", id: string): void;
  (event: "rename"): void;
  (event: "deleteLibrary", id: string, name: string): void;
}>();
const create = () => emit("create");
const select = (id: string) => emit("select", id);
const rename = () => emit("rename");
const requestChange = (_kind: string, id: string, name: string) =>
  emit("deleteLibrary", id, name);
const form = defineModel<LibraryBasicsDraft>("form", { required: true });
</script>
<template>
  <div class="library-management page-stack">
    <form
      v-if="enabled"
      class="surface-card surface-card--compact library-create"
      @submit.prevent="create"
    >
      <div>
        <h2>创建私人库</h2>
        <p class="helper">片源与授权独立管理</p>
      </div>
      <label
        >名称<input
          v-model="form.createName"
          maxlength="100"
          required
          placeholder="例如：家庭影院"
      /></label>
      <button class="primary" :disabled="busy || !form.createName.trim()">
        <AppIcon name="plus" />创建
      </button>
    </form>
    <section
      v-if="libraries.length"
      class="surface-card surface-card--compact library-picker"
    >
      <div class="section-heading">
        <h2>选择媒体库</h2>
        <span class="helper">{{ libraries.length }} 个可访问的媒体库</span>
      </div>
      <nav aria-label="媒体库选择" class="library-tabs segmented-nav">
        <button
          v-for="library in libraries"
          :key="library.id"
          :aria-pressed="selectedId === library.id"
          :disabled="busy"
          @click="select(library.id)"
        >
          <AppIcon name="movie" :size="18" />
          {{ library.name }} ·
          {{ library.visibility === "private" ? "私人" : "实例共享" }}
        </button>
      </nav>
    </section>
    <section v-if="selected" class="surface-card library-summary">
      <div class="section-heading">
        <div class="section-heading__copy">
          <p class="section-label">当前媒体库</p>
          <h2>{{ selected.name }}</h2>
          <p class="helper">权限版本 {{ selected.permission_epoch }}</p>
        </div>
        <div class="button-row">
          <span class="status-badge">{{
            selected.visibility === "private" ? "私人媒体库" : "实例共享"
          }}</span>
          <span
            class="status-badge"
            :class="{
              'status-badge--success': selected.permissions.browse,
            }"
            >{{ selected.permissions.browse ? "可浏览" : "不可浏览" }}</span
          >
          <span
            class="status-badge"
            :class="{
              'status-badge--success': selected.permissions.play,
            }"
            >{{ selected.permissions.play ? "可播放" : "不可播放" }}</span
          >
        </div>
      </div>
      <form
        v-if="selected.permissions.manage"
        class="library-inline-form"
        @submit.prevent="rename()"
      >
        <label
          >媒体库名称<input v-model="form.editName" maxlength="100" required
        /></label>
        <button :disabled="busy">保存名称</button>
      </form>
      <button
        v-if="selected.visibility === 'private' && selected.owner_id === userId"
        class="danger"
        :disabled="busy"
        @click="requestChange('deleteLibrary', selected.id, selected.name)"
      >
        删除媒体库
      </button>
    </section>
  </div>
</template>
