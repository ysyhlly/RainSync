import { computed, ref } from "vue";
import type { ApiClient } from "../../../shared/api/client";
import type { QueueItem } from "../../../shared/api/types";
import type { RoomScopePort } from "./room-scope";

/** Queue reads belong to a connection; committed edits belong to their room. */
export function createRoomQueue(options: {
  api: ApiClient;
  scope: RoomScopePort;
  active: () => boolean;
}) {
  const playlist = ref<QueueItem[]>([]),
    playlistLoaded = ref(false),
    playlistLoading = ref(false),
    playlistError = ref(""),
    queueNotice = ref(""),
    queueReceipts = ref<Record<string, string>>({}),
    queuePendingKeys = ref<string[]>([]);
  let request = 0,
    pending: Promise<void> | undefined,
    invalidation: { dirty: boolean } | undefined;
  const operations = new Map<string, { work?: Promise<void> }>();
  function retainReadError() {
    // A failed refresh cannot turn a committed edit into a repeatable mutation.
  }
  function refresh(): Promise<void> {
    const scope = options.scope.capture(),
      serial = ++request;
    if (!scope) return Promise.resolve();
    const current = () => options.scope.currentRoom(scope) && serial === request;
    playlistLoading.value = true;
    const work = (async () => {
      try {
        const items = await options.api<QueueItem[]>(
          `/rooms/${scope.room}/playlist`,
        );
        if (!current()) return;
        playlist.value = items;
        playlistLoaded.value = true;
        playlistError.value = "";
      } catch (failure) {
        if (!current()) return;
        playlistError.value =
          failure instanceof Error ? failure.message : String(failure);
        throw failure;
      } finally {
        if (current()) {
          playlistLoading.value = false;
          pending = undefined;
        }
      }
    })();
    pending = work;
    return work;
  }
  function invalidate() {
    const scope = options.scope.capture();
    if (!scope) return;
    if (invalidation) {
      invalidation.dirty = true;
      return;
    }
    const operation = { dirty: true };
    invalidation = operation;
    const current = () =>
      invalidation === operation && options.scope.currentRoom(scope);
    void (async () => {
      while (current() && operation.dirty) {
        operation.dirty = false;
        // Wait for a read predating the edit, then share one trailing refresh.
        await pending?.catch(retainReadError);
        if (!current()) return;
        await refresh().catch(retainReadError);
      }
    })().finally(() => {
      if (invalidation === operation) invalidation = undefined;
    });
  }
  function mutate(kind: "add" | "remove", id: string): Promise<void> {
    const scope = options.scope.capture();
    if (!scope || !options.active())
      return Promise.reject(Error("房间当前未开放"));
    const key = `${kind}:${id}`,
      existing = operations.get(key);
    if (existing) return existing.work!;
    // A reconnect fences reads, not the receipt for this same-room HTTP commit.
    const current = () => options.scope.currentRoom(scope);
    delete queueReceipts.value[key];
    queuePendingKeys.value = [...queuePendingKeys.value, key];
    const operation: { work?: Promise<void> } = {};
    operations.set(key, operation);
    const work = (async () => {
      try {
        if (kind === "add")
          await options.api(`/rooms/${scope.room}/playlist`, "POST", {
            media_id: id,
          });
        else await options.api(`/rooms/${scope.room}/playlist/${id}`, "DELETE");
        if (!current()) return;
        queueNotice.value =
          kind === "add" ? "已加入当前房间待播" : "已从当前房间待播移除";
        queueReceipts.value[key] = queueNotice.value;
        await refresh().catch(retainReadError);
      } finally {
        if (current() && operations.get(key) === operation) {
          operations.delete(key);
          queuePendingKeys.value = queuePendingKeys.value.filter(
            (value) => value !== key,
          );
        }
      }
    })();
    operation.work = work;
    return work;
  }
  function connectionChanged() {
    ++request;
    pending = undefined;
    invalidation = undefined;
    playlistLoading.value = false;
  }
  function reset() {
    connectionChanged();
    playlist.value = [];
    playlistLoaded.value = false;
    playlistError.value = "";
    queueNotice.value = "";
    queueReceipts.value = {};
    operations.clear();
    queuePendingKeys.value = [];
  }
  return {
    playlist,
    playlistLoaded,
    playlistLoading,
    playlistError,
    queueNotice,
    queuePendingCount: computed(() => queuePendingKeys.value.length),
    queuePending: (kind: "add" | "remove", id: string) =>
      queuePendingKeys.value.includes(`${kind}:${id}`),
    queueReceipt: (kind: "add" | "remove", id: string) =>
      queueReceipts.value[`${kind}:${id}`] ?? "",
    refresh,
    invalidate,
    pending: () => pending,
    add: (id: string) => mutate("add", id),
    remove: (id: string) => mutate("remove", id),
    connectionChanged,
    reset,
  };
}
