import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the current native fixture's observer with in-memory events only.
// Importing the fixture itself would start services, so extract its full helper.
const source = readFileSync(
  new URL("./room-directory-authority-native.mjs", import.meta.url),
  "utf8",
);
const marker = "    async function observer(";
const start = source.indexOf(marker);
const end = source.indexOf("\n    const cases = [", start);
assert.ok(start >= 0 && end > start, "Actual directory observer must be present");
assert.equal(source.lastIndexOf(marker), start, "Observer extraction is unique");
const makeObserver = new Function(
  "WebSocket", "f", "signal", "bounded", "pause", "privateFile", "assert",
  `${source.slice(start, end)}\nreturn observer;`,
);

function fixture({
  duringClose,
  normalFailure,
  forcedFailure,
  malformedSetup = false,
} = {}) {
  let socket;
  const bounds = [], receipts = [];
  class MockSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      super();
      socket = this;
      this.readyState = MockSocket.OPEN;
      this.closeCalls = 0;
      this.terminateCalls = 0;
      this.closeEvents = 0;
      queueMicrotask(() => this.emit("open"));
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.type === "JOIN") {
        this.emit("message", Buffer.from(malformedSetup ? "{" : JSON.stringify({
          type: "SNAPSHOT",
          state: { room_id: "owned-room", clock_epoch: "owned-epoch" },
        })));
      } else {
        assert.equal(request.type, "CLOCK_SYNC");
        this.emit("message", Buffer.from(JSON.stringify({
          type: "CLOCK_SYNC_REPLY", t1: request.t1,
          t2: request.t1 + 1, t3: request.t1 + 2, clock_epoch: "owned-epoch",
        })));
      }
    }
    finishClose(code) {
      this.readyState = MockSocket.CLOSED;
      this.closeEvents++;
      this.emit("close", code, Buffer.alloc(0));
    }
    close(code) {
      this.closeCalls++;
      this.readyState = MockSocket.CLOSING;
      queueMicrotask(() => {
        duringClose?.(this);
        if (!normalFailure) this.finishClose(code);
      });
    }
    terminate() {
      this.terminateCalls++;
      if (!forcedFailure) queueMicrotask(() => this.finishClose(1006));
    }
  }
  // Deterministic cleanup deadlines: retain the real helper's requested bounds,
  // but do not open sockets or wait twelve seconds to model a failed close.
  const bounded = (promise, ms, observeAbort) => {
    if (observeAbort === false) {
      bounds.push({ ms, observeAbort });
      assert.equal(ms, 12000);
      if (bounds.length === 1 && normalFailure)
        return Promise.reject(normalFailure);
      if (bounds.length === 2 && forcedFailure)
        return Promise.reject(forcedFailure);
    }
    return promise;
  };
  const observer = makeObserver(
    MockSocket,
    { origin: "http://owned.invalid" },
    new AbortController().signal,
    bounded,
    async () => { throw Error("Mock expected a queued matching frame"); },
    async (label, suffix, bytes) => {
      const receipt = { label, suffix, bytes };
      receipts.push(receipt);
      return receipt;
    },
    assert,
  );
  return {
    open: () => observer(
      { live: { cookie: "synthetic-owned-cookie" } },
      { id: "owned-room" },
      "directory-test",
    ),
    socket: () => socket,
    bounds,
    receipts,
  };
}

test("valid directory clock samples and one normal close preserve actual receipts", async () => {
  const f = fixture(), observer = await f.open();
  const first = await observer.clock(), second = await observer.clock();
  assert.equal(first.value.clock_epoch, "owned-epoch");
  assert.equal(second.value.t1, first.value.t1 + 1);
  assert.ok(second.value.t3 > first.value.t3);
  assert.equal(f.receipts.length, 2);
  assert.deepEqual(await observer.close(), {
    close_observed: true, code: 1000, reason_bytes: 0,
  });
  await observer.close();
  assert.equal(f.socket().closeCalls, 1, "Repeated cleanup reuses its outcome");
  assert.equal(f.socket().terminateCalls, 0);
  assert.equal(f.socket().closeEvents, 1);
  assert.deepEqual(f.bounds, [{ ms: 12000, observeAbort: false }]);
});

test("malformed setup frame rejects through actual owned close", async () => {
  const f = fixture({ malformedSetup: true });
  await assert.rejects(f.open(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "directory_observer_setup_and_cleanup_failed");
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors.every((item) => item instanceof SyntaxError));
    return true;
  });
  assert.equal(f.socket().closeEvents, 1);
});

