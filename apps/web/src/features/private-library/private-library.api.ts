import type { ApiClient } from "../../shared/api/client";
import type { Media } from "../../shared/api/types";
export interface LibraryPermissions {
  browse: boolean;
  play: boolean;
  share_to_room: boolean;
  manage: boolean;
}
export interface Library {
  id: string;
  name: string;
  owner_id: string | null;
  visibility: "private" | "instance_shared";
  revision: string;
  permission_epoch: string;
  permissions: LibraryPermissions;
}
export interface LibrarySource {
  id: string;
  name: string;
  kind: string;
  access_policy_revision: number;
}
export interface LibraryGrant extends LibraryPermissions {
  user_id: string;
  username: string;
  expires_at: number;
}
export interface RoomShare {
  id: string;
  media_id: string;
  room_id: string;
  title: string;
  mode: "room_members" | "library_members";
  expires_at: number;
  active: boolean;
}
export interface LibraryDetail extends Library {
  sources?: LibrarySource[];
  grants?: LibraryGrant[];
  room_shares?: RoomShare[];
  audit?: { id: string; action: string; created_at: number }[];
}
export interface ScanStatus {
  scan_id?: string;
  status: "not_started" | "running" | "failed" | "completed";
  item_count: number;
  page_count: number;
  has_more: boolean;
  last_error?: string | null;
}
export function privateLibraryApi(api: ApiClient) {
  const root = (id: string) => "/libraries/" + encodeURIComponent(id);
  return {
    list: (signal?: AbortSignal) =>
      api<{ enabled: boolean; items: Library[] }>(
        "/libraries",
        "GET",
        undefined,
        signal,
      ),
    detail: (id: string, signal?: AbortSignal) =>
      api<LibraryDetail>(root(id), "GET", undefined, signal),
    create: (name: string) =>
      api<LibraryDetail>("/libraries", "POST", { name }),
    rename: (id: string, name: string, expected_revision: string) =>
      api<LibraryDetail>(root(id), "PUT", { name, expected_revision }),
    grant: (
      id: string,
      body: LibraryPermissions & {
        username: string;
        expires_in_hours: number;
        expected_revision: string;
      },
    ) => api<LibraryDetail>(root(id) + "/grants", "POST", body),
    revoke: (id: string, user: string, expected_revision: string) =>
      api<LibraryDetail>(
        root(id) + "/grants/" + encodeURIComponent(user),
        "DELETE",
        { expected_revision },
      ),
    transfer: (id: string, username: string, expected_revision: string) =>
      api<{ transferred: boolean }>(root(id) + "/transfer", "POST", {
        username,
        expected_revision,
      }),
    source: (
      id: string,
      body: { name: string; kind: string; config: unknown },
    ) => api<{ id: string }>(root(id) + "/sources", "POST", body),
    attach: (id: string, source_id: string, expected_revision: string) =>
      api(root(id) + "/attach-source", "POST", {
        source_id,
        expected_revision,
      }),
    media: (id: string, search: string, after?: string, signal?: AbortSignal) =>
      api<Media[]>(
        root(id) +
          "/media?" +
          new URLSearchParams({
            search,
            limit: "50",
            ...(after ? { after } : {}),
          }),
        "GET",
        undefined,
        signal,
      ),
    scan: (id: string, source: string, restart = false) =>
      api<ScanStatus>(
        root(id) + "/sources/" + encodeURIComponent(source) + "/scan",
        "POST",
        { restart },
      ),
    scanStatus: (id: string, source: string) =>
      api<ScanStatus>(
        root(id) + "/sources/" + encodeURIComponent(source) + "/scan",
      ),
    share: (
      id: string,
      body: {
        room_id: string;
        media_id: string;
        mode: "room_members" | "library_members";
        expires_in_minutes: number;
        expected_revision: string;
      },
    ) =>
      api<{ id: string; revision: string }>(
        root(id) + "/room-shares",
        "POST",
        body,
      ),
    revokeShare: (id: string, grant: string, expected_revision: string) =>
      api(root(id) + "/room-shares/" + encodeURIComponent(grant), "DELETE", {
        expected_revision,
      }),
  };
}
