import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the actual native fixture helper with in-memory events only. Importing
// the native module would start services; extracting connect does not do that.
const source = readFileSync(
  new URL("./room-playlist-authority-native.mjs", import.meta.url), "utf8",
);
const marker = "  async function connect(";
const start = source.indexOf(marker);
const end = source.indexOf("\n  async function holder(", start);
assert.ok(start >= 0 && end > start, "Actual playlist connect must be present");
assert.equal(source.lastIndexOf(marker), start, "Connect extraction is unique");
const makeConnect = new Function(
  "WebSocket", "f", "bounded", "waitFor", "pause", "report", "randomUUID", "assert",
  `${source.slice(start, end)}\nreturn connect;`,
);

function fixture({
  onJoin,
  onClock,
  duringClose,
  duringPause,
  cleanupFailure,
  suppressClose = false,
  closedState = 3,
} = {}) {
  let socket, nonce = 0;
  const bounds = [], pauses = [];
  const waitFailure = Error("Mock expected a queued matching frame or sticky error");
  class MockSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, options) {
      super();
      assert.equal(url, "ws://owned.invalid/api/v1/ws");
      assert.deepEqual(options, {
        headers: { Origin: "http://owned.invalid", Cookie: "synthetic-owned-cookie" },
      });
      socket = this;
      this.readyState = MockSocket.CONNECTING;
      this.terminateCalls = 0;
      this.closeEvents = 0;
      this.sent = [];
      queueMicrotask(() => {
        this.readyState = MockSocket.OPEN;
        this.emit("open");
      });
    }
    message(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
    send(raw) {
      const request = JSON.parse(raw);
      this.sent.push(request);
      if (request.type === "JOIN") {
        assert.equal(request.room_id, "owned-room");
        if (onJoin) onJoin(this);
        else this.message({ type: "SNAPSHOT" });
      } else {
        assert.equal(request.type, "CLOCK_SYNC");
        if (onClock) onClock(this, request);
        else this.message({ type: "CLOCK_SYNC_REPLY", t1: request.t1 });
      }
    }
    finishClose() {
      this.readyState = closedState;
      this.closeEvents++;
      this.emit("close", 1006, Buffer.alloc(0));
    }
    terminate() {
      this.terminateCalls++;
      this.readyState = MockSocket.CLOSING;
      queueMicrotask(() => {
        duringClose?.(this);
        if (!suppressClose) this.finishClose();
      });
    }
    close() { assert.fail("Playlist cleanup must retain terminate semantics"); }
  }
  const connect = makeConnect(
    MockSocket,
    { origin: "http://owned.invalid" },
    (promise, ...args) => {
      bounds.push(args);
      // Model a failed existing cleanup bound without a real twelve-second wait.
      if (bounds.length > 1 && cleanupFailure) return Promise.reject(cleanupFailure);
      return promise;
    },
    async (predicate) => {
      if (predicate()) return;
      await Promise.resolve();
      if (!predicate()) throw waitFailure;
    },
    async (ms) => {
      pauses.push(ms);
      duringPause?.(socket);
    },
    { no_event_observation_ms: 250 },
    () => `synthetic-clock-${++nonce}`,
    assert,
  );
  return {
    open: () => connect({ cookie: "synthetic-owned-cookie" }, "owned-room"),
    socket: () => socket,
    bounds,
    pauses,
    waitFailure,
  };
}

function setupSyntaxError(error) {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.ok(error.errors[0] instanceof SyntaxError);
  assert.equal(error.errors[1], error.errors[0], "Setup and cleanup retain the first failure");
  return true;
}

test("valid playlist changes, bounded absence and actual termination still pass", async () => {
  const f = fixture(), peer = await f.open();
  f.socket().message({ type: "PLAYLIST_CHANGED" });
  await peer.nextChange();
  await peer.noChange();
  await peer.noChange();
  assert.deepEqual(f.pauses, [250, 250]);
  assert.deepEqual(f.socket().sent, [
    { type: "JOIN", room_id: "owned-room" },
    { type: "CLOCK_SYNC", t1: "synthetic-clock-1" },
    { type: "CLOCK_SYNC", t1: "synthetic-clock-2" },
  ]);
  await peer.close();
  await peer.close();
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 1);
  assert.equal(f.socket().readyState, 3);
  assert.deepEqual(f.bounds, [[], [], []], "Existing default bounds are unchanged");
});

test("malformed setup rejects immediately through actual termination", async () => {
  const f = fixture({ onJoin: (socket) => socket.emit("message", Buffer.from("{")) });
  await assert.rejects(f.open(), setupSyntaxError);
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 1);
});

