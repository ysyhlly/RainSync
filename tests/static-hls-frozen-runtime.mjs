// Frozen actual pre-Stage-A Server/Worker; owned database, cache and media only.
// Marking is explicit synthetic Stage A fixture SQL, never a public endpoint.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {isolatedMediaStack} from './fixtures/media-stack.mjs';
import {delay} from './fixtures/server.mjs';
for(const key of ['RAINSYNC_ARTIFACT_DIR','RAINSYNC_NATIVE_POSTGRES_BIN','RAINSYNC_STATIC_OLD_BINDING']) assert.ok(process.env[key],key);
const old=JSON.parse(await readFile(process.env.RAINSYNC_STATIC_OLD_BINDING,'utf8'));
const server=old.binaries.find(b=>b.name==='rainsync-server'),worker=old.binaries.find(b=>b.name==='rainsync-media-worker');
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const b of [server,worker])assert.equal(sha(await readFile(b.path)),b.sha256,'frozen binary '+b.name);
const root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'static-hls-frozen-runtime',randomUUID());await mkdir(root,{recursive:true});
const report={result:'running',scope:'explicit internal Stage A synthetic marking; actual frozen binaries; no public fallback/activation or product acceptance',old_binding:resolve(process.env.RAINSYNC_STATIC_OLD_BINDING),old_source_digest:old.source_digest,binaries:[server,worker],checks:[]};
const check=name=>{report.checks.push(name);console.log('PASS: '+name)};
let fixture,failure;
try {
 process.env.CARGO_TARGET_DIR=dirname(dirname(worker.path));
 await isolatedMediaStack('static-hls-frozen-runtime',async f=>{
  fixture=f;const client=f.client();await client.login();await f.makeClip('static-foundation.mp4',{pictureSeconds:2});
  const src=await client.request('/sources','POST',{name:'owned static fixture',kind:'local',config:{root:f.root}});await client.request(`/sources/${src.id}/test`,'POST');
  const media=(await client.request('/media')).find(m=>m.title.includes('static-foundation'));assert.ok(media);
  // Preview work is unrelated to the marked-grant claim experiment.
  f.sql('DELETE FROM media_previews');
  const room=await client.request('/rooms','POST',{name:'owned static fixture room'});
  f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media.id}"'),'{media_generation}','1') WHERE room_id='${room.id}'`);
  const body={room_id:room.id,media_generation:1,mode:'direct',position_ms:0,viewer_id:randomUUID(),plan_generation:1,idempotency_key:randomUUID()};
  const plan=await client.request('/playback-sessions','POST',body),capture=randomUUID(),owner=randomUUID(),sid=plan.session_id;
  const ordinaryBody={...body,idempotency_key:randomUUID(),viewer_id:randomUUID()};
  const ordinary=await client.request('/playback-sessions','POST',ordinaryBody);
  const queuedBody={...body,mode:'transcode',idempotency_key:randomUUID(),viewer_id:randomUUID()};
  const queued=await client.request('/playback-sessions','POST',queuedBody);
  assert.equal(Object.hasOwn(plan,'static_hls_fallback_version'),false);
  f.sql(`BEGIN;${await readFile('migrations/0043_static_hls_foundation.sql','utf8')};COMMIT;`);
  f.sql(`SET rainsync.static_hls_reader='1';
  INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at) SELECT '${capture}',p.id,p.user_id,'${owner}',p.resource,r.owner_epoch,p.expires_at FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE p.id='${sid}';
  INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES('${capture}','${owner}',0,134217728,'static_hls_capture');
  UPDATE static_hls_captures SET state='verified',inventory_encrypted='owned-synthetic-proof' WHERE id='${capture}';
  UPDATE playback_sessions SET static_hls_capture_id='${capture}',resource=resource||jsonb_build_object('static_hls_capture_id','${capture}') WHERE id='${sid}';
  INSERT INTO media_jobs(id,session_id,status,spec,logical_queue) VALUES('${sid}','${sid}','queued','{}','static_hls_v1');`);
  const state=()=>f.sql(`SELECT jsonb_build_object('session',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id='${sid}'),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id='${sid}'),'job',(SELECT to_jsonb(j) FROM media_jobs j WHERE id='${sid}'),'outputs',(SELECT COALESCE(jsonb_agg(to_jsonb(o)),'[]') FROM media_outputs o WHERE job_id='${sid}'),'executions',(SELECT COALESCE(jsonb_agg(to_jsonb(e)),'[]') FROM media_executions e WHERE session_id='${sid}'),'reservation',(SELECT to_jsonb(r) FROM cache_write_reservations r WHERE job_id='${capture}'))`);
  const before=state();
  const shim=resolve(f.root,'decoder-sentinel');await mkdir(shim);const calls=resolve(shim,'calls');
  for(const program of ['ffmpeg','ffprobe']){
   const binary=execFileSync('which',[program],{encoding:'utf8'}).trim();
   const script=`#!/bin/sh\nif [ "$1" = "-version" ]; then exec '${binary}' "$@"; fi\ncase "$*" in *${sid}*) printf '${program}:marked-decoder\\n' >> '${calls}'; exit 77;; esac\nprintf '${program}:decoder\\n' >> '${calls}'\nexec '${binary}' "$@"\n`;
   await writeFile(resolve(shim,program),script);await chmod(resolve(shim,program),0o700);
  }
  await f.startWorker({PATH:shim+':'+process.env.PATH});
  await f.waitForSql(`SELECT status FROM media_jobs WHERE session_id='${queued.session_id}'`,'succeeded',30000);
  const output=JSON.parse(f.sql(`SELECT to_jsonb(o) FROM media_outputs o WHERE job_id='${queued.session_id}' AND status='published'`));
  assert.ok(output.manifest_sha256);assert.ok(output.ready_segments>0);
  const produced=await fetch(f.workerOrigin+queued.playback_url);assert.equal(produced.status,200);assert.match(await produced.text(),/#EXTM3U/);
  report.null_transcode_output={session:queued.session_id,attempt:output.attempt,manifest_sha256:output.manifest_sha256,ready_segments:output.ready_segments};
  check('actual frozen old Worker claims and produces validated NULL transcode HLS alongside live marked work');
  await delay(500);
  assert.equal(state(),before,'old running claim/housekeeping leaves marked state byte-for-byte unchanged');
  let callsText='';try{callsText=await readFile(calls,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}assert.equal(callsText.includes('marked-decoder'),false,'marked queue invokes no decoder');assert.ok(callsText.includes('decoder'),'NULL workload exercised actual decoder');
  check('actual frozen old Worker leaves claim/housekeeping/output/receipt/reservation unchanged and invokes no decoder');
  await client.request(`/playback-sessions/${sid}`,'POST',undefined,410);
  await client.request('/playback-sessions','POST',body,410);
  assert.equal(state(),before,'old Server renewal/replay cannot mutate capture-bound grant');
  check('actual frozen old Server refuses marked renewal and replay without publication mutation');
  const response=await fetch(f.workerOrigin+plan.playback_url);assert.equal(response.status,401);await response.arrayBuffer();
  assert.equal(state(),before,'denied old delivery creates no execution receipt');
  check('old delivery denies marked grant; no receipt or public fallback marker is minted');
  await client.request(`/playback-sessions/${ordinary.session_id}`,'POST');
  assert.equal((await client.request('/playback-sessions','POST',ordinaryBody)).session_id,ordinary.session_id);
  const normal=await fetch(f.workerOrigin+ordinary.playback_url,{headers:{Range:'bytes=0-1023'}});
  assert.equal(normal.status,206);assert.equal((await normal.arrayBuffer()).byteLength,1024);
  assert.equal(f.sql(`SELECT static_hls_capture_id IS NULL FROM playback_sessions WHERE id='${ordinary.session_id}'`),'t');
  check('ordinary NULL static contract still renews, replays and serves actual Range bytes on frozen old binaries');
  await f.stopWorker();
  const protectedDir=resolve(f.env.CACHE_ROOT,sid);await mkdir(protectedDir,{recursive:true});
  const sentinel=Buffer.alloc(1024*1024,91);await writeFile(resolve(protectedDir,'owned-pressure-sentinel'),sentinel);
  // Explicit synthetic metadata for a stopped/expired marked attempt. This is
  // a DB compatibility experiment, not an OS reaping/capture disposal receipt.
  f.sql(`SET rainsync.static_hls_reader='1';UPDATE playback_sessions SET expires_at=clock_timestamp()-interval '1 second',stopped=true WHERE id='${sid}';
  UPDATE media_jobs SET status='failed',attempt=1,owner_id='${owner}',lease_until=NULL,error='owned synthetic terminal' WHERE id='${sid}';
  INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id,reaped_at) VALUES('${randomUUID()}','${sid}','job','${sid}',1,'${owner}',clock_timestamp());
  INSERT INTO cache_entries(id,cache_key,path) VALUES('${sid}','${sid}','${sid}') ON CONFLICT DO NOTHING;`);
  const cacheBefore=f.sql(`SELECT to_jsonb(c) FROM cache_entries c WHERE id='${sid}'`);
  const pressure=await client.request('/playback-sessions','POST',{...queuedBody,idempotency_key:randomUUID(),viewer_id:randomUUID()});
  await f.startWorker({PATH:shim+':'+process.env.PATH,CACHE_MAX_BYTES:'65536'});
  await f.waitForSql(`SELECT status FROM media_jobs WHERE session_id='${pressure.session_id}'`,'failed',10000);
  assert.equal(f.sql(`SELECT to_jsonb(c) FROM cache_entries c WHERE id='${sid}'`),cacheBefore);
  assert.deepEqual(await readFile(resolve(protectedDir,'owned-pressure-sentinel')),sentinel);
  const pgLog=await readFile(resolve(f.root,'postgres.log'),'utf8');assert.match(pgLog,/static_hls_reader_required/);
  report.old_cache_pressure={ordinary_job_failed:true,marked_stopped_expired:true,synthetic_job_reaped_metadata:true,sentinel_sha256:sha(sentinel),catalog_unchanged:true,db_guard_error_observed:true};
  check('actual frozen old Worker under pressure is stopped by catalog exception before deleting expired marked sentinel even with reaped metadata');
  await f.stopWorker();
 },{binary:server.path,env:{PLAYBACK_SESSION_LIMIT:'8'}});
 report.cleanup=await fixture.verifyStopped();report.result='passed';
}catch(error){failure=error;report.result='failed';report.error=String(error.stack??error);if(fixture)try{report.cleanup=await fixture.verifyStopped()}catch(e){report.cleanup_error=String(e)}}
finally{report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
