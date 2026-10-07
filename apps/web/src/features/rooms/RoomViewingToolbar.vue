<script setup lang="ts">
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconLayoutSidebarRight,
  IconLayoutSidebarRightCollapse,
  IconWindowMaximize,
} from "@tabler/icons-vue";
defineProps<{
  mode: "normal" | "webpage" | "browser";
  chatVisible: boolean;
  pending: boolean;
  editing: boolean;
  title: string;
}>();
const emit = defineEmits<{ webpage: []; browser: []; chat: [] }>();
</script>
<template>
  <div class="room-viewing-toolbar" aria-label="观看模式">
    <div class="room-viewing-toolbar__title">
      <strong>{{ mode === "normal" ? "观看模式" : title }}</strong>
      <span>{{
        mode === "browser"
          ? "浏览器全屏"
          : mode === "webpage"
            ? "网页全屏"
            : "可保留聊天侧栏"
      }}</span>
    </div>
    <div class="room-viewing-toolbar__actions">
      <button
        type="button"
        :disabled="editing || pending"
        :aria-pressed="mode === 'webpage'"
        :title="
          editing
            ? '请先完成或取消布局编辑'
            : '铺满当前浏览器窗口，保留浏览器标签栏'
        "
        data-testid="room-webpage-fullscreen"
        @click="emit('webpage')"
      >
        <IconWindowMaximize :size="18" aria-hidden="true" />
        {{
          mode === "browser"
            ? "切换网页全屏"
            : mode === "webpage"
              ? "退出网页全屏"
              : "网页全屏"
        }}
      </button>
      <button
        type="button"
        :disabled="editing || pending"
        :aria-pressed="mode === 'browser'"
        :aria-busy="pending"
        :title="
          editing ? '请先完成或取消布局编辑' : '使用浏览器全屏，可按 Esc 退出'
        "
        data-testid="room-browser-fullscreen"
        @click="emit('browser')"
      >
        <component
          :is="mode === 'browser' ? IconArrowsMinimize : IconArrowsMaximize"
          :size="18"
          aria-hidden="true"
        />
        {{ mode === "browser" ? "退出浏览器全屏" : "浏览器全屏" }}
      </button>
      <button
        v-if="mode !== 'normal'"
        type="button"
        :aria-pressed="chatVisible"
        aria-controls="room-chat"
        data-testid="room-toggle-chat"
        @click="emit('chat')"
      >
        <component
          :is="
            chatVisible
              ? IconLayoutSidebarRightCollapse
              : IconLayoutSidebarRight
          "
          :size="18"
          aria-hidden="true"
        />
        {{ chatVisible ? "隐藏聊天" : "显示聊天" }}
      </button>
      <slot />
    </div>
  </div>
</template>
