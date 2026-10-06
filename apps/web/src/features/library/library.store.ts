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
    requestedQuery = ref(""),
    requestedPage = ref(0),
    page = ref(0),
    busy = ref(false),
    error = ref(""),
    loaded = ref(false),
    refreshKey = ref(0),
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
    const signal = controller.signal;
    busy.value = true;
    error.value = "";
    // A cursor only belongs to the last successful query. A failed search
    // must leave that query, its page and its cursors as one snapshot.
    if (search !== query.value || next < 0 || (next > 0 && !cursors[next]))
      next = 0;
    requestedQuery.value = search;
    requestedPage.value = next;
    const requestCursors = search === query.value ? [...cursors] : [""];
    const params = new URLSearchParams({ limit: String(pageSize + 1), search });
    if (next > 0) params.set("after", requestCursors[next]);
    try {
      const rows = await session.api<Media[]>(
        "/media?" + params,
        "GET",
        undefined,
        signal,
      );
      if (id !== serial || signal.aborted) return;
      query.value = search;
      items.value = rows.slice(0, pageSize);
      hasMore.value = rows.length > pageSize;
      page.value = next;
      loaded.value = true;
      cursors = [
        ...requestCursors.slice(0, next + 1),
        items.value.at(-1)?.id ?? "",
      ];
      catalog.remember(rows, stamp);
      refreshKey.value++;
    } catch (e) {
      if (id === serial && !signal.aborted)
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
      requestedQuery.value = "";
      requestedPage.value = 0;
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
  return {
    items,
    query,
    requestedQuery,
    requestedPage,
    page,
    busy,
    error,
    loaded,
    hasMore,
    refreshKey,
    load,
    retry: () => load(requestedPage.value, requestedQuery.value),
  };
});
