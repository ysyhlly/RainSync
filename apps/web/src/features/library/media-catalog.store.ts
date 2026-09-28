import { defineStore } from "pinia";
import { ref, watch, onScopeDispose } from "vue";
import { useSession } from "../auth/session.store";
import { StaleIdentity } from "../../shared/api/client";
import type { Media } from "../../shared/api/types";
import { mediaApi } from "./media.api";
export const useMediaCatalog = defineStore("media-catalog", () => {
  const session = useSession(),
    records = ref<Record<string, Media>>({});
  const api = mediaApi(
    (...args: Parameters<typeof session.api>) => session.api(...args) as any,
  );
  let controller = new AbortController(),
    sequence = 0;
  const pending = new Map<string, Promise<Media>>(),
    covers = new Map<string, number>();
  function reset() {
    controller.abort();
    controller = new AbortController();
    records.value = {};
    pending.clear();
    covers.clear();
    sequence++;
  }
  function remember(items: Media[], started = ++sequence) {
    for (const item of items) {
      if (!item?.id || typeof item.title !== "string") continue;
      // Transitional older servers/fixtures retain a safe original title.
      const next: Media = {
        ...item,
        original_title: item.original_title ?? item.title,
        shared_title: item.shared_title ?? null,
        shared_title_revision: item.shared_title_revision ?? "0",
        personal_title: item.personal_title ?? null,
        personal_title_revision: item.personal_title_revision ?? "0",
        cover: item.cover ?? {
          status: "missing",
          revision: null,
          url: null,
          retry_after_ms: null,
        },
      };
      const old = records.value[item.id];
      if (old) {
        for (const scope of ["personal", "shared"] as const) {
          if (
            BigInt(old[`${scope}_title_revision`]) >
            BigInt(next[`${scope}_title_revision`])
          ) {
            next[`${scope}_title`] = old[`${scope}_title`];
            next[`${scope}_title_revision`] = old[`${scope}_title_revision`];
          }
        }
        if ((covers.get(item.id) ?? 0) > started) next.cover = old.cover;
      }
      next.title =
        next.personal_title ?? next.shared_title ?? next.original_title;
      records.value[item.id] = next;
      covers.set(item.id, Math.max(started, covers.get(item.id) ?? 0));
    }
  }
  function ensure(id: string, force = false): Promise<Media> {
    if (pending.has(id)) return pending.get(id)!;
    if (!force && records.value[id]) return Promise.resolve(records.value[id]);
    const epoch = session.epoch,
      started = ++sequence,
      signal = controller.signal;
    const work = api
      .detail(id, signal)
      .then((item) => {
        if (epoch !== session.epoch || signal.aborted)
          throw new StaleIdentity();
        remember([item], started);
        if (!records.value[id]) throw Error("媒体详情响应不完整");
        return records.value[id];
      })
      .finally(() => {
        if (pending.get(id) === work) pending.delete(id);
      });
    pending.set(id, work);
    return work;
  }
  async function rename(
    id: string,
    scope: "personal" | "shared",
    title: string | null,
    revision: string,
  ) {
    const epoch = session.epoch,
      signal = controller.signal,
      started = ++sequence;
    const item = await api.rename(id, scope, title, revision, signal);
    if (epoch !== session.epoch || signal.aborted) throw new StaleIdentity();
    remember([item], started);
    return records.value[id];
  }
  async function previews(
    ids: string[],
    request: boolean,
    external?: AbortSignal,
  ) {
    const epoch = session.epoch,
      started = ++sequence,
      signal = external
        ? AbortSignal.any([controller.signal, external])
        : controller.signal;
    const result = await api.previews(
      [...new Set(ids)].slice(0, 24),
      request,
      signal,
    );
    if (epoch !== session.epoch || signal.aborted) throw new StaleIdentity();
    if (!Array.isArray(result.items)) throw Error("预览响应不完整");
    for (const item of result.items) {
      const old = records.value[item.media_id];
      if (old && (covers.get(item.media_id) ?? 0) <= started) {
        records.value[item.media_id] = { ...old, cover: item.cover };
        covers.set(item.media_id, started);
      }
    }
  }
  watch(() => session.epoch, reset, { flush: "sync" });
  onScopeDispose(reset);
  return {
    records,
    remember,
    ensure,
    reset,
    requestPreviews: (ids: string[], signal?: AbortSignal) =>
      previews(ids, true, signal),
    refreshPreviewStatuses: (ids: string[], signal?: AbortSignal) =>
      previews(ids, false, signal),
    renamePersonal: (id: string, title: string | null, revision: string) =>
      rename(id, "personal", title, revision),
    renameShared: (id: string, title: string | null, revision: string) =>
      rename(id, "shared", title, revision),
    stamp: () => ++sequence,
  };
});
