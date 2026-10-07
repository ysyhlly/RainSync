<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useId,
  watch,
  type CSSProperties,
} from "vue";
import RoomWidgetFrame from "./RoomWidgetFrame.vue";
import {
  createDefaultLayout,
  MAX_LAYOUT_ROWS,
  PLAYER_ASPECT_RATIO,
  WIDGET_DEFINITIONS,
  WIDGET_TYPES,
  type LayoutDocument,
  type LayoutItem,
} from "./layout-model";
import {
  getGridMetrics,
  getPlayerHeight,
  getWidgetConstraints,
  moveWidget,
  resizeWidget,
} from "./layout-geometry";

const props = withDefaults(
  defineProps<{
    layout: LayoutDocument;
    editing: boolean;
    viewing?: boolean;
    chatVisible?: boolean;
  }>(),
  { viewing: false, chatVisible: true },
);
const emit = defineEmits<{
  move: [payload: { id: string; x: number; y: number }];
  resize: [payload: { id: string; w: number; h: number }];
  remove: [id: string];
}>();
type GestureMode = "move" | "resize";
type Gesture = {
  id: string;
  mode: GestureMode;
  pointerId: number;
  target: HTMLElement;
  startX: number;
  startY: number;
  item: LayoutItem;
  base: LayoutDocument;
  metrics: ReturnType<typeof getGridMetrics>;
  moved: boolean;
};
type Preview = {
  item: LayoutItem;
  requested: LayoutItem;
  valid: boolean;
  changed: boolean;
};
const canvas = ref<HTMLElement>();
const width = ref(1200);
const selected = ref<string | null>(null);
const gesture = shallowRef<Gesture | null>(null);
const preview = shallowRef<Preview | null>(null);
const announcement = ref("");
const helpId = useId();
const narrow = computed(() => props.layout.breakpoint === "narrow");
const metrics = computed(() =>
  getGridMetrics(width.value, props.layout.breakpoint),
);
const defaults = computed(() => createDefaultLayout(props.layout.breakpoint));
const liveIds = computed(
  () => new Set(props.layout.items.map((item) => item.id)),
);
// Keep every business slot mounted. Reordering keyed frames moves existing nodes only.
const frames = computed(() =>
  WIDGET_TYPES.map(
    (type) =>
      props.layout.items.find((item) => item.type === type) ??
      defaults.value.items.find((item) => item.type === type)!,
  ).sort((a, b) => {
    if (liveIds.value.has(a.id) !== liveIds.value.has(b.id))
      return liveIds.value.has(a.id) ? -1 : 1;
    return (
      a.y - b.y ||
      a.x - b.x ||
      WIDGET_TYPES.indexOf(a.type) - WIDGET_TYPES.indexOf(b.type)
    );
  }),
);
function frameVisible(item: LayoutItem) {
  return props.viewing
    ? item.type === "player" || (item.type === "chat" && props.chatVisible)
    : liveIds.value.has(item.id);
}
const canvasStyle = computed<CSSProperties>(() =>
  props.viewing
    ? {}
    : {
        ...(narrow.value
          ? {}
          : {
              height: `${Math.max(...props.layout.items.map((item) => item.y + item.h), 1) * metrics.value.rowHeight + (props.editing ? 48 : 0)}px`,
            }),
        "--room-layout-column-step": `${metrics.value.columnWidth + metrics.value.gap}px`,
        "--room-layout-row-step": `${metrics.value.rowHeight}px`,
        "--room-layout-gap": `${metrics.value.gap}px`,
      },
);
let observer: ResizeObserver | undefined;
let ignoreClickUntil = 0;

