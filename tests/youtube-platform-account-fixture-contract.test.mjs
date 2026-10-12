// Pure Node: actual fixture assertion functions, immutable source strings and fake
// child/response objects. No native entrypoint import, process, socket or DB.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {requiredChecks, SQL, caseFailure, expiryFailure, assertChecks, assertOwnedCleanExit, outerQualification, assertDto, assertSafeText,
  assertYoutubeRateIncrement, exactLoginHash, cookieFile} from './fixtures/youtube-platform-account-contract.mjs';
import {cleanupShortAccountCase, trackResponseBody} from './fixtures/short-platform-account-response.mjs';
import {ownedYoutubeHolder} from './fixtures/youtube-platform-account-holder.mjs';
const expected = [
  'startup_opt_in_and_private_ten_field_dto',
  'exact_login_guest_csrf_json_precedence',
  'netscape_caps_consent_revision_rate_and_cipher',
  'status_exact_login_expiry_account_wait',
  'mutations_exact_login_expiry_account_wait',
  'mutations_exact_login_expiry_final_update_wait',
  'credential_expiry_replacement_tombstone_overflow',
  'precommit_commit_reject_and_owned_cleanup',
];
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const source = await read('tests/youtube-platform-account-authority-native.mjs');
const gateSource = await read('tests/fixtures/youtube-platform-account-gate.mjs');
const wire = value => JSON.stringify(value, (_key, value) => typeof value === 'bigint' ? JSON.rawJSON(value.toString()) : value);
const user = '00000000-0000-0000-0000-000000000001';
const scope = 'youtube-cookie-import';
const key = createHash('sha256').update(`account-rate:${scope}:${user}`).digest('hex');
const clocks = {before: '2026-10-10T00:00:00.123455Z', after: '2026-10-10T00:00:00.123458Z'};
const rate = () => ({scope, key_hash: key, attempts: 1n, window_started: '2026-10-10T00:00:00.123456Z', expires_at: '2026-10-10T00:10:00.123457Z'});
const rows = () => ({users: [{id: user}], sessions: [{token_hash: 'synthetic', expires_at: 'unchanged'}], user_profiles: [],
  platform_accounts: [{id: user, provider: 'youtube', revision: 9223372036854775807n, credential_encrypted: 'unchanged'}],
  platform_login_requests: [], account_rate_limits: [rate()]});
