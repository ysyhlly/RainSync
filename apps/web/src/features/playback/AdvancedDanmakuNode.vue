<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, type CSSProperties, type DeepReadonly } from "vue";
import {
  sampleSceneNode,
  danmakuActionUrl,
  validDanmakuAction,
  type SceneNode,
  type SceneValue,
  type DanmakuAction,
} from "./advanced-danmaku";
const props = defineProps<{
  node: DeepReadonly<SceneNode>;
  nodes: readonly DeepReadonly<SceneNode>[];
  elapsed: number;
  width: number;
  height: number;
  viewportWidth?: number;
  reduced: boolean;
  canSeek: boolean;
}>();
const emit = defineEmits<{ seek: [atMs: number] }>();
const element = ref<HTMLElement>(),
  ownWidth = ref(0),
  ownHeight = ref(0);
let observer: ResizeObserver | undefined;
watch(element, (value) => {
  observer?.disconnect();
  if (value) {
    observer = new ResizeObserver(() => {
      ownWidth.value = value.clientWidth;
      ownHeight.value = value.clientHeight;
    });
    observer.observe(value);
  }
});
onBeforeUnmount(() => observer?.disconnect());
const p = computed(() =>
  sampleSceneNode(
    props.node,
    props.elapsed,
    props.width,
    props.height,
    props.reduced,
  ),
);
const active = computed(
  () => props.elapsed >= props.node.start && props.elapsed < props.node.end,
);
const children = computed(() =>
  props.nodes.filter((n) => n.props.parent === props.node.id),
);
const target = computed(() =>
  validDanmakuAction(p.value.target) ? p.value.target : undefined,
);
const href = computed(() =>
  target.value ? danmakuActionUrl(target.value) : undefined,
);
const text = computed(() => String(p.value.content ?? p.value.text ?? ""));
const cssValue = (v: SceneValue | undefined, fallback: string) =>
  typeof v === "number"
    ? `${v}px`
    : v && typeof v === "object" && "percent" in v
      ? `${v.percent}%`
      : fallback;
const rgb = (v: SceneValue | undefined, fallback = 0xffffff) =>
  `#${Number(v ?? fallback)
    .toString(16)
    .padStart(6, "0")}`;
function style(): CSSProperties {
  const v = p.value,
    path = props.node.kind === "path";
  return {
    left: cssValue(v.x, "0px"),
    top: cssValue(v.y, "0px"),
    width: cssValue(
      v.width,
      props.node.kind === "group" ? "100%" : path ? "672px" : "max-content",
    ),
    height: cssValue(
      v.height,
      props.node.kind === "group" ? "100%" : path ? "438px" : "auto",
    ),
    opacity: Number(v.alpha ?? 1),
    zIndex: Number(v.zIndex ?? 0),
    transform: `translate(${-Number(v.anchorX ?? 0) * 100}%, ${-Number(v.anchorY ?? 0) * 100}%) rotateX(${Number(v.rotateX ?? 0)}deg) rotateY(${Number(v.rotateY ?? 0)}deg) rotateZ(${Number(v.rotateZ ?? 0)}deg) scale(${Number(v.scaleX ?? v.scale ?? 1)},${Number(v.scaleY ?? v.scale ?? 1)})`,
    color: rgb(
      v.textColor ?? v.color,
      props.node.kind === "button" ? 0 : 0xffffff,
    ),
    fontSize:
      v.fontSize && typeof v.fontSize === "object" && "percent" in v.fontSize
        ? `${((props.viewportWidth ?? props.width) * v.fontSize.percent) / 100}px`
        : cssValue(v.fontSize, "25px"),
    fontFamily: String(v.fontFamily ?? "sans-serif"),
    fontWeight: Number(v.bold ?? 1) ? 700 : 400,
    textShadow: Number(v.textShadow ?? (props.node.kind === "button" ? 0 : 1))
      ? "1px 1px 2px #000"
      : "none",
    WebkitTextStroke: `${Number(v.strokeWidth ?? 0)}px ${rgb(v.strokeColor)}`,
  };
}
function click(action?: DanmakuAction) {
  if (action?.kind === "seek" && props.canSeek) emit("seek", action.at_ms);
}
const background = computed(() => {
  const color = Number(p.value.fillColor ?? 0xffffff),
    alpha = Number(p.value.fillAlpha ?? 1);
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;
});
</script>
<template>
  <div
    v-if="active"
    ref="element"
    class="advanced-node"
    :style="style()"
    :data-danmaku-kind="node.kind"
  >
    <svg
      v-if="node.kind === 'path'"
      :viewBox="String(p.viewBox ?? '0 0 672 438')"
      width="100%"
      height="100%"
      aria-hidden="true"
    >
      <path
        :d="String(p.d ?? '')"
        :fill="rgb(p.fillColor)"
        :fill-opacity="Number(p.fillAlpha ?? 1)"
        :stroke="rgb(p.borderColor)"
        :stroke-width="Number(p.borderWidth ?? 0)"
        :stroke-opacity="Number(p.borderAlpha ?? 1)"
      />
    </svg>
    <a
      v-else-if="node.kind === 'button' && href"
      class="advanced-button"
      :href="href"
      target="_blank"
      rel="noopener noreferrer"
      :style="{ backgroundColor: background }"
      :aria-label="text + '（在新窗口打开原站）'"
      @click.stop
      @pointerdown.stop
      >{{ text }}</a
    >
    <button
      v-else-if="node.kind === 'button' && target?.kind === 'seek'"
      class="advanced-button"
      :disabled="!canSeek"
      :title="canSeek ? '跳转房间播放进度' : '需要房间控制权限'"
      :style="{ backgroundColor: background }"
      @click.stop="click(target)"
      @pointerdown.stop
    >
      {{ text }}
    </button>
    <span
      v-else-if="node.kind === 'text' || node.kind === 'button'"
      aria-hidden="true"
      >{{ text }}</span
    >
    <AdvancedDanmakuNode
      v-for="child in children"
      :key="child.id"
      :node="child"
      :nodes="nodes"
      :elapsed="elapsed"
      :width="ownWidth || width"
      :height="ownHeight || height"
      :viewport-width="viewportWidth ?? width"
      :reduced="reduced"
      :can-seek="canSeek"
      @seek="emit('seek', $event)"
    />
  </div>
</template>
<style scoped>
.advanced-node {
  position: absolute;
  transform-origin: 0 0;
  white-space: pre;
  pointer-events: none;
  line-height: 1.2;
}
.advanced-node > span {
  font: inherit;
  color: inherit;
  text-shadow: inherit;
}
.advanced-button {
  pointer-events: auto;
  display: inline-block;
  font: inherit;
  color: inherit;
  padding: 0.35em 0.6em;
  border: 1px solid currentColor;
  border-radius: 0.3em;
  text-decoration: none;
  line-height: 1.2;
  cursor: pointer;
}
.advanced-button:disabled {
  cursor: default;
  opacity: 0.65;
}
.advanced-button:focus-visible {
  outline: 3px solid #fff;
  outline-offset: 3px;
}
</style>
