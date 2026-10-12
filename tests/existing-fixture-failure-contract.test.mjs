// Actual coordinator definitions with memory-only dependencies. Do not import
// native entrypoints or start native/DB/HTTP/socket/Cargo work from these tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, isAbsolute} from 'node:path';
import {inspect} from 'node:util';
import {runInNewContext} from 'node:vm';
import {cleanupShortAccountCase, privateFailureDetails} from './fixtures/short-platform-account-response.mjs';

const sources = Object.fromEntries(await Promise.all([
  'fixtures/native-owner-gate', 'short-platform-account-authority-native',
  'room-guest-access-authority-native', 'room-kick-authority-native',
].map(async name => [name, await readFile(new URL(`./${name}.mjs`, import.meta.url), 'utf8')])));
const section = (source, start, end) => {
  const at = source.indexOf(start); assert.notEqual(at, -1, start);
  assert.equal(source.indexOf(start, at + start.length), -1, `Unique extraction marker: ${start}`);
  const stop = source.indexOf(end, at + start.length); assert.notEqual(stop, -1, end);
  return source.slice(at, stop);
};
const base = {assert, Buffer, Error, AggregateError, AbortController, AbortSignal, privateFailureDetails};
const compile = (text, scope = {}) => runInNewContext(`(${text})`, {...base, ...scope});
const caught = async run => {try {return {passed: true, value: await run()};} catch (error) {return {passed: false, error};}};
const falsy = [undefined, null, false, 0, '', NaN];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gateText = sources['fixtures/native-owner-gate'].slice(sources['fixtures/native-owner-gate'].indexOf('export async function')).replace('export ', '');

async function mockedGate(options = {}) {
  const files = new Map(), writes = [], reads = [], attempts = [], logged = [];
  let post = false, report;
  const f = {id: 'memory', postgresDiagnostics: () => ({}), verifyStopped: async () => {
    attempts.push('cleanup'); if (Object.hasOwn(options, 'cleanupError')) throw options.cleanupError;
    return {completed: true};
  }};
  const fn = compile(gateText, {
    root: '/memory/root', commonInputs: ['first-helper', 'second-helper'], resolve, isAbsolute,
    process: {env: {RAINSYNC_ARTIFACT_DIR: '/memory/artifacts', RAINSYNC_NATIVE_POSTGRES_BIN: '/memory/postgres'}},
    randomUUID: () => 'owned-run', mkdir: async () => {}, sha256: digest,
    readFile: async path => {reads.push({path, post}); if (!post && path === options.unreadableInput) throw options.readError; if (post && options.drift?.includes(path)) return Buffer.from('changed'); return Buffer.from(path);},
    writeFile: async (path, bytes, config) => {
      writes.push({path, bytes: String(bytes), config});
      if (writes.length === 1 && Object.hasOwn(options, 'initialWriteError')) throw options.initialWriteError;
      if (path.endsWith('/report.json') && JSON.parse(bytes).result !== 'running' && Object.hasOwn(options, 'writeError')) throw options.writeError;
      if (path.endsWith('.private.json') && Object.hasOwn(options, 'privateWriteError')) throw options.privateWriteError;
      files.set(path, String(bytes));
    },
    loadOwnerBinding: async () => ({summary: {}, server: '/memory/server', verify: async () => {
      attempts.push('binding'); if (Object.hasOwn(options, 'bindingError')) throw options.bindingError;
    }}),
    withTerminationSignal: async fn => fn(new AbortController().signal),
    isolatedServer: async (_name, run, config) => {config.beforeStart(f);try {await run(f);} finally {post = true;}},
    setTimeout: () => 1, clearTimeout() {}, console: {log: text => logged.push(text), error: text => logged.push(text)},
  });
  const result = await caught(() => fn('memory-gate', async (_f, context) => {
    report = context.report; if (Object.hasOwn(options, 'runError')) throw options.runError;
  }));
  return {...result, report, files, writes, reads, attempts, logged};
}

