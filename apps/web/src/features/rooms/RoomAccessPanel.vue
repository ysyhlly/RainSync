<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRoomRuntime } from "./room-runtime";
import { useSession } from "../auth/session.store";
import { useAction } from "../../shared/use-action";
import type {
  RoomMember,
  RoomPermission,
  RoomPermissionSnapshot,
} from "../../shared/api/types";
import { roomPermissionOptions } from "./room-permissions";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
const r = useRoomRuntime(),
  session = useSession();
const { busy, error, message, run } = useAction();
const open = ref(false),
  loading = ref(false),
  loaded = ref(false),
  members = ref<RoomMember[]>([]),
  grants = ref<RoomPermissionSnapshot>();
const selected = ref(""),
  role = ref<"viewer" | "moderator">("viewer"),
  actions = ref<RoomPermission[]>([]),
  ttl = ref(24);
const selectedGuest = computed(
  () =>
    members.value.find((member) => member.id === selected.value)?.guest ===
    true,
);
const selectedOwner = computed(() => selected.value === r.room?.owner_id);
const otherMembers = computed(() =>
  members.value.filter((member) => member.id !== r.room?.owner_id),
);
let roomId = "";
let serial = 0;
let generation = 0,
  lifetime = new AbortController();
function reset() {
  ++generation;
  lifetime.abort();
  lifetime = new AbortController();
  ++serial;
  busy.value = false;
  error.value = "";
  message.value = "";
  open.value = false;
  loading.value = false;
  loaded.value = false;
  members.value = [];
  grants.value = undefined;
  selected.value = "";
  roomId = "";
}
watch(
  () => [
    r.room?.id,
    r.room?.owner_id,
    r.roomActive,
    session.epoch,
    r.canManageRoom,
    r.can("kick"),
  ],
  reset,
  { flush: "sync" },
);
onBeforeUnmount(reset);
const requestSignal = () =>
  AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]);
