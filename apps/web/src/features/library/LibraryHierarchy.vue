<script setup lang="ts">
import { IconFolder } from "@tabler/icons-vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import type { BrowseFolder, BrowsePage } from "./media.api";
defineProps<{
  folders: BrowseFolder[];
  breadcrumbs: BrowsePage["breadcrumbs"];
  busy?: boolean;
  totalMedia?: number;
}>();
defineEmits<{ navigate: [node: string | null] }>();
</script>
<template>
  <div class="library-hierarchy">
    <div class="hierarchy-heading">
      <nav class="library-breadcrumbs" aria-label="媒体库目录">
        <template
          v-for="(crumb, index) in breadcrumbs"
          :key="crumb.id ?? 'root'"
        >
          <AppIcon v-if="index" name="next" :size="14" />
          <button
            class="text-button"
            :disabled="busy || index === breadcrumbs.length - 1"
            :aria-current="
              index === breadcrumbs.length - 1 ? 'page' : undefined
            "
            @click="$emit('navigate', crumb.id)"
          >
            {{ crumb.name }}
          </button>
        </template>
      </nav>
      <p
        v-if="totalMedia !== undefined"
        class="helper hierarchy-count"
        title="包含当前目录与所有子目录中可浏览的影片"
      >
        共 {{ totalMedia }} 部影片
      </p>
    </div>
    <div v-if="folders.length" class="folder-grid">
      <button
        v-for="folder in folders"
        :key="folder.id"
        class="folder-card surface-card surface-card--compact"
        :disabled="busy"
        :aria-label="`打开${folder.type === 'source' ? '片源' : '目录'} ${folder.name}`"
        @click="$emit('navigate', folder.id)"
      >
        <AppIcon v-if="folder.type === 'source'" name="server" :size="26" />
        <IconFolder v-else :size="26" stroke="1.7" aria-hidden="true" />
        <span class="folder-copy"
          ><strong>{{ folder.name }}</strong
          ><span class="helper"
            >{{ folder.type === "source" ? "片源" : "目录" }} ·
            {{ folder.media_count }} 部影片</span
          ></span
        >
        <AppIcon name="next" :size="18" />
      </button>
    </div>
  </div>
</template>
<style scoped>
.library-hierarchy {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
}
.hierarchy-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1) var(--space-4);
  min-width: 0;
}
.hierarchy-count {
  flex: 0 0 auto;
}
.library-breadcrumbs {
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.library-breadcrumbs button {
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
}
.library-breadcrumbs [aria-current="page"] {
  color: var(--text-primary);
  opacity: 1;
}
.folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
  gap: var(--space-3);
}
.folder-card {
  width: 100%;
  min-height: 5.5rem;
  display: flex;
  gap: var(--space-3);
  align-items: center;
  text-align: left;
}
.folder-card > svg {
  flex-shrink: 0;
}
.folder-copy {
  display: grid;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
}
.folder-copy strong {
  overflow-wrap: anywhere;
}
</style>
