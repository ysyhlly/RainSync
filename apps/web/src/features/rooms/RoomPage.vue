<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "./room-runtime";
import { roomsApi } from "./rooms.api";
import type { RoomInvitation, RoomMember } from "../../shared/api/types";
import { useAction } from "../../shared/use-action";
import PlaybackInformation from "../playback/PlaybackInformation.vue";
import ChatPanel from "./ChatPanel.vue";
import AppSegmented from "../../shared/ui/AppSegmented.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
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
const lifecycleAction = ref<"close" | "reopen" | "archive" | "">("");
const lifecycleTitle = computed(
  () =>
    ({ close: "关闭房间", reopen: "重新开放房间", archive: "归档房间" })[
      lifecycleAction.value || "close"
    ],
);
const ownershipOpen = ref(false),
  members = ref<RoomMember[]>([]),
  selectedOwner = ref("");
const ownerOptions = computed(() =>
  members.value
    .filter((member) => member.id !== r.room?.owner_id)
    .map((member) => ({
      value: member.id,
      label: `${member.display_name} (@${member.username})`,
    })),
);
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
      ownershipOpen.value = false;
      lifecycleAction.value = "";
      inviteOpen.value = false;
      invite.value = null;
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
async function manageOwnership() {
  const id = r.room?.id;
  if (!id) return;
  const result = await api.members(id);
  if (!alive || r.room?.id !== id) return;
  members.value = result;
  selectedOwner.value = "";
  ownershipOpen.value = true;
}
async function changeLifecycle() {
  if (!lifecycleAction.value) return;
  await r.changeLifecycle(lifecycleAction.value);
  lifecycleAction.value = "";
  inviteOpen.value = false;
  invite.value = null;
  ownershipOpen.value = false;
}
async function transferOwnership() {
  await r.transferOwnership(selectedOwner.value);
  ownershipOpen.value = false;
  message.value = "房间已转让，当前影片继续播放";
}
</script>
<template>
  <section class="room-content">
    <Notice v-if="!inviteOpen" :message="error" error />
    <Notice v-if="!ownershipOpen && !inviteOpen" :message="message" />
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
        <div class="panel" role="status">
          <strong>房间{{ r.lifecycleLabel }}</strong>
          <p v-if="r.room?.lifecycle === 'closing'">
            正在停止播放和清理媒体任务，完成后才会关闭。历史记录仍可查看。
          </p>
          <p v-else-if="!r.roomActive">
            当前为只读状态，可以查看聊天记录和待播列表。
          </p>
          <Notice :message="r.cleanupError" error />
        </div>
        <div class="room-actions">
          <RouterLink class="button primary" to="/library"
            ><AppIcon name="movie" />选择影片</RouterLink
          ><button
            v-if="r.owner"
            :disabled="busy || !r.connected"
            @click="run(generate)"
          >
            <AppIcon name="key" />房间邀请</button
          ><button
            v-if="r.canManageRoom && r.roomActive"
            :disabled="busy || !r.connected"
            @click="run(manageOwnership)"
          >
            转让房间</button
          ><button
            v-if="r.canManageRoom && r.roomActive"
            class="danger"
            :disabled="busy || !r.state"
            @click="lifecycleAction = 'close'"
          >
            关闭房间
          </button>
          <button
            v-if="r.canManageRoom && r.room?.lifecycle === 'closed'"
            :disabled="busy || !r.state"
            @click="lifecycleAction = 'reopen'"
          >
            重新开放
          </button>
          <button
            v-if="r.canManageRoom && r.room?.lifecycle === 'closed'"
            :disabled="busy || !r.state"
            @click="lifecycleAction = 'archive'"
          >
            归档房间
          </button>
          <button @click="run(leave)">离开观看</button>
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
    <AppDialog
      :model-value="!!lifecycleAction"
      :title="lifecycleTitle"
      :busy="busy"
      @update:model-value="
        (value) => {
          if (!value) lifecycleAction = '';
        }
      "
    >
      <p v-if="lifecycleAction === 'close'">
        将停止所有设备的播放，撤销现有邀请和控制凭据。清理完成前房间保持“正在关闭”，现有成员仍能查看历史。
      </p>
      <p v-else-if="lifecycleAction === 'reopen'">
        重新开放后保持暂停。旧邀请和播放链接仍失效，需要创建新的邀请和播放授权。
      </p>
      <p v-else>
        归档后房间只读，不能再次开放。现有成员仍能查看保留期内的历史。
      </p>
      <Notice :message="error" error />
      <div class="button-row">
        <button
          class="danger"
          :disabled="busy || !r.canManageRoom"
          @click="run(changeLifecycle)"
        >
          确认{{ lifecycleTitle }}</button
        ><button :disabled="busy" @click="lifecycleAction = ''">取消</button>
      </div>
    </AppDialog>
    <AppDialog v-model="ownershipOpen" title="转让房间" :busy="busy">
      <p>
        选择已加入房间的成员作为新房主。新房主将获得播放、邀请和待播列表管理权限；你仍可观看和聊天。
      </p>
      <p class="helper">
        当前影片不会中断，片源所有权不会改变。转让后不能自行取回房主权限。
      </p>
      <AppSelect
        v-model="selectedOwner"
        :options="ownerOptions"
        label="新房主"
        placeholder="选择房间成员"
        :disabled="busy || !r.canManageRoom || !r.roomActive"
      />
      <p v-if="!ownerOptions.length" class="helper">
        请先邀请其他成员加入房间。
      </p>
      <Notice :message="error" error />
      <div class="button-row">
        <button
          class="danger"
          :disabled="
            busy ||
            !selectedOwner ||
            !r.canManageRoom ||
            !r.roomActive ||
            !r.connected
          "
          @click="run(transferOwnership)"
        >
          确认转让
        </button>
        <button :disabled="busy" @click="ownershipOpen = false">取消</button>
      </div>
    </AppDialog>
  </section>
</template>