test('shared cleanup preserves all caught falsy values while explicit no-failure remains successful', async () => {
  for (const primaryError of falsy) {
    const original = await caught(() => cleanupShortAccountCase({primaryError, primaryFailed: true}));
    assert.equal(original.passed, false); assert.ok(Object.is(original.error, primaryError));
    const later = Error('cleanup');
    const combined = await caught(() => cleanupShortAccountCase({primaryError, primaryFailed: true, release: async () => {throw later;}}));
    assert.deepEqual(combined.error.errors, [primaryError, later]);
  }
  await cleanupShortAccountCase({primaryError: undefined}); // Existing YouTube success contract.
  await cleanupShortAccountCase({primaryError: undefined, primaryFailed: false});
});

test('private serialization preserves errors/cause and explicitly rejects getter, toString and cycle failures', () => {
  const first = Error('first'), cause = Error('cause'); first.cause = cause;
  const wrapper = Error('safe'); Object.defineProperty(wrapper, 'errors', {value: [first, first, undefined]});
  const detail = JSON.parse(JSON.stringify(privateFailureDetails(wrapper)));
  const safeWrapper = Error('safe'); Object.defineProperty(safeWrapper, 'privateErrors', {value: [first]});
  assert.equal(privateFailureDetails(safeWrapper).errors[0].message, 'first');
  Object.defineProperty(safeWrapper, 'errors', {value: [cause]});
  assert.deepEqual(privateFailureDetails(safeWrapper).errors.map(e => e.message), ['cause', 'first']);
  assert.deepEqual(detail.errors.map(e => e.message), ['first', 'first', 'undefined']);
  assert.equal(detail.errors[0].cause.message, 'cause');
  for (const key of ['name', 'message', 'stack', 'cause', 'errors', 'privateErrors']) {
    const getter = Error(`getter-${key}`), hostile = Error('original');
    Object.defineProperty(hostile, key, {get() {throw getter;}});
    assert.throws(() => privateFailureDetails(hostile), error => error === getter);
  }
  const coercion = Error('coercion');
  assert.throws(() => privateFailureDetails({toString() {throw coercion;}}), error => error === coercion);
  first.cause = first;
  assert.throws(() => privateFailureDetails(first), /private_failure_cycle/);
});

test('actual shared owner gate never passes a falsy rejection; success still verifies and saves', async () => {
  for (const runError of falsy) {
    const f = await mockedGate({runError}); assert.equal(f.passed, false);
    assert.ok(Object.is(f.error.privateErrors[0], runError)); assert.equal(f.report.result, 'failed');
    const report = [...f.files].find(([path]) => path.endsWith('/report.json'))[1];
    assert.equal(JSON.parse(report).result, 'failed'); assert.deepEqual(f.attempts, ['binding', 'cleanup']);
  }
  const f = await mockedGate(); assert.equal(f.passed, true); assert.equal(f.value.result, 'passed');
  assert.equal(f.value.inputs_unchanged, true); assert.equal(f.value.cleanup.completed, true);
  assert.equal(f.writes.filter(item => item.path.endsWith('.private.json')).length, 0);
});

test('actual shared owner gate keeps primary, all independent rechecks, cleanup and final write in order with safe logs', async () => {
  const runError = Error('SECRET-runtime'), bindingError = Error('SECRET-binding'), cleanupError = Error('SECRET-cleanup'), writeError = Error('SECRET-write');
  const f = await mockedGate({runError, bindingError, cleanupError, writeError, drift: ['/memory/root/first-helper', '/memory/root/second-helper']});
  assert.equal(f.passed, false); assert.equal(f.report.result, 'failed'); assert.equal(f.report.inputs_unchanged, false);
  const errors = Array.from(f.error.privateErrors); assert.equal(errors.length, 6);
  assert.equal(errors[0], runError); assert.equal(errors[1], bindingError); assert.equal(errors[4], cleanupError); assert.equal(errors[5], writeError);
  assert.deepEqual(f.reads.filter(item => item.post).map(item => item.path), ['/memory/root/first-helper', '/memory/root/second-helper', '/memory/root/tests/memory-gate.mjs']);
  assert.deepEqual(f.attempts, ['binding', 'cleanup']);
  const saved = JSON.parse([...f.files].find(([path]) => path.endsWith('/final-report-failure.private.json'))[1]);
  assert.equal(saved.errors[0].message, runError.message); assert.equal(saved.errors.at(-1).message, writeError.message);
  assert.ok(f.writes.filter(item => item.path.endsWith('.private.json')).every(item => item.config.mode === 0o600 && item.config.flag === 'wx'));
  assert.doesNotMatch(f.logged.join('\n') + inspect(f.error) + JSON.stringify(f.report), /SECRET/);
});

