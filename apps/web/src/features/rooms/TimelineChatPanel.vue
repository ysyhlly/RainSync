<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRoomRuntime } from "./room-runtime";
import { useSession } from "../auth/session.store";
import {
  displayedComments,
  mergeTimeline,
  parseActivity,
  parseTimelinePage,
  reactionEmoji,
  timeLabel,
  type MediaActivity,
  type TimelineComment,
} from "./timeline-chat";
import type { RoomMember } from "../../shared/api/types";
const r = useRoomRuntime(),
  session = useSession();
const opened = ref(false),
  current = ref<MediaActivity | null>(null),
  activities = ref<MediaActivity[]>([]),
  selected = ref(""),
  comments = ref<TimelineComment[]>([]),
  nextBefore = ref<string | null>(null),
  text = ref(""),
  anchor = ref("client_reported"),
  hideFuture = ref(true),
  ordered = ref(true),
  showReactions = ref(true),
  error = ref(""),
  busy = ref(false),
  canModerate = ref(false),
  canAssign = ref(false),
  members = ref<RoomMember[]>([]),
  target = ref(""),
  action = ref("mute"),
  reason = ref(""),
  audit = ref<{ id: string; action: string; reason: string }[]>([]),
  manageOpen = ref(false),
  targetModerator = ref(true);
const reactions = ref<{ id: string; emoji: string; until: number }[]>([]);
let serial = 0,
  pollSerial = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined,
  pending: Record<string, unknown> | undefined;
