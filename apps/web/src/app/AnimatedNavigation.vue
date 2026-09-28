<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { watchNavigation, adminNavigation } from "./navigation";
import { useNavigationIndicator } from "./use-navigation-indicator";
import AppIcon from "../shared/ui/AppIcon.vue";

const props = defineProps<{ variant: "sidebar" | "bottom"; admin: boolean }>();
const route = useRoute();
const container = ref<HTMLElement | null>(null);
const selected = computed(() => {
  const path = route.path.replace(/\/$/, "");
  const watching = watchNavigation.find(
    (item) => path === item.to || path.startsWith(item.to + "/"),
  );
  if (watching) return watching.to;
  if (!props.admin) return null;
  const adminPath =
    path === "/admin/users" ? "/admin/registration-invites" : path;
  const item = adminNavigation.find((item) => item.to === adminPath);
  return item
    ? props.variant === "bottom"
      ? "/admin/sources"
      : item.to
    : null;
});
const { rect, paused } = useNavigationIndicator(container, selected);
const indicatorStyle = computed(() =>
  rect.value
    ? {
        transform: `translate3d(${rect.value.x}px, ${rect.value.y}px, 0)`,
        width: `${rect.value.width}px`,
        height: `${rect.value.height}px`,
      }
    : undefined,
);
</script>

<template>
  <nav
    ref="container"
    :class="variant === 'sidebar' ? 'sidebar-navigation' : 'bottom-nav'"
    :aria-label="variant === 'sidebar' ? '主导航' : '移动导航'"
  >
    <span
      v-if="rect"
      class="navigation-indicator"
      :class="{ 'motion-paused': paused }"
      :style="indicatorStyle"
      aria-hidden="true"
    >
      <span
        v-if="variant === 'sidebar'"
        class="navigation-glow"
        aria-hidden="true"
      />
    </span>
    <RouterLink
      v-for="item in watchNavigation"
      :key="item.to"
      :to="item.to"
      :aria-current="selected === item.to ? 'page' : undefined"
      ><AppIcon :name="item.icon" />{{ item.label }}</RouterLink
    >
    <div v-if="admin && variant === 'sidebar'" class="navigation-group">
      <p>管理</p>
      <RouterLink
        v-for="item in adminNavigation"
        :key="item.to"
        :to="item.to"
        :aria-current="selected === item.to ? 'page' : undefined"
        ><AppIcon :name="item.icon" />{{ item.label }}</RouterLink
      >
    </div>
    <RouterLink
      v-else-if="admin"
      to="/admin/sources"
      :aria-current="selected === '/admin/sources' ? 'page' : undefined"
      ><AppIcon name="settings" />管理</RouterLink
    >
  </nav>
</template>
