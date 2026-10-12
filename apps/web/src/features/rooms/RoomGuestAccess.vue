<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useRoomRuntime } from "./room-runtime";
import { useSession } from "../auth/session.store";
import { useAction } from "../../shared/use-action";
import AppDialog from "../../shared/ui/AppDialog.vue";
import Notice from "../../shared/ui/Notice.vue";
const r = useRoomRuntime(),
  session = useSession();
const { busy, error, message, run } = useAction();
const open = ref(false),
  enabled = ref(false),
  globalEnabled = ref(false),
  loaded = ref(false);
let serial = 0,
  room = "";
interface GuestAccess {
  enabled: boolean;
  guests_enabled: boolean;
}
function cancel() {
  ++serial;
  open.value = false;
  loaded.value = false;
  room = "";
}
watch(() => [r.room?.id, session.epoch], cancel);
onBeforeUnmount(cancel);
async function show() {
  const id = r.room?.id,
    identity = session.epoch,
    request = ++serial;
  if (!id || !r.canManageRoom) return;
  loaded.value = false;
  open.value = true;
  const value = await session.api<GuestAccess>(`/rooms/${id}/guest-access`);
  if (
    serial !== request ||
    r.room?.id !== id ||
    identity !== session.epoch ||
    !open.value
  )
    return;
  room = id;
  enabled.value = value.enabled;
  globalEnabled.value = value.guests_enabled;
  loaded.value = true;
}
async function save() {
  const id = room,
    request = serial,
    identity = session.epoch,
    next = enabled.value;
  if (!loaded.value || !id || r.room?.id !== id || !r.canManageRoom) return;
  await session.api(`/rooms/${id}/guest-access`, "PUT", { enabled: next });
  if (request !== serial || identity !== session.epoch || r.room?.id !== id)
    return;
  message.value = next
    ? "此房间已允许游客凭有效观看邀请进入"
    : "游客入口已关闭，现有游客会话已撤销";
}
</script>
<template>
  <button
    v-if="r.canManageRoom && r.roomActive"
    :disabled="busy"
    @click="run(show)"
  >
    游客访问
  </button>
  <AppDialog
    v-model="open"
    title="游客访问"
    drawer
    close-label="关闭游客访问"
    :busy="busy"
    @update:model-value="
      (value) => {
        if (!value) cancel();
      }
    "
  >
    <p>游客凭有效观看邀请进入，每次最多 2 小时，可观看和聊天。</p>
    <p v-if="!loaded" role="status">正在读取游客设置…</p>
    <p v-if="loaded && !globalEnabled" class="helper">
      实例的游客模式尚未开启。房主可以保存房间设置，管理员开启实例开关后才会生效。
    </p>
    <label
      ><input
        v-model="enabled"
        type="checkbox"
        :disabled="busy || !loaded"
      />允许游客凭邀请进入此房间</label
    >
    <p class="helper">
      关闭后，现有游客的连接和播放授权立即失效。重新开启不会恢复旧会话。
    </p>
    <Notice :message="error" error /><Notice :message="message" />
    <button
      class="primary"
      :disabled="busy || !loaded || !r.roomActive"
      @click="run(save)"
    >
      保存游客设置
    </button>
  </AppDialog>
</template>
