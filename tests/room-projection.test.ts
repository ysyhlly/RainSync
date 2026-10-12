import { describe, expect, it } from "vitest";
import type { RoomState } from "../packages/protocol";
import {
  beginRoomConnection,
  emptyRoomProjection,
  projectRoomFrame,
  projectRoomHttp,
  type RoomProjection,
} from "../apps/web/src/features/rooms/projection/room-projection";
import {
  emptyChatProjection,
  projectChatDeletion,
  projectChatHistory,
  projectChatMessage,
} from "../apps/web/src/features/rooms/projection/chat-projection";
import { createRoomScopePort } from "../apps/web/src/features/rooms/commands/room-scope";
import type { Message } from "../apps/web/src/shared/api/types";
import type { RoomCommandObservation } from "../apps/web/src/features/rooms/commands/room-commands";
import type { RoomTransportObservation } from "../apps/web/src/features/rooms/transport/room-transport";

// Compiled by the P06 port gate, never invoked. These modules observe only;
// all authoritative room/state publication remains with the projection owner.
function finiteRoomPorts(
  commands: RoomCommandObservation,
  transport: RoomTransportObservation,
) {
  // @ts-expect-error Commands cannot supply their own control epoch.
  commands.controlEpoch = "invented";
  if (commands.room) {
    // @ts-expect-error Nested room lifecycle is readonly.
    commands.room.lifecycle = "closed";
  }
  if (commands.state) {
    // @ts-expect-error Nested room revision is readonly.
    commands.state.revision++;
    if (commands.state.live) {
      // @ts-expect-error Deeply nested broadcast identity is readonly.
      commands.state.live.broadcast_id = "invented";
    }
  }
  // @ts-expect-error Commands cannot replace the authoritative snapshot.
  commands.state = null;
  // @ts-expect-error Transport cannot certify its own snapshot as projected.
  transport.snapshotReady = true;
  if (transport.room) {
    // @ts-expect-error Nested room ownership is readonly.
    transport.room.owner_id = "invented";
  }
  if (transport.state) {
    // @ts-expect-error Transport cannot advance a projected revision.
    transport.state.revision++;
    if (transport.state.live) {
      // @ts-expect-error Deeply nested broadcast identity is readonly.
      transport.state.live.broadcast_id = "invented";
    }
  }
  // @ts-expect-error Transport cannot replace projected room ownership.
  transport.room = null;
}
void finiteRoomPorts;

const state: RoomState = {
  room_id: "room",
  revision: 8,
  media_id: "film",
  media_generation: 3,
  playback_status: "paused",
  anchor_position_ms: 4000,
  anchor_server_time_ms: 1000,
  playback_rate: 1,
  controller_user_id: "owner",
  duration_ms: 100000,
  clock_epoch: "clock",
};
function ready(): RoomProjection {
  return {
    ...emptyRoomProjection(),
    room: {
      id: "room",
      name: "Room",
      owner_id: "owner",
      lifecycle: "active",
      lifecycle_epoch: 0,
    },
    state,
    controlEpoch: "control",
    snapshotReady: true,
  };
}
function mediaEffects(value: ReturnType<typeof projectRoomFrame>) {
  return value.effects.filter((effect) =>
    ["media-changed", "apply-playback", "reset-playback"].includes(effect.type),
  );
}

