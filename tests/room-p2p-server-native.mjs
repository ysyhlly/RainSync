// Original Server HTTP signaling baseline. No Chromium, media qualification or publication.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedServer, delay } from './fixtures/server.mjs';
import { loadOwnerBinding, sha256 } from '../scripts/native-owner-binding.mjs';
import { ownedProcess, withTerminationSignal } from '../deploy/owned-process.mjs';
import { verifyPidAbsent } from './fixtures/postgres.mjs';
const repo = resolve(import.meta.dirname, '..');
const id = n => `00000000-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
const consent = { acknowledge_peer_addresses:true, confirm_current_network:true, upload_allowed:true };
const report = { schema_version:1, result:'running', scope:'real original Server HTTP, full production migrations and legal stamped synthetic ready job; no media qualification, browser or primary playback acceptance', checks:[], observations:[], concurrency:[] };
let fixture, failed = false;
const diagnosticFlag='--diagnose-after-known-payload-boundary';
const transactionRepairFlag='--observe-transaction-repair';
const flags=process.argv.slice(2);
assert.ok(flags.every(arg=>arg===diagnosticFlag||arg===transactionRepairFlag),'Unknown diagnostic argument');
assert.equal(new Set(flags).size,flags.length,'Diagnostic flag must not repeat');
const observeTransactionRepair=flags.includes(transactionRepairFlag);
report.transaction_repair_observation_enabled=observeTransactionRepair;
const diagnoseAfterKnownPayloadBoundary=process.argv.includes(diagnosticFlag);
report.mode=diagnoseAfterKnownPayloadBoundary?'failed-diagnostic-continuation':'strict';
const sources = ['tests/room-p2p-server-native.mjs','tests/fixtures/server.mjs','tests/fixtures/postgres.mjs','tests/fixtures/unused-port.mjs','scripts/native-owner-binding.mjs','deploy/owned-process.mjs'];
const snapshot = () => Promise.all(sources.map(async path => ({path,sha256:sha256(await readFile(resolve(repo,path)))})));
function protect(value,key='') {
 if (Array.isArray(value)) return value.map(v=>protect(v));
 if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,protect(v,k)]));
 if (/token|login_hash|csrf|password|encrypted/i.test(key) && value !== null) return { redacted_sha256:sha256(Buffer.from(String(value))) };
 return value;
}
try {
 assert.ok(!process.env.DATABASE_URL,'external DATABASE_URL forbidden');
 assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT,'1');
 assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN);
 const binding = await loadOwnerBinding({root:repo,target:process.env.CARGO_TARGET_DIR,path:process.env.W03_BACKEND_BINDING});
 report.binding=binding.summary; report.coordinator=await snapshot();
 await withTerminationSignal(async signal => {
 await isolatedServer('room-p2p-server-native',async f=>{
  fixture=f; await binding.verify();
  const serverHash=()=>readFile(`/proc/${f.serverPid}/exe`).then(sha256);
  const expectedServer=binding.summary.binaries.find(item=>item.name==='rainsync-server').sha256;
  report.running_server_sha256_before=await serverHash();assert.equal(report.running_server_sha256_before,expectedServer);
  // Server starts/migrates its owned fresh PostgreSQL before these legal production INSERTs.
  const room=id(4),agent=id(2),media=id(3),job=id(10),generation=id(11),digest='b'.repeat(64);
  const clients=[];
  for(let n=1;n<=35;n++) {
   const user=id(100+n), login=n.toString(16).padStart(64,'0'), member=id(200+n);
   f.sql(`INSERT INTO users(id,username,password_hash,admin) VALUES('${user}','p2p-owned-${n}','!',true); INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES('${createHash('sha256').update(login).digest('hex')}','${user}','owned','2100-01-01');`);
   const c=f.client();c.cookie=`rainsync_session=${login}`;c.csrf='owned';clients.push({c,user,member,loginHash:createHash('sha256').update(login).digest('hex')});
  }
  f.sql(`INSERT INTO agents(id,name) VALUES('${agent}','owned'); INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${agent}','owned','agent','owned-unused'); INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${media}','${agent}','owned','owned.mp4','stat-v1:${digest}'); INSERT INTO rooms(id,name,owner_id) VALUES('${room}','owned','${clients[0].user}'); INSERT INTO room_snapshots(room_id,state) VALUES('${room}','{"media_id":"${media}","media_generation":1}');`);
  for(const c of clients) f.sql(`INSERT INTO room_members(room_id,user_id,membership_epoch) VALUES('${room}','${c.user}','${c.member}');`);
  f.sql(`INSERT INTO distributed_compute_jobs(id,room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,attempt,output_generation,owner_agent,owner_connection,qualification,qualification_sha256,created_at,expires_at) SELECT '${job}','${room}','${clients[0].user}','${clients[0].loginHash}','${clients[0].member}','${media}',1,0,'stat-v1:${digest}',access_policy_revision,'${digest}',1024,'remux_hls_v1','ready',1,'${generation}','${agent}','${id(12)}','{"schema_version":1,"full_decode":true}','${digest}','2000-01-01','2100-01-01' FROM sources WHERE id='${agent}';`);
  assert.equal(f.sql(`SELECT distributed_compute_authorized('${job}')`),'t');
  const tables=['room_p2p_peers','room_p2p_signals','distributed_compute_jobs','distributed_compute_files','sessions','room_members','playback_viewer_plans','playback_requests','playback_sessions','distributed_playback_bindings'];
  const observationSql=`SELECT jsonb_build_object(${tables.map(table=>`'${table}',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${table} t)`).join(',')})`;
  const observe=()=>protect(JSON.parse(f.sql(observationSql)));
  const liveWitness=(table,where,expected,label)=>{
   const state=JSON.parse(f.sql(`SELECT jsonb_build_object('observed_at',clock_timestamp(),'count',count(*),'min_expires_at',min(expires_at),'min_remaining_ms',floor(extract(epoch FROM (min(expires_at)-clock_timestamp()))*1000)) FROM ${table} WHERE ${where} AND expires_at>clock_timestamp()`));
   report.ttl_witnesses??=[];report.ttl_witnesses.push({label,...state});assert.equal(state.count,expected,label);assert.ok(state.min_remaining_ms>0,label);return state;
  };
  async function api(c,path,method='GET',body,expected=200) {
   const before=observe(),response=await c.raw(path,{method,body}),value=await response.json();
   report.observations.push({path,method,status:response.status,result:protect(value),before,after:observe()});
   if(expected!==null)assert.equal(response.status,expected,`${method} ${path}`);
   if(response.status>=400) {
    const code=value.error?.code??value.error;
    const expectedCode=expected===429?(path.endsWith('/signal')?'p2p_signal_budget_exceeded':'p2p_room_peer_budget_exceeded'):expected===400?(path.includes('?')||path.endsWith('/signal')?'invalid_p2p_signal':'p2p_consent_required'):expected===404?(path.endsWith('/signal')?'p2p_target_unavailable':'p2p_peer_expired'):undefined;
    if(expectedCode)assert.equal(code,expectedCode.toUpperCase());
    if(expected!==null)assert.deepEqual(observe(),before,'rejected API changed durable rows');
   }
   return {status:response.status,value};
  }
  async function withObservedLock(label,sqlBody,startRequests,waitQuery,expectedWaiters){
   const tag=`p2p-repair-${label}`,log=resolve(f.root,`${tag}.log`);
   const lock=ownedProcess('/bin/sh',['-c','set -C; exec "$@" > "$RAINSYNC_P2P_LOCK_LOG" 2>&1','owned-p2p-repair',resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,'psql'),f.env.DATABASE_URL,'-v','ON_ERROR_STOP=1','-c',`SET application_name='${tag}'; BEGIN; ${sqlBody}; COMMIT;`],{timeoutMs:10000,signal,env:{...process.env,RAINSYNC_P2P_LOCK_LOG:log}});lock.catch(()=>{});
   let pending,receipt,failed=false,primary;const cleanupErrors=[];
   try {
    let ready=false;for(let n=0;n<100;n++){if(f.sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${tag}' AND wait_event='PgSleep'`)==='1'){ready=true;break;}await delay(10);}assert.ok(ready,'owned blocker holding row before HTTP');
    pending=startRequests();pending.catch(()=>{});
    let witnessed=false;for(let n=0;n<100;n++){if(Number(f.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '${waitQuery}'`))===expectedWaiters){witnessed=true;break;}await delay(10);}assert.ok(witnessed,'actual Server SQL waiting on owned row lock');
    report.repair_lock_witnesses??=[];report.repair_lock_witnesses.push({label,expected_waiters:expectedWaiters,witnessed,observed_at:new Date().toISOString()});
    return await pending;
   }catch(error){failed=true;primary=error;throw error;}
   finally{
    try{receipt=await lock;assert.equal(receipt.exit_code,0);assert.equal(receipt.observed_close,true);assert.equal(verifyPidAbsent(receipt.pid),true);}catch(error){receipt??=error.cleanup;cleanupErrors.push(error);}
    if(pending)try{await pending;}catch(error){if(!failed)cleanupErrors.push(error);}
    try{const bytes=await readFile(log);report.repair_lock_receipts??=[];report.repair_lock_receipts.push({label,...receipt,output:undefined,log_bytes:bytes.length,log_sha256:sha256(bytes)});}catch(error){cleanupErrors.push(error);}
    if(cleanupErrors.length)throw new AggregateError([...(failed?[primary]:[]),...cleanupErrors],'owned_repair_lock_cleanup_failed');
   }
  }
  const join=(n,expected=200)=>api(clients[n].c,`/rooms/${room}/compute/${job}/p2p`,'POST',consent,expected);
  const leave=(n,p)=>api(clients[n].c,`/room-p2p/${p}`,'DELETE');
  // Isolated first peer: natural TTL before periodic retention and other peer seeds.
  report.natural_ttl_started_at=new Date().toISOString();
  const natural=(await join(0)).value;
  const expiresBefore=f.sql(`SELECT expires_at::text FROM room_p2p_peers WHERE id='${natural.peer_id}'`);
  await new Promise((done,reject)=>{const timer=setTimeout(done,31000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
  await api(clients[0].c,`/room-p2p/${natural.peer_id}`,'GET',undefined,404);
  assert.equal(f.sql(`SELECT expires_at::text FROM room_p2p_peers WHERE id='${natural.peer_id}'`),expiresBefore);
  await leave(0,natural.peer_id);await leave(0,natural.peer_id);
  report.natural_ttl_completed_at=new Date().toISOString();
  report.checks.push('natural30s expiry cannot renew; exact owner leave idempotent');
  const peers=[];report.peer_window_started_at=new Date().toISOString();
  await api(clients[0].c,`/rooms/${room}/compute/${job}/p2p`,'POST',{...consent,upload_allowed:false},400);
  for(let n=0;n<32;n++){const p=(await join(n)).value;assert.equal(p.ttl_ms,30000);assert.equal(p.max_peers,3);assert.ok(p.peers.length<=3);assert.ok(p.authorization.lease_ms>0&&p.authorization.lease_ms<=3000);peers.push(p.peer_id);}
  liveWitness('room_p2p_peers',`room_id='${room}'`,32,'before sequential32 cap');
  await join(32,429);const replaced=(await join(0)).value.peer_id;assert.notEqual(replaced,peers[0]);peers[0]=replaced;
  report.checks.push('consent, sequential32cap, replacement, bounded peers/TTL/auth lease');
  for(let n=2;n<32;n++)await leave(n,peers[n]);
  // Original HTTP replacement gives the signal scenario fresh tickets after quota cleanup.
  peers[0]=(await join(0)).value.peer_id;peers[1]=(await join(1)).value.peer_id;
  report.signal_peers_rebuilt_via_original_join=true;
  const signalPath=`/room-p2p/${peers[0]}/signal`;
  const body={recipient:peers[1],kind:'offer',payload:{type:'offer',sdp:'owned'}};
  if(observeTransactionRepair){
   // Additional request-boundary cases, distinct from unchanged common schedule.
   const boundaryCases=[
    {name:'signal_origin_before_invalid_kind',path:signalPath,method:'POST',body:{...body,kind:'invalid'},headers:{Origin:'http://invalid.example'},status:403,code:'ORIGIN_REJECTED'},
    {name:'signal_csrf_before_invalid_kind',path:signalPath,method:'POST',body:{...body,kind:'invalid'},headers:{'x-csrf-token':'invalid'},status:403,code:'CSRF_REJECTED'},
    {name:'signal_login_before_invalid_kind',path:signalPath,method:'POST',body:{...body,kind:'invalid'},headers:{Cookie:''},status:401,code:'LOGIN_REQUIRED'},
    {name:'poll_login_before_invalid_cursor',path:`/room-p2p/${peers[0]}?peers=invalid`,method:'GET',headers:{Cookie:''},status:401,code:'LOGIN_REQUIRED'},
    {name:'poll_readonly_missing_origin_csrf',path:`/room-p2p/${peers[0]}`,method:'GET',bare:true,status:200},
   ];
   report.request_boundary_cases=[];
   for(const item of boundaryCases){
    const before=observe();const response=item.bare?await fetch(f.origin+'/api/v1'+item.path,{headers:{Cookie:clients[0].c.cookie},signal}):await clients[0].c.raw(item.path,{method:item.method,body:item.body,headers:item.headers});const value=await response.json();const after=observe();
    report.request_boundary_cases.push({name:item.name,status:response.status,result:protect(value),before,after});assert.equal(response.status,item.status,item.name);
    if(item.code){assert.equal(value.error.code,item.code,item.name);assert.deepEqual(after,before,'rejected boundary request changed rows');}
    else{assert.equal(value.authorization.peer_id,peers[0]);assert.equal(value.ttl_ms,30000);assert.ok(value.authorization.lease_ms>0&&value.authorization.lease_ms<=3000);assert.deepEqual(value.signals,[]);for(const table of tables.filter(name=>name!=='room_p2p_peers'))assert.deepEqual(after[table],before[table]);}
   }
   // Unused account34: authenticate before waiting, then expire its real login.
   const loginWaitPeer=(await join(34)).value.peer_id;
   const loginWaitBefore=observe();
   const loginExpired=await withObservedLock('request-login-expiry',`SELECT id FROM room_p2p_peers WHERE id='${loginWaitPeer}' FOR UPDATE; SELECT pg_sleep(3); UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id='${clients[34].user}'`,()=>api(clients[34].c,`/room-p2p/${loginWaitPeer}`,'GET',undefined,null),'%room_p2p_peers%FOR UPDATE%',1);
   assert.equal(loginExpired.status,404);assert.equal(loginExpired.value.error.code,'P2P_PEER_EXPIRED');
   const loginWaitAfter=observe();assert.deepEqual(loginWaitAfter.room_p2p_peers,loginWaitBefore.room_p2p_peers,'post-wait expired login must not extend peer deadline');
   report.request_boundary_cases.push({name:'login_expiry_after_peer_lock_wait',status:loginExpired.status,before:loginWaitBefore,after:loginWaitAfter});
   for(const item of [{name:'expired_login_before_invalid_signal',path:`/room-p2p/${loginWaitPeer}/signal`,method:'POST',body:{...body,kind:'invalid'}},{name:'expired_login_before_invalid_cursor',path:`/room-p2p/${loginWaitPeer}?peers=invalid`,method:'GET'}]){
    const before=observe(),response=await clients[34].c.raw(item.path,{method:item.method,body:item.body}),value=await response.json(),after=observe();report.request_boundary_cases.push({name:item.name,status:response.status,result:protect(value),before,after});assert.equal(response.status,401);assert.equal(value.error.code,'SESSION_EXPIRED');assert.deepEqual(after,before);
   }
   // Owned cleanup only; an expired login cannot invoke authenticated leave.
   f.sql(`DELETE FROM room_p2p_peers WHERE id='${loginWaitPeer}'`);
   // Re-establish original30s tickets by real HTTP, without changing ids or quotas.
   for(let n=0;n<2;n++){const renewed=await api(clients[n].c,`/room-p2p/${peers[n]}`,'GET');assert.equal(renewed.value.authorization.peer_id,peers[n]);assert.equal(renewed.value.ttl_ms,30000);assert.deepEqual(renewed.value.signals,[]);}
   report.request_boundary_fresh_peer_witness=liveWitness('room_p2p_peers',`room_id='${room}'`,2,'fresh two peers after request boundary supplement');
  }

  report.signal_window_started_at=new Date().toISOString();
  for(let n=0;n<64;n++)await api(clients[0].c,signalPath,'POST',body);
  liveWitness('room_p2p_signals',`sender='${peers[0]}'`,64,'before sequential64 cap');
  liveWitness('room_p2p_peers',`id IN ('${peers[0]}','${peers[1]}')`,2,'signal scenario peer tickets');
  await api(clients[0].c,signalPath,'POST',body,429);
  const inbox=await api(clients[1].c,`/room-p2p/${peers[1]}?after=0`);assert.equal(inbox.value.signals.length,64);report.signal_window_consumed_at=new Date().toISOString();
  const empty=await api(clients[1].c,`/room-p2p/${peers[1]}?after=${inbox.value.cursor}`);assert.equal(empty.value.signals.length,0);assert.equal(empty.value.cursor,inbox.value.cursor);assert.equal(f.sql(`SELECT count(*) FROM room_p2p_signals WHERE recipient='${peers[1]}'`),'0');
  await api(clients[0].c,signalPath,'POST',{...body,kind:'invalid'},400);
  await api(clients[0].c,signalPath,'POST',{...body,payload:[]},400);
  await api(clients[0].c,signalPath,'POST',{...body,recipient:randomUUID()},404);
  const exact={x:'x'.repeat(16376)};assert.equal(Buffer.byteLength(JSON.stringify(exact)),16384);
  const postgresLogBefore=diagnoseAfterKnownPayloadBoundary?await readFile(resolve(f.root,'postgres.log')):undefined;
  const boundary=await api(clients[0].c,signalPath,'POST',{...body,payload:exact},null);
  report.serialized_boundary={bytes:16384,status:boundary.status,result:boundary.value};
  try {
  assert.equal(boundary.status,200,'original compact16KiB payload expected acceptance; DB serializer discrepancy is retained failure');
  } catch(originalAssertion) {
   if(!diagnoseAfterKnownPayloadBoundary)throw originalAssertion;
   try {
   // This branch records a real unchanged assertion failure; it never grants acceptance.
   assert.equal(boundary.status,500);assert.equal(boundary.value.error.code,'DATABASE_ERROR');
   const observation=report.observations.at(-1);assert.equal(observation.status,500);
   assert.deepEqual(observation.before,observation.after,'known payload failure must preserve every observed row');
   assert.equal(Object.keys(observation.before).length,10);
   const postgresBytes=await readFile(resolve(f.root,'postgres.log'));
   assert.ok(postgresBytes.subarray(0,postgresLogBefore.length).equals(postgresLogBefore),'PostgreSQL log prefix changed');
   const newDatabaseDiagnostics=postgresBytes.subarray(postgresLogBefore.length);
   const diagnostics=newDatabaseDiagnostics.toString('utf8');
   assert.match(diagnostics,/violates check constraint "room_p2p_signals_payload_check"/);
   assert.match(diagnostics,/STATEMENT:  INSERT INTO room_p2p_signals/);
   const assertionBytes=Buffer.from(String(originalAssertion.stack??originalAssertion)+'\n');
   const assertionPath=resolve(f.root,'known-payload-assertion.private.log');
   const diagnosticPath=resolve(f.root,'known-payload-postgres.private.log');
   await writeFile(assertionPath,assertionBytes,{flag:'wx',mode:0o600});
   await writeFile(diagnosticPath,newDatabaseDiagnostics,{flag:'wx',mode:0o600});
   failed=true;process.exitCode=1;
   report.failure={code:'original_payload_boundary_assertion_failed_unfixed'};
   report.known_failures=[{case:'compact16384_expected200',actual_status:500,actual_code:'DATABASE_ERROR',constraint:'room_p2p_signals_payload_check',observed_tables_unchanged:true,assertion_log:assertionPath,assertion_sha256:sha256(assertionBytes),postgres_log:diagnosticPath,postgres_sha256:sha256(newDatabaseDiagnostics),cause_fixed:false,source_binding:report.binding,continued_for_diagnostics:true}];
   // Later failures keep their ordinary throw path and do not receive another continuation.
   console.error('Original P2P payload assertion failed and remains unfixed; continuing explicit diagnostics with exit1.');
   } catch(diagnosticEvidenceError) { throw new AggregateError([originalAssertion,diagnosticEvidenceError],'original_payload_failure_and_diagnostic_evidence_failure'); }
  }
  await api(clients[0].c,signalPath,'POST',{...body,payload:{x:'x'.repeat(16377)}},400);
  await api(clients[0].c,`/room-p2p/${peers[0]}?peers=${[peers[1],id(999),id(998),id(997)].join(',')}`,'GET',undefined,400);
  await api(clients[0].c,`/room-p2p/${peers[0]}?peers=invalid`,'GET',undefined,400);
  report.checks.push('sequential64cap, consumed inbox, invalid signal/target, serialized16KiB observed, cursor3 bound');
  // Real locked UPDATE crosses the old peer expiry: establish lock first, then poll.
  f.sql(`UPDATE room_p2p_peers SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id='${peers[1]}'`);
  const lockLog=resolve(f.root,'expiry-lock.log');
  const lock=ownedProcess('/bin/sh',['-c','set -C; exec "$@" > "$RAINSYNC_P2P_LOCK_LOG" 2>&1','owned-p2p-lock',resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,'psql'),f.env.DATABASE_URL,'-v','ON_ERROR_STOP=1','-c',`BEGIN; SELECT id FROM room_p2p_peers WHERE id='${peers[1]}' FOR UPDATE; SELECT pg_sleep(3); COMMIT;`],{timeoutMs:10000,signal,env:{...process.env,RAINSYNC_P2P_LOCK_LOG:lockLog}});
  lock.catch(()=>{}); // The original rejection is retained and awaited in finally.
  let poll,closed,lockFailure,lockFailed=false;
  try {
  let locked=false;for(let n=0;n<100;n++){if(f.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%room_p2p_peers%'")==='1'){locked=true;break;}await delay(10);}assert.ok(locked);
  const pendingPoll=api(clients[1].c,`/room-p2p/${peers[1]}`,'GET',undefined,null);pendingPoll.catch(()=>{});
  try {let witness=false;for(let n=0;n<100;n++){if(f.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%room_p2p_peers%'")==='1'){witness=true;break;}await delay(10);}assert.ok(witness,'actual poll peer-lock wait');report.poll_lock_wait_scope='owned_pg_room_p2p_peers_original_update_or_candidate_select';}finally{poll=await pendingPoll;}
  } catch(error) { lockFailed=true;lockFailure=error; }
  finally {
   try { closed=await lock; } catch(error) {closed=error.cleanup;lockFailed=true;lockFailure??=error;}
   report.lock_child=closed?{...closed,output:undefined}:{observed_close:false};
   try {const bytes=await readFile(lockLog);report.lock_child.log_bytes=bytes.length;report.lock_child.log_sha256=sha256(bytes);}catch(error){lockFailed=true;lockFailure??=error;}
  }
  if(lockFailed)throw lockFailure;
  assert.equal(closed.exit_code,0);assert.ok(closed.observed_close&&verifyPidAbsent(closed.pid));
  const bytes=await readFile(lockLog);report.lock_child={...closed,output:undefined,log_bytes:bytes.length,log_sha256:sha256(bytes)};
  report.locked_expiry={status:poll.status,result:poll.value,authorized:f.sql(`SELECT room_p2p_peer_authorized('${peers[1]}')`)};
  if(poll.status!==404||report.locked_expiry.authorized!=='f')report.concurrency.push({case:'locked_expiry',result:'contract_violation'});
  // Preserve actual concurrent outcomes; no production locks added here.
  await join(1);peers[1]=JSON.parse(f.sql(`SELECT to_jsonb(id) FROM room_p2p_peers WHERE user_id='${clients[1].user}'`));
  f.sql('DELETE FROM room_p2p_signals');
  for(let n=0;n<63;n++)await api(clients[0].c,signalPath,'POST',{...body,recipient:peers[1]});
  liveWitness('room_p2p_signals',`sender='${peers[0]}'`,63,'before concurrent63 signals');report.signal_race_started_at=new Date().toISOString();
  const signalRaceBefore=observe();
  const race=await Promise.all([api(clients[0].c,signalPath,'POST',{...body,recipient:peers[1]},null),api(clients[0].c,signalPath,'POST',{...body,recipient:peers[1]},null)]);
  const signalRaceAfter=observe();
  for(const reply of race){assert.ok([200,429].includes(reply.status));if(reply.status===429)assert.equal(reply.value.error.code,'P2P_SIGNAL_BUDGET_EXCEEDED');}
  for(const table of tables.filter(name=>name!=='room_p2p_signals'))assert.deepEqual(signalRaceAfter[table],signalRaceBefore[table]);
  assert.equal(signalRaceAfter.room_p2p_signals.length-signalRaceBefore.room_p2p_signals.length,race.filter(reply=>reply.status===200).length);
  for(const row of signalRaceBefore.room_p2p_signals)assert.deepEqual(signalRaceAfter.room_p2p_signals.find(item=>item.sequence===row.sequence),row);
  for(const row of signalRaceAfter.room_p2p_signals.filter(item=>!signalRaceBefore.room_p2p_signals.some(old=>old.sequence===item.sequence))){assert.equal(row.sender,peers[0]);assert.equal(row.recipient,peers[1]);assert.equal(row.kind,'offer');assert.deepEqual(row.payload,body.payload);}
  report.signal_race_observation={before:signalRaceBefore,after:signalRaceAfter};
  const count=Number(f.sql(`SELECT count(*) FROM room_p2p_signals WHERE sender='${peers[0]}' AND expires_at>clock_timestamp()`));report.concurrency.push({case:'signal63_two_posts',statuses:race.map(x=>x.status),count,result:count<=64?'observed_within_cap':'contract_violation'});
  // Real sender poll before independent quota setup; preserve id/outbound signals.
  const peerCapSenderBefore=observe();
  const peerCapRenewal=await api(clients[0].c,`/room-p2p/${peers[0]}`,'GET');
  assert.equal(peerCapRenewal.value.ttl_ms,30000);
  assert.equal(peerCapRenewal.value.authorization.peer_id,peers[0]);
  assert.ok(peerCapRenewal.value.authorization.lease_ms>0&&peerCapRenewal.value.authorization.lease_ms<=3000);
  assert.deepEqual(peerCapRenewal.value.signals,[]);
  const peerCapSenderAfter=observe();
  assert.deepEqual(peerCapSenderAfter.room_p2p_signals,peerCapSenderBefore.room_p2p_signals,'sender renewal preserves queued outbound signals');
  report.peer_cap_setup_sender_renewal={scope:'original HTTP poll before independent31peer setup; unchanged peer id/TTL and outbound signals',peer_id:peers[0],before:peerCapSenderBefore,after:peerCapSenderAfter};
  // Consume the completed signal-quota scenario through the original receiver API.
  const peerCapConsumeBefore=observe();
  assert.equal(peerCapConsumeBefore.room_p2p_signals.length,64);
  assert.deepEqual(peerCapConsumeBefore.room_p2p_signals,signalRaceAfter.room_p2p_signals);
  const peerCapConsume=await api(clients[1].c,`/room-p2p/${peers[1]}`,'GET');
  assert.equal(peerCapConsume.value.ttl_ms,30000);
  assert.equal(peerCapConsume.value.authorization.peer_id,peers[1]);
  assert.ok(peerCapConsume.value.authorization.lease_ms>0&&peerCapConsume.value.authorization.lease_ms<=3000);
  assert.equal(peerCapConsume.value.signals.length,64);
  assert.deepEqual(peerCapConsume.value.signals,peerCapConsumeBefore.room_p2p_signals.map(({sender,kind,payload})=>({sender,kind,payload})));
  const peerCapConsumeAfter=observe();
  assert.deepEqual(peerCapConsumeAfter.room_p2p_signals,[]);
  report.peer_cap_setup_receiver_consume={before:peerCapConsumeBefore,response:peerCapConsume.value,after:peerCapConsumeAfter};
  for(let n=2;n<31;n++)await join(n);
  // A distinct nonempty live signal witnesses the independent peer-cap race.
  const peerCapSentinelPayload={type:'offer',sdp:'owned-peer-cap-sentinel'};
  await api(clients[0].c,`/room-p2p/${peers[0]}/signal`,'POST',{kind:'offer',recipient:peers[1],payload:peerCapSentinelPayload});
  const peerCapSentinel=observe().room_p2p_signals;
  assert.equal(peerCapSentinel.length,1);
  assert.equal(peerCapSentinel[0].sender,peers[0]);assert.equal(peerCapSentinel[0].recipient,peers[1]);
  assert.equal(peerCapSentinel[0].kind,'offer');assert.deepEqual(peerCapSentinel[0].payload,peerCapSentinelPayload);
  const peerCapSentinelClock=JSON.parse(f.sql(`SELECT jsonb_build_object('observed_at',clock_timestamp(),'remaining_ms',EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))*1000) FROM room_p2p_signals WHERE sequence=${peerCapSentinel[0].sequence}`));
  assert.ok(peerCapSentinelClock.remaining_ms>0&&peerCapSentinelClock.remaining_ms<=20000);
  report.peer_cap_setup_live_sentinel={row:peerCapSentinel[0],clock:peerCapSentinelClock};
  liveWitness('room_p2p_peers',`room_id='${room}'`,31,'before concurrent31 peers');report.peer_race_started_at=new Date().toISOString();
  const peerRaceBefore=observe();
  const peerRace=await Promise.all([join(31,null),join(32,null)]);const peerRaceAfter=observe();
  for(const reply of peerRace){assert.ok([200,429].includes(reply.status));if(reply.status===429)assert.equal(reply.value.error.code,'P2P_ROOM_PEER_BUDGET_EXCEEDED');}
  for(const table of tables.filter(name=>!['room_p2p_peers','room_p2p_signals'].includes(name)))assert.deepEqual(peerRaceAfter[table],peerRaceBefore[table]);
  assert.equal(peerRaceAfter.room_p2p_peers.length-peerRaceBefore.room_p2p_peers.length,peerRace.filter(reply=>reply.status===200).length);
  assert.deepEqual(peerRaceAfter.room_p2p_signals,peerRaceBefore.room_p2p_signals,'fresh peer race cannot prune live prior signals');
  for(const row of peerRaceBefore.room_p2p_peers)assert.deepEqual(peerRaceAfter.room_p2p_peers.find(item=>item.id===row.id),row);
  for(const reply of peerRace.filter(item=>item.status===200)){const row=peerRaceAfter.room_p2p_peers.find(item=>item.id===reply.value.peer_id);assert.ok(row);assert.equal(row.room_id,room);assert.equal(row.job_id,job);assert.equal(row.output_generation,generation);}
  report.peer_race_observation={before:peerRaceBefore,after:peerRaceAfter};
  const peerCount=Number(f.sql(`SELECT count(*) FROM room_p2p_peers WHERE room_id='${room}' AND expires_at>clock_timestamp()`));report.concurrency.push({case:'peer31_two_joins',statuses:peerRace.map(x=>x.status),count:peerCount,result:peerCount<=32?'observed_within_cap':'contract_violation'});
  if(observeTransactionRepair){
  // Selected transaction schedules only; original quota and TTL assertions stay intact.
  f.sql('DELETE FROM room_p2p_peers');
  const repairA=(await join(0)).value.peer_id,repairB=(await join(1)).value.peer_id;
  // Candidate-only forced room wait; common63 race above stays unforced.
  for(let n=0;n<63;n++)await api(clients[0].c,`/room-p2p/${repairA}/signal`,'POST',{...body,recipient:repairB});
  liveWitness('room_p2p_signals',`sender='${repairA}'`,63,'candidate forced63');
  const forcedBefore=observe();
  const forcedRace=await withObservedLock('candidate-signal63',`SELECT id FROM rooms WHERE id='${room}' FOR NO KEY UPDATE; SELECT pg_sleep(3)`,()=>Promise.all([api(clients[0].c,`/room-p2p/${repairA}/signal`,'POST',{...body,recipient:repairB},null),api(clients[0].c,`/room-p2p/${repairA}/signal`,'POST',{...body,recipient:repairB},null)]),'%rooms%FOR NO KEY UPDATE%',2);
  assert.deepEqual(forcedRace.map(reply=>reply.status).sort(),[200,429]);
  assert.equal(forcedRace.find(reply=>reply.status===429).value.error.code,'P2P_SIGNAL_BUDGET_EXCEEDED');
  const forcedAfter=observe();assert.equal(forcedAfter.room_p2p_signals.length,64);
  report.repair_schedules??=[];report.repair_schedules.push({case:'candidate_forced_room_wait_signal63',before:forcedBefore,after:forcedAfter,statuses:forcedRace.map(reply=>reply.status)});
  await api(clients[1].c,`/room-p2p/${repairB}`);assert.equal(observe().room_p2p_signals.length,0);
  const oppositeBefore=observe();
  const opposite=await withObservedLock('opposite',`SELECT id FROM rooms WHERE id='${room}' FOR NO KEY UPDATE; SELECT pg_sleep(3)`,()=>Promise.all([api(clients[0].c,`/room-p2p/${repairA}/signal`,'POST',{...body,recipient:repairB},null),api(clients[1].c,`/room-p2p/${repairB}/signal`,'POST',{...body,recipient:repairA},null)]),'%rooms%FOR NO KEY UPDATE%',2);
  assert.deepEqual(opposite.map(x=>x.status),[200,200]);assert.equal(observe().room_p2p_signals.length,2);
  report.repair_schedules??=[];report.repair_schedules.push({case:'opposite_senders',before:oppositeBefore,after:observe(),statuses:opposite.map(x=>x.status)});
  await api(clients[0].c,`/room-p2p/${repairB}`,'GET',undefined,404); // Exact foreign-login owner remains rejected.
  const repairVictim=(await join(33)).value.peer_id;
  const rejectedBefore=observe();
  const revoked=await withObservedLock('membership-revoke',`SELECT id FROM room_p2p_peers WHERE id='${repairVictim}' FOR UPDATE; SELECT pg_sleep(3); DELETE FROM room_members WHERE room_id='${room}' AND user_id='${clients[33].user}'`,()=>api(clients[33].c,`/room-p2p/${repairVictim}`,'GET',undefined,null),'%room_p2p_peers%FOR UPDATE%',1);
  assert.equal(revoked.status,404);assert.equal(revoked.value.error.code,'P2P_PEER_EXPIRED');
  const revokedAfter=observe();
  assert.deepEqual(revokedAfter.room_p2p_peers,rejectedBefore.room_p2p_peers,'revoked poll must not extend deadline');
  report.repair_schedules.push({case:'membership_revoke_after_peer_lock_wait',before:rejectedBefore,after:revokedAfter,status:revoked.status});
  const repairJoined=(await join(1)).value.peer_id;
  const joinSignal=await withObservedLock('join-signal',`SELECT id FROM rooms WHERE id='${room}' FOR NO KEY UPDATE; SELECT pg_sleep(3)`,()=>Promise.all([join(2,null),api(clients[0].c,`/room-p2p/${repairA}/signal`,'POST',{...body,recipient:repairJoined},null)]),'%rooms%FOR NO KEY UPDATE%',2);
  assert.deepEqual(joinSignal.map(x=>x.status),[200,200]);
  // Receiver leave races an actual signal; either legal insertion-before-delete or missing target.
  const leaveRaceBefore=observe();
  const leaveRace=await Promise.all([api(clients[0].c,`/room-p2p/${repairA}/signal`,'POST',{...body,recipient:repairJoined},null),api(clients[1].c,`/room-p2p/${repairJoined}`,'DELETE',undefined,null)]);
  assert.ok([200,404].includes(leaveRace[0].status));if(leaveRace[0].status===404)assert.equal(leaveRace[0].value.error.code,'P2P_TARGET_UNAVAILABLE');assert.equal(leaveRace[1].status,200);
  const leaveRaceAfter=observe();assert.ok(!leaveRaceAfter.room_p2p_peers.some(row=>row.id===repairJoined));assert.ok(!leaveRaceAfter.room_p2p_signals.some(row=>row.recipient===repairJoined||row.sender===repairJoined));
  report.repair_schedules.push({case:'join_and_signal',statuses:joinSignal.map(x=>x.status)},{case:'leave_and_signal',before:leaveRaceBefore,after:leaveRaceAfter,statuses:leaveRace.map(x=>x.status)});
  }
  // A second legally stamped ready job/generation isolates output authority.
  const otherJob=id(20),otherGeneration=id(21);
  f.sql(`INSERT INTO distributed_compute_jobs(id,room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,attempt,output_generation,owner_agent,owner_connection,qualification,qualification_sha256,created_at,expires_at) SELECT '${otherJob}',room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,attempt,'${otherGeneration}',owner_agent,owner_connection,qualification,qualification_sha256,created_at,expires_at FROM distributed_compute_jobs WHERE id='${job}';`);
  f.sql('DELETE FROM room_p2p_peers');
  const one=(await join(0)).value;
  const other=(await api(clients[1].c,`/rooms/${room}/compute/${otherJob}/p2p`,'POST',consent)).value;
  await api(clients[0].c,`/room-p2p/${one.peer_id}/signal`,'POST',{...body,recipient:other.peer_id},404);
  report.checks.push('different immutable job/generation cannot signal');
  // Primary scope is seeded through unchanged viewer-plan/request/session/binding triggers.
  const session=id(30),viewer=id(31),c=clients[0];
  f.sql(`INSERT INTO distributed_compute_files(job_id,output_generation,name,sha256,size_bytes) VALUES('${job}','${generation}','index.m3u8','${digest}',5);`);
  f.sql(`INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash) VALUES('${c.user}','${room}','${viewer}',1,'${c.loginHash}');
    INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,auth_login_hash,auth_membership_epoch) VALUES('${c.user}','${session}','owned','${session}','${id(32)}','pending','2099-01-01','2099-01-01','${room}','${c.loginHash}','${c.member}');
    INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,viewer_id,plan_generation) VALUES('${session}','${c.user}','${room}','${media}',1,'owned-delivery','{"distributed_compute_version":1,"distributed_session_id":"${session}","distributed_job_id":"${job}","distributed_attempt":1,"distributed_output_generation":"${generation}","distributed_qualification_sha256":"${digest}"}','2099-01-01','${viewer}',1);
    INSERT INTO distributed_playback_bindings(session_id,job_id,attempt,output_generation,manifest_sha256,qualification_sha256,duration_ms) VALUES('${session}','${job}',1,'${generation}','${digest}','${digest}',1000);`);
  assert.equal(f.sql(`SELECT distributed_playback_session_authorized('${session}')`),'t');
  const primary=(await api(c.c,`/playback-sessions/${session}/distributed/p2p`,'POST',consent)).value;
  assert.equal(primary.authorization.session_id,session);
  const compute=(await join(1)).value;
  await api(c.c,`/room-p2p/${primary.peer_id}/signal`,'POST',{...body,recipient:compute.peer_id},404);
  report.checks.push('legal primary session binding and primary/compute mode isolation');
  // Production immutable-ready guard rejects same-job generation replacement.
  const jobBefore=f.sql(`SELECT to_jsonb(t)::text FROM distributed_compute_jobs t WHERE id='${job}'`);
  assert.throws(()=>f.sql(`UPDATE distributed_compute_jobs SET output_generation='${id(900)}' WHERE id='${job}'`),/distributed_compute_output_immutable/);
  assert.equal(f.sql(`SELECT to_jsonb(t)::text FROM distributed_compute_jobs t WHERE id='${job}'`),jobBefore);
  report.checks.push('ready same-job generation replacement rejected by original immutable trigger');
  // Fresh room and job use legal room/library stamping; cross-room peers cannot signal.
  const otherRoom=id(40),crossJob=id(41),crossGeneration=id(42);
  f.sql(`INSERT INTO rooms(id,name,owner_id) VALUES('${otherRoom}','cross-owned','${c.user}');INSERT INTO room_members(room_id,user_id,membership_epoch) VALUES('${otherRoom}','${c.user}','${c.member}');INSERT INTO room_snapshots(room_id,state) VALUES('${otherRoom}','{"media_id":"${media}","media_generation":1}');
    INSERT INTO distributed_compute_jobs(id,room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,attempt,output_generation,owner_agent,owner_connection,qualification,qualification_sha256,created_at,expires_at) SELECT '${crossJob}','${otherRoom}',user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,status,attempt,'${crossGeneration}',owner_agent,owner_connection,qualification,qualification_sha256,created_at,expires_at FROM distributed_compute_jobs WHERE id='${job}';`);
  const cross=(await api(c.c,`/rooms/${otherRoom}/compute/${crossJob}/p2p`,'POST',consent)).value;
  await api(c.c,`/room-p2p/${cross.peer_id}/signal`,'POST',{...body,recipient:compute.peer_id},404);
  report.checks.push('cross-room signaling rejected');
  report.uncovered=['media qualification/FFmpeg/publication','live same-job ready generation replacement is forbidden by production immutable trigger; rejection covered','quota concurrency exhaustive schedule'];
  report.running_server_sha256_after=await serverHash();assert.equal(report.running_server_sha256_after,expectedServer);
  await binding.verify();assert.deepEqual(await snapshot(),report.coordinator);
  if(report.concurrency.some(x=>x.result==='contract_violation'))throw Error('original_p2p_contract_violation_preserved');
  if(report.known_failures?.length){report.remaining_blocker='known_payload_boundary_unfixed';report.transaction_repair_scope=observeTransactionRepair?'common_and_candidate_selected_cases_satisfied_pending_independent_review':'common_cases_only';}
 },{signal,binary:binding.server,env:{RAINSYNC_P2P_ENABLED:'1'},beforeStart:f=>{f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT=resolve(f.root,'published');}});
 });
 report.result=failed?'failed':'passed';
} catch(error) {failed=true;report.result='failed';report.failure={code:'owned_p2p_server_baseline_failed'};if(fixture)await writeFile(resolve(fixture.root,'failure.log'),String(error.stack??error));process.exitCode=1;}
finally {
 if(fixture) {
  const errors=[];
  try {report.cleanup=await fixture.verifyStopped();}catch(error){errors.push(error);report.cleanup={completed:false};}
  try {report.server_logs=await Promise.all((report.cleanup.servers??[]).map(async entry=>{const path=resolve(fixture.root,`server-${entry.launch}.log`);const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:sha256(bytes),complete_to_observed_close:!!entry.closed_at};}));}catch(error){errors.push(error);}
  try {report.coordinator_after=await snapshot();assert.deepEqual(report.coordinator_after,report.coordinator);}catch(error){errors.push(error);report.inputs_unchanged=false;}
  if(errors.length){failed=true;process.exitCode=1;report.evidence_failures=errors.map(()=> 'cleanup_or_evidence_unconfirmed');}
  report.result=failed?'failed':'passed';
  await writeFile(resolve(fixture.root,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({result:report.result,path:resolve(fixture.root,'report.json')}));
 }
}
