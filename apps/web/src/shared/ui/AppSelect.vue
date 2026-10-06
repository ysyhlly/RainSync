<script setup lang="ts" generic="T extends SelectValue">
import { computed, nextTick, ref, useId, watch } from "vue";
import type { SelectOption, SelectValue } from "./select";
import { useSelectPopup } from "./use-select-popup";
import AppIcon from "./AppIcon.vue";
const props = defineProps<{
  modelValue: T;
  options: SelectOption[];
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  compact?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [T];
  change: [T];
  "open-change": [boolean];
}>();
const trigger = ref<HTMLElement>(),
  menu = ref<HTMLElement>(),
  id = useId(),
  active = ref(-1);
const { open, show, close } = useSelectPopup(
  trigger,
  menu,
  (value) => emit("open-change", value),
  () => !!props.disabled,
);
const selected = computed(() =>
  props.options.find((o) => o.value === props.modelValue),
);
const displayLabel = computed(
  () =>
    selected.value?.label ??
    props.placeholder ??
    (props.options.length ? "请选择" : "暂无可用选项"),
);
let typed = "",
  typedAt = 0;
function enabled() {
  return props.options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);
}
async function reveal() {
  await nextTick();
  if (!open.value || props.disabled) return;
  menu.value
    ?.querySelector<HTMLElement>(`[id="${id}-${active.value}"]`)
    ?.scrollIntoView({ block: "nearest" });
}
async function expand() {
  if (props.disabled) return;
  active.value = props.options.findIndex(
    (o) => o.value === props.modelValue && !o.disabled,
  );
  if (active.value < 0) active.value = enabled()[0] ?? -1;
  await show();
  void reveal();
}
function choose(index: number) {
  if (props.disabled) return;
  const option = props.options[index];
  if (!option || option.disabled) return;
  if (option.value !== props.modelValue) {
    emit("update:modelValue", option.value as T);
    emit("change", option.value as T);
  }
  close();
  trigger.value?.focus({ preventScroll: true });
}
async function key(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === "Tab") {
    close();
    return;
  }
  if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    if (open.value) choose(active.value);
    else await expand();
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (!open.value) await expand();
    const list = enabled(),
      index = list.indexOf(active.value);
    active.value =
      event.key === "Home"
        ? (list[0] ?? -1)
        : event.key === "End"
          ? (list.at(-1) ?? -1)
          : (list[
              (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) %
                list.length
            ] ?? -1);
    void reveal();
    return;
  }
  if (
    event.key.length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    if (!open.value) await expand();
    typed = Date.now() - typedAt > 700 ? event.key : typed + event.key;
    typedAt = Date.now();
    const found = props.options.findIndex(
      (o) =>
        !o.disabled &&
        o.label.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase()),
    );
    if (found >= 0) {
      active.value = found;
      void reveal();
    }
  }
}
watch(
  () => props.disabled,
  (value) => {
    if (value) close();
  },
);
watch(
  () => props.options,
  () => {
    if (open.value && !enabled().includes(active.value))
      active.value = enabled()[0] ?? -1;
  },
);
</script>
<template>
  <span class="app-select" :class="{ compact }">
    <button
      ref="trigger"
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="id"
      :aria-activedescendant="
        open && active >= 0 ? `${id}-${active}` : undefined
      "
      :aria-invalid="invalid || undefined"
      :aria-describedby="[describedBy, `${id}-value`].filter(Boolean).join(' ')"
      :title="displayLabel"
      :disabled="disabled"
      class="select-trigger"
      @click="open ? close() : expand()"
      @keydown="key"
    >
      <span :id="`${id}-value`" class="select-value">{{ displayLabel }}</span
      ><AppIcon name="down" :size="20" class="select-chevron" />
    </button>
    <div
      v-show="open"
      :id="id"
      ref="menu"
      class="select-menu"
      popover="manual"
      role="listbox"
      :aria-label="label"
      @pointerdown.prevent
      @keydown="key"
    >
      <div
        v-for="(option, index) in options"
        :id="`${id}-${index}`"
        :key="`${typeof option.value}:${option.value}`"
        role="option"
        :aria-selected="option.value === modelValue"
        :aria-disabled="option.disabled || undefined"
        :title="option.label"
        class="select-option"
        :class="{ active: index === active }"
        @pointermove="!option.disabled && (active = index)"
        @click.stop.prevent="choose(index)"
      >
        <span class="select-option-label">{{ option.label }}</span
        ><AppIcon v-if="option.value === modelValue" name="check" :size="20" />
      </div>
      <div v-if="!options.length" class="select-option" aria-disabled="true">
        暂无可用选项
      </div>
    </div>
  </span>
</template>
