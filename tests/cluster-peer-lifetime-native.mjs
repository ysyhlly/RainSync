// Original proxy lifetime through an owned Axum listener and remote wire witness.
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
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `cluster-peer-lifetime-native-${randomUUID()}`);
await mkdir(root, { recursive: true, mode: 0o700 });
const test = 'control_cluster::peer_contract::owned_peer_lifetime';
const cases = ['all'];
const validationCases = ['exact_headers_first_and_bidirectional_frames','legal_claim_changed_node_token_closes_both_live','upstream_refused_error_and_close'];
const report = { result: 'running', scope: 'actual original proxy_socket via test-only Axum upgrade and real PG; owned remote wire witness is not authority; production two-Server auth baseline separate', cases: [] };
let failure, binding;
const inputs = ['tests/cluster-peer-lifetime-native.mjs', 'tests/fixtures/postgres.mjs',
  'tests/fixtures/unused-port.mjs', 'scripts/native-owner-binding.mjs', 'deploy/owned-process.mjs'];
const snapshot = () => Promise.all(inputs.map(async path => ({ path, sha256: sha256(await readFile(resolve(repo, path))) })));

try {
  assert.equal(process.env.DATABASE_URL, undefined, 'Owned cluster route rejects caller DATABASE_URL');
  assert.equal(process.platform, 'linux', 'Owned log redirection requires the selected Linux fixture');
  assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, 'Owned cluster route requires native PostgreSQL');
  binding = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING, requireTest: true });
  report.binding = binding.summary;
  report.coordinator = await snapshot();
  report.test_name = test;
  report.command = ['/bin/sh', '-c', 'umask 077; set -C; exec "$@" > "$RAINSYNC_CLUSTER_PEER_RUST_LOG" 2>&1', 'owned-cluster-route', binding.owner.path, '--exact', test, '--ignored', '--nocapture', '--test-threads=1'];
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
        const fixture = isolatedPostgres({ root: directory, name: 'cluster-route-native', id: run });
        const entry = { name, result: 'running' }; report.cases.push(entry);
        let caseFailure;
        try {
          await fixture.start(); signal.throwIfAborted();
          fixture.sql(`CREATE TABLE rainsync_cluster_peer_fixture_owner(singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL); INSERT INTO rainsync_cluster_peer_fixture_owner VALUES(true,'${run}');`);
          await binding.verify();
          const observation = resolve(directory, 'observation.json');
          // exec preserves the supervised PID; binary and arguments are positional data.
          // Redirect directly to the owned file so timeout/error logs are never capped.
          const exit = await ownedProcess('/bin/sh',
            ['-c', 'umask 077; set -C; exec "$@" > "$RAINSYNC_CLUSTER_PEER_RUST_LOG" 2>&1',
              'owned-cluster-route', binding.owner.path,
              '--exact', test, '--ignored', '--nocapture', '--test-threads=1'], {
              timeoutMs: 120000, signal,
              env: { ...process.env, RAINSYNC_ISOLATED_TEST: '1', RAINSYNC_CLUSTER_PEER_RUN_ID: run,
                RAINSYNC_CLUSTER_PEER_DATABASE_URL: fixture.url, RAINSYNC_CLUSTER_PEER_EXPECTED_DATABASE_URL: fixture.url,
                RAINSYNC_COMPUTE_OUTPUT_ROOT: resolve(directory, 'outputs'),
                RAINSYNC_CLUSTER_PEER_OBSERVATION: observation,
                RAINSYNC_CLUSTER_PEER_CLEANUP: resolve(directory,'rust-cleanup.json'),
                RAINSYNC_CLUSTER_PEER_RUST_LOG: resolve(directory, 'rust.log') },
            });
          const { output: shellOutput, ...receipt } = exit; entry.exit = receipt;
          assert.equal(shellOutput, '', 'Rust output must use the owned log');
          const output = await readFile(resolve(directory, 'rust.log'), 'utf8');
          assert.equal(exit.exit_code, 0, `Inspect ${directory}/rust.log`); assert.equal(exit.signal, null);
          assert.equal(exit.observed_close, true);
          assert.match(output, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
          for (const caseName of validationCases) assert.equal(output.split(/\r?\n/).filter(line => line === `PASS: owned cluster peer ${caseName}`).length, 1);
          entry.checks = validationCases.map(name => ({ name, result: 'passed' }));
          assert.equal(verifyPidAbsent(exit.pid), true);
          signal.throwIfAborted();
          const bytes = await readFile(observation), rows = JSON.parse(bytes);
          assert.deepEqual(rows.cases.map(item => item.case), validationCases);
          entry.observation_sha256 = sha256(bytes);
          const cleanup=JSON.parse(await readFile(resolve(directory,'rust-cleanup.json'),'utf8'));
          assert.equal(cleanup.ports_closed,true);assert.equal(cleanup.remote_task_closed,true);assert.equal(cleanup.local_task_closed,true);assert.equal(cleanup.relay_completion_observed,true);assert.equal(cleanup.relay_started,2);assert.equal(cleanup.relay_completed,2);entry.rust_cleanup=cleanup;
          const comparison = Buffer.from(JSON.stringify(rows) + '\n');
          await writeFile(resolve(directory, 'comparison.json'), comparison, { flag: 'wx', mode: 0o600 });
          entry.comparison_sha256 = sha256(comparison);
          await binding.verify();
        } catch (error) {
          caseFailure = error;
          if (error.cleanup) entry.exit = error.cleanup;
          entry.failure = { code: 'owned_file_validation_case_failed' };
          await writeFile(resolve(directory, 'failure.log'), String(error) + '\n', { mode: 0o600 });
        } finally {
          try{const bytes=await readFile(resolve(directory,'rust-cleanup.json'));entry.rust_cleanup=JSON.parse(bytes);entry.rust_cleanup_sha256=sha256(bytes);}catch(error){caseFailure??=error;entry.rust_cleanup_unconfirmed=true;}
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
  report.uncovered = ['production two-Server authentication is verified separately', 'Runtime::start/background heartbeat lifecycle', 'physical backpressure deadline', 'exact relayed Ping/Pong frames', 'oversized or malformed upstream handshake'];
} catch (error) {
  failure = error;
  report.failure = { code: 'owned_file_validation_gate_failed' };
  await writeFile(resolve(root, 'failure.log'), String(error) + '\n', { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if(binding){try{await binding.verify();report.final_binding_verified=true;}catch(error){failure??=error;process.exitCode=1;report.final_binding_verified=false;report.failure??={code:"final_binding_unconfirmed"};}}
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