const passed = () => expected.map(name => ({name, result: 'passed'}));
test('independently frozen eight groups reject missing, duplicate, unknown, reordered or failed checks', () => {
  assert.deepEqual(requiredChecks, expected); assertChecks(passed());
  for (const mutate of [v => v.pop(), v => v.push(v[0]), v => {v[0].name = 'unknown';}, v => v.reverse(), v => {v[0].result = 'running';}]) {
    const value = passed(); mutate(value); assert.throws(() => assertChecks(value));
  }
});
test('YouTube Netscape DTO is exactly ten fields and forbids secret extras', () => {
  const value = {id: null, provider: 'youtube', revision: null, state: 'revoked', credential_expires_at: null,
    login_method: 'netscape_cookie_import', qr_available: false, verification: 'none', account_import_available: true, availability_reason: null};
  assertDto(value);
  for (const mutate of [v => {v.login_method = 'cookie_import';}, v => {v.cookies = 'bad';}, v => {delete v.account_import_available;}, v => {v.verification = 'verified';}]) {
    const candidate = {...value}; mutate(candidate); assert.throws(() => assertDto(candidate));
  }
  assert.match(cookieFile(), /^# Netscape HTTP Cookie File\n/);
});
test('exact client hash rejects borrowed fixtures and non-exact session cookies', () => {
  const f = {id: 'owned', sql() {}}, client = {fixture: f, cookie: 'rainsync_session=' + '1'.repeat(64)};
  assert.equal(exactLoginHash(f, client), createHash('sha256').update('1'.repeat(64)).digest('hex'));
  assert.throws(() => exactLoginHash({...f}, client));
  assert.throws(() => exactLoginHash(f, {...client, cookie: 'other=' + '1'.repeat(64)}));
});
test('YouTube account-wait unlink preserves SQL-zero-row precedence, final wait preserves final live guard', () => {
  assert.deepEqual(expiryFailure('unlink', 'account'), {status: 409, code: 'PLATFORM_ACCOUNT_CHANGED'});
  for (const [action, boundary] of [['status', 'account'], ['import', 'account'], ['import', 'final'], ['unlink', 'final']])
    assert.deepEqual(expiryFailure(action, boundary), {status: 401, code: 'SESSION_EXPIRED'});
  assert.throws(() => expiryFailure('other', 'account'));
  assert.ok(source.includes('const rejected = expiryFailure(action, boundary);'));
});
test('new and existing YouTube-only buckets preserve all other exact rows and microseconds', () => {
  const before = rows(), after = structuredClone(before); after.account_rate_limits[0].attempts++;
  assertYoutubeRateIncrement(wire(before), wire(after), user, clocks);
  before.account_rate_limits = []; after.account_rate_limits[0] = rate();
  assertYoutubeRateIncrement(wire(before), wire(after), user, clocks);
});
for (const [name, mutate] of [
  ['wrong short scope', v => {v.account_rate_limits[0].scope = 'platform-cookie-import';}],
  ['wrong key', v => {v.account_rate_limits[0].key_hash = 'other';}],
  ['MAX-1 revision', v => {v.platform_accounts[0].revision--;}],
  ['cipher change', v => {v.platform_accounts[0].credential_encrypted = 'changed';}],
  ['session change', v => {v.sessions[0].expires_at = 'changed';}],
  ['rate expiry microsecond', v => {v.account_rate_limits[0].expires_at = '2026-10-10T00:10:00.123458Z';}],
  ['double increment', v => {v.account_rate_limits[0].attempts++;}],
  ['extra account row', v => {v.platform_accounts.push({id: 'other'});}],
  ['omitted table', v => {delete v.platform_login_requests;}],
  ['duplicate rate row', v => {v.account_rate_limits.push({...v.account_rate_limits[0]});}],
]) test(`exact snapshot rejects ${name}`, () => {
  const before = rows(), after = structuredClone(before); after.account_rate_limits[0].attempts++; mutate(after);
  assert.throws(() => assertYoutubeRateIncrement(wire(before), wire(after), user, clocks));
});
test('new bucket cannot bypass actual request-bracketing DB clocks', () => {
  const before = rows(); before.account_rate_limits = [];
  assert.throws(() => assertYoutubeRateIncrement(wire(before), wire(rows()), user));
  const after = rows(); after.account_rate_limits[0].window_started = '2026-10-10T00:00:00.123454Z';
  assert.throws(() => assertYoutubeRateIncrement(wire(before), wire(after), user, clocks));
});
test('secret scanner rejects actual forbidden bytes, never serializes their contents in its message', () => {
  assertSafeText('safe', ['synthetic-secret']);
  assert.throws(() => assertSafeText('contains synthetic-secret', ['synthetic-secret']), error => !error.message.includes('synthetic-secret'));
});
function assertFixtureContract(text) {
  for (const literal of [
    "assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT, '1'",
    "assert.equal(process.env[name], undefined",
    'await nativeOwnerGate(', 'binding.server', 'assertChecks(report.checks)',
    "body_drained: true", 'await bounded(body.read())', "response.headers.get('cache-control'), 'no-store'",
    "cleanupShortAccountCase({pending, body, wait: bounded, primaryError: failure",
    "a.query=${quote(exact)}", 'pg_blocking_pids', "await witness('initial')", "await witness('expired')",
    'first.holder.backend_start, second.holder.backend_start', 'first.blocked.backend_start, second.blocked.backend_start',
    'assert.equal(next.raw, prev.raw)', 'rateChange(prev, next, s)',
    'assertYoutubeRateIncrement(before.raw, after.raw, s.id, {before: before.databaseClock, after: after.databaseClock})',
    "'DEFERRABLE INITIALLY DEFERRED '", "'BEFORE'", "'trigger-fired.private.json'",
    "floor(extract(epoch FROM credential_expires_at)*1000)::bigint", "expires * 1000",
    "await noExtractor();\n      const stopped = await f.stopServer();\n      assert.equal(stopped.observed_close, true);\n      await noExtractor();",
    'sha256(bytes)', "privateFailureDetails(error)", 'mode: 0o600',
    '32 * 1024', '64 * 1024', "assert.equal(f.sql('SELECT count(*) FROM control_cluster_activation'), '0')",
  ]) assert.ok(text.includes(literal), `Required fixture contract missing: ${literal}`);
  assert.equal((text.match(/catch \(error\) \{failure = caseFailure\(error\);\}/g) ?? []).length, 4, 'All four native cases must wrap every caught reason');
  assert.doesNotMatch(text, /\.bodyUsed\b|\.startServer\([^\n]*\);[^\n]*defaultBinary/);
}
test('real fixture source requires bound execution, real exact SQL witnesses, sticky drain and private evidence', () => assertFixtureContract(source));
for (const literal of ['binding.server', 'assertChecks(report.checks)', 'a.query=${quote(exact)}', 'pg_blocking_pids', 'await bounded(body.read())', "'DEFERRABLE INITIALLY DEFERRED '", 'rateChange(prev, next, s)', "mode: 0o600"])
  test(`actual source mutation removing ${literal} is rejected`, () => assert.throws(() => assertFixtureContract(source.replaceAll(literal, '/* removed */'))));
test('every reused runtime helper gets its own coordinator digest and shared source is untouched by this fixture', () => {
  for (const file of ['youtube-platform-account-contract', 'youtube-platform-account-holder', 'short-platform-account-snapshot', 'short-platform-account-response'])
    assert.ok(gateSource.includes(`'tests/fixtures/${file}.mjs'`));
  assert.doesNotMatch(source, /writeFile\([^\n]*(?:apps\/server|migrations|short-platform-account)/);
});
test('SQL witness strings match exact production statements including YouTube-specific differences', async () => {
  const youtube = await read('apps/server/src/platform_accounts/youtube.rs'), shared = await read('apps/server/src/platform_accounts.rs');
  for (const [name, sql] of Object.entries(SQL)) assert.ok((name === 'account' ? shared : youtube).includes(sql), `Missing production SQL ${name}`);
  assert.ok(SQL.status.includes("provider='youtube'"));
  assert.ok(SQL.import.includes('to_timestamp($8::double precision/1000)'));
  assert.ok(SQL.unlink.includes("provider='youtube' AND playback_login_allowed($4,$5)"));
});
function fakeHolder({rejectDone = false, receiptFailure = false} = {}) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.pid = 77; child.exitCode = null; child.signalCode = null;
  let done, failed, marker, doneCalls = 0;
  child.done = new Promise((resolve, reject) => {done = resolve; failed = reject;}); child.done.catch(() => {});
  const close = () => {child.exitCode = rejectDone ? 1 : 0; child.emit('close', child.exitCode, null); rejectDone ? failed(Error('original holder close')) : done();};
  child.stdin.write = value => {marker = /application_name='([^']+)'/.exec(value)[1]; queueMicrotask(() => child.stdout.emit('data', Buffer.from(marker + '_ready\n')));};
  child.stdin.end = () => queueMicrotask(close);
  child.kill = () => {child.signalCode = 'SIGKILL'; child.emit('close', null, 'SIGKILL'); done();};
  const writes = [], queries = [];
  const f = {sqlProcess() {return child;}, sql(query) {queries.push(query); return query.includes('jsonb_agg') ? JSON.stringify([{pid: 88, backend_start: '2026-10-10T00:00:00Z'}]) : 't';}};
  return {queries, writes, options: {f, row: {id: user}, boundary: 'account', label: 'fake',
    bounded: promise => {doneCalls++; return promise;}, pidAbsent: pid => {assert.equal(pid, 77); return true;},
    privateFile: async (label, suffix, bytes) => {writes.push(suffix); if (receiptFailure) throw Error('receipt failure'); return {path: label + suffix, bytes: bytes.length};}}};
}
test('actual holder function observes close, exact PID/backend absence and idempotent receipt cleanup on fake objects', async () => {
  const fake = fakeHolder(), holder = await ownedYoutubeHolder(fake.options);
  const first = await holder.release(), second = await holder.release();
  assert.equal(first, second); assert.equal(first.close_observed, true); assert.equal(first.pid_absent, true); assert.equal(first.backend_absent, true);
  assert.deepEqual(fake.writes, ['holder.stdout.private.log', 'holder.stderr.private.log', 'holder-lifecycle.private.json']);
});
test('actual holder function keeps original failure when every private receipt write also fails', async () => {
  const fake = fakeHolder({rejectDone: true, receiptFailure: true}), holder = await ownedYoutubeHolder(fake.options);
  await assert.rejects(holder.release(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].message, 'original holder close');
    assert.equal(error.errors.filter(e => e.message === 'receipt failure').length, 3); return true;
  });
  assert.ok(fake.queries.some(q => q.includes('pg_terminate_backend') && q.includes('backend_start=') && q.includes('application_name=')));
});

