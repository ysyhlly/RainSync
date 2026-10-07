<script setup lang="ts">
import "../../styles/room-layout.css";
import QueueFeedback from "./QueueFeedback.vue";
import RoomMediaPicker from "./RoomMediaPicker.vue";
import RoomViewingToolbar from "./RoomViewingToolbar.vue";
import { createRoomViewingMode } from "./room-viewing-mode";
import {
  computed,
  ref,
  watch,
  nextTick,
  onBeforeUnmount,
  onMounted,
} from "vue";
import {
  useRoute,
  useRouter,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
} from "vue-router";
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
import RoomGuestAccess from "./RoomGuestAccess.vue";
import { roomPermissionOptions } from "./room-permissions";
import { useAction } from "../../shared/use-action";
import DistributedComputePanel from "../playback/DistributedComputePanel.vue";
import RoomPlayerAnchor from "../playback/RoomPlayerAnchor.vue";
import PlatformMediaImport from "./PlatformMediaImport.vue";
import ChatPanel from "./ChatPanel.vue";
import PresencePanel from "./PresencePanel.vue";
import UserAvatar from "../../shared/ui/UserAvatar.vue";
import RoomLayoutCanvas from "../room-layout/RoomLayoutCanvas.vue";
import RoomLayoutToolbar from "../room-layout/RoomLayoutToolbar.vue";
import RoomWidgetCatalog from "../room-layout/RoomWidgetCatalog.vue";
import { useRoomLayout } from "../room-layout/layout-controller";
import {
  NARROW_BREAKPOINT_PX,
  type LayoutBreakpoint,
  type WidgetType,
} from "../room-layout/layout-model";
import { formatTime } from "../../shared/use-action";
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
  managementOpen = ref(false),
  platformOpen = ref(false),
  catalogOpen = ref(false),
  mediaPickerOpen = ref(false);
const canBrowseMedia = computed(
  () =>
    !!session.user &&
    !session.user.guest &&
    r.roomActive &&
    (r.can("change_media") || r.can("queue")),
);
// Dismiss the temporary picker on Back without adding a synthetic history entry.
function dismissMediaPicker() {
  if (!mediaPickerOpen.value) return;
  mediaPickerOpen.value = false;
  return false;
}
onBeforeRouteLeave(dismissMediaPicker);
onBeforeRouteUpdate(dismissMediaPicker);
watch(
  [() => session.epoch, () => r.room?.id, canBrowseMedia],
  () => {
    mediaPickerOpen.value = false;
  },
  { flush: "sync" },
);
const platformImport = ref<HTMLElement>();
const layoutCanvas = ref<InstanceType<typeof RoomLayoutCanvas>>();
const roomPage = ref<HTMLElement>();
const viewing = createRoomViewingMode(document);
const {
  expanded: viewingExpanded,
  mode: viewingMode,
  chatVisible,
  pending: viewingPending,
  error: viewingError,
} = viewing;
// Route guards run after picker dismissal, so Back first closes the picker.
onBeforeRouteLeave(() => {
  void viewing.reset();
});
onBeforeRouteUpdate(() => {
  void viewing.reset();
});
watch(
  () => session.epoch,
  () => {
    void viewing.reset();
  },
);
function viewingKey(event: KeyboardEvent) {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    document.fullscreenElement ||
    viewing.browser.value ||
    document.querySelector("dialog[open]")
  )
    return;
  if (viewing.webpage.value) {
    event.preventDefault();
    void viewing.toggleWebpage();
  }
}
onMounted(() => document.addEventListener("keydown", viewingKey));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", viewingKey);
  void viewing.dispose();
});
const breakpoint = ref<LayoutBreakpoint>(
  window.innerWidth < NARROW_BREAKPOINT_PX ? "narrow" : "wide",
);
let widthObserver: ResizeObserver | undefined;
function updateBreakpoint(width: number) {
  if (viewingExpanded.value) return;
  const next: LayoutBreakpoint =
    width < NARROW_BREAKPOINT_PX ? "narrow" : "wide";
  if (next === breakpoint.value) return;
  layoutCanvas.value?.cancelGesture();
  breakpoint.value = next;
  catalogOpen.value = false;
}
onMounted(() => {
  if (!roomPage.value) return;
  // Profile selection follows usable canvas width, not browser chrome width.
  updateBreakpoint(roomPage.value.clientWidth);
  widthObserver = new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width > 0)
      updateBreakpoint(entry.contentRect.width);
  });
  widthObserver.observe(roomPage.value);
});
onBeforeUnmount(() => widthObserver?.disconnect());
let viewingScroll = { x: 0, y: 0 };
watch(viewingExpanded, async (expanded) => {
  if (expanded) viewingScroll = { x: window.scrollX, y: window.scrollY };
  layoutCanvas.value?.cancelGesture();
  if (!expanded) {
    await nextTick();
    if (roomPage.value) {
      updateBreakpoint(roomPage.value.clientWidth);
      window.scrollTo(viewingScroll.x, viewingScroll.y);
    }
  }
});
const {
  layout,
  editing,
  dirty,
  canUndo,
  canRedo,
  error: layoutError,
  begin,
  cancel,
  commit,
  reset,
  add,
  remove,
  move,
  resize,
  undo,
  redo,
} = useRoomLayout({ userId: computed(() => session.user?.id), breakpoint });
async function focusWidget(id: string) {
  await nextTick();
  await layoutCanvas.value?.focusWidget(id);
}
async function addWidget(type: WidgetType) {
  if (add(type)) await focusWidget(type);
}
function finishLayout() {
  layoutCanvas.value?.cancelGesture();
  if (commit()) catalogOpen.value = false;
}
function cancelLayout() {
  layoutCanvas.value?.cancelGesture();
  cancel();
  catalogOpen.value = false;
}
async function showPlatformImport() {
  platformOpen.value = true;
  await nextTick();
  await nextTick();
  platformImport.value?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}