test('actual shared owner gate handles final-only write failure and falsy later failures', async () => {
  const f = await mockedGate({writeError: undefined, cleanupError: false, bindingError: null});
  assert.equal(f.passed, false); assert.deepEqual(Array.from(f.error.privateErrors), [null, false, undefined]);
  const only = await mockedGate({writeError: 0}); assert.equal(only.passed, false);
  assert.deepEqual(Array.from(only.error.privateErrors), [0]); assert.equal(only.report.result, 'failed');
});

test('actual gate serialization and private write failures cannot skip cleanup or safe final save', async () => {
  const getter = Error('SECRET-getter'), original = Error('original'), disk = Error('SECRET-disk');
  Object.defineProperty(original, 'message', {get() {throw getter;}});
  const f = await mockedGate({runError: original, privateWriteError: disk});
  assert.equal(f.passed, false); assert.deepEqual(Array.from(f.error.privateErrors), [original, getter, disk]);
  assert.deepEqual(f.attempts, ['binding', 'cleanup']);
  assert.equal(JSON.parse([...f.files].find(([path]) => path.endsWith('/report.json'))[1]).result, 'failed');
  assert.ok(f.writes.some(item => item.bytes.includes('private_failure_serialization_failed') && item.path.endsWith('.private.json')));
  assert.doesNotMatch(f.logged.join('\n') + inspect(f.error) + JSON.stringify(f.report), /SECRET/);
});

const short = sources['short-platform-account-authority-native'], guest = sources['room-guest-access-authority-native'], kick = sources['room-kick-authority-native'];
const groupText = section(short, ' async function group(', '\n const admin=');
const runCaseText = section(guest, ' async function runCase(', '\n await runCase(');

test('actual short and guest wrappers retain nested originals plus serializer, receipt and phase failures', async () => {
  for (const [kind, definition] of [['short', groupText], ['guest', runCaseText]]) {
    for (const primary of [...falsy, new AggregateError([Error('first'), Error('cleanup')], 'nested')]) {
      const writes = [], report = {groups: [], cases: []};
      const fn = compile(definition, {report, active: undefined, check() {assert.fail('Must not credit failed case');}, phase: async () => {}, privateFile: async (_name, _suffix, bytes) => {writes.push(JSON.parse(bytes));return {};}});
      const result = await caught(() => fn('case', async () => {throw primary;}));
      assert.equal(result.passed, false); assert.ok(Object.is(result.error.errors[0], primary));
      if (primary instanceof AggregateError) assert.deepEqual(writes[0].errors.map(e => e.message), ['first', 'cleanup']);
      assert.equal((kind === 'short' ? report.groups : report.cases)[0].result, 'failed');
    }
    const getter = Error('getter'), primary = Error('primary'), disk = Error('disk'), phaseError = Error('phase');
    Object.defineProperty(primary, 'message', {get() {throw getter;}});
    const report = {groups: [], cases: []}, attempts = [];
    const fn = compile(definition, {report, active: undefined, check() {}, phase: async () => {attempts.push('phase'); if (attempts.length > 1) throw phaseError;}, privateFile: async () => {attempts.push('receipt'); throw disk;}});
    const result = await caught(() => fn('case', async () => {throw primary;}));
    assert.deepEqual(Array.from(result.error.errors), kind === 'short' ? [primary, getter, disk] : [primary, getter, disk, phaseError]);
    assert.ok(attempts.includes('receipt'));
  }
});

