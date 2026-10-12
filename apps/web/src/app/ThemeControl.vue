<script setup lang="ts">
import {
  themePreference,
  setThemePreference,
  type ThemePreference,
} from "./theme";
</script>
<template>
  <label class="theme-control"
    ><span class="sr-only">界面主题</span
    ><select
      aria-label="界面主题"
      :value="themePreference"
      @change="
        setThemePreference(
          ($event.target as HTMLSelectElement).value as ThemePreference,
        )
      "
    >
      <option value="system">跟随系统</option>
      <option value="light">浅色主题</option>
      <option value="dark">深色主题</option>
    </select></label
  >
</template>
<style scoped>
.theme-control {
  min-width: 0;
}
.theme-control select {
  width: auto;
  max-width: 100%;
  font-size: var(--font-size-sm);
  padding-inline: 8px;
  min-height: 36px;
}
</style>
