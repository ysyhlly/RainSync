import type { useSession } from "../auth/session.store";
import type { Media, MediaCover } from "../../shared/api/types";
export function mediaApi(api: ReturnType<typeof useSession>["api"]) {
  return {
    detail: (id: string, signal?: AbortSignal) =>
      api<Media>(`/media/${encodeURIComponent(id)}`, "GET", undefined, signal),
    roomDetail: (room: string, id: string, signal?: AbortSignal) =>
      api<Media>(
        `/rooms/${encodeURIComponent(room)}/media/${encodeURIComponent(id)}`,
        "GET",
        undefined,
        signal,
      ),
    rename: (
      id: string,
      scope: "personal" | "shared",
      title: string | null,
      revision: string,
      signal?: AbortSignal,
    ) =>
      api<Media>(
        `${scope === "shared" ? "/admin" : ""}/media/${encodeURIComponent(id)}/${scope}-title`,
        "PUT",
        { title, expected_revision: revision },
        signal,
      ),
    previews: (ids: string[], request: boolean, signal?: AbortSignal) =>
      api<{ items: { media_id: string; cover: MediaCover }[] }>(
        request
          ? "/media/previews"
          : "/media/previews?ids=" + ids.map(encodeURIComponent).join(","),
        request ? "POST" : "GET",
        request ? { media_ids: ids } : undefined,
        signal,
      ),
  };
}
