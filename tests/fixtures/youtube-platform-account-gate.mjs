// YouTube-only coordinator: unchanged shared binding/owned services plus mandatory
// post-flush audit and failure-sticky, independently receipted pre/post inputs.
// Importing this module never starts a process, socket or database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile, realpath, stat, rename} from 'node:fs/promises';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withTerminationSignal} from '../../deploy/owned-process.mjs';
import {loadOwnerBinding, sha256} from '../../scripts/native-owner-binding.mjs';
import {isolatedServer} from './server.mjs';
import {privateFailureDetails} from './short-platform-account-response.mjs';
import {assertChecks, assertOwnedCleanExit, outerQualification} from './youtube-platform-account-contract.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const commonInputs = [
  'scripts/native-owner-binding.mjs', 'tests/fixtures/youtube-platform-account-gate.mjs',
  'tests/fixtures/server.mjs', 'tests/fixtures/postgres.mjs',
  'tests/fixtures/unused-port.mjs', 'deploy/owned-process.mjs',
  'tests/fixtures/youtube-platform-account-contract.mjs',
  'tests/fixtures/youtube-platform-account-holder.mjs',
  'tests/fixtures/short-platform-account-snapshot.mjs',
  'tests/fixtures/short-platform-account-response.mjs',
];
export async function youtubeNativeOwnerGate(name, run) {
  assert.equal(name, 'youtube-platform-account-authority-native');
  assert.ok(isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR ?? ''));
  const directory = resolve(process.env.RAINSYNC_ARTIFACT_DIR, 'owner-gates', name, randomUUID());
  await mkdir(directory, {recursive: true, mode: 0o700});
  const reportPath = resolve(directory, 'report.json');
  const report = {schema_version: 1, gate: name, result: 'running', started_at: new Date().toISOString(), checks: [],
    cleanup: {completed: false}, native_qualification: outerQualification, failures: [], integrity: {binding: 'not_checked', coordinator: [], execution_inputs: []}};
  let saveSerial = 0;
  const save = async () => {
    // A failed final write cannot truncate the earlier report into apparent success.
    const pending = resolve(directory, `report-${++saveSerial}.pending.private.json`);
    await writeFile(pending, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    await rename(pending, reportPath);
  };
  let fixture, binding, inputsCaptured = false, stage = 'prerequisites';
  const failures = [], executionInputs = [];
  const fail = (code, error, at = stage) => {
    failures.push(error); report.failures.push({stage: at, code});
    report.failure ??= {stage: at, code};
  };
  async function privateFailures(label) {
    let bytes, serialization = 'complete';
    try {
      const error = new AggregateError([...failures], 'youtube_native_original_and_following_failures');
      bytes = Buffer.from(JSON.stringify(privateFailureDetails(error)) + '\n');
    } catch (error) {
      // Getters/toString on arbitrary rejected values must not escape finally,
      // suppress cleanup/final save, or replace the original stored reason.
      fail('private_failure_serialization_failed', error, 'evidence');
      serialization = 'fixed_fallback';
      bytes = Buffer.from('{"code":"private_failure_serialization_failed","details":"raw failure details unavailable"}\n');
    }
    const path = resolve(directory, label + '.private.json');
    try {
      await writeFile(path, bytes, {flag: 'wx', mode: 0o600});
      return {path, bytes: bytes.length, sha256: sha256(bytes), serialization};
    } catch (error) {fail('private_failure_write_failed', error, 'evidence'); return null;}
  }
  async function inputReceipt(input) {
    assert.ok(isAbsolute(input.path));
    const actual = await realpath(input.path), metadata = await stat(actual);
    assert.equal(metadata.isFile(), true, 'Execution input must be a regular file');
    if (input.executable) assert.notEqual(metadata.mode & 0o111, 0, 'Expected executable input');
    const bytes = await readFile(actual), digest = sha256(bytes);
    const receipt = {kind: input.kind, name: input.name, path: input.path, realpath: actual, sha256: digest, bytes: bytes.length,
      mode: metadata.mode & 0o777, execution: input.kind === 'owner_fixture' ? 'not_executed' : input.execution ?? 'input_only'};
    if (input.kind === 'owner_fixture') receipt.test_name = input.test_name;
    if (input.kind === 'node') {receipt.version = process.version; receipt.runtime_versions = {...process.versions};}
    if (input.kind === 'postgres_tool') {
      // Only a future authorized native invocation reaches this bounded local
      // metadata probe. Pure tests inject an in-memory execFileSync replacement.
      const version = execFileSync(actual, ['--version'], {encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}).trim();
      assert.ok(version.startsWith(`${input.name} (PostgreSQL) `), 'Unexpected PostgreSQL version response');
      receipt.version = version.slice(`${input.name} (PostgreSQL) `.length);
      assert.ok(receipt.version.length > 0);
    }
    return receipt;
  }
  async function captureInput(input) {
    const item = {input, before: null, verified: false}; executionInputs.push(item);
    item.before = await inputReceipt(input);
    report.execution_inputs.push(item.before);
    if (input.expected) assert.equal(item.before.sha256, input.expected, 'Bound execution input digest mismatch');
    item.verified = true;
  }
  try {
    await save();
    assert.equal(process.versions.node.split('.')[0], '24', 'Require Node 24 for exact JSON source tokens');
    assert.ok(!process.env.DATABASE_URL, 'Reject caller-supplied database');
    assert.ok(isAbsolute(process.env.RAINSYNC_NATIVE_POSTGRES_BIN ?? ''), 'Require absolute owned native PostgreSQL bin');
    assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT, '1');
    binding = await loadOwnerBinding({root, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING});
    report.backend_binding = binding.summary;
    report.coordinator = [];
    for (const path of [...commonInputs, `tests/${name}.mjs`]) report.coordinator.push({path, sha256: sha256(await readFile(resolve(root, path)))});
    const manifestBytes = await readFile(process.env.W03_BACKEND_BINDING);
    assert.equal(sha256(manifestBytes), binding.summary.sha256, 'Use the exact manifest already verified by shared binding');
    const manifest = JSON.parse(manifestBytes);
    assert.deepEqual(manifest.producers?.map(input => input.path), ['scripts/bind-native-backend.mjs', 'scripts/native-owner-binding.mjs']);
    report.execution_inputs = [];
    for (const input of manifest.producers) {
      assert.match(input.sha256, /^[a-f0-9]{64}$/);
      await captureInput({kind: 'producer', name: input.path, path: resolve(root, input.path), expected: input.sha256, executable: false});
    }
    for (const [kind, values] of [['binary', manifest.binaries], ['test_helper', manifest.test_helpers], ['owner_fixture', manifest.owner_fixtures ?? []]]) {
      assert.ok(Array.isArray(values));
      for (const input of values) {
        assert.equal(typeof input.name, 'string'); assert.match(input.sha256, /^[a-f0-9]{64}$/);
        if (kind === 'owner_fixture') {
          assert.equal(dirname(input.path), resolve(process.env.CARGO_TARGET_DIR, 'debug', 'deps'));
          assert.equal(input.build?.exit_code, 0); assert.equal(typeof input.test_name, 'string');
        }
        await captureInput({kind, name: input.name, path: input.path, expected: input.sha256, executable: true, test_name: input.test_name});
      }
    }
    report.owner_fixture_count = manifest.owner_fixtures?.length ?? 0;
    report.owner_fixture_presence = !Object.hasOwn(manifest, 'owner_fixtures') ? 'absent'
      : report.owner_fixture_count ? 'present_and_bound_not_executed' : 'present_empty';
    await captureInput({kind: 'node', name: 'node', path: process.execPath, executable: true, execution: 'current_process'});
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const name of ['initdb', 'postgres', 'psql', 'pg_ctl'])
      await captureInput({kind: 'postgres_tool', name, path: resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, name + suffix), executable: true, execution: 'owned_fixture_tool'});
    const pgInputs = report.execution_inputs.filter(input => input.kind === 'postgres_tool');
    assert.equal(new Set(pgInputs.map(input => dirname(input.realpath))).size, 1, 'PostgreSQL tools must share one canonical bin directory');
    assert.equal(new Set(pgInputs.map(input => input.version)).size, 1, 'PostgreSQL tool versions must be coherent');
    report.postgres_toolchain = {directory: dirname(pgInputs[0].realpath), version: pgInputs[0].version};
    inputsCaptured = true;
    stage = 'fixture';
    await withTerminationSignal(async termination => {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(Error('youtube_gate_timeout')), 180000);
      const signal = AbortSignal.any([termination, deadline.signal]);
      let afterStopped;
      try {
        await isolatedServer(name, async f => {
          fixture = f; report.fixture_id = f.id; report.postgres = f.postgresDiagnostics(); await save();
          afterStopped = await run(f, {report, binding, signal, check: name => report.checks.push({name, result: 'passed'})});
          signal.throwIfAborted();
        }, {signal, binary: binding.server, beforeStart: f => {fixture = f;}});
        // isolatedServer's finally has awaited stream.end callbacks here.
        stage = 'poststop';
        assert.equal(typeof afterStopped, 'function', 'Post-flush audit is mandatory');
        await afterStopped(); report.poststop_audit = 'passed'; signal.throwIfAborted();
      } finally {clearTimeout(timer);}
    });
    assertChecks(report.checks);
  } catch (error) {fail('youtube_native_gate_failed', error);}
  finally {
    // Qualification integrity is checked even after assertion, startup or audit
    // failure. Each input gets a separate attempt; one error cannot skip the rest.
    if (binding) {
      try {await binding.verify(); report.integrity.binding = 'passed';}
      catch (error) {report.integrity.binding = 'failed'; fail('backend_binding_recheck_failed', error, 'integrity');}
    }
    for (const input of report.coordinator ?? []) {
      const receipt = {path: input.path, expected_sha256: input.sha256, result: 'failed'};
      try {receipt.sha256 = sha256(await readFile(resolve(root, input.path))); assert.equal(receipt.sha256, input.sha256, 'Fixture source changed during execution'); receipt.result = 'passed';}
      catch (error) {fail('coordinator_recheck_failed', error, 'integrity');}
      report.integrity.coordinator.push(receipt);
    }
    for (const {input, before, verified} of executionInputs) {
      const receipt = {kind: input.kind, name: input.name, before, before_verified: verified, after: null, result: 'failed'};
      try {
        receipt.after = await inputReceipt(input);
        assert.ok(verified, 'No successful pre-run input receipt');
        assert.deepEqual(receipt.after, before, 'Execution input changed during validation');
        if (input.expected) assert.equal(receipt.after.sha256, input.expected, 'Bound execution input digest mismatch');
        receipt.result = 'passed';
      }
      catch (error) {fail('execution_input_recheck_failed', error, 'integrity');}
      report.integrity.execution_inputs.push(receipt);
    }
    report.inputs_complete = inputsCaptured;
    report.inputs_unchanged = inputsCaptured && report.integrity.binding === 'passed' && report.integrity.coordinator.length > 0
      && report.integrity.coordinator.every(item => item.result === 'passed') && executionInputs.length > 0
      && report.integrity.execution_inputs.every(item => item.result === 'passed');
    if (fixture) {
      let observed, resolved = false;
      try {observed = await fixture.verifyStopped(); resolved = true; report.cleanup = observed;}
      catch (error) {
        fail('owned_cleanup_unconfirmed', error, 'cleanup');
        if (report.cleanup?.completed) report.prior_cleanup_receipt = report.cleanup;
        report.cleanup = {completed: false, code: 'owned_cleanup_unconfirmed'};
      }
      if (resolved) {
        try {assertOwnedCleanExit(observed); report.cleanup_qualification = {result: 'passed', server_processes_checked: observed.servers.length};}
        catch (error) {
          fail('owned_process_exit_unqualified', error, 'cleanup');
          // Preserve the complete observed positive-stop receipt, including the
          // rejected code/signal, rather than replacing it with a summary.
          report.cleanup_qualification = {result: 'failed', code: 'owned_process_exit_unqualified'};
        }
      }
    } else report.cleanup = stage === 'prerequisites' ? {completed: true, resources_started: false} : {completed: false, code: 'fixture_startup_cleanup_unconfirmed'};
    if (failures.length) report.private_failure = await privateFailures('original-and-following-failures');
    report.result = failures.length ? 'failed' : 'passed'; report.finished_at = new Date().toISOString();
    try {await save();}
    catch (error) {
      // Never let report-write failure replace the earlier runtime/integrity errors.
      fail('final_report_write_failed', error, 'report'); report.result = 'failed';
      report.final_write_failure = await privateFailures('final-report-write-failure');
    }
    console.log(`YouTube owner gate evidence: ${reportPath}`);
  }
  if (failures.length) throw Error('YouTube native gate failed; inspect private owned evidence');
  return report;
}
