<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick, useId } from "vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps<{
  modelValue: boolean;
  title: string;
  drawer?: boolean;
  busy?: boolean;
  canClose?: () => boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();
const dialog = ref<HTMLDialogElement>(),
  titleId = useId();
let previous: HTMLElement | null = null;
let backdropPointer: number | null = null;
function outside(event: PointerEvent) {
  if (!dialog.value || event.target !== dialog.value) return false;
  const rect = dialog.value.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}
function down(event: PointerEvent) {
  backdropPointer =
    props.drawer && event.isPrimary && event.button === 0 && outside(event)
      ? event.pointerId
      : null;
}
function up(event: PointerEvent) {
  const dismiss = backdropPointer === event.pointerId && outside(event);
  backdropPointer = null;
  if (dismiss) close();
}
function close() {
  if (props.busy || (props.canClose && !props.canClose())) return;
  emit("update:modelValue", false);
}
function trapTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || !dialog.value) return;
  const items = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      "button, a[href], input, textarea, select, [tabindex]",
    ),
  ).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.matches(":disabled") &&
      el.getClientRects().length > 0,
  );
  const first = items[0],
    last = items.at(-1);
  if (!first) {
    event.preventDefault();
    dialog.value.querySelector<HTMLElement>("h2")?.focus();
  } else if (
    event.shiftKey &&
    (document.activeElement === first ||
      !items.includes(document.activeElement as HTMLElement))
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
async function sync() {
  await nextTick();
  if (props.modelValue) {
    if (!dialog.value?.open) {
      previous = document.activeElement as HTMLElement;
      dialog.value?.showModal();
    }
  } else {
    dialog.value?.close();
    previous?.focus({ preventScroll: true });
  }
}
watch(() => props.modelValue, sync);
onMounted(sync);
onBeforeUnmount(() => {
  dialog.value?.close();
  previous?.focus({ preventScroll: true });
});
</script>
<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    :class="{ drawer }"
    :aria-labelledby="titleId"
    @cancel.prevent="close"
    @keydown="trapTab"
    @pointerdown="down"
    @pointerup="up"
    @pointercancel="backdropPointer = null"
  >
    <header>
      <h2 :id="titleId" tabindex="-1">{{ title }}</h2>
      <button
        class="icon-button"
        aria-label="关闭弹窗"
        :disabled="busy"
        @click="close"
      >
        <AppIcon name="close" />
      </button>
    </header>
    <div class="dialog-body"><slot /></div>
  </dialog>
</template>
