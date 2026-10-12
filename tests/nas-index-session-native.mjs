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
assert.ok(process.env.AGENT_INDEX_INTERVAL_SECS === undefined || process.env.AGENT_INDEX_INTERVAL_SECS === '60', 'Reject non-default inherited scan interval');
assert.ok(process.env.W03_BACKEND_BINDING, 'Frozen producer binding required');
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, 'Owned runtime artifact directory required');
const bound = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING });
const binding = JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
const binary = binding.binaries.find(b => b.name === 'rainsync-nas-agent');
assert.equal(binary?.path, resolve(process.env.CARGO_TARGET_DIR, 'debug', 'rainsync-nas-agent'));
assert.ok(isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR));
const inputs = await Promise.all(['tests/nas-index-session-native.mjs', 'deploy/owned-process.mjs',
  'tests/fixtures/postgres.mjs', 'tests/fixtures/unused-port.mjs', 'scripts/native-owner-binding.mjs']
  .map(async path => ({ path, sha256: hash(await readFile(resolve(repo, path))) })));
async function verifyBinding() {
  await bound.verify();
  for (const i of inputs) assert.equal(hash(await readFile(resolve(repo, i.path))), i.sha256, i.path);
}
await verifyBinding();
const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, `nas-index-native-${randomUUID()}`);
await mkdir(root, { mode: 0o700 });
const media = resolve(root, 'media'); await mkdir(media);
const source = resolve(media, 'owned.bin');
for (let n = 0; n < 129; n++) await writeFile(resolve(media, `owned-${n}.mp4`), 'owned index fixture', { flag: 'wx', mode: 0o600 });
const credentials = resolve(root, 'credentials');
const journal = `${credentials}.drained.json`;
const timing = {};
const pages = [], busy = [], controlCloses = [];
let connections = 0;
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
      let connection;
      peer.on('close', () => { controlCloses.push(connection); if (control === peer) control = null; });
      peer.on('message', bytes => {
        try {
        const v = JSON.parse(bytes);
        if (v.type === 'HELLO') { control = peer; connection = ++connections; }
        if (v.type === 'INDEX') pages.push({ connection, ...v });
        if (v.type === 'SCAN_BUSY') busy.push({ connection, ...v });
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
try {
  setup();
  await closeDeadline(new Promise((r, reject) => server.once('error', reject).listen(0, '127.0.0.1', r)), 'listen');
  port = server.address().port; origin = `http://127.0.0.1:${port}`;
  await withTerminationSignal(async signal => {
    child = spawn(binary.path, [], { env: { ...process.env, AGENT_TOKEN: 'synthetic-owned-peer', SERVER_URL: origin,
      AGENT_INDEX_INTERVAL_SECS: '60', AGENT_DATA_ORIGIN: origin, MEDIA_ROOT: media, AGENT_CREDENTIAL_FILE: credentials }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on('error', eventError);
    closed = new Promise(r => child.once('close', (code, signal) => { childResult = { pid: child.pid, exit_code: code, signal, observed_close: true }; r(); }));
    await until(() => control, 'control HELLO', 15000, signal);
    assert.equal(hash(await readFile(`/proc/${child.pid}/exe`)),binary.sha256,'actual running NAS exe matches binding');
    await until(() => pages.length === 1, 'first page', 15000, signal);
    const first = pages[0];
    assert.equal(first.sequence, 0); assert.equal(first.final, false); assert.equal(first.items.length, 128);
    const originalPeer = control;
    control.send(JSON.stringify({ type: 'SCAN', snapshot: 'busy-owned' }));
    await until(() => busy.length === 1, 'SCAN_BUSY', 15000, signal);
    assert.equal(busy[0].snapshot, 'busy-owned'); assert.equal(busy[0].connection, first.connection);
    assert.equal(pages.length, 1, 'Awaiting ACK forbids second page send');
    checks.push('Outstanding first page keeps same connection scan busy and next page unsent');
    const ack = page => control.send(JSON.stringify({ type: 'INDEX_ACK', snapshot: page.snapshot, sequence: page.sequence }));
    ack(first);
    await until(() => pages.length === 2, 'second page', 15000, signal);
    const final = pages[1];
    assert.equal(final.connection, first.connection); assert.equal(final.snapshot, first.snapshot);
    assert.equal(final.sequence, 1); assert.equal(final.final, true); assert.equal(final.items.length, 1);
    const resources = [...first.items, ...final.items].map(i => i.resource);
    assert.equal(new Set(resources).size, 129);
    assert.deepEqual(resources.sort(), Array.from({ length: 129 }, (_, n) => `owned-${n}.mp4`).sort());
    checks.push('Exact same-socket snapshot ACK advances 128+1 unique indexed files');
    // Keep the actual final page awaiting ACK, avoiding any assumption about
    // blocking scan permit release before a new SCAN command.
    const wrong = final;
    control.send(JSON.stringify({ type: 'INDEX_ACK', snapshot: wrong.snapshot, sequence: 0 }));
    await until(() => controlCloses.includes(first.connection), 'wrong ACK closes original connection', 15000, signal);
    await until(() => control && control !== originalPeer && pages.length === 3, 'fresh reconnect page', 15000, signal);
    const fresh = pages[2];
    assert.notEqual(fresh.connection, first.connection); assert.notEqual(fresh.snapshot, wrong.snapshot);
    assert.equal(fresh.sequence, 0); assert.equal(fresh.final, false);
    ack(fresh);
    await until(() => pages.length === 4, 'reconnect final page', 15000, signal);
    assert.equal(pages[3].connection, fresh.connection); assert.equal(pages[3].snapshot, fresh.snapshot);
    assert.equal(pages[3].sequence, 1); assert.equal(pages[3].final, true);
    assert.equal(fresh.items.length,128);assert.equal(pages[3].items.length,1);
    assert.deepEqual([...fresh.items,...pages[3].items].map(item=>item.resource).sort(),resources);
    for(const page of [first,final,fresh,pages[3]])for(const item of page.items){assert.equal(item.available,true);assert.match(item.source_version,/^stat-v1:[0-9a-f]{64}$/);}
    ack(pages[3]);
    assert.equal(hash(await readFile(`/proc/${child.pid}/exe`)),binary.sha256,'running NAS exe remains bound');
    assert.equal(rows.size, 0, 'Index-only fixture opens no data connection');
    checks.push('Wrong sequence ACK ends actual connection and reconnect starts a fresh complete snapshot');

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
  try { await writeFile(resolve(root, 'observations.private.json'), JSON.stringify({ pages, busy, controlCloses, journal: await ids() }, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { record(error, 'observations_write'); }
  let logSha;
  try { logSha = hash(await readFile(logPath)); } catch (error) { record(error, 'log_hash'); }
  try { await writeFile(resolve(root, 'failure.private.log'), failures.map(f => `${f.phase}\n${f.original}\n`).join('\n'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { record(error, 'failure_log_write'); }
  try { await writeFile(resolve(root, 'evidence.json'), JSON.stringify({ schema_version: 1,
    kind: 'nas-index-session-native', result: failure ? 'failed' : 'passed',
    scope: 'Actual NAS daemon multi-page INDEX/ACK/SCAN lifecycle with synthetic peer; no Server indexing authority/PG/all-descendants claim',
    checks, failures: failures.map(f => f.phase), child: childResult, listener: { port, closed: serverClosed },
    index_interval_seconds: 60, inputs, binding: bound.summary, binary_sha256: binary.sha256,
    private_log_sha256: logSha, log_complete: logFinished && logClosed && !logFailed,
    logs: 'uncapped private file; not for CI upload',
  }, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { record(error, 'summary_write');
    try { await writeFile(resolve(root, 'summary-failure.private.log'), error?.stack ?? String(error), { flag: 'wx', mode: 0o600 }); } catch {} }
}
if (failure) throw Error('nas_index_fixture_failed; inspect private fixture evidence');
console.log(`PASS: ${checks.join('; ')}`);

}
try { await main(); }
catch (error) {
  // Startup/load-binding failures also leave private raw failure and fixed report.
  const fallback = resolve(process.env.RAINSYNC_ARTIFACT_DIR || tmpdir(), `nas-index-failure-${randomUUID()}`);
  await mkdir(fallback, { recursive: true, mode: 0o700 });
  try { await writeFile(resolve(fallback, 'failure.private.log'), error?.stack ?? String(error), { flag: 'wx', mode: 0o600 }); }
  finally { await writeFile(resolve(fallback, 'evidence.json'), JSON.stringify({ schema_version: 1, kind: 'nas-index-session-native', result: 'failed', failure: 'startup_or_fixture_failed', log_complete: false }) + '\n', { mode: 0o600 }); }
  throw Error('nas_index_fixture_failed; inspect private fixture evidence');
}