function frameElement(id: string) {
  return Array.from(
    canvas.value?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [],
  ).find((element) => element.dataset.widgetId === id);
}
function boxStyle(item: LayoutItem): CSSProperties {
  const m = metrics.value;
  return {
    position: "absolute",
    left: `${item.x * (m.columnWidth + m.gap)}px`,
    top: `${item.y * m.rowHeight}px`,
    width: `${item.w * (m.columnWidth + m.gap) - m.gap}px`,
    height: `${item.h * m.rowHeight}px`,
  };
}
function frameStyle(item: LayoutItem): CSSProperties {
  if (props.viewing) return {};
  if (!narrow.value) return boxStyle(item);
  if (item.type === "player")
    return { height: `${width.value / PLAYER_ASPECT_RATIO}px` };
  return {
    minHeight: `${item.h * metrics.value.rowHeight}px`,
    ...(item.type === "chat" || item.type === "queue" || item.type === "members"
      ? { height: `${item.h * metrics.value.rowHeight}px` }
      : {}),
  };
}
const previewStyle = computed<CSSProperties>(() => {
  if (!preview.value) return {};
  if (!narrow.value) return boxStyle(preview.value.item);
  const active = gesture.value;
  const destination =
    active?.mode === "move"
      ? active.base.items.find(
          (item) =>
            item.y === preview.value!.requested.y && item.id !== active.id,
        )
      : undefined;
  const element = frameElement(destination?.id ?? preview.value.item.id);
  if (!element || !canvas.value) return {};
  const box = element.getBoundingClientRect(),
    origin = canvas.value.getBoundingClientRect();
  return {
    position: "absolute",
    left: "0",
    top: `${box.top - origin.top}px`,
    width: `${box.width}px`,
    height: `${active?.mode === "resize" ? preview.value.item.h * metrics.value.rowHeight : box.height}px`,
  };
});