const releases = [
  ['short', section(short, '  async function release(){', '\n  try{await bounded(ready)')],
  ['guest', section(guest, '  async function release(){', '\n  try{await bounded(ready)')],
  ['kick', section(kick, '    async function release(){', '\n    try{\n      await bounded(ready);')],
];
test('actual holder releases attempt every independent private receipt, retaining original and falsy write failures', async () => {
  for (const [kind, definition] of releases) {
    const close = Error('close'), attempts = [], writeFailures = kind === 'guest' ? [undefined, false, 0] : [undefined, false];
    let ended = 0;
    const fn = compile(definition, {
      releasePromise: undefined, child: {stdin: {end() {ended++;}}, get done() {return Promise.reject(close);}},
      bounded: promise => promise, cleanupBound: promise => promise, record: {}, backend: undefined,
      label: 'memory', spec: {name: 'memory'}, out: [], err: [], stdout: [], stderr: [], setup: 'private setup',
      setTimeout: () => 1, clearTimeout() {},
      privateFile: async (_label, suffix) => {attempts.push(suffix); throw writeFailures[attempts.length - 1];},
    });
    const result = await caught(fn); assert.equal(result.passed, false);
    assert.deepEqual(Array.from(result.error.errors), [close, ...writeFailures]);
    assert.deepEqual(attempts, kind === 'guest' ? ['holder-setup.private.sql', 'holder.stdout.private.log', 'holder.stderr.private.log'] : ['holder.stdout.private.log', 'holder.stderr.private.log']);
    const again = await caught(fn); assert.equal(again.error, result.error); assert.equal(ended, 1);
  }
});

test('actual short expiry callback passes explicit caught presence into shared cleanup', async () => {
  const definition = section(short, ' async function expiryCase(', '\n for(const [name,action,boundary]');
  for (const primary of falsy) {
    let holders = 0;
    const fn = compile(definition, {providers: ['douyin', 'tiktok'], person: async () => ({}), imported: async () => ({}), holder: async () => {holders++;throw primary;}, bounded: promise => promise, cleanupShortAccountCase});
    const result = await caught(() => fn('status', 'admission'));
    assert.equal(result.passed, false); assert.ok(Object.is(result.error, primary)); assert.equal(holders, 1);
  }
});

const guestFinally = section(guest, '  finally{\n   const errors=[...evidenceErrors];', '\n  if(primaryFailed)throw failure;').replace(/^  finally/, 'async function finalizer()');
const kickFinally = section(kick, '    finally{\n      const errors=[];', '\n    if(primaryFailed)throw failure;').replace(/^    finally/, 'async function finalizer()');
test('actual guest cleanup retains original, earlier evidence, release, body and cleanup receipt errors', async () => {
  const primary = undefined, evidence = Error('evidence'), release = Error('release'), body = Error('body'), write = Error('write');
  const attempts = [];
  const fn = compile(guestFinally, {failure: primary, primaryFailed: true, evidenceErrors: [evidence], block: {release: async () => {attempts.push('release');throw release;}, record: {}}, pending: true, response: undefined, cleanupBound: async () => {attempts.push('body');throw body;}, active: {}, spec: {name: 'guest'}, privateFile: async () => {attempts.push('receipt');throw write;}});
  const result = await caught(fn); assert.equal(result.passed, false);
  assert.deepEqual(Array.from(result.error.errors), [primary, evidence, release, body, write]);
  assert.deepEqual(attempts, ['release', 'body', 'receipt']);
});

test('actual kick finalizer retains primary, release, HTTP and final phase errors without skipping save', async () => {
  for (const primary of [undefined, Error('primary')]) {
    const release = Error('release'), transport = Error('transport'), save = Error('save');
    const attempts = [], pending = Promise.reject(transport); pending.catch(() => {});
    const fn = compile(kickFinally, {failure: primary, primaryFailed: true, block: {release: async () => {attempts.push('release');throw release;}, record: {}}, pending, active: {phase: 'pending'}, cleanup: undefined, savePhase: async () => {attempts.push('save');throw save;}});
    const result = await caught(fn); assert.equal(result.passed, false);
    assert.deepEqual(Array.from(result.error.errors), [primary, release, transport, save]);
    assert.deepEqual(attempts, ['release', 'save']);
  }
});

test('actual case wrappers preserve their successful check and cleanup behavior', async () => {
  for (const [kind, definition] of [['short', groupText], ['guest', runCaseText]]) {
    const report = {groups: [], cases: []}, checks = [], phases = [];
    const fn = compile(definition, {report, active: undefined, check: name => checks.push(name), phase: async value => phases.push(value), privateFile: async () => assert.fail('No failure receipt on success')});
    const result = await caught(() => fn('success', async () => {}));
    assert.equal(result.passed, true); assert.deepEqual(checks, ['success']);
    assert.equal((kind === 'short' ? report.groups : report.cases)[0].result, 'passed');
    assert.deepEqual(phases, kind === 'short' ? [] : ['setup', 'complete']);
    if (kind === 'short') assert.equal(Object.hasOwn(report, 'active'), false);
  }
});

