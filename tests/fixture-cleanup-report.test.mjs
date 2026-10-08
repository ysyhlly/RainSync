import assert from "node:assert/strict";
import { test } from "node:test";
import { finishOwnedFixture } from "./fixtures/server.mjs";

test("owned cleanup evidence requires cleanup and positive verification", async () => {
  const calls = [], receipt = { completed: true, server_port_closed: true };
  let saved;
  await finishOwnedFixture({
    cleanup: async () => { calls.push("cleanup"); },
    verifyStopped: async () => { calls.push("verify"); return receipt; },
    save: async (report) => { calls.push("save"); saved = report; },
  });
  assert.deepEqual(calls, ["cleanup", "verify", "save"]);
  assert.deepEqual(saved, {
    result: "passed", test_outcome: "passed", cleanup_outcome: "verified",
    failures: [], cleanup: receipt,
  });
});

test("successful cleanup preserves a primary failure and never logs its contents", async () => {
  const primaryError = Error("SECRET database request");
  let saved;
  await assert.rejects(finishOwnedFixture({
    primaryError, cleanup: async () => {},
    verifyStopped: async () => ({ completed: true }),
    save: async (report) => { saved = report; },
  }), (error) => error === primaryError);
  assert.equal(saved.result, "failed");
  assert.equal(saved.test_outcome, "failed");
  assert.equal(saved.cleanup_outcome, "verified");
  assert.deepEqual(saved.failures, ["fixture_failed"]);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET|database request/);
});

test("primary, cleanup and verification failures remain observable together", async () => {
  const primaryError = Error("SECRET primary");
  const cleanupError = Error("SECRET cleanup"), verifyError = Error("SECRET verification");
  let saved;
  await assert.rejects(finishOwnedFixture({
    primaryError, cleanup: async () => { throw cleanupError; },
    verifyStopped: async () => { throw verifyError; },
    save: async (report) => { saved = report; },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primaryError, cleanupError, verifyError]);
    return true;
  });
  assert.equal(saved.result, "failed");
  assert.equal(saved.cleanup_outcome, "failed");
  assert.deepEqual(saved.cleanup, { completed: false });
  assert.deepEqual(saved.failures, ["fixture_failed", "cleanup_failed", "cleanup_verification_failed"]);
  assert.doesNotMatch(JSON.stringify(saved), /SECRET/);
});

test("a report write failure cannot hide a test failure or produce success", async () => {
  const primaryError = Error("primary"), saveError = Error("write failed");
  await assert.rejects(finishOwnedFixture({
    primaryError, cleanup: async () => {},
    verifyStopped: async () => ({ completed: true }),
    save: async () => { throw saveError; },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primaryError, saveError]);
    return true;
  });
});

test("even a falsy thrown value remains a primary fixture failure", async () => {
  let caught = false, saved;
  try {
    await finishOwnedFixture({
      primaryError: undefined, primaryFailed: true,
      cleanup: async () => {}, verifyStopped: async () => ({ completed: true }),
      save: async (report) => { saved = report; },
    });
  } catch (error) {
    caught = true;
    assert.equal(error, undefined);
  }
  assert.equal(caught, true);
  assert.equal(saved.result, "failed");
  assert.equal(saved.test_outcome, "failed");
});
