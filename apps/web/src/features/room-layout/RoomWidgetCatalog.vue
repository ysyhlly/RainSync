<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
  type Component,
} from "vue";
import {
  IconDeviceTv,
  IconInfoCircle,
  IconMovie,
  IconMessageCircle,
  IconPlaylist,
  IconUsers,
  IconPlus,
  IconFocus2,
  IconX,
} from "@tabler/icons-vue";
import {
  WIDGET_DEFINITIONS,
  WIDGET_TYPES,
  type LayoutDocument,
  type WidgetType,
} from "./layout-model";

const props = defineProps<{ modelValue: boolean; layout: LayoutDocument }>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  add: [type: WidgetType];
  locate: [id: string];
}>();
const dialog = ref<HTMLDialogElement>();
const titleId = useId();
const descriptionId = useId();
const present = computed(
  () => new Map(props.layout.items.map((item) => [item.type, item.id])),
);
const icons: Record<WidgetType, Component> = {
  player: IconDeviceTv,
  "room-info": IconInfoCircle,
  "media-info": IconMovie,
  chat: IconMessageCircle,
  queue: IconPlaylist,
  members: IconUsers,
};
let previous: HTMLElement | null = null;
let actionClosing = false;
function close(restoreFocus = true) {
  dialog.value?.close();
  if (restoreFocus) previous?.focus({ preventScroll: true });
  previous = null;
  emit("update:modelValue", false);
}
async function choose(type: WidgetType) {
  actionClosing = true;
  close(false);
  await nextTick();
  const id = present.value.get(type);
  if (id) emit("locate", id);
  else emit("add", type);
  actionClosing = false;
}
async function sync() {
  await nextTick();
  if (props.modelValue && !dialog.value?.open) {
    previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.value?.showModal();
  } else if (!props.modelValue && dialog.value?.open) {
    dialog.value.close();
    if (!actionClosing) previous?.focus({ preventScroll: true });
    previous = null;
  }
}
function onCancel(event: Event) {
  event.preventDefault();
  event.stopPropagation();
  close();
}
watch(() => props.modelValue, sync);
onMounted(sync);
onBeforeUnmount(() => {
  dialog.value?.close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog room-widget-catalog"
    :aria-labelledby="titleId"
    :aria-describedby="descriptionId"
    @cancel="onCancel"
  >
    <header>
      <h2 :id="titleId" tabindex="-1">添加组件</h2>
      <button
        type="button"
        class="icon-button"
        aria-label="关闭组件目录"
        @click="close()"
      >
        <IconX :size="20" aria-hidden="true" />
      </button>
    </header>
    <div class="dialog-body">
      <p :id="descriptionId" class="room-widget-catalog__intro helper">
        每种组件只能添加一个。隐藏只改变当前布局，不会删除聊天、影片或成员。
      </p>
      <div class="room-widget-catalog__grid room-widget-catalog-grid">
        <article
          v-for="type in WIDGET_TYPES"
          :key="type"
          class="room-widget-catalog__item room-widget-catalog-item"
          :data-catalog-type="type"
        >
          <div
            class="room-widget-catalog__preview room-widget-catalog-preview"
            :data-preview-type="type"
            aria-hidden="true"
          >
            <component :is="icons[type]" :size="36" stroke="1.5" />
          </div>
          <div class="room-widget-catalog__copy room-widget-catalog-copy">
            <h3>{{ WIDGET_DEFINITIONS[type].label }}</h3>
            <p>{{ WIDGET_DEFINITIONS[type].description }}</p>
            <span v-if="!WIDGET_DEFINITIONS[type].removable" class="helper"
              >必要组件，不能隐藏</span
            >
          </div>
          <button
            type="button"
            :aria-label="`${present.has(type) ? '定位' : '添加'}${WIDGET_DEFINITIONS[type].label}`"
            @click="choose(type)"
          >
            <IconFocus2
              v-if="present.has(type)"
              :size="18"
              aria-hidden="true"
            />
            <IconPlus v-else :size="18" aria-hidden="true" />
            {{ present.has(type) ? "已添加 · 定位" : "添加" }}
          </button>
        </article>
      </div>
    </div>
  </dialog>
</template>
