import type { useSession } from "../auth/session.store";
import type { Media, MediaCover } from "../../shared/api/types";
export interface BrowseFolder {
  type: "source" | "folder";
  id: string;
  name: string;
  media_count: number;
  kind?: string;
}
export interface BrowsePage {
  entries: (BrowseFolder | { type: "media"; media: Media })[];
  breadcrumbs: { id: string | null; name: string }[];
  node: string | null;
  next_cursor: string | null;
  total_media: number;
}
export interface BrowseRequest {
  libraryId?: string;
  node?: string | null;
  after?: string;
  limit?: number;
}
export function mediaApi(api: ReturnType<typeof useSession>["api"]) {
  return {
    browse: (request: BrowseRequest = {}, signal?: AbortSignal) => {
      const params = new URLSearchParams({
        limit: String(request.limit ?? 24),
      });
      if (request.libraryId) params.set("library_id", request.libraryId);
      if (request.node) params.set("node", request.node);
      if (request.after) params.set("after", request.after);
      return api<BrowsePage>(
        "/media/browse?" + params,
        "GET",
        undefined,
        signal,
      );
    },
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
