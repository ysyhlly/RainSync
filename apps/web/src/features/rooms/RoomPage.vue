<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "./room-runtime";
import { roomsApi } from "./rooms.api";
import type { RoomInvitation } from "../../shared/api/types";
import { useAction } from "../../shared/use-action";
import PlaybackInformation from "../playback/PlaybackInformation.vue";
import ChatPanel from "./ChatPanel.vue";
import AppSegmented from "../../shared/ui/AppSegmented.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
import { useMediaCatalog } from "../library/media-catalog.store";
import MediaThumbnail from "../library/MediaThumbnail.vue";
const catalog = useMediaCatalog();
const r = useRoomRuntime(),
  session = useSession(),
  route = useRoute(),
  router = useRouter(),
  api = roomsApi(session.api);
const { busy, error, message, run } = useAction();
const inviteOpen = ref(false),
  invite = ref<RoomInvitation | null>(null),
  revoking = ref(false),
  mobilePanel = ref("chat");
let entry = 0;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  ++entry;
});
watch(
  () => route.params.id,
  () =>
    run(async () => {
      const serial = ++entry,
        id = String(route.params.id);
      if (r.room?.id === id) {
        r.refreshMetadata();
        return;
      }
      const rooms = await api.list();
      if (!alive || serial !== entry || String(route.params.id) !== id) return;
      const room = rooms.find((r) => r.id === id);
      if (!room) throw Error("你尚未加入此放映室，请通过房间邀请加入。");
      await r.enter(room);
    }),
  { immediate: true },
);
async function generate() {
  invite.value = await r.makeInvite();
  inviteOpen.value = true;
}
async function copy() {
  if (!invite.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(invite.value));
    message.value = "房间邀请已复制";
  } catch {
    error.value = "复制失败，请选中文本手动复制。";
  }
}
async function revoke() {
  if (!invite.value) return;
  await r.revokeInvite(invite.value);
  invite.value = null;
  revoking.value = false;
  message.value = "此房间邀请已撤销";
}
async function leave() {
  await r.leave();
  await router.push("/rooms");
}
</script>
<template>
  <section class="room-content">
    <Notice v-if="!inviteOpen" :message="error" error />
    <div v-if="r.room?.id !== String(route.params.id)" class="page empty-state">
      <h1>放映室</h1>
      <p v-if="busy" role="status">正在进入房间…</p>
      <RouterLink class="button" to="/rooms">返回放映室</RouterLink>
    </div>
    <template v-else
      ><PlaybackInformation
        class="room-information"
        :title="r.currentTitle"
        :room="r.room?.name ?? ''"
        :connected="r.connected"
        :stopped="r.connectionStopped"
        :owner="r.owner" /><AppSegmented
        v-model="mobilePanel"
        class="mobile-room-tabs"
        label="房间面板"
        :options="[
          { value: 'chat', label: '聊天', panel: 'room-chat' },
          { value: 'queue', label: '待播', panel: 'room-queue' },
        ]" />
      <div
        id="room-chat"
        role="tabpanel"
        aria-labelledby="room-chat-tab"
        class="room-chat"
        :class="{ 'mobile-hidden': mobilePanel !== 'chat' }"
      >
        <ChatPanel />
      </div>
      <section
        id="room-queue"
        role="tabpanel"
        aria-labelledby="room-queue-tab"
        class="room-secondary"
        :class="{ 'mobile-hidden': mobilePanel !== 'queue' }"
      >
        <div class="room-actions">
          <RouterLink class="button primary" to="/library"
            ><AppIcon name="movie" />选择影片</RouterLink
          ><button
            v-if="r.owner"
            :disabled="busy || !r.connected"
            @click="run(generate)"
          >
            <AppIcon name="key" />房间邀请</button
          ><button @click="run(leave)">离开观看</button>
        </div>
        <div class="queue-panel panel">
          <header>
            <h2>待播列表</h2>
            <span class="helper">{{ r.playlist.length }} 部</span>
          </header>
          <p v-if="!r.playlist.length" class="helper">
            暂无待播影片，在媒体库中添加。
          </p>
          <article v-for="item in r.playlist" :key="item.id" class="queue-row">
            <MediaThumbnail
              small
              :cover="catalog.records[item.media_id]?.cover ?? item.cover"
              :alt="catalog.records[item.media_id]?.title ?? item.title"
            />
            <h3>{{ catalog.records[item.media_id]?.title ?? item.title }}</h3>
            <button
              class="icon-button"
              :aria-label="
                '播放 ' + (catalog.records[item.media_id]?.title ?? item.title)
              "
              :disabled="!r.owner || !r.connected"
              @click="r.choose(item.media_id)"
            >
              <AppIcon name="play" /></button
            ><button
              v-if="r.owner"
              class="icon-button"
              :aria-label="'移除 ' + item.title"
              @click="r.run(() => r.removeQueue(item.id))"
            >
              <AppIcon name="trash" />
            </button>
          </article>
        </div></section></template
    ><AppDialog v-model="inviteOpen" title="房间邀请" drawer :busy="busy"
      ><p>邀请在创建后24小时内有效，仅用于加入此房间。</p>
      <label v-if="invite"
        >完整房间邀请<textarea
          readonly
          :value="JSON.stringify(invite)"
          @focus="($event.target as HTMLTextAreaElement).select()"
        /></label
      ><Notice :message="error" error /><Notice :message="message" />
      <div v-if="invite" class="button-row">
        <button class="primary" @click="copy">
          <AppIcon name="copy" />复制邀请</button
        ><button class="danger" @click="revoking = true">撤销此邀请</button>
      </div>
      <div v-if="revoking" class="confirm-panel">
        <p>撤销后此邀请无法继续加入房间，现有成员不受影响。</p>
        <button class="danger" :disabled="busy" @click="run(revoke)">
          确认撤销</button
        ><button @click="revoking = false">取消</button>
      </div></AppDialog
    >
  </section>
</template>
