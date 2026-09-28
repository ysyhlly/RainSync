import { defineStore } from "pinia";
import { ref, watch, onScopeDispose } from "vue";
import { useSession } from "../auth/session.store";
import { useMediaCatalog } from "./media-catalog.store";
import type { Media } from "../../shared/api/types";
export const useLibrary = defineStore("library", () => {
  const session = useSession(),
    catalog = useMediaCatalog();
  const items = ref<Media[]>([]),
    query = ref(""),
    page = ref(0),
    busy = ref(false),
    error = ref(""),
    loaded = ref(false),
    hasMore = ref(false);
  let cursors = [""],
    serial = 0,
    controller: AbortController | undefined;
  const pageSize = 24;
  async function load(next = 0, search = query.value) {
    const id = ++serial;
    const stamp = catalog.stamp();
    controller?.abort();
    controller = new AbortController();
    busy.value = true;
    error.value = "";
    if (search !== query.value) {
      next = 0;
      cursors = [""];
    }
    query.value = search;
    const params = new URLSearchParams({ limit: String(pageSize + 1), search });
    if (next > 0 && cursors[next]) params.set("after", cursors[next]);
    try {
      const rows = await session.api<Media[]>(
        "/media?" + params,
        "GET",
        undefined,
        controller.signal,
      );
      if (id !== serial) return;
      items.value = rows.slice(0, pageSize);
      hasMore.value = rows.length > pageSize;
      page.value = next;
      loaded.value = true;
      cursors = [...cursors.slice(0, next + 1), items.value.at(-1)?.id ?? ""];
      catalog.remember(rows, stamp);
    } catch (e) {
      if (id === serial && !controller.signal.aborted)
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (id === serial) busy.value = false;
    }
  }
  watch(
    () => session.epoch,
    () => {
      ++serial;
      controller?.abort();
      items.value = [];
      query.value = "";
      page.value = 0;
      busy.value = false;
      error.value = "";
      loaded.value = false;
      hasMore.value = false;
      cursors = [""];
    },
    { flush: "sync" },
  );
  onScopeDispose(() => controller?.abort());
  return { items, query, page, busy, error, loaded, hasMore, load };
});
