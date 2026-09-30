<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "./room-runtime";
import { roomsApi } from "./rooms.api";
import type { Room } from "../../shared/api/types";
import { useAction } from "../../shared/use-action";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import Notice from "../../shared/ui/Notice.vue";
const session = useSession(),
  runtime = useRoomRuntime(),
  api = roomsApi(session.api),
  router = useRouter();
const { busy, error, run } = useAction();
const rooms = ref<Room[]>([]),
  loaded = ref(false),
  createOpen = ref(false),
  joinOpen = ref(false),
  name = ref(""),
  roomId = ref(""),
  token = ref(""),
  pasted = ref("");
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  token.value = "";
  pasted.value = "";
});
async function load() {
  const value = await api.list();
  if (!alive) return;
  rooms.value = value;
  loaded.value = true;
}
async function enter(room: Room) {
  await runtime.enter(room);
  if (!alive) return;
  await router.push("/rooms/" + room.id);
}
async function create() {
  if (!name.value.trim() || [...name.value].length > 120)
    throw Error("房间名称须为1–120个字符");
  const result = await api.create(name.value);
  if (!alive) return;
  createOpen.value = false;
  name.value = "";
  await load();
  if (!alive) return;
  const room = rooms.value.find((r) => r.id === result.id);
  if (room) await enter(room);
}
function parse() {
  try {
    const value = JSON.parse(pasted.value);
    if (typeof value.room_id !== "string" || typeof value.token !== "string")
      throw Error();
    roomId.value = value.room_id;
    token.value = value.token;
    error.value = "";
  } catch {
    error.value = "请粘贴完整房间邀请JSON，或分别填写房间ID与邀请token。";
  }
}
async function join() {
  await api.join(roomId.value, token.value);
  if (!alive) return;
  joinOpen.value = false;
  token.value = "";
  pasted.value = "";
  await load();
  if (!alive) return;
  const room = rooms.value.find((r) => r.id === roomId.value);
  if (room) await enter(room);
}
onMounted(() => run(load));
</script>
<template>
  <section class="page">
    <div class="page-title">
      <div>
        <p class="section-label">观看区</p>
        <h1>放映室</h1>
        <p>创建放映室，或使用房间邀请加入。</p>
      </div>
      <div class="button-row">
        <button @click="joinOpen = true">通过邀请加入</button
        ><button class="primary" @click="createOpen = true">
          <AppIcon name="plus" />创建房间
        </button>
      </div>
    </div>
    <Notice v-if="!createOpen && !joinOpen" :message="error" error /><button
      v-if="error && !createOpen && !joinOpen"
      @click="run(load)"
    >
      重新加载
    </button>
    <p v-if="busy && !loaded" role="status">正在加载放映室…</p>
    <div v-else-if="loaded && !rooms.length" class="empty-state">
      <AppIcon name="rooms" :size="40" />
      <h2>还没有加入放映室</h2>
      <p>注册邀请码只用于创建账号。加入房间需要独立的房间邀请。</p>
      <button class="primary" @click="createOpen = true">创建第一个房间</button>
    </div>
    <div class="room-list">
      <article v-for="room in rooms" :key="room.id" class="room-card">
        <div class="room-symbol"><AppIcon name="rooms" :size="28" /></div>
        <div>
          <h2>{{ room.name }}</h2>
          <p>
            {{
              room.owner_id === session.user?.id
                ? "我创建的放映室"
                : "已加入的放映室"
            }}
          </p>
        </div>
        <button :disabled="busy" @click="run(() => enter(room))">
          {{ runtime.room?.id === room.id ? "返回房间" : "进入房间"
          }}<AppIcon name="next" />
        </button>
      </article>
    </div>
    <AppDialog v-model="createOpen" title="创建房间" drawer :busy="busy"
      ><form @submit.prevent="run(create)">
        <label
          >房间名称<input
            v-model="name"
            required
            autofocus
            maxlength="240"
            autocomplete="off"
        /></label>
        <p class="helper">最多120个字符。</p>
        <Notice :message="error" error /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在创建…" : "创建并进入" }}
        </button>
      </form></AppDialog
    ><AppDialog v-model="joinOpen" title="通过邀请加入" drawer :busy="busy"
      ><form @submit.prevent="run(join)">
        <label
          >粘贴完整房间邀请<textarea
            v-model="pasted"
            spellcheck="false"
            @change="parse"
          /></label
        ><button type="button" @click="parse">解析邀请</button
        ><label
          >房间 ID<input v-model="roomId" required autocomplete="off" /></label
        ><label
          >邀请 token<input v-model="token" required autocomplete="off"
        /></label>
        <p class="helper">请使用房间邀请，注册邀请码不能加入房间。</p>
        <Notice :message="error" error /><button
          class="primary"
          :disabled="busy"
        >
          {{ busy ? "正在加入…" : "加入房间" }}
        </button>
      </form></AppDialog
    >
  </section>
</template>