describe("pure atomic room projection", () => {
  it.each(["ACK", "EVENT"])(
    "applies same-revision %s metadata without repeating SEEK",
    (type) => {
      const previous = ready();
      const result = projectRoomFrame(previous, {
        type,
        state: { ...state, controller_user_id: "next" },
        owner_id: "next",
        control_epoch: { id: "fresh" },
        action: { type: "SEEK" },
      });
      expect(result.accepted).toBe(true);
      expect(result.value).toMatchObject({
        room: { owner_id: "next" },
        state: { controller_user_id: "next" },
        controlEpoch: "fresh",
        snapshotReady: true,
      });
      expect(mediaEffects(result)).toEqual([]);
      expect(previous.room?.owner_id).toBe("owner");
      expect(previous.controlEpoch).toBe("control");
    },
  );
  it("closes at the same revision and emits one reset without a second reset for duplicate close", () => {
    const close = {
      type: "EVENT",
      state,
      owner_id: "next",
      lifecycle: "closing",
      lifecycle_epoch: 2,
      control_epoch: null,
    };
    const first = projectRoomFrame(ready(), close);
    expect(first.value).toMatchObject({
      room: { owner_id: "next", lifecycle: "closing", lifecycle_epoch: 2 },
      controlEpoch: undefined,
    });
    expect(mediaEffects(first)).toEqual([{ type: "reset-playback" }]);
    expect(mediaEffects(projectRoomFrame(first.value, close))).toEqual([]);
    const reopened = projectRoomFrame(first.value, {
      type: "ACK",
      state,
      lifecycle: "active",
      lifecycle_epoch: 3,
      control_epoch: { id: "reopened" },
    });
    expect(mediaEffects(reopened)).toEqual([{ type: "media-changed" }]);
  });
  it.each(["ACK", "EVENT"])(
    "a %s gap requests RESUME without projecting partial metadata",
    (type) => {
      const previous = ready();
      const result = projectRoomFrame(previous, {
        type,
        state: { ...state, revision: 10 },
        owner_id: "unconfirmed",
        lifecycle: "closed",
        control_epoch: { id: "unconfirmed" },
      });
      expect(result.accepted).toBe(false);
      expect(result.value.state).toBe(previous.state);
      expect(result.value.room).toBe(previous.room);
      expect(result.value.controlEpoch).toBeUndefined();
      expect(result.value.snapshotReady).toBe(false);
      expect(result.effects).toEqual([{ type: "resume" }]);
    },
  );
  it("a changed clock epoch needs a snapshot, while a snapshot may restart its revision", () => {
    const next = { ...state, clock_epoch: "new-clock", revision: 1 };
    const event = projectRoomFrame(ready(), { type: "EVENT", state: next });
    expect(event.effects).toEqual([{ type: "resume" }]);
    const snapshot = projectRoomFrame(event.value, {
      type: "SNAPSHOT",
      state: next,
      owner_id: "new-owner",
      control_epoch: { id: "new-control" },
    });
    expect(snapshot.value.state).toBe(next);
    expect(snapshot.value.room?.owner_id).toBe("new-owner");
    expect(snapshot.effects.map((effect) => effect.type)).toEqual([
      "refresh-playlist",
      "snapshot-applied",
      "calibrate-clock",
      "apply-playback",
    ]);
  });
  it("rejects an old revision or another room without touching any projected field", () => {
    const previous = ready();
    for (const next of [
      { ...state, revision: 7 },
      { ...state, room_id: "other" },
    ]) {
      const result = projectRoomFrame(previous, {
        type: "SNAPSHOT",
        state: next,
        owner_id: "wrong",
        lifecycle: "closed",
      });
      expect(result).toEqual({ value: previous, accepted: false, effects: [] });
    }
  });
  it("a continuous event cannot recover a new connection before its snapshot", () => {
    const result = projectRoomFrame(beginRoomConnection(ready()), {
      type: "EVENT",
      state: { ...state, revision: 9 },
    });
    expect(result.accepted).toBe(false);
    expect(result.effects).toEqual([{ type: "resume" }]);
  });
  it("preserves seeking semantics and does not mutate the supplied frame", () => {
    const frame = Object.freeze({
      type: "EVENT",
      state: Object.freeze({ ...state, revision: 9 }),
      action: Object.freeze({ type: "SEEK" }),
    });
    expect(mediaEffects(projectRoomFrame(ready(), frame))).toEqual([
      { type: "apply-playback", seek: true },
    ]);
    expect(
      mediaEffects(
        projectRoomFrame(ready(), {
          ...frame,
          state: { ...frame.state, media_generation: 4 },
        }),
      ),
    ).toEqual([{ type: "media-changed" }]);
  });
  it("publishes HTTP lifecycle, ownership, state and safe cleanup notice as one result", () => {
    const previous = ready();
    const result = projectRoomHttp(
      previous,
      {
        state: { ...state, revision: 9 },
        owner_id: "next",
        lifecycle: "closed",
        lifecycle_epoch: 4,
        cleanup: {
          attempts: 1,
          completed: false,
          last_error: "private backend content",
        },
      },
      true,
    );
    expect(result.value).toMatchObject({
      room: { lifecycle: "closed", lifecycle_epoch: 4, owner_id: "next" },
      state: { revision: 9 },
      controlEpoch: undefined,
      cleanupError: "清理尚未完成，服务端将继续重试。",
    });
    expect(JSON.stringify(result)).not.toContain("private backend content");
    expect(previous.room?.lifecycle).toBe("active");
    expect(result.effects).toEqual([
      { type: "clear-chat" },
      { type: "reset-playback" },
    ]);
  });
  it.each([true, false])(
    "HTTP epoch changes invalidate controls before async work, connected=%s",
    (connected) => {
      const result = projectRoomHttp(
        ready(),
        {
          owner_id: "next",
          state: { ...state, revision: 1, clock_epoch: "next" },
        },
        connected,
      );
      expect(result.value).toMatchObject({
        snapshotReady: false,
        controlEpoch: undefined,
      });
      expect(result.effects).toEqual([
        { type: connected ? "resume" : "invalidate-clock" },
      ]);
    },
  );
});