test('actual holders keep positive exit, PID/backend verification and idempotent successful release', async () => {
  for (const [kind, definition] of releases) {
    const record = {close_observed: true, exit_code: 0, signal: null}, attempts = [];
    const fn = compile(definition, {
      releasePromise: undefined, child: {pid: 123, exitCode: 0, stdin: {end() {attempts.push('commit');}}, done: Promise.resolve()},
      bounded: promise => promise, cleanupBound: promise => promise, record, backend: 321,
      label: 'memory', spec: {name: 'memory'}, out: [], err: [], stdout: [], stderr: [], setup: 'private setup',
      setTimeout: () => 1, clearTimeout() {}, fixed: (condition, name) => assert.ok(condition, name),
      verifyPidAbsent: pid => {assert.equal(pid, 123);attempts.push('pid');return true;},
      f: {sql: query => {assert.ok(query.includes('pid=321'));attempts.push('backend');return 't';}},
      privateFile: async (_label, suffix) => {attempts.push(suffix);return {path: suffix};},
    });
    assert.equal(await fn(), record); assert.equal(await fn(), record);
    assert.deepEqual(attempts, ['commit', 'pid', 'backend', ...(kind === 'guest' ? ['holder-setup.private.sql'] : []), 'holder.stdout.private.log', 'holder.stderr.private.log']);
    assert.equal(record.pid_absent, true); assert.equal(kind === 'kick' ? record.backend_pid_absent : record.backend_absent, true);
  }
});

test('actual guest boundary plus case wrapper cannot credit any falsy holder failure', async () => {
  const start = ' for(const spec of cases)await runCase(spec.name,';
  const callback = section(guest, start, '\n });').slice(start.length) + '\n }';
  for (const primary of falsy) {
    const report = {cases: [], checks: []};
    const scope = {...base, active: undefined, report, spec: {name: 'boundary', boundary: 'policy', expiry: true, status: 200},
      subject: async () => ({owner: {id: 'owner', client: {}}, member: {}, outside: {}}),
      f: {sql: () => '2026-10-10T12:00:00.000000Z'}, testLoginHash: () => 'hash', uuid: value => value, quote: value => value,
      fixed: (ok, name) => assert.ok(ok, name), privateFile: async () => ({}),
      snapshot: async () => ({value: {playback_sessions: [], playback_requests: []}, receipt: {}, sql: {}}),
      holder: async () => {throw primary;}, phase: async () => {}, check: name => report.checks.push(name)};
    const chain = runInNewContext(`({runCase: (${runCaseText}), work: (${callback})})`, scope);
    const result = await caught(() => chain.runCase('boundary', chain.work));
    assert.equal(result.passed, false); assert.ok(Object.is(result.error.errors[0], primary));
    assert.equal(report.cases[0].result, 'failed'); assert.deepEqual(report.checks, []);
  }
});

test('actual kick boundary catch carries falsy originals across successful and failed final saves', async () => {
  const loop = section(kick, '  for(const spec of cases){', '\n  assert.equal(sha256');
  for (const primary of falsy) for (const failSave of [false, true]) {
    const save = Error('save'), spec = {name: 'boundary', boundary: 'epoch'}, report = {boundary_cases: []}, checks = [];
    let saves = 0;
    const fn = compile(`async function boundary(){${loop}}`, {
      report, cases: [spec], signal: {throwIfAborted() {}}, subject: async () => ({room: {id: 'room'}, target: {id: 'target'}, actor: {id: 'actor'}, admission: {loginHash: 'hash'}, playback: 'playback'}),
      savePhase: async () => {if (++saves > 1 && failSave) throw save;},
      takeSnapshot: async () => ({receipt: {}, value: {playback_sessions: [{id: 'playback', auth_login_hash: 'hash'}]}}),
      holder: async () => {throw primary;}, check: name => checks.push(name),
    });
    const result = await caught(fn); assert.equal(result.passed, false);
    if (failSave) assert.deepEqual(Array.from(result.error.errors), [primary, save]);
    else assert.ok(Object.is(result.error, primary));
    assert.equal(saves, 2); assert.deepEqual(checks, []); assert.equal(report.boundary_cases[0].result, 'failed');
  }
});