function assertPoststopGate(text) {
  const start = text.indexOf('await isolatedServer(');
  const end = text.indexOf('stage = \'poststop\';', start);
  const audit = text.indexOf('await afterStopped();', end);
  const binding = text.indexOf('await binding.verify();', audit);
  const complete = text.indexOf("report.result = failures.length ? 'failed' : 'passed'", binding);
  assert.ok(start >= 0 && end > start && audit > end && binding > audit && complete > binding);
  for (const literal of ['binary: binding.server', 'beforeStart: f => {fixture = f;}', 'await fixture.verifyStopped()',
    'privateFailureDetails(error)', 'assertChecks(report.checks)', "assert.ok(!process.env.DATABASE_URL", 'RAINSYNC_NATIVE_POSTGRES_BIN',
    "'tests/fixtures/postgres.mjs'", "'tests/fixtures/server.mjs'", "'tests/fixtures/unused-port.mjs'", "'deploy/owned-process.mjs'", "mode: 0o600"])
    assert.ok(text.includes(literal));
  assert.doesNotMatch(text, /console\.error\(error|console\.error\(failure/);
}
test('dedicated gate audits only after complete owned teardown and before final passed report', () => assertPoststopGate(gateSource));
for (const literal of ['await afterStopped();', 'binary: binding.server', 'await fixture.verifyStopped()', 'assertChecks(report.checks)'])
  test(`actual gate source cannot omit ${literal}`, () => assert.throws(() => assertPoststopGate(gateSource.replaceAll(literal, '/* removed */'))));

test('post-flush audit requires every recorded bound Server log, never an empty scan', () => {
  for (const literal of ['assert.equal(report.cleanup.servers.length, 2)', 'assert.equal(server.binary, binding.server)', 'assert.deepEqual(logs, expectedLogs)'])
    assert.ok(source.includes(literal));
});


async function mockedGate(options = {}) {
  // Execute the actual exported gate function text with in-memory dependencies.
  // No mocked helper is counted as a native execution/integrity proof.
  const {runInNewContext} = await import('node:vm');
  const {resolve, dirname} = await import('node:path');
  const {privateFailureDetails} = await import('./fixtures/short-platform-account-response.mjs');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const original = path => Buffer.from('frozen:' + path);
  const manifest = {
    producers: ['scripts/bind-native-backend.mjs', 'scripts/native-owner-binding.mjs'].map(path => ({path, sha256: digest(original('/fake/' + path))})),
    binaries: [{name: 'rainsync-server', path: '/fake-target/debug/rainsync-server', sha256: digest(original('/fake-target/debug/rainsync-server'))}],
    test_helpers: [{name: 'fixture_password', path: '/fake-target/debug/examples/fixture_password', sha256: digest(original('/fake-target/debug/examples/fixture_password'))}],
    owner_fixtures: [{name: 'owner-tests', test_name: 'owned_test', path: '/fake-target/debug/deps/owner-tests', sha256: digest(original('/fake-target/debug/deps/owner-tests')), build: {exit_code: 0}}],
  };
  if (options.noOwners) delete manifest.owner_fixtures;
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const files = new Map(), written = [], reads = [], phases = [], executed = [];
  let post = false;
  const f = {id: 'fake-owned', postgresDiagnostics: () => ({}), verifyStopped: async () => {
    phases.push('verify-stopped'); if (options.cleanupError) throw Error('cleanup verification failure'); if (Object.hasOwn(options, 'cleanupReceipt')) return options.cleanupReceipt; return {completed: true, server_port_closed: true, servers: [{closed_at: 'observed-close', pid_absent: true, exit_code: 0, signal: null}], postgres: {kind: 'native', stopped: true, process_close_observed: true, pid_absent: true, pg_ctl_status: 3, port_closed: true, exit_code: 0, signal: null}};
  }};
  const sandbox = {
    assert, resolve, dirname, root: '/fake', commonInputs: ['helper', 'second-helper'], Buffer, AbortController, AbortSignal, Error, AggregateError,
    process: {execPath: '/fake-node', version: options.wrongNodeMajor ? 'v22.1.0' : 'v24.19.0', versions: {node: options.wrongNodeMajor ? '22.1.0' : '24.19.0'}, platform: 'linux', env: {RAINSYNC_ARTIFACT_DIR: '/fake-artifacts', RAINSYNC_NATIVE_POSTGRES_BIN: '/fake-pg', RAINSYNC_FIXTURE_CLEANUP_REPORT: '1', CARGO_TARGET_DIR: '/fake-target', W03_BACKEND_BINDING: '/fake-binding'}},
    isAbsolute: value => value.startsWith('/'), randomUUID: () => 'fake-run', mkdir: async () => {},
    writeFile: async (path, bytes) => {
      written.push({path, bytes: String(bytes)});
      if (options.finalWriteError && /report-\d+\.pending\.private\.json$/.test(path) && JSON.parse(String(bytes)).result !== 'running') throw Error('final report write failure');
      files.set(path, String(bytes));
    },
    rename: async (from, to) => {if (options.finalRenameError && JSON.parse(files.get(from)).result !== 'running') throw Error('final report rename failure'); files.set(to, files.get(from)); files.delete(from);},
    realpath: async path => options.foreignPgDirectory && path === '/fake-pg/pg_ctl' ? '/other-pg/pg_ctl' : path,
    execFileSync: (path, args, config) => {executed.push(path); assert.deepEqual(Array.from(args), ['--version']); assert.equal(config.timeout, 5000); return `${path.split('/').at(-1)} (PostgreSQL) ${options.mixedPgVersion && path.endsWith('/psql') ? '18.1' : '17.5'}`;},
    stat: async () => ({isFile: () => true, mode: 0o755}),
    readFile: async path => {
      reads.push({path, post});
      if (path === '/fake-binding') return manifestBytes;
      if (options.preflightUnreadable === path) throw Error('unreadable input');
      return post && options.drift?.includes(path) ? Buffer.from('drift:' + path) : original(path);
    },
    sha256: digest, privateFailureDetails,
    loadOwnerBinding: async () => {
      if (options.bindingLoadError) throw Error('binding preflight failure');
      return {summary: {sha256: digest(manifestBytes)}, server: '/fake-target/debug/rainsync-server', verify: async () => {
        phases.push('binding-verify'); if (options.bindingError) throw Error('binding recheck failure');
      }};
    },
    withTerminationSignal: async fn => fn(new AbortController().signal),
    isolatedServer: async (_name, fn, config) => {
      assert.equal(config.binary, '/fake-target/debug/rainsync-server'); config.beforeStart(f);
      try {if (options.startupError) throw Error('owned server startup failure'); await fn(f);} finally {post = true; phases.push('streams-flushed');}
    },
    setTimeout: () => 1, clearTimeout: () => {}, console: {log() {}}, assertChecks, assertOwnedCleanExit, outerQualification,
  };
  const fn = runInNewContext(gateSource.slice(gateSource.indexOf('export async function')).replace('export ', '') + '\nyoutubeNativeOwnerGate', sandbox);
  let error, result;
  try {
    result = await fn('youtube-platform-account-authority-native', async (_f, {report}) => {
      report.checks = passed();
      if (Object.hasOwn(options, 'runValue')) throw options.runValue;
      if (options.runError) throw Error('original runtime failure');
      return async () => {phases.push('audit'); if (Object.hasOwn(options, 'auditCleanupReceipt')) report.cleanup = options.auditCleanupReceipt; if (options.auditError) throw Error('original post-stop audit failure');};
    });
  } catch (caught) {error = caught;}
  const reportEntry = [...files.entries()].find(([path]) => path.endsWith('/report.json'));
  return {error, result, written, reads, phases, files, executed, report: reportEntry ? JSON.parse(reportEntry[1]) : null};
}

test('actual gate rejects post-stop failure and still rechecks binding, coordinator, every input and cleanup', async () => {
  const fake = await mockedGate({auditError: true});
  assert.match(fake.error?.message ?? '', /YouTube native gate failed/);
  assert.deepEqual(fake.phases, ['streams-flushed', 'audit', 'binding-verify', 'verify-stopped']);
  assert.equal(fake.report.result, 'failed'); assert.equal(fake.report.failure.stage, 'poststop');
  assert.equal(fake.report.integrity.binding, 'passed');
  assert.ok(fake.report.integrity.coordinator.every(input => input.result === 'passed'));
  assert.equal(fake.report.integrity.execution_inputs.length, 10);
  assert.ok(fake.report.integrity.execution_inputs.every(input => input.result === 'passed'));
  assert.equal(fake.report.cleanup.completed, true);
});
test('actual gate records optional owner artifact, producers, executing Node and every PG tool without execution', async () => {
  const fake = await mockedGate(); assert.equal(fake.error, undefined); assert.equal(fake.report.result, 'passed');
  const inputs = fake.report.integrity.execution_inputs;
  assert.deepEqual(inputs.map(input => input.kind), ['producer', 'producer', 'binary', 'test_helper', 'owner_fixture', 'node', 'postgres_tool', 'postgres_tool', 'postgres_tool', 'postgres_tool']);
  assert.deepEqual(inputs.filter(input => input.kind === 'postgres_tool').map(input => input.name), ['initdb', 'postgres', 'psql', 'pg_ctl']);
  assert.equal(inputs.find(input => input.kind === 'owner_fixture').before.execution, 'not_executed');
  assert.deepEqual(fake.executed, [...['initdb', 'postgres', 'psql', 'pg_ctl'], ...['initdb', 'postgres', 'psql', 'pg_ctl']].map(name => '/fake-pg/' + name));
  for (const {before, after} of inputs) {assert.deepEqual(before, after); assert.equal(before.path, before.realpath); assert.match(before.sha256, /^[a-f0-9]{64}$/);}
  assert.equal(inputs.find(input => input.kind === 'node').before.version, 'v24.19.0');
  assert.deepEqual(fake.report.postgres_toolchain, {directory: '/fake-pg', version: '17.5'});
  assert.equal(fake.report.inputs_complete, true); assert.equal(fake.report.inputs_unchanged, true);
});
for (const [name, path] of [
  ['owner artifact', '/fake-target/debug/deps/owner-tests'],
  ['producer', '/fake/scripts/bind-native-backend.mjs'],
  ['binding producer', '/fake/scripts/native-owner-binding.mjs'],
  ['actual Node', '/fake-node'],
  ['initdb', '/fake-pg/initdb'], ['postgres', '/fake-pg/postgres'], ['psql', '/fake-pg/psql'], ['pg_ctl', '/fake-pg/pg_ctl'],
]) test(`actual gate rejects ${name} drift without skipping other postchecks or cleanup`, async () => {
  const fake = await mockedGate({drift: [path]});
  assert.ok(fake.error); assert.equal(fake.report.result, 'failed'); assert.equal(fake.report.inputs_unchanged, false);
  const changed = fake.report.integrity.execution_inputs.filter(input => input.result === 'failed');
  assert.equal(changed.length, 1); assert.equal(changed[0].before.path, path);
  assert.equal(fake.report.integrity.execution_inputs.length, 10); assert.equal(fake.report.cleanup.completed, true);
});
test('actual gate retains runtime, integrity, cleanup and final report-write failures in original order', async () => {
  const fake = await mockedGate({runError: true, bindingError: true, drift: ['/fake/helper', '/fake-pg/psql'], cleanupError: true, finalWriteError: true});
  assert.ok(fake.error); assert.equal(fake.report.result, 'running', 'Atomic failed final save leaves the earlier report unqualified');
  assert.deepEqual(fake.phases, ['streams-flushed', 'binding-verify', 'verify-stopped']);
  const attemptedFinal = JSON.parse(fake.written.filter(item => /report-\d+\.pending/.test(item.path)).at(-1).bytes);
  assert.equal(attemptedFinal.failure.code, 'youtube_native_gate_failed');
  assert.deepEqual(attemptedFinal.failures.map(item => item.code), ['youtube_native_gate_failed', 'backend_binding_recheck_failed', 'coordinator_recheck_failed', 'execution_input_recheck_failed', 'owned_cleanup_unconfirmed']);
  const stored = JSON.parse(fake.written.find(item => item.path.endsWith('/final-report-write-failure.private.json')).bytes);
  assert.deepEqual(stored.errors.map(item => item.message.split('\n')[0]), ['original runtime failure', 'binding recheck failure', 'Fixture source changed during execution', 'Execution input changed during validation', 'cleanup verification failure', 'final report write failure']);
  assert.equal(fake.reads.filter(item => item.post && item.path === '/fake/second-helper').length, 1);
});
test('actual gate final save failure alone cannot return or persist passed qualification', async () => {
  const fake = await mockedGate({finalWriteError: true}); assert.ok(fake.error); assert.equal(fake.report.result, 'running');
  const stored = JSON.parse(fake.written.find(item => item.path.endsWith('/final-report-write-failure.private.json')).bytes);
  assert.deepEqual(stored.errors.map(item => item.message), ['final report write failure']);
});
test('actual gate preflight failure has explicit incomplete integrity and starts no services', async () => {
  const fake = await mockedGate({bindingLoadError: true});
  assert.ok(fake.error); assert.equal(fake.report.inputs_complete, false); assert.equal(fake.report.inputs_unchanged, false);
  assert.equal(fake.report.integrity.binding, 'not_checked'); assert.equal(fake.report.cleanup.resources_started, false);
  assert.deepEqual(fake.phases, []);
});
test('actual gate partially captured preflight inputs never become an unchanged certificate', async () => {
  const fake = await mockedGate({preflightUnreadable: '/fake-pg/postgres'});
  assert.ok(fake.error); assert.equal(fake.report.inputs_complete, false); assert.equal(fake.report.inputs_unchanged, false);
  assert.equal(fake.report.integrity.execution_inputs.at(-1).before, null);
  assert.equal(fake.report.integrity.execution_inputs.at(-1).result, 'failed');
  assert.equal(fake.report.cleanup.resources_started, false);
});
test('actual gate explicitly records a binding without owner fixtures as absent', async () => {
  const fake = await mockedGate({noOwners: true}); assert.equal(fake.error, undefined);
  assert.equal(fake.report.owner_fixture_presence, 'absent');
  assert.equal(fake.report.integrity.execution_inputs.some(input => input.kind === 'owner_fixture'), false);
});

for (const option of ['foreignPgDirectory', 'mixedPgVersion'])
  test(`actual gate rejects incoherent PostgreSQL ${option} before any service starts`, async () => {
    const fake = await mockedGate({[option]: true}); assert.ok(fake.error);
    assert.equal(fake.report.inputs_complete, false); assert.equal(fake.report.inputs_unchanged, false);
    assert.equal(fake.report.cleanup.resources_started, false);
    assert.deepEqual(fake.phases, ['binding-verify']);
  });

test('actual gate rechecks all preflight inputs even when Server startup never reaches the fixture callback', async () => {
  const fake = await mockedGate({startupError: true}); assert.ok(fake.error);
  assert.equal(fake.report.failure.stage, 'fixture'); assert.equal(fake.report.checks.length, 0);
  assert.equal(fake.report.integrity.binding, 'passed');
  assert.equal(fake.report.integrity.execution_inputs.length, 10);
  assert.ok(fake.report.integrity.execution_inputs.every(input => input.result === 'passed'));
  assert.ok(fake.report.integrity.coordinator.every(input => input.result === 'passed'));
  assert.equal(fake.report.cleanup.completed, true);
  assert.deepEqual(fake.phases, ['streams-flushed', 'binding-verify', 'verify-stopped']);
});

test('actual gate wrong Node major fails before any native metadata probe or service startup', async () => {
  const fake = await mockedGate({wrongNodeMajor: true}); assert.ok(fake.error);
  assert.equal(fake.report.failure.stage, 'prerequisites'); assert.equal(fake.report.inputs_complete, false);
  assert.equal(fake.report.inputs_unchanged, false); assert.deepEqual(fake.executed, []); assert.deepEqual(fake.phases, []);
});
test('actual gate final atomic rename failure preserves original runtime failure and earlier unqualified report', async () => {
  const fake = await mockedGate({runError: true, finalRenameError: true}); assert.ok(fake.error);
  assert.equal(fake.report.result, 'running');
  const stored = JSON.parse(fake.written.find(item => item.path.endsWith('/final-report-write-failure.private.json')).bytes);
  assert.deepEqual(stored.errors.map(item => item.message), ['original runtime failure', 'final report rename failure']);
});

for (const [label, reason] of [['undefined', undefined], ['null', null], ['false', false], ['zero', 0], ['negative zero', -0], ['NaN', NaN], ['empty string', '']])
  test(`actual case wrapper and shared cleanup retain thrown ${label} after successful drain/cleanup`, async () => {
    let failure;
    try {throw reason;} catch (error) {failure = caseFailure(error);}
    const calls = [], pending = Promise.resolve({status: 500, text: async () => 'drained'});
    const body = trackResponseBody(pending);
    await assert.rejects(cleanupShortAccountCase({pending, body, primaryError: failure,
      wait: promise => promise, release: async () => {calls.push('release');},
      drop: async () => {assert.equal(body.bodyDrained, true); calls.push('drop');}}), error => {
        assert.equal(error, failure); assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1); assert.equal(Object.is(error.errors[0], reason), true); return true;
      });
    assert.deepEqual(calls, ['release', 'drop']);
  });
test('actual case wrapper keeps falsy original ahead of simultaneous falsy cleanup rejections', async () => {
  const original = caseFailure(false);
  await assert.rejects(cleanupShortAccountCase({primaryError: original, wait: promise => promise,
    release: async () => {throw undefined;}, drop: async () => {throw 0;}}), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
      assert.deepEqual(error.errors, [original, undefined, 0]); assert.deepEqual(original.errors, [false]); return true;
    });
});
test('actual native source mutation reverting one caught reason to truthiness is rejected', () => {
  assert.throws(() => assertFixtureContract(source.replace('failure = caseFailure(error);', 'failure = error;')));
});
function hostileRejection(kind) {
  if (kind === 'toString') return {toString() {throw Error('hostile toString');}};
  const error = new Error('initial');
  Object.defineProperty(error, 'message', {get() {throw Error('hostile message getter');}});
  return error;
}
for (const kind of ['toString', 'getter'])
  test(`actual gate catches hostile ${kind} serialization, writes fixed fallback and still finalizes failed`, async () => {
    const fake = await mockedGate({runValue: hostileRejection(kind)});
    assert.match(fake.error?.message ?? '', /YouTube native gate failed/);
    assert.equal(fake.report.result, 'failed'); assert.equal(fake.report.cleanup.completed, true);
    assert.deepEqual(fake.report.failures.map(item => item.code), ['youtube_native_gate_failed', 'private_failure_serialization_failed']);
    assert.equal(fake.report.private_failure.serialization, 'fixed_fallback');
    const fallback = JSON.parse(fake.files.get(fake.report.private_failure.path));
    assert.deepEqual(fallback, {code: 'private_failure_serialization_failed', details: 'raw failure details unavailable'});
    assert.deepEqual(fake.phases, ['streams-flushed', 'binding-verify', 'verify-stopped']);
  });
