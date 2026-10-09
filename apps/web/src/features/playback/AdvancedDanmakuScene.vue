<script setup lang="ts">
import { computed, type DeepReadonly } from "vue";
import AdvancedDanmakuNode from "./AdvancedDanmakuNode.vue";
import type { DanmakuScene } from "./advanced-danmaku";
const props = defineProps<{
  scene: DeepReadonly<DanmakuScene>;
  elapsed: number;
  width: number;
  height: number;
  reduced: boolean;
  canSeek: boolean;
}>();
const emit = defineEmits<{ seek: [atMs: number] }>();
const roots = computed(() => props.scene.nodes.filter((n) => !n.props.parent));
const size = computed(
  () => props.scene.stage ?? { width: props.width, height: props.height },
);
</script>
<template>
  <div
    class="advanced-scene"
    :style="{
      width: size.width + 'px',
      height: size.height + 'px',
      transform: scene.stage
        ? `scale(${width / size.width},${height / size.height})`
        : undefined,
    }"
  >
    <AdvancedDanmakuNode
      v-for="node in roots"
      :key="node.id"
      :node="node"
      :nodes="scene.nodes"
      :elapsed="elapsed"
      :width="size.width"
      :height="size.height"
      :reduced="reduced"
      :can-seek="canSeek"
      @seek="emit('seek', $event)"
    />
  </div>
</template>
<style scoped>
.advanced-scene {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transform-origin: 0 0;
  perspective: 1000px;
}
</style>
