import { describe, expect, it } from "vitest";
import {
  canManageRoom,
  hasRoomPermission,
  isPlaybackController,
  permissionForControl,
  readRoomPermissionGrant,
  roomPermissionOptions,
} from "../apps/web/src/features/rooms/room-permissions";

const member = { id: "viewer", admin: false };
const admin = { id: "admin", admin: true };
const state = { controller_user_id: "controller" };
const room = { owner_id: "owner" };
const now = 1_000;
const authority = {
  active: true,
  controller: false,
  user: member,
  delegated: ["seek"] as const,
  expiresAt: 1_001,
};

describe("room permission decisions", () => {
  it.each([
    null, [], {},
    { self_permissions: ["seek"], members: null },
    { self_permissions: ["unknown"], members: [] },
    { self_permissions: ["seek"], members: [{ user_id: "viewer", expires_at: "later" }] },
    { self_permissions: ["seek"], members: [null] },
  ])("rejects malformed permission snapshots before publishing them: %j", (value) => {
    expect(() => readRoomPermissionGrant(value, member.id)).toThrow("房间权限响应不完整");
  });

  it("copies only a validated permission decision and its own expiry", () => {
    const snapshot = {
      self_permissions: ["seek"],
      members: [{ user_id: "other", expires_at: now - 1 }, { user_id: member.id, expires_at: now + 1 }],
    };
    const grant = readRoomPermissionGrant(snapshot, member.id);
    snapshot.self_permissions.length = 0;
    expect(grant).toEqual({ permissions: ["seek"], expiresAt: now + 1 });
  });
  it("maps end-of-media to change permission and rejects unknown/prototype names", () => {
    expect(permissionForControl("END_MEDIA")).toBe("change_media");
    expect(permissionForControl("SEEK")).toBe("seek");
    for (const command of ["", "play", "CLOSE", "constructor", "__proto__"])
      expect(permissionForControl(command)).toBeUndefined();
  });
  it("separates playback control from lifecycle ownership", () => {
    const owner = { id: room.owner_id, admin: false };
    expect(canManageRoom(room, owner)).toBe(true);
    expect(isPlaybackController(true, state, owner)).toBe(false);
    const controller = { id: state.controller_user_id, admin: false };
    expect(isPlaybackController(true, state, controller)).toBe(true);
    expect(canManageRoom(room, controller)).toBe(false);
    expect(canManageRoom(room, member)).toBe(false);
  });

  it("allows an administrator only after playback state is available", () => {
    expect(isPlaybackController(true, state, admin)).toBe(true);
    expect(isPlaybackController(true, undefined, admin)).toBe(false);
    expect(isPlaybackController(false, state, admin)).toBe(false);
    expect(canManageRoom(room, admin)).toBe(true);
    expect(canManageRoom(null, admin)).toBe(false);
  });

  it.each([null, undefined])(
    "rejects a missing identity %s, including cached grants",
    (user) => {
      expect(isPlaybackController(true, state, user)).toBe(false);
      expect(canManageRoom(room, user)).toBe(false);
      expect(hasRoomPermission("seek", { ...authority, user }, now)).toBe(
        false,
      );
      expect(
        hasRoomPermission(
          "seek",
          { ...authority, user, controller: true },
          now,
        ),
      ).toBe(false);
    },
  );

  it("expires exactly at the deadline and rejects invalid expiry values", () => {
    expect(hasRoomPermission("seek", authority, now)).toBe(true);
    for (const expiresAt of [now, now - 1, NaN, Infinity, -Infinity]) {
      expect(hasRoomPermission("seek", { ...authority, expiresAt }, now)).toBe(
        false,
      );
    }
    expect(
      hasRoomPermission("seek", { ...authority, expiresAt: null }, now),
    ).toBe(true);
  });

  it.each(roomPermissionOptions.map(({ value }) => value))(
    "requires the specific delegated permission %s",
    (permission) => {
      expect(hasRoomPermission(permission, authority, now)).toBe(
        permission === "seek",
      );
      expect(
        hasRoomPermission(
          permission,
          { ...authority, delegated: [permission] },
          now,
        ),
      ).toBe(true);
      expect(
        hasRoomPermission(
          permission,
          { ...authority, controller: true, expiresAt: now - 1 },
          now,
        ),
      ).toBe(true);
      expect(
        hasRoomPermission(
          permission,
          { ...authority, active: false, controller: true },
          now,
        ),
      ).toBe(false);
    },
  );

  it("keeps lifecycle management available for reopening a closed room", () => {
    const closed = { ...room, lifecycle: "closed" as const };
    expect(canManageRoom(closed, { id: room.owner_id, admin: false })).toBe(
      true,
    );
    expect(
      hasRoomPermission("close", { ...authority, active: false }, now),
    ).toBe(false);
  });
});
