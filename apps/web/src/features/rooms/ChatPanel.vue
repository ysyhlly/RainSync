<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from "vue";
import { useRoomRuntime } from "./room-runtime";
import UserAvatar from "../../shared/ui/UserAvatar.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
const r = useRoomRuntime(),
  log = ref<HTMLElement>(),
  atBottom = ref(true),
  unread = ref(false);
function scroll() {
  const el = log.value;
  if (el)
    atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  if (atBottom.value) unread.value = false;
}
function bottom() {
  log.value?.scrollTo({ top: log.value.scrollHeight });
  atBottom.value = true;
  unread.value = false;
}
watch(
  () => r.messages.length,
  async () => {
    const wasBottom = atBottom.value;
    await nextTick();
    if (wasBottom) bottom();
    else unread.value = true;
  },
);
onMounted(bottom);
</script>
<template>
  <aside class="chat-panel panel">
    <header>
      <h2>房间聊天</h2>
      <span class="helper">{{
        !r.roomActive ? "只读" : r.connected ? "已连接" : "连接中断"
      }}</span>
    </header>
    <div
      ref="log"
      class="chat-log"
      role="log"
      aria-label="聊天记录"
      aria-live="polite"
      @scroll="scroll"
    >
      <p v-if="!r.messages.length" class="empty-chat">暂无消息</p>
      <article v-for="m in r.messages" :key="m.id" class="chat-message">
        <UserAvatar
          :name="m.display_name ?? m.username"
          :url="m.avatar_url"
          :size="32"
        />
        <div>
          <b>{{ m.display_name ?? m.username }}</b
          ><time
            v-if="m.created_at"
            :datetime="new Date(m.created_at).toISOString()"
            >{{
              new Date(m.created_at).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })
            }}</time
          >
          <p>{{ m.body }}</p>
        </div>
      </article>
    </div>
    <button v-if="unread" class="new-messages" @click="bottom">
      有新消息<AppIcon name="down" />
    </button>
    <form class="chat-form" @submit.prevent="r.sendChat">
      <label class="sr-only" for="chat-body">聊天消息</label
      ><input
        id="chat-body"
        v-model="r.chat"
        :maxlength="4000"
        placeholder="发送消息"
        :disabled="!r.connected || !r.roomActive"
        autocomplete="off"
      /><button
        class="primary icon-button"
        :aria-label="r.chatFailed ? '重试发送' : '发送消息'"
        :disabled="
          !r.connected || !r.roomActive || r.chatPending || !r.chat.trim()
        "
      >
        <AppIcon :name="r.chatFailed ? 'refresh' : 'send'" />
      </button>
    </form>
    <p v-if="r.chatPending || r.chatFailed" class="helper" role="status">
      {{
        r.chatPending ? "正在等待发送确认…" : "消息未确认，保留原编号以供重试。"
      }}
    </p>
  </aside>
</template>