test('actual kick cleanup attempts both HTTP receipts after the first receipt write fails', async () => {
  const first = Error('first receipt'), second = Error('second receipt'), save = Error('phase'), calls = [];
  const fn = compile(kickFinally, {failure: undefined, primaryFailed: true, block: undefined, cleanup: undefined, responseObserved: false,
    pending: Promise.resolve({status: 401, statusText: 'Unauthorized', headers: [], bodyUsed: false, text: async () => 'private body'}),
    active: {phase: 'pending'}, spec: {name: 'kick'}, privateFile: async (_label, suffix) => {calls.push(suffix);throw calls.length === 1 ? first : second;},
    savePhase: async () => {calls.push('save');throw save;},
  });
  const result = await caught(fn); assert.deepEqual(Array.from(result.error.errors), [undefined, first, second, save]);
  assert.deepEqual(calls, ['http.private.json', 'http-body.private.json', 'save']);
});

test('actual gate initial save failure still finalizes and never starts a fixture', async () => {
  const original = Error('initial write'); const f = await mockedGate({initialWriteError: original});
  assert.equal(f.passed, false); assert.deepEqual(Array.from(f.error.privateErrors), [original]); assert.deepEqual(f.attempts, []);
  const saved = JSON.parse([...f.files].find(([path]) => path.endsWith('/report.json'))[1]);
  assert.equal(saved.result, 'failed'); assert.deepEqual(saved.cleanup, {completed: true, resources_started: false});
});

test('actual gate partially captured inputs still get independent rechecks without an unchanged claim', async () => {
  const original = Error('unreadable'); const f = await mockedGate({unreadableInput: '/memory/root/second-helper', readError: original});
  assert.equal(f.passed, false); assert.equal(f.error.privateErrors[0], original); assert.deepEqual(f.attempts, ['binding']);
  assert.deepEqual(f.reads.map(item => item.path), ['/memory/root/first-helper', '/memory/root/second-helper', '/memory/root/first-helper']);
  const saved = JSON.parse([...f.files].find(([path]) => path.endsWith('/report.json'))[1]);
  assert.equal(saved.inputs_unchanged, false); assert.equal(saved.result, 'failed');
});

test('actual gate keeps all combinations of hostile serialization, failed private fallback and failed final save', async () => {
  const getter = Error('SECRET-coercion'), original = {toString() {throw getter;}}, disk = Error('SECRET-private-write'), final = Error('SECRET-final');
  const f = await mockedGate({runError: original, privateWriteError: disk, writeError: final});
  assert.equal(f.passed, false);
  assert.deepEqual(Array.from(f.error.privateErrors), [original, getter, disk, final, getter, disk]);
  assert.deepEqual(f.attempts, ['binding', 'cleanup']);
  assert.equal(f.writes.filter(item => item.path.endsWith('.private.json')).length, 2);
  assert.doesNotMatch(f.logged.join('\n') + inspect(f.error) + JSON.stringify(f.report), /SECRET/);
});

// Extract only the actual log projector, never execute the native coordinator.
const workerFailureSource = await readFile(new URL('./worker-error-classification.mjs', import.meta.url), 'utf8');
const resourceWrapperSource = await readFile(new URL('../apps/server/src/http_file_fallback.rs', import.meta.url), 'utf8');

