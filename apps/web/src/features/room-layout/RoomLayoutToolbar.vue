<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import {
  IconCheck,
  IconLayoutDashboard,
  IconLock,
  IconPlus,
  IconRestore,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconX,
} from "@tabler/icons-vue";
import type { LayoutBreakpoint } from "./layout-model";

const props = withDefaults(
  defineProps<{
    editing: boolean;
    dirty?: boolean;
    canUndo?: boolean;
    canRedo?: boolean;
    error?: string | null;
    breakpoint?: LayoutBreakpoint;
  }>(),
  {
    dirty: false,
    canUndo: false,
    canRedo: false,
    error: null,
    breakpoint: "wide",
  },
);
const editButton = ref<HTMLButtonElement>();
const catalogButton = ref<HTMLButtonElement>();
watch(
  () => props.editing,
  async (editing) => {
    await nextTick();
    (editing ? catalogButton.value : editButton.value)?.focus({
      preventScroll: true,
    });
  },
);
defineEmits<{
  begin: [];
  cancel: [];
  commit: [];
  reset: [];
  undo: [];
  redo: [];
  catalog: [];
}>();
</script>

<template>
  <section
    class="room-layout-toolbar"
    :class="{ 'room-layout-toolbar--editing': editing }"
    aria-label="个人布局"
  >
    <div class="room-layout-toolbar__intro">
      <span class="room-layout-toolbar__title">
        <IconLayoutDashboard v-if="editing" :size="18" aria-hidden="true" />
        <IconLock v-else :size="18" aria-hidden="true" />
        {{ editing ? "编排我的放映室" : "我的放映室" }}
      </span>
      <p class="helper">
        {{
          editing
            ? breakpoint === "narrow"
              ? "窄屏可单独调整顺序；完成后保存在当前浏览器"
              : "拖动把手，或用方向键和调整按钮；只改变自己的布局"
            : "布局保存在当前账号的当前浏览器"
        }}
      </p>
    </div>
    <div class="room-layout-toolbar__actions">
      <template v-if="editing">
        <button ref="catalogButton" type="button" @click="$emit('catalog')">
          <IconPlus :size="18" aria-hidden="true" />添加组件
        </button>
        <button type="button" :disabled="!canUndo" @click="$emit('undo')">
          <IconArrowBackUp :size="18" aria-hidden="true" />撤销
        </button>
        <button type="button" :disabled="!canRedo" @click="$emit('redo')">
          <IconArrowForwardUp :size="18" aria-hidden="true" />重做
        </button>
        <button type="button" @click="$emit('reset')">
          <IconRestore :size="18" aria-hidden="true" />恢复默认
        </button>
        <button type="button" @click="$emit('cancel')">
          <IconX :size="18" aria-hidden="true" />取消
        </button>
        <button type="button" class="primary" @click="$emit('commit')">
          <IconCheck :size="18" aria-hidden="true" />完成
        </button>
      </template>
      <button v-else ref="editButton" type="button" @click="$emit('begin')">
        <IconLayoutDashboard :size="18" aria-hidden="true" />编辑布局
      </button>
    </div>
    <p v-if="error" class="room-layout-toolbar__status error" role="alert">
      {{ error }}
    </p>
    <p
      v-else-if="editing"
      class="room-layout-toolbar__status helper"
      role="status"
    >
      {{
        dirty
          ? "更改尚未保存；取消会恢复进入编辑前的布局"
          : "正在编辑；完成后退出编辑模式"
      }}
    </p>
  </section>
</template>
