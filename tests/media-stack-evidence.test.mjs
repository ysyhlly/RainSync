import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { finishStackObservation, observeStackChild, runObservedStack } from "./fixtures/media-stack.mjs";

const observer = () => ({
  fixture_id: "owned-fixture", fixture_root: "/owned/synthetic",
  callback_started: true, reap_completed: true, reap_failed: false,
  worker_port: 45001, children: [],
});
function child(pid) { const value = new EventEmitter(); value.pid = pid; return value; }
async function observe(value, { primaryError, primaryFailed = false, pidAbsent = () => true, portClosed = async () => true, save } = {}) {
  let receipt;
  try {
    await finishStackObservation({ observer: value, primaryError, primaryFailed, pidAbsent, portClosed,
      save: async (report) => { receipt = structuredClone(report); await save?.(report); } });
    return { receipt, error: null };
  } catch (error) { return { receipt, error }; }
}

test("direct children are observed from creation, including already-exited children", async () => {
  const value = observer(), order = [];
  const worker = child(101), agent = child(102), ffmpeg = child(103);
  observeStackChild(value, worker, "worker", 1);
  observeStackChild(value, agent, "agent", 2);
  observeStackChild(value, ffmpeg, "ffmpeg", 3);
  assert.deepEqual(value.children.map((entry) => entry.pid), [101, 102, 103]);
  assert.ok(value.children.every((entry) => !entry.close_observed));
  ffmpeg.emit("close", 0, null);
  worker.emit("close", 0, null);
  agent.emit("close", null, "SIGTERM");
  const { receipt, error } = await observe(value, {
    pidAbsent: (pid) => { order.push(`pid:${pid}`); return true; },
    portClosed: async (port) => { order.push(`port:${port}`); return true; },
  });
  assert.equal(error, null);
  assert.equal(receipt.result, "passed");
  assert.equal(receipt.cleanup_outcome, "verified");
  assert.deepEqual(order, ["pid:101", "pid:102", "pid:103", "port:45001"]);
  assert.deepEqual(receipt.children.map(({ role, exit_code, signal, pid_absent }) => ({ role, exit_code, signal, pid_absent })), [
    { role: "worker", exit_code: 0, signal: null, pid_absent: true },
    { role: "agent", exit_code: null, signal: "SIGTERM", pid_absent: true },
    { role: "ffmpeg", exit_code: 0, signal: null, pid_absent: true },
  ]);
  assert.equal(receipt.worker_listener.closed, true);
  assert.match(receipt.scope, /no Worker-internal/);
  for (const entry of receipt.children) for (const key of ["argv", "env", "binary", "error", "stack"]) assert.equal(entry[key], undefined);
});

test("startup failure cannot be converted to an empty successful observation", async () => {
  const value = { children: [], callback_started: false, reap_completed: false, reap_failed: false };
  const primary = Error("synthetic-secret-startup-detail");
  const { receipt, error } = await observe(value, { primaryError: primary, primaryFailed: true });
  assert.equal(receipt.result, "failed");
  assert.equal(receipt.test_outcome, "failed");
  assert.equal(receipt.cleanup_outcome, "failed");
  assert.ok(error.errors.includes(primary));
  assert.ok(receipt.observation_failures.includes("stack_start_not_observed"));
  assert.ok(!JSON.stringify(receipt).includes(primary.message));
});

test("partial launch retains actual close facts and the primary failure", async () => {
  const value = observer(), first = child(201), second = child(undefined);
  observeStackChild(value, first, "worker", 1);
  observeStackChild(value, second, "agent", 2);
  first.emit("close", 0, null);
  second.emit("error", Error("synthetic-secret-spawn-detail"));
  second.emit("close", -2, null);
  const primary = Error("partial_launch_failed");
  const { receipt, error } = await observe(value, { primaryError: primary, primaryFailed: true });
  assert.equal(receipt.result, "failed");
  assert.equal(receipt.cleanup_outcome, "failed");
  assert.ok(error.errors.includes(primary));
  assert.equal(receipt.children[0].pid_absent, true);
  assert.equal(receipt.children[1].pid, null);
  assert.equal(receipt.children[1].spawn_error, true);
  assert.equal(receipt.children[1].exit_code, -2);
  assert.equal(receipt.children[1].pid_absent, null);
  assert.ok(!JSON.stringify(receipt).includes("synthetic-secret"));
});

