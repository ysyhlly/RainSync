<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useSession } from "../auth/session.store";
import { useRoomRuntime } from "./room-runtime";
import { roomsApi } from "./rooms.api";
import { createRoomSubmission } from "./room-creation";
import type { Room } from "../../shared/api/types";
import { useAction } from "../../shared/use-action";
import AppDialog from "../../shared/ui/AppDialog.vue";
import AppIcon from "../../shared/ui/AppIcon.vue";
import AppSelect from "../../shared/ui/AppSelect.vue";
import {
  filterRooms,
  lifecycleLabels,
  type RoomFilter,
} from "./room-lifecycle";
import Notice from "../../shared/ui/Notice.vue";
import PendingMediaSelection from "../library/PendingMediaSelection.vue";
const session = useSession(),
  runtime = useRoomRuntime(),
  api = roomsApi(session.api),
  router = useRouter();
const { busy, error, run } = useAction();
const { busy: loading, error: loadError, run: runLoad } = useAction();
const submitRoom = createRoomSubmission(api.create, () => session.user?.id);
const rooms = ref<Room[]>([]),
  loaded = ref(false),
  createOpen = ref(false),
  joinOpen = ref(false),
  name = ref(""),
  roomId = ref(""),
  token = ref(""),
  pasted = ref("");
const inviteParsed = ref(false);
let navigationIntent = 0;
watch(
  [createOpen, joinOpen],
  ([create, join], [previousCreate, previousJoin]) => {
    if ((create && !previousCreate) || (join && !previousJoin))
      ++navigationIntent;
  },
  { flush: "sync" },
);
watch(
  pasted,
  () => {
    roomId.value = "";
    token.value = "";
    inviteParsed.value = false;
    error.value = "";
  },
  { flush: "sync" },
);
const lifecycleFilter = ref<RoomFilter>("all"),
  roomSearch = ref("");