const currentMedia = computed(() =>
  catalog.roomRecord(r.room?.id, r.state?.media_id ?? undefined),
);
const currentDuration = computed(() =>
  r.duration > 0 ? r.duration : (currentMedia.value?.duration_ms ?? 0) / 1000,
);
const playbackPermissions = computed(() =>
  roomPermissionOptions.filter(
    ({ value }) =>
      ["play", "pause", "seek", "set_rate", "change_media"].includes(value) &&
      r.can(value),
  ),
);
const canControlPlayback = computed(() => playbackPermissions.value.length > 0);
const playbackPermissionSummary = computed(() =>
  playbackPermissions.value.length === 5
    ? "你可以控制房间播放"
    : playbackPermissions.value.length
      ? `可${playbackPermissions.value.map(({ label }) => label).join("、")}`
      : "播放由房间控制者同步",
);
const knownPresence = computed(() => r.presence?.members.slice(0, 3) ?? []);
function presenceName(userId: string) {
  return userId === session.user?.id
    ? session.user.display_name
    : r.presenceNames[userId] || "房间成员";
}
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
    .filter((member) => member.id !== r.room?.owner_id && !member.guest)
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
      platformOpen.value = false;
      managementOpen.value = false;
      const serial = ++entry,
        id = String(route.params.id);
      if (r.room?.id === id) {
        r.refreshMetadata();
        await r.enter(r.room);
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
  const guest = session.user?.guest;
  await r.leave();
  if (guest) {
    await session.logout();
    await router.push("/login");
  } else await router.push("/rooms");
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
  <section
    ref="roomPage"
    class="room-content room-modular-page"
    :class="{
      'room-viewing-expanded': viewingExpanded,
      'room-viewing-with-chat': viewingExpanded && chatVisible,
    }"
    :data-viewing-mode="viewingMode"
  >
    <Notice v-if="!inviteOpen && !managementOpen" :message="error" error />
    <Notice
      v-if="!ownershipOpen && !inviteOpen && !managementOpen"
      :message="message"
    />
    <div v-if="r.room?.id !== String(route.params.id)" class="page empty-state">
      <h1>放映室</h1>
      <p v-if="busy" role="status">正在进入房间…</p>
      <RouterLink class="button" to="/rooms">返回放映室</RouterLink>
    </div>
    <template v-else>
      <RoomViewingToolbar
        :mode="viewingMode"
        :chat-visible="chatVisible"
        :pending="viewingPending"
        :editing="editing"
        :title="r.state?.media_id ? r.currentTitle : (r.room?.name ?? '放映室')"
        @webpage="viewing.toggleWebpage"
        @browser="viewing.toggleBrowser"
        @chat="viewing.toggleChat"
      >
        <button
          v-if="viewingExpanded && canBrowseMedia"
          type="button"
          aria-haspopup="dialog"
          @click="mediaPickerOpen = true"
        >
          <AppIcon name="movie" />选择影片
        </button>
      </RoomViewingToolbar>
      <Notice :message="viewingError" error class="room-viewing-error" />
      <div
        v-show="!viewingExpanded"
        class="room-command-bar"
        :class="{ 'room-command-bar--editing': editing }"
      >
        <div class="room-permanent-actions" aria-label="房间常用操作">
          <div class="room-permanent-status" role="status">
            <span class="connection-status">{{
              r.connected
                ? "房间连接正常"
                : r.connectionStopped
                  ? "连接已停止"
                  : "正在重连"
            }}</span>
            <span v-if="!r.roomActive">
              · 房间{{ r.lifecycleLabel }} · 只读</span
            >
          </div>
          <div class="button-row">
            <button
              v-if="canBrowseMedia"
              aria-haspopup="dialog"
              @click="mediaPickerOpen = true"
            >
              <AppIcon name="movie" />选择影片
            </button>
            <button
              v-if="r.can('queue') && r.roomActive"
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
              <AppIcon name="key" />邀请
            </button>
            <button v-if="!session.user?.guest" @click="managementOpen = true">
              <AppIcon name="settings" />房间管理
            </button>
            <button :disabled="busy" @click="run(leave)">离开观看</button>
          </div>
        </div>
        <RoomLayoutToolbar
          :editing="editing"
          :dirty="dirty"
          :can-undo="canUndo"
          :can-redo="canRedo"
          :error="layoutError"
          :breakpoint="breakpoint"
          @begin="begin"
          @cancel="cancelLayout"
          @commit="finishLayout"
          @reset="reset"
          @undo="undo"
          @redo="redo"
          @catalog="catalogOpen = true"
        />
      </div>
      <Notice :message="r.cleanupError" error />
      <p v-if="r.room?.lifecycle === 'closing'" class="notice" role="status">
        正在停止播放和清理媒体任务，完成后才会关闭。历史记录仍可查看。
      </p>
      <PendingMediaSelection
        v-if="!session.user?.guest"
        class="room-pending-selection"
      />
      <RoomLayoutCanvas
        ref="layoutCanvas"
        :layout="layout"
        :editing="editing"
        :viewing="viewingExpanded"
        :chat-visible="chatVisible"
        @move="({ id, x, y }) => move(id, x, y)"
        @resize="({ id, w, h }) => resize(id, w, h)"
        @remove="remove"
      >
        <template #widget="{ item, visible }">
          <div v-if="item.type === 'room-info'" class="room-information-widget">
            <h1>{{ r.room?.name }}</h1>
            <div class="room-presence-summary">
              <span class="room-avatar-stack" aria-hidden="true">
                <UserAvatar
                  v-for="member in knownPresence"
                  :key="member.userId"
                  :name="presenceName(member.userId)"
                  :url="
                    member.userId === session.user?.id
                      ? session.user?.avatar_url
                      : undefined
                  "
                  :size="36"
                />
              </span>
              <span
                :title="
                  r.presence
                    ? '仅统计已上报在线状态的连接，其他成员状态未知'
                    : undefined
                "
                >{{
                  r.presence
                    ? `${r.presence.members.length} 人已上报在线`
                    : "在线状态未知"
                }}
                ·
                {{
                  r.room?.owner_id === session.user?.id
                    ? "房主"
                    : canControlPlayback
                      ? "可控制播放"
                      : "观看者"
                }}</span
              >
            </div>
          </div>
          <RoomPlayerAnchor
            v-else-if="item.type === 'player'"
            :editing="editing"
          />
          <section
            v-else-if="item.type === 'media-info'"
            class="room-media-widget"
            aria-label="当前影片详情"
          >
            <div class="room-media-title">
              <h2>{{ r.state?.media_id ? r.currentTitle : "开始一起观看" }}</h2>
              <span v-if="r.state?.media_id" class="room-media-status">{{
                r.state.playback_status === "playing" ? "正在播放" : "已暂停"
              }}</span>
            </div>
            <p v-if="r.state?.media_id" class="helper">
              {{
                r.live
                  ? "直播"
                  : currentDuration > 0
                    ? formatTime(currentDuration)
                    : "时长未知"
              }}
              ·
              {{ playbackPermissionSummary
              }}<template v-if="r.playbackSummary">
                · {{ r.playbackSummary.mode }}</template
              >
              <template v-if="r.recoveryLabel">
                · {{ r.recoveryLabel }}</template
              >
            </p>
            <p v-else class="helper">{{ preparationMessage }}</p>
          </section>
          <div
            v-else-if="item.type === 'chat'"
            id="room-chat"
            class="room-chat-widget"
          >
            <ChatPanel :visible="visible" />
          </div>
          <section
            v-else-if="item.type === 'queue'"
            id="room-queue"
            class="room-queue-widget"
            aria-label="待播列表"
          >
            <div class="queue-widget-heading">
              <span class="helper">{{ r.playlist.length }} 部待播</span>
              <div v-if="r.can('queue')" class="button-row">
                <button
                  v-if="canBrowseMedia"
                  aria-haspopup="dialog"
                  @click="mediaPickerOpen = true"
                >
                  <AppIcon name="plus" />添加影片</button
                ><button :disabled="!r.connected" @click="showPlatformImport">
                  平台链接
                </button>
              </div>
            </div>
            <QueueFeedback />
            <p
              v-if="!r.playlistLoaded && r.playlistLoading"
              class="helper"
              role="status"
            >
              正在加载待播列表…
            </p>
            <p
              v-else-if="
                r.playlistLoaded && !r.playlist.length && !r.playlistError
              "
              class="helper"
            >
              暂无待播影片。{{
                r.can("queue")
                  ? "添加影片后，在这里选择下一部。"
                  : "等待有待播管理权限的成员添加影片。"
              }}
            </p>
            <div class="queue-widget-list">
              <article
                v-for="item in r.playlist"
                :key="item.id"
                class="queue-row"
              >
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
                  <AppIcon name="play" />
                </button>
                <button
                  v-if="r.can('queue')"
                  class="icon-button"
                  :aria-label="'移除 ' + item.title"
                  :aria-busy="r.queuePending('remove', item.id)"
                  :disabled="!r.connected || r.queuePending('remove', item.id)"
                  @click="r.run(() => r.removeQueue(item.id))"
                >
                  <AppIcon name="trash" />
                </button>
              </article>
            </div>
          </section>
          <div v-else-if="item.type === 'members'" class="room-members-widget">
            <PresencePanel
              compact
              :snapshot="r.presence"
              :names="r.presenceNames"
              :self-id="session.user?.id"
            />
          </div>
        </template>
      </RoomLayoutCanvas>
      <RoomWidgetCatalog
        v-model="catalogOpen"
        :layout="layout"
        @add="addWidget"
        @locate="focusWidget"
      />
    </template>
    <RoomMediaPicker v-model="mediaPickerOpen" />
    <AppDialog v-model="platformOpen" title="添加平台视频" drawer>
      <div ref="platformImport" class="room-platform-import">
        <PlatformMediaImport v-if="r.roomActive && r.can('queue')" />
      </div>
    </AppDialog>
    <AppDialog v-model="managementOpen" title="房间管理" drawer :busy="busy">
      <p>
        房间{{ r.lifecycleLabel }}。{{
          r.roomActive
            ? "这里的管理操作会影响整个房间。"
            : "当前为只读状态，可以查看聊天记录和待播列表。"
        }}
      </p>
      <Notice :message="r.cleanupError" error />
      <Notice :message="error" error />
      <Notice :message="message" />
      <div class="room-actions">
        <button
          v-if="r.canManageRoom"
          :disabled="busy || !r.state"
          @click="run(manageOwnership)"
        >
          转让房间
        </button>
        <button
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
        <RoomAccessPanel />
        <RoomGuestAccess />
      </div>
      <DistributedComputePanel
        v-if="managementOpen && r.room && r.state && r.roomActive"
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
    </AppDialog>
    <AppDialog v-model="inviteOpen" title="房间邀请" drawer :busy="busy"
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
