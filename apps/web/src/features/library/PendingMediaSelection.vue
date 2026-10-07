<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { usePendingMedia } from "./pending-media.store";
import { useMediaCatalog } from "./media-catalog.store";
import { useRoomRuntime } from "../rooms/room-runtime";
import { useSession } from "../auth/session.store";
import Notice from "../../shared/ui/Notice.vue";
import { RequestFailure } from "../../errors";
const pending = usePendingMedia(),
  catalog = useMediaCatalog(),
  runtime = useRoomRuntime(),
  session = useSession();
const busy = ref(false),
  error = ref("");
const displayError = computed(() => error.value || pending.selectionError);
let active = true,
  serial = 0;
const canContinue = computed(
  () =>
    !!runtime.room &&
    !!runtime.state &&
    runtime.connected &&
    runtime.can("change_media"),
);
watch(
  () => pending.selection,
  () => {
    ++serial;
    busy.value = false;
    error.value = "";
  },
  { flush: "sync" },
);
watch(
  () => [runtime.room?.id, runtime.connected],
  () => {
    // Returning to the same room after an intervening switch still requires
    // a fresh confirmation; an old detail response cannot resume the action.
    ++serial;
    busy.value = false;
    error.value = "";
    pending.clearContextError(runtime.selectionContext(), runtime.connected);
  },
  { flush: "sync", immediate: true },
);
onBeforeUnmount(() => {
  active = false;
  ++serial;
});
async function confirm() {
  const selection = pending.selection,
    room = runtime.room?.id;
  if (!selection || !room || busy.value || !canContinue.value) return;
  const mine = ++serial;
  const context = runtime.selectionContext();
  busy.value = true;
  error.value = "";
  try {
    // Recheck visibility before using a selection from another page. The
    // server still owns the final room and playback authorization.
    await catalog.ensure(selection.mediaId, true);
    if (
      !active ||
      mine !== serial ||
      pending.selection !== selection ||
      selection.epoch !== session.epoch ||
      runtime.room?.id !== room ||
      runtime.selectionContext() !== context ||
      !canContinue.value
    )
      return;
    const sent = await runtime.choose(selection.mediaId);
    if (!active || mine !== serial || pending.selection !== selection) return;
    if (!sent) {
      error.value = "房间状态尚未就绪，影片选择已保留。连接恢复后请再次确认。";
      return;
    }
    if (pending.selection === selection) pending.clear();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (
      e instanceof RequestFailure &&
      e.code === "MEDIA_NOT_FOUND" &&
      pending.selection === selection &&
      selection.epoch === session.epoch &&
      runtime.room?.id === room &&
      runtime.connected &&
      runtime.selectionContext() === context
    ) {
      // Public visibility belongs to this exact saved selection. Carry a
      // confirmed denial across the RoomsPage -> RoomPage component handoff;
      // a room-only metadata success grants no public-library visibility.
      pending.rejectSelection(selection, message, context);
      if (active) error.value = message;
      return;
    }
    if (active && mine === serial && pending.selection === selection) {
      error.value = message;
    }
  } finally {
    if (active && mine === serial) busy.value = false;
  }
}
</script>
<template>
  <Notice v-if="!pending.selection" :message="displayError" error />
  <section
    v-if="pending.selection"
    class="panel pending-media-selection"
    aria-label="已选择的影片"
  >
    <h2>已选择：{{ pending.selection.title }}</h2>
    <p v-if="!runtime.room">选择一个放映室，进入后确认播放这部影片。</p>
    <p v-else-if="canContinue">
      在“{{ runtime.room.name }}”中播放，确认后会更换房间当前影片。
    </p>
    <p v-else>影片选择已保留。连接恢复且获得选片权限后，可确认继续。</p>
    <Notice :message="displayError" error />
    <div class="form-actions">
      <button
        v-if="runtime.room"
        class="primary"
        :disabled="busy || !canContinue"
        @click="confirm"
      >
        {{ busy ? "正在检查影片…" : "确认播放所选影片" }}
      </button>
      <button @click="pending.clear()">取消选片</button>
    </div>
  </section>
</template>
