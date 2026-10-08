<script setup lang="ts">
import { computed, ref, useId } from "vue";
import {
  IconArrowsMove,
  IconArrowsDiagonal2,
  IconAdjustmentsHorizontal,
  IconArrowUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconMinus,
  IconPlus,
  IconX,
} from "@tabler/icons-vue";
import { WIDGET_DEFINITIONS, type LayoutItem } from "./layout-model";

const props = withDefaults(
  defineProps<{
    item: LayoutItem;
    editing: boolean;
    selected?: boolean;
    dragging?: boolean;
    narrow?: boolean;
  }>(),
  { selected: false, dragging: false, narrow: false },
);
const emit = defineEmits<{
  select: [id: string];
  gesture: [
    payload: { id: string; mode: "move" | "resize"; event: PointerEvent },
  ];
  step: [
    payload: { id: string; mode: "move" | "resize"; dx: number; dy: number },
  ];
  remove: [id: string];
}>();
const root = ref<HTMLElement>();
const definition = computed(() => WIDGET_DEFINITIONS[props.item.type]);
const titleId = useId();
const helpId = useId();
const controlsId = useId();
const plain = computed(() =>
  ["player", "room-info", "media-info"].includes(props.item.type),
);
const widthOnly = computed(() => props.item.type === "player");

function start(mode: "move" | "resize", event: PointerEvent) {
  emit("gesture", { id: props.item.id, mode, event });
}
function step(mode: "move" | "resize", dx: number, dy: number) {
  emit("step", { id: props.item.id, mode, dx, dy });
}
function key(mode: "move" | "resize", event: KeyboardEvent) {
  if (!props.editing || event.ctrlKey || event.metaKey || event.altKey) return;
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  const scale = event.shiftKey ? 5 : 1;
  if (mode === "resize" && widthOnly.value) {
    if (!props.narrow) step(mode, (direction[0] || direction[1]) * scale, 0);
  } else if (!props.narrow || direction[0] === 0) {
    step(mode, direction[0] * scale, direction[1] * scale);
  }
}
function focus() {
  root.value?.focus({ preventScroll: true });
}
defineExpose({ focus, element: root });
</script>

<template>
  <section
    ref="root"
    class="room-widget room-widget-frame"
    :class="{
      'room-widget--plain': plain,
      'room-widget--selected': selected,
      'room-widget--dragging': dragging,
      'is-selected': selected,
      'is-dragging': dragging,
    }"
    :data-widget-type="item.type"
    :data-widget-id="item.id"
    :data-layout-x="item.x"
    :data-layout-y="item.y"
    :data-layout-w="item.w"
    :data-layout-h="item.h"
    :aria-label="definition.label"
    tabindex="-1"
  >
    <header
      v-show="editing || !plain"
      class="room-widget__header room-widget-header"
      :class="{ 'room-widget__header--overlay': plain }"
    >
      <button
        v-if="editing"
        type="button"
        class="room-widget__drag-handle room-widget-drag-handle icon-button"
        :aria-label="`移动${definition.label}`"
        :aria-describedby="helpId"
        @pointerdown="start('move', $event)"
        @keydown="key('move', $event)"
        @click="emit('select', item.id)"
      >
        <IconArrowsMove :size="18" aria-hidden="true" />
      </button>
      <h2 :id="titleId" class="room-widget__title room-widget-title">
        {{ definition.label }}
      </h2>
      <div v-if="editing" class="room-widget__actions room-widget-actions">
        <button
          type="button"
          class="icon-button"
          :aria-label="`调整${definition.label}位置和大小`"
          :aria-expanded="selected"
          :aria-controls="controlsId"
          @click="emit('select', item.id)"
        >
          <IconAdjustmentsHorizontal :size="18" aria-hidden="true" />
        </button>
        <button
          v-if="definition.removable"
          type="button"
          class="icon-button"
          :aria-label="`隐藏${definition.label}`"
          @click="emit('remove', item.id)"
        >
          <IconX :size="18" aria-hidden="true" />
        </button>
      </div>
    </header>
    <p v-if="editing" :id="helpId" class="sr-only">
      {{
        narrow
          ? "使用上、下方向键调整顺序。"
          : "使用方向键移动，每次一步；按住 Shift 每次五步。"
      }}
      拖动时按 Escape 取消。本次编辑可用顶部取消全部还原。
    </p>
    <div class="room-widget__body room-widget-content"><slot /></div>
    <div
      v-if="editing && selected"
      :id="controlsId"
      class="room-widget__position-tools room-layout-position-tools"
      :aria-label="`${definition.label}布局调整`"
      role="group"
    >
      <p class="helper">{{ narrow ? "调整顺序" : "移动组件" }}</p>
      <div class="room-widget__step-actions">
        <button
          v-if="!narrow"
          type="button"
          aria-label="左移"
          @click="step('move', -1, 0)"
        >
          <IconArrowLeft :size="18" aria-hidden="true" />
        </button>
        <button type="button" aria-label="上移" @click="step('move', 0, -1)">
          <IconArrowUp :size="18" aria-hidden="true" />
        </button>
        <button type="button" aria-label="下移" @click="step('move', 0, 1)">
          <IconArrowDown :size="18" aria-hidden="true" />
        </button>
        <button
          v-if="!narrow"
          type="button"
          aria-label="右移"
          @click="step('move', 1, 0)"
        >
          <IconArrowRight :size="18" aria-hidden="true" />
        </button>
      </div>
      <template v-if="!narrow">
        <p class="helper">
          {{ widthOnly ? "画面宽度（保持比例）" : "组件宽度" }}
        </p>
        <div class="room-widget__step-actions">
          <button
            type="button"
            aria-label="减少宽度"
            @click="step('resize', -1, 0)"
          >
            <IconMinus :size="18" aria-hidden="true" />宽度
          </button>
          <button
            type="button"
            aria-label="增加宽度"
            @click="step('resize', 1, 0)"
          >
            <IconPlus :size="18" aria-hidden="true" />宽度
          </button>
        </div>
      </template>
      <template v-if="!widthOnly">
        <p class="helper">组件高度</p>
        <div class="room-widget__step-actions">
          <button
            type="button"
            aria-label="减少高度"
            @click="step('resize', 0, -1)"
          >
            <IconMinus :size="18" aria-hidden="true" />高度
          </button>
          <button
            type="button"
            aria-label="增加高度"
            @click="step('resize', 0, 1)"
          >
            <IconPlus :size="18" aria-hidden="true" />高度
          </button>
        </div>
      </template>
      <p v-if="widthOnly" class="helper">
        播放器保留在布局中；画面始终保持比例
      </p>
      <button type="button" @click="emit('select', item.id)">收起调整</button>
    </div>
    <button
      v-if="editing && !(narrow && widthOnly)"
      type="button"
      class="room-widget__resize-handle room-widget-resize-handle icon-button"
      :aria-label="`调整${definition.label}大小`"
      :title="
        widthOnly
          ? '拖动调整宽度，画面保持比例'
          : '拖动调整大小，也可使用方向键'
      "
      @pointerdown="start('resize', $event)"
      @keydown="key('resize', $event)"
      @click="emit('select', item.id)"
    >
      <IconArrowsDiagonal2 :size="19" aria-hidden="true" />
    </button>
  </section>
</template>
