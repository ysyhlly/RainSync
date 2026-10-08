import type { ApiClient } from "../../shared/api/client";
import type {
  SourceSettings,
  SourceSettingsSaved,
} from "../admin/source-settings";
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
  revision: string;
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
  max_expires_at: number;
}
export interface IssuedRoomShare {
  id: string;
  library_id: string;
  revision: string;
  media_id: string;
  room_id: string;
  title: string | null;
  mode: RoomShare["mode"];
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
    issuedShares: (after?: string, signal?: AbortSignal) =>
      api<{ items: IssuedRoomShare[]; has_more: boolean }>(
        "/libraries/issued-shares" +
          (after ? "?" + new URLSearchParams({ after }) : ""),
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
    remove: (id: string, expected_revision: string) =>
      api<{ deleted: boolean }>(root(id), "DELETE", { expected_revision }),
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
    sourceSettings: (id: string, source: string, signal?: AbortSignal) =>
      api<
        SourceSettings & {
          config: SourceSettings["config"] & { s3?: Record<string, unknown> };
        }
      >(
        root(id) + "/sources/" + encodeURIComponent(source),
        "GET",
        undefined,
        signal,
      ),
    updateSource: (
      id: string,
      source: string,
      body: {
        expected_revision: string;
        name?: string;
        config?: Record<string, unknown>;
      },
    ) =>
      api<SourceSettingsSaved>(
        root(id) + "/sources/" + encodeURIComponent(source),
        "PATCH",
        body,
      ),
    removeSource: (
      id: string,
      source: string,
      expected_revision: string,
      expected_library_revision: string,
    ) =>
      api(root(id) + "/sources/" + encodeURIComponent(source), "DELETE", {
        expected_revision,
        expected_library_revision,
      }),
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
    updateShare: (
      id: string,
      grant: string,
      body: {
        mode: RoomShare["mode"];
        expires_at: number;
        expected_revision: string;
      },
    ) =>
      api<{ id: string; revision: string }>(
        root(id) + "/room-shares/" + encodeURIComponent(grant),
        "PATCH",
        body,
      ),
    revokeShare: (id: string, grant: string, expected_revision: string) =>
      api(root(id) + "/room-shares/" + encodeURIComponent(grant), "DELETE", {
        expected_revision,
      }),
  };
}
