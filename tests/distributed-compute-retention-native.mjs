// Direct full production sweep; no server listener, synthetic SQL extraction or encoder.
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
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `compute-retention-native-${randomUUID()}`);
await mkdir(root, { recursive: true });
const test = 'distributed_compute::retention_contract::owned_retention_sweep';
const cases = ['success', 'missing', 'not_directory', 'sql_after_files', 'sql_after_files_retry', 'sql_after_attempts'];
const report = { result: 'running', scope: 'direct cleanup, full SQLx schema, synthetic owned uploaded files; no proof of child reaping', cases: [] };
let failure;
const inputs = ['tests/distributed-compute-retention-native.mjs', 'tests/fixtures/postgres.mjs',
  'tests/fixtures/unused-port.mjs', 'scripts/native-owner-binding.mjs', 'deploy/owned-process.mjs'];
const snapshot = () => Promise.all(inputs.map(async path => ({ path, sha256: sha256(await readFile(resolve(repo, path))) })));
function normalize(value, key = '') {
  if (Array.isArray(value)) { const rows = value.map(item => normalize(item)); return rows.every(item => item && typeof item === 'object' && !Array.isArray(item)) ? rows.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : rows; }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, normalize(value[name], name)]));
  // Only automatically generated created_at/updated_at are normalized. All deadlines,
  // lease values and receipt timestamps remain exact; requested_at is not normalized.
  if (typeof value === 'string' && ['created_at', 'updated_at'].includes(key) && /^20\d\d-\d\d-\d\dT/.test(value) && !/^(2000|2099|2100)-/.test(value)) return '<runtime timestamp>';
  return value;
}
try {
  assert.ok(!process.env.DATABASE_URL, 'Owned retention rejects caller DATABASE_URL');
  assert.equal(process.platform, 'linux', 'Owned log redirection requires the selected Linux fixture');
  assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, 'Owned retention requires native PostgreSQL');
  const binding = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING, requireTest: true });
  report.binding = binding.summary;
  report.coordinator = await snapshot();
  await withTerminationSignal(async termination => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(Error('owner_gate_timeout')), 180000);
    const signal = AbortSignal.any([termination, deadline.signal]);
    try {
      for (const name of cases) {
        signal.throwIfAborted();
        const directory = resolve(root, name), run = randomUUID();
        await mkdir(directory);
        const fixture = isolatedPostgres({ root: directory, name: 'retention-native', id: run });
        const entry = { name, result: 'running' }; report.cases.push(entry);
        let caseFailure;
        try {
          await fixture.start(); signal.throwIfAborted();
          fixture.sql(`CREATE TABLE rainsync_retention_fixture_owner(singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL); INSERT INTO rainsync_retention_fixture_owner VALUES(true,'${run}');`);
          await binding.verify();
          const observation = resolve(directory, 'observation.json');
          // exec preserves the supervised PID; binary and arguments are positional data.
          // Redirect directly to the owned file so timeout/error logs are never capped.
          const exit = await ownedProcess('/bin/sh',
            ['-c', 'set -C; exec "$@" > "$RAINSYNC_RETENTION_RUST_LOG" 2>&1',
              'owned-retention', binding.owner.path,
              '--exact', test, '--ignored', '--nocapture', '--test-threads=1'], {
              timeoutMs: 120000, signal,
              env: { ...process.env, RAINSYNC_ISOLATED_TEST: '1', RAINSYNC_RETENTION_RUN_ID: run,
                RAINSYNC_RETENTION_DATABASE_URL: fixture.url, RAINSYNC_RETENTION_EXPECTED_DATABASE_URL: fixture.url,
                RAINSYNC_COMPUTE_OUTPUT_ROOT: resolve(directory, 'outputs'), RAINSYNC_RETENTION_CASE: name,
                RAINSYNC_RETENTION_OBSERVATION: observation,
                RAINSYNC_RETENTION_RUST_LOG: resolve(directory, 'rust.log') },
            });
          const { output: shellOutput, ...receipt } = exit; entry.exit = receipt;
          assert.equal(shellOutput, '', 'Rust output must use the owned log');
          const output = await readFile(resolve(directory, 'rust.log'), 'utf8');
          assert.equal(exit.exit_code, 0, `Inspect ${directory}/rust.log`); assert.equal(exit.signal, null);
          assert.match(output, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
          assert.ok(output.split(/\r?\n/).includes(`PASS: owned retention ${name}`));
          assert.equal(verifyPidAbsent(exit.pid), true);
          signal.throwIfAborted();
          const bytes = await readFile(observation), rows = JSON.parse(bytes);
          entry.observation_sha256 = sha256(bytes);
          const normalized = Buffer.from(JSON.stringify(normalize(rows)) + '\n');
          await writeFile(resolve(directory, 'comparison.json'), normalized, { flag: 'wx' });
          entry.comparison_sha256 = sha256(normalized);
          await binding.verify();
        } catch (error) {
          caseFailure = error;
          if (error.cleanup) entry.exit = error.cleanup;
          entry.failure = { code: 'owned_retention_case_failed' };
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
  report.uncovered = ['expired immutable playback binding natural deadline (minimal SQL/FK fixture covers separately)', 'real NAS/Server child join', 'generation remove_dir_all permission failure'];
} catch (error) {
  failure = error;
  report.failure = { code: 'owned_retention_gate_failed' };
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
