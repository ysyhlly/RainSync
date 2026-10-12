// Real test-only compute qualification, HTTP detach, ACK retry and shutdown observations.
// Frozen external proposal v3; install as the reviewed repository test, never business logic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, copyFile, chmod, readlink, realpath } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const proposal = dirname(fileURLToPath(import.meta.url));
const root = process.env.RAINSYNC_REPO_ROOT ?? process.cwd();
assert.ok(isAbsolute(root), 'Selected repo path must be absolute');
await readFile(resolve(root,'Cargo.toml'));
await readFile(resolve(root,'scripts/native-owner-binding.mjs'));
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { isolatedMediaStack } = await load('tests/fixtures/media-stack.mjs');
const { delay } = await load('tests/fixtures/server.mjs');
const { verifyPidAbsent, verifyClosedPort } = await load('tests/fixtures/postgres.mjs');
const { reapOwnedChildren, withTerminationSignal } = await load('deploy/owned-process.mjs');
const { backendSnapshot, loadOwnerBinding, sha256 } = await load('scripts/native-owner-binding.mjs');
assert.equal(process.platform, 'linux', 'This draft observes real Linux /usr/bin media tools');
assert.ok(isAbsolute(process.env.RAINSYNC_ARTIFACT_DIR ?? ''));
const directory = resolve(process.env.RAINSYNC_ARTIFACT_DIR, 'compute-finish-owner', randomUUID());
await mkdir(directory, { recursive: true });
const reportPath = resolve(directory, 'report.json');
const report = { schema_version: 1, gate: 'compute-finish-owner-native', result: 'running',
  started_at: new Date().toISOString(), checks: [], cases: [], cleanup: { completed: false },
  scope: 'Owned synthetic NAS source and real compute-node qualification; test-only Server PATH instrumentation, real PostgreSQL ACK faults. No production data, forged qualification, Registry count or process receipt inferred from SQL.' };