for (const malformedFirst of [true, false]) {
  test(`queued SNAPSHOT cannot hide a ${malformedFirst ? "preceding" : "following"} malformed setup frame`, async () => {
    const f = fixture({ onJoin: (socket) => {
      if (malformedFirst) socket.emit("message", Buffer.from("{"));
      socket.message({ type: "SNAPSHOT" });
      if (!malformedFirst) socket.emit("message", Buffer.from("{"));
    } });
    await assert.rejects(f.open(), setupSyntaxError);
    assert.equal(f.socket().closeEvents, 1);
  });
}

test("queued playlist change cannot hide malformed input or overwrite the first frame error", async () => {
  const f = fixture(), peer = await f.open();
  f.socket().message({ type: "PLAYLIST_CHANGED" });
  assert.doesNotThrow(() => f.socket().emit("message", Buffer.from("{")));
  let first;
  await assert.rejects(peer.nextChange(), (error) => {
    assert.ok(error instanceof SyntaxError);
    first = error;
    return true;
  });
  f.socket().emit("message", Buffer.from("different malformed frame"));
  f.socket().emit("error", Error("later transport failure"));
  await assert.rejects(peer.noChange(), (error) => error === first);
  await assert.rejects(peer.close(), (error) => error === first);
  assert.equal(f.socket().closeEvents, 1);
});

test("queued clock reply cannot hide a malformed noChange frame", async () => {
  const f = fixture({ onClock: (socket, request) => {
    socket.message({ type: "CLOCK_SYNC_REPLY", t1: request.t1 });
    socket.emit("message", Buffer.from("{"));
  } });
  const peer = await f.open();
  await assert.rejects(peer.noChange(), SyntaxError);
  assert.deepEqual(f.pauses, [], "A known error is rejected before the observation pause");
  await assert.rejects(peer.close(), SyntaxError);
  assert.equal(f.socket().closeEvents, 1);
});

test("malformed frame in the bounded noChange observation remains a failure", async () => {
  const f = fixture({ duringPause: (socket) => socket.emit("message", Buffer.from("{")) });
  const peer = await f.open();
  await assert.rejects(peer.noChange(), SyntaxError);
  assert.deepEqual(f.pauses, [250]);
  await assert.rejects(peer.close(), SyntaxError);
  assert.equal(f.socket().closeEvents, 1);
});

test("malformed terminal frame after the last successful observation fails close", async () => {
  const f = fixture(), peer = await f.open();
  f.socket().message({ type: "PLAYLIST_CHANGED" });
  await peer.nextChange();
  await peer.noChange();
  f.socket().emit("message", Buffer.from("malformed final frame"));
  let first;
  await assert.rejects(peer.close(), (error) => {
    assert.ok(error instanceof SyntaxError);
    first = error;
    return true;
  });
  await assert.rejects(peer.close(), (error) => error === first);
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 1);
});

test("close waits for the actual close event before reporting a frame error", async () => {
  const f = fixture({ suppressClose: true }), peer = await f.open();
  let settled = false;
  const closing = peer.close();
  const rejected = assert.rejects(closing, SyntaxError);
  closing.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 0);
  f.socket().emit("message", Buffer.from("{"));
  await Promise.resolve();
  assert.equal(settled, false, "A sticky failure cannot skip owned cleanup");
  f.socket().finishClose();
  await rejected;
  assert.equal(f.socket().closeEvents, 1);
  assert.equal(f.socket().readyState, 3);
});

test("malformed frame emitted during terminate is retained after close", async () => {
  const f = fixture({ duringClose: (socket) => socket.emit("message", Buffer.from("{")) });
  const peer = await f.open();
  await assert.rejects(peer.close(), SyntaxError);
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 1);
});

test("first transport error wins over later transport and malformed frames", async () => {
  const f = fixture(), peer = await f.open();
  const first = Error("first owned transport failure");
  f.socket().message({ type: "PLAYLIST_CHANGED" });
  f.socket().emit("error", first);
  f.socket().emit("error", Error("later owned transport failure"));
  f.socket().emit("message", Buffer.from("{"));
  await assert.rejects(peer.nextChange(), (error) => error === first);
  await assert.rejects(peer.noChange(), (error) => error === first);
  await assert.rejects(peer.close(), (error) => error === first);
  assert.equal(f.socket().closeEvents, 1);
});