function announce(message: string) {
  announcement.value = "";
  void nextTick(() => {
    announcement.value = message;
  });
}
async function focusWidget(id: string) {
  await nextTick();
  if (!liveIds.value.has(id)) return;
  const element = frameElement(id);
  element?.scrollIntoView({ block: "nearest", behavior: "instant" });
  element?.focus({ preventScroll: true });
  if (props.editing) selected.value = id;
  const item = props.layout.items.find((entry) => entry.id === id);
  if (item) announce(`已定位${WIDGET_DEFINITIONS[item.type].label}`);
}
function select(id: string) {
  if (performance.now() < ignoreClickUntil) return;
  selected.value = selected.value === id ? null : id;
}
function makePreview(
  base: LayoutDocument,
  requested: LayoutItem,
  mode: GestureMode,
): Preview {
  const next =
    mode === "move"
      ? moveWidget(base, requested.id, requested.x, requested.y)
      : resizeWidget(base, requested.id, requested.w, requested.h);
  const previous = base.items.find((item) => item.id === requested.id)!;
  const unchangedRequest =
    mode === "move"
      ? previous.x === requested.x && previous.y === requested.y
      : previous.w === requested.w && previous.h === requested.h;
  const changed = next !== base;
  const valid = changed || unchangedRequest;
  return {
    item: valid
      ? next.items.find((item) => item.id === requested.id)!
      : requested,
    requested,
    valid,
    changed,
  };
}
function requestedSize(
  item: LayoutItem,
  w: number,
  h: number,
  currentMetrics = metrics.value,
) {
  const limits = getWidgetConstraints(item.type, props.layout.breakpoint);
  const nextW = Math.max(
    limits.minW,
    Math.min(w, limits.maxW, currentMetrics.columns - item.x),
  );
  const nextH =
    item.type === "player" && !narrow.value
      ? getPlayerHeight(nextW, currentMetrics)
      : h;
  return {
    ...item,
    w: nextW,
    h: Math.max(
      limits.minH,
      Math.min(nextH, limits.maxH, MAX_LAYOUT_ROWS - item.y),
    ),
  };
}
function emitPlacement(result: Preview, mode: GestureMode) {
  const label = WIDGET_DEFINITIONS[result.requested.type].label;
  if (!result.valid) {
    announce(
      `${label}无法放在这里：空间不足或与其他组件重叠。原位置保持不变。`,
    );
    return;
  }
  if (!result.changed) {
    announce(`${label}的位置和大小未改变`);
    return;
  }
  const item = result.requested;
  const focused =
    document.activeElement instanceof HTMLElement &&
    canvas.value?.contains(document.activeElement)
      ? document.activeElement
      : null;
  if (mode === "move") emit("move", { id: item.id, x: item.x, y: item.y });
  else emit("resize", { id: item.id, w: item.w, h: item.h });
  // Moving a keyed DOM node may drop native focus in some browsers.
  void nextTick(() => {
    if (focused?.isConnected && document.activeElement === document.body)
      focused.focus({ preventScroll: true });
  });
  announce(
    narrow.value && mode === "move"
      ? `${label}顺序已调整；完成后保存`
      : `${label}已${mode === "move" ? "移动" : "调整大小"}；完成后保存`,
  );
}
function step(payload: {
  id: string;
  mode: GestureMode;
  dx: number;
  dy: number;
}) {
  if (!props.editing || gesture.value) return;
  const item = props.layout.items.find((entry) => entry.id === payload.id);
  if (!item) return;
  const requested =
    payload.mode === "move"
      ? {
          ...item,
          x: Math.max(
            0,
            Math.min(item.x + payload.dx, metrics.value.columns - item.w),
          ),
          y: Math.max(
            0,
            Math.min(
              item.y + payload.dy * (narrow.value ? 1 : 2),
              MAX_LAYOUT_ROWS - item.h,
            ),
          ),
        }
      : requestedSize(item, item.w + payload.dx, item.h + payload.dy * 2);
  emitPlacement(
    makePreview(props.layout, requested, payload.mode),
    payload.mode,
  );
}
function beginGesture(payload: {
  id: string;
  mode: GestureMode;
  event: PointerEvent;
}) {
  const { id, mode, event } = payload;
  if (!props.editing || gesture.value || !event.isPrimary || event.button !== 0)
    return;
  const item = props.layout.items.find((entry) => entry.id === id);
  const target = event.currentTarget;
  if (!item || !(target instanceof HTMLElement)) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  gesture.value = {
    id,
    mode,
    pointerId: event.pointerId,
    target,
    startX: event.pageX,
    startY: event.pageY,
    item: { ...item },
    base: props.layout,
    metrics: metrics.value,
    moved: false,
  };
  preview.value = makePreview(props.layout, item, mode);
  try {
    target.setPointerCapture(event.pointerId);
  } catch {
    /* Window listeners also cover synthetic pointers. */
  }
  window.addEventListener("pointermove", pointerMove, { passive: false });
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("pointercancel", pointerCancel);
  window.addEventListener("keydown", cancelKey, true);
  window.addEventListener("blur", cancelGesture);
  target.addEventListener("lostpointercapture", pointerCancel);
}
function pointerMove(event: PointerEvent) {
  const active = gesture.value;
  if (!active || event.pointerId !== active.pointerId) return;
  event.preventDefault();
  const dx = event.pageX - active.startX,
    dy = event.pageY - active.startY;
  if (Math.abs(dx) + Math.abs(dy) < 4 && !active.moved) return;
  active.moved = true;
  selected.value = active.id;
  const m = active.metrics;
  let requested: LayoutItem;
  if (active.mode === "resize") {
    requested = requestedSize(
      active.item,
      active.item.w +
        (narrow.value ? 0 : Math.round(dx / (m.columnWidth + m.gap))),
      active.item.h + Math.round(dy / m.rowHeight),
      m,
    );
  } else if (narrow.value) {
    const others = active.base.items
      .filter((item) => item.id !== active.id)
      .sort((a, b) => a.y - b.y);
    let targetY = active.item.y;
    for (const item of others) {
      const box = frameElement(item.id)?.getBoundingClientRect();
      if (!box) continue;
      if (
        dy > 0 &&
        item.y > active.item.y &&
        event.clientY >= box.top + box.height / 2
      )
        targetY = item.y;
      else if (
        dy < 0 &&
        item.y < active.item.y &&
        event.clientY <= box.top + box.height / 2
      ) {
        targetY = item.y;
        break;
      }
    }
    requested = { ...active.item, x: 0, y: targetY };
  } else {
    requested = {
      ...active.item,
      x: Math.max(
        0,
        Math.min(
          active.item.x + Math.round(dx / (m.columnWidth + m.gap)),
          m.columns - active.item.w,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          active.item.y + Math.round(dy / m.rowHeight),
          MAX_LAYOUT_ROWS - active.item.h,
        ),
      ),
    };
  }
  preview.value = makePreview(active.base, requested, active.mode);
}
function releaseGesture() {
  const active = gesture.value;
  gesture.value = null;
  preview.value = null;
  window.removeEventListener("pointermove", pointerMove);
  window.removeEventListener("pointerup", pointerUp);
  window.removeEventListener("pointercancel", pointerCancel);
  window.removeEventListener("keydown", cancelKey, true);
  window.removeEventListener("blur", cancelGesture);
  if (active) {
    active.target.removeEventListener("lostpointercapture", pointerCancel);
    try {
      if (active.target.hasPointerCapture(active.pointerId))
        active.target.releasePointerCapture(active.pointerId);
    } catch {
      /* Capture may already have been released. */
    }
  }
  return active;
}
function pointerUp(event: PointerEvent) {
  const active = gesture.value;
  if (!active || event.pointerId !== active.pointerId) return;
  // The final pointer position, not the path or last move event, determines the result.
  pointerMove(event);
  const result = preview.value;
  releaseGesture();
  if (active.moved && result) {
    ignoreClickUntil = performance.now() + 300;
    emitPlacement(result, active.mode);
  }
}
function pointerCancel(event: PointerEvent) {
  if (gesture.value?.pointerId === event.pointerId) cancelGesture();
}
function cancelKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || !gesture.value) return;
  event.preventDefault();
  event.stopPropagation();
  cancelGesture();
}
function cancelGesture() {
  if (!gesture.value) return;
  const active = releaseGesture();
  if (active) {
    ignoreClickUntil = performance.now() + 300;
    active.target.focus({ preventScroll: true });
    announce("已取消本次拖动，布局未改变");
  }
}
async function remove(id: string) {
  const item = props.layout.items.find((entry) => entry.id === id);
  if (!props.editing || !item || !WIDGET_DEFINITIONS[item.type].removable)
    return;
  const remaining = props.layout.items
    .filter((entry) => entry.id !== id)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  emit("remove", id);
  selected.value = null;
  await nextTick();
  if (remaining[0]) await focusWidget(remaining[0].id);
  announce(
    `${WIDGET_DEFINITIONS[item.type].label}已隐藏，可从添加组件找回；内容不会删除`,
  );
}
watch(
  () => props.editing,
  (editing) => {
    if (!editing) {
      cancelGesture();
      selected.value = null;
    }
  },
);
watch(
  () => props.layout,
  () => {
    if (gesture.value) cancelGesture();
  },
);
onMounted(() => {
  if (!canvas.value) return;
  width.value = canvas.value.clientWidth || 1200;
  observer = new ResizeObserver((entries) => {
    const nextWidth = entries[0]?.contentRect.width;
    if (nextWidth && Math.abs(nextWidth - width.value) > 0.5) {
      cancelGesture();
      width.value = nextWidth;
    }
  });
  observer.observe(canvas.value);
});
onBeforeUnmount(() => {
  releaseGesture();
  observer?.disconnect();
});
defineExpose({ focusWidget, cancelGesture });
</script>

