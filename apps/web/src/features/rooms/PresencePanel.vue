<script setup lang="ts">
import type { OnlineSnapshot } from "./presence-state";

defineProps<{
  snapshot?: OnlineSnapshot;
  names?: Readonly<Record<string, string>>;
  selfId?: string;
}>();
</script>

<template>
  <section class="presence-panel" aria-label="已上报在线状态的连接">
    <p v-if="!snapshot" role="status">在线状态不可用</p>
    <template v-else>
      <p role="status">{{ snapshot.members.length }} 位成员已上报在线状态</p>
      <p>仅显示已上报在线状态的连接；其他成员的状态未知。</p>
      <ul v-if="snapshot.members.length">
        <li v-for="member in snapshot.members" :key="member.userId">
          <span
            >{{ names?.[member.userId] || "房间成员"
            }}{{ member.userId === selfId ? "（你）" : "" }}</span
          >
          <span
            v-if="member.connections > 1"
            title="可能来自多个设备或浏览器标签页"
          >
            {{ member.connections }} 个连接
          </span>
          <span v-else>1 个连接</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.presence-panel {
  font-size: 0.875rem;
}
p {
  margin: 0 0 0.5rem;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.25rem 0;
}
</style>
