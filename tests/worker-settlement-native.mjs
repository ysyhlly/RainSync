// Worker test executable binding is separate from the Server-only owner binder.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendSnapshot, sha256 } from '../scripts/native-owner-binding.mjs';
import { isolatedPostgres, verifyPidAbsent } from './fixtures/postgres.mjs';
import { ownedProcess, withTerminationSignal } from '../deploy/owned-process.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const test = 'attempts::settlement_contract::owned_settlement_contract';
const inputs = ['tests/worker-settlement-native.mjs', 'scripts/native-owner-binding.mjs', 'tests/fixtures/postgres.mjs', 'tests/fixtures/unused-port.mjs', 'deploy/owned-process.mjs'];
const coordinator = () => Promise.all(inputs.map(async path => ({ path, sha256: sha256(await readFile(resolve(repo, path))) })));
const args = process.argv.slice(2);
assert.ok((args.length === 1 && args[0] === '--build-only') || (args.length === 2 && args[0] === '--run-only' && isAbsolute(args[1])), 'Use --build-only or --run-only /absolute/binding.json');
assert.ok(!process.env.DATABASE_URL, 'Reject caller DATABASE_URL');
assert.equal(process.platform, 'linux');
assert.ok(isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR ?? '') && isAbsolute(process.env.RAINSYNC_RUNTIME_ROOT ?? '') && isAbsolute(process.env.CARGO_TARGET_DIR ?? ''));
const run = randomUUID(), artifacts = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `worker-settlement-${run}`), runtime = resolve(process.env.RAINSYNC_RUNTIME_ROOT, `worker-settlement-${run}`);
await mkdir(artifacts, { recursive: true }); await mkdir(runtime, { recursive: true, mode: 0o700 });
const report = { schema_version: 1, stage: args[0], result: 'running', test, scope: 'direct original Worker settlement, synthetic NULL-principal/room sessions and one managed shell child; no decoder media/playback/publication acceptance' };
const save = () => writeFile(resolve(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let failure, fixture;
function normalize(value, key = '') {
  if (Array.isArray(value)) return value.map(item => normalize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, normalize(value[name], name)]));
  if (typeof value === 'string' && ['created_at', 'updated_at', 'reaped_at'].includes(key) && /^20\d\d-\d\d-\d\dT/.test(value)) return '<generated timestamp present>';
  return value;
}
async function supervised(program, commandArgs, log, env, signal, timeoutMs) {
  // Positional executable/arguments and exec preserve the owned PID; logs go directly to a private file without the helper's capture cap.
  return ownedProcess('/bin/sh', ['-c', 'umask 077; set -C; exec "$@" > "$RAINSYNC_SETTLEMENT_COMMAND_LOG" 2>&1', 'owned-settlement', program, ...commandArgs],
    { timeoutMs, signal, env: { ...env, RAINSYNC_SETTLEMENT_COMMAND_LOG: log } });
}
try {
  report.source = await backendSnapshot(repo); report.coordinator = await coordinator(); await save();
  await withTerminationSignal(async signal => {
    if (args[0] === '--build-only') {
      const commandArgs = ['test', '-p', 'rainsync-media-worker', '--bin', 'rainsync-media-worker', '--no-run', '--locked', '--message-format=json', '-j1'];
      const log = resolve(runtime, 'build.log'); report.build = { command: ['cargo', ...commandArgs], log };
      let exit;
      try { exit = await supervised('cargo', commandArgs, log, process.env, signal, 300000); }
      catch (error) { if (error.cleanup) report.build.exit = error.cleanup; throw error; }
      const { output, ...receipt } = exit; report.build.exit = receipt; assert.equal(output, '');
      assert.equal(exit.exit_code, 0); assert.equal(exit.signal, null); assert.equal(verifyPidAbsent(exit.pid), true);
      const bytes = await readFile(log); report.build.log_sha256 = sha256(bytes);
      const paths = new Set();
      for (const line of bytes.toString('utf8').split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        const value = JSON.parse(line);
        if (value.reason === 'compiler-artifact' && value.profile?.test === true && value.target?.name === 'rainsync-media-worker' && value.target.kind?.includes('bin') && value.executable) paths.add(resolve(value.executable));
      }
      assert.equal(paths.size, 1, 'Cargo must identify one Worker test artifact');
      const source = [...paths][0]; assert.equal(dirname(source), resolve(process.env.CARGO_TARGET_DIR, 'debug', 'deps'));
      const path = resolve(runtime, 'worker-test'); await copyFile(source, path);
      assert.deepEqual(await backendSnapshot(repo), report.source); assert.deepEqual(await coordinator(), report.coordinator);
      const binding = { schema_version: 1, result: 'passed', test, source: report.source, coordinator: report.coordinator, executable: { path, sha256: sha256(await readFile(path)) }, build: report.build };
      const bindingPath = resolve(runtime, 'binding.json'); await writeFile(bindingPath, JSON.stringify(binding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      report.binding = { path: bindingPath, sha256: sha256(await readFile(bindingPath)) }; console.log(`Worker settlement binding: ${bindingPath}`);
    } else {
      assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, 'Run requires owned native PostgreSQL');
      const bindingBytes = await readFile(args[1]), binding = JSON.parse(bindingBytes);
      assert.equal(binding.schema_version, 1); assert.equal(binding.result, 'passed'); assert.equal(binding.test, test); assert.equal(binding.build.exit.exit_code, 0);
      assert.deepEqual(binding.source, report.source); assert.deepEqual(binding.coordinator, report.coordinator);
      assert.ok(isAbsolute(binding.executable.path)); assert.equal(sha256(await readFile(binding.executable.path)), binding.executable.sha256);
      report.binding = { path: args[1], sha256: sha256(bindingBytes), executable: binding.executable };
      const databaseRoot = resolve(runtime, 'database'); await mkdir(databaseRoot);
      fixture = isolatedPostgres({ root: databaseRoot, name: 'worker-settlement', id: run }); await fixture.start(); signal.throwIfAborted();
      assert.equal(fixture.database, `rainsync_${run.replaceAll('-', '')}`);
      fixture.sql(`CREATE TABLE rainsync_settlement_fixture_owner(singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL); INSERT INTO rainsync_settlement_fixture_owner VALUES(true,'${run}');`);
      const observation = resolve(runtime, 'observation.json'), log = resolve(runtime, 'rust.log'); report.driver = { log };
      let exit;
      try { exit = await supervised(binding.executable.path, ['--exact', test, '--ignored', '--nocapture', '--test-threads=1'], log,
        { ...process.env, RAINSYNC_ISOLATED_TEST: '1', RAINSYNC_SETTLEMENT_RUN_ID: run, RAINSYNC_SETTLEMENT_DATABASE_URL: fixture.url, RAINSYNC_SETTLEMENT_EXPECTED_DATABASE_URL: fixture.url,
          RAINSYNC_SETTLEMENT_FILES: resolve(runtime, 'files'), RAINSYNC_SETTLEMENT_OBSERVATION: observation }, signal, 120000); }
      catch (error) { if (error.cleanup) report.driver.exit = error.cleanup; throw error; }
      const { output, ...receipt } = exit; report.driver.exit = receipt; assert.equal(output, '');
      assert.equal(exit.exit_code, 0); assert.equal(exit.signal, null); assert.equal(verifyPidAbsent(exit.pid), true);
      const bytes = await readFile(log), text = bytes.toString('utf8'); report.driver.log_sha256 = sha256(bytes);
      assert.match(text, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
      for (const name of ['ack_raise_recover', 'ack_zero_rows', 'release_failure_ignored', 'registry shutdown']) assert.ok(text.split(/\r?\n/).includes(`PASS: owned settlement ${name}`));
      const raw = await readFile(observation), value = JSON.parse(raw); report.observation_sha256 = sha256(raw);
      // Compare database/readiness behavior separately from added diagnostics and the OS-assigned child PID.
      const comparison = value.cases.map(({ case: name, before, blocked, after, writer_stopped, child }) => ({ case: name, before: normalize(before), blocked: normalize(blocked), after: normalize(after), writer_stopped,
        child: Object.fromEntries(Object.entries(child).filter(([key]) => key !== 'pid')) }));
      await writeFile(resolve(runtime, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      report.comparison_sha256 = sha256(await readFile(resolve(runtime, 'comparison.json')));
      assert.deepEqual(await readFile(args[1]), bindingBytes); assert.equal(sha256(await readFile(binding.executable.path)), binding.executable.sha256);
    }
    signal.throwIfAborted();
  });
} catch (error) {
  failure = error; report.failure = { code: 'worker_settlement_stage_failed' };
  await writeFile(resolve(runtime, 'failure.log'), String(error) + '\n', { mode: 0o600 });
} finally {
  if (fixture) {
    try { await fixture.stop(); report.cleanup = await fixture.verifyStopped(); }
    catch (error) { failure ??= error; report.cleanup = { completed: false }; }
    report.postgres = fixture.diagnostics();
  }
  for (const phase of ['build', 'driver']) if (report[phase]?.exit) {
    try { assert.equal(report[phase].exit.observed_close, true); assert.equal(verifyPidAbsent(report[phase].exit.pid), true);
      const bytes = await readFile(report[phase].log); report[phase].log_capture = { complete_to_observed_close: true, size_bytes: bytes.length, sha256: sha256(bytes) }; }
    catch (error) { failure ??= error; report[phase].log_capture = { complete_to_observed_close: false }; }
  }
  try { assert.deepEqual(await backendSnapshot(repo), report.source); assert.deepEqual(await coordinator(), report.coordinator); report.inputs_unchanged = true; }
  catch (error) { failure ??= error; report.inputs_unchanged = false; }
  report.result = failure ? 'failed' : 'passed'; await save();
  console.log(`Worker settlement evidence: ${resolve(artifacts, 'report.json')}`);
  if (failure) process.exitCode = 1;
}
