// Execute the actual coordinator definition with memory-only dependencies.
// Never import native entrypoints or start tools, processes, DBs, or sockets.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

const source = await readFile(new URL('./compute-finish-owner-native.mjs', import.meta.url), 'utf8');
const start = 'async function mediaReceipts(';
const end = '\nfunction installAckGate(';
const from = source.indexOf(start);
assert.notEqual(from, -1, 'Extract the actual mediaReceipts definition');
assert.equal(source.indexOf(start, from + start.length), -1, 'Unique mediaReceipts definition');
const to = source.indexOf(end, from + start.length);
assert.notEqual(to, -1, 'Extract only mediaReceipts, never the native entrypoint');
const definition = source.slice(from, to);

const receiptPath = '/memory/receipts';
const serverPid = 2000;
const job = 'owned-job';
const generation = 'owned-generation';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const binaries = new Map(['ffmpeg', 'ffprobe'].map(tool => [`/usr/bin/${tool}`, Buffer.from(`memory binary: ${tool}`)]));
const plain = value => JSON.parse(JSON.stringify(value));

function receipt(index, tool = index === 0 ? 'ffmpeg' : 'ffprobe') {
  return {
    invocation: `invocation-${String(index).padStart(2, '0')}`, tool,
    wrapper_pid: 3000 + index, parent_pid: serverPid, child_pid: 4000 + index,
    output_bindings: [{job_id: job, output_generation: generation}],
    spawn_observed: true, close_observed: true, exit_code: 0, signal: null,
    pid_absent: true, spawn_error: false, observer_error: false,
    observer_error_phase: null, observer_error_type: null, observer_error_errno: null,
    child_executable: `/memory/real/${tool}`,
    child_executable_sha256: digest(binaries.get(`/usr/bin/${tool}`)),
    child_parent_pid: 3000 + index, child_start_ticks: String(100000 + index),
    received_signals: [],
  };
}
const complete = () => Array.from({length: 7}, (_, index) => receipt(index));

function memory(records, {livePids = []} = {}) {
  const files = new Map(records.map((record, index) => [`receipt-${index}.json`, JSON.stringify(record)]));
  // Atomic-write leftovers must never be treated as published JSON receipts.
  files.set('unfinished.tmp', 'not JSON and must never be read');
  const reads = [], pidChecks = [], paths = [], hashes = [];
  const fn = runInNewContext(`(${definition})`, {
    assert, resolve,
    readdir: async path => {assert.equal(path, receiptPath); return [...files.keys()];},
    readFile: async (path, encoding) => {
      reads.push(path);
      if (binaries.has(path)) {assert.equal(encoding, undefined); return binaries.get(path);}
      assert.equal(encoding, 'utf8');
      const name = path.slice(`${receiptPath}/`.length);
      assert.equal(path, resolve(receiptPath, name));
      assert.ok(files.has(name), `Unexpected memory read: ${path}`);
      return files.get(name);
    },
    realpath: async path => {
      paths.push(path); assert.ok(binaries.has(path), `Unexpected binary path: ${path}`);
      return `/memory/real/${path.split('/').at(-1)}`;
    },
    verifyPidAbsent: pid => {
      pidChecks.push(pid);
      assert.ok(Number.isInteger(pid) && pid > 0, 'Expected an actual positive PID');
      return !livePids.includes(pid);
    },
    sha256: bytes => {hashes.push(bytes); return digest(bytes);},
  });
  return {
    reads, pidChecks, paths, hashes,
    observe: (observation, options = {}) => fn(receiptPath, serverPid, job, generation,
      options.requireComplete ?? true,
      Object.hasOwn(options, 'expectedSegments') ? options.expectedSegments : 2, observation),
  };
}

test('actual media observer fails partial observer/spawn errors before waiting for seven children', async () => {
  for (const changes of [
    {observer_error: true},
    {spawn_error: true, spawn_observed: false, child_pid: null},
  ]) {
    const record = {...receipt(0), ...changes, close_observed: false, exit_code: null,
      observer_error_phase: 'open_child_executable', observer_error_type: 'FileNotFoundError',
      observer_error_errno: 2};
    const f = memory([record]), observation = {};
    await assert.rejects(f.observe(observation), /Real media child (observation|spawn) failed/);
    assert.equal(observation.count, 1);
    assert.equal(observation.expected_count, 7);
    assert.equal(observation.wait_reason, 'terminal_observer_error');
    assert.deepEqual(plain(observation.tools), {ffmpeg: 1, ffprobe: 0});
    assert.equal(observation.receipts[0].observer_error_phase, 'open_child_executable');
    assert.equal(observation.receipts[0].observer_error_type, 'FileNotFoundError');
    assert.equal(observation.receipts[0].observer_error_errno, 2);
    assert.deepEqual(f.pidChecks, []);
    assert.deepEqual(f.paths, []);
  }
});