test("transport failure cannot hide behind the setup snapshot", async () => {
  const first = Error("setup transport failure");
  const f = fixture({ onJoin: (socket) => {
    socket.message({ type: "SNAPSHOT" });
    socket.emit("error", first);
  } });
  await assert.rejects(f.open(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, first]);
    return true;
  });
  assert.equal(f.socket().closeEvents, 1);
});

test("transport failure during noChange cannot hide behind a clock reply", async () => {
  const first = Error("clock transport failure");
  const f = fixture({ onClock: (socket, request) => {
    socket.message({ type: "CLOCK_SYNC_REPLY", t1: request.t1 });
    socket.emit("error", first);
  } });
  const peer = await f.open();
  await assert.rejects(peer.noChange(), (error) => error === first);
  await assert.rejects(peer.close(), (error) => error === first);
  assert.equal(f.socket().closeEvents, 1);
});

test("transport failure arriving during termination cannot turn into success", async () => {
  const first = Error("terminal transport failure");
  const f = fixture({ duringClose: (socket) => socket.emit("error", first) });
  const peer = await f.open();
  await assert.rejects(peer.close(), (error) => error === first);
  assert.equal(f.socket().closeEvents, 1);
});

test("bounded buffer overflow is sticky and still terminates the owned socket", async () => {
  const f = fixture(), peer = await f.open();
  // SNAPSHOT plus these frames exactly fill the unchanged 256-frame buffer.
  for (let i = 0; i < 255; i++) f.socket().message({ type: "UNRELATED", i });
  assert.doesNotThrow(() => f.socket().message({ type: "PLAYLIST_CHANGED" }));
  let first;
  await assert.rejects(peer.nextChange(), (error) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.match(error.message, /bounded owned socket buffer/);
    first = error;
    return true;
  });
  f.socket().emit("error", Error("later transport failure"));
  f.socket().emit("message", Buffer.from("{"));
  await assert.rejects(peer.noChange(), (error) => error === first);
  await assert.rejects(peer.close(), (error) => error === first);
  assert.equal(f.socket().closeEvents, 1);
});

test("cleanup failure remains an error even without a frame failure", async () => {
  const cleanup = Error("owned close deadline");
  const f = fixture({ cleanupFailure: cleanup, suppressClose: true });
  const peer = await f.open();
  await assert.rejects(peer.close(), (error) => error === cleanup);
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 0);
});

test("frame and cleanup failures are both retained in primary-first order", async () => {
  const first = Error("owned transport failure"), cleanup = Error("owned close deadline");
  const f = fixture({ cleanupFailure: cleanup, suppressClose: true });
  const peer = await f.open();
  f.socket().emit("error", first);
  await assert.rejects(peer.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "playlist_socket_frame_and_cleanup_failed");
    assert.deepEqual(error.errors, [first, cleanup]);
    return true;
  });
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 0);
});

test("setup primary and sticky frame plus cleanup failure all remain observable", async () => {
  const primary = Error("JOIN send failure"), frame = Error("setup transport failure");
  const cleanup = Error("owned close deadline");
  const f = fixture({ cleanupFailure: cleanup, suppressClose: true, onJoin: (socket) => {
    socket.emit("error", frame);
    throw primary;
  } });
  await assert.rejects(f.open(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], primary);
    const combined = error.errors[1];
    assert.ok(combined instanceof AggregateError);
    assert.deepEqual(combined.errors, [frame, cleanup]);
    return true;
  });
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 0);
});

test("close event cannot conceal a non-CLOSED readyState or its frame failure", async () => {
  const frame = Error("owned transport failure");
  const f = fixture({ closedState: 2 }), peer = await f.open();
  f.socket().emit("error", frame);
  await assert.rejects(peer.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], frame);
    assert.ok(error.errors[1] instanceof assert.AssertionError);
    return true;
  });
  assert.equal(f.socket().closeEvents, 1);
});

test("valid JSON still must match the exact playlist invalidation shape", async () => {
  const f = fixture(), peer = await f.open();
  f.socket().message({ type: "PLAYLIST_CHANGED", unexpected: true });
  await assert.rejects(peer.nextChange(), assert.AssertionError);
  await peer.close();
});

test("noChange still requires a live recipient and no playlist invalidation", async () => {
  const f = fixture(), peer = await f.open();
  f.socket().message({ type: "PLAYLIST_CHANGED" });
  await assert.rejects(peer.noChange(), /no invalidation in the bounded post-response observation window/);
  await peer.nextChange();
  f.socket().finishClose();
  await assert.rejects(peer.noChange(), /absence is observed on a live recipient/);
  await peer.close();
  assert.equal(f.socket().terminateCalls, 0);
});