test("successful child cleanup never hides a primary fixture failure", async () => {
  const value = observer(), worker = child(301);
  observeStackChild(value, worker, "worker", 1); worker.emit("close", 0, null);
  const primary = Error("synthetic-secret-assertion-detail");
  const { receipt, error } = await observe(value, { primaryError: primary, primaryFailed: true });
  assert.equal(error, primary);
  assert.equal(receipt.result, "failed");
  assert.equal(receipt.test_outcome, "failed");
  assert.equal(receipt.cleanup_outcome, "verified");
  assert.ok(!JSON.stringify(receipt).includes(primary.message));
});

test("observer failures remain failed and do not skip the remaining checks", async () => {
  const value = observer(), worker = child(401), order = [];
  observeStackChild(value, worker, "worker", 1); worker.emit("close", 0, null);
  const { receipt, error } = await observe(value, {
    pidAbsent: () => { order.push("pid"); throw Error("synthetic-secret-observer-detail"); },
    portClosed: async () => { order.push("port"); return false; },
  });
  assert.ok(error);
  assert.equal(receipt.result, "failed");
  assert.equal(receipt.test_outcome, "passed");
  assert.equal(receipt.cleanup_outcome, "failed");
  assert.deepEqual(order, ["pid", "port"]);
  assert.ok(receipt.observation_failures.includes("stack_child_pid_check_failed"));
  assert.ok(receipt.observation_failures.includes("stack_worker_port_closure_unconfirmed"));
  assert.ok(!JSON.stringify(receipt).includes("synthetic-secret"));
});

test("an original reap failure is never reported as successful cleanup", async () => {
  const value = observer(), worker = child(501);
  value.reap_completed = false; value.reap_failed = true;
  observeStackChild(value, worker, "worker", 1); worker.emit("close", 0, null);
  const primary = Error("original_reap_failure");
  value.reap_error = primary;
  const { receipt, error } = await observe(value, { primaryError: primary, primaryFailed: true });
  assert.equal(receipt.result, "failed");
  assert.equal(receipt.cleanup_outcome, "failed");
  assert.ok(receipt.observation_failures.includes("stack_reap_not_confirmed"));
  assert.ok(error.errors.includes(primary));
});

test("receipt-save failure preserves the original failure", async () => {
  const value = observer(), worker = child(601);
  observeStackChild(value, worker, "worker", 1); worker.emit("close", 0, null);
  const primary = Error("primary_fixture_failure"), denied = Error("receipt_write_failed");
  const { error } = await observe(value, { primaryError: primary, primaryFailed: true, save: async () => { throw denied; } });
  assert.ok(error.errors.includes(primary));
  assert.ok(error.errors.includes(denied));
});

test("wired run, reap, stream and outer failures retain the original run failure, including falsy values", { timeout: 1000 }, async () => {
  for (const primary of [Error("synthetic-secret-run-failure"), undefined, null, false, 0, ""]) {
    const value = observer(), order = [];
    value.reap_completed = false;
    const worker = child(701); observeStackChild(value, worker, "worker", 1); worker.emit("close", 0, null);
    const reapFailure = Error("synthetic-secret-reap-failure"), streamFailure = Error("synthetic-secret-stream-failure");
    let outerError, outerFailed = false;
    try {
      await runObservedStack({ observer: value,
        run: async () => { order.push("run"); throw primary; },
        reap: async () => { order.push("reap"); throw reapFailure; },
        closeStreams: async () => { order.push("streams"); throw streamFailure; },
      });
    } catch (error) { outerError = error; outerFailed = true; }
    assert.deepEqual(order, ["run", "reap", "streams"]);
    assert.equal(outerError, streamFailure);
    const serverFailure = Error("synthetic-secret-outer-failure");
    const outerCombined = new AggregateError([outerError, serverFailure], "owned_outer_cleanup_failed");
    const { receipt, error } = await observe(value, { primaryError: outerCombined, primaryFailed: outerFailed });
    assert.equal(receipt.result, "failed"); assert.equal(receipt.cleanup_outcome, "failed");
    const preserved = error.errors[0];
    assert.ok(preserved instanceof AggregateError);
    assert.deepEqual(preserved.errors, [primary, reapFailure, streamFailure, outerCombined]);
    assert.ok(!JSON.stringify(receipt).includes("synthetic-secret"));
  }
});