test('actual gate hostile serialization plus final-save rejection still preserves unqualified report and fallback evidence', async () => {
  const fake = await mockedGate({runValue: hostileRejection('getter'), finalWriteError: true});
  assert.match(fake.error?.message ?? '', /YouTube native gate failed/); assert.equal(fake.report.result, 'running');
  assert.deepEqual(fake.phases, ['streams-flushed', 'binding-verify', 'verify-stopped']);
  const finalAttempt = JSON.parse(fake.written.filter(item => /report-\d+\.pending/.test(item.path)).at(-1).bytes);
  assert.equal(finalAttempt.result, 'failed'); assert.equal(finalAttempt.cleanup.completed, true);
  assert.equal(finalAttempt.failure.code, 'youtube_native_gate_failed');
  const fallback = JSON.parse(fake.written.find(item => item.path.endsWith('/final-report-write-failure.private.json')).bytes);
  assert.equal(fallback.code, 'private_failure_serialization_failed');
});

function cleanExitReceipt() {
  return {completed: true, server_port_closed: true,
    servers: [{binary: '/fake-target/debug/rainsync-server', closed_at: 'observed-close', pid_absent: true, exit_code: 0, signal: null}],
    postgres: {kind: 'native', stopped: true, process_close_observed: true, pid_absent: true, pg_ctl_status: 3, port_closed: true, exit_code: 0, signal: null}};
}
for (const [label, mutate] of [
  ['Server nonzero exit', r => {r.servers[0].exit_code = 2;}],
  ['Server signal termination', r => {r.servers[0].exit_code = null; r.servers[0].signal = 'SIGKILL';}],
  ['PostgreSQL nonzero exit', r => {r.postgres.exit_code = 1;}],
  ['PostgreSQL signal termination', r => {r.postgres.exit_code = null; r.postgres.signal = 'SIGTERM';}],
  ['missing Server exit evidence', r => {delete r.servers[0].exit_code;}],
  ['missing PostgreSQL exit evidence', r => {delete r.postgres.exit_code;}],
]) test(`actual gate rejects ${label} while retaining primary failure and full stopped receipt`, async () => {
  const receipt = cleanExitReceipt(); mutate(receipt);
  for (const runError of [false, true]) {
    const fake = await mockedGate({runError, cleanupReceipt: receipt}); assert.ok(fake.error);
    assert.equal(fake.report.result, 'failed');
    assert.equal(fake.report.failure.code, runError ? 'youtube_native_gate_failed' : 'owned_process_exit_unqualified');
    assert.deepEqual(fake.report.cleanup, receipt);
    assert.equal(fake.report.cleanup_qualification.result, 'failed');
    assert.equal(fake.report.failures.at(-1).code, 'owned_process_exit_unqualified');
    const stored = JSON.parse(fake.files.get(fake.report.private_failure.path));
    if (runError) assert.equal(stored.errors[0].message, 'original runtime failure');
    else assert.equal(stored.errors.length, 1);
    assert.equal(fake.report.integrity.binding, 'passed');
  }
});
test('actual gate clean service exits still do not certify external supervisor or outer runner success', async () => {
  const fake = await mockedGate(); assert.equal(fake.error, undefined);
  assert.equal(fake.report.cleanup_qualification.result, 'passed');
  assert.deepEqual(fake.report.native_qualification, outerQualification);
  assert.equal(fake.report.native_qualification.result, 'requires_outer_receipt');
});
test('actual gate failed startup with zero Server records preserves original error without inventing a launch', async () => {
  const receipt = cleanExitReceipt(); receipt.servers = [];
  const fake = await mockedGate({startupError: true, cleanupReceipt: receipt}); assert.ok(fake.error);
  assert.equal(fake.report.cleanup_qualification.server_processes_checked, 0);
  assert.equal(fake.report.failure.code, 'youtube_native_gate_failed');
  assert.equal(fake.report.failures.length, 1);
});

