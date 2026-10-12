// Real frozen NAS daemon + controlled WS peers; no Server authority/PG claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { reapOwnedChildren, withTerminationSignal } from '../deploy/owned-process.mjs';
import { verifyPidAbsent, verifyClosedPort } from './fixtures/postgres.mjs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { loadOwnerBinding } from '../scripts/native-owner-binding.mjs';
async function closeDeadline(operation, phase) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`owned_listener_timeout:${phase}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = b => createHash('sha256').update(b).digest('hex');
const coordinator = hash(await readFile(fileURLToPath(import.meta.url)));
assert.equal(process.platform, 'linux', 'This fd-observing fixture requires Linux');
assert.equal(process.env.DATABASE_URL, undefined, 'Reject caller database');
assert.ok(process.env.W03_BACKEND_BINDING, 'Frozen producer binding required');
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, 'Owned runtime artifact directory required');
const bound = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING });
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
const binary = binding.binaries.find(b => b.name === 'rainsync-nas-agent');
assert.equal(binary?.path, resolve(process.env.CARGO_TARGET_DIR, 'debug', 'rainsync-nas-agent'));
assert.ok(isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR));
const inputs = await Promise.all(['tests/nas-transfer-admission-native.mjs', 'deploy/owned-process.mjs',
  'tests/fixtures/postgres.mjs', 'tests/fixtures/unused-port.mjs', 'scripts/native-owner-binding.mjs']
  .map(async path => ({ path, sha256: hash(await readFile(resolve(repo, path))) })));
async function verifyBinding() {
  await bound.verify();
  for (const i of inputs) assert.equal(hash(await readFile(resolve(repo, i.path))), i.sha256, i.path);
}
await verifyBinding();
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `nas-admission-native-${randomUUID()}`);
await mkdir(root, { mode: 0o700 });
const media = resolve(root, 'media'); await mkdir(media);
const source = resolve(media, 'owned.bin');
const file = await open(source, 'wx', 0o600);
try { await file.truncate(1024 * 1024 * 1024); } finally { await file.close(); }
const credentials = resolve(root, 'credentials');
const journal = `${credentials}.drained.json`;
const timing = {};
const checks = [], peers = new Set(), held = new Map(), rows = new Map();
let control, child, closed, childResult, failure, serverClosed = false, port;
const failures = [];
let eventFailure;
function record(error, phase) {
  failure = true;
  failures.push({ phase, original: error?.stack ?? String(error) });
}
function eventError(error) { eventFailure ??= error; record(error, 'peer_event'); }
const logPath = resolve(root, 'nas.private.log');
let log, wss, server;
let logFailed = false, logFinished = false, logClosed = false;
function setup() {
log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
 log.on('finish', () => { logFinished = true; });
log.on('close', () => { logClosed = true; });
log.on('error', error => { logFailed = true; eventError(error); });
wss = new WebSocketServer({ noServer: true });
wss.on('error', eventError);
server = createServer((_, res) => { res.writeHead(404); res.end(); });
server.on('error', eventError);
server.on('upgrade', (req, socket, head) => {
  try {
  socket.on('error', () => {});
  const id = req.url.split('/').at(-1);
  if (req.url.startsWith('/data/')) {
    if (!rows.has(id)) { failure = true; socket.destroy(); return; }
    rows.get(id).upgrades++;
    if (rows.get(id).hold) { held.set(id, { req, socket, head }); return; }
  }
  accept(req, socket, head);
  } catch (error) { eventError(error); socket.destroy(); }
});
}
function accept(req, socket, head) {
  wss.handleUpgrade(req, socket, head, peer => {
    peers.add(peer); peer.on('error', eventError); peer.on('close', () => peers.delete(peer));
    if (req.url === '/api/v1/agents/ws') {
      peer.on('message', bytes => {
        try {
        const v = JSON.parse(bytes);
        if (v.type === 'HELLO') control = peer;
        if (v.type === 'INDEX') peer.send(JSON.stringify({ type: 'INDEX_ACK', sequence: v.sequence, snapshot: v.snapshot }));
        // Deliberately withhold drain ACK so the real journal remains observable.
        } catch (error) { eventError(error); }
      });
    } else {
      const row = rows.get(req.url.split('/').at(-1));
      peer.on('message', (bytes, binary) => {
        try {
        if (binary) { row.bytes += bytes.length; return; }
        row.status = JSON.parse(bytes).status;
        if (row.status === 200 && !row.head) peer._socket.pause();
        } catch (error) { eventError(error); }
      });
    }
  });
}
let origin;
async function until(check, label, ms = 15000, signal) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    if (eventFailure !== undefined) throw eventFailure;
    assert.equal(logFailed, false, 'Private log write must succeed');
    if (await check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw Error(`fixture_timeout:${label}`);
}
async function ids() { try { return JSON.parse(await readFile(journal, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
async function fds() {
  let count = 0;
  for (const fd of await readdir(`/proc/${child.pid}/fd`)) {
    try { if (await readlink(`/proc/${child.pid}/fd/${fd}`) === source) count++; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return count;
}
function dispatch({ hold = false, head = false, bad = false } = {}) {
  const id = randomUUID(); rows.set(id, { dispatched_ms: performance.now(), upgrades: 0, status: null, bytes: 0, hold, head });
  control.send(JSON.stringify({ type: 'TRANSFER', id, request: {
    drain_receipt_required: true, data_url: bad ? ':malformed' : `${origin.replace('http:', 'ws:')}/data/${id}`,
    resource: 'owned.bin', head,
  }})); return id;
}
try {
  setup();
  await closeDeadline(new Promise((r, reject) => server.once('error', reject).listen(0, '127.0.0.1', r)), 'listen');
  port = server.address().port; origin = `http://127.0.0.1:${port}`;
  await withTerminationSignal(async signal => {
    child = spawn(binary.path, [], { env: { ...process.env, AGENT_TOKEN: 'synthetic-owned-peer', SERVER_URL: origin,
      AGENT_DATA_ORIGIN: origin, MEDIA_ROOT: media, AGENT_CREDENTIAL_FILE: credentials }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on('error', eventError);
    closed = new Promise(r => child.once('close', (code, signal) => { childResult = { pid: child.pid, exit_code: code, signal, observed_close: true }; r(); }));
    await until(() => control, 'control HELLO', 15000, signal);
    const normals = [];
    for (let n = 0; n < 16; n++) {
      const id = dispatch(); normals.push(id);
      await until(() => rows.get(id).status === 200, `normal${n}`, 15000, signal);
    }
    assert.equal(await fds(), 16, 'Sixteen actual open source owners');
    assert.deepEqual(await ids(), [], 'Active owners have no receipt');
    checks.push('16 real source transfers hold normal permits and file descriptors');
    const rejects = Array.from({ length: 4 }, () => dispatch({ hold: true }));
    await until(() => rejects.every(id => held.has(id)), 'four pending data handshakes', 5000, signal);
    const earliestHoldDispatch = Math.min(...rejects.map(id => rows.get(id).dispatched_ms));
    const earliestNormalDispatch = Math.min(...normals.map(id => rows.get(id).dispatched_ms));
    const excess = dispatch();
    await until(async () => (await ids()).includes(excess), '21st journal', 3000, signal);
    const observedJournal = await ids();
    const overflowObserved = performance.now();
    Object.assign(timing, { earliest_hold_dispatch_ms: earliestHoldDispatch, earliest_normal_dispatch_ms: earliestNormalDispatch, overflow_observed_ms: overflowObserved });
    assert.ok(overflowObserved - earliestHoldDispatch < 10000, '21st observed before original earliest connect deadline');
    assert.ok(overflowObserved - earliestNormalDispatch < 30000, 'Original source write deadline not elapsed');
    assert.ok(rejects.every(id => !held.get(id).socket.destroyed && held.get(id).socket.writable), 'All four held sockets still live');
    assert.ok(normals.every(id => !(observedJournal.includes(id))), 'No active normal receipt');
    assert.equal(rows.get(excess).upgrades, 0, '21st dispatch opens no data connection');
    assert.equal(await fds(), 16);
    checks.push('16 normal + 4 pending rejection permits reject 21st with journal and zero data open');
    assert.equal(await fds(), 16);
    timing.release_ms = performance.now();
    assert.ok(timing.release_ms - earliestHoldDispatch < 10000, 'Release precedes original earliest connect deadline');
    for (const id of rejects) { const h = held.get(id); held.delete(id); accept(h.req, h.socket, h.head); }
    await until(() => rejects.every(id => rows.get(id).status === 503), 'four busy replies', 5000, signal);
    await until(async () => { const all = await ids(); return rejects.every(id => all.includes(id)); }, 'busy joined receipts', 15000, signal);
    const busyJournal = await ids();
    assert.ok(performance.now() - earliestNormalDispatch < 30000, 'Busy verification before original write deadline');
    assert.ok(normals.every(id => !busyJournal.includes(id)), 'Normal owners still unreceipted');
    assert.equal(await fds(), 16, 'Busy rejection work never opens a source');
    for (const id of rejects) { assert.equal(rows.get(id).bytes, 0); assert.equal(rows.get(id).upgrades, 1); }
    checks.push('Four rejection owners produce 503, zero body, join and durable receipts');
    const malformed = dispatch({ bad: true });
    await until(async () => (await ids()).includes(malformed), 'malformed journal', 3000, signal);
    assert.equal(rows.get(malformed).upgrades, 0);
    assert.equal(await fds(), 16);
    const preCancelJournal = await ids();
    assert.ok(normals.every(id => !preCancelJournal.includes(id)));
    assert.ok(performance.now() - earliestNormalDispatch < 30000, 'Control cancellation occurs before original write deadline');
    checks.push('Malformed data URL records no-resource receipt without a connection');
    timing.control_cancel_ms = performance.now();
    control.terminate(); control = null;
    await until(async () => (await fds()) === 0, 'control loss releases source files', 15000, signal);
    await until(async () => { const all = await ids(); return normals.every(id => all.includes(id)); }, 'normal owners joined and journaled', 15000, signal);
    checks.push('Control loss cancels and joins all sixteen file owners before durable receipts');
    await until(() => control, 'fresh control reconnect', 15000, signal);
    const fresh = dispatch({ head: true });
    await until(() => rows.get(fresh).status === 200, 'fresh normal permit', 15000, signal);
    await until(async () => (await ids()).includes(fresh), 'fresh joined receipt', 15000, signal);
    assert.equal(await fds(), 0);
    assert.equal(rows.get(fresh).bytes, 0);
    checks.push('Reconnect admits fresh HEAD using released normal capacity');
    assert.deepEqual((await ids()).sort(), [...normals, ...rejects, excess, malformed, fresh].sort());
  });
 } catch (error) { record(error, 'run'); }
finally {
  try { if (child && closed) await reapOwnedChildren([{ child, closed }]); }
  catch (error) { record(error, 'reap'); }
  try {
    assert.equal(childResult?.exit_code, 0); assert.equal(childResult?.signal, null);
    assert.equal(await verifyPidAbsent(child.pid), true);
  } catch (error) { record(error, 'pid_exit'); }
  for (const { socket } of held.values()) { try { socket.destroy(); } catch (error) { record(error, 'held_socket'); } }
  for (const peer of peers) { try { peer.terminate(); } catch (error) { record(error, 'peer_close'); } }
  try { if (wss) await closeDeadline(new Promise((r, reject) => wss.close(error => error ? reject(error) : r())), 'ws_close'); }
  catch (error) { record(error, 'ws_listener_close'); }
  try { if (server?.listening) await closeDeadline(new Promise((r, reject) => server.close(error => error ? reject(error) : r())), 'http_close'); serverClosed = true; }
  catch (error) { record(error, 'http_listener_close'); }
  try { if (port) assert.equal(await verifyClosedPort(port), true); else throw Error('listener_never_started'); }
  catch (error) { record(error, 'port_absence'); }
  try { await verifyBinding(); } catch (error) { record(error, 'final_binding'); }
  try { if (log) await closeDeadline(new Promise((r, reject) => { if (logFailed) return reject(Error('private_log_failed')); if (logClosed) return logFinished ? r() : reject(Error('private_log_unfinished')); log.once('error', reject); log.once('close', () => logFinished ? r() : reject(Error('private_log_unfinished'))); log.end(); }), 'log_close'); }
  catch (error) { logFailed = true; record(error, 'log_close'); }
  try { await writeFile(resolve(root, 'observations.private.json'), JSON.stringify({ timing, journal: await ids(), dispatched: [...rows.entries()] }, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { record(error, 'observations_write'); }
  let logSha;
  try { logSha = hash(await readFile(logPath)); } catch (error) { record(error, 'log_hash'); }
  try { await writeFile(resolve(root, 'failure.private.log'), failures.map(f => `${f.phase}\n${f.original}\n`).join('\n'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { record(error, 'failure_log_write'); }
  try { await writeFile(resolve(root, 'evidence.json'), JSON.stringify({ schema_version: 1,
    kind: 'nas-transfer-admission-native', result: failure ? 'failed' : 'passed',
    scope: 'Actual NAS daemon admission and owned source I/O with synthetic peers; no Server authority/PG/all-descendants claim',
    checks, failures: failures.map(f => f.phase), child: childResult, listener: { port, closed: serverClosed },
    inputs, binding: bound.summary, binary_sha256: binary.sha256,
    private_log_sha256: logSha, log_complete: logFinished && logClosed && !logFailed,
    logs: 'uncapped private file; not for CI upload',
  }, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { record(error, 'summary_write');
    try { await writeFile(resolve(root, 'summary-failure.private.log'), error?.stack ?? String(error), { flag: 'wx', mode: 0o600 }); } catch {} }
}
if (failure) throw Error('nas_admission_fixture_failed; inspect private fixture evidence');
console.log(`PASS: ${checks.join('; ')}`);

}
try { await main(); }
catch (error) {
  // Startup/load-binding failures also leave private raw failure and fixed report.
  const fallback = resolve(process.env.RAINSYNC_ARTIFACT_DIR || tmpdir(), `nas-admission-failure-${randomUUID()}`);
  await mkdir(fallback, { recursive: true, mode: 0o700 });
  try { await writeFile(resolve(fallback, 'failure.private.log'), error?.stack ?? String(error), { flag: 'wx', mode: 0o600 }); }
  finally { await writeFile(resolve(fallback, 'evidence.json'), JSON.stringify({ schema_version: 1, kind: 'nas-transfer-admission-native', result: 'failed', failure: 'startup_or_fixture_failed', log_complete: false }) + '\n', { mode: 0o600 }); }
  throw Error('nas_admission_fixture_failed; inspect private fixture evidence');
}
