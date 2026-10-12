import type { DeepReadonly } from "vue";
import type { RoomState } from "../../../../../../packages/protocol";
import type { ApiClient } from "../../../shared/api/client";
import type {
  RoomInvitation,
  RoomInvitePolicy,
  RoomPermission,
} from "../../../shared/api/types";
import { RequestFailure } from "../../../errors";
import { permissionForControl } from "../room-permissions";
import {
  roomProjectionActive,
  type LifecycleView,
  type RoomProjection,
} from "../projection/room-projection";
import type { RoomRequestScope, RoomScopePort } from "./room-scope";

export type RoomCommandObservation = DeepReadonly<
  Pick<RoomProjection, "room" | "state" | "controlEpoch">
>;

export function createRoomCommands(options: {
  api: ApiClient;
  scope: RoomScopePort;
  read: () => RoomCommandObservation;
  connected: () => boolean;
  can: (permission: RoomPermission) => boolean;
  canManage: () => boolean;
  send: (payload: unknown) => boolean;
  accept: (
    input: { owner_id: string; state: RoomState } | LifecycleView,
    scope: RoomRequestScope,
  ) => boolean;
  connect: () => void;
}) {
  function send(type: string, payload?: unknown) {
    const permission = permissionForControl(type),
      value = options.read(),
      state = value.state;
    if (
      !permission ||
      !options.connected() ||
      !options.can(permission) ||
      !state ||
      !value.controlEpoch
    )
      return false;
    if (
      state.live &&
      (type === "SEEK" ||
        type === "END_MEDIA" ||
        (type === "SET_RATE" && (payload as { rate?: number })?.rate !== 1))
    )
      return false;
    return options.send({
      ...(state.live || type === "CHANGE_MEDIA" || type === "END_MEDIA"
        ? { live_version: 1 }
        : {}),
      protocol_version: 1,
      type,
      payload,
      room_id: state.room_id,
      command_id: crypto.randomUUID(),
      control_epoch: value.controlEpoch,
      expected_revision: state.revision,
      media_generation: state.media_generation,
    });
  }
  async function transferOwnership(ownerId: string) {
    const state = options.read().state,
      scope = options.scope.capture();
    if (!state || !scope || !options.canManage())
      throw Error("当前无法转让房间");
    const result = await options.api<{ owner_id: string; state: RoomState }>(
      `/rooms/${scope.room}/owner`,
      "POST",
      { owner_id: ownerId, expected_revision: state.revision },
    );
    // Commit success is retained even when its now-stale projection is ignored.
    options.accept(result, scope);
  }
  async function refreshLifecycle() {
    const scope = options.scope.capture();
    if (!scope) return;
    const value = await options.api<LifecycleView>(
      `/rooms/${scope.room}/lifecycle`,
    );
    options.accept(value, scope);
  }
  async function changeLifecycle(action: "close" | "reopen" | "archive") {
    const state = options.read().state,
      scope = options.scope.capture();
    if (
      !state ||
      !scope ||
      !(options.canManage() || (action === "close" && options.can("close")))
    )
      throw Error("当前无法管理房间");
    try {
      const value = await options.api<LifecycleView>(
        `/rooms/${scope.room}/${action}`,
        "POST",
        { expected_revision: state.revision },
      );
      if (options.accept(value, scope) && action === "reopen")
        options.connect();
    } catch (failure) {
      if (
        options.scope.current(scope) &&
        failure instanceof RequestFailure &&
        ["REVISION_CONFLICT", "ROOM_LIFECYCLE_CONFLICT"].includes(failure.code)
      ) {
        await refreshLifecycle().catch(() => {
          // Preserve the original conflict when its recovery read also fails.
        });
      }
      throw failure;
    }
  }
  async function makeInvite(policy?: RoomInvitePolicy) {
    const value = options.read();
    if (!value.room || !roomProjectionActive(value))
      throw Error("房间当前未开放");
    return options.api<RoomInvitation>(
      `/rooms/${value.room.id}/invites`,
      "POST",
      policy,
    );
  }
  async function revokeInvite(invite: RoomInvitation) {
    await options.api(
      `/rooms/${invite.room_id}/invites/${encodeURIComponent(invite.token)}`,
      "DELETE",
    );
  }
  return {
    send,
    choose: async (id: string) => send("CHANGE_MEDIA", { media_id: id }),
    transferOwnership,
    refreshLifecycle,
    changeLifecycle,
    makeInvite,
    revokeInvite,
  };
}
