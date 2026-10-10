// Direct original file validation; no server listener, SQL extraction or encoder.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedPostgres, verifyPidAbsent } from './fixtures/postgres.mjs';
import { ownedProcess, withTerminationSignal } from '../deploy/owned-process.mjs';
import { loadOwnerBinding, sha256 } from '../scripts/native-owner-binding.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR && isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR));
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `compute-file-validation-native-${randomUUID()}`);
await mkdir(root, { recursive: true });
const test = 'distributed_compute::file_validation_contract::owned_file_validation';
const cases = ['all'];
const validationCases = ['valid', 'bad_header', 'no_endlist', 'invalid_utf8', 'invalid_duration', 'nonfinite_duration', 'zero_duration', 'negative_duration', 'long_duration', 'missing_duration', 'unsafe_name', 'manifest_reference', 'duplicate_segment', 'uri_tag', 'key_tag', 'master_tag', 'empty_manifest', 'dangling_duration', 'missing_manifest', 'incomplete', 'unreferenced', 'missing_segment', 'size_changed', 'hash_changed', 'generation_isolation', 'directory_read_error', 'same_transaction_visibility'];
const report = { result: 'running', scope: 'original production playlist/file validation, full SQLx schema and owned generation files; no finish/publication or FFmpeg qualification', cases: [] };
let failure;
const inputs = ['tests/distributed-compute-file-validation-native.mjs', 'tests/fixtures/postgres.mjs',
  'tests/fixtures/unused-port.mjs', 'scripts/native-owner-binding.mjs', 'deploy/owned-process.mjs'];
const snapshot = () => Promise.all(inputs.map(async path => ({ path, sha256: sha256(await readFile(resolve(repo, path))) })));

