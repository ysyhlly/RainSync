<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoomRuntime } from "./room-runtime";
import { useSession } from "../auth/session.store";
import {
  displayedComments,
  parseActivity,
  parseTimelinePage,
  reactionEmoji,
  timeLabel,
  type MediaActivity,
  type TimelineComment,
} from "./timeline-chat";
import { historicalCutoffMs, mergeTimelineWindow } from "./timeline-view-state";
import type { RoomMember } from "../../shared/api/types";
const props = withDefaults(defineProps<{ visible?: boolean }>(), {
  visible: true,
});
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
  refreshError = ref(""),
  selectionError = ref(""),
  olderError = ref(""),
  revalidationError = ref(""),
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
const historyCutoffs = ref<Record<string, number | "">>({}),
  browsingOlder = ref(false),
  newerAvailable = ref(false),
  loadingOlder = ref(false),
  pageVisible = ref(!document.hidden);
let latestPage: TimelineComment[] = [],
  latestBefore: string | null = null,
  windowSerial = 0,
  submissionSerial = 0,
  revalidateOnDisplay = false,
  revalidationInFlight: AbortController | undefined;
const reactions = ref<{ id: string; emoji: string; until: number }[]>([]);
let serial = 0,
  pollSerial = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined,
  pending: Record<string, unknown> | undefined;
