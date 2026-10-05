// Actual new persistence helper + owned native PostgreSQL; no decoder or network media.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {isolatedPostgres} from './fixtures/postgres.mjs';
for(const key of ['RAINSYNC_ARTIFACT_DIR','RAINSYNC_NATIVE_POSTGRES_BIN','RAINSYNC_STATIC_HLS_HELPER'])assert.ok(process.env[key],key);
const id=randomUUID(),root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'static-hls-new-runtime',id);await mkdir(root,{recursive:true});
const db=isolatedPostgres({root,name:'static-hls-new-runtime',id});
const q=v=>`'${String(v).replaceAll("'","''")}'`,sha=v=>createHash('sha256').update(v).digest('hex');
const report={result:'running',scope:'actual new physical pool/admission/queue helpers with synthetic inventory; no public grant, decoder or production activation',checks:[],migrations:[]};
const user=randomUUID(),room=randomUUID(),source=randomUUID(),media=randomUUID(),session=randomUUID(),login=sha('owned helper login '+id);
let failure;
try{
 await db.start();
 for(const name of(await readdir('migrations')).filter(v=>/^\d+_.+\.sql$/.test(v)).sort()){
  const bytes=await readFile('migrations/'+name);db.sql(`BEGIN;${bytes};COMMIT;`);report.migrations.push({name,sha256:sha(bytes)});
 }
 db.sql(`INSERT INTO users(id,username,password_hash) VALUES(${q(user)},'owned-static-new','not-for-login');
 INSERT INTO sessions VALUES(${q(login)},${q(user)},'owned csrf',clock_timestamp()+interval '1 hour');
 INSERT INTO rooms(id,name,owner_id) VALUES(${q(room)},'owned static new',${q(user)});
 INSERT INTO room_members(room_id,user_id) VALUES(${q(room)},${q(user)});
 INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${q(source)},'owned static new HTTP','http','fixture-ciphertext');
 INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES(${q(media)},${q(source)},'owned static media','fixture.m3u8','{}');
 INSERT INTO room_snapshots(room_id,state) VALUES(${q(room)},'{"media_id":"${media}","media_generation":1}');
 INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch)
 SELECT ${q(user)},${q(randomUUID())},'owned helper request',${q(session)},${q(randomUUID())},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',${q(room)},0,${q(login)},membership_epoch FROM room_members WHERE room_id=${q(room)} AND user_id=${q(user)};
 INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${q(session)},${q(user)},${q(room)},${q(media)},1,'owned new ticket','{"encrypted":"fixture-ciphertext","source_policy_revision":0}',clock_timestamp()+interval '20 minutes');
 UPDATE playback_requests SET status='completed',response_encrypted='fixture-response' WHERE session_id=${q(session)};`);
 const helper=resolve(process.env.RAINSYNC_STATIC_HLS_HELPER);report.helper={path:helper,sha256:sha(await readFile(helper))};
 report.source=await Promise.all(["crates/persistence/examples/verify_static_hls_foundation.rs","crates/persistence/src/static_hls.rs","crates/persistence/src/media_jobs.rs","crates/persistence/src/media_queue.rs","migrations/0043_static_hls_foundation.sql"].map(async path=>({path,sha256:sha(await readFile(path))})));
 const result=execFileSync(helper,[],{env:{...process.env,DATABASE_URL:db.url,RAINSYNC_ISOLATED_TEST:'1',RAINSYNC_STATIC_HLS_SESSION:session},encoding:'utf8',timeout:20000});
 report.helper_result=JSON.parse(result.trim());assert.equal(report.helper_result.result,'passed');
 report.checks.push('12 actual physical pool connections and replacement declare contract; raw connection does not');
 report.checks.push('real mint-only capture admission follows live authority and shared reservation budget; same-user second denied');
 report.checks.push('new generic NULL queue leaves static job unchanged and claims ordinary NULL work; separate static claim/renew bind exact owner/attempt');
 assert.equal(report.helper_result.late_epoch_denied,true);assert.equal(report.helper_result.unknown_query_denied,true);assert.equal(report.helper_result.responsibility_retained,true);
 report.checks.push('blocked actual SQL completion after epoch change and 750ms unknown authority both fail without releasing responsibility');
 const row=JSON.parse(db.sql(`SELECT jsonb_build_object('owner',owner_id,'attempt',attempt,'status',status,'queue',logical_queue) FROM media_jobs WHERE id=${q(session)}`));assert.equal(row.queue,'static_hls_v1');assert.equal(row.attempt,1);assert.equal(row.status,'running');
 assert.equal(db.sql('SELECT sum(bytes) FROM cache_write_reservations'),'134217728');
 db.sql(`DELETE FROM sessions WHERE token_hash=${q(login)};`);
 assert.equal(db.sql(`SELECT static_hls_capture_authority_allowed(id) FROM static_hls_captures WHERE session_id=${q(session)}`),'f');
 assert.equal(db.sql('SELECT sum(bytes) FROM cache_write_reservations'),'134217728');
 report.checks.push('late exact-login revocation denies capture authority while unresolved responsibility remains counted');
 for(const name of report.checks)console.log('PASS: '+name);
 report.result='passed';
}catch(e){failure=e;report.result='failed';report.error=String(e.stack??e)}
finally{await db.stop();report.cleanup=await db.verifyStopped();report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