test('synthetic local and HTTP worker grants preserve the production no-upstream marker', () => {
  const production = section(resourceWrapperSource, 'pub fn wrap_resource(', 'pub async fn seed(');
  assert.ok(production.includes('Some("local" | "agent" | "http")'));
  assert.ok(production.includes('resource.get("upstream_base").is_none()'));
  assert.ok(production.includes('outer["upstream_closed"] = json!(true);'));
  const seed = section(workerFailureSource, '      withPlaybackAdmission(', '      diagnostics.stage("wait_terminal",');
  const check = (source) => {
    const match = source.match(/\$\{json\((\{ encrypted: encrypt\(resource\)[^\n]*?\})\)\}/);
    assert.ok(match, 'The actual session INSERT must publish the resource envelope');
    for (const resource of [{kind: 'local', job_id: 'job', resource: 'fixture.mp4'},
      {kind: 'http', job_id: 'job', url: 'http://fixture.invalid/media', headers: {}}]) {
      let encrypted;
      const actual = runInNewContext(`(${match[1]})`, {resource, encrypt: value => {
        encrypted = value; return 'fixture-cipher';
      }});
      assert.equal(encrypted, resource);
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), {encrypted: 'fixture-cipher', upstream_closed: true});
    }
  };
  check(seed);
  for (const mutation of [seed.replace(', upstream_closed: true', ''),
    seed.replace('upstream_closed: true', 'upstream_closed: false'),
    seed.replace('upstream_closed: true', 'upstream_closed: null')])
    assert.throws(() => check(mutation), assert.AssertionError);
  for (const assertion of ['assert.equal(delivery.status, httpStatus);',
    'assert.equal(readiness.status, httpStatus);', 'assert.equal(error.error.code, code);',
    'assert.equal(error.error.retryable, false);', 'assert.equal(error.error.retry_after_ms, undefined);',
    'assert.ok(redacted);', 'assert.equal(published, "0");'])
    assert.ok(workerFailureSource.includes(assertion), assertion);
});
const workerDiagnosticFactory = compile(section(workerFailureSource, 'function createWorkerErrorDiagnostics(', '\nconst repo = '));
const plainWorkerSummary = (diagnostics, report) => JSON.parse(JSON.stringify(diagnostics.summary(report)));

test('actual worker failure summary removes unknown labels, raw text and coercion hooks', () => {
  const diagnostics = workerDiagnosticFactory(() => 10);
  const secret = 'SECRET-token-http://fixture.invalid/private?credential=hidden';
  const hostile = {toString() {throw Error(secret);}, toJSON() {throw Error(secret);}};
  diagnostics.stage(secret, {status: secret, error: secret, code: secret, count: secret, body: secret});
  diagnostics.observe({status: hostile, error: secret, code: secret, attempt: secret, http_status: secret,
    retryable: secret, retry_after_present: secret, redacted: secret, url: secret, spec: hostile, sql: secret,
    stack: secret, message: secret, cause: hostile, body: secret, token: secret});
  const summary = plainWorkerSummary(diagnostics, {result: secret, active_check: secret,
    failure: secret, cleanup_failure: secret, checks: [], cleanup: {completed: secret, worker_pid_absent: secret, origin_closed: secret}});
  assert.equal(summary.result, 'other'); assert.equal(summary.active_check, 'other');
  assert.equal(summary.active_stage, 'other'); assert.equal(summary.failure, 'other');
  assert.equal(summary.cleanup_failure, 'other');
  assert.deepEqual(summary.expected, {status: 'other', error: 'other', code: 'other', count: null});
  assert.deepEqual(summary.actual, {status: 'other', error: 'other', code: 'other', attempt: null,
    http_status: null, retryable: null, retry_after_present: null, redacted: null});
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|credential|fixture\.invalid|private|stack|message|token|spec|sql|body/);
  const getter = Object.defineProperty({}, 'error', {get() {throw Error(secret);}});
  diagnostics.observe(getter);
  assert.deepEqual(plainWorkerSummary(diagnostics, {}).actual, {});
});

test('actual worker failure summary accepts only finite bounded numbers and real booleans', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, 1.5, 1_000_000_001, '1e3', '0x10', ' 3', true, {}]) {
    const diagnostics = workerDiagnosticFactory(() => 0);
    diagnostics.observe({attempt: value, count: value, wait_timeout_ms: value});
    assert.deepEqual(plainWorkerSummary(diagnostics, {}).actual, {attempt: null, count: null, wait_timeout_ms: null});
  }
  for (const [http_status, expected] of [[99, null], [100, 100], [502, 502], [599, 599], [600, null]]) {
    const diagnostics = workerDiagnosticFactory(() => 0);
    diagnostics.observe({http_status, attempt: '3', count: '0', retryable: false, retry_after_present: true});
    assert.deepEqual(plainWorkerSummary(diagnostics, {}).actual,
      {attempt: 3, count: 0, http_status: expected, retryable: false, retry_after_present: true});
  }
});

