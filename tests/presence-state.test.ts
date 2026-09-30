import { describe, expect, it } from "vitest";
import {
  PresenceState,
  type OnlineSnapshot,
} from "../apps/web/src/features/rooms/presence-state";
const snapshot = (sequence = 1, epoch = "process-a"): OnlineSnapshot => ({
  roomId: "room",
  epoch,
  sequence,
  members: [{ userId: "user", connections: 2 }],
});
describe("presence connection and epoch fencing", () => {
  it("requires a handshake and accepts replaceable snapshots with sequence gaps", () => {
    const state = new PresenceState(),
      generation = state.begin("room");
    expect(state.accept(generation, snapshot())).toBe("ignored");
    expect(state.bind(generation, "connection", snapshot())).toBe("applied");
    expect(state.accept(generation, snapshot(100))).toBe("applied");
    expect(state.current?.sequence).toBe(100);
    expect(state.accept(generation, snapshot(99))).toBe("ignored");
    expect(state.accept(generation, { ...snapshot(100), members: [] })).toBe(
      "ignored",
    );
    expect(state.current?.members).toHaveLength(1);
  });
  it("old connection callbacks and old handshakes cannot overwrite a reconnect", () => {
    const state = new PresenceState(),
      old = state.begin("room");
    state.bind(old, "old", snapshot(100));
    const next = state.begin("room");
    expect(state.current).toBeUndefined();
    state.bind(next, "new", snapshot(1, "process-b"));
    expect(state.accept(old, snapshot(200))).toBe("ignored");
    expect(state.bind(old, "old", snapshot(300))).toBe("ignored");
    state.end(old);
    expect(state.current?.epoch).toBe("process-b");
  });
  it("unknown epochs require resync and cannot replace the current epoch", () => {
    const state = new PresenceState(),
      generation = state.begin("room");
    state.bind(generation, "connection", snapshot());
    expect(state.accept(generation, snapshot(999, "old-process"))).toBe(
      "resync",
    );
    expect(state.current).toBeUndefined();
    expect(state.bind(generation, "late", snapshot())).toBe("ignored");
  });
  it("duplicate handshake cannot reset the sequence or epoch", () => {
    const state = new PresenceState(),
      generation = state.begin("room");
    state.bind(generation, "connection", snapshot(100));
    expect(state.bind(generation, "late", snapshot(1, "other"))).toBe(
      "ignored",
    );
    expect(state.current?.sequence).toBe(100);
  });
  it("clears online claims on disconnect and room change", () => {
    const state = new PresenceState(),
      generation = state.begin("room");
    state.bind(generation, "connection", snapshot());
    state.end(generation);
    expect(state.current).toBeUndefined();
    const next = state.begin("other-room");
    expect(state.bind(next, "new", snapshot())).toBe("ignored");
  });
  it("replaces the whole collection, including an empty online snapshot", () => {
    const state = new PresenceState(),
      generation = state.begin("room");
    state.bind(generation, "connection", snapshot());
    expect(state.accept(generation, { ...snapshot(2), members: [] })).toBe(
      "applied",
    );
    expect(state.current?.members).toEqual([]);
  });
  it.each([
    { sequence: NaN },
    { sequence: -1 },
    { sequence: 2 ** 32 },
    { members: [{ userId: "user", connections: 0 }] },
    { members: [{ userId: "user", connections: 1.5 }] },
    { members: [{ userId: "user", connections: 9 }] },
    {
      members: [
        { userId: "user", connections: 1 },
        { userId: "user", connections: 2 },
      ],
    },
  ])(
    "rejects malformed state without changing the accepted snapshot: %j",
    (patch) => {
      const state = new PresenceState(),
        generation = state.begin("room");
      state.bind(generation, "connection", snapshot());
      expect(state.accept(generation, { ...snapshot(2), ...patch })).toBe(
        "ignored",
      );
      expect(state.current?.sequence).toBe(1);
    },
  );
  it("copies accepted collections so external mutation cannot bypass fencing", () => {
    const state = new PresenceState(),
      generation = state.begin("room"),
      value = snapshot();
    state.bind(generation, "connection", value);
    value.members[0].connections = 7;
    state.current!.members.length = 0;
    expect(state.current?.members[0].connections).toBe(2);
  });
});
