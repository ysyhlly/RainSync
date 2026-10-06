import { defineStore } from "pinia";
import { onScopeDispose, ref, watch } from "vue";
import { useSession } from "../auth/session.store";

// Keep only the selection in this session's memory. Never persist credentials
// or execute a saved action when a room or account changes.
export const usePendingMedia = defineStore("pending-media", () => {
  const session = useSession();
  const selection = ref<{
    mediaId: string;
    title: string;
    epoch: number;
  } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    clearTimeout(timer);
    selection.value = null;
  }
  function select(mediaId: string, title: string) {
    clear();
    if (!session.user) return;
    selection.value = { mediaId, title, epoch: session.epoch };
    timer = setTimeout(clear, 10 * 60 * 1000);
  }
  watch(() => session.epoch, clear, { flush: "sync" });
  onScopeDispose(clear);
  return { selection, select, clear };
});
