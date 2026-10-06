<script setup lang="ts">
import { ref } from "vue";
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
  members = ref<RoomMember[]>([]),
  grants = ref<RoomPermissionSnapshot>();
const selected = ref(""),
  role = ref<"viewer" | "moderator">("viewer"),
  actions = ref<RoomPermission[]>([]),
  ttl = ref(24);
let roomId = "";
async function load() {
  const id = r.room?.id;
  if (!id) return;
  const [people, permissions] = await Promise.all([
    session.api<RoomMember[]>(`/rooms/${id}/members`),
    session.api<RoomPermissionSnapshot>(`/rooms/${id}/permissions`),
  ]);
  if (r.room?.id !== id) return;
  members.value = people;
  grants.value = permissions;
  roomId = id;
}
async function show() {
  await load();
  selected.value = "";
  open.value = true;
}
function select(id: string) {
  selected.value = id;
  const grant = grants.value?.members.find((g) => g.user_id === id);
  role.value = grant?.active ? grant.role : "viewer";
  actions.value = grant?.active ? [...grant.permissions] : [];
}
async function save() {
  if (roomId !== r.room?.id || !selected.value) return;
  await session.api(`/rooms/${roomId}/permissions/${selected.value}`, "PUT", {
    role: role.value,
    permissions: role.value === "moderator" ? actions.value : [],
    expires_in_seconds: ttl.value > 0 ? Math.round(ttl.value * 3600) : null,
  });
  await load();
  message.value = "成员权限已保存";
}
async function revoke() {
  if (roomId !== r.room?.id || !selected.value) return;
  await session.api(`/rooms/${roomId}/permissions/${selected.value}`, "DELETE");
  await load();
  select(selected.value);
  message.value = "成员的委派权限已撤销";
}
async function kick() {
  if (roomId !== r.room?.id || !selected.value) return;
  await session.api(`/rooms/${roomId}/members/${selected.value}`, "DELETE");
  selected.value = "";
  await load();
  message.value = "成员已移出房间";
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
  <AppDialog v-model="open" title="成员与权限" drawer :busy="busy">
    <p>
      权限仅用于此房间，私人媒体库仍需单独授权。只有房主或管理员可授予权限。
    </p>
    <label
      >房间成员<select
        :value="selected"
        @change="select(($event.target as HTMLSelectElement).value)"
      >
        <option value="">选择成员</option>
        <option
          v-for="member in members.filter((m) => m.id !== r.room?.owner_id)"
          :key="member.id"
          :value="member.id"
        >
          {{ member.display_name }} (@{{ member.username }})
        </option>
      </select></label
    >
    <template v-if="selected && r.canManageRoom">
      <label
        >角色<select v-model="role">
          <option value="viewer">观看者</option>
          <option value="moderator">Moderator</option>
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
    <p v-if="selected">
      移出房间会终止此账户的所有房间连接和播放授权。有效邀请仍可再次加入；如需阻止再次加入，请同时撤销其邀请。
    </p>
    <button
      v-if="selected && r.can('kick')"
      class="danger"
      :disabled="busy"
      @click="run(kick)"
    >
      移出选中成员
    </button>
    <Notice :message="error" error /><Notice :message="message" />
  </AppDialog>
</template>
