<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "./room-runtime";
import { roomsApi } from "./rooms.api";
import type {
  RoomInvitation,
  RoomMember,
  RoomPermission,
  RoomInviteRecord,
} from "../../shared/api/types";
import RoomAccessPanel from "./RoomAccessPanel.vue";
import { roomPermissionOptions } from "./room-permissions";
import { useAction } from "../../shared/use-action";
import DistributedComputePanel from "../playback/DistributedComputePanel.vue";
import PlaybackInformation from "../playback/PlaybackInformation.vue";
import PlatformMediaImport from "./PlatformMediaImport.vue";
import ChatPanel from "./ChatPanel.vue";
import PresencePanel from "./PresencePanel.vue";
import AppSegmented from "../../shared/ui/AppSegmented.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import Notice from "../../shared/ui/Notice.vue";
import { useMediaCatalog } from "../library/media-catalog.store";
import MediaThumbnail from "../library/MediaThumbnail.vue";
import PendingMediaSelection from "../library/PendingMediaSelection.vue";
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
const platformImport = ref<HTMLDetailsElement>();
async function showQueue() {
  mobilePanel.value = "queue";
  await nextTick();
  document.getElementById("room-queue")?.scrollIntoView({ block: "nearest" });
}
async function showPlatformImport() {
  await showQueue();
  if (platformImport.value) platformImport.value.open = true;
  await nextTick();
  platformImport.value?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}
const emptyRoom = computed(() => !!r.state && !r.state.media_id);
const preparationMessage = computed(() => {
  if (!r.state) return "正在读取房间内容，请稍候。";
  if (!r.roomActive) return "房间当前为只读状态，可以查看聊天记录和待播列表。";
  if (!r.connected) return "正在恢复房间连接，连接后可继续准备观看。";
  return r.can("change_media")
    ? "从媒体库选片，或把平台视频加入待播列表后开始观看。"
    : "等待有控制权限的成员选择影片，你可以先在聊天中交流。";
});
const inviteTtl = ref(24),
  inviteUses = ref(1),
  invitedAccount = ref("");
const inviteRole = ref<"viewer" | "moderator">("viewer"),
  invitePermissions = ref<RoomPermission[]>([]),
  grantTtl = ref(24);