test('actual media observer fails one closed nonzero or signalled child before count/kind checks', async () => {
  for (const [changes, message] of [
    [{exit_code: 1}, /Real media child failed/],
    [{exit_code: null, signal: 15}, /Real media child failed/],
    [{signal: 15}, /Real media child was signalled/],
    [{received_signals: [15]}, /Expected natural media-tool completion/],
  ]) {
    const f = memory([{...receipt(0), ...changes}]), observation = {};
    await assert.rejects(f.observe(observation), message);
    assert.equal(observation.count, 1);
    assert.equal(observation.expected_count, 7);
    assert.equal(observation.wait_reason, 'terminal_child_failure');
    assert.equal(observation.receipts.length, 1);
    assert.deepEqual(f.pidChecks, []);
  }
});

test('healthy empty, single-kind and short batches remain pending with partial evidence', async () => {
  for (const [records, reason] of [
    [[], 'missing_tool_kind'],
    [[receipt(0)], 'missing_tool_kind'],
    [[receipt(1)], 'missing_tool_kind'],
    [complete().slice(0, 2), 'missing_children'],
    [complete().slice(0, 6), 'missing_children'],
  ]) {
    const f = memory(records), observation = {};
    assert.equal(await f.observe(observation), null);
    assert.equal(observation.wait_reason, reason);
    assert.equal(observation.count, records.length);
    assert.equal(observation.expected_count, 7);
    assert.equal(observation.receipts.length, records.length);
    assert.deepEqual(plain(observation.tools), {
      ffmpeg: records.filter(r => r.tool === 'ffmpeg').length,
      ffprobe: records.filter(r => r.tool === 'ffprobe').length,
    });
    assert.deepEqual(f.pidChecks, []);
    assert.deepEqual(f.paths, []);
  }
});

