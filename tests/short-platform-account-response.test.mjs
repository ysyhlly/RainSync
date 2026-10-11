// Fake response streams and manually resolved promises only; no network or DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  trackResponseBody, cleanupShortAccountCase, privateFailureDetails,
} from "./fixtures/short-platform-account-response.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fakeResponse(readResult) {
  const started = deferred();
  let reads = 0;
  return {
    status: 401,
    get bodyUsed() { return reads > 0; },
    get reads() { return reads; },
    started: started.promise,
    text() { reads++; started.resolve(); return readResult; },
  };
}
function fixture(pending, extras = {}) {
  const body = trackResponseBody(pending), calls = [], bounds = [];
  return {
    body, calls, bounds,
    options: {
      pending, body,
      wait: (promise, ms) => { bounds.push(ms); return promise; },
      release: async () => { calls.push("release"); },
      record: async (_response, text) => { calls.push(`record:${text}`); },
      drop: async () => { calls.push("drop"); },
      ...extras,
    },
  };
}

function aggregateHas(error, expected) {
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "first_failure_and_cleanup");
  assert.deepEqual(error.errors, expected);
  return true;
}

test("successful delayed drain shares one read and precedes trigger DROP", async () => {
  const content = deferred(), response = fakeResponse(content.promise);
  const f = fixture(Promise.resolve(response));
  const firstRead = f.body.read();
  assert.equal(f.body.read(), firstRead);
  const cleaning = cleanupShortAccountCase(f.options);
  await response.started;
  assert.equal(response.bodyUsed, true);
  assert.equal(f.body.bodyDrained, false);
  assert.deepEqual(f.calls, ["release"]);
  content.resolve("complete");
  await cleaning;
  assert.equal(await firstRead, "complete");
  assert.equal(response.reads, 1);
  assert.equal(f.body.bodyDrained, true);
  assert.deepEqual(f.calls, ["release", "record:complete", "drop"]);
  assert.deepEqual(f.bounds, [12000, 12000]);
});

test("pending rejection skips DROP and preserves the exact failure", async () => {
  const failed = Error("pending_rejected"), response = deferred();
  const f = fixture(response.promise);
  const cleaning = cleanupShortAccountCase(f.options);
  const checked = assert.rejects(cleaning, (error) => {
    assert.equal(error.errors[0], failed);
    assert.equal(error.errors[1].message, "short_body_drain_unconfirmed");
    return aggregateHas(error, [failed, error.errors[1]]);
  });
  response.reject(failed);
  await checked;
  assert.equal(f.body.bodyDrained, false);
  assert.deepEqual(f.calls, ["release"]);
  assert.deepEqual(f.bounds, [12000]);
});

test("body read rejection cannot pass through bodyUsed", async () => {
  const content = deferred(), response = fakeResponse(content.promise);
  const failed = Error("read_rejected"), f = fixture(Promise.resolve(response));
  const cleaning = cleanupShortAccountCase(f.options);
  const checked = assert.rejects(cleaning, (error) => {
    assert.equal(error.errors[0], failed);
    assert.equal(error.errors[1].message, "short_body_drain_unconfirmed");
    return aggregateHas(error, [failed, error.errors[1]]);
  });
  await response.started;
  content.reject(failed);
  await checked;
  assert.equal(response.bodyUsed, true);
  assert.equal(response.reads, 1);
  assert.equal(f.body.bodyDrained, false);
  assert.deepEqual(f.calls, ["release"]);
});

test("read timeout skips DROP even if the same read later reaches EOF", async () => {
  const content = deferred(), response = fakeResponse(content.promise);
  const timeout = Error("short_fixture_deadline");
  const f = fixture(Promise.resolve(response));
  let waits = 0;
  f.options.wait = (promise, ms) => {
    f.bounds.push(ms);
    // Deterministic fake deadline: do not enlarge or wait out production limits.
    return ++waits === 2 ? Promise.race([promise, Promise.reject(timeout)]) : promise;
  };
  await assert.rejects(cleanupShortAccountCase(f.options), (error) => {
    assert.equal(error.errors[0], timeout);
    assert.equal(error.errors[1].message, "short_body_drain_unconfirmed");
    return aggregateHas(error, [timeout, error.errors[1]]);
  });
  assert.equal(response.bodyUsed, true);
  assert.equal(f.body.bodyDrained, false);
  assert.deepEqual(f.calls, ["release"]);
  assert.deepEqual(f.bounds, [12000, 12000]);
  content.resolve("late complete");
  await f.body.read();
  assert.equal(f.body.bodyDrained, true);
  assert.deepEqual(f.calls, ["release"], "Late completion must not schedule a deferred DROP");
});

