<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { watchNavigation, adminNavigation } from "./navigation";
import { useNavigationIndicator } from "./use-navigation-indicator";
import AppIcon from "../shared/ui/AppIcon.vue";

const props = defineProps<{
  variant: "sidebar" | "bottom" | "room";
  admin: boolean;
}>();
const route = useRoute();
const container = ref<HTMLElement | null>(null);
// Sample the fade more finely than a screen pixel along the usual sidebar path.
// Every sample shares the same arc-length animation, so the whole tail travels
// at constant speed, including where the rounded path turns a corner.
const beamSamples = Array.from({ length: 96 }, (_, index) => {
  const progress = (index + 0.5) / 96;
  return {
    offset: `${-(index * 18) / 96}px`,
    opacity: progress,
    color: `color-mix(in srgb, var(--navigation-glow-tail) ${(1 - progress) * 100}%, var(--navigation-glow))`,
  };
});
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
    ? props.variant !== "sidebar"
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
    :class="variant === 'bottom' ? 'bottom-nav' : 'sidebar-navigation'"
    :aria-label="variant === 'bottom' ? '移动导航' : '主导航'"
  >
    <span
      v-if="rect"
      class="navigation-indicator"
      :class="{ 'motion-paused': paused }"
      :style="indicatorStyle"
      aria-hidden="true"
    >
      <svg
        v-if="variant === 'sidebar'"
        class="navigation-glow"
        :viewBox="`0 0 ${rect.width} ${rect.height}`"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          v-for="(sample, index) in beamSamples"
          :key="index"
          class="navigation-beam"
          :style="{
            '--beam-offset': sample.offset,
            opacity: sample.opacity,
            color: sample.color,
          }"
          x="1"
          y="1"
          :width="Math.max(0, rect.width - 2)"
          :height="Math.max(0, rect.height - 2)"
          rx="11"
          pathLength="100"
          stroke-dasharray="0.2075 49.7925"
        />
      </svg>
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