try {
  assert.ok(!process.env.DATABASE_URL, 'Owned file validation rejects caller DATABASE_URL');
  assert.equal(process.platform, 'linux', 'Owned log redirection requires the selected Linux fixture');
  assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, 'Owned file validation requires native PostgreSQL');
  const binding = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING, requireTest: true });
  report.binding = binding.summary;
  report.coordinator = await snapshot();
  report.test_name = test;
  report.command = ['/bin/sh', '-c', 'set -C; exec "$@" > "$RAINSYNC_FILE_VALIDATION_RUST_LOG" 2>&1', 'owned-file-validation', binding.owner.path, '--exact', test, '--ignored', '--nocapture', '--test-threads=1'];
  report.owner_test_name = binding.owner.test_name;
  await withTerminationSignal(async termination => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(Error('owner_gate_timeout')), 180000);
    const signal = AbortSignal.any([termination, deadline.signal]);
    try {
      for (const name of cases) {
        signal.throwIfAborted();
        const directory = resolve(root, name), run = randomUUID();
        await mkdir(directory);
        const fixture = isolatedPostgres({ root: directory, name: 'file-validation-native', id: run });
        const entry = { name, result: 'running' }; report.cases.push(entry);
        let caseFailure;
        try {
          await fixture.start(); signal.throwIfAborted();
          fixture.sql(`CREATE TABLE rainsync_file_validation_fixture_owner(singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL); INSERT INTO rainsync_file_validation_fixture_owner VALUES(true,'${run}');`);
          await binding.verify();
          const observation = resolve(directory, 'observation.json');
          // exec preserves the supervised PID; binary and arguments are positional data.
          // Redirect directly to the owned file so timeout/error logs are never capped.
          const exit = await ownedProcess('/bin/sh',
            ['-c', 'set -C; exec "$@" > "$RAINSYNC_FILE_VALIDATION_RUST_LOG" 2>&1',
              'owned-file-validation', binding.owner.path,
              '--exact', test, '--ignored', '--nocapture', '--test-threads=1'], {
              timeoutMs: 120000, signal,
              env: { ...process.env, RAINSYNC_ISOLATED_TEST: '1', RAINSYNC_FILE_VALIDATION_RUN_ID: run,
                RAINSYNC_FILE_VALIDATION_DATABASE_URL: fixture.url, RAINSYNC_FILE_VALIDATION_EXPECTED_DATABASE_URL: fixture.url,
                RAINSYNC_COMPUTE_OUTPUT_ROOT: resolve(directory, 'outputs'), 
                RAINSYNC_FILE_VALIDATION_OBSERVATION: observation,
                RAINSYNC_FILE_VALIDATION_RUST_LOG: resolve(directory, 'rust.log') },
            });
          const { output: shellOutput, ...receipt } = exit; entry.exit = receipt;
          assert.equal(shellOutput, '', 'Rust output must use the owned log');
          const output = await readFile(resolve(directory, 'rust.log'), 'utf8');
          assert.equal(exit.exit_code, 0, `Inspect ${directory}/rust.log`); assert.equal(exit.signal, null);
          assert.equal(exit.observed_close, true);
          assert.match(output, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
          for (const caseName of validationCases) assert.equal(output.split(/\r?\n/).filter(line => line === `PASS: owned file validation ${caseName}`).length, 1);
          entry.checks = validationCases.map(name => ({ name, result: 'passed' }));
          assert.equal(verifyPidAbsent(exit.pid), true);
          signal.throwIfAborted();
          const bytes = await readFile(observation), rows = JSON.parse(bytes);
          assert.deepEqual(rows.cases.map(item => item.case), validationCases);
          assert.deepEqual(rows.final, rows.initial);
          for (const item of rows.cases) {
            assert.deepEqual(item.transaction_files_after, item.transaction_files_before);
            assert.deepEqual(item.transaction_jobs_after, item.transaction_jobs_before);
            assert.deepEqual(item.durable_after_rollback, rows.initial);
            assert.deepEqual(item.files_after, item.files_before);
          }
          entry.observation_sha256 = sha256(bytes);
          const comparison = Buffer.from(JSON.stringify(rows) + '\n');
          await writeFile(resolve(directory, 'comparison.json'), comparison, { flag: 'wx' });
          entry.comparison_sha256 = sha256(comparison);
          await binding.verify();
        } catch (error) {
          caseFailure = error;
          if (error.cleanup) entry.exit = error.cleanup;
          entry.failure = { code: 'owned_file_validation_case_failed' };
          await writeFile(resolve(directory, 'failure.log'), String(error) + '\n');
        } finally {
          if (entry.exit) {
            try {
              assert.equal(entry.exit.observed_close, true);
              assert.equal(verifyPidAbsent(entry.exit.pid), true);
              const bytes = await readFile(resolve(directory, 'rust.log'));
              entry.log_capture = { available: true, complete_to_observed_close: true,
                size_bytes: bytes.length, sha256: sha256(bytes) };
            } catch (error) {
              caseFailure ??= error;
              entry.log_capture = { available: false, code: 'owned_log_or_close_unconfirmed' };
            }
          }
          try { await fixture.stop(); entry.cleanup = await fixture.verifyStopped(); }
          catch (error) { caseFailure ??= error; entry.cleanup = { completed: false, code: 'owned_cleanup_unconfirmed' }; }
          entry.postgres = fixture.diagnostics();
          entry.result = caseFailure ? 'failed' : 'passed';
          await writeFile(resolve(root, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
        }
        if (caseFailure) throw caseFailure;
      }
      signal.throwIfAborted();
    } finally { clearTimeout(timer); }
  });
  await binding.verify();
  assert.deepEqual(await snapshot(), report.coordinator, 'Coordinator inputs changed during validation');
  report.inputs_unchanged = true;
  report.uncovered = ['finish authorization/final fence and FFmpeg qualification', 'real NAS/Server child join', 'OS permission-denied path (directory-read error exercised without changing permissions)'];
} catch (error) {
  failure = error;
  report.failure = { code: 'owned_file_validation_gate_failed' };
  await writeFile(resolve(root, 'failure.log'), String(error) + '\n');
  process.exitCode = 1;
} finally {
  if (report.coordinator) {
    try {
      report.coordinator_after = await snapshot();
      assert.deepEqual(report.coordinator_after, report.coordinator, 'Coordinator inputs changed during validation');
      report.inputs_unchanged = true;
    } catch (error) {
      failure ??= error; process.exitCode = 1;
      report.inputs_unchanged = false;
      report.failure ??= { code: 'coordinator_source_changed_or_unreadable' };
    }
  }
  report.result = failure ? 'failed' : 'passed';
  await writeFile(resolve(root, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, evidence: resolve(root, 'evidence.json') }));
}