let fixture, failure, stage = 'prerequisites', binding, extraVerify;
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
await save();
const uuid = value => { assert.match(value, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/); return value; };
const jsonSql = (f, query) => JSON.parse(f.sql(query));
async function until(signal, check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(75);
  }
  throw Error(`bounded_observation_failed: ${label}`);
}
function observeChild(child) {
  const record = { pid: child.pid ?? null, started_at: new Date().toISOString(),
    close_observed: false, exit_code: null, signal: null, spawn_error: false, pid_absent: null };
  child.once('error', () => { record.spawn_error = true; });
  const closed = new Promise(done => child.once('close', (exit_code, signal) => {
    Object.assign(record, { close_observed: true, exit_code, signal, closed_at: new Date().toISOString() });
    done(record);
  }));
  return { child, closed, record };
}
// An owned HTTP server forwards every non-finish request unchanged, including renew.
// A finish is fully received from the real node and retained only in memory.
async function finishProxy(realOrigin, signal) {
  const held = new Map(), sockets = new Set(), outgoing = new Set();
  const server = createServer(async (incoming, response) => {
    try {
      const chunks = []; let length = 0;
      for await (const bytes of incoming) {
        length += bytes.length; assert.ok(length <= 8 * 1024 * 1024);
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      const path = incoming.url;
      const headers = { ...incoming.headers, host: new URL(realOrigin).host };
      const forward = () => new Promise((done, reject) => {
        const upstream = request(realOrigin + path, { method: incoming.method, headers, signal }, reply => {
          response.writeHead(reply.statusCode, reply.headers);
          reply.pipe(response);
          reply.once('end', () => done({ status: reply.statusCode }));
          reply.once('error', reject);
          reply.once('aborted', () => reject(Error('proxy_upstream_aborted')));
        });
        outgoing.add(upstream);
        upstream.once('close', () => outgoing.delete(upstream));
        upstream.once('error', reject);
        response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
        upstream.end(bytes);
      });
      const match = /^\/api\/v1\/agent-compute\/jobs\/([0-9a-f-]{36})\/finish$/.exec(path);
      if (match) {
        const id = uuid(match[1]);
        assert.ok(!held.has(id), 'Exactly one original node finish per job');
        const document = JSON.parse(bytes);
        held.set(id, { id, document, bytes, headers, path, incoming, response, forward,
          captured_at: new Date().toISOString(), sha256: sha256(bytes),
          disconnect: () => response.destroy() });
      } else await forward();
    } catch {
      // Network failures never fabricate a successful response or qualification.
      response.destroy();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const interrupt = () => { for (const socket of sockets) socket.destroy(); for (const pending of outgoing) pending.destroy(); };
  signal.addEventListener('abort', interrupt, {once:true});
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  return { held, port, origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const pending of held.values()) pending.disconnect();
      for (const pending of outgoing) pending.destroy();
      const socketClosures = [...sockets].map(socket => new Promise(done => {socket.once('close',done);socket.destroy();}));
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      await Promise.all(socketClosures);
      signal.removeEventListener('abort',interrupt);
      assert.equal(sockets.size, 0, 'Proxy sockets observed closed');
      assert.equal(await verifyClosedPort(port), true);
      return { close_observed: true, port, port_closed: true, remaining_sockets: sockets.size };
    } };
}
function manualFinish(realOrigin, captured) {
  const expected = new URL(realOrigin);
  const expectedPort = Number(expected.port || (expected.protocol==='https:' ? 443 : 80));
  const record = { body_sha256: captured.sha256, same_captured_bytes: true,
    socket_connected: false, socket_local_port: null, socket_remote_port: null,
    socket_local_address: null, socket_remote_address: null,
    expected_origin_peer: {origin:expected.origin,hostname:expected.hostname,port:expectedPort},
    reused_socket: null, connect_event_observed: false,
    socket_observations: [], socket_close_observed: false, socket_closed_at: null,
    response_observed: false, close_observed: false, disconnected_at: null };
  const req = request(realOrigin + captured.path, { method: 'POST', headers: captured.headers }, res => {
    record.response_observed = true; record.response_status = res.statusCode; res.resume();
  });
  let socketClosed;
  req.once('socket', socket => {
    const snapshot = source => ({source,observed_at:new Date().toISOString(),
      reused_socket:req.reusedSocket ?? null,connecting:socket.connecting,destroyed:socket.destroyed,
      ready_state:socket.readyState,local_address:socket.localAddress ?? null,
      local_port:socket.localPort ?? null,remote_address:socket.remoteAddress ?? null,
      remote_port:socket.remotePort ?? null,remote_family:socket.remoteFamily ?? null});
    record.reused_socket = req.reusedSocket ?? null;
    record.socket_observations.push(snapshot('socket_assignment'));
    socketClosed = new Promise(done => socket.once('close', hadError => {
      record.socket_close_observed=true;record.socket_closed_at=new Date().toISOString();
      record.socket_close_had_error=hadError;
      record.socket_close_state={connecting:socket.connecting,destroyed:socket.destroyed,ready_state:socket.readyState};
      done();
    }));
    const observeConnected = source => {
      const actual=snapshot(source);record.socket_observations.push(actual);
      const connected = actual.connecting===false && actual.destroyed===false && actual.ready_state==='open';
      const peerMatches = actual.remote_address===expected.hostname && actual.remote_port===expectedPort;
      const localObserved = actual.local_address==='127.0.0.1' && Number.isInteger(actual.local_port) && actual.local_port>0;
      Object.assign(record,{socket_connected:connected && peerMatches && localObserved,
        socket_peer_matches_origin:peerMatches,socket_connection_observation:source,
        socket_local_address:actual.local_address,socket_local_port:actual.local_port,
        socket_remote_address:actual.remote_address,socket_remote_port:actual.remote_port});
    };
    if(socket.connecting) socket.once('connect',()=>{
      record.connect_event_observed=true;observeConnected('connect_event');
    });
    else observeConnected('assigned_connected_socket');
  });
  req.on('error', () => { record.transport_error_observed = true; });
  const closed = new Promise(done => req.once('close', () => {
    record.close_observed = true; done();
  }));
  req.end(captured.bytes);
  return { record, async disconnect() {
    record.disconnected_at = new Date().toISOString(); req.destroy(); await closed;
    assert.ok(socketClosed,'Actual assigned socket close observer required');
    await socketClosed;
    assert.equal(record.close_observed,true);assert.equal(record.socket_close_observed,true);
  } };
}
async function finishRequest(f, captured, document, signal, expectedStatus, expectedCode) {
  const body = document === captured.document ? captured.bytes : Buffer.from(JSON.stringify(document));
  const response = await fetch(f.origin + captured.path, {method:'POST',
    headers:{Authorization:captured.headers.authorization,'Content-Type':'application/json'},body,
    signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  const value = await response.json();
  assert.equal(response.status,expectedStatus);
  if(expectedCode) assert.equal(value?.error?.code,expectedCode);
  else {assert.equal(value.ok,true);assert.equal(value.primary_qualified,true);
    assert.equal(value.output_generation,captured.document.output_generation);}
  return {body_sha256:sha256(body),status:response.status,code:expectedCode??null,
    output_generation:expectedCode?null:value.output_generation,observed_at:new Date().toISOString()};
}
function verificationState(f,id) {
  return jsonSql(f,`SELECT row_to_json(a) FROM (SELECT job_id,attempt,output_generation,
    server_verification_id,server_verification_owner_epoch,server_verification_started_at,
    server_verification_reaped_at FROM distributed_compute_attempts WHERE job_id='${id}') a`);
}
function assertNotStarted(value) {
  assert.equal(value.server_verification_id,null);assert.equal(value.server_verification_owner_epoch,null);
  assert.equal(value.server_verification_started_at,null);assert.equal(value.server_verification_reaped_at,null);
}
async function mediaReceipts(path, serverPid, job, generation, requireComplete = true, expectedSegments) {
  const records = [];
  for (const name of await readdir(path)) if (name.endsWith('.json')) {
    const value = JSON.parse(await readFile(resolve(path, name), 'utf8'));
    if (value.parent_pid === serverPid && value.output_bindings.some(b => b.job_id === job && b.output_generation === generation))
      records.push(value);
  }
  if (!requireComplete) return records;
  if (!records.some(r => r.tool === 'ffmpeg') || !records.some(r => r.tool === 'ffprobe')) return null;
  assert.ok(Number.isInteger(expectedSegments) && expectedSegments>0,'Actual manifest segment count required');
  const expectedTotal=3+2*expectedSegments;
  if(records.length<expectedTotal) return null;
  assert.equal(records.length,expectedTotal,'Exactly every required check_output child observed');
  assert.equal(records.filter(r=>r.tool==='ffmpeg').length,1);
  assert.equal(records.filter(r=>r.tool==='ffprobe').length,2+2*expectedSegments);
  if (records.some(r => !r.close_observed)) return null;
  // A wrapper writes its real child's close receipt just before its own exit.
  // Continue observation until the actual wrapper also no longer exists.
  if (records.some(r => !verifyPidAbsent(r.wrapper_pid))) return null;
  for (const r of records) {
    assert.equal(r.spawn_observed, true); assert.equal(r.spawn_error, false);assert.equal(r.observer_error,false);
    assert.equal(r.child_parent_pid,r.wrapper_pid);assert.match(r.child_start_ticks,/^[0-9]+$/);
    const realPath=await realpath(`/usr/bin/${r.tool}`);
    assert.equal(r.child_executable,realPath);
    assert.equal(r.child_executable_sha256,sha256(await readFile(`/usr/bin/${r.tool}`)));
    assert.equal(r.exit_code, 0); assert.equal(r.signal, null);
    assert.deepEqual(r.received_signals, [], 'Expected natural media-tool completion');
    assert.equal(r.pid_absent, true, 'Wrapper waitpid plus exact child PID absence');
    assert.equal(verifyPidAbsent(r.child_pid), true, 'Coordinator independently checks actual tool PID absent');
    assert.equal(verifyPidAbsent(r.wrapper_pid), true, 'Server wrapper process also closed');
    r.coordinator_child_pid_absent = true; r.coordinator_wrapper_pid_absent = true;
  }
  return records.sort((a,b)=>a.invocation.localeCompare(b.invocation));
}
function installAckGate(f, id, captured, mode) {
  const generation = uuid(captured.document.output_generation);
  const connection = uuid(captured.document.connection_id);
  const attempt = captured.document.attempt;
  assert.ok(Number.isInteger(attempt) && attempt >= 1 && attempt <= 3);
  assert.ok(['error', 'zero_rows'].includes(mode));
  // All objects exist only inside this fixture's newly owned native database.
  // nextval/setval remain visible when RAISE rolls back its UPDATE transaction.
  f.sql(`CREATE SEQUENCE finish_fixture_attempts START 1;
    CREATE SEQUENCE finish_fixture_backend_pid START 1;
    CREATE TABLE finish_fixture_gate(active boolean NOT NULL, job_id uuid NOT NULL,
      attempt integer NOT NULL, output_generation uuid NOT NULL, owner_connection uuid NOT NULL, mode text NOT NULL);
    INSERT INTO finish_fixture_gate VALUES(true,'${id}',${attempt},'${generation}','${connection}','${mode}');
    CREATE FUNCTION finish_fixture_ack() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE gate finish_fixture_gate%ROWTYPE; n bigint;
    BEGIN
      SELECT * INTO gate FROM finish_fixture_gate;
      IF gate.active AND OLD.job_id=gate.job_id AND OLD.attempt=gate.attempt
        AND OLD.output_generation=gate.output_generation AND OLD.owner_connection=gate.owner_connection
        AND OLD.server_verification_id IS NOT NULL AND OLD.server_verification_owner_epoch IS NOT NULL
        AND OLD.server_verification_reaped_at IS NULL AND NEW.server_verification_reaped_at IS NOT NULL
        AND NEW.server_verification_id=OLD.server_verification_id
        AND NEW.server_verification_owner_epoch=OLD.server_verification_owner_epoch THEN
        n := nextval('finish_fixture_attempts');
        PERFORM setval('finish_fixture_backend_pid',pg_backend_pid(),true);
        RAISE LOG 'finish_fixture_ack job=% attempt=% generation=% verification=% epoch=% pid=% ordinal=% mode=%',
          OLD.job_id,OLD.attempt,OLD.output_generation,OLD.server_verification_id,OLD.server_verification_owner_epoch,pg_backend_pid(),n,gate.mode;
        IF gate.mode='error' THEN RAISE EXCEPTION 'finish_fixture_controlled_ack_error'; END IF;
        RETURN NULL;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER finish_fixture_ack BEFORE UPDATE OF server_verification_reaped_at
      ON distributed_compute_attempts FOR EACH ROW EXECUTE FUNCTION finish_fixture_ack();`);
}
function ackState(f, id) {
  const state = jsonSql(f, `SELECT json_build_object('attempts',CASE WHEN s.is_called THEN s.last_value ELSE 0 END,
    'last_backend_pid',CASE WHEN p.is_called THEN p.last_value ELSE NULL END,
    'binding',(SELECT row_to_json(a) FROM (SELECT job_id,attempt,output_generation,owner_connection,
      server_verification_id,server_verification_owner_epoch,server_verification_started_at,
      server_verification_reaped_at FROM distributed_compute_attempts WHERE job_id='${id}') a),
    'job_status',(SELECT status FROM distributed_compute_jobs WHERE id='${id}'))
    FROM finish_fixture_attempts s,finish_fixture_backend_pid p`);
  return {...state, observed_at:new Date().toISOString()};
}
function releaseAckGate(f) { f.sql('UPDATE finish_fixture_gate SET active=false'); }
function dropAckGate(f) {
  f.sql('DROP TRIGGER finish_fixture_ack ON distributed_compute_attempts; DROP FUNCTION finish_fixture_ack(); DROP TABLE finish_fixture_gate; DROP SEQUENCE finish_fixture_attempts; DROP SEQUENCE finish_fixture_backend_pid;');
}
try {
  assert.ok(!process.env.DATABASE_URL, 'Reject caller database; own an isolated native PostgreSQL');
  assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, 'Native PostgreSQL required');
  assert.equal(process.env.RAINSYNC_MEDIA_STACK_EVIDENCE, '1', 'Require real existing stack direct-child receipts');
  assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT, '1');
  binding = await loadOwnerBinding({ root, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING, requireTest: true });
  report.backend_binding = binding.summary;
  const rawBytes=await readFile(process.env.W03_BACKEND_BINDING),rawBinding=JSON.parse(rawBytes);
  assert.equal(sha256(rawBytes),binding.summary.sha256);
  const helpers=rawBinding.test_helpers.filter(item=>item.name==='rainsync-compute-node');
  assert.ok(helpers.length<=1,'Require unique canonical compute-node helper');
  let extra;
  if(helpers.length===1) {
    const binary=helpers[0];
    assert.equal(binary.path,resolve(process.env.CARGO_TARGET_DIR,'debug/rainsync-compute-node'));
    assert.equal(rawBinding.source_digest,binding.summary.source_digest);
    assert.equal(sha256(JSON.stringify(rawBinding.source)),rawBinding.source_digest);
    extra={binary};
    extraVerify=async()=>{
      assert.equal(sha256(await readFile(process.env.W03_BACKEND_BINDING)),sha256(rawBytes));
      assert.deepEqual(await backendSnapshot(root),rawBinding.source);
      assert.equal(sha256(await readFile(binary.path)),binary.sha256);
    };
    report.compute_node_binding={source:'W03_BACKEND_BINDING.test_helpers',path:process.env.W03_BACKEND_BINDING,
      sha256:sha256(rawBytes),source_digest:rawBinding.source_digest,binary};
  } else {
    const extraPath=process.env.RAINSYNC_COMPUTE_NODE_BINDING;
    assert.ok(isAbsolute(extraPath??''),'Missing W03 node helper: set actual extra Cargo JSON binding');
    const extraBytes=await readFile(extraPath);extra=JSON.parse(extraBytes);
    assert.equal(extra.result,'passed');assert.equal(extra.kind,'additional-compute-node-build-binding');
    assert.equal(extra.build.close_observed,true);assert.equal(extra.build.exit_code,0);assert.equal(extra.build.signal,null);
    assert.equal(extra.source_unchanged,true);assert.equal(extra.backend_binding_sha256,binding.summary.sha256);
    assert.equal(extra.source_digest,binding.summary.source_digest);
    assert.equal(sha256(JSON.stringify(extra.source)),extra.source_digest);
    assert.equal(extra.compiler_artifact?.executable,extra.binary.path,'Require actual Cargo JSON executable provenance');
    assert.equal(extra.binary.path,resolve(process.env.CARGO_TARGET_DIR,'debug/rainsync-compute-node'));
    extraVerify=async()=>{
      assert.equal(sha256(await readFile(extraPath)),sha256(extraBytes));
      assert.deepEqual(await backendSnapshot(root),extra.source);
      assert.equal(sha256(await readFile(extra.binary.path)),extra.binary.sha256);
    };
    report.compute_node_binding={source:'RAINSYNC_COMPUTE_NODE_BINDING.actual-Cargo-JSON',path:extraPath,
      sha256:sha256(extraBytes),source_digest:extra.source_digest,binary:extra.binary};
  }
  await extraVerify();
  let wrapperSource=resolve(root,'tests/fixtures/compute-finish-real-media-wrapper.py');
  try {await readFile(wrapperSource);}catch(error){if(error.code!=='ENOENT')throw error;wrapperSource=resolve(proposal,'real-media-wrapper.py');await readFile(wrapperSource);}
  report.wrapper_source={path:wrapperSource,sha256:sha256(await readFile(wrapperSource))};
  report.media_tools = await Promise.all(['ffmpeg','ffprobe','python3'].map(async name => ({ name, path: `/usr/bin/${name}`, sha256: sha256(await readFile(`/usr/bin/${name}`)) })));
  const inputs = [fileURLToPath(import.meta.url),wrapperSource,
    ...['tests/fixtures/media-stack.mjs','tests/fixtures/server.mjs','tests/fixtures/postgres.mjs','tests/fixtures/unused-port.mjs',
      'deploy/owned-process.mjs','scripts/native-owner-binding.mjs'].map(p => resolve(root,p))];
  report.coordinator = await Promise.all(inputs.map(async path => ({path,sha256:sha256(await readFile(path))})));
  stage = 'fixture';
  await withTerminationSignal(async termination => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(Error('compute_finish_absolute_timeout')), 180000);
    const signal = AbortSignal.any([termination,deadline.signal]);
    const originalPath = process.env.PATH;
    try {
      await isolatedMediaStack('compute-finish-owner-native', async f => {
        fixture = f;
        // The already-started Server retains instrumented PATH. New fixture NAS,
        // clip generation and compute node use the original PATH and real tools.
        f.env.PATH = originalPath; delete f.env.RAINSYNC_FINISH_PROCESS_RECEIPTS;
        const receiptsPath = resolve(f.root,'server-process-receipts');
        const source = resolve(f.root,'source'); await mkdir(source);
        await f.makeClip('source/owned-4k.mp4',{width:3840,height:2160,pictureSeconds:3});
        const admin = f.client(); await admin.login();
        const {agentId} = await f.startAgent({mediaRoot:source}); uuid(agentId);
        const media = uuid(await until(signal,() => f.sql(`SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='owned-4k.mp4' AND available AND source_version IS NOT NULL`),'source'));
        await admin.request(`/agents/${agentId}/compute-policy`,'POST',{enabled:true,slots:1,output_budget_bytes:67108864});
        const proxy = await finishProxy(f.origin,signal);
        const logPath=resolve(f.root,'compute-node.log');
        const log = createWriteStream(logPath);
        const logRecord={path:logPath,finish_observed:false,close_observed:false,error_observed:false,bytes:null,sha256:null};
        log.once('finish',()=>{logRecord.finish_observed=true;logRecord.finished_at=new Date().toISOString();});
        log.on('error',()=>{logRecord.error_observed=true;});
        const logClosed=new Promise(done=>log.once('close',()=>{logRecord.close_observed=true;logRecord.closed_at=new Date().toISOString();done();}));
        report.compute_node_log=logRecord;
        const node = observeChild(spawn(extra.binary.path,[],{env:{...f.env,SERVER_URL:proxy.origin,
          RAINSYNC_NAS_COMPUTE_ENABLED:'1',AGENT_CREDENTIAL_FILE:resolve(f.root,'agent-token'),
          COMPUTE_MEDIA_ROOT:source,COMPUTE_OUTPUT_ROOT:resolve(f.root,'node-output'),FFMPEG:'/usr/bin/ffmpeg',FFPROBE:'/usr/bin/ffprobe'},
          stdio:['ignore','pipe','pipe']}));
        node.child.stdout.pipe(log,{end:false}); node.child.stderr.pipe(log,{end:false});
        report.compute_node_process = node.record;
        let liveGate = false, pendingManual, stopping, stopClosed = false, runError;
        try {
          const stat=await readFile(`/proc/${node.record.pid}/stat`,'utf8');
          const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
          node.record.parent_pid=Number(fields[1]);node.record.process_start_ticks=fields[19];
          assert.equal(node.record.parent_pid,process.pid);
          node.record.executable=await readlink(`/proc/${node.record.pid}/exe`);
          assert.equal(node.record.executable,extra.binary.path);
          node.record.binary_sha256=sha256(await readFile(`/proc/${node.record.pid}/exe`));
          assert.equal(node.record.binary_sha256,extra.binary.sha256);
          await until(signal,() => {
            if(node.record.spawn_error || node.record.close_observed) throw Error('compute_node_start_failed');
            return f.sql(`SELECT count(*) FROM distributed_compute_sources WHERE media_id='${media}'`)==='1';
          },'real node self-test and catalog');
          for(const [name,mode,shutdown] of [['ack_error_http_disconnect','error',false],['ack_zero_rows_http_disconnect','zero_rows',false],['shutdown_pending_ack_error','error',true]]) {
            signal.throwIfAborted();
            const item = {name,mode,result:'running',stage:'real_job',server_pid:f.serverPid};
            report.cases.push(item); await save();
            const room = await admin.request('/rooms','POST',{name:`owned ${name}`}); uuid(room.id);
            f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1) WHERE room_id='${room.id}'`);
            const job = await admin.request(`/rooms/${room.id}/compute`,'POST',{media_generation:1,recipe:'h264_720p_hls_v1'}); uuid(job.id);
            const captured = await until(signal,() => proxy.held.get(job.id),'original measured node finish');
            item.job_id=job.id; item.qualification_body_sha256=captured.sha256;
            const bodyPath=resolve(f.root,`${job.id}.private.body`);
            await writeFile(bodyPath,captured.bytes,{flag:'wx',mode:0o600});
            assert.equal(sha256(await readFile(bodyPath)),captured.sha256);
            item.original_private_body={path:bodyPath,bytes:captured.bytes.length,sha256:captured.sha256};
            const generation = uuid(captured.document.output_generation);
            assert.equal(captured.document.qualification.recipe,'h264_720p_hls_v1');
            assert.equal(captured.document.qualification.full_decode,true);
            assert.equal(captured.document.qualification.output.video.width,1280);
            assert.equal(captured.document.qualification.output.video.height,720);
            item.node_finish = {captured_at:captured.captured_at,output_generation:generation,attempt:captured.document.attempt,
              connection_id:captured.document.connection_id,withheld_from_server:true};
            if(name==='ack_error_http_disconnect') {
              item.priority=[];
              const before=verificationState(f,job.id);assertNotStarted(before);
              const invalid=structuredClone(captured.document);invalid.qualification.full_decode=false;
              const invalidReply=await finishRequest(f,captured,invalid,signal,422,'COMPUTE_QUALIFICATION_REJECTED');
              const afterInvalid=verificationState(f,job.id);assertNotStarted(afterInvalid);assert.deepEqual(afterInvalid,before);
              item.priority.push({name:'invalid_full_decode_before_start',result:'passed',reply:invalidReply,ledger:afterInvalid});
              const changed=structuredClone(captured.document);
              changed.qualification.content_sha256=captured.document.qualification.content_sha256==='0'.repeat(64)?'a'.repeat(64):'0'.repeat(64);
              const changedReply=await finishRequest(f,captured,changed,signal,409,'COMPUTE_QUALIFICATION_BINDING_CHANGED');
              const afterHash=verificationState(f,job.id);assertNotStarted(afterHash);assert.deepEqual(afterHash,before);
              item.priority.push({name:'valid_shape_hash_binding_before_start',result:'passed',reply:changedReply,ledger:afterHash});
              assert.deepEqual(await mediaReceipts(receiptsPath,item.server_pid,job.id,generation,false),[]);
            }
            const playlist=await readFile(resolve(f.root,'published',job.id,generation,'index.m3u8'),'utf8');
            const segmentNames=playlist.split(/\r?\n/).map(v=>v.trim()).filter(v=>v && !v.startsWith('#'));
            assert.ok(segmentNames.length>0);assert.equal(new Set(segmentNames).size,segmentNames.length);
            for(const name of segmentNames) {assert.match(name,/^segment[0-9]{5}\.ts$/);assert.ok((await readFile(resolve(f.root,'published',job.id,generation,name))).length>0);}
            item.actual_manifest={sha256:sha256(Buffer.from(playlist)),segments:segmentNames.length,
              expected_children:3+2*segmentNames.length,expected_ffmpeg:1,expected_ffprobe:2+2*segmentNames.length};
            item.stage='ack_fault'; liveGate=true; installAckGate(f,job.id,captured,mode);
            pendingManual=manualFinish(f.origin,captured); item.manual_http=pendingManual.record;
            await until(signal,() => { const state=ackState(f,job.id); return state.attempts>=2 ? state : null; },'real failed ACK UPDATE attempts');
            item.server_media_processes=await until(signal,() => mediaReceipts(receiptsPath,item.server_pid,job.id,generation,true,segmentNames.length),'natural real ffmpeg and ffprobe close');
            if(name==='ack_error_http_disconnect') {
              const beforeDuplicate=verificationState(f,job.id);
              const reply=await finishRequest(f,captured,captured.document,signal,409,'COMPUTE_VERIFICATION_ALREADY_OWNED');
              const afterDuplicate=verificationState(f,job.id);assert.deepEqual(afterDuplicate,beforeDuplicate);
              item.priority.push({name:'same_body_while_ack_owned',result:'passed',reply,ledger:afterDuplicate});
            }
            item.before_disconnect=ackState(f,job.id);
            assert.equal(item.before_disconnect.binding.server_verification_reaped_at,null);
            assert.equal(item.before_disconnect.job_status,'running');
            assert.equal(pendingManual.record.socket_connected,true); assert.equal(pendingManual.record.response_observed,false);
            await pendingManual.disconnect(); pendingManual=undefined;
            item.after_disconnect=await until(signal,() => {
              const state=ackState(f,job.id); return state.attempts>=item.before_disconnect.attempts+2 ? state:null;
            },'detached owner continues exact ACK retries');
            assert.equal(item.after_disconnect.binding.server_verification_id,item.before_disconnect.binding.server_verification_id);
            assert.equal(item.after_disconnect.binding.server_verification_owner_epoch,item.before_disconnect.binding.server_verification_owner_epoch);
            assert.equal(item.after_disconnect.binding.server_verification_reaped_at,null);
            item.stage=shutdown?'shutdown_pending':'release'; await save();
            if(shutdown) {
              stopping=f.stopServer().then(outcome => {stopClosed=true; return outcome;});
              item.shutdown_pending=await until(signal,() => {
                const state=ackState(f,job.id); return state.attempts>=item.after_disconnect.attempts+2 ? state:null;
              },'ACK owner retained during real Server shutdown');
              assert.equal(stopClosed,false,'Server close pending while fault remains');
              assert.equal(verifyPidAbsent(item.server_pid),false,'Same Server PID remains live');
              item.server_close_pending_under_fault=true; item.server_pid_live_under_fault=true;
            }
            releaseAckGate(f);
            item.durable_ack=await until(signal,() => {
              const state=ackState(f,job.id); return state.binding.server_verification_reaped_at ? state:null;
            },'same exact verification durable ACK');
            assert.equal(item.durable_ack.binding.server_verification_id,item.before_disconnect.binding.server_verification_id);
            assert.equal(item.durable_ack.binding.server_verification_owner_epoch,item.before_disconnect.binding.server_verification_owner_epoch);
            if(shutdown) {
              item.server_stop=await stopping; stopping=undefined;
              assert.equal(item.server_stop.observed_close,true); assert.equal(item.server_stop.exit_code,0); assert.equal(item.server_stop.signal,null);
              assert.equal(verifyPidAbsent(item.server_pid),true); item.server_stop.pid_absent=true;
              item.final_job_status=f.sql(`SELECT status FROM distributed_compute_jobs WHERE id='${job.id}'`);
              item.final_gate_scope='Final job status recorded as observed; shutdown case does not require ready.';
              captured.disconnect();
            } else {
              const ready=await until(signal,async() => {
                const status=await admin.request(`/rooms/${room.id}/compute/${job.id}`);
                assert.ok(!['failed','cancelled'].includes(status.status));
                return status.status==='ready'?status:null;
              },'independent viewer ready');
              item.viewer_ready={status:ready.status,output_generation:ready.output_generation};
              const qualificationBytes=Buffer.from(f.sql(`SELECT qualification FROM distributed_compute_jobs WHERE id='${job.id}'`));
              const qualificationPath=resolve(f.root,`${job.id}.qualification.private.json`);
              await writeFile(qualificationPath,qualificationBytes,{flag:'wx',mode:0o600});
              item.server_private_qualification={path:qualificationPath,bytes:qualificationBytes.length,sha256:sha256(qualificationBytes)};
              const actualQualification=JSON.parse(qualificationBytes);
              assert.equal(actualQualification.recipe,'h264_720p_hls_v1');assert.equal(actualQualification.full_decode,true);
              assert.equal(actualQualification.output.video.width,1280);assert.equal(actualQualification.output.video.height,720);
              assert.equal(ready.output_generation,generation);
              const directory=await admin.request(`/rooms/${room.id}/compute/${job.id}/directory`);
              assert.equal(directory.output_generation,generation); assert.ok(directory.files.length>=2);
              for(const file of directory.files) assert.equal((await admin.raw(file.url.replace('/api/v1',''))).status,200);
              item.ready_files={count:directory.files.length,bytes:directory.files.reduce((n,v)=>n+v.size_bytes,0)};
              if(name==='ack_error_http_disconnect') {
                const beforeReplay=verificationState(f,job.id);
                const replayReply=await finishRequest(f,captured,captured.document,signal,200);
                item.priority.push({name:'authorized_ready_same_body_replay',result:'passed',reply:replayReply});
                const invalid=structuredClone(captured.document);invalid.qualification.full_decode=false;
                const invalidReply=await finishRequest(f,captured,invalid,signal,422,'COMPUTE_QUALIFICATION_REJECTED');
                const afterReplay=verificationState(f,job.id);assert.deepEqual(afterReplay,beforeReplay);
                item.priority.push({name:'invalid_full_decode_precedes_ready_replay',result:'passed',reply:invalidReply,ledger:afterReplay});
              }
              const replay=await captured.forward(); assert.equal(replay.status,200);
              item.original_node_finish_replay={same_body_sha256:captured.sha256,status:replay.status};
              await until(signal,() => f.sql(`SELECT process_reaped_at IS NOT NULL AND files_removed_at IS NOT NULL FROM distributed_compute_attempts WHERE job_id='${job.id}'`)==='t','node durable drain ledger');
              // This is direct filesystem observation, separately scoped from SQL.
              try { await readdir(resolve(f.root,'node-output',job.id,generation)); throw Error('node_output_still_exists'); }
              catch(error) { assert.equal(error.code,'ENOENT'); }
              item.node_output_directory_absent=true;
            }
            const finalReceipts=await mediaReceipts(receiptsPath,item.server_pid,job.id,generation,true,segmentNames.length);
            assert.deepEqual(finalReceipts,item.server_media_processes,'No additional verification media child appeared after ACK');
            dropAckGate(f); liveGate=false;
            item.stage='complete'; item.result='passed'; report.checks.push({name,result:'passed'});
            for(const priority of item.priority??[]) report.checks.push({name:priority.name,result:'passed'}); await save();
          }
        } catch(error) {runError=error;throw error;} finally {
          const errors=[];
          // Release ACK faults before any Server/stack cleanup so retained owners can finish.
          if(liveGate) {try {releaseAckGate(f); report.ack_fault_released_on_cleanup=true;}catch(error){errors.push(error);}}
          if(pendingManual) {try{await pendingManual.disconnect();}catch(error){errors.push(error);}}
          for(const held of proxy.held.values()) held.disconnect();
          if(stopping) {try{report.pending_server_stop_cleanup=await stopping;}catch(error){errors.push(error);}}
          try {await reapOwnedChildren([{child:node.child,closed:node.closed}]);}catch(error){errors.push(error);}
          try {assert.equal(node.record.close_observed,true);assert.equal(node.record.spawn_error,false);
            assert.equal(node.record.exit_code,0);assert.equal(node.record.signal,null);
            node.record.pid_absent=verifyPidAbsent(node.record.pid);assert.equal(node.record.pid_absent,true);
          }catch(error){errors.push(error);}
          try {report.proxy_cleanup=await proxy.close();}catch(error){errors.push(error);}
          try {
            log.end();let logTimer;
            try {await Promise.race([logClosed,new Promise((_,reject)=>{logTimer=setTimeout(()=>reject(Error('compute_node_log_close_unconfirmed')),3000);})]);}
            finally {clearTimeout(logTimer);}
            assert.equal(logRecord.finish_observed,true);assert.equal(logRecord.close_observed,true);assert.equal(logRecord.error_observed,false);
            const bytes=await readFile(logPath);logRecord.bytes=bytes.length;logRecord.sha256=sha256(bytes);
          }catch(error){errors.push(error);}
          if(errors.length) throw new AggregateError([...(runError?[runError]:[]),...errors],'compute_finish_owned_cleanup_failed');
        }
      },{signal,binary:binding.server,beforeStart:async f=>{
        fixture=f; report.fixture_id=f.id;report.postgres=f.postgresDiagnostics();
        const wrappers=resolve(f.root,'server-path-wrapper');await mkdir(wrappers);
        const receipts=resolve(f.root,'server-process-receipts');await mkdir(receipts);
        for(const name of ['ffmpeg','ffprobe']) {const path=resolve(wrappers,name);await copyFile(wrapperSource,path);await chmod(path,0o700);}
        f.env.PATH=wrappers+':'+originalPath; f.env.RAINSYNC_FINISH_PROCESS_RECEIPTS=receipts;
        f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT=resolve(f.root,'published'); await save();
      }});
    } finally {clearTimeout(timer);}
  });
} catch(error) {
  failure=error; report.failure={stage,code:'compute_finish_owner_failed'};
  for(const item of report.cases) if(item.result==='running') item.result='failed';
} finally {
  // Before/after binding and coordinator observations also run after case failure.
  if(binding && extraVerify && report.coordinator && report.media_tools) {
    try {
      await binding.verify();await extraVerify();
      for(const input of report.coordinator) assert.equal(sha256(await readFile(input.path)),input.sha256);
      for(const tool of report.media_tools) assert.equal(sha256(await readFile(tool.path)),tool.sha256);
      report.inputs_unchanged=true;
    } catch(error) {failure=failure?new AggregateError([failure,error],'run_and_binding_failed'):error;report.inputs_unchanged=false;report.binding_recheck={code:'binding_recheck_failed'};}
  }
  if(fixture) try{report.cleanup=await fixture.verifyStopped();
    for(const child of report.cleanup.servers) {assert.equal(child.exit_code,0);assert.equal(child.signal,null);}
    assert.equal(report.cleanup.postgres.exit_code,0);assert.equal(report.cleanup.postgres.signal,null);
  }catch(error){failure??=error;report.cleanup={completed:false,code:'owned_cleanup_unconfirmed'};}
  else report.cleanup={completed:stage==='prerequisites',resources_started:false};
  report.result=failure?'failed':'passed';report.finished_at=new Date().toISOString();await save();
  console.log(`Compute finish owner report: ${reportPath}`);
}
if(failure) {console.error(failure);throw Error('compute-finish-owner-native failed; retain report and local logs');}
