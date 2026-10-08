import type { RoomState } from "../../../../../../packages/protocol";
import type { Room, RoomLifecycle } from "../../../shared/api/types";

/** One authoritative value is published before any resulting side effect runs. */
export type RoomProjection = {
  room: Room | null;
  state: RoomState | null;
  controlEpoch: string | undefined;
  snapshotReady: boolean;
  cleanupError: string;
};

export type RoomProjectionEffect =
  | { type: "resume" }
  | { type: "invalidate-clock" }
  | { type: "calibrate-clock" }
  | { type: "refresh-playlist" }
  | { type: "snapshot-applied"; metricsVersion: unknown }
  | { type: "clear-chat" }
  | { type: "reset-playback" }
  | { type: "media-changed" }
  | { type: "apply-playback"; seek: boolean };

export type RoomProjectionResult = {
  value: RoomProjection;
  accepted: boolean;
  effects: RoomProjectionEffect[];
};

export type RoomStateFrame = {
  type?: unknown;
  state: RoomState;
  owner_id?: unknown;
  lifecycle?: unknown;
  lifecycle_epoch?: number;
  control_epoch?: { id?: unknown } | null;
  control_recovery_metrics_version?: unknown;
  action?: { type?: unknown };
};

export type LifecycleView = {
  lifecycle: RoomLifecycle;
  lifecycle_epoch: number;
  owner_id: string;
  state: RoomState;
  cleanup?: {
    attempts: number;
    last_error: string | null;
    completed: boolean;
  } | null;
};

export function emptyRoomProjection(): RoomProjection {
  return {
    room: null,
    state: null,
    controlEpoch: undefined,
    snapshotReady: false,
    cleanupError: "",
  };
}

export function roomProjectionActive(value: {
  readonly room: Readonly<Pick<Room, "lifecycle">> | null;
}): boolean {
  return !!value.room && (value.room.lifecycle ?? "active") === "active";
}

export function beginRoomConnection(value: RoomProjection): RoomProjection {
  return { ...value, controlEpoch: undefined, snapshotReady: false };
}

function staleState(value: RoomProjection, next: RoomState): boolean {
  return (
    !value.room ||
    next.room_id !== value.room.id ||
    !!(
      value.state &&
      value.state.clock_epoch === next.clock_epoch &&
      next.revision < value.state.revision
    )
  );
}

/** Pure WS projection: socket generations and clock sampling live in transport. */
export function projectRoomFrame(
  previous: RoomProjection,
  frame: RoomStateFrame,
): RoomProjectionResult {
  const old = previous.state,
    next = frame.state,
    snapshot = frame.type === "SNAPSHOT";
  if (staleState(previous, next))
    return { value: previous, accepted: false, effects: [] };
  if (
    !snapshot &&
    (!previous.snapshotReady ||
      !old ||
      old.clock_epoch !== next.clock_epoch ||
      next.revision > old.revision + 1)
  ) {
    // An ACK/EVENT cannot prove that missing owner/lifecycle metadata recovered.
    return {
      value: beginRoomConnection(previous),
      accepted: false,
      effects: [{ type: "resume" }],
    };
  }
  const room = { ...previous.room! };
  if (typeof frame.owner_id === "string") room.owner_id = frame.owner_id;
  if (
    typeof frame.lifecycle === "string" &&
    ["active", "closing", "closed", "archived"].includes(frame.lifecycle)
  ) {
    room.lifecycle = frame.lifecycle as RoomLifecycle;
    room.lifecycle_epoch = frame.lifecycle_epoch;
  }
  const value: RoomProjection = {
    ...previous,
    room,
    state: next,
    snapshotReady: true,
  };
  const wasActive = roomProjectionActive(previous),
    active = roomProjectionActive(value);
  if (frame.control_epoch === null || !active) value.controlEpoch = undefined;
  else if (typeof frame.control_epoch?.id === "string")
    value.controlEpoch = frame.control_epoch.id;
  const effects: RoomProjectionEffect[] = [];
  if (snapshot) {
    effects.push({ type: "refresh-playlist" });
    effects.push({
      type: "snapshot-applied",
      metricsVersion: frame.control_recovery_metrics_version,
    });
  }
  if (!previous.snapshotReady || old?.clock_epoch !== next.clock_epoch)
    effects.push({ type: "calibrate-clock" });
  if (!active) {
    effects.push({ type: "clear-chat" });
    if (wasActive || !old) effects.push({ type: "reset-playback" });
  } else {
    const duplicate =
      !snapshot &&
      old?.clock_epoch === next.clock_epoch &&
      old.revision === next.revision;
    if (!duplicate || !wasActive) {
      if (
        !wasActive ||
        !old ||
        old.media_generation !== next.media_generation ||
        old.live?.broadcast_id !== next.live?.broadcast_id
      ) {
        effects.push({ type: "media-changed" });
        if (!snapshot) effects.push({ type: "refresh-playlist" });
      } else {
        effects.push({
          type: "apply-playback",
          seek: frame.action?.type === "SEEK",
        });
      }
    }
  }
  return { value, accepted: true, effects };
}

/** Callers must validate the original HTTP request scope before projecting. */
export function projectRoomHttp(
  previous: RoomProjection,
  input: { state: RoomState; owner_id: string } | LifecycleView,
  connected: boolean,
): RoomProjectionResult {
  if (staleState(previous, input.state))
    return { value: previous, accepted: false, effects: [] };
  const lifecycle = "lifecycle" in input ? input : undefined;
  const value: RoomProjection = {
    ...previous,
    room: {
      ...previous.room!,
      owner_id: input.owner_id,
      ...(lifecycle && {
        lifecycle: lifecycle.lifecycle,
        lifecycle_epoch: lifecycle.lifecycle_epoch,
      }),
    },
    state: input.state,
    cleanupError: lifecycle
      ? lifecycle.cleanup?.last_error
        ? "清理尚未完成，服务端将继续重试。"
        : ""
      : previous.cleanupError,
  };
  const active = roomProjectionActive(value),
    effects: RoomProjectionEffect[] = [];
  if (previous.state?.clock_epoch !== input.state.clock_epoch) {
    value.snapshotReady = false;
    value.controlEpoch = undefined;
    effects.push({ type: connected && active ? "resume" : "invalidate-clock" });
  }
  if (lifecycle && !active) {
    value.controlEpoch = undefined;
    effects.push({ type: "clear-chat" }, { type: "reset-playback" });
  }
  return { value, accepted: true, effects };
}
