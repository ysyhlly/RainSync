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
export interface Room {
  id: string;
  name: string;
  owner_id: string;
}
export interface Media {
  id: string;
  title: string;
  duration_ms: number | null;
  kind: string;
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
