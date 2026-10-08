<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { useRoomRuntime } from "./room-runtime";
import { useSession } from "../auth/session.store";
import {
  parseRoomCleanupStatus,
  cleanupBlockerLabel,
  type RoomCleanupStatus,
} from "./room-cleanup";
import { useAction } from "../../shared/use-action";
import Notice from "../../shared/ui/Notice.vue";
const r = useRoomRuntime(),
  session = useSession();
const status = ref<RoomCleanupStatus>(),
  loading = ref(false),
  loadError = ref("");
const { busy, error, message, run } = useAction();
let serial = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined;
let active = true;
function reset() {
  ++serial;
  clearTimeout(timer);
  controller?.abort();
  controller = undefined;
  status.value = undefined;
  loading.value = false;
  loadError.value = "";
  error.value = "";
  message.value = "";
  busy.value = false;
}
async function refresh() {
  if (!active || loading.value || !r.room || r.room.lifecycle !== "closing")
    return;
  clearTimeout(timer);
  const room = r.room.id,
    epoch = session.epoch,
    lifecycleEpoch = r.room.lifecycle_epoch,
    request = ++serial;
  controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(15000),
  ]);
  loading.value = true;
  try {
    const value = parseRoomCleanupStatus(
      await session.api(`/rooms/${room}/lifecycle`, "GET", undefined, signal),
    );
    if (
      request !== serial ||
      r.room?.id !== room ||
      session.epoch !== epoch ||
      r.room.lifecycle_epoch !== lifecycleEpoch
    )
      return;
    status.value = value;
    loadError.value = "";
    // Metadata refresh only updates titles. A terminal read must reconcile the
    // authoritative room state/revision too, even if its websocket event was lost.
    if (value.lifecycle !== "closing") await r.refreshLifecycle();
  } catch (e) {
    if (request === serial && session.epoch === epoch && r.room?.id === room)
      loadError.value =
        e instanceof Error ? e.message : "清理状态更新失败，请重试";
  } finally {
    if (request === serial) {
      loading.value = false;
      controller = undefined;
      if (r.room?.lifecycle === "closing") timer = setTimeout(refresh, 3000);
    }
  }
}
async function retry() {
  const room = r.room?.id,
    epoch = session.epoch,
    lifecycleEpoch = r.room?.lifecycle_epoch,
    revision = r.state?.revision;
  if (
    !room ||
    r.room?.lifecycle !== "closing" ||
    !r.canManageRoom ||
    !Number.isInteger(revision) ||
    !status.value?.cleanup.retryable
  )
    return;
  const current = () =>
    active &&
    r.room?.id === room &&
    session.epoch === epoch &&
    r.room.lifecycle_epoch === lifecycleEpoch &&
    r.room.lifecycle === "closing";
  try {
    const result = await session.api<{ cleanup?: { scheduled?: boolean } }>(
      `/rooms/${room}/cleanup/retry`,
      "POST",
      { expected_revision: revision },
      AbortSignal.timeout(15000),
    );
    if (!current()) return;
    if (typeof result.cleanup?.scheduled !== "boolean")
      throw Error("清理重试结果尚未确认，请刷新进度");
    message.value = result.cleanup.scheduled
      ? "已重新安排清理，确认资源释放后会完成关闭。"
      : "清理任务仍在运行，已保留原任务，请等待释放确认。";
    await refresh();
  } catch (e) {
    if (current()) throw e;
  }
}
watch(
  () => [r.room?.id, r.room?.lifecycle, r.room?.lifecycle_epoch, session.epoch],
  () => {
    reset();
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  active = false;
  reset();
});
</script>
<template>
  <section class="room-cleanup-panel" aria-label="房间关闭进度">
    <strong>{{
      status?.cleanup.completed ? "房间清理已完成" : "房间正在关闭"
    }}</strong>
    <p role="status">
      {{
        !status
          ? "正在读取清理进度…"
          : status.cleanup.lease_active
            ? "正在停止播放并释放媒体资源…"
            : status.cleanup.blockers.length
              ? "仍有媒体资源等待释放确认。"
              : "正在检查清理结果，历史记录仍可查看。"
      }}
    </p>
    <p v-if="status" class="helper">
      已检查 {{ status.cleanup.attempts }} 次<span
        v-if="status.cleanup.elapsed_ms != null"
      >
        · 已等待 {{ Math.floor(status.cleanup.elapsed_ms / 1000) }} 秒</span
      >
    </p>
    <ul v-if="status?.cleanup.blockers.length">
      <li
        v-for="(blocker, index) in status.cleanup.blockers"
        :key="`${blocker}:${index}`"
      >
        {{ cleanupBlockerLabel(blocker) }}
      </li>
    </ul>
    <p v-if="status?.cleanup.last_error" class="helper">
      上次清理未完成，系统会继续重试；你也可以重新安排清理。
    </p>
    <Notice :message="loadError" error />
    <Notice :message="error" error />
    <Notice :message="message" />
    <div class="button-row">
      <button :disabled="loading" @click="refresh">
        {{ loading ? "正在更新…" : "刷新进度" }}
      </button>
      <button
        v-if="r.canManageRoom && status?.cleanup.retryable"
        :disabled="busy || loading"
        @click="run(retry)"
      >
        重新尝试清理
      </button>
    </div>
  </section>
</template>
<style scoped>
.room-cleanup-panel {
  border: 1px solid var(--border-control);
  border-radius: 12px;
  background: var(--surface-panel);
  padding: 16px;
  margin: 12px 0;
}
.room-cleanup-panel p {
  margin: 8px 0;
}
</style>