const failed = ref(false);
const atMs = computed(() => Math.max(0, Math.round(r.position * 1000)));
const visible = computed(() =>
  displayedComments(
    comments.value,
    atMs.value,
    hideFuture.value,
    ordered.value,
  ),
);
const currentSelected = computed(
  () => !!current.value && selected.value === current.value.id,
);
const prefix = () => `/rooms/${r.room?.id}/timeline`;
function reset() {
  ++serial;
  controller?.abort();
  clearTimeout(timer);
  comments.value = [];
  activities.value = [];
  selected.value = "";
  current.value = null;
  reactions.value = [];
  pending = undefined;
  failed.value = false;
  busy.value = false;
  error.value = "";
  manageOpen.value = false;
  audit.value = [];
}
function activeRequest() {
  controller?.abort();
  controller = new AbortController();
  return AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
}
async function load(before?: string) {
  const room = r.room?.id,
    sequence = serial,
    activity = selected.value;
  if (!room || !activity) return;
  const value = await session.api(
    `${prefix()}/messages?activity_id=${activity}${before ? `&before=${before}` : ""}`,
    "GET",
    undefined,
    AbortSignal.timeout(15000),
  );
  if (sequence !== serial || r.room?.id !== room || selected.value !== activity)
    return;
  const page = parseTimelinePage(value, activity);
  comments.value = mergeTimeline(comments.value, page.items);
  if (before || comments.value.length <= 100)
    nextBefore.value = page.nextBefore;
}
async function refresh() {
  if (!opened.value || !r.room?.id) return;
  const room = r.room.id,
    sequence = serial,
    poll = ++pollSerial;
  try {
    if (document.hidden) return;
    const result = await session.api<{
      activity: unknown;
      can_moderate: boolean;
      can_assign_moderator: boolean;
    }>(`${prefix()}/current`, "GET", undefined, activeRequest());
    if (sequence !== serial || poll !== pollSerial || r.room?.id !== room)
      return;
    const activity = result.activity ? parseActivity(result.activity) : null,
      previous = current.value?.id;
    current.value = activity;
    canModerate.value = result.can_moderate === true;
    canAssign.value = result.can_assign_moderator === true;
    if (!selected.value || selected.value === previous) {
      if (selected.value !== activity?.id) {
        selected.value = activity?.id ?? "";
        comments.value = [];
        nextBefore.value = null;
        reactions.value = [];
      }
    }
    const list = await session.api<{ items: unknown[] }>(
      `${prefix()}/activities`,
      "GET",
      undefined,
      controller?.signal,
    );
    if (sequence !== serial || poll !== pollSerial || r.room?.id !== room)
      return;
    if (!Array.isArray(list.items) || list.items.length > 50)
      throw new TypeError("场次列表无效");
    activities.value = list.items.map(parseActivity);
    if (selected.value) await load();
    if (currentSelected.value && showReactions.value) {
      const events = await session.api<{
        items: { id: string; emoji: string; expires_at: number }[];
        server_now_ms: number;
      }>(
        `${prefix()}/reactions?activity_id=${selected.value}`,
        "GET",
        undefined,
        controller?.signal,
      );
      if (sequence !== serial || poll !== pollSerial || r.room?.id !== room)
        return;
      if (
        !Array.isArray(events.items) ||
        events.items.length > 200 ||
        !Number.isSafeInteger(events.server_now_ms)
      )
        throw new TypeError("表情数据无效");
      reactions.value = events.items
        .filter(
          (e) =>
            reactionEmoji.includes(e.emoji as (typeof reactionEmoji)[number]) &&
            Number.isSafeInteger(e.expires_at) &&
            e.expires_at > events.server_now_ms &&
            e.expires_at - events.server_now_ms <= 8000,
        )
        .slice(-30)
        .map((e) => ({
          id: e.id,
          emoji: e.emoji,
          until: Date.now() + e.expires_at - events.server_now_ms,
        }));
    } else reactions.value = [];
  } catch (e) {
    if (
      sequence === serial &&
      poll === pollSerial &&
      !(e instanceof DOMException && e.name === "AbortError")
    )
      error.value = e instanceof Error ? e.message : "评论加载失败";
  } finally {
    if (sequence === serial && poll === pollSerial && opened.value)
      timer = setTimeout(() => void refresh(), error.value ? 10000 : 3000);
  }
}
watch(
  () => [opened.value, r.room?.id, session.epoch] as const,
  () => {
    reset();
    if (opened.value) void refresh();
  },
);
watch(
  () =>
    [
      r.state?.media_id,
      r.state?.media_generation,
      r.room?.lifecycle_epoch,
    ] as const,
  () => {
    if (opened.value) {
      clearTimeout(timer);
      controller?.abort();
      ++serial;
      void refresh();
    }
  },
);
function tombstone(ids: ReadonlySet<string>) {
  comments.value = comments.value.map((m) =>
    ids.has(m.id) ? { ...m, deleted: true, body: "" } : m,
  );
}
watch(
  () => r.lastChatDeletion,
  (id) => {
    if (id) tombstone(new Set([id]));
  },
);
watch(
  () => r.messages,
  () =>
    tombstone(new Set(r.messages.filter((m) => m.deleted).map((m) => m.id))),
  { deep: true },
);
watch(
  () => r.connected,
  async (connected, previous) => {
    if (!connected || previous || !opened.value || !comments.value.length)
      return;
    const sequence = serial,
      room = r.room?.id,
      cached = comments.value.map((m) => m.id);
    try {
      for (let i = 0; i < cached.length; i += 100) {
        const history = await session.api<{ id: string; deleted?: boolean }[]>(
          `/rooms/${room}/messages?check_ids=${cached.slice(i, i + 100).join(",")}`,
        );
        if (sequence !== serial || r.room?.id !== room) return;
        tombstone(new Set(history.filter((m) => m.deleted).map((m) => m.id)));
      }
    } catch (e) {
      if (sequence === serial)
        error.value = e instanceof Error ? e.message : "评论删除状态核对失败";
    }
  },
);
watch(selected, async (value, old) => {
  if (value === old) return;
  comments.value = [];
  nextBefore.value = null;
  reactions.value = [];
  try {
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
watch(text, () => {
  if (!busy.value && failed.value) {
    pending = undefined;
    failed.value = false;
  }
});
async function send() {
  if (
    !currentSelected.value ||
    !r.roomActive ||
    !text.value.trim() ||
    busy.value
  )
    return;
  const room = r.room?.id,
    sequence = serial;
  error.value = "";
  busy.value = true;
  pending ??= {
    client_message_id: crypto.randomUUID(),
    activity_id: selected.value,
    body: text.value,
    anchor_source: anchor.value,
    ...(anchor.value === "client_reported"
      ? { media_time_ms: atMs.value }
      : {}),
  };
  try {
    const result = await session.api<{ message: unknown }>(
      `${prefix()}/messages`,
      "POST",
      pending,
      AbortSignal.timeout(15000),
    );
    if (sequence !== serial || r.room?.id !== room) return;
    const page = parseTimelinePage(
      { items: [result.message], next_before: null, next_after: null },
      selected.value,
    );
    comments.value = mergeTimeline(comments.value, page.items);
    pending = undefined;
    failed.value = false;
    text.value = "";
  } catch (e) {
    if (sequence === serial) {
      failed.value = true;
      error.value =
        e instanceof Error ? e.message : "评论未确认，请用原编号重试";
    }
  } finally {
    if (sequence === serial) busy.value = false;
  }
}
async function react(emoji: string) {
  if (!currentSelected.value || !r.roomActive) return;
  const sequence = serial;
  try {
    await session.api(
      `${prefix()}/reactions`,
      "POST",
      {
        client_reaction_id: crypto.randomUUID(),
        activity_id: selected.value,
        emoji,
      },
      AbortSignal.timeout(10000),
    );
    if (sequence === serial) {
      clearTimeout(timer);
      void refresh();
    }
  } catch (e) {
    if (sequence === serial)
      error.value = e instanceof Error ? e.message : String(e);
  }
}
async function manage() {
  const room = r.room?.id,
    sequence = serial;
  try {
    const list = await session.api<RoomMember[]>(`/rooms/${room}/members`);
    if (sequence !== serial || r.room?.id !== room) return;
    members.value = list;
    manageOpen.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function moderation(messageId?: string) {
  if (!reason.value.trim()) {
    if (!manageOpen.value) await manage();
    error.value = "请填写管理原因，再执行操作";
    return;
  }
  const sequence = serial;
  busy.value = true;
  error.value = "";
  try {
    await session.api(`${prefix()}/moderation`, "POST", {
      action: messageId ? "delete" : action.value,
      reason: reason.value,
      ...(messageId
        ? { message_id: messageId }
        : {
            target_user_id: target.value,
            ...(action.value === "mute" ? { minutes: 10 } : {}),
            ...(action.value === "moderator"
              ? { moderator: targetModerator.value }
              : {}),
          }),
    });
    if (sequence !== serial) return;
    reason.value = "";
    if (messageId)
      comments.value = comments.value.map((m) =>
        m.id === messageId ? { ...m, deleted: true, body: "" } : m,
      );
  } catch (e) {
    if (sequence === serial)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (sequence === serial) busy.value = false;
  }
}
async function showAudit() {
  try {
    const sequence = serial,
      result = await session.api<{
        items: { id: string; action: string; reason: string }[];
      }>(`${prefix()}/audit`);
    if (sequence === serial) audit.value = result.items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
onBeforeUnmount(() => reset());
</script>
<template>
  <section class="timeline-chat" aria-label="时间轴评论">
    <button
      class="timeline-toggle"
      :aria-expanded="opened"
      @click="opened = !opened"
    >
      {{ opened ? "收起时间轴评论" : "时间轴评论与表情" }}
    </button>
    <div v-if="opened">
      <p class="helper">
        评论绑定本次共同观影场次；我的画面位置由本机报告，房间位置由服务器接收时推算
      </p>
      <label
        >观影场次<select v-model="selected">
          <option value="">当前无可用点播场次</option>
          <option v-for="a in activities" :key="a.id" :value="a.id">
            {{ a.id === current?.id ? "当前场次" : "历史场次" }} · 第{{
              a.media_generation
            }}次切片 ·
            {{
              a.created_at
                ? new Date(a.created_at).toLocaleString("zh-CN")
                : a.id.slice(0, 8)
            }}
          </option>
        </select></label
      >
      <p v-if="current && !current.versioned" class="helper">
        片源未提供版本标识，已按目录身份隔离场次；同一远程地址内容变化仍需重新选择影片
      </p>
      <div class="timeline-preferences">
        <label
          ><input
            v-model="hideFuture"
            type="checkbox"
          />隐藏当前进度之后的评论</label
        ><label
          ><input v-model="ordered" type="checkbox" />按影片时间排序</label
        >
      </div>
      <p class="helper">
        当前画面 {{ timeLabel(atMs) }}；隐藏未来评论仅影响展示
      </p>
      <button v-if="nextBefore" :disabled="busy" @click="load(nextBefore)">
        加载更早评论
      </button>
      <div class="timeline-log" role="log" aria-live="polite">
        <p v-if="!visible.length" class="helper">当前没有可显示的评论</p>
        <article v-for="m in visible" :key="m.id">
          <b>{{ m.display_name }}</b
          ><small
            >{{ timeLabel(m.media_time_ms) }} ·
            {{
              m.anchor_source === "client_reported" ? "本机画面" : "房间位置"
            }}</small
          >
          <p>{{ m.deleted ? "消息已删除" : m.body }}</p>
          <button
            v-if="canModerate && !m.deleted"
            class="small-delete"
            :disabled="busy"
            @click="moderation(m.id)"
          >
            删除
          </button>
        </article>
      </div>
      <form v-if="currentSelected" @submit.prevent="send">
        <label
          >评论位置<select v-model="anchor" :disabled="busy || failed">
            <option value="client_reported">我看到的位置</option>
            <option value="server_received">当前房间位置</option>
          </select></label
        ><label
          >时间轴评论<input
            v-model="text"
            maxlength="2000"
            :disabled="busy || !r.roomActive"
            placeholder="评论当前画面" /></label
        ><button
          class="primary"
          :disabled="busy || !r.roomActive || !text.trim()"
        >
          {{
            busy ? "等待确认…" : failed ? "用原编号重试" : "发送评论"
          }}</button
        ><button
          v-if="failed"
          type="button"
          @click="
            pending = undefined;
            failed = false;
          "
        >
          放弃未确认消息
        </button>
      </form>
      <div v-if="currentSelected" class="reaction-controls">
        <label
          ><input
            v-model="showReactions"
            type="checkbox"
          />显示近期房间表情</label
        >
        <div class="emoji-buttons">
          <button
            v-for="emoji in reactionEmoji"
            :key="emoji"
            :disabled="!r.roomActive"
            :aria-label="`发送表情 ${emoji}`"
            @click="react(emoji)"
          >
            {{ emoji }}
          </button>
        </div>
        <p class="helper">房间即时反应：每秒2次，突发最多5次，8秒后消失</p>
        <div v-if="showReactions" class="recent-reactions" aria-live="off">
          <span
            v-for="e in reactions.filter((e) => e.until > Date.now())"
            :key="e.id"
            >{{ e.emoji }}</span
          >
        </div>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button v-if="canModerate" @click="manage">管理聊天</button>
      <div v-if="manageOpen && canModerate" class="moderation-form">
        <label
          >管理原因<input
            v-model="reason"
            maxlength="200"
            placeholder="删除消息也需填写原因" /></label
        ><label
          >成员<select v-model="target">
            <option value="">选择成员</option>
            <option v-for="m in members" :key="m.id" :value="m.id">
              {{ m.display_name }} (@{{ m.username }})
            </option>
          </select></label
        ><label
          >操作<select v-model="action">
            <option value="mute">禁言10分钟</option>
            <option value="unmute">解除禁言</option>
            <option value="remove">移除房间成员</option>
            <option v-if="canAssign" value="moderator">设置聊天管理员</option>
          </select></label
        ><label v-if="action === 'moderator'"
          ><input
            v-model="targetModerator"
            type="checkbox"
          />授予聊天管理权限（取消勾选可撤销）</label
        ><button
          :disabled="busy || !target || !reason.trim()"
          @click="moderation()"
        >
          执行管理操作</button
        ><button @click="showAudit">查看管理记录</button
        ><button @click="manageOpen = false">收起</button>
        <ul v-if="audit.length">
          <li v-for="a in audit" :key="a.id">{{ a.action }}：{{ a.reason }}</li>
        </ul>
      </div>
    </div>
  </section>
</template>
<style scoped>
.timeline-chat {
  border-top: 1px solid var(--border, #ddd);
  padding: 12px;
  margin-top: 8px;
  min-width: 0;
}
.timeline-toggle {
  width: 100%;
}
.timeline-chat label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
}
.timeline-chat select,
.timeline-chat input:not([type="checkbox"]) {
  max-width: 100%;
  min-width: 0;
  flex: 1;
}
.timeline-log {
  max-height: 300px;
  overflow: auto;
}
.timeline-log article {
  padding: 8px 0;
  border-bottom: 1px solid var(--border, #ddd);
  overflow-wrap: anywhere;
}
.timeline-log small {
  margin-left: 8px;
}
.timeline-log p {
  margin: 4px 0;
}
.timeline-preferences {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.timeline-log .small-delete {
  font-size: 12px;
  padding: 2px 8px;
}
.emoji-buttons,
.recent-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.recent-reactions span {
  font-size: 24px;
  animation: reaction-in 180ms ease-out;
}
.moderation-form {
  padding: 8px;
  border: 1px solid var(--border, #ddd);
  margin-top: 8px;
}
.error {
  color: #973b32;
}
@keyframes reaction-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .recent-reactions span {
    animation: none;
  }
}
</style>