test('two segments pass only with seven strictly proved, closed and absent real tools', async () => {
  const records = complete().reverse(), f = memory(records), observation = {};
  const result = await f.observe(observation);
  assert.equal(result.length, 7);
  assert.deepEqual(Array.from(result, r => r.invocation), complete().map(r => r.invocation));
  assert.ok(result.every(r => r.coordinator_child_pid_absent === true && r.coordinator_wrapper_pid_absent === true));
  assert.equal(observation.wait_reason, 'complete');
  assert.equal(observation.count, 7);
  assert.equal(observation.expected_count, 7);
  assert.deepEqual(plain(observation.tools), {ffmpeg: 1, ffprobe: 6});
  assert.match(observation.observed_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(f.paths.length, 7);
  assert.equal(f.hashes.length, 7);
  for (const record of records) {
    assert.equal(f.pidChecks.filter(pid => pid === record.child_pid).length, 1);
    assert.equal(f.pidChecks.filter(pid => pid === record.wrapper_pid).length, 2);
  }
  assert.equal(f.reads.filter(path => path.endsWith('.tmp')).length, 0);
  assert.equal((await memory(complete()).observe()).length, 7, 'Observation argument stays optional');
});

test('surplus children and wrong tool distributions fail instead of crediting completion', async () => {
  for (const records of [
    [...complete(), receipt(7)],
    complete().map((r, index) => index === 1 ? {...r, tool: 'ffmpeg'} : r),
    complete().map((r, index) => index === 1 ? {...r, tool: 'unexpected-tool'} : r),
  ]) {
    const f = memory(records), observation = {};
    await assert.rejects(f.observe(observation), {code: 'ERR_ASSERTION'});
    assert.equal(observation.count, records.length);
    assert.notEqual(observation.wait_reason, 'complete');
    assert.deepEqual(f.pidChecks, []);
  }
});

test('complete batches still wait for child close and live wrappers', async () => {
  const records = complete();
  records[1].close_observed = false;
  records[1].exit_code = null;
  const closing = memory(records), closeObservation = {};
  assert.equal(await closing.observe(closeObservation), null);
  assert.equal(closeObservation.wait_reason, 'child_close_pending');
  assert.equal(closeObservation.count, 7);
  assert.deepEqual(closing.pidChecks, []);

  const live = memory(complete(), {livePids: [receipt(1).wrapper_pid]}), wrapperObservation = {};
  assert.equal(await live.observe(wrapperObservation), null);
  assert.equal(wrapperObservation.wait_reason, 'wrapper_close_pending');
  assert.equal(wrapperObservation.count, 7);
  assert.ok(live.pidChecks.includes(receipt(1).wrapper_pid));
  assert.deepEqual(live.paths, []);
});

test('parent, start ticks, executable identity, spawn and PID proof failures never pass', async () => {
  for (const [label, changes, options] of [
    ['wrong child parent', {child_parent_pid: serverPid}],
    ['missing child parent', {child_parent_pid: null}],
    ['nonnumeric start ticks', {child_start_ticks: 'not-ticks'}],
    ['missing start ticks', {child_start_ticks: null}],
    ['nonstring start ticks', {child_start_ticks: 123}],
    ['wrong binary path', {child_executable: '/memory/impostor/ffprobe'}],
    ['missing binary path', {child_executable: null}],
    ['wrong binary hash', {child_executable_sha256: '0'.repeat(64)}],
    ['missing binary hash', {child_executable_sha256: null}],
    ['missing observed spawn', {spawn_observed: false}],
    ['nonboolean observed spawn', {spawn_observed: 1}],
    ['missing spawn-error proof', {spawn_error: null}],
    ['missing observer-error proof', {observer_error: null}],
    ['wrapper sees live child', {pid_absent: false}],
    ['missing wrapper PID proof', {pid_absent: null}],
    ['nonboolean wrapper PID proof', {pid_absent: 1}],
    ['invalid actual child PID', {child_pid: null}],
    ['independently live actual child', {}, {livePids: [receipt(1).child_pid]}],
  ]) {
    const records = complete(); Object.assign(records[1], changes);
    const observation = {};
    await assert.rejects(memory(records, options).observe(observation), {code: 'ERR_ASSERTION'}, label);
    assert.equal(observation.count, 7, label);
    assert.notEqual(observation.wait_reason, 'complete', label);
  }
});

test('closed exit, signal and received-signal fields require natural successful completion', async () => {
  for (const changes of [
    {exit_code: 2}, {exit_code: null}, {exit_code: '0'},
    {signal: 9}, {signal: false},
    {received_signals: [2]}, {received_signals: 'unexpected'}, {received_signals: {}},
  ]) {
    const records = complete(); Object.assign(records[1], changes);
    const observation = {};
    await assert.rejects(memory(records).observe(observation), {code: 'ERR_ASSERTION'});
    assert.equal(observation.count, 7);
    assert.notEqual(observation.wait_reason, 'complete');
  }
});

test('actual manifest count is required and never replaced by the observed receipt count', async () => {
  for (const expectedSegments of [undefined, null, 0, -1, 1.5, '2']) {
    const observation = {};
    await assert.rejects(memory(complete()).observe(observation, {expectedSegments}), /Actual manifest segment count required/);
    assert.notEqual(observation.wait_reason, 'complete');
  }
  const observation = {};
  assert.equal(await memory(complete()).observe(observation, {expectedSegments: 3}), null);
  assert.equal(observation.expected_count, 9);
  assert.equal(observation.wait_reason, 'missing_children');
});

test('receipt selection remains scoped to the server, job and output generation', async () => {
  const unrelated = [
    {...receipt(10), parent_pid: serverPid + 1},
    {...receipt(11), output_bindings: [{job_id: 'other-job', output_generation: generation}]},
    {...receipt(12), output_bindings: [{job_id: job, output_generation: 'other-generation'}]},
  ].map(r => ({...r, observer_error: true, spawn_error: true}));
  const observation = {};
  const result = await memory([...complete(), ...unrelated]).observe(observation);
  assert.equal(result.length, 7);
  assert.equal(observation.count, 7);
  assert.equal(observation.wait_reason, 'complete');
});

test('diagnostics retain only allowlisted proof fields, never arbitrary secret-bearing content', async () => {
  const record = {...receipt(0), observer_error: true,
    observer_error_phase: 'read_child_stat', observer_error_type: 'ProcessLookupError', observer_error_errno: 3,
    SECRET_unknown: 'SECRET-value', error_message: 'SECRET-error', traceback: 'SECRET-stack',
    argv: ['SECRET-argv'], stdout: 'SECRET-stdout', stderr: 'SECRET-stderr',
    diagnostic: {payload: 'SECRET-nested'}, output_path: '/SECRET-path',
  };
  record.output_bindings[0].extra = 'SECRET-binding-extra';
  const observation = {};
  await assert.rejects(memory([record]).observe(observation), /Real media child observation failed/);
  assert.deepEqual(Object.keys(observation.receipts[0]).sort(), [
    'invocation', 'tool', 'wrapper_pid', 'parent_pid', 'child_pid',
    'spawn_observed', 'close_observed', 'exit_code', 'signal', 'pid_absent',
    'spawn_error', 'observer_error', 'observer_error_phase', 'observer_error_type',
    'observer_error_errno', 'child_executable', 'child_executable_sha256',
    'child_parent_pid', 'child_start_ticks', 'received_signals',
  ].sort());
  assert.equal(observation.receipts[0].observer_error_phase, 'read_child_stat');
  assert.equal(observation.receipts[0].observer_error_type, 'ProcessLookupError');
  assert.equal(observation.receipts[0].observer_error_errno, 3);
  assert.doesNotMatch(JSON.stringify(observation), /SECRET/);
});

test('inspection-only mode preserves unvalidated records without probing process or binary state', async () => {
  const f = memory([{...receipt(0), observer_error: true}]), observation = {};
  const result = await f.observe(observation, {requireComplete: false, expectedSegments: undefined});
  assert.equal(result.length, 1);
  assert.equal(result[0].observer_error, true);
  assert.equal(observation.count, 1);
  assert.equal(observation.expected_count, null);
  assert.deepEqual(f.pidChecks, []);
  assert.deepEqual(f.paths, []);
  assert.deepEqual(f.hashes, []);
});