const invitations = ref<RoomInviteRecord[]>([]);
async function loadInvites() {
  const id = r.room?.id;
  if (!id) return;
  const result = await session.api<RoomInviteRecord[]>(`/rooms/${id}/invites`);
  if (r.room?.id === id) invitations.value = result;
}
async function showInvites() {
  inviteOpen.value = true;
  await loadInvites();
}
async function revokeSaved(id: string) {
  if (!r.room) return;
  await session.api(`/rooms/${r.room.id}/invites/${id}`, "DELETE");
  await loadInvites();
}
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
      if (platformImport.value) platformImport.value.open = false;
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
  invite.value = await r.makeInvite({
    expires_in_seconds: Math.round(inviteTtl.value * 3600),
    max_uses: inviteUses.value > 0 ? inviteUses.value : null,
    invited_user_id: invitedAccount.value.trim() || null,
    role: r.canManageRoom ? inviteRole.value : "viewer",
    permissions:
      r.canManageRoom && inviteRole.value === "moderator"
        ? invitePermissions.value
        : [],
    grant_expires_in_seconds:
      grantTtl.value > 0 ? Math.round(grantTtl.value * 3600) : null,
  });
  await loadInvites();
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
        :owner="
          r.can('play') ||
          r.can('pause') ||
          r.can('seek') ||
          r.can('set_rate') ||
          r.can('change_media')
        " />
      <div class="room-opening">
        <PendingMediaSelection class="room-preparation" />
        <section
          v-if="!r.state || emptyRoom"
          class="room-preparation panel"
          aria-labelledby="room-preparation-title"
        >
          <h2 id="room-preparation-title">
            {{
              !r.state
                ? "正在准备房间"
                : r.roomActive
                  ? "开始一起观看"
                  : "房间历史"
            }}
          </h2>
          <p class="helper">{{ preparationMessage }}</p>
        </section>
        <div class="room-tools button-row" aria-label="房间常用操作">
          <RouterLink
            v-if="r.can('change_media')"
            class="button primary"
            to="/library"
          >
            <AppIcon name="movie" />{{
              emptyRoom ? "从媒体库选片" : "选择影片"
            }}
          </RouterLink>
          <button
            v-if="r.can('queue')"
            :disabled="!r.connected"
            @click="showPlatformImport"
          >
            粘贴平台链接
          </button>
          <button
            v-if="r.can('invite')"
            :disabled="busy || !r.connected"
            @click="run(showInvites)"
          >
            <AppIcon name="key" />房间邀请
          </button>
          <button @click="showQueue">
            待播列表（{{ r.playlist.length }}）
          </button>
        </div>
      </div>
      <AppSegmented
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
        <PresencePanel
          class="panel"
          :snapshot="r.presence"
          :names="r.presenceNames"
          :self-id="session.user?.id"
        />
        <ChatPanel />
        <DistributedComputePanel
          v-if="r.room && r.state && r.roomActive"
          :room-id="r.room.id"
          :media-generation="r.state.media_generation"
          :audio-index="r.audioIndex"
          :active-job="r.distributedFacts?.job_id"
          :sharing="r.peerSharing"
          :stats="r.peerStats"
          :activate="r.useDistributedOutput"
          :original="r.useOriginalSource"
          :share="r.startPeerSharing"
          :stop-sharing="r.stopPeerSharing"
        />
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
          <button
            v-if="r.canManageRoom"
            :disabled="busy || !r.state"
            @click="run(manageOwnership)"
          >
            转让房间</button
          ><button
            v-if="r.can('close') && r.roomActive"
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
            暂无待播影片。{{
              r.can("queue")
                ? "添加影片后，可在这里选择下一部。"
                : "有待播管理权限的成员可以添加影片。"
            }}
          </p>
          <div v-if="r.can('queue')" class="button-row queue-add-actions">
            <RouterLink class="button" to="/library">从媒体库添加</RouterLink>
            <button :disabled="!r.connected" @click="showPlatformImport">
              添加平台链接
            </button>
          </div>
          <article v-for="item in r.playlist" :key="item.id" class="queue-row">
            <MediaThumbnail
              small
              :cover="
                catalog.roomRecord(r.room?.id, item.media_id)?.cover ??
                item.cover
              "
              :alt="
                catalog.roomRecord(r.room?.id, item.media_id)?.title ??
                item.title
              "
            />
            <h3>
              {{
                catalog.roomRecord(r.room?.id, item.media_id)?.title ??
                item.title
              }}
            </h3>
            <button
              class="icon-button"
              :aria-label="
                '播放 ' +
                (catalog.roomRecord(r.room?.id, item.media_id)?.title ??
                  item.title)
              "
              :disabled="!r.can('change_media') || !r.connected"
              @click="r.choose(item.media_id)"
            >
              <AppIcon name="play" /></button
            ><button
              v-if="r.can('queue')"
              class="icon-button"
              :aria-label="'移除 ' + item.title"
              @click="r.run(() => r.removeQueue(item.id))"
            >
              <AppIcon name="trash" />
            </button>
          </article>
        </div>
        <details
          v-if="r.roomActive"
          ref="platformImport"
          class="platform-import-disclosure"
        >
          <summary>添加平台视频</summary>
          <PlatformMediaImport />
        </details>
        <RoomAccessPanel /></section></template
    ><AppDialog v-model="inviteOpen" title="房间邀请" drawer :busy="busy"
      ><p>
        邀请仅用于此房间，不授予私人媒体库权限。复制的邀请只显示一次，请妥善保存。
      </p>
      <label
        >邀请有效期（小时）<input
          v-model.number="inviteTtl"
          type="number"
          min="0.017"
          max="720"
      /></label>
      <label
        >可使用次数（0 为不限）<input
          v-model.number="inviteUses"
          type="number"
          min="0"
          max="10000"
          step="1"
      /></label>
      <label
        >指定受邀账户 ID（可选）<input
          v-model="invitedAccount"
          placeholder="账户 UUID"
      /></label>
      <template v-if="r.canManageRoom">
        <label
          >授予角色<select v-model="inviteRole">
            <option value="viewer">观看者</option>
            <option value="moderator">Moderator</option>
          </select></label
        >
        <fieldset v-if="inviteRole === 'moderator'">
          <legend>允许的动作</legend>
          <label
            v-for="permission in roomPermissionOptions"
            :key="permission.value"
            ><input
              v-model="invitePermissions"
              type="checkbox"
              :value="permission.value"
            />{{ permission.label }}</label
          >
        </fieldset>
        <label v-if="inviteRole === 'moderator'"
          >权限有效期（小时，0 为不限）<input
            v-model.number="grantTtl"
            type="number"
            min="0"
            max="8760"
        /></label>
      </template>
      <button
        class="primary"
        :disabled="busy || !r.can('invite')"
        @click="run(generate)"
      >
        生成邀请
      </button>
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
      </div>
      <h3 v-if="invitations.length">已创建邀请</h3>
      <article v-for="item in invitations" :key="item.id">
        <p>
          {{ item.role === "moderator" ? "Moderator" : "观看者" }} · 已使用
          {{ item.use_count }} / {{ item.max_uses ?? "不限" }} ·
          {{ item.revoked ? "已撤销" : item.expired ? "已过期" : "有效" }}
        </p>
        <p v-if="item.invited_user_id" class="helper">
          受邀账户 {{ item.invited_user_id }}
        </p>
        <button
          v-if="!item.revoked && !item.expired"
          :disabled="busy"
          @click="run(() => revokeSaved(item.id))"
        >
          撤销邀请
        </button>
      </article></AppDialog
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
          :disabled="
            busy ||
            (lifecycleAction === 'close' ? !r.can('close') : !r.canManageRoom)
          "
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
        :disabled="busy || !r.canManageRoom"
      />
      <p v-if="!ownerOptions.length" class="helper">
        请先邀请其他成员加入房间。
      </p>
      <Notice :message="error" error />
      <div class="button-row">
        <button
          class="danger"
          :disabled="busy || !selectedOwner || !r.canManageRoom || !r.connected"
          @click="run(transferOwnership)"
        >
          确认转让
        </button>
        <button :disabled="busy" @click="ownershipOpen = false">取消</button>
      </div>
    </AppDialog>
  </section>
</template>
