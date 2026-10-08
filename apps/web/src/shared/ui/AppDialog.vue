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
const closing = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let emitClosed = false;
let previous: HTMLElement | null = null;
let backdropPointer: number | null = null;
let focusVersion = 0;
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
  beginClose(true);
}
// Child controls (for example a native search field) can request the same
// guarded dismissal instead of bypassing animation, inertness or focus recovery.
defineExpose({ close });
function finishClose() {
  if (!closing.value) return;
  clearTimeout(closeTimer);
  dialog.value?.close();
  setClosing(false);
  if (emitClosed) emit("update:modelValue", false);
  emitClosed = false;
  restoreFocus();
}
function beginClose(notify: boolean) {
  if (!dialog.value?.open || closing.value) return;
  emitClosed = notify;
  setClosing(true);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) finishClose();
  else closeTimer = setTimeout(finishClose, 300);
}
function setClosing(value: boolean) {
  closing.value = value;
  for (const type of ["keydown", "click", "submit"]) {
    // Native capture avoids changing Vue's event timestamps for child handlers.
    if (value)
      dialog.value?.addEventListener(type, blockClosingInteraction, true);
    else dialog.value?.removeEventListener(type, blockClosingInteraction, true);
  }
}
function blockClosingInteraction(event: Event) {
  // Guard before inert is rendered, including programmatic form submissions.
  if (!closing.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
function restoreFocus() {
  const target = previous;
  const version = ++focusVersion;
  if (!target) return;
  void nextTick(() => {
    // Let the parent re-enable its trigger, but don't interrupt a newer modal.
    if (version !== focusVersion || dialog.value?.open || !target.isConnected)
      return;
    if (
      Array.from(document.querySelectorAll("dialog:modal")).some(
        (modal) => !modal.contains(target),
      )
    )
      return;
    target.focus({ preventScroll: true });
  });
}
function animationEnded(event: AnimationEvent) {
  if (event.target === dialog.value && event.animationName.endsWith("-leave"))
    finishClose();
}
function trapTab(event: KeyboardEvent) {
  if (event.key !== "Tab" || !dialog.value) return;
  const items = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      "button, a[href], input, textarea, select, details > summary:first-of-type, [tabindex]",
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
  if (props.modelValue) ++focusVersion;
  await nextTick();
  if (props.modelValue) {
    clearTimeout(closeTimer);
    setClosing(false);
    emitClosed = false;
    if (!dialog.value?.open) {
      previous = document.activeElement as HTMLElement;
      dialog.value?.showModal();
    }
  } else {
    beginClose(false);
  }
}
watch(() => props.modelValue, sync);
onMounted(sync);
onBeforeUnmount(() => {
  clearTimeout(closeTimer);
  setClosing(false);
  dialog.value?.close();
  restoreFocus();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    :class="{ drawer, closing }"
    :inert="closing"
    @animationend="animationEnded"
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