test('actual worker coordinator captures a sanitized terminal snapshot before its failing assertion', () => {
  let now = 100;
  const diagnostics = workerDiagnosticFactory(() => now);
  const definition = section(workerFailureSource, '      diagnostics.stage("terminal_state",', '\n      diagnostics.stage("delivery_status",');
  const actual = {status: 'failed', attempt: 2, error: 'SECRET-untrusted-job-error'};
  const run = compile(`function terminal(){${definition}}`, {
    diagnostics, reason: 'upstream_transport_retry_exhausted', attempts: 3,
    f: {sql: () => JSON.stringify(actual)}, quote: () => 'fixture-id', id: 'fixture-id',
  });
  assert.throws(run, assert.AssertionError);
  actual.error = 'changed after capture'; now = 110;
  const summary = plainWorkerSummary(diagnostics, {result: 'failed', active_check: 'unavailable',
    failure: 'assertion_failed', cleanup_failure: 'verification_failed', checks: [1, 2, 3, 4],
    cleanup: {completed: true, worker_pid_absent: true, origin_closed: true}});
  assert.equal(summary.active_check, 'unavailable'); assert.equal(summary.active_stage, 'terminal_state');
  assert.equal(summary.stage_elapsed_ms, 10); assert.equal(summary.checks_recorded, 4);
  assert.equal(summary.failure, 'assertion_failed'); assert.equal(summary.cleanup_failure, 'verification_failed');
  assert.deepEqual(summary.expected, {status: 'failed', error: 'upstream_transport_retry_exhausted', attempt: 3});
  assert.deepEqual(summary.actual, {status: 'failed', error: 'other', attempt: 2});
  assert.doesNotMatch(JSON.stringify(summary), /SECRET|changed after capture/);
});

test('actual worker summary preserves unknown wait failures without claiming a deadline or a last probe', () => {
  let now = 0;
  const diagnostics = workerDiagnosticFactory(() => now);
  diagnostics.stage('terminal_state'); diagnostics.observe({attempt: 3});
  diagnostics.stage('wait_execution_reaped', {count: 0, wait_timeout_ms: 10000});
  now = 10200;
  const summary = plainWorkerSummary(diagnostics, {result: 'failed', active_check: 'unavailable',
    failure: 'verification_failed', checks: [1, 2, 3, 4]});
  assert.equal(summary.wait_outcome, 'unclassified_failure');
  assert.equal(summary.stage_elapsed_ms, 10200); assert.equal(summary.actual, null);
  assert.deepEqual(summary.expected, {count: 0, wait_timeout_ms: 10000});
  assert.equal(summary.cleanup_completed, null); assert.equal(summary.worker_pid_absent, null);
  assert.equal(summary.origin_closed, null);
});

test('worker diagnostic wiring keeps existing wait and retry contracts and logs only its projector', () => {
  assert.match(workerFailureSource, /\["unavailable", 503, "upstream_transport_retry_exhausted", 502, 3\]/);
  assert.match(workerFailureSource, /await f\.waitForSql\(\s*`SELECT status IN \('failed','succeeded'\)[\s\S]*?"t",\s*25000,/);
  assert.match(workerFailureSource, /await f\.waitForSql\(\s*`SELECT count\(\*\) FROM media_executions[\s\S]*?"0",\s*\);/);
  assert.match(workerFailureSource, /await f\.waitForSql\(\s*`SELECT count\(\*\) FROM cache_write_reservations[\s\S]*?"0",\s*\);/);
  assert.match(workerFailureSource, /await delay\(250\);/);
  const summaryLine = 'console.log("worker-error-classification summary: " + JSON.stringify(diagnostics.summary(report)));';
  assert.equal(workerFailureSource.split(summaryLine).length, 2);
  assert.ok(workerFailureSource.indexOf(summaryLine) < workerFailureSource.indexOf('await writeFile(path, JSON.stringify(report, null, 2))'));
  assert.doesNotMatch(workerFailureSource, /console\.(?:log|error)\([^;]*(?:error\.(?:stack|message)|JSON\.stringify\(report\))/);
});
