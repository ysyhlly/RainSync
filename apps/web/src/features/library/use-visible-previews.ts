import {
  onBeforeUnmount,
  onMounted,
  nextTick,
  watch,
  ref,
  type Ref,
} from "vue";
import { useMediaCatalog } from "./media-catalog.store";
/** One merged batch, at most 24 visible cards, with bounded waiting. */
export function useVisiblePreviews(
  root: Ref<HTMLElement | undefined>,
  ids: () => string[],
) {
  const catalog = useMediaCatalog(),
    visible = new Set<string>(),
    requested = new Set<string>(),
    began = new Map<string, number>(),
    retryAt = new Map<string, number>();
  const stalled = ref(new Set<string>());
  let observer: IntersectionObserver | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller = new AbortController(),
    alive = true,
    running = false;
  function schedule(ms = 50) {
    clearTimeout(timer);
    if (alive && !document.hidden) timer = setTimeout(tick, ms);
  }
  async function tick() {
    if (running) {
      schedule(100);
      return;
    }
    if (document.hidden || !alive) return;
    running = true;
    const signal = controller.signal;
    try {
      const fresh = [...visible]
        .filter(
          (id) =>
            !requested.has(id) &&
            catalog.records[id]?.cover.status === "missing",
        )
        .slice(0, 24);
      if (fresh.length) {
        fresh.forEach((id) => {
          requested.add(id);
          began.set(id, Date.now());
        });
        await catalog.requestPreviews(fresh, signal);
      }
      const pending = [...visible].filter(
        (id) =>
          ["queued", "running"].includes(catalog.records[id]?.cover.status) &&
          !stalled.value.has(id),
      );
      for (const id of pending) {
        if (!began.has(id)) began.set(id, Date.now());
        if (Date.now() - began.get(id)! >= 60000) stalled.value.add(id);
      }
      const due = pending
        .filter(
          (id) =>
            !stalled.value.has(id) && Date.now() >= (retryAt.get(id) ?? 0),
        )
        .slice(0, 24);
      if (due.length) {
        await catalog.refreshPreviewStatuses(due, signal);
        for (const id of due)
          retryAt.set(
            id,
            Date.now() +
              Math.max(2000, catalog.records[id]?.cover.retry_after_ms ?? 2000),
          );
      }
    } catch {
      if (!signal.aborted)
        for (const id of visible)
          if (catalog.records[id]?.cover.status !== "ready")
            stalled.value.add(id);
    } finally {
      running = false;
      if (
        !signal.aborted &&
        [...visible].some(
          (id) =>
            !stalled.value.has(id) &&
            ((catalog.records[id]?.cover.status === "missing" &&
              !requested.has(id)) ||
              ["queued", "running"].includes(
                catalog.records[id]?.cover.status,
              )),
        )
      )
        schedule(2000);
    }
  }
  async function observe() {
    await nextTick();
    observer?.disconnect();
    visible.clear();
    for (const node of Array.from(
      root.value?.querySelectorAll<HTMLElement>("[data-media-id]") ?? [],
    ))
      observer?.observe(node);
  }
  function visibility() {
    controller.abort();
    controller = new AbortController();
    clearTimeout(timer);
    if (!document.hidden) {
      requested.clear();
      began.clear();
      retryAt.clear();
      stalled.value.clear();
      schedule();
    }
  }
  onMounted(() => {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.mediaId!;
        if (e.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      schedule();
    });
    void observe();
    document.addEventListener("visibilitychange", visibility);
  });
  watch(ids, observe);
  onBeforeUnmount(() => {
    alive = false;
    clearTimeout(timer);
    controller.abort();
    observer?.disconnect();
    document.removeEventListener("visibilitychange", visibility);
  });
  return {
    stalled,
    retry(id: string) {
      stalled.value.delete(id);
      requested.add(id);
      began.set(id, Date.now());
      void catalog
        .requestPreviews([id], controller.signal)
        .then(() => schedule())
        .catch(() => {
          stalled.value.add(id);
        });
    },
  };
}
