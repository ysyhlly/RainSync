// Production persistence operations against a fresh, owned PostgreSQL fixture.
// Reuses P02's complete source/binary binding and interrupt-safe process owner.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ownedProcess } from "../deploy/owned-process.mjs";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { verifyPidAbsent } from "./fixtures/postgres.mjs";

const cases = Object.freeze([
  "atomic_commit_and_replay",
  "normalized_payload_and_replay_denials",
  "latest_snapshot_lock_wait",
  "end_media_latest_queue",
  "precommit_write_failure_rollback",
  "deferred_commit_failure_rollback",
  "exact_login_expiry_after_cleanup_wait",
  "delegated_permission_expiry_after_cleanup_wait",
  "fenced_commit_and_replay",
  "final_node_fence_after_checkpoint",
  "activated_cluster_rejects_unfenced",
]);

await nativeOwnerGate("room-command-transactions", async (f, { report, check, signal }) => {
  report.scope = "Named production room-command transactions on owned synthetic PostgreSQL; no playback, provider, browser, physical-resource disposal or transport-loss COMMIT evidence";
  const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
  for (const path of [
    "crates/persistence/src/lib.rs",
    "crates/persistence/src/room_commands.rs",
    "crates/persistence/examples/verify_room_commands.rs",
  ]) assert.ok(binding.source.some((entry) => entry.path === path),
    `Current binding must include ${path}`);
  const driver = binding.test_helpers.find((entry) => entry.name === "verify_room_commands");
  assert.ok(driver, "Bind verify_room_commands with the current backend before running this gate");
  assert.equal(driver.path, resolve(f.target, "examples",
    `verify_room_commands${process.platform === "win32" ? ".exe" : ""}`));
  report.driver_binary = { name: driver.name, sha256: driver.sha256 };
  let result;
  try {
    result = await ownedProcess(driver.path, [], {
      timeoutMs: 90000,
      signal,
      env: {
        ...f.env,
        RAINSYNC_ISOLATED_TEST: "1",
        RAINSYNC_FIXTURE_DATABASE: f.env.DATABASE_URL,
      },
    });
    const { output, ...receipt } = result;
    report.driver = { ...receipt, pid_absent: verifyPidAbsent(result.pid) };
    process.stdout.write(output);
    assert.equal(result.exit_code, 0, "Room-command transaction fixture failed");
    assert.equal(result.signal, null);
    assert.equal(report.driver.pid_absent, true);
    const passed = output.split(/\r?\n/).filter((line) => line.startsWith("PASS: "));
    assert.deepEqual(passed, cases.map((name) => `PASS: ${name}`),
      "Every expected production-operation case must execute exactly once");
    for (const name of cases) check(name);
  } catch (error) {
    if (error.cleanup)
      report.driver = { ...error.cleanup, pid_absent: verifyPidAbsent(error.cleanup.pid) };
    throw error;
  }
});
