import { onScopeDispose, ref } from "vue";
import { StaleIdentity } from "./api/client";
export function useAction() {
  const busy = ref(false),
    error = ref(""),
    message = ref("");
  let serial = 0,
    active = true;
  onScopeDispose(() => {
    active = false;
    ++serial;
  });
  async function run(action: () => Promise<unknown>) {
    const id = ++serial;
    busy.value = true;
    error.value = "";
    message.value = "";
    try {
      await action();
    } catch (e) {
      if (
        active &&
        id === serial &&
        !(e instanceof StaleIdentity) &&
        !(e instanceof DOMException && e.name === "AbortError")
      )
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (active && id === serial) busy.value = false;
    }
  }
  return { busy, error, message, run };
}
export function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  return (
    Math.floor(seconds / 60) +
    ":" +
    Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0")
  );
}
export function formatDate(value: number | string | null | undefined) {
  if (value == null) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "暂无"
    : date.toLocaleString("zh-CN", { hour12: false });
}
