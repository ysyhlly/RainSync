/** REST DTOs checked against Server handlers; playback types remain generated. */
export interface Avatar {
  avatar_url: string | null;
  avatar_version: string | null;
}
export interface Profile extends Avatar {
  id: string;
  username: string;
  display_name: string;
  custom_display_name: string | null;
}
export interface Identity extends Profile {
  admin: boolean;
  csrf: string;
}
export type RoomLifecycle = "active" | "closing" | "closed" | "archived";
export interface Room {
  id: string;
  name: string;
  owner_id: string;
  /** Missing only when connected to a pre-lifecycle server. */
  lifecycle?: RoomLifecycle;
  lifecycle_epoch?: number;
}
export interface RoomMember {
  id: string;
  username: string;
  display_name: string;
}
export interface Media {
  id: string;
  title: string;
  duration_ms: number | null;
  kind: string;
  original_title: string;
  shared_title: string | null;
  shared_title_revision: string;
  personal_title: string | null;
  personal_title_revision: string;
  cover: MediaCover;
}
export interface MediaCover {
  status: "missing" | "queued" | "running" | "ready" | "unavailable";
  revision: string | null;
  url: string | null;
  retry_after_ms: number | null;
}
export interface Source {
  id: string;
  name: string;
  kind: string;
}
export interface Agent {
  id: string;
  name: string;
  revoked: boolean;
  last_seen: string | null;
  /** Optional for compatibility with servers predating readiness reporting. */
  connected?: boolean;
  manual_scan?: boolean;
  source_versions?: boolean | null;
  drain_receipts?: boolean | null;
  indexed_count?: number;
  unversioned_count?: number;
  source_version_status?:
    "empty" | "ready" | "rescan_required" | "upgrade_required";
}
export interface Message extends Partial<Avatar> {
  id: string;
  user_id?: string;
  username: string;
  display_name?: string;
  body: string;
  created_at?: number;
  client_message_id?: string;
}
export interface QueueItem {
  id: string;
  media_id: string;
  title: string;
  cover: MediaCover;
}
export interface RoomInvitation {
  room_id: string;
  token: string;
}
export type InviteStatus = "unused" | "used" | "expired" | "revoked";
export interface RegistrationInvite {
  id: string;
  batch_id: string;
  code_suffix: string;
  status: InviteStatus;
  created_at: number;
  expires_at: number;
  note: string | null;
  used_at: number | null;
  revoked_at: number | null;
  used_by: string | null;
  used_by_username: string | null;
  used_by_display_name: string | null;
}
export interface InvitePage {
  items: RegistrationInvite[];
  next_cursor: string | null;
  server_time: number;
}
export interface InviteBatch {
  batch_id: string;
  items: {
    id: string;
    code: string;
    code_suffix: string;
    expires_at: number;
  }[];
}
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
