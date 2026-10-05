// Disposable owned PostgreSQL only. No activation, account or media network.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedPostgres} from './fixtures/postgres.mjs';
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,'native owned PostgreSQL required; no Docker fallback');
const id=randomUUID(),root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'static-hls-foundation-migration',id);
await mkdir(root,{recursive:true});
const db=isolatedPostgres({root,name:'static-hls-foundation',id});
const q=v=>`'${String(v).replaceAll("'","''")}'`,sha=v=>createHash('sha256').update(v).digest('hex');
const tail=v=>v.split('\n').at(-1),supported=sql=>tail(db.sql(`SET rainsync.static_hls_reader='1';${sql}`));
const user=randomUUID(),room=randomUUID(),source=randomUUID(),media=randomUUID(),session=randomUUID(),capture=randomUUID(),owner=randomUUID(),login=sha('owned static login '+id);
const report={result:'running',scope:'Stage A compatibility and ownership only; static admission and public fallback remain disabled',checks:[],migrations:[]};
const check=(name,run)=>{run();report.checks.push(name);console.log('PASS: '+name)};
let failure;
try {
 await db.start();
 for(const name of (await readdir('migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&Number(n.slice(0,4))<43).sort()) {
  const bytes=await readFile('migrations/'+name);db.sql(`BEGIN;${bytes};COMMIT;`);report.migrations.push({name,sha256:sha(bytes)});
 }
 db.sql(`INSERT INTO users(id,username,password_hash) VALUES(${q(user)},'owned-static-foundation','not-for-login');
 INSERT INTO sessions VALUES(${q(login)},${q(user)},'owned csrf',clock_timestamp()+interval '1 hour');
 INSERT INTO rooms(id,name,owner_id) VALUES(${q(room)},'owned static room',${q(user)});
 INSERT INTO room_members(room_id,user_id) VALUES(${q(room)},${q(user)});
 INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${q(source)},'owned static HTTP','http','fixture-ciphertext');
 INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES(${q(media)},${q(source)},'owned static media','fixture.m3u8','{}');
 INSERT INTO room_snapshots(room_id,state) VALUES(${q(room)},'{"media_id":"${media}","media_generation":1}');
 INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
 SELECT ${q(user)},${q(randomUUID())},'owned immutable request',${q(session)},${q(randomUUID())},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',${q(room)},0,${q(login)},membership_epoch FROM room_members WHERE room_id=${q(room)} AND user_id=${q(user)};
 INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${q(session)},${q(user)},${q(room)},${q(media)},1,'owned static ticket','{"encrypted":"fixture-ciphertext","source_policy_revision":0}',clock_timestamp()+interval '20 minutes');
 UPDATE playback_requests SET status='completed',response_encrypted='fixture-response' WHERE session_id=${q(session)};`);
 const before=db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(session)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(session)}))`);
 const migration=await readFile('migrations/0043_static_hls_foundation.sql');
 db.sql(`BEGIN;${migration};ROLLBACK;`);
 check('rollback retains exact existing session/request values',()=>assert.equal(db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(session)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(session)}))`),before));
 db.sql(`BEGIN;${migration};COMMIT;`);report.migrations.push({name:'0043_static_hls_foundation.sql',sha256:sha(migration)});
 check('NULL contract keeps original source gate and stored legacy fields',()=>{
  assert.equal(db.sql(`SELECT static_hls_capture_id IS NULL AND playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(session)}`),'t');
  assert.equal(db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p)-'static_hls_capture_id' FROM playback_sessions p WHERE id=${q(session)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(session)}))`),before);
 });
 check('missing physical connection contract refuses capture admission',()=>assert.throws(()=>db.sql(`INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at) SELECT ${q(capture)},p.id,p.user_id,${q(owner)},p.resource,r.owner_epoch,p.expires_at FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE p.id=${q(session)}`),/static_hls_reader_required/));
 supported(`INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at) SELECT ${q(capture)},p.id,p.user_id,${q(owner)},p.resource,r.owner_epoch,p.expires_at FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE p.id=${q(session)};
 INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES(${q(capture)},${q(owner)},0,134217728,'static_hls_capture');
 UPDATE static_hls_captures SET state='verified',inventory_encrypted='fixture-verified-inventory' WHERE id=${q(capture)};
 UPDATE playback_sessions SET static_hls_capture_id=${q(capture)},resource=resource||jsonb_build_object('static_hls_capture_id',${q(capture)}) WHERE id=${q(session)};
 INSERT INTO media_jobs(id,session_id,status,spec,logical_queue,timing_version,timing_attempt,queue_entered_at,metrics_queue_ms,metrics_queue_complete,metrics_queue_accounted_attempt) VALUES(${q(session)},${q(session)},'queued','{}','static_hls_v1',1,0,clock_timestamp(),0,true,0);`);
 const actor=()=>{
  const principal=randomUUID(),login=sha('owned capacity '+principal),sid=randomUUID();
  db.sql(`INSERT INTO users(id,username,password_hash) VALUES(${q(principal)},${q('owned-'+principal)},'not-for-login');
  INSERT INTO sessions VALUES(${q(login)},${q(principal)},'owned csrf',clock_timestamp()+interval '1 hour');
  INSERT INTO room_members(room_id,user_id) VALUES(${q(room)},${q(principal)});
  INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
  SELECT ${q(principal)},${q(randomUUID())},'owned capacity request',${q(sid)},${q(randomUUID())},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',${q(room)},0,${q(login)},membership_epoch FROM room_members WHERE room_id=${q(room)} AND user_id=${q(principal)};
  INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${q(sid)},${q(principal)},${q(room)},${q(media)},1,${q('owned-ticket-'+sid)},'{"encrypted":"fixture-ciphertext","source_policy_revision":0}',clock_timestamp()+interval '20 minutes');
  UPDATE playback_requests SET status='completed',response_encrypted='fixture-response' WHERE session_id=${q(sid)};`);
  return{principal,sid,capture:randomUUID(),owner:randomUUID()};
 };
 const a=actor(),b=actor();
 const admissionSQL=a=>`BEGIN;SET LOCAL rainsync.static_hls_reader='1';
 INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at) SELECT ${q(a.capture)},p.id,p.user_id,${q(a.owner)},p.resource,r.owner_epoch,p.expires_at FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE p.id=${q(a.sid)};
 INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES(${q(a.capture)},${q(a.owner)},0,134217728,'static_hls_capture');COMMIT;`;
 const outcomes=await Promise.allSettled([db.sqlProcess(admissionSQL(a)).done,db.sqlProcess(admissionSQL(b)).done]);
 check('concurrent different-user admission grants exactly one remaining global slot with full shared reservation totals',()=>{
  assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(db.sql('SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL'),'2');
  assert.equal(db.sql('SELECT sum(bytes) FROM cache_write_reservations'),'268435456');
 });
 const winner=outcomes[0].status==='fulfilled'?a:b;
 supported(`UPDATE static_hls_captures SET state='cancelled' WHERE id=${q(winner.capture)}`);
 check('cancelled unresolved ownership still blocks further global admission',()=>assert.throws(()=>supported(admissionSQL(outcomes[0].status==='fulfilled'?b:a)),/static_hls_capture_capacity/));
 // Only this fixture's non-started owner positively disposes its empty attempt.
 supported(`UPDATE static_hls_captures SET state='disposed',streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),process_disposition='never_started',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp() WHERE id=${q(winner.capture)};DELETE FROM cache_write_reservations WHERE job_id=${q(winner.capture)};`);
 const sameUserSession=randomUUID();
 supported(`INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
 SELECT user_id,${q(randomUUID())},'owned same-user capacity',${q(sameUserSession)},${q(randomUUID())},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch FROM playback_requests WHERE session_id=${q(session)};
 INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) SELECT ${q(sameUserSession)},user_id,room_id,media_id,generation,'owned duplicate-user ticket',resource-'static_hls_capture_id',expires_at FROM playback_sessions WHERE id=${q(session)};
 UPDATE playback_requests SET status='completed',response_encrypted='fixture-response' WHERE session_id=${q(sameUserSession)};`);
 check('same-user unresolved ownership blocks a different valid parent even below global capacity',()=>assert.throws(()=>supported(admissionSQL({sid:sameUserSession,capture:randomUUID(),owner:randomUUID()})),/static_hls_capture_user_owner/));
 const unchanged=()=>db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(session)}),'job',(SELECT to_jsonb(j) FROM media_jobs j WHERE id=${q(session)}),'outputs',(SELECT COALESCE(jsonb_agg(to_jsonb(o)),'[]') FROM media_outputs o WHERE job_id=${q(session)}))`);
 const frozen=unchanged();
 check('unsupported reader gate is false while actual authority stays live',()=>assert.equal(db.sql(`SELECT NOT playback_source_allowed(media_id,resource) AND static_hls_session_authority_allowed(id) FROM playback_sessions WHERE id=${q(session)}`),'t'));
 check('old claim, source-denial housekeeping, renewal and unmark leave live static ownership unchanged',()=>{
  db.sql(`UPDATE media_jobs SET status='running',owner_id=${q(randomUUID())},attempt=attempt+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=${q(session)};
  UPDATE media_jobs j SET status='cancelled',owner_id=NULL,lease_until=NULL FROM playback_sessions p WHERE j.session_id=p.id AND NOT playback_source_allowed(p.media_id,p.resource);
  UPDATE playback_sessions SET stopped=true WHERE id=${q(session)} AND NOT playback_source_allowed(media_id,resource);
  UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '30 minutes' WHERE id=${q(session)};
  UPDATE playback_sessions SET resource=resource-'static_hls_capture_id',static_hls_capture_id=NULL WHERE id=${q(session)};`);
  assert.equal(unchanged(),frozen);
 });
 supported(`UPDATE media_jobs SET status='running',owner_id=${q(owner)},attempt=1,lease_until=clock_timestamp()+interval '30 seconds',timing_version=1,timing_attempt=1,queue_entered_at=NULL,run_started_at=clock_timestamp() WHERE id=${q(session)};
 INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir) VALUES(${q(session)},1,${q(owner)},'writing','owned/1');
 INSERT INTO media_output_files(job_id,attempt,segment_index,size_bytes,sha256) VALUES(${q(session)},1,-1,9,${q('0'.repeat(64))});
 INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id) VALUES(${q(randomUUID())},${q(session)},'job',${q(session)},1,${q(owner)});
 INSERT INTO cache_entries(id,cache_key,path) VALUES(${q(session)},${q(session)},'owned/1');
 INSERT INTO cache_read_leases(id,cache_id,expires_at,attempt) VALUES(${q(randomUUID())},${q(session)},clock_timestamp()+interval '1 minute',1);`);
 const fullState=()=>db.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(session)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(session)}),'job',(SELECT to_jsonb(j) FROM media_jobs j WHERE id=${q(session)}),'output',(SELECT jsonb_agg(to_jsonb(o)) FROM media_outputs o WHERE job_id=${q(session)}),'files',(SELECT jsonb_agg(to_jsonb(f)) FROM media_output_files f WHERE job_id=${q(session)}),'executions',(SELECT jsonb_agg(to_jsonb(e)) FROM media_executions e WHERE session_id=${q(session)}),'entry',(SELECT to_jsonb(c) FROM cache_entries c WHERE id=${q(session)}),'reads',(SELECT jsonb_agg(to_jsonb(r)) FROM cache_read_leases r WHERE cache_id=${q(session)}))`);
 const allFrozen=fullState();
 check('old exhausted/retry/publication/reaping/catalog/request UPDATE and DELETE paths preserve every live marked row',()=>{
  db.sql(`UPDATE media_jobs SET status='failed',error='media_job_retry_exhausted',owner_id=NULL,lease_until=NULL WHERE id=${q(session)};
  UPDATE media_jobs SET status='queued',error='worker_lease_expired',owner_id=NULL,lease_until=NULL WHERE id=${q(session)};
  UPDATE media_jobs SET logical_queue=NULL WHERE id=${q(session)};
  UPDATE media_outputs SET status='published',manifest_sha256=${q('1'.repeat(64))},segment_count=1,published_at=clock_timestamp() WHERE job_id=${q(session)};
  UPDATE media_outputs SET status='abandoned' WHERE job_id=${q(session)};
  UPDATE media_outputs SET cleanup_owner=${q(randomUUID())},cleanup_until=clock_timestamp()+interval '1 minute' WHERE job_id=${q(session)};
  UPDATE media_output_files SET sha256=${q('1'.repeat(64))} WHERE job_id=${q(session)};
  UPDATE media_executions SET reaped_at=clock_timestamp() WHERE session_id=${q(session)};
  UPDATE cache_read_leases SET expires_at=clock_timestamp()+interval '30 minutes' WHERE cache_id=${q(session)};
  UPDATE playback_requests SET response_encrypted='late old publication' WHERE session_id=${q(session)};
  DELETE FROM media_output_files WHERE job_id=${q(session)};
  DELETE FROM media_outputs WHERE job_id=${q(session)};
  DELETE FROM media_executions WHERE session_id=${q(session)};
  DELETE FROM media_jobs WHERE id=${q(session)};
  DELETE FROM cache_read_leases WHERE cache_id=${q(session)};
  DELETE FROM playback_requests WHERE session_id=${q(session)};
  DELETE FROM playback_sessions WHERE id=${q(session)};`);
  assert.equal(fullState(),allFrozen);
 });
 check('unsupported cache catalog operations raise before old callers can ignore rows_affected and delete files',()=>{
  for(const sql of [`INSERT INTO cache_entries(id,cache_key,path) VALUES(${q(session)},${q(session)},'owned/1') ON CONFLICT DO NOTHING`,
   `UPDATE cache_entries SET state='evicting',eviction_owner=${q(randomUUID())} WHERE id=${q(session)}`,
   `DELETE FROM cache_entries WHERE id=${q(session)}`])assert.throws(()=>db.sql(sql),/static_hls_reader_required/);
  assert.equal(fullState(),allFrozen);
 });
 check('new connection cannot strip queue or retroactively mark preexisting work',()=>{
  assert.throws(()=>supported(`UPDATE media_jobs SET logical_queue=NULL WHERE id=${q(session)}`),/static_hls_queue_immutable/);
  assert.throws(()=>supported(`UPDATE playback_sessions SET resource=resource-'static_hls_capture_id',static_hls_capture_id=NULL WHERE id=${q(session)}`),/static_hls_session_immutable/);
 });
 check('reservation purpose/owner cannot be reassigned and unknown disposal remains counted',()=>{
  assert.throws(()=>supported(`UPDATE cache_write_reservations SET purpose='media_job' WHERE job_id=${q(capture)}`),/static_hls_reservation_immutable/);
  assert.throws(()=>supported(`UPDATE cache_write_reservations SET owner_id=${q(randomUUID())} WHERE job_id=${q(capture)}`),/static_hls_reservation_immutable/);
  db.sql(`DELETE FROM cache_write_reservations WHERE job_id=${q(capture)}`);
  assert.equal(db.sql('SELECT sum(bytes) FROM cache_write_reservations'),'134217728');
 });
 supported(`UPDATE media_jobs SET status='queued',owner_id=NULL,lease_until=NULL,timing_version=1,timing_attempt=attempt,queue_entered_at=clock_timestamp(),run_started_at=NULL WHERE id=${q(session)};`);
 check('actual login revocation independently permits old retirement without releasing owner responsibility',()=>{
  db.sql(`DELETE FROM sessions WHERE token_hash=${q(login)};
  UPDATE playback_sessions SET stopped=true WHERE id=${q(session)};`);
  const owned=db.sql(`SELECT to_jsonb(j) FROM media_jobs j WHERE id=${q(session)}`);
  db.sql(`UPDATE media_jobs SET status='cancelled',owner_id=${q(randomUUID())},lease_until=clock_timestamp()+interval '1 hour' WHERE id=${q(session)}`);
  assert.equal(db.sql(`SELECT to_jsonb(j) FROM media_jobs j WHERE id=${q(session)}`),owned);
  db.sql(`UPDATE media_jobs SET status='cancelled',owner_id=NULL,lease_until=NULL,error='playback_session_stopped',timing_version=NULL,timing_attempt=NULL,queue_entered_at=NULL,run_started_at=NULL WHERE id=${q(session)}`);
  assert.equal(db.sql(`SELECT metrics_queue_complete AND metrics_queue_ms>=0 AND metrics_queue_accounted_attempt=attempt FROM media_jobs WHERE id=${q(session)}`),'t');
  assert.equal(db.sql(`SELECT stopped AND NOT static_hls_session_authority_allowed(id) FROM playback_sessions WHERE id=${q(session)}`),'t');
  assert.equal(db.sql(`SELECT status FROM media_jobs WHERE id=${q(session)}`),'cancelled');
  assert.equal(db.sql(`SELECT count(*) FROM media_executions WHERE session_id=${q(session)} AND reaped_at IS NULL`),'1');
 });
 check('expiry and cancellation do not stand in for positive physical cleanup',()=>{
  supported(`UPDATE static_hls_captures SET state='cancelled' WHERE id=${q(capture)}`);
  supported(`DELETE FROM cache_write_reservations WHERE job_id=${q(capture)}`);
  assert.equal(db.sql('SELECT sum(bytes) FROM cache_write_reservations'),'134217728');
 });
 check('old/new room closer cannot commit closed while capture stream/process/file custody is unresolved',()=>{
  db.sql(`UPDATE rooms SET lifecycle='closing',lifecycle_epoch=1 WHERE id=${q(room)}`);
  assert.throws(()=>db.sql(`BEGIN;UPDATE rooms SET lifecycle='closed' WHERE id=${q(room)};UPDATE room_snapshots SET state='{}' WHERE room_id=${q(room)};COMMIT;`),/static_hls_capture_drain_unconfirmed/);
  assert.throws(()=>supported(`UPDATE rooms SET lifecycle='closed' WHERE id=${q(room)}`),/static_hls_capture_drain_unconfirmed/);
  assert.equal(db.sql(`SELECT lifecycle FROM rooms WHERE id=${q(room)}`),'closing');
 });
 check('positive source/process/file receipts permit disposal and budget release',()=>{
  supported(`UPDATE static_hls_captures SET streams_closed_at=clock_timestamp(),process_closed_at=clock_timestamp(),process_disposition='reaped',files_removed_at=clock_timestamp(),disposed_at=clock_timestamp(),state='disposed' WHERE id=${q(capture)};
  DELETE FROM cache_write_reservations WHERE job_id=${q(capture)};`);
  assert.equal(db.sql('SELECT count(*) FROM cache_write_reservations'),'0');
  db.sql(`UPDATE rooms SET lifecycle='closed' WHERE id=${q(room)}`);
  assert.equal(db.sql(`SELECT lifecycle FROM rooms WHERE id=${q(room)}`),'closed');
 });
 report.result='passed';
}catch(error){failure=error;report.result='failed';report.error=String(error.stack??error)}
finally{await db.stop();report.cleanup=await db.verifyStopped();report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
