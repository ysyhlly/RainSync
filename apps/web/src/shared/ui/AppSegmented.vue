<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  label: string;
  options: { value: string; label: string; panel: string }[];
}>();
const emit = defineEmits<{ "update:modelValue": [string] }>();
function key(event: KeyboardEvent, index: number) {
  const direction =
    event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!direction && !["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? props.options.length - 1
        : (index + direction + props.options.length) % props.options.length;
  emit("update:modelValue", props.options[next].value);
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelectorAll<HTMLButtonElement>("button")
    [next]?.focus();
}
</script>
<template>
  <div class="app-segmented" role="tablist" :aria-label="label">
    <button
      v-for="(option, index) in options"
      :id="option.panel + '-tab'"
      :key="option.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === option.value"
      :aria-controls="option.panel"
      :tabindex="modelValue === option.value ? 0 : -1"
      @click="emit('update:modelValue', option.value)"
      @keydown="key($event, index)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
