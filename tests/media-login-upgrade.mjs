// Real owned old Server issues grants, then the bound new Server applies 0041.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedMediaStack} from './fixtures/media-stack.mjs';
import {delay} from './fixtures/server.mjs';
import {mediaLoginPreflight} from '../scripts/media-login-preflight.mjs';
for(const k of ['W03_BACKEND_BINDING','RAINSYNC_OLD_AUTH_BINDING','RAINSYNC_OLD_AUTH_SERVER','RAINSYNC_ARTIFACT_DIR'])assert.ok(process.env[k],k);
const sha=b=>createHash('sha256').update(b).digest('hex');
const current=JSON.parse(await readFile(process.env.W03_BACKEND_BINDING,'utf8')),old=JSON.parse(await readFile(process.env.RAINSYNC_OLD_AUTH_BINDING,'utf8'));
const boundVersions=current.source.map(v=>/^migrations\/(\d+)_.*\.sql$/.exec(v.path)).filter(Boolean).map(v=>Number(v[1]));
const expectedVersion=Math.max(...boundVersions);assert.ok(expectedVersion>=41);
const originalFields=(actual,original)=>Object.fromEntries(Object.keys(original).map(key=>[key,actual[key]]));
const oldServer=resolve(process.env.RAINSYNC_OLD_AUTH_SERVER),newServer=current.binaries.find(v=>v.name==='rainsync-server').path;
const root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'media-login-upgrade',randomUUID());await mkdir(root,{recursive:true});
const report={result:'running',scope:'owned old-Server API grant issuance then real SQLx upgrade; no live accounts or historical identity invention',old_source_digest:old.source_digest,new_source_digest:current.source_digest,checks:[]};
const check=name=>{report.checks.push(name);console.log('PASS: '+name)};
let fixture,failure;
try {
 assert.equal(sha(await readFile(oldServer)),old.binaries.find(v=>v.name==='rainsync-server').sha256);
 assert.equal(sha(await readFile(newServer)),current.binaries.find(v=>v.name==='rainsync-server').sha256);
 for(const input of current.source)assert.equal(sha(await readFile(input.path)),input.sha256);
 await assert.rejects(mediaLoginPreflight(oldServer),/Unsafe Server cutover/);await mediaLoginPreflight(newServer);
 await isolatedMediaStack('media-login-upgrade',async f=>{
  fixture=f;const client=f.client();await client.login();await f.makeClip('legacy-login.mp4',{pictureSeconds:2});
  const src=await client.request('/sources','POST',{name:'owned upgrade media',kind:'local',config:{root:f.root}});await client.request(`/sources/${src.id}/test`,'POST');
  const media=(await client.request('/media')).find(m=>m.title.includes('legacy-login'));assert.ok(media);
  const room=await client.request('/rooms','POST',{name:'owned upgrade room'});
  f.sql(`UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media.id}"'),'{media_generation}','1') WHERE room_id='${room.id}'`);
  const body={room_id:room.id,media_generation:1,mode:'direct',position_ms:0,idempotency_key:randomUUID(),viewer_id:randomUUID(),plan_generation:1,playback_metrics_version:1,playback_metrics:{meter_start_generation:1,startup_origin:'user_intent'}};
  const grant=await client.request('/playback-sessions','POST',body);
  // Only shorten this disposable old grant before upgrade to exercise its real
  // near-expiry boundary; migration must retain that stored timestamp exactly.
  f.sql(`UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '15 seconds' WHERE id='${grant.session_id}'`);
  const before=JSON.parse(f.sql(`SELECT to_jsonb(p) FROM playback_sessions p WHERE id='${grant.session_id}'`));
  const oldMetrics=JSON.parse(f.sql(`SELECT to_jsonb(v) FROM playback_viewer_plans v WHERE viewer_id='${body.viewer_id}'`));
  const maxBefore=f.sql('SELECT max(version) FROM _sqlx_migrations');assert.ok(Number(maxBefore)<41);
  await f.startServer({},newServer);await f.startWorker();
  assert.equal(Number(f.sql('SELECT max(version) FROM _sqlx_migrations')),expectedVersion);
  const currentPid=f.serverPid;
  const applied=f.sql("SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m");
  const retained=f.sql(`SELECT to_jsonb(p) FROM playback_sessions p WHERE id='${grant.session_id}'`);
  await assert.rejects(mediaLoginPreflight(oldServer),/Unsafe Server cutover/);
  assert.equal(f.serverPid,currentPid,'the old binary was never installed or given DB credentials');
  assert.equal(f.sql("SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m"),applied);
  assert.equal(f.sql(`SELECT to_jsonb(p) FROM playback_sessions p WHERE id='${grant.session_id}'`),retained);
  await client.request('/auth/me');
  check('post0041 rollback preflight blocks old binary without changing DB/grant or replacing current Server');
  const after=JSON.parse(f.sql(`SELECT to_jsonb(p)-ARRAY['auth_login_hash','auth_membership_epoch'] FROM playback_sessions p WHERE id='${grant.session_id}'`));
  assert.deepEqual(originalFields(after,before),before);
  assert.equal(f.sql(`SELECT auth_login_hash IS NULL AND auth_membership_epoch IS NULL FROM playback_sessions WHERE id='${grant.session_id}'`),'t');
  for(const key of ['metrics_source_kind','metrics_delivery_mode','metrics_output_entry_availability','metrics_output_entry_queue_ms'])if(Object.hasOwn(after,key))assert.equal(after[key],null);
  if(Object.hasOwn(after,'metrics_output_entry_completed'))assert.equal(after.metrics_output_entry_completed,false);
  check('SQLx upgrade preserves every original grant field/ciphertext/deadline; added observation facts stay unknown');
  await client.request(`/playback-sessions/${grant.session_id}`);
  assert.equal((await client.request('/playback-sessions','POST',body)).session_id,grant.session_id);
  const otherLogin=f.client();await otherLogin.login();
  const freshKey=randomUUID();const blocked=await otherLogin.request('/playback-sessions','POST',{...body,idempotency_key:freshKey,plan_generation:2},409);
  assert.equal(blocked.error.code,'PLAYBACK_VIEWER_ORIGIN_REQUIRED');
  assert.equal(f.sql(`SELECT count(*) FROM playback_requests WHERE idempotency_key='${freshKey}'`),'0');
  assert.equal(f.sql(`SELECT auth_login_hash IS NULL AND plan_generation=1 FROM playback_viewer_plans WHERE viewer_id='${body.viewer_id}'`),'t');
  assert.deepEqual(originalFields(JSON.parse(f.sql(`SELECT to_jsonb(v) FROM playback_viewer_plans v WHERE viewer_id='${body.viewer_id}'`)),oldMetrics),oldMetrics);
  assert.equal(f.sql(`SELECT expires_at='${before.expires_at}'::timestamptz FROM playback_sessions WHERE id='${grant.session_id}'`),'t');
  check('other login cannot adopt legacy viewer/metrics intent: no creation or metrics/high-water/expiry mutation');
  const next=await client.request('/playback-sessions','POST',{...body,idempotency_key:randomUUID(),viewer_id:randomUUID()});
  assert.equal(f.sql(`SELECT auth_login_hash IS NOT NULL FROM playback_sessions WHERE id='${next.session_id}'`),'t');
  check('fresh authenticated request/viewer creates bound replacement without adopting old grant');
  let previous=Infinity;
  for(let n=0;n<4;n++){
   const result=await client.request(`/playback-sessions/${grant.session_id}`,'POST');
   assert.equal(result.ok,true);assert.equal(result.legacy_expiry_unchanged,true);
   assert.ok(result.expires_in_seconds>0&&result.expires_in_seconds<=previous);previous=result.expires_in_seconds;
   assert.equal(f.sql(`SELECT expires_at='${before.expires_at}'::timestamptz FROM playback_sessions WHERE id='${grant.session_id}'`),'t');
   await delay(250);
  }
  const response=await fetch(f.workerOrigin+grant.playback_url,{headers:{Range:'bytes=0-100'}});assert.equal(response.status,206);await response.arrayBuffer();
  check('legacy renewal200 acknowledges only unchanged remaining expiry and preserves existing delivery');
  const remaining=Number(f.sql(`SELECT GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp()))*1000) FROM playback_sessions WHERE id='${grant.session_id}'`));await delay(remaining+150);
  await client.request(`/playback-sessions/${grant.session_id}`,'POST',undefined,410);
  await client.request('/playback-sessions','POST',body,410);
  const expired=await fetch(f.workerOrigin+grant.playback_url);assert.equal(expired.status,401);await expired.arrayBuffer();
  await client.request(`/playback-sessions/${next.session_id}`);
  check('original deadline actually expires despite successful keepalives; new bound grant remains valid');
  await client.request(`/playback-sessions/${next.session_id}`,'DELETE');
 },{binary:oldServer});
 report.cleanup=await fixture.verifyStopped();report.result='passed';
}catch(error){failure=error;report.result='failed';report.error=String(error.stack??error);if(fixture)try{report.cleanup=await fixture.verifyStopped()}catch(e){report.cleanup_error=String(e)}}
finally{report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
