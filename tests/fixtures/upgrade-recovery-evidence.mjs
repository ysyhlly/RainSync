// Test-only finalization. Original failures stay in memory; durable evidence
// contains only fixed categories and allowlisted lifecycle observations.
// Only isolated test-owned roots are supported; this is not hardened against
// adversarial concurrent filesystem replacement.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const roots = Object.freeze({
  "recovery-integrity": "rainsync-recovery-integrity-",
  "current-baseline-upgrade": "rainsync-current-upgrade-",
});
const reportFields = [
  "baseline_commit", "candidate_commit", "migrations", "application_acceptance", "scope",
];
const cleanupFields = [
  "kind", "stopped", "process_close_observed", "pid_absent", "pg_ctl_status",
  "port_closed", "exit_code", "signal", "removed",
];

export async function finishRecoveryFixture({
  name, root, fixture, report = {}, primaryFailed = false, primaryError,
}) {
  const errors = [], failures = [];
  const record = (category, error) => { failures.push(category); errors.push(error); };
  if (primaryFailed) failures.push("fixture_failed");
  let cleanup = { completed: false }, ownershipConfirmed = false, canonicalRoot;
  try { await fixture.stop(); }
  catch (error) { record("cleanup_failed", error); }
  try {
    const receipt = await fixture.verifyStopped();
    assert.equal(receipt?.stopped, true, "owned fixture stop verification required");
    cleanup = { completed: true };
    for (const key of cleanupFields)
      if (receipt[key] !== undefined) cleanup[key] = receipt[key];
  } catch (error) { record("cleanup_verification_failed", error); }

  try {
    assert.ok(Object.hasOwn(roots, name), "known owned fixture required");
    assert.ok(isAbsolute(root), "owned fixture root must be absolute");
    const leaf = await lstat(root);
    canonicalRoot = await realpath(root);
    assert.ok(leaf.isDirectory() && !leaf.isSymbolicLink(),
      "owned fixture leaf must be a directory, not a symlink");
    assert.ok(basename(root).startsWith(roots[name]), "unexpected owned fixture root");
    ownershipConfirmed = true;
  } catch (error) { record("fixture_ownership_failed", error); }

  let reportPath, temporaryPath, initialSaved = false;
  const base = Object.fromEntries(reportFields.filter(key => report[key] !== undefined)
    .map(key => [key, report[key]]));
  const disposal = { outcome: "not_attempted" };
  const document = (state, result) => ({
    ...base, schema_version: 1, fixture: name, state, result,
    test_outcome: primaryFailed ? "failed" : "passed",
    cleanup_outcome: failures.some(category =>
      ["cleanup_failed", "cleanup_verification_failed", "fixture_ownership_failed"].includes(category))
      ? "failed" : "verified",
    failures: [...failures], cleanup, disposal: { ...disposal },
  });
  try {
    const directory = process.env.RAINSYNC_ARTIFACT_DIR ?? dirname(root);
    assert.ok(isAbsolute(directory), "recovery evidence directory must be absolute");
    await mkdir(directory, { recursive: true });
    const canonicalDirectory = await realpath(directory);
    const inside = relative(canonicalRoot ?? resolve(root), canonicalDirectory);
    assert.ok(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside),
      "recovery evidence must be outside the disposable fixture root");
    reportPath = resolve(canonicalDirectory, `${name}-${randomUUID()}.json`);
    temporaryPath = `${reportPath}.${randomUUID()}.tmp`;
    // A partial write or later failure can never leave a provisional pass.
    await writeFile(reportPath, JSON.stringify(document("incomplete", "failed"), null, 2) + "\n",
      { mode: 0o600, flag: "wx" });
    initialSaved = true;
  } catch (error) { record("evidence_write_failed", error); }

  if (initialSaved && cleanup.completed && ownershipConfirmed) {
    try {
      await rm(root, { recursive: true, force: true });
      Object.assign(disposal, { outcome: "removed", removed: true, retained: false });
    } catch (error) {
      Object.assign(disposal, { outcome: "unknown", removed: null, retained: null });
      record("fixture_removal_failed", error);
    }
  }
  if (initialSaved) {
    try {
      const final = document("complete", primaryFailed || errors.length ? "failed" : "passed");
      await writeFile(temporaryPath, JSON.stringify(final, null, 2) + "\n",
        { mode: 0o600, flag: "wx" });
      // Atomic final replacement is the last fallible success operation.
      await rename(temporaryPath, reportPath);
    } catch (error) { record("evidence_write_failed", error); }
  }
  const originalFailures = [...(primaryFailed ? [primaryError] : []), ...errors];
  if (originalFailures.length === 1) throw originalFailures[0];
  if (originalFailures.length)
    throw new AggregateError(originalFailures, "owned_recovery_cleanup_or_evidence_failed");
}