const failed = ref(false);
let lifetime = new AbortController();
function requestSignal(timeout: number) {
  return AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]);
}
const displayError = computed(
  () =>
    error.value ||
    selectionError.value ||
    olderError.value ||
    refreshError.value ||
    revalidationError.value,
);
const atMs = computed(() => Math.max(0, Math.round(r.position * 1000)));
const currentSelected = computed(
  () => !!current.value && selected.value === current.value.id,
);
const historicalCutoff = computed({
  get: () => historyCutoffs.value[selected.value] ?? "",
  set: (value: number | "") => {
    historyCutoffs.value[selected.value] = value;
  },
});
const cutoff = computed(() =>
  currentSelected.value
    ? atMs.value
    : historicalCutoffMs(historicalCutoff.value),
);
const visibleComments = computed(() =>
  hideFuture.value && cutoff.value === null
    ? []
    : displayedComments(
        comments.value,
        cutoff.value ?? 0,
        hideFuture.value,
        ordered.value,
      ),
);
const displayActive = computed(
  () => opened.value && props.visible && pageVisible.value,
);
const emptyMessage = computed(() => {
  if (!selected.value) return "请选择观影场次";
  if (hideFuture.value && cutoff.value === null)
    return "请设置此历史场次的浏览截止，或取消隐藏以显示全部已加载评论";
  if (comments.value.length) return "已加载的评论在当前筛选截止之后";
  return nextBefore.value
    ? "当前页暂无评论，可继续加载更早评论"
    : "此场次暂无评论";
});
const prefix = () => `/rooms/${r.room?.id}/timeline`;
function cancelRevalidation() {
  revalidationInFlight?.abort();
  revalidationInFlight = undefined;
}
function pauseDisplay() {
  ++pollSerial;
  cancelRevalidation();
  controller?.abort();
  clearTimeout(timer);
}
function discardPending(clearDraft = false) {
  ++submissionSerial;
  pending = undefined;
  failed.value = false;
  busy.value = false;
  if (clearDraft) text.value = "";
}
function clearWindow() {
  ++windowSerial;
  cancelRevalidation();
  comments.value = [];
  nextBefore.value = null;
  latestPage = [];
  latestBefore = null;
  browsingOlder.value = false;
  newerAvailable.value = false;
  loadingOlder.value = false;
  selectionError.value = "";
  olderError.value = "";
  reactions.value = [];
}
function reset() {
  lifetime.abort();
  lifetime = new AbortController();
  ++serial;
  pauseDisplay();
  clearWindow();
  activities.value = [];
  selected.value = "";
  current.value = null;
  discardPending(true);
  historyCutoffs.value = {};
  revalidateOnDisplay = false;
  revalidationError.value = "";
  refreshError.value = "";
  error.value = "";
  manageOpen.value = false;
  canModerate.value = false;
  canAssign.value = false;
  members.value = [];
  target.value = "";
  reason.value = "";
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
    window = windowSerial,
    activity = selected.value;
  if (!room || !activity) return;
  const value = await session.api(
    `${prefix()}/messages?activity_id=${activity}${before ? `&before=${before}` : ""}`,
    "GET",
    undefined,
    requestSignal(15000),
  );
  if (
    sequence !== serial ||
    window !== windowSerial ||
    r.room?.id !== room ||
    selected.value !== activity
  )
    return;
  const page = parseTimelinePage(value, activity);
  if (before) {
    olderError.value = "";
    comments.value = mergeTimelineWindow(comments.value, page.items, "older");
    nextBefore.value = page.nextBefore;
    browsingOlder.value = true;
  } else {
    selectionError.value = "";
    const previousLatest = latestPage.at(-1)?.id;
    latestPage = mergeTimelineWindow(latestPage, page.items, "latest").slice(
      -100,
    );
    latestBefore = page.nextBefore;
    if (browsingOlder.value) {
      comments.value = mergeTimelineWindow(
        comments.value,
        page.items,
        "refresh",
      );
      if (previousLatest && latestPage.at(-1)?.id !== previousLatest)
        newerAvailable.value = true;
    } else {
      comments.value = mergeTimelineWindow(
        comments.value,
        page.items,
        "latest",
      );
      nextBefore.value =
        comments.value.length > page.items.length
          ? (comments.value[0]?.id ?? null)
          : page.nextBefore;
    }
  }
}
async function loadEarlier() {
  if (!nextBefore.value || loadingOlder.value) return;
  const sequence = serial,
    window = windowSerial;
  loadingOlder.value = true;
  try {
    await load(nextBefore.value);
  } catch (e) {
    if (sequence === serial && window === windowSerial)
      olderError.value = e instanceof Error ? e.message : "更早评论加载失败";
  } finally {
    if (sequence === serial && window === windowSerial)
      loadingOlder.value = false;
  }
}
function returnLatest() {
  ++windowSerial;
  comments.value = [...latestPage];
  nextBefore.value = latestBefore;
  browsingOlder.value = false;
  newerAvailable.value = false;
  loadingOlder.value = false;
  olderError.value = "";
  pauseDisplay();
  if (displayActive.value) void refresh();
}
async function refresh() {
  if (!displayActive.value || !r.room?.id) return;
  const room = r.room.id,
    sequence = serial,
    poll = ++pollSerial;
  try {
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
    if (pending && pending.activity_id !== activity?.id) discardPending(true);
    canModerate.value = result.can_moderate === true;
    canAssign.value = result.can_assign_moderator === true;
    if (!selected.value || selected.value === previous) {
      if (selected.value !== activity?.id) {
        selected.value = activity?.id ?? "";
        clearWindow();
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
    if (sequence !== serial || poll !== pollSerial || r.room?.id !== room)
      return;
    // Retry a failed reconnect check at the existing bounded polling cadence.
    if (revalidateOnDisplay) await revalidateCached();
    if (sequence !== serial || poll !== pollSerial || r.room?.id !== room)
      return;
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
    // A recovered read clears its own diagnostic, not an unconfirmed send or
    // moderation action that still needs the user's attention.
    refreshError.value = "";
  } catch (e) {
    if (
      sequence === serial &&
      poll === pollSerial &&
      !(e instanceof DOMException && e.name === "AbortError")
    )
      refreshError.value = e instanceof Error ? e.message : "评论加载失败";
  } finally {
    if (sequence === serial && poll === pollSerial && displayActive.value)
      timer = setTimeout(
        () => void refresh(),
        displayError.value ? 10000 : 3000,
      );
  }
}
watch([() => r.room?.id, () => session.epoch], () => {
  reset();
  if (displayActive.value) void refresh();
});
watch(displayActive, (active) => {
  pauseDisplay();
  if (active) {
    if (revalidateOnDisplay) void revalidateCached();
    void refresh();
  }
});
watch(
  [
    () => r.state?.media_id,
    () => r.state?.media_generation,
    () => r.room?.lifecycle_epoch,
  ],
  () => {
    // A new media/lifecycle context cannot reuse a submission from the old one.
    ++serial;
    lifetime.abort();
    lifetime = new AbortController();
    discardPending(true);
    if (selected.value === current.value?.id) selected.value = "";
    current.value = null;
    pauseDisplay();
    if (displayActive.value) void refresh();
  },
);
function tombstone(ids: ReadonlySet<string>) {
  if (!ids.size) return;
  const scrub = (messages: TimelineComment[]) => {
    let changed = false;
    const result = messages.map((message) => {
      if (!ids.has(message.id) || (message.deleted && message.body === ""))
        return message;
      changed = true;
      return { ...message, deleted: true, body: "" };
    });
    return changed ? result : messages;
  };
  latestPage = scrub(latestPage);
  comments.value = scrub(comments.value);
}
watch(
  () => r.lastChatDeletion,
  (id) => {
    if (id) tombstone(new Set([id]));
  },
);
watch(
  // Track structure and deletion flags, not every message body/metadata field.
  () =>
    JSON.stringify(
      r.messages
        .filter((message) => message.deleted)
        .map((message) => message.id),
    ),
  (signature) => tombstone(new Set<string>(JSON.parse(signature))),
);
async function revalidateCached() {
  if (!r.connected || !displayActive.value || revalidationInFlight) return;
  const token = new AbortController(),
    sequence = serial,
    window = windowSerial,
    room = r.room?.id,
    cached = [...new Set([...comments.value, ...latestPage].map((m) => m.id))];
  revalidationInFlight = token;
  try {
    for (let i = 0; i < cached.length; i += 100) {
      if (!r.connected || !displayActive.value) return;
      const history = await session.api<{ id: string; deleted?: boolean }[]>(
        `/rooms/${room}/messages?check_ids=${cached.slice(i, i + 100).join(",")}`,
        "GET",
        undefined,
        AbortSignal.any([token.signal, AbortSignal.timeout(15000)]),
      );
      if (
        sequence !== serial ||
        window !== windowSerial ||
        revalidationInFlight !== token ||
        r.room?.id !== room
      )
        return;
      tombstone(new Set(history.filter((m) => m.deleted).map((m) => m.id)));
    }
    if (r.connected && revalidationInFlight === token) {
      revalidateOnDisplay = false;
      revalidationError.value = "";
    }
  } catch (e) {
    if (
      sequence === serial &&
      window === windowSerial &&
      revalidationInFlight === token
    ) {
      revalidationError.value =
        e instanceof Error ? e.message : "评论删除状态核对失败";
    }
  } finally {
    if (revalidationInFlight === token) revalidationInFlight = undefined;
  }
}
watch(
  () => r.connected,
  (connected, previous) => {
    if (!connected) {
      revalidateOnDisplay = true;
      cancelRevalidation();
    } else if (!previous && revalidateOnDisplay) void revalidateCached();
  },
);
watch(selected, async (value, old) => {
  if (value === old) return;
  clearWindow();
  const sequence = serial,
    window = windowSerial;
  try {
    await load();
  } catch (e) {
    if (sequence === serial && window === windowSerial)
      selectionError.value = e instanceof Error ? e.message : String(e);
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
    sequence = serial,
    submission = ++submissionSerial;
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
  const activity = String(pending.activity_id);
  try {
    const result = await session.api<{ message: unknown }>(
      `${prefix()}/messages`,
      "POST",
      pending,
      requestSignal(15000),
    );
    if (
      sequence !== serial ||
      submission !== submissionSerial ||
      r.room?.id !== room
    )
      return;
    const page = parseTimelinePage(
      { items: [result.message], next_before: null, next_after: null },
      activity,
    );
    if (selected.value === activity) {
      comments.value = mergeTimelineWindow(
        comments.value,
        page.items,
        browsingOlder.value ? "refresh" : "latest",
      );
      latestPage = mergeTimelineWindow(latestPage, page.items, "latest").slice(
        -100,
      );
      if (browsingOlder.value) newerAvailable.value = true;
    }
    pending = undefined;
    failed.value = false;
    text.value = "";
  } catch (e) {
    if (sequence === serial && submission === submissionSerial) {
      failed.value = true;
      error.value =
        e instanceof Error ? e.message : "评论未确认，请用原编号重试";
    }
  } finally {
    if (sequence === serial && submission === submissionSerial)
      busy.value = false;
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
      requestSignal(10000),
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
    const list = await session.api<RoomMember[]>(
      `/rooms/${room}/members`,
      "GET",
      undefined,
      requestSignal(15000),
    );
    if (sequence !== serial || r.room?.id !== room) return;
    members.value = list;
    manageOpen.value = true;
  } catch (e) {
    if (sequence === serial && r.room?.id === room)
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
    await session.api(
      `${prefix()}/moderation`,
      "POST",
      {
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
      },
      requestSignal(15000),
    );
    if (sequence !== serial) return;
    reason.value = "";
    if (messageId) tombstone(new Set([messageId]));
  } catch (e) {
    if (sequence === serial)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (sequence === serial) busy.value = false;
  }
}
async function showAudit() {
  const sequence = serial;
  try {
    const result = await session.api<{
      items: { id: string; action: string; reason: string }[];
    }>(`${prefix()}/audit`, "GET", undefined, requestSignal(15000));
    if (sequence === serial) audit.value = result.items;
  } catch (e) {
    if (sequence === serial)
      error.value = e instanceof Error ? e.message : String(e);
  }
}
function visibilityChanged() {
  pageVisible.value = !document.hidden;
}
onMounted(() =>
  document.addEventListener("visibilitychange", visibilityChanged),
);
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", visibilityChanged);
  reset();
  lifetime.abort();
});
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
          ><input v-model="hideFuture" type="checkbox" />{{
            currentSelected
              ? "隐藏当前进度之后的评论"
              : "隐藏浏览截止之后的评论"
          }}</label
        ><label
          ><input v-model="ordered" type="checkbox" />按影片时间排序</label
        >
      </div>
      <p v-if="currentSelected" class="helper">
        当前画面 {{ timeLabel(atMs) }}；隐藏未来评论仅影响展示
      </p>
      <template v-else-if="selected">
        <label
          >历史浏览截止（秒）<input
            v-model.number="historicalCutoff"
            type="number"
            min="0"
            max="604800"
            step="1"
            placeholder="填写此场次已观看的秒数"
        /></label>
        <p class="helper">
          历史场次独立筛选，不跟随当前影片进度
          <template v-if="cutoff !== null"
            >；浏览截止 {{ timeLabel(cutoff) }}</template
          >
        </p>
      </template>
      <button
        v-if="nextBefore"
        :disabled="busy || loadingOlder"
        @click="loadEarlier"
      >
        {{ loadingOlder ? "正在加载更早评论…" : "加载更早评论" }}
      </button>
      <button v-if="browsingOlder" @click="returnLatest">返回最新评论</button>
      <p v-if="newerAvailable" class="helper" role="status">
        有新评论，返回最新评论查看
      </p>
      <div
        class="timeline-log"
        role="log"
        :aria-live="currentSelected && !browsingOlder ? 'polite' : 'off'"
      >
        <p v-if="!visibleComments.length" class="helper">{{ emptyMessage }}</p>
        <article v-for="m in visibleComments" :key="m.id">
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
            :disabled="busy || failed || !r.roomActive"
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
            discardPending();
            error = '';
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
      <p v-if="displayError" class="error" role="alert">{{ displayError }}</p>
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