describe("room request scopes", () => {
  it("keeps identity, room, room generation, and connection generation distinct", () => {
    const original = {
      identity: 1,
      room: "room",
      roomGeneration: 2,
      connectionGeneration: 3,
    };
    let current = { ...original };
    const port = createRoomScopePort(() => current),
      scope = port.capture()!;
    expect(Object.isFrozen(scope)).toBe(true);
    for (const delta of [
      { identity: 2 },
      { room: "next" },
      { roomGeneration: 3 },
      { connectionGeneration: 4 },
    ]) {
      current = { ...original, ...delta };
      expect(port.current(scope)).toBe(false);
      expect(port.currentRoom(scope)).toBe("connectionGeneration" in delta);
    }
  });
  it("cannot reuse coincident counters from another runtime owner", () => {
    const read = () => ({
      identity: 1,
      room: "room",
      roomGeneration: 2,
      connectionGeneration: 3,
    });
    const first = createRoomScopePort(read),
      second = createRoomScopePort(read);
    expect(second.current(first.capture()!)).toBe(false);
    expect(second.currentRoom(first.capture()!)).toBe(false);
  });
});

describe("chat projection", () => {
  const message = (id: string, body = "body") => ({ id, body }) as Message;
  it("late history and live duplicates cannot resurrect deleted content", () => {
    const current = projectChatDeletion(
      projectChatMessage(emptyChatProjection(), message("one")),
      "one",
    );
    const recovered = projectChatHistory(
      current,
      [message("one")],
      [message("one", "private"), message("two")],
    );
    expect(recovered.messages[0]).toMatchObject({
      id: "one",
      body: "",
      deleted: true,
    });
    expect(
      projectChatMessage(recovered, message("one", "private")).messages,
    ).toEqual(recovered.messages);
    expect(recovered.lastDeletion).toBe("one");
  });
  it("live content wins duplicate history while tombstones and the 2000-message cap survive", () => {
    const live = projectChatMessage(
      emptyChatProjection(),
      message("latest", "live"),
    );
    const history = Array.from({ length: 2000 }, (_, index) =>
      message(`m${index}`),
    );
    const result = projectChatHistory(
      live,
      [],
      [...history, message("latest", "history")],
    );
    expect(result.messages).toHaveLength(2000);
    expect(result.messages.at(-1)?.body).toBe("live");
  });
});
