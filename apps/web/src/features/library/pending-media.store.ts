import { defineStore } from "pinia";
import { computed, onScopeDispose, ref, watch } from "vue";
import { useSession } from "../auth/session.store";

export interface PendingSelection {
  mediaId: string;
  title: string;
  epoch: number;
}

// Keep only the selection in this session's memory. Never persist credentials
// or execute a saved action when a room or account changes.
export const usePendingMedia = defineStore("pending-media", () => {
  const session = useSession();
  const snapshot = ref<{
    selection: PendingSelection | null;
    denial?: { message: string; context: string };
  }>({ selection: null });
  const selection = computed({
    get: () => snapshot.value.selection,
    set: (value: PendingSelection | null) => {
      snapshot.value = { selection: value };
    },
  });
  const selectionError = computed(() => snapshot.value.denial?.message ?? "");
  const selectionErrorContext = computed(() => snapshot.value.denial?.context);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    clearTimeout(timer);
    snapshot.value = { selection: null };
  }
  function select(mediaId: string, title: string) {
    clear();
    if (!session.user) return;
    selection.value = { mediaId, title, epoch: session.epoch };
    timer = setTimeout(clear, 10 * 60 * 1000);
  }
  function rejectSelection(
    expected: PendingSelection,
    message: string,
    context: string,
  ) {
    if (selection.value !== expected || expected.epoch !== session.epoch)
      return false;
    clearTimeout(timer);
    // One state replacement: selection observers also see its denial message.
    snapshot.value = { selection: null, denial: { message, context } };
    return true;
  }
  function clearContextError(context: string, connected: boolean) {
    if (
      snapshot.value.denial &&
      (!connected || snapshot.value.denial.context !== context)
    ) {
      snapshot.value = { selection: selection.value };
    }
  }
  watch(() => session.epoch, clear, { flush: "sync" });
  onScopeDispose(clear);
  return {
    selection,
    selectionError,
    selectionErrorContext,
    select,
    clear,
    rejectSelection,
    clearContextError,
  };
});
