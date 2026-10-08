// Actual source-bound Server/Worker and disposable owned media/database.
// No Agent connection, external account or browser is created by this test.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {request} from 'node:http';
import {performance} from 'node:perf_hooks';
import {isolatedMediaStack} from './fixtures/media-stack.mjs';
import {delay} from './fixtures/server.mjs';
import {mediaLoginPreflight} from '../scripts/media-login-preflight.mjs';
assert.ok(process.env.W03_BACKEND_BINDING,'require source-bound native build');
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'media-login-runtime',randomUUID());await mkdir(root,{recursive:true});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const binding=JSON.parse(await readFile(process.env.W03_BACKEND_BINDING,'utf8'));
const report={result:'running',scope:'owned local media, actual Server/Worker, owned native PostgreSQL; no browser/real-upstream/Agent claim',binding:{path:resolve(process.env.W03_BACKEND_BINDING),source_digest:binding.source_digest},checks:[]};
let fixture,failure;
const check=name=>{report.checks.push(name);console.log('PASS: '+name)};
const until=async(fn,label,ms=10000)=>{const until=performance.now()+ms;while(performance.now()<until){const v=await fn();if(v)return v;await delay(50)}throw Error('deadline: '+label)};
try {
 for(const input of binding.source)assert.equal(sha(await readFile(input.path)),input.sha256,'bound source '+input.path);
 for(const b of binding.binaries)assert.equal(sha(await readFile(b.path)),b.sha256,'bound binary '+b.name);
 report.preflight=await mediaLoginPreflight(binding.binaries.find(b=>b.name==='rainsync-server').path);
 if(process.env.RAINSYNC_OLD_AUTH_SERVER) {
  const old=resolve(process.env.RAINSYNC_OLD_AUTH_SERVER);
  assert.ok(process.env.RAINSYNC_OLD_AUTH_BINDING,'old binary requires its source binding');
  const prior=JSON.parse(await readFile(process.env.RAINSYNC_OLD_AUTH_BINDING,'utf8'));
  const oldHash=sha(await readFile(old));assert.equal(oldHash,prior.binaries.find(b=>b.name==='rainsync-server').sha256);
  report.old_server={path:old,sha256:oldHash,binding:resolve(process.env.RAINSYNC_OLD_AUTH_BINDING),source_digest:prior.source_digest};
  await assert.rejects(mediaLoginPreflight(old),/Unsafe Server cutover/);check('known pre-cutover Server fails sanitized empty-cwd capability preflight');
 } else report.old_server={result:'not-run',reason:'no bound pre-cutover binary provided'};
 await isolatedMediaStack('media-login-runtime',async f=>{
  fixture=f;
  const a=f.client(),b=f.client();const identity=await a.login();await b.login();
  const path=await f.makeClip('login-bound.mp4',{pictureSeconds:2});
  // Keep a real valid MP4 prefix and a bounded sparse tail for backpressure.
  const file=await open(path,'r+');await file.truncate(128*1024*1024);await file.close();
  const src=await a.request('/sources','POST',{name:'owned login media',kind:'local',config:{root:f.root}});
  await a.request(`/sources/${src.id}/test`,'POST');
  const media=(await a.request('/media')).find(m=>m.title.includes('login-bound'));assert.ok(media);
  await f.startServer({WORKER_URL:f.workerOrigin,PLAYBACK_SESSION_LIMIT:'32'});
  const room=await a.request('/rooms','POST',{name:'owned exact login room'});
  f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media.id}"'),'{media_generation}','1') WHERE room_id='${room.id}'`);
  const body=(viewer=randomUUID())=>({room_id:room.id,media_generation:1,mode:'direct',position_ms:0,viewer_id:viewer,plan_generation:1,observation_version:1,idempotency_key:randomUUID()});
  const queuedClient=f.client();await queuedClient.login();
  const queued=await queuedClient.request('/playback-sessions','POST',{...body(),mode:'transcode'});
  assert.equal(f.sql(`SELECT status FROM media_jobs WHERE session_id='${queued.session_id}'`),'queued');
  await queuedClient.request('/auth/logout','POST');
  await until(()=>f.sql(`SELECT status FROM media_jobs WHERE session_id='${queued.session_id}'`)==='cancelled','all-provider queued job retirement');
  await f.startWorker();
  assert.equal(f.sql(`SELECT attempt FROM media_jobs WHERE session_id='${queued.session_id}'`),'0');
  check('logout retires a queued local job before any Worker claim');
  const ba=body(),bb=body(),pa=await a.request('/playback-sessions','POST',ba),pb=await b.request('/playback-sessions','POST',bb);
  assert.equal(f.sql(`SELECT p.auth_login_hash=r.auth_login_hash AND p.auth_membership_epoch=r.auth_membership_epoch AND p.resource->'auth_context'->>'login_hash'=r.auth_login_hash FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE p.id='${pa.session_id}'`),'t');
  assert.equal((await a.request('/playback-sessions','POST',ba)).session_id,pa.session_id);
  check('same-login replay preserves its grant and all provisional/final origin fields');
  for(const [method,path,body] of [['GET',`/playback-sessions/${pa.session_id}`],['POST',`/playback-sessions/${pa.session_id}`],['DELETE',`/playback-sessions/${pa.session_id}`],['DELETE',`/playback-requests/${ba.idempotency_key}`],['POST',`/playback-sessions/${pa.session_id}/observations`,{media_generation:1,seq:1,event:'playing',media_time_ms:0,paused:false,seeking:false,buffering:false,playback_rate:1,has_played:true}]]) await b.request(path,method,body,410);
  await b.request('/playback-sessions','POST',ba,409);
  await b.request('/playback-sessions','POST',{...ba,idempotency_key:randomUUID(),plan_generation:2},409);
  assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id='${pa.session_id}'`),'f');
  check('same-account login B cannot replay/control/cancel/supersede A');
  const delivery=async plan=>{const r=await fetch(f.workerOrigin+plan.playback_url,{headers:{Range:'bytes=0-1023'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,1024)};
  await delivery(pa);await delivery(pb);
  const paused=await new Promise((done,reject)=>{
   const req=request(f.workerOrigin+pa.playback_url,res=>{
    assert.equal(res.statusCode,200);let bytes=0,ended=false,first=true;
    res.on('data',chunk=>{bytes+=chunk.length;if(first){first=false;res.pause();done({req,res,bytes:()=>bytes,ended:()=>ended})}});
    res.on('end',()=>{ended=true});res.on('error',()=>{});
   });req.once('error',reject);req.end();
  });
  const began=performance.now();await a.request('/auth/logout','POST');
  await until(()=>f.sql(`SELECT stopped FROM playback_sessions WHERE id='${pa.session_id}'`)==='t','A all-provider retirement');
  await until(()=>f.sql(`SELECT count(*) FROM media_executions WHERE session_id='${pa.session_id}' AND reaped_at IS NULL`)==='0','Worker drops/reaps A backpressured body');
  const elapsed=performance.now()-began;assert.ok(elapsed<10000);report.logout_revocation_ms=elapsed;
  paused.res.resume();await until(()=>paused.res.destroyed,'old body terminates');assert.equal(paused.ended(),false,'revoked response is not falsely successful');paused.req.destroy();
  const denied=await fetch(f.workerOrigin+pa.playback_url);assert.equal(denied.status,401);await denied.arrayBuffer();
  await delivery(pb);await b.request(`/playback-sessions/${pb.session_id}`);await b.request(`/playback-sessions/${pb.session_id}`,'POST');
  assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id='${pb.session_id}'`),'f');
  check('logout A retires its local long stream inside 10s under backpressure; B still reads and renews');
  // An expired but not yet purged login must fail independently of cleanup.
  const c=f.client();await c.login();const pc=await c.request('/playback-sessions','POST',body());
  const hash=sha(c.cookie.split('=')[1]);f.sql(`UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash='${hash}'`);
  const expired=await fetch(f.workerOrigin+pc.playback_url);assert.equal(expired.status,401);await expired.arrayBuffer();
  await until(()=>f.sql(`SELECT stopped FROM playback_sessions WHERE id='${pc.session_id}'`)==='t','expired origin retired');await delivery(pb);
  check('login expiry revokes new bytes and retirement without waiting for session purge');
  // Cancel-before-create belongs to one exact login even for the same account.
  const d=f.client();await d.login();const key=randomUUID();await b.request(`/playback-requests/${key}`,'DELETE');
  await d.request(`/playback-requests/${key}`,'DELETE',undefined,410);
  await d.request('/playback-sessions','POST',{...body(),idempotency_key:key},410);
  check('cancel-before-create tombstone cannot be borrowed by another login');
  await b.request(`/playback-sessions/${pb.session_id}`,'DELETE');
 },{env:{PLAYBACK_SESSION_LIMIT:'32'}});
 report.cleanup=await fixture.verifyStopped();
 for(const input of binding.source)assert.equal(sha(await readFile(input.path)),input.sha256,'source unchanged after tests');
 report.result='passed';
}catch(error){failure=error;report.result='failed';report.error=String(error.stack??error);if(fixture)try{report.cleanup=await fixture.verifyStopped()}catch(e){report.cleanup_error=String(e)}}
finally{report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