for (const [label, receipt] of [['undefined', undefined], ['null', null], ['false', false], ['zero', 0], ['empty string', '']])
  test(`actual gate rejects successful verifyStopped resolution with missing ${label} receipt`, async () => {
    for (const runError of [false, true]) {
      const fake = await mockedGate({runError, cleanupReceipt: receipt}); assert.ok(fake.error);
      assert.equal(fake.report.result, 'failed');
      assert.equal(fake.report.cleanup_qualification.result, 'failed');
      assert.equal(fake.report.failures.at(-1).code, 'owned_process_exit_unqualified');
      assert.equal(fake.report.failure.code, runError ? 'youtube_native_gate_failed' : 'owned_process_exit_unqualified');
      assert.equal(fake.report.native_qualification.result, 'requires_outer_receipt');
      assert.equal(fake.report.integrity.binding, 'passed');
      assert.equal(fake.report.cleanup, receipt);
    }
  });
test('actual gate nullable earlier cleanup plus later verification rejection cannot replace original audit failure or skip final report', async () => {
  const fake = await mockedGate({auditCleanupReceipt: null, auditError: true, cleanupError: true}); assert.ok(fake.error);
  assert.equal(fake.report.result, 'failed'); assert.equal(fake.report.failure.stage, 'poststop');
  assert.equal(fake.report.cleanup.completed, false);
  assert.deepEqual(fake.report.failures.map(item => item.code), ['youtube_native_gate_failed', 'owned_cleanup_unconfirmed']);
  const stored = JSON.parse(fake.files.get(fake.report.private_failure.path));
  assert.deepEqual(stored.errors.map(item => item.message), ['original post-stop audit failure', 'cleanup verification failure']);
  assert.deepEqual(fake.phases, ['streams-flushed', 'audit', 'binding-verify', 'verify-stopped']);
});