const visibleRooms = computed(() => {
  const query = roomSearch.value.trim().toLocaleLowerCase();
  return filterRooms(rooms.value, lifecycleFilter.value).filter((room) =>
    room.name.toLocaleLowerCase().includes(query),
  );
});
function clearFilters() {
  lifecycleFilter.value = "all";
  roomSearch.value = "";
}
watch([createOpen, joinOpen], () => {
  error.value = "";
});
watch(joinOpen, (open) => {
  if (!open) {
    token.value = "";
    pasted.value = "";
    roomId.value = "";
    inviteParsed.value = false;
  }
});
const lifecycleOptions = [
  { value: "all", label: "全部房间" },
  ...Object.entries(lifecycleLabels).map(([value, label]) => ({
    value,
    label,
  })),
];
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
async function reload() {
  let succeeded = false;
  await runLoad(async () => {
    await load();
    succeeded = true;
  });
  return succeeded;
}
function retryLoad() {
  error.value = "";
  void reload();
}
async function enter(room: Room, intent = navigationIntent) {
  if (!alive || intent !== navigationIntent) return;
  await runtime.enter(room);
  if (!alive || intent !== navigationIntent) return;
  await router.push("/rooms/" + room.id);
}
function submitCreate() {
  if (busy.value) return;
  return run(create);
}
async function create() {
  const submittedName = name.value,
    intent = navigationIntent;
  if (!submittedName.trim() || [...submittedName].length > 120)
    throw Error("房间名称须为1–120个字符");
  const result = await submitRoom(submittedName);
  if (!alive) return;
  const sameDraft = name.value === submittedName;
  if (sameDraft) {
    createOpen.value = false;
    name.value = "";
  }
  if (!(await reload())) return;
  if (
    !alive ||
    intent !== navigationIntent ||
    !sameDraft ||
    createOpen.value ||
    joinOpen.value ||
    name.value !== ""
  )
    return;
  const room = rooms.value.find((r) => r.id === result.id);
  if (room) await enter(room, intent);
}
function parse() {
  try {
    const value = JSON.parse(pasted.value);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.room_id !== "string" ||
      !value.room_id.trim() ||
      typeof value.token !== "string" ||
      !value.token.trim()
    )
      throw Error();
    roomId.value = value.room_id.trim();
    token.value = value.token.trim();
    inviteParsed.value = true;
    error.value = "";
    return true;
  } catch {
    roomId.value = "";
    token.value = "";
    inviteParsed.value = false;
    error.value =
      "请粘贴完整房间邀请JSON，或清空粘贴内容后分别填写房间ID与邀请token。";
    return false;
  }
}
async function join() {
  if (pasted.value.trim() && !parse()) return;
  const joinedRoomId = roomId.value.trim();
  await api.join(joinedRoomId, token.value.trim());
  if (!alive) return;
  joinOpen.value = false;
  token.value = "";
  pasted.value = "";
  if (!(await reload())) return;
  if (!alive) return;
  const room = rooms.value.find((r) => r.id === joinedRoomId);
  if (room) await enter(room);
}
onMounted(reload);
</script>
<template>
  <section class="page rooms-page">
    <div class="page-title">
      <div class="page-intro">
        <p class="section-label">观看区</p>
        <h1>放映室</h1>
        <p>选择一个房间继续观看，或邀请朋友一起开始。</p>
      </div>
      <div class="button-row">
        <button @click="joinOpen = true">通过邀请加入</button>
        <button class="primary" @click="createOpen = true">
          <AppIcon name="plus" />创建房间
        </button>
      </div>
    </div>
    <div class="page-stack">
      <PendingMediaSelection />
      <div
        v-if="(loadError || error) && !createOpen && !joinOpen"
        class="surface-card surface-card--compact"
      >
        <Notice :message="loadError" error />
        <Notice :message="error" error />
        <button :disabled="busy || loading" @click="retryLoad">
          <AppIcon name="refresh" />重新加载
        </button>
      </div>
      <div v-if="loading && !loaded" class="loading-state" role="status">
        <AppIcon name="rooms" :size="32" />
        <p>正在加载放映室…</p>
      </div>
      <div v-else-if="loaded && !rooms.length" class="empty-state surface-card">
        <span class="empty-state__icon"
          ><AppIcon name="rooms" :size="28"
        /></span>
        <h2>还没有加入放映室</h2>
        <p>
          创建自己的放映室，或向朋友获取房间邀请。注册邀请码只用于创建账号。
        </p>
        <div class="button-row">
          <button class="primary" @click="createOpen = true">
            创建第一个房间
          </button>
          <button @click="joinOpen = true">使用房间邀请</button>
        </div>
      </div>
      <template v-if="loaded && rooms.length">
        <div class="toolbar room-filters">
          <label class="toolbar__field">
            <span class="sr-only">搜索放映室</span>
            <input
              v-model="roomSearch"
              type="search"
              placeholder="搜索房间名称"
            />
          </label>
          <AppSelect
            v-model="lifecycleFilter"
            :options="lifecycleOptions"
            label="房间状态"
          />
          <p class="helper" role="status">{{ visibleRooms.length }} 个房间</p>
          <button
            v-if="roomSearch || lifecycleFilter !== 'all'"
            class="text-button"
            @click="clearFilters"
          >
            清除筛选
          </button>
        </div>
        <div
          v-if="!visibleRooms.length"
          class="empty-state empty-state--compact surface-card"
        >
          <span class="empty-state__icon"
            ><AppIcon name="search" :size="28"
          /></span>
          <h2>没有匹配的放映室</h2>
          <p>换个房间名称，或切换状态查看其他房间。</p>
          <button @click="clearFilters">查看全部房间</button>
        </div>
        <div class="room-list" :aria-busy="busy || loading">
          <article
            v-for="room in visibleRooms"
            :key="room.id"
            class="room-card surface-card"
          >
            <div class="room-symbol"><AppIcon name="rooms" :size="28" /></div>
            <div>
              <div class="room-card-heading">
                <h2>{{ room.name }}</h2>
                <span
                  class="status-badge"
                  :class="{
                    'status-badge--success':
                      !room.lifecycle || room.lifecycle === 'active',
                  }"
                >
                  {{ lifecycleLabels[room.lifecycle ?? "active"] }}
                </span>
              </div>
              <p>
                {{
                  room.owner_id === session.user?.id
                    ? "我创建的放映室"
                    : "已加入的放映室"
                }}
              </p>
            </div>
            <button
              :class="{ primary: runtime.room?.id === room.id }"
              :disabled="busy"
              @click="run(() => enter(room))"
            >
              {{ runtime.room?.id === room.id ? "返回房间" : "进入房间"
              }}<AppIcon name="next" />
            </button>
          </article>
        </div>
      </template>
    </div>
    <AppDialog v-model="createOpen" title="创建房间" drawer :busy="busy">
      <form :aria-busy="busy" @submit.prevent="submitCreate">
        <p class="helper">取一个容易认出的名字，创建后即可邀请朋友加入。</p>
        <label
          >房间名称<input
            v-model="name"
            :disabled="busy"
            required
            autofocus
            maxlength="240"
            autocomplete="off"
            placeholder="例如：周末放映室"
        /></label>
        <p class="helper">最多120个字符。</p>
        <Notice :message="error" error />
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="createOpen = false">
            取消
          </button>
          <button class="primary" :disabled="busy">
            {{ busy ? "正在创建…" : "创建并进入" }}
          </button>
        </div>
      </form>
    </AppDialog>
    <AppDialog v-model="joinOpen" title="通过邀请加入" drawer :busy="busy">
      <form @submit.prevent="!busy && run(join)">
        <p class="helper">
          粘贴朋友发送的完整邀请，或直接填写房间 ID 和邀请 token。
        </p>
        <label
          >粘贴完整房间邀请<textarea
            v-model="pasted"
            spellcheck="false"
            @change="parse"
          />
        </label>
        <button type="button" @click="parse">解析邀请</button>
        <label
          >房间 ID<input v-model="roomId" required autocomplete="off"
        /></label>
        <label
          >邀请 token<input v-model="token" required autocomplete="off"
        /></label>
        <p class="helper">
          请使用房间邀请，注册邀请码不能加入房间。修改粘贴内容后，需重新解析邀请。
        </p>
        <Notice :message="error" error />
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="joinOpen = false">
            取消
          </button>
          <button
            class="primary"
            :disabled="busy || (!!pasted.trim() && !inviteParsed)"
          >
            {{ busy ? "正在加入…" : "加入房间" }}
          </button>
        </div>
      </form>
    </AppDialog>
  </section>
</template>
<style scoped>
.room-filters > .app-select {
  width: min(100%, 13rem);
}
.room-card-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.room-card-heading h2 {
  min-width: 0;
}
@media (max-width: 600px) {
  .room-filters > .app-select {
    width: 100%;
  }
}
</style>
