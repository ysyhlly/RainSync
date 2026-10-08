<template>
  <div class="library-loading" role="status" aria-live="polite">
    <p>正在加载媒体库…</p>
    <div class="library-loading-grid" aria-hidden="true">
      <div v-for="item in 6" :key="item" class="library-loading-card">
        <span class="library-loading-cover" /><span
          class="library-loading-line"
        />
        <span class="library-loading-line short" />
      </div>
    </div>
  </div>
</template>
<style scoped>
.library-loading-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
  gap: var(--space-4);
}
.library-loading-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-panel);
}
.library-loading-cover,
.library-loading-line {
  display: block;
  background: var(--surface-muted, #ffffff0c);
  border-radius: var(--radius-small);
}
.library-loading-cover {
  aspect-ratio: 16 / 9;
}
.library-loading-line {
  height: 0.9rem;
}
.library-loading-line.short {
  width: 65%;
}
</style>
