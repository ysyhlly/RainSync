import type { Identity, Room, RoomPermission } from "../../shared/api/types";
import type { RoomState } from "../../../../../packages/protocol";

type RoomUser = Pick<Identity, "id" | "admin"> | null | undefined;

const controlPermissions = new Map<string, RoomPermission>([
  ["PLAY", "play"],
  ["PAUSE", "pause"],
  ["SEEK", "seek"],
  ["SET_RATE", "set_rate"],
  ["CHANGE_MEDIA", "change_media"],
  ["END_MEDIA", "change_media"],
]);

export function permissionForControl(command: string): RoomPermission | undefined {
  return controlPermissions.get(command);
}

export interface RoomPermissionGrant {
  permissions: readonly RoomPermission[];
  expiresAt: number | null;
}

/** Validate the complete decision before publishing it to synchronous watchers. */
export function readRoomPermissionGrant(value: unknown, userId: string | undefined): RoomPermissionGrant {
  const snapshot = value as { self_permissions?: unknown; members?: unknown } | null;
  const valid = new Set(roomPermissionOptions.map(option => option.value));
  if (!snapshot || !Array.isArray(snapshot.self_permissions) ||
      !snapshot.self_permissions.every(permission => valid.has(permission)) ||
      !Array.isArray(snapshot.members) || !snapshot.members.every(member =>
        member && typeof member.user_id === "string" &&
        (member.expires_at === null || Number.isSafeInteger(member.expires_at))))
    throw new TypeError("房间权限响应不完整");
  const member = snapshot.members.find(member => member.user_id === userId);
  return { permissions: [...snapshot.self_permissions], expiresAt: member?.expires_at ?? null };
}

export function isPlaybackController(
  active: boolean,
  state: Pick<RoomState, "controller_user_id"> | null | undefined,
  user: RoomUser,
): boolean {
  return (
    active &&
    !!state &&
    !!user &&
    (state.controller_user_id === user.id || user.admin)
  );
}

export function hasRoomPermission(
  permission: RoomPermission,
  authority: {
    active: boolean;
    controller: boolean;
    user: RoomUser;
    delegated: readonly RoomPermission[];
    expiresAt: number | null;
  },
  now = Date.now(),
): boolean {
  if (!authority.active || !authority.user) return false;
  if (authority.controller) return true;
  const expires = authority.expiresAt;
  return (
    (expires === null || (Number.isFinite(expires) && expires > now)) &&
    authority.delegated.includes(permission)
  );
}

// Lifecycle management remains available to owners of a closed room for reopening.
export function canManageRoom(
  room: Pick<Room, "owner_id"> | null | undefined,
  user: RoomUser,
): boolean {
  return !!room && !!user && (room.owner_id === user.id || user.admin);
}

export const roomPermissionOptions: { value: RoomPermission; label: string }[] =
  [
    { value: "invite", label: "邀请观看者" },
    { value: "kick", label: "移除成员" },
    { value: "close", label: "关闭房间" },
    { value: "play", label: "播放" },
    { value: "pause", label: "暂停" },
    { value: "seek", label: "跳转进度" },
    { value: "set_rate", label: "调整倍速" },
    { value: "change_media", label: "更换影片 / 自动下一部" },
    { value: "queue", label: "管理待播 / 导入影片" },
  ];
