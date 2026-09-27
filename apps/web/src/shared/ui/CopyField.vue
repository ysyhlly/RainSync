<script setup lang="ts">
import { ref, useId, watch } from "vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps<{ value: string; label: string }>();
const emit = defineEmits<{ copied: [] }>();
const id = useId(),
  field = ref<HTMLTextAreaElement>(),
  status = ref("");
watch(
  () => props.value,
  () => (status.value = ""),
);
async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
    status.value = "已复制";
    emit("copied");
  } catch {
    status.value = "复制失败，请选中文本手动复制。";
    field.value?.focus();
    field.value?.select();
  }
}
</script>
<template>
  <div class="copy-field">
    <label :for="id">{{ label }}</label
    ><textarea
      :id="id"
      ref="field"
      readonly
      :value="value"
      @focus="field?.select()"
    /><button type="button" @click="copy">
      <AppIcon name="copy" />复制{{ label }}
    </button>
    <p v-if="status" role="status" class="helper">{{ status }}</p>
  </div>
</template>