test("malformed message cannot escape its event listener or hide behind a valid reply", async () => {
  const f = fixture(), observer = await f.open();
  assert.doesNotThrow(() => f.socket().emit("message", Buffer.from("{")));
  await assert.rejects(observer.clock(), SyntaxError);
  await assert.rejects(observer.close(), SyntaxError);
  assert.equal(f.socket().closeCalls, 1);
  assert.equal(f.socket().closeEvents, 1);
});

test("malformed terminal frame fails cleanup after the final valid sample", async () => {
  const f = fixture(), observer = await f.open();
  await observer.clock();
  f.socket().emit("message", Buffer.from("malformed final frame"));
  let firstFailure;
  await assert.rejects(observer.close(), (error) => {
    assert.ok(error instanceof SyntaxError);
    firstFailure = error;
    return true;
  });
  await assert.rejects(observer.close(), (error) => error === firstFailure);
  assert.equal(f.socket().closeEvents, 1);
  assert.equal(f.socket().closeCalls, 1);
});

test("malformed frame during the close wait is retained after observed close", async () => {
  const f = fixture({
    duringClose: (socket) => socket.emit("message", Buffer.from("{")),
  });
  const observer = await f.open();
  await observer.clock();
  await assert.rejects(observer.close(), SyntaxError);
  assert.equal(f.socket().closeEvents, 1);
  assert.equal(f.socket().terminateCalls, 0);
});

test("first transport error remains sticky and does not prevent actual cleanup", async () => {
  const f = fixture(), observer = await f.open();
  await observer.clock();
  const first = Error("first owned transport failure");
  f.socket().emit("error", first);
  f.socket().emit("error", Error("later transport failure"));
  f.socket().emit("message", Buffer.from("{"));
  await assert.rejects(observer.close(), (error) => error === first);
  assert.equal(f.socket().closeEvents, 1);
});

test("forced close success cannot convert normal close timeout into a pass", async () => {
  const normal = Error("normal owned close timeout");
  const f = fixture({ normalFailure: normal }), observer = await f.open();
  await assert.rejects(observer.close(), (error) => error === normal);
  assert.equal(f.socket().closeCalls, 1);
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 1);
  assert.equal(f.bounds.length, 2);
});

test("normal and forced close failures are both retained in original order", async () => {
  const normal = Error("normal owned close timeout"), forced = Error("forced owned close timeout");
  const f = fixture({ normalFailure: normal, forcedFailure: forced });
  const observer = await f.open();
  await assert.rejects(observer.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "directory_observer_forced_close_failed");
    assert.deepEqual(error.errors, [normal, forced]);
    return true;
  });
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 0);
  assert.equal(f.bounds.length, 2);
});

test("frame failure and both cleanup failures remain observable together", async () => {
  const frame = Error("owned transport failure"), normal = Error("normal timeout"), forced = Error("forced timeout");
  const f = fixture({ normalFailure: normal, forcedFailure: forced });
  const observer = await f.open();
  f.socket().emit("error", frame);
  await assert.rejects(observer.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "directory_observer_frame_and_cleanup_failed");
    assert.equal(error.errors[0], frame);
    const cleanup = error.errors[1];
    assert.ok(cleanup instanceof AggregateError);
    assert.equal(cleanup.message, "directory_observer_forced_close_failed");
    assert.deepEqual(cleanup.errors, [normal, forced]);
    return true;
  });
  assert.equal(f.socket().closeCalls, 1);
  assert.equal(f.socket().terminateCalls, 1);
  assert.equal(f.socket().closeEvents, 0);
});

// Keep the native oracle aligned with the existing public error mapping.
// These are source contracts only; they do not execute a database case.
for (const name of ["blank_name", "unicode_121"]) {
  test(`directory ${name} expects the public INVALID_NAME code`, () => {
    const start = source.indexOf(`          "${name}",`);
    assert.ok(start >= 0);
    const end = source.indexOf("\n        ],", start);
    assert.ok(end > start);
    const entry = source.slice(start, end);
    assert.match(entry, /400,\s*"INVALID_NAME"/);
    assert.doesNotMatch(entry, /"INVALID_REQUEST"/);
    const production = readFileSync(
      new URL("../apps/server/src/room_directory_operations.rs", import.meta.url), "utf8",
    );
    assert.match(production, /"invalid_name"/);
    const errors = readFileSync(
      new URL("../crates/protocol/src/errors.rs", import.meta.url), "utf8",
    );
    assert.match(errors, /InvalidName/);
  });
}
