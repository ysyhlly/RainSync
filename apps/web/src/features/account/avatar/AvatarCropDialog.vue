<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import AppDialog from "../../../shared/ui/AppDialog.vue";
import Notice from "../../../shared/ui/Notice.vue";
import {
  createCrop,
  drawCrop,
  panCrop,
  zoomCrop,
  exportCrop,
} from "./crop-model";
const props = defineProps<{
  image: ImageBitmap;
  modelValue: boolean;
  saving: boolean;
  locked?: boolean;
  error?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [boolean]; save: [Blob] }>();
const crop = ref(createCrop(props.image.width, props.image.height)),
  canvas = ref<HTMLCanvasElement>(),
  preview = ref<HTMLCanvasElement>(),
  small = ref<HTMLCanvasElement>(),
  localError = ref("");
const pointers = new Map<number, { x: number; y: number }>();
function draw() {
  if (canvas.value) drawCrop(canvas.value, props.image, crop.value);
  if (preview.value) drawCrop(preview.value, props.image, crop.value, 128);
  if (small.value) drawCrop(small.value, props.image, crop.value, 40);
}
watch(crop, draw, { deep: true });
watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      await nextTick();
      draw();
    } else pointers.clear();
  },
  { immediate: true },
);
function reset() {
  crop.value = createCrop(props.image.width, props.image.height);
}
function start(event: PointerEvent) {
  if (props.saving || props.locked) return;
  canvas.value?.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
}
function move(event: PointerEvent) {
  if (
    props.saving ||
    props.locked ||
    !pointers.has(event.pointerId) ||
    !canvas.value
  )
    return;
  const before = [...pointers.values()];
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const after = [...pointers.values()],
    box = canvas.value.getBoundingClientRect();
  if (after.length === 1) {
    crop.value = panCrop(
      crop.value,
      after[0].x - before[0].x,
      after[0].y - before[0].y,
      box.width,
    );
  } else if (after.length === 2) {
    const mid = (points: { x: number; y: number }[]) => ({
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    });
    const old = mid(before),
      current = mid(after),
      distance = (points: { x: number; y: number }[]) =>
        Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    const ratio = distance(before) > 0 ? distance(after) / distance(before) : 1;
    crop.value = zoomCrop(
      panCrop(crop.value, current.x - old.x, current.y - old.y, box.width),
      crop.value.zoom * ratio,
      (current.x - box.left) / box.width,
      (current.y - box.top) / box.height,
    );
  }
}
function end(event: PointerEvent) {
  pointers.delete(event.pointerId);
}
function key(event: KeyboardEvent) {
  if (props.saving || props.locked) return;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [10, 0],
    ArrowRight: [-10, 0],
    ArrowUp: [0, 10],
    ArrowDown: [0, -10],
  };
  if (moves[event.key]) {
    event.preventDefault();
    const [x, y] = moves[event.key];
    crop.value = panCrop(
      crop.value,
      x * (event.shiftKey ? 5 : 1),
      y * (event.shiftKey ? 5 : 1),
      canvas.value?.clientWidth ?? 300,
    );
  }
}
async function save() {
  localError.value = "";
  try {
    emit("save", await exportCrop(props.image, crop.value));
  } catch (e) {
    localError.value = e instanceof Error ? e.message : String(e);
  }
}
onBeforeUnmount(() => pointers.clear());
</script>
<template>
  <AppDialog
    :model-value="modelValue"
    title="调整头像"
    :busy="saving"
    @update:model-value="emit('update:modelValue', $event)"
    ><p>拖动图片并缩放，调整头像显示范围。输出为 512 × 512。</p>
    <p v-if="image.width < 512 || image.height < 512" class="helper">
      原图较小，保存后可能模糊。
    </p>
    <div class="crop-grid">
      <div class="crop-surface">
        <canvas
          ref="canvas"
          aria-label="头像取景区域，方向键移动取景"
          tabindex="0"
          @pointerdown="start"
          @pointermove="move"
          @pointerup="end"
          @pointercancel="end"
          @lostpointercapture="end"
          @keydown="key"
        />
        <div class="crop-guide" aria-hidden="true" />
      </div>
      <div class="crop-previews">
        <span>头像预览</span
        ><canvas
          ref="preview"
          class="avatar-preview"
          aria-label="头像预览128像素"
        /><canvas
          ref="small"
          class="avatar-preview small"
          aria-label="头像预览40像素"
        /><span class="helper">保存方形图片，界面圆形展示。</span>
      </div>
    </div>
    <label
      >缩放<input
        :value="crop.zoom"
        type="range"
        min="1"
        max="8"
        step=".01"
        :disabled="saving || locked"
        @input="
          crop = zoomCrop(
            crop,
            Number(($event.target as HTMLInputElement).value),
          )
        "
    /></label>
    <div class="button-row">
      <button
        :disabled="saving || locked"
        @click="crop = zoomCrop(crop, crop.zoom / 1.2)"
      >
        缩小</button
      ><button
        :disabled="saving || locked"
        @click="crop = zoomCrop(crop, crop.zoom * 1.2)"
      >
        放大</button
      ><button :disabled="saving || locked" @click="reset">重置取景</button>
    </div>
    <Notice :message="error || localError" error />
    <p v-if="locked" class="helper">
      上次保存结果尚待确认，重试将保持同一操作与图片。
    </p>
    <div class="dialog-actions">
      <button :disabled="saving" @click="emit('update:modelValue', false)">
        取消</button
      ><button class="primary" :disabled="saving" @click="save">
        {{ saving ? "正在保存…" : locked ? "重试此保存" : "保存头像" }}
      </button>
    </div></AppDialog
  >
</template>