const stamp = () => ({
  room: roomId,
  epoch: session.epoch,
  generation,
  target: selected.value,
});
function current(value: ReturnType<typeof stamp>) {
  return (
    value.room === r.room?.id &&
    value.epoch === session.epoch &&
    value.generation === generation &&
    value.target === selected.value
  );
}
async function load() {
  const id = r.room?.id,
    epoch = session.epoch,
    request = ++serial;
  if (!id) return;
  loading.value = true;
  try {
    const [people, permissions] = await Promise.all([
      session.api<RoomMember[]>(
        `/rooms/${id}/members`,
        "GET",
        undefined,
        requestSignal(),
      ),
      session.api<RoomPermissionSnapshot>(
        `/rooms/${id}/permissions`,
        "GET",
        undefined,
        requestSignal(),
      ),
    ]);
    if (r.room?.id !== id || session.epoch !== epoch || request !== serial)
      return;
    members.value = people;
    grants.value = permissions;
    roomId = id;
    loaded.value = true;
  } finally {
    if (request === serial) loading.value = false;
  }
}
async function show() {
  selected.value = "";
  open.value = true;
  loaded.value = false;
  await load();
}
function select(id: string) {
  selected.value = id;
  const grant = grants.value?.members.find((g) => g.user_id === id);
  role.value = grant?.active ? grant.role : "viewer";
  actions.value = grant?.active ? [...grant.permissions] : [];
}
async function save() {
  if (
    roomId !== r.room?.id ||
    !selected.value ||
    selectedGuest.value ||
    selectedOwner.value
  )
    return;
  const value = stamp();
  try {
    await session.api(
      `/rooms/${value.room}/permissions/${value.target}`,
      "PUT",
      {
        role: role.value,
        permissions: role.value === "moderator" ? actions.value : [],
        expires_in_seconds: ttl.value > 0 ? Math.round(ttl.value * 3600) : null,
      },
      requestSignal(),
    );
    if (!current(value)) return;
    await load();
    if (current(value)) message.value = "成员权限已保存";
  } catch (e) {
    if (current(value)) throw e;
  }
}
async function revoke() {
  if (roomId !== r.room?.id || !selected.value || selectedOwner.value) return;
  const value = stamp();
  try {
    await session.api(
      `/rooms/${value.room}/permissions/${value.target}`,
      "DELETE",
      undefined,
      requestSignal(),
    );
    if (!current(value)) return;
    await load();
    if (!current(value)) return;
    select(value.target);
    message.value = "成员的委派权限已撤销";
  } catch (e) {
    if (current(value)) throw e;
  }
}
async function kick() {
  if (roomId !== r.room?.id || !selected.value || selectedOwner.value) return;
  const value = stamp();
  try {
    await session.api(
      `/rooms/${value.room}/members/${value.target}`,
      "DELETE",
      undefined,
      requestSignal(),
    );
    if (!current(value)) return;
    selected.value = "";
    value.target = "";
    await load();
    if (current(value)) message.value = "成员已移出房间";
  } catch (e) {
    if (current(value)) throw e;
  }
}
</script>
<template>
  <button
    v-if="r.roomActive && (r.canManageRoom || r.can('kick'))"
    :disabled="busy"
    @click="run(show)"
  >
    成员与权限
  </button>
  <AppDialog
    v-model="open"
    title="成员与权限"
    drawer
    :busy="busy"
    close-label="关闭成员与权限"
  >
    <p>
      权限仅用于此房间，私人媒体库仍需单独授权。只有房主或管理员可授予权限。
    </p>
    <p v-if="loading" role="status">正在加载房间成员…</p>
    <p v-else-if="loaded && !otherMembers.length" class="helper">
      目前只有房主。邀请其他成员加入后，可在这里分配权限。
    </p>
    <label
      >房间成员<select
        :value="selected"
        :disabled="busy || loading || !loaded"
        @change="select(($event.target as HTMLSelectElement).value)"
      >
        <option value="">选择成员</option>
        <option v-for="member in members" :key="member.id" :value="member.id">
          {{ member.display_name }}
          {{ member.guest ? "（游客）" : `(@${member.username})` }}
          {{ member.id === r.room?.owner_id ? " · 房主" : "" }}
        </option>
      </select></label
    >
    <p v-if="selected && selectedOwner" class="helper">
      房主拥有此房间的全部管理权限。更换房主请使用“转让房间”。
    </p>
    <template
      v-if="selected && r.canManageRoom && !selectedGuest && !selectedOwner"
    >
      <label
        >角色<select v-model="role">
          <option value="viewer">观看者</option>
          <option value="moderator">协管员</option>
        </select></label
      >
      <fieldset v-if="role === 'moderator'">
        <legend>允许的动作</legend>
        <label
          v-for="permission in roomPermissionOptions"
          :key="permission.value"
          ><input
            v-model="actions"
            type="checkbox"
            :value="permission.value"
          />{{ permission.label }}</label
        >
      </fieldset>
      <label
        >权限有效期（小时，0 为不限）<input
          v-model.number="ttl"
          type="number"
          min="0"
          max="8760"
      /></label>
      <p
        v-if="grants?.members.find((g) => g.user_id === selected)?.revoked"
        class="helper"
      >
        此成员的委派权限已撤销。
      </p>
      <div class="button-row">
        <button class="primary" :disabled="busy" @click="run(save)">
          保存权限</button
        ><button :disabled="busy" @click="run(revoke)">撤销权限</button>
      </div>
    </template>
    <p v-if="selectedGuest" class="helper">
      游客固定为观看者，不能被授予房间权限或转为房主。
    </p>
    <p v-if="selected && !selectedOwner">
      移出房间会终止此账户的所有房间连接和播放授权。有效邀请仍可再次加入；如需阻止再次加入，请同时撤销其邀请。
    </p>
    <button
      v-if="selected && !selectedOwner && r.can('kick')"
      class="danger"
      :disabled="busy"
      @click="run(kick)"
    >
      移出选中成员
    </button>
    <Notice :message="error" error /><Notice :message="message" />
  </AppDialog>
</template>
