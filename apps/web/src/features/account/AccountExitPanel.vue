<script setup lang="ts">
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useSession } from "../auth/session.store";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
import AppDialog from "../../shared/ui/AppDialog.vue";
const session = useSession(),
  router = useRouter();
const identity = session.user!.id;
const { busy, error, run } = useAction();
const open = ref(false),
  password = ref(""),
  confirmation = ref("");
type Preview = {
  can_delete: boolean;
  last_admin: boolean;
  rooms: { id: string; name: string; lifecycle: string }[];
  libraries: { id: string; name: string; revision: number }[];
};
const preview = ref<Preview>();
function assertIdentity() {
  if (session.user?.id !== identity)
    throw new Error("账号已变化，请重新打开个人资料页");
}
async function load() {
  assertIdentity();
  const value = await session.api<Preview>("/users/me/deletion");
  assertIdentity();
  preview.value = value;
}
async function begin() {
  preview.value = undefined;
  open.value = true;
  await run(load);
}
async function retire() {
  assertIdentity();
  if (!preview.value?.can_delete || confirmation.value !== "DELETE") return;
  await session.api("/users/me/deletion", "POST", {
    password: password.value,
    confirmation: confirmation.value,
  });
  password.value = "";
  session.clear();
  open.value = false;
  await router.replace("/login");
}
watch(open, (value) => {
  if (!value) {
    password.value = "";
    confirmation.value = "";
  }
});
watch(
  () => session.user?.id,
  (value) => {
    if (value !== identity) {
      open.value = false;
      preview.value = undefined;
      password.value = "";
      confirmation.value = "";
    }
  },
);
</script>
<template>
  <section class="panel">
    <h2>注销账号</h2>
    <p>
      注销会退出所有设备、停止自己的播放并撤销平台登录。共享聊天和审计记录会以“已注销用户”保留。
    </p>
    <button class="danger" :disabled="busy" @click="begin">检查注销条件</button>
    <AppDialog v-model="open" title="注销账号" :busy="busy">
      <Notice :message="error" error />
      <p v-if="busy && !preview" role="status">正在检查账号资源…</p>
      <template v-if="preview">
        <p v-if="preview.last_admin">
          当前账号是唯一管理员。请先设置另一名管理员。
        </p>
        <p v-if="preview.rooms.length || preview.libraries.length">
          请先转移以下资源的所有权，再刷新检查。关闭或归档的房间也需要转移所有权。
        </p>
        <ul v-if="preview.rooms.length">
          <li v-for="room in preview.rooms" :key="room.id">
            <RouterLink :to="`/rooms/${room.id}`" @click="open = false"
              >房间：{{ room.name }}</RouterLink
            >
          </li>
        </ul>
        <ul v-if="preview.libraries.length">
          <li v-for="library in preview.libraries" :key="library.id">
            <RouterLink to="/libraries" @click="open = false"
              >私人媒体库：{{ library.name }}</RouterLink
            >
          </li>
        </ul>
        <button type="button" :disabled="busy" @click="run(load)">
          刷新检查
        </button>
        <form v-if="preview.can_delete" @submit.prevent="run(retire)">
          <p>
            注销后无法恢复此账号。自己的头像、昵称和平台凭据会被清除；他人的房间和媒体库会继续保留。
          </p>
          <label
            >当前密码<input
              v-model="password"
              type="password"
              autocomplete="current-password"
              :disabled="busy"
              required
              maxlength="1024"
          /></label>
          <label
            >输入 DELETE 确认<input
              v-model="confirmation"
              autocomplete="off"
              :disabled="busy"
              required
          /></label>
          <div class="dialog-actions">
            <button type="button" :disabled="busy" @click="open = false">
              取消
            </button>
            <button
              class="danger"
              :disabled="busy || !password || confirmation !== 'DELETE'"
            >
              {{ busy ? "正在注销…" : "永久注销账号" }}
            </button>
          </div>
        </form>
      </template>
      <button v-if="!preview && !busy" @click="run(load)">重新检查</button>
    </AppDialog>
  </section>
</template>
