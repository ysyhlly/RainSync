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

describe("presence input bounds and retired epochs", () => {
  it("ignores a known old epoch after a new socket handshake without clearing the new snapshot", () => {
    const state = new PresenceState();
    state.bind(state.begin("room"), "old", snapshot(100, "process-a"));
    const current = state.begin("room");
    state.bind(current, "new", snapshot(1, "process-b"));
    expect(state.accept(current, snapshot(999, "process-a"))).toBe("ignored");
    expect(state.current?.epoch).toBe("process-b");
    expect(state.current?.sequence).toBe(1);
  });

  it("bounds retired epoch memory and requires resync for epochs outside that history", () => {
    const state = new PresenceState();
    let current = 0;
    for (let index = 0; index < 10; index++) {
      current = state.begin("room");
      state.bind(current, "connection", snapshot(1, `process-${index}`));
    }
    expect(state.accept(current, snapshot(999, "process-8"))).toBe("ignored");
    expect(state.current?.epoch).toBe("process-9");
    expect(state.accept(current, snapshot(999, "process-0"))).toBe("resync");
  });

  it("allows an authenticated reconnect to re-establish an epoch in retired history", () => {
    const state = new PresenceState();
    state.bind(state.begin("room"), "first", snapshot(1, "process-a"));
    state.bind(state.begin("room"), "second", snapshot(1, "process-b"));
    const current = state.begin("room");
    expect(state.bind(current, "third", snapshot(2, "process-a"))).toBe(
      "applied",
    );
    expect(state.accept(current, snapshot(3, "process-a"))).toBe("applied");
  });

  it("bounds identifiers and ignores excessive member or connection counts", () => {
    const state = new PresenceState(),
      current = state.begin("room");
    expect(state.bind(current, "x".repeat(65), snapshot())).toBe("ignored");
    state.bind(current, "connection", snapshot());
    const invalid: OnlineSnapshot[] = [
      snapshot(2, "x".repeat(65)),
      { ...snapshot(2), members: [{ userId: "x".repeat(65), connections: 1 }] },
      {
        ...snapshot(2),
        members: Array.from({ length: 81 }, (_, index) => ({
          userId: `user-${index}`,
          connections: 1,
        })),
      },
      {
        ...snapshot(2),
        members: Array.from({ length: 11 }, (_, index) => ({
          userId: `user-${index}`,
          connections: 8,
        })),
      },
    ];
    for (const value of invalid)
      expect(state.accept(current, value)).toBe("ignored");
    expect(state.current?.sequence).toBe(1);
  });

  it("stores only known fields even if parsed JSON contains additional properties", () => {
    const state = new PresenceState(),
      current = state.begin("room");
    const value = {
      ...snapshot(),
      extra: { secret: "do not retain" },
      members: [
        { userId: "user", connections: 1, extra: { secret: "do not retain" } },
      ],
    };
    state.bind(current, "connection", value);
    expect(Object.keys(state.current!).sort()).toEqual([
      "epoch",
      "members",
      "roomId",
      "sequence",
    ]);
    expect(Object.keys(state.current!.members[0]).sort()).toEqual([
      "connections",
      "userId",
    ]);
  });
});