test("primary, holder and body failures survive together in first-failure order", async () => {
  const primary = Error("original_assertion"), holder = Error("holder_cleanup");
  const content = deferred(), response = fakeResponse(content.promise);
  const read = Error("body_cleanup"), f = fixture(Promise.resolve(response), {
    primaryError: primary,
    release: async () => { throw holder; },
  });
  const cleaning = cleanupShortAccountCase(f.options);
  const checked = assert.rejects(cleaning, (error) => {
    assert.equal(error.errors[3].message, "short_body_drain_unconfirmed");
    return aggregateHas(error, [primary, holder, read, error.errors[3]]);
  });
  await response.started;
  content.reject(read);
  await checked;
  assert.deepEqual(f.calls, []);
});

test("DROP failure remains alongside the primary failure after successful drain", async () => {
  const primary = Error("original_assertion"), drop = Error("drop_failed");
  const f = fixture(Promise.resolve(fakeResponse(Promise.resolve("done"))), {
    primaryError: primary, drop: async () => { throw drop; },
  });
  await assert.rejects(cleanupShortAccountCase(f.options),
    (error) => aggregateHas(error, [primary, drop]));
  assert.equal(f.body.bodyDrained, true);
});

test("successful cleanup cannot erase an earlier HTTP assertion failure", async () => {
  const primary = Error("wrong_status"), response = fakeResponse(Promise.resolve("body"));
  const f = fixture(Promise.resolve(response), { primaryError: primary });
  // Model http() having drained successfully before its exact status assertion fails.
  await f.body.read();
  await assert.rejects(cleanupShortAccountCase(f.options), (error) => error === primary);
  assert.equal(response.reads, 1);
  assert.deepEqual(f.calls, ["release", "record:body", "drop"]);
});

test("without a started request, owned trigger DROP is safe", async () => {
  const calls = [];
  await cleanupShortAccountCase({
    wait: () => { throw Error("must not wait"); },
    drop: async () => { calls.push("drop"); },
  });
  assert.deepEqual(calls, ["drop"]);
});

test("private receipt failure stays blocking but does not undo confirmed drain", async () => {
  const failure = Error("receipt_failed"), f = fixture(
    Promise.resolve(fakeResponse(Promise.resolve("body"))),
    { record: async () => { throw failure; } },
  );
  await assert.rejects(cleanupShortAccountCase(f.options),
    (error) => aggregateHas(error, [failure]));
  assert.equal(f.body.bodyDrained, true);
  assert.deepEqual(f.calls, ["release", "drop"]);
});

test("private receipt keeps nested primary and cleanup failures in order", () => {
  const primary = Error("first assertion"), read = Error("read rejected");
  const nested = new AggregateError([read, Error("short_body_drain_unconfirmed")], "cleanup");
  const combined = new AggregateError([primary, nested], "first_failure_and_cleanup");
  const stored = JSON.parse(JSON.stringify(privateFailureDetails(combined)));
  assert.equal(stored.message, "first_failure_and_cleanup");
  assert.equal(stored.errors[0].message, primary.message);
  assert.equal(stored.errors[0].stack, primary.stack);
  assert.deepEqual(stored.errors[1].errors.map((item) => item.message),
    ["read rejected", "short_body_drain_unconfirmed"]);
});

test("native fixture shares the exact read across assertion and cleanup", async () => {
  const source = await readFile(new URL("./short-platform-account-authority-native.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("responseBody=trackResponseBody(pending)"));
  assert.ok(source.includes("await http(label,pending,401,'SESSION_EXPIRED',responseBody)"));
  assert.ok(source.includes("cleanupShortAccountCase({pending,body:responseBody,wait:bounded,primaryError:failure"));
  assert.ok(source.includes("JSON.stringify(privateFailureDetails(error))"));
  assert.ok(source.includes("['short-platform-account-snapshot','short-platform-account-response']"));
  assert.ok(source.includes("async function bounded(work,ms=10000)"));
  assert.doesNotMatch(source, /\.bodyUsed\b/);
});