<template>
  <div class="room-layout-workspace">
    <p v-if="editing" :id="helpId" class="room-layout-help helper">
      {{
        narrow
          ? "拖动把手调整顺序，或选择组件的调整按钮。窄屏布局单独保存。"
          : "拖动组件左上角把手移动，拖动右下角调整大小。重叠时不会放置，Escape 取消拖动。"
      }}
    </p>
    <div
      ref="canvas"
      class="room-layout-canvas"
      :class="{
        'room-layout-canvas--editing': editing,
        'room-layout-canvas--narrow': narrow,
        'is-editing': editing,
        'is-narrow': narrow,
      }"
      :style="canvasStyle"
      :aria-describedby="editing ? helpId : undefined"
      data-testid="room-layout-canvas"
      :data-layout-breakpoint="layout.breakpoint"
    >
      <RoomWidgetFrame
        v-for="item in frames"
        v-show="frameVisible(item)"
        :key="item.id"
        :item="item"
        :editing="editing"
        :selected="selected === item.id && !gesture"
        :dragging="gesture?.id === item.id"
        :narrow="narrow"
        :style="frameStyle(item)"
        @select="select"
        @gesture="beginGesture"
        @step="step"
        @remove="remove"
        ><slot name="widget" :item="item" :visible="frameVisible(item)"
      /></RoomWidgetFrame>
      <div
        v-if="preview && gesture?.moved"
        class="room-layout-preview"
        :class="{
          'room-layout-preview--invalid': !preview.valid,
          'is-invalid': !preview.valid,
        }"
        :style="previewStyle"
        aria-hidden="true"
        data-testid="room-layout-preview"
        :data-valid="preview.valid"
      >
        <span>{{
          preview.valid
            ? narrow
              ? "松开调整顺序"
              : "松开放置"
            : "空间不足，松开将保持原位"
        }}</span>
      </div>
    </div>
    <p
      :class="editing ? 'room-layout-feedback helper' : 'sr-only'"
      aria-live="polite"
      aria-atomic="true"
      role="status"
    >
      {{ announcement }}
    </p>
  </div>
</template>
