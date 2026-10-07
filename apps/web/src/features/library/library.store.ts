import { defineStore } from "pinia";
import { ref, watch, onScopeDispose, computed } from "vue";
import { RequestFailure } from "../../errors";
import { useSession } from "../auth/session.store";
import { useMediaCatalog } from "./media-catalog.store";
import { mediaApi, type BrowseFolder, type BrowsePage } from "./media.api";
import type { Media } from "../../shared/api/types";

// Each caller gets an isolated navigation snapshot; private-library instances
// never share node/cursor state with another library or the global catalog.
export function createLibraryState(
  libraryId: () => string | undefined = () => undefined,
) {
  const session = useSession(),
    catalog = useMediaCatalog();
  const items = ref<Media[]>([]),
    folders = ref<BrowseFolder[]>([]),
    breadcrumbs = ref<BrowsePage["breadcrumbs"]>([
      { id: null, name: "全部片源" },
    ]),
    node = ref<string | null>(null),
    mode = ref<"browse" | "flat">("browse"),
    requestedMode = ref<"browse" | "flat">("browse"),
    requestedNode = ref<string | null>(null),
    totalMedia = ref(0),
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
  const entryCount = computed(() => items.value.length + folders.value.length);
  async function request(
    next: number,
    search: string,
    target: string | null,
    browsing: boolean,
  ): Promise<void> {
    const id = ++serial,
      stamp = catalog.stamp(),
      scope = libraryId();
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    busy.value = true;
    error.value = "";
    const requestMode = browsing ? "browse" : "flat";
    const same =
      mode.value === requestMode &&
      (browsing ? target === node.value : search === query.value);
    // A failed navigation or search preserves the complete successful snapshot.
    if (!same || next < 0 || (next > 0 && !cursors[next])) next = 0;
    requestedQuery.value = search;
    requestedPage.value = next;
    requestedMode.value = requestMode;
    requestedNode.value = target;
    const requestCursors = same ? [...cursors] : [""];
    try {
      let rows: Media[], nextCursor: string, more: boolean;
      let result: BrowsePage | undefined;
      if (browsing) {
        result = await mediaApi(session.api).browse(
          {
            libraryId: scope,
            node: target,
            after: next > 0 ? requestCursors[next] : undefined,
            limit: pageSize,
          },
          signal,
        );
        rows = result.entries.flatMap((entry) =>
          entry.type === "media" ? [entry.media] : [],
        );
        nextCursor = result.next_cursor ?? "";
        more = !!result.next_cursor;
      } else {
        const params = new URLSearchParams({
          limit: String(pageSize + 1),
          search,
        });
        if (next > 0) params.set("after", requestCursors[next]);
        rows = await session.api<Media[]>(
          "/media?" + params,
          "GET",
          undefined,
          signal,
        );
        nextCursor = rows.slice(0, pageSize).at(-1)?.id ?? "";
        more = rows.length > pageSize;
      }
      if (id !== serial || signal.aborted || scope !== libraryId()) return;
      mode.value = requestMode;
      query.value = search;
      items.value = rows.slice(0, pageSize);
      folders.value =
        result?.entries.filter(
          (entry): entry is BrowseFolder => entry.type !== "media",
        ) ?? [];
      if (result) {
        node.value = result.node;
        breadcrumbs.value = result.breadcrumbs;
        totalMedia.value = result.total_media;
      }
      hasMore.value = more;
      page.value = next;
      loaded.value = true;
      cursors = [...requestCursors.slice(0, next + 1), nextCursor];
      catalog.remember(rows, stamp);
      refreshKey.value++;
    } catch (e) {
      if (id !== serial || signal.aborted || scope !== libraryId()) return;
      if (browsing && e instanceof RequestFailure) {
        // A definitive denial invalidates the old snapshot; a transient error
        // or a missing different destination must still preserve navigation.
        if (scope && e.code === "LIBRARY_NOT_FOUND") {
          reset();
        } else if (
          e.code === "MEDIA_NOT_FOUND" &&
          target !== null &&
          mode.value === "browse" &&
          target === node.value
        ) {
          reset();
          // The root request retains libraryId and cannot replay a stale cursor.
          await request(0, "", null, true);
          return;
        }
      }
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (id === serial) busy.value = false;
    }
  }
  function reset() {
    ++serial;
    controller?.abort();
    items.value = [];
    folders.value = [];
    breadcrumbs.value = [{ id: null, name: "全部片源" }];
    node.value = requestedNode.value = null;
    mode.value = requestedMode.value = "browse";
    query.value = requestedQuery.value = "";
    requestedPage.value = page.value = totalMedia.value = 0;
    busy.value = loaded.value = hasMore.value = false;
    error.value = "";
    cursors = [""];
  }
  watch(() => session.epoch, reset, { flush: "sync" });
  watch(libraryId, reset, { flush: "sync" });
  onScopeDispose(() => {
    ++serial;
    controller?.abort();
  });
  const load = (next = 0, search = query.value) =>
    request(next, search, node.value, false);
  const browse = (target: string | null = node.value, next = 0) =>
    request(next, "", target, true);
  const loadPage = (next: number) =>
    mode.value === "browse" ? browse(node.value, next) : load(next);
  return {
    items,
    folders,
    breadcrumbs,
    node,
    mode,
    requestedMode,
    requestedNode,
    totalMedia,
    entryCount,
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
    browse,
    loadPage,
    refresh: () => loadPage(page.value),
    retry: () =>
      request(
        requestedPage.value,
        requestedQuery.value,
        requestedNode.value,
        requestedMode.value === "browse",
      ),
  };
}
export const useLibrary = defineStore("library", () => createLibraryState());
