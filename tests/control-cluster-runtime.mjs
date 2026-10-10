// Disposable PostgreSQL and two real RainSync servers. No OS network changes.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {createWriteStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import WebSocket from 'ws';
import {isolatedServer,Client,delay} from './fixtures/server.mjs';
import {sourceMedia} from './fixtures/source-grant.mjs';
import {verifyClosedPort,verifyPidAbsent} from './fixtures/postgres.mjs';
import {reapOwnedChildren} from '../deploy/owned-process.mjs';
import {loadOwnerBinding,sha256} from '../scripts/native-owner-binding.mjs';
import {redactEvidence} from '../scripts/acceptance-runtime.mjs';
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p}
async function until(fn,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100)}throw Error(`Timeout: ${label}`)}
const report={schema_version:1,result:'running',checks:[],scope:'Owned loopback two-server PostgreSQL/HTTP/WS control acceptance; SIGSTOP partition; no OS network changes, production accounts, cross-host TLS or performance claim'};
const nodes=[randomUUID(),randomUUID()];let secondaryPort,fixture,secondary,secondaryOrigin;const children=new Set(),streams=[],sockets=new Set();let launches=0;
const repo=resolve(import.meta.dirname,'..');
const inputPaths=['tests/control-cluster-runtime.mjs','tests/fixtures/server.mjs','tests/fixtures/postgres.mjs','tests/fixtures/unused-port.mjs','tests/fixtures/source-grant.mjs','scripts/native-owner-binding.mjs','deploy/owned-process.mjs','scripts/acceptance-runtime.mjs'];
const inputSnapshot=()=>Promise.all(inputPaths.map(async path=>({path,sha256:sha256(await readFile(resolve(repo,path)))})));
let binding;const executableChecks=[],logPaths=[],logErrors=[],logStates=[];
function observeLog(stream,path){
 logPaths.push(path);const state={stream,path,finished:false,closed:false,failed:false};logStates.push(state);
 stream.on('finish',()=>state.finished=true);stream.on('close',()=>state.closed=true);
 stream.on('error',error=>{state.failed=true;logErrors.push(error);});return state;
}
function closeLog(state){
 return new Promise((resolve,reject)=>{
  let timer;const done=error=>{clearTimeout(timer);state.stream.off('finish',check);state.stream.off('close',check);state.stream.off('error',fail);error?reject(error):resolve();};
  const check=()=>{if(state.failed)done(Error('uncapped_log_write_failed'));else if(state.finished&&state.closed)done();};
  const fail=()=>done(Error('uncapped_log_write_failed'));
  if(state.failed)return reject(Error('uncapped_log_write_failed'));
  if(state.finished&&state.closed)return resolve();
  timer=setTimeout(()=>{state.failed=true;done(Error('uncapped_log_close_unconfirmed'));},5000);
  state.stream.on('finish',check);state.stream.on('close',check);state.stream.on('error',fail);
  if(!state.stream.writableEnded&&!state.stream.destroyed)state.stream.end(error=>{if(error){state.failed=true;logErrors.push(error);fail();}});
  check();
 });
}
function captureExecutable(pid,label){
 const entry={pid,label,result:'pending'};report.running_executables??=[];report.running_executables.push(entry);
 const check=readFile(`/proc/${pid}/exe`).then(bytes=>{entry.sha256=sha256(bytes);assert.equal(entry.sha256,report.server_binary_sha256);entry.result='verified';}).catch(error=>{entry.result='unconfirmed';entry.error='running_executable_binding_unconfirmed';return error;});
 executableChecks.push(check);return check;
}
async function verifyInputs(){await binding.verify();assert.deepEqual(await inputSnapshot(),report.coordinator);}
try {
 assert.equal(process.platform,'linux','Existing SIGSTOP/proc fixture requires Linux');assert.ok(!process.env.DATABASE_URL);
 binding=await loadOwnerBinding({root:repo,target:process.env.CARGO_TARGET_DIR,path:process.env.W03_BACKEND_BINDING});report.backend_binding=binding.summary;report.coordinator=await inputSnapshot();
 await isolatedServer('control-cluster-runtime',async f=>{
  fixture=f;await verifyInputs();
  assert.equal(createHash('sha256').update(await readFile(resolve(f.target,'rainsync-server'))).digest('hex'),report.server_binary_sha256,'server binary unchanged after primary launch');
  try {
  const launch=(extra)=>{
   const label=`extra-node-${++launches}`,path=resolve(f.root,`${label}.log`),log=createWriteStream(path);streams.push(log);observeLog(log,path);
   const child=spawn(resolve(f.target,'rainsync-server'),[],{env:{...f.env,...extra},stdio:['ignore','pipe','pipe']});
   const record={child,closed:new Promise(r=>child.once('close',(code,signal)=>{record.exit={code,signal,observed_close:true};r({code,signal});})),wasStopped:false};
   // The error listener is installed before any asynchronous evidence work.
   child.on('error',error=>{record.spawn_error='extra_server_spawn_failed';logErrors.push(error);});
   const liveCheck=new Promise(resolve=>{
    child.once('spawn',()=>resolve(captureExecutable(child.pid,label)));
    child.once('error',error=>{report.running_executables??=[];report.running_executables.push({pid:child.pid??null,label,result:'unconfirmed',error:'running_executable_spawn_failed'});resolve(error);});
   });
   executableChecks.push(liveCheck);children.add(record);child.stdout?.pipe(log,{end:false});child.stderr?.pipe(log,{end:false});return record;
  };
  const secondaryClient=primary=>{const client=new Client({...f,origin:secondaryOrigin});client.cookie=primary.cookie;client.csrf=primary.csrf;return client};
  async function socket(origin,client,room,resume){const ws=new WebSocket(origin.replace('http','ws')+'/api/v1/ws',{headers:{Cookie:client.cookie,Origin:f.origin},maxPayload:1048576});sockets.add(ws);const messages=[];let closed=false;ws.on('message',data=>{try{messages.push(JSON.parse(data))}catch{}});ws.on('error',()=>{});ws.on('close',()=>closed=true);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});ws.send(JSON.stringify(resume??{type:'JOIN',room_id:room}));const snapshot=await until(()=>messages.find(m=>m.type==='SNAPSHOT'),'WS snapshot');return{ws,messages,snapshot,get closed(){return closed},wait:predicate=>until(()=>messages.find(predicate),'WS message')};}
  const admin=f.client();const adminUser=await admin.login();
  secondary=launch({BIND:`127.0.0.1:${secondaryPort}`,RAINSYNC_CONTROL_NODE_ID:nodes[1],RAINSYNC_CONTROL_ROLE:'control'});
  await until(async()=>{assert.equal(secondary.child.exitCode,null,'secondary node stays alive');try{return(await fetch(secondaryOrigin+'/ready')).ok}catch{return false}},'secondary ready');
  const viaSecondary=secondaryClient(admin);
  await viaSecondary.request('/agents','GET',undefined,503);
  await viaSecondary.request('/platform-accounts/youtube','GET',undefined,503);
  assert.equal((await fetch(secondaryOrigin+'/_rainsync/control/ws/'+randomUUID())).status,403);
  report.checks.push('secondary starts alongside retained single media advisory owner; agent/OAuth/media routes fail closed; private peer endpoint rejects anonymous requests');
  const room=(await viaSecondary.request('/rooms','POST',{name:'control node room'})).id;
  assert.equal(f.sql(`SELECT owner_node FROM room_leases WHERE room_id=${quote(room)}`),nodes[1]);
  const balanced=[];
  for(let i=0;i<2;i++)balanced.push((await admin.request('/rooms','POST',{name:`public gateway balance ${i}`})).id);
  assert.equal(f.sql(`SELECT count(DISTINCT owner_node) FROM room_leases WHERE room_id IN (${balanced.map(quote).join(',')})`),'2');
  report.checks.push('one public gateway creates rooms across both live allowlisted control owners; creation has no unsafe retry after an unknown remote outcome');
  const controlClosing=balanced[1];
  const initialClosing=await admin.request(`/rooms/${controlClosing}/lifecycle`);
  await admin.request(`/rooms/${controlClosing}/close`,'POST',{expected_revision:initialClosing.state.revision});
  const controlClosed=await until(async()=>{const value=await admin.request(`/rooms/${controlClosing}/lifecycle`);return value.lifecycle==='closed'?value:null},'control-only positive receipt reconciliation');
  assert.equal(f.sql(`SELECT owner_node FROM room_leases WHERE room_id=${quote(controlClosing)}`),nodes[1]);
  await admin.request(`/rooms/${controlClosing}/reopen`,'POST',{expected_revision:controlClosed.state.revision});
  report.checks.push('live control-only owner independently reconciles positive database receipts to closed and can reopen through the public gateway');
  // Guest admission commits on the remote room owner, but its only login
  // credential must reach the browser through the public media gateway.
  const settingsBeforeGuest=await admin.request('/admin/settings');
  await admin.request('/admin/settings','PATCH',{expected_revision:settingsBeforeGuest.revision,changes:{guests_enabled:true}});
  await admin.request(`/rooms/${controlClosing}/guest-access`,'PUT',{enabled:true});
  const guestInvite=await admin.request(`/rooms/${controlClosing}/invites`,'POST',{max_uses:1});
  const guest=f.client();
  const guestResponse=await guest.raw(`/rooms/${controlClosing}/guest-session`,{method:'POST',body:{token:guestInvite.token,display_name:'Cluster guest'}});
  assert.equal(guestResponse.status,201,'remote owner creates the guest through the public gateway');
  const guestCookie=guestResponse.headers.get('set-cookie');
  assert.ok(guestCookie?.startsWith('rainsync_session='),'gateway preserves the guest login cookie');
  assert.ok(guestCookie.includes('HttpOnly')&&guestCookie.includes('SameSite=Strict')&&guestCookie.includes('Max-Age=7200'),'gateway preserves guest cookie restrictions');
  const guestIdentity=await guestResponse.json();guest.csrf=guestIdentity.csrf;
  assert.equal((await guest.request('/auth/me')).id,guestIdentity.id,'guest cookie authenticates at the public media authority');
  assert.equal((await secondaryClient(guest).request('/auth/me')).id,guestIdentity.id,'the same guest login authenticates at its room owner');
  assert.deepEqual((await guest.request('/rooms')).map(value=>value.id),[controlClosing]);
  await guest.request(`/rooms/${controlClosing}/guest-session`,'POST',{token:guestInvite.token},409);
  assert.equal(f.sql(`SELECT use_count FROM invites WHERE id=${quote(guestInvite.id)}`),'1','retry with the established cookie consumes no second invitation use');
  assert.equal(f.sql(`SELECT count(*) FROM guest_principals WHERE room_id=${quote(controlClosing)}`),'1','forwarded admission creates exactly one guest identity');
  await admin.request(`/rooms/${controlClosing}/members/${guestIdentity.id}`,'DELETE');
  await guest.request('/auth/me','GET',undefined,401);
  assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(controlClosing)}`),'1','remote owner removes only the temporary guest membership');
  // Distinct loopback clients use real source sockets; no proxy-header trust
  // or host network configuration is added to this disposable two-node fixture.
  const guestRateHeader='x-rainsync-control-guest-rate-identity';
  const guestAttempt=(origin,source,body,headers={})=>new Promise((resolve,reject)=>{
   const request=httpRequest(new URL(`/api/v1/rooms/${controlClosing}/guest-session`,origin),{
    method:'POST',localAddress:source,agent:false,
    signal:AbortSignal.any([f.abortSignal,AbortSignal.timeout(20000)]),
    headers:{Origin:f.origin,'Content-Type':'application/json',...headers},
   },response=>{
    let data='';response.setEncoding('utf8');response.on('data',chunk=>data+=chunk);
    response.on('error',reject);response.on('end',()=>{
     try{resolve({status:response.statusCode,headers:response.headers,body:JSON.parse(data)})}catch(error){reject(error)}
    });
   });
   request.on('error',reject);request.end(JSON.stringify(body));
  });
  const sourceA='127.0.0.2',sourceB='127.0.0.3';
  const guestRateKey=source=>createHash('sha256').update('account-rate:guest-entry:'+source).digest('hex');
  const attempts=source=>Number(f.sql(`SELECT COALESCE((SELECT attempts FROM account_rate_limits WHERE scope='guest-entry' AND key_hash=${quote(guestRateKey(source))}),0)`));
  const admissionBefore=f.sql(`SELECT json_build_array((SELECT count(*) FROM guest_principals WHERE room_id=${quote(controlClosing)}),(SELECT count(*) FROM sessions),(SELECT count(*) FROM room_members WHERE room_id=${quote(controlClosing)}))`);
  for(let attempt=0;attempt<10;attempt++){
   const result=await guestAttempt(attempt%2===0?f.origin:secondaryOrigin,sourceA,{token:'invalid'},{
    [guestRateHeader]:createHash('sha256').update(`untrusted-${attempt}`).digest('hex'),
    'X-Forwarded-For':`198.51.100.${attempt+1}`,
   });
   assert.equal(result.status,403,'invalid invitation remains denied before the fixed-window limit');
   assert.equal(result.body.error.code,'INVALID_INVITE');
   assert.equal(attempts(sourceA),attempt+1,'direct owner and forwarded gateway share the original source bucket; spoofed headers cannot select a new bucket');
  }
  for(const origin of [f.origin,secondaryOrigin]){
   const limited=await guestAttempt(origin,sourceA,{token:guestInvite.token},{[guestRateHeader]:'b'.repeat(64),'X-Forwarded-For':'203.0.113.9'});
   assert.equal(limited.status,429,'the exhausted source stays limited through either gateway despite browser-supplied identity');
   assert.ok(Number(limited.headers['retry-after'])>0);
  }
  assert.equal(attempts(sourceA),11,'attempt storage remains capped at the existing ceiling');
  const independent=await guestAttempt(f.origin,sourceB,{token:'invalid'},{[guestRateHeader]:'b'.repeat(64),'X-Forwarded-For':'203.0.113.9'});
  assert.equal(independent.status,403,'another client behind the same forwarding node has its own allowance');
  assert.equal(independent.body.error.code,'INVALID_INVITE');
  assert.equal(attempts(sourceB),1);
  const expiredUse=await guestAttempt(secondaryOrigin,sourceB,{token:guestInvite.token});
  assert.equal(expiredUse.status,403,'rate identity does not bypass the one-use invitation admission gate');
  assert.equal(attempts(sourceB),2);
  const peerRejected=await guestAttempt(f.origin,sourceB,{token:'invalid'},{
   'x-rainsync-control-peer':nodes[1],'x-rainsync-control-secret':'not-the-fixture-peer-secret',[guestRateHeader]:'c'.repeat(64),
  });
  assert.equal(peerRejected.status,403,'an untrusted caller cannot activate peer context by naming an allowlisted node');
  assert.equal(attempts(sourceB),2,'rejected peer headers never reach guest admission');
  assert.equal(f.sql(`SELECT use_count FROM invites WHERE id=${quote(guestInvite.id)}`),'1');
  assert.equal(f.sql(`SELECT json_build_array((SELECT count(*) FROM guest_principals WHERE room_id=${quote(controlClosing)}),(SELECT count(*) FROM sessions),(SELECT count(*) FROM room_members WHERE room_id=${quote(controlClosing)}))`),admissionBefore,'failed admissions issue no guest identities, sessions or memberships');
  report.checks.push('distinct original socket clients retain independent guest admission buckets across two gateways; direct and forwarded attempts share one source window, forged source/XFF/peer headers cannot evade limits, and invite/session/membership gates remain enforced');
  const settingsAfterGuest=await admin.request('/admin/settings');
  await admin.request('/admin/settings','PATCH',{expected_revision:settingsAfterGuest.revision,changes:{guests_enabled:false}});
  report.checks.push('remote-owner guest entry forwards its HttpOnly cookie; public and owner authentication restore one scoped identity, retry spends one invite use only, and owner removal revokes it');
  const createKey=randomUUID(),createBody={name:'same creation key across control gateways'};
  const createHeaders={'Idempotency-Key':createKey};
  const firstCreated=await admin.request('/rooms','POST',createBody,200,createHeaders);
  const secondaryReplay=await viaSecondary.request('/rooms','POST',createBody,200,createHeaders);
  const primaryReplay=await admin.request('/rooms','POST',createBody,200,createHeaders);
  assert.equal(secondaryReplay.id,firstCreated.id,'secondary gateway preserves the original per-account creation key');
  assert.equal(primaryReplay.id,firstCreated.id,'round-robin forwarding preserves the same key when primary selects a remote owner');
  assert.equal(f.sql(`SELECT count(*) FROM rooms WHERE owner_id=${quote(adminUser.id)} AND name=${quote(createBody.name)}`),'1');
  assert.equal(f.sql(`SELECT count(*) FROM room_creation_requests WHERE user_id=${quote(adminUser.id)} AND request_key=${quote(createKey)}`),'1');
  for(const gateway of [admin,viaSecondary,admin]){
   const conflict=await gateway.request('/rooms','POST',{name:createBody.name+' changed'},409,createHeaders);
   assert.equal(conflict.error.code,'INVALID_REQUEST','payload conflict retains the public error code across local and forwarded handlers');
  }
  assert.equal(f.sql(`SELECT count(*) FROM rooms WHERE owner_id=${quote(adminUser.id)} AND name=${quote(createBody.name+' changed')}`),'0');
  report.checks.push('the same account creation key replays one durable room through both gateways and alternating room routes; conflicting payloads return 409 without a second room');
  const media=sourceMedia(f,{kind:'local',root:f.root,resource:'cluster-control-fixture.mp4'});
  f.sql(`UPDATE media_items SET duration_ms=900000 WHERE id=${quote(media)}`);
  await admin.request('/users','POST',{username:'cluster-member',password:f.password});const viewer=f.client();const viewerUser=await viewer.login('cluster-member',f.password);
  const invite=await admin.request(`/rooms/${room}/invites`,'POST');await viewer.request(`/rooms/${room}/join`,'POST',{token:invite.token});
  assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(room)}`),'2');
  report.checks.push('room created on control owner; primary gateway forwards invite and member join preserving ordinary login/Origin/CSRF gates');
  const viewerCreated=await viewer.request('/rooms','POST',createBody,200,createHeaders);
  assert.notEqual(viewerCreated.id,firstCreated.id,'another authenticated account has a separate creation result for the same request key');
  const viewerReplay=await secondaryClient(viewer).request('/rooms','POST',createBody,200,createHeaders);
  assert.equal(viewerReplay.id,viewerCreated.id);
  assert.equal(f.sql(`SELECT count(*) FROM room_creation_requests WHERE request_key=${quote(createKey)} AND user_id IN (${quote(adminUser.id)},${quote(viewerUser.id)})`),'2');
  report.checks.push('creation-key isolation remains per account across the control gateways');
  // A global account tombstone spans rooms with two different physical owners.
  // Keep the ordinary viewer alive to prove cleanup is scoped to the exited user.
  await admin.request('/users','POST',{username:'cluster-exit',password:f.password});
  const exitClient=f.client(),exitUser=await exitClient.login('cluster-exit',f.password);
  const exitOtherLogin=f.client();await exitOtherLogin.login('cluster-exit',f.password);
  const exitViaSecondary=secondaryClient(exitClient),exitInvites=[];
  const exitRoomOwners=balanced.map(id=>f.sql(`SELECT owner_node FROM room_leases WHERE room_id=${quote(id)}`));
  assert.equal(new Set(exitRoomOwners).size,2);
  for(const id of balanced){
   const ownedInvite=await admin.request(`/rooms/${id}/invites`,'POST');
   for(const member of [exitClient,viewer])await member.request(`/rooms/${id}/join`,'POST',{token:ownedInvite.token});
   await viaSecondary.request(`/rooms/${id}/permissions/${exitUser.id}`,'PUT',{role:'moderator',permissions:['invite']});
   assert.equal(f.sql(`SELECT room_permission_allowed(${quote(id)},${quote(exitUser.id)},'invite')`),'t');
   const policy=await exitViaSecondary.request(`/rooms/${id}/permissions`);
   assert.deepEqual(policy.self_permissions,['invite'],'new permission routes forward through either gateway to the room owner');
   exitInvites.push(await exitViaSecondary.request(`/rooms/${id}/invites`,'POST',{expires_in_seconds:3600,max_uses:2}));
   assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(id)}`),'3');
  }
  const exited=await exitClient.request('/users/me/deletion','POST',{password:f.password,confirmation:'DELETE'});
  assert.equal(exited.ok,true,'account exit is global and does not require one transaction to own both rooms');
  assert.equal(f.sql(`SELECT account_active(${quote(exitUser.id)})`),'f');
  assert.equal(f.sql(`SELECT count(*) FROM sessions WHERE user_id=${quote(exitUser.id)}`),'0');
  await exitOtherLogin.request('/auth/me','GET',undefined,401);
  await exitViaSecondary.request('/auth/me','GET',undefined,401);
  for(let index=0;index<balanced.length;index++){
   const id=balanced[index];
   assert.equal(f.sql(`SELECT room_permission_allowed(${quote(id)},${quote(exitUser.id)},'invite')`),'f','logical delegation is revoked before owner cleanup is required');
   const rejected=await viewer.request(`/rooms/${id}/join`,'POST',{token:exitInvites[index].token},403);
   assert.equal(rejected.error.code,'INVALID_INVITE','a tombstoned creator cannot authorize a fresh or repeated join under the current generated public error contract');
  }
  await until(()=>f.sql(`SELECT count(*) FROM account_exit_room_cleanup WHERE user_id=${quote(exitUser.id)}`)==='0','both room owners drain durable account-exit cleanup');
  for(let index=0;index<balanced.length;index++){
   const id=balanced[index];
   assert.equal(f.sql(`SELECT owner_node FROM room_leases WHERE room_id=${quote(id)}`),exitRoomOwners[index],'cleanup respects the existing live room owner');
   assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(id)} AND user_id=${quote(exitUser.id)}`),'0');
   assert.equal(f.sql(`SELECT count(*) FROM room_member_permissions WHERE room_id=${quote(id)} AND (user_id=${quote(exitUser.id)} OR granted_by=${quote(exitUser.id)})`),'0');
   assert.equal(f.sql(`SELECT revoked FROM invites WHERE room_id=${quote(id)} AND id=${quote(exitInvites[index].id)}`),'t');
   assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(id)} AND user_id IN (${quote(adminUser.id)},${quote(viewerUser.id)})`),'2','other members survive account cleanup');
  }
  report.checks.push('global account exit immediately revokes all logins, delegation and creator invitations across two live room owners; durable owner-fenced cleanup removes only the exited memberships and grants without taking over either lease');
  // Requeue only already-revoked cleanup receipts. Hold one queue row while
  // proving the other owner can finish before the lock is released.
  const queueLockTag='account_queue_lock_'+randomUUID().replaceAll('-','');
  const heldRoom=balanced[0],freeRoom=balanced[1];
  const queueLock=f.sqlProcess(`SET application_name=${quote(queueLockTag)}; BEGIN;
   INSERT INTO account_exit_room_cleanup(room_id,user_id) VALUES(${quote(heldRoom)},${quote(exitUser.id)}),(${quote(freeRoom)},${quote(exitUser.id)});
   COMMIT; BEGIN; SELECT user_id FROM account_exit_room_cleanup WHERE room_id=${quote(heldRoom)} AND user_id=${quote(exitUser.id)} FOR UPDATE;
   SELECT pg_sleep(12); COMMIT;`);
  try {
   await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(queueLockTag)} AND wait_event='PgSleep'`,'1');
   assert.equal(f.sql(`SELECT count(*) FROM account_exit_room_cleanup WHERE room_id=${quote(heldRoom)} AND user_id=${quote(exitUser.id)}`),'1');
   await until(()=>f.sql(`SELECT count(*) FROM account_exit_room_cleanup WHERE room_id=${quote(freeRoom)} AND user_id=${quote(exitUser.id)}`)==='0','unlocked account-exit receipt drains while another queue row is locked',10000);
   assert.equal(f.sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(queueLockTag)} AND wait_event='PgSleep'`),'1','the second cleanup finishes before the first queue lock is released');
   assert.equal(f.sql(`SELECT count(*) FROM account_exit_room_cleanup WHERE room_id=${quote(heldRoom)} AND user_id=${quote(exitUser.id)}`),'1');
  } finally {
   f.sql(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name=${quote(queueLockTag)}`);
   await queueLock.done.catch(()=>{});
   await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(queueLockTag)}`,'0');
  }
  await until(()=>f.sql(`SELECT count(*) FROM account_exit_room_cleanup WHERE user_id=${quote(exitUser.id)}`)==='0','previously locked account-exit receipt drains after release');
  for(const id of balanced)assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(id)} AND user_id IN (${quote(adminUser.id)},${quote(viewerUser.id)})`),'2','queue contention cannot revoke unrelated members');
  report.checks.push('atomic queue rotation skips a row held by an owned PostgreSQL transaction; the other live room owner completes independently, and the held receipt retries after lock release');
  // Complete real peer handshake/forwarding baseline; separate ordinary account.
  await admin.request('/users','POST',{username:'peer-lifetime',password:f.password});
  const peerClient=f.client(),peerUser=await peerClient.login('peer-lifetime',f.password);
  const peerInvite=await admin.request(`/rooms/${room}/invites`,'POST');
  await peerClient.request(`/rooms/${room}/join`,'POST',{token:peerInvite.token});
  const peerLogin=f.sql(`SELECT token_hash FROM sessions WHERE user_id=${quote(peerUser.id)}`);
  assert.match(peerLogin,/^[0-9a-f]{64}$/);
  const privateHeaders={'x-rainsync-control-peer':nodes[0],'x-rainsync-control-secret':f.env.RAINSYNC_CONTROL_PEER_TOKEN,'x-rainsync-control-user':peerUser.id,'x-rainsync-control-session':peerLogin};
  async function privateUpgrade(headers,expected,code){
   const ws=new WebSocket(secondaryOrigin.replace('http','ws')+'/_rainsync/control/ws/'+room,{headers});sockets.add(ws);
   let accepted=false,primaryFailed=false,primaryError;
   ws.on('error',()=>{});
   try {
    const outcome=await new Promise((resolve,reject)=>{
     let settled=false,response;
     const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);ws.off('error',failed);ws.off('close',closed);if(error){response?.destroy();reject(error);}else resolve(value);};
     const failed=error=>finish(error),closed=()=>finish(Error('private_upgrade_closed_without_result'));
     const timer=setTimeout(()=>finish(Error('private_upgrade_observation_timeout')),20000);
     ws.once('error',failed);ws.once('close',closed);
     ws.once('open',()=>finish(null,{status:101}));
     ws.once('unexpected-response',(_request,incoming)=>{response=incoming;let text='';incoming.on('data',chunk=>text+=chunk);incoming.once('end',()=>{try{finish(null,{status:incoming.statusCode,value:JSON.parse(text)});}catch(error){finish(error);}});incoming.once('error',failed);incoming.once('aborted',()=>finish(Error('private_upgrade_response_aborted')));});
    });
    assert.equal(outcome.status,expected);if(code)assert.equal(outcome.value?.error?.code,code);
    if(expected!==101){ws.terminate();await until(()=>ws.readyState===WebSocket.CLOSED,'rejected private socket close');}
    accepted=expected===101;
   report.peer_lifetime??={handshakes:[]};report.peer_lifetime.handshakes.push({status:outcome.status,code:outcome.value?.error?.code??null});
   return ws;
   } catch(error){primaryFailed=true;primaryError=error;throw error;} finally {if(!accepted){try{ws.terminate();await until(()=>ws.readyState===WebSocket.CLOSED,'private handshake cleanup close');}catch(error){if(primaryFailed)throw new AggregateError([primaryError,error],'private_upgrade_and_cleanup_failed');throw error;}}}
  }
  const privatePeer=await privateUpgrade(privateHeaders,101);
  let privateSnapshot,privateMessageError;privatePeer.on('message',data=>{try{const value=JSON.parse(data);if(value.type==='SNAPSHOT')privateSnapshot=value;}catch(error){privateMessageError=error;}});
  privatePeer.send(JSON.stringify({type:'JOIN',room_id:room}));
  await until(()=>{if(privateMessageError)throw privateMessageError;return privateSnapshot;},'private peer authenticated snapshot');
  privatePeer.close();await until(()=>privatePeer.readyState===WebSocket.CLOSED,'private peer positive close');
  await privateUpgrade({...privateHeaders,'x-rainsync-control-secret':'invalid'},403,'FORBIDDEN');
  await privateUpgrade({...privateHeaders,'x-rainsync-control-user':'invalid'},403,'FORBIDDEN');
  await privateUpgrade({...privateHeaders,'x-rainsync-control-session':'invalid'},403,'FORBIDDEN');
  const forwarded=await socket(f.origin,peerClient,room);
  assert.equal(forwarded.snapshot.state.revision,privateSnapshot.state.revision,'private and forwarded identity see same owner snapshot');
  let pong;forwarded.ws.once('pong',bytes=>pong=bytes.toString());forwarded.ws.ping('peer-owned-ping');
  await until(()=>pong==='peer-owned-ping','forwarded websocket pong');
  forwarded.ws.close();await until(()=>forwarded.closed,'forwarded positive close');
  await admin.request(`/rooms/${room}/members/${peerUser.id}`,'DELETE');
  await privateUpgrade(privateHeaders,403,'SESSION_EXPIRED');
  const renewedInvite=await admin.request(`/rooms/${room}/invites`,'POST');
  await peerClient.request(`/rooms/${room}/join`,'POST',{token:renewedInvite.token});
  assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(room)} AND user_id=${quote(peerUser.id)}`),'1');
  // Expiry is lawful fixture mutation of this account's real login, not SQL auth success.
  f.sql(`UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=${quote(peerUser.id)}`);
  await privateUpgrade(privateHeaders,403,'SESSION_EXPIRED');
  assert.equal(secondary.child.exitCode,null,'owner remains running throughout peer lifetime cases');
  report.checks.push('real configured peer handshake and forwarded ordinary identity, snapshot, client ping/pong and positive close; malformed credentials and removed/expired identity rejected');
  let a=await socket(f.origin,admin,room),b=await socket(secondaryOrigin,viaSecondary,room);
  const make=(state,type,payload)=>({protocol_version:1,command_id:randomUUID(),control_epoch:a.snapshot.control_epoch.id,room_id:room,expected_revision:state.revision,media_generation:state.media_generation,type,...payload});
  let command=make(a.snapshot.state,'CHANGE_MEDIA',{payload:{media_id:media}});a.ws.send(JSON.stringify(command));let ack=await a.wait(m=>m.type==='ACK'&&m.command_id===command.command_id);
  assert.equal(ack.state.media_id,media);
  const play=make(ack.state,'PLAY');a.ws.send(JSON.stringify(play));b.ws.send(JSON.stringify(play));const playAck=await a.wait(m=>m.type==='ACK'&&m.command_id===play.command_id);await b.wait(m=>m.type==='ACK'&&m.command_id===play.command_id);
  assert.equal(f.sql(`SELECT count(*) FROM command_results WHERE room_id=${quote(room)} AND command_id=${quote(play.command_id)}`),'1');
  assert.equal(f.sql(`SELECT count(*) FROM room_events WHERE room_id=${quote(room)} AND revision=${playAck.state.revision}`),'1');
  assert.equal(a.messages.filter(m=>m.type==='EVENT'&&m.state?.revision===playAck.state.revision).length,1);
  report.checks.push('two live gateways route to one room actor; identical original command IDs yield one durable commit/event and safe idempotent ACK replay');
  await delay(6500);
  const checkpoint=JSON.parse(f.sql(`SELECT json_build_object('position',checkpoint_position_ms,'revision',checkpoint_revision,'generation',checkpoint_generation,'epoch',checkpoint_clock_epoch,'fence',fencing_token) FROM room_leases WHERE room_id=${quote(room)}`));
  report.checkpoint_before_partition=checkpoint;
  assert.ok(checkpoint.position>=4000,'continuous playing without a recent command checkpoints real progress');assert.equal(checkpoint.revision,playAck.state.revision);
  const pending=make(playAck.state,'PAUSE');
  secondary.child.kill('SIGSTOP');secondary.wasStopped=true;
  b.ws.send(JSON.stringify(pending));
  await delay(11200);
  const recoveryClient=f.client();recoveryClient.cookie=admin.cookie;recoveryClient.csrf=admin.csrf;
  const recovered=await socket(f.origin,recoveryClient,room,{type:'RESUME',room_id:room,revision:playAck.state.revision,clock_epoch:playAck.state.clock_epoch});
  report.takeover={revision:recovered.snapshot.state.revision,position_ms:recovered.snapshot.state.anchor_position_ms,recovery:recovered.snapshot.recovery};
  assert.equal(recovered.snapshot.state.playback_status,'paused');assert.notEqual(recovered.snapshot.state.clock_epoch,playAck.state.clock_epoch);
  assert.equal(recovered.snapshot.recovery,'snapshot');
  assert.ok(recovered.snapshot.state.anchor_position_ms>=checkpoint.position);
  assert.ok(recovered.snapshot.state.anchor_position_ms<15000,'takeover pauses at confirmed progress, not wall-clock/SIGSTOP elapsed time');
  assert.equal(f.sql(`SELECT owner_node FROM room_leases WHERE room_id=${quote(room)}`),nodes[0]);
  assert.notEqual(f.sql(`SELECT fencing_token FROM room_leases WHERE room_id=${quote(room)}`),String(checkpoint.fence));
  recovered.ws.send(JSON.stringify(play));await recovered.wait(m=>m.type==='ACK'&&m.command_id===play.command_id);
  assert.equal(f.sql(`SELECT count(*) FROM command_results WHERE room_id=${quote(room)} AND command_id=${quote(play.command_id)}`),'1');
  report.checks.push('SIGSTOP owner partition expires lease; gateway reconnect resumes by committed snapshot; new token; honest pause at revision/generation/epoch-matched checkpoint; prior ACK persists and replays without recommit');
  secondary.child.kill('SIGCONT');secondary.wasStopped=false;
  await delay(3000);
  assert.equal(f.sql(`SELECT count(*) FROM command_results WHERE room_id=${quote(room)} AND command_id=${quote(pending.command_id)}`),'0');
  assert.equal(b.messages.filter(m=>m.type==='ACK'&&m.command_id===pending.command_id).length,0);
  assert.equal(f.sql(`SELECT owner_node FROM room_leases WHERE room_id=${quote(room)}`),nodes[0]);
  report.checks.push('old owner resumes with client still connected and queued command; exact old fence rejects commit and emits no successful ACK');
  const lifecycle=await viaSecondary.request(`/rooms/${room}/lifecycle`);
  await viaSecondary.request(`/rooms/${room}/close`,'POST',{expected_revision:lifecycle.state.revision});
  await until(async()=>(await admin.request(`/rooms/${room}/lifecycle`)).lifecycle==='closed','positive DB-only room close');
  const closed=await admin.request(`/rooms/${room}/lifecycle`);await viaSecondary.request(`/rooms/${room}/reopen`,'POST',{expected_revision:closed.state.revision});
  assert.equal((await admin.request(`/rooms/${room}/lifecycle`)).lifecycle,'active');
  await viaSecondary.request(`/rooms/${room}/timeline/moderation`,'POST',{action:'remove',target_user_id:viewerUser.id,reason:'owned cluster fixture'});
  assert.equal(f.sql(`SELECT count(*) FROM room_members WHERE room_id=${quote(room)} AND user_id=${quote(viewerUser.id)}`),'0');
  report.checks.push('closing/reopen REST forwards through owner; positive receipt reconciliation reaches closed; membership removal mutates only at owner');
  await admin.raw(`/rooms/${room}/lifecycle`,{headers:{'x-rainsync-control-peer':nodes[1],'x-rainsync-control-secret':'forged-peer-token'}}).then(r=>assert.equal(r.status,403));
  const originalOrigin=f.sql(`SELECT route_origin FROM control_nodes WHERE id=${quote(nodes[0])}`);f.sql(`UPDATE control_nodes SET route_origin='https://untrusted.example' WHERE id=${quote(nodes[0])}`);
  await delay(350);await viaSecondary.request(`/rooms/${room}/lifecycle`,'GET',undefined,503);f.sql(`UPDATE control_nodes SET route_origin=${quote(originalOrigin)} WHERE id=${quote(nodes[0])}`);
  report.checks.push('forged peer headers cannot bypass auth; database-injected route outside configured origin allowlist never receives user cookies or peer token');
  const legacy=launch({BIND:'127.0.0.1:0',RAINSYNC_CONTROL_CLUSTER:'0'});const legacyExit=await legacy.closed;assert.notEqual(legacyExit.code,0);
  assert.throws(()=>f.sql(`UPDATE room_snapshots SET state=state WHERE room_id=${quote(room)}`),/room_owner_lost/);
  report.checks.push('persisted activation refuses unconfigured startup and blocks unfenced old-pool room writes');
  // Existing node-ID restart is a new process incarnation. Its pool identity and
  // every acquired fence must be new; a delayed old connection cannot revive.
  const incarnation=f.sql(`SELECT incarnation FROM control_nodes WHERE id=${quote(nodes[1])}`);
  secondary.child.kill('SIGTERM');await secondary.closed;secondary=launch({BIND:`127.0.0.1:${secondaryPort}`,RAINSYNC_CONTROL_NODE_ID:nodes[1],RAINSYNC_CONTROL_ROLE:'control'});
  await until(async()=>{try{return(await fetch(secondaryOrigin+'/ready')).ok}catch{return false}},'secondary restart');
  assert.notEqual(f.sql(`SELECT incarnation FROM control_nodes WHERE id=${quote(nodes[1])}`),incarnation);
  report.checks.push('gateway restart preserves durable room owner/replay history; stable node ID receives a distinct process incarnation');
  assert.equal(createHash('sha256').update(await readFile(resolve(f.target,'rainsync-server'))).digest('hex'),report.server_binary_sha256,'server binary unchanged for entire two-node fixture');
  for(const error of await Promise.all(executableChecks))if(error)throw error;await verifyInputs();
  report.result='passed';
  } finally {
   for(const ws of sockets)ws.terminate();
   for(const record of children)if(record.wasStopped){record.child.kill('SIGCONT');record.wasStopped=false;}
   await reapOwnedChildren([...children]);
  }
 },{observeServerLog:observeLog,beforeStart:async f=>{fixture=f;const originalStart=f.startServer.bind(f);let primaryLaunch=0;f.startServer=async(...args)=>{const label=`primary-${++primaryLaunch}`;let value;try{value=await originalStart(...args);}catch(error){report.running_executables??=[];report.running_executables.push({pid:f.serverPid??null,label,result:'unconfirmed',error:'primary_start_executable_unconfirmed'});throw error;}const error=await captureExecutable(f.serverPid,label);if(error)throw error;return value;};report.server_binary_sha256=createHash('sha256').update(await readFile(resolve(f.target,'rainsync-server'))).digest('hex');assert.equal(report.server_binary_sha256,binding.summary.binaries.find(item=>item.name==='rainsync-server').sha256);await verifyInputs();secondaryPort=await port();secondaryOrigin=`http://127.0.0.1:${secondaryPort}`;Object.assign(f.env,{TRUSTED_PROXY_CIDRS:'',RAINSYNC_CONTROL_CLUSTER:'1',RAINSYNC_CONTROL_NODE_ID:nodes[0],RAINSYNC_CONTROL_ROLE:'media',RAINSYNC_CONTROL_NODES:JSON.stringify({[nodes[0]]:f.origin,[nodes[1]]:secondaryOrigin}),RAINSYNC_CONTROL_PEER_TOKEN:randomBytes(32).toString('hex')})},signal:AbortSignal.timeout(150000)});
 report.cleanup=await fixture.verifyStopped();
}catch(error){report.result='failed';report.error=String(error);throw error}
finally {
 const evidenceErrors=[];
 const attempt=async(name,run)=>{try{await run();}catch(error){evidenceErrors.push({phase:name,message:String(error)});report.result='failed';process.exitCode=1;}};
 await attempt('socket_close',async()=>{for(const ws of sockets)ws.terminate();});
 await attempt('resume_stopped_children',async()=>{for(const record of children)if(record.wasStopped)record.child.kill('SIGCONT');});
 await attempt('extra_reap',()=>reapOwnedChildren([...children]));
 for(const state of logStates)await attempt('uncapped_log_finish_close',()=>closeLog(state));
 await attempt('running_executable_checks',async()=>{for(const error of await Promise.all(executableChecks))if(error)throw error;});
 if(binding)await attempt('final_binding_and_coordinator',verifyInputs);
 if(fixture){
  await attempt('fixture_cleanup_receipt',async()=>{report.cleanup=await fixture.verifyStopped();});
  await attempt('extra_cleanup',async()=>{report.extra_cleanup={processes:[...children].map(r=>({pid:r.child.pid,...r.exit,pid_absent:verifyPidAbsent(r.child.pid)})),secondary_port_closed:await verifyClosedPort(secondaryPort)};assert.ok(report.extra_cleanup.processes.every(r=>r.observed_close&&r.pid_absent));assert.equal(report.extra_cleanup.secondary_port_closed,true);});
  await attempt('complete_uncapped_logs',async()=>{report.full_logs=await Promise.all(logPaths.map(async path=>{const bytes=await readFile(path);return{path,bytes:bytes.length,sha256:sha256(bytes),complete_to_observed_close:report.cleanup?.completed===true&&[...children].every(r=>r.exit?.observed_close===true)&&logStates.every(s=>s.finished&&s.closed&&!s.failed)&&logErrors.length===0};}));});
  if(logErrors.length){report.result='failed';process.exitCode=1;evidenceErrors.push({phase:'extra_log_write'});}
  report.log_closures=logStates.map(({path,finished,closed,failed})=>({path,finished,closed,failed}));report.evidence_failures=evidenceErrors.map(error=>error.phase);
  await writeFile(resolve(fixture.root,'evidence.json'),JSON.stringify(redactEvidence(report,[fixture.password,fixture.env.RAINSYNC_CONTROL_PEER_TOKEN]),null,2));console.log(JSON.stringify(redactEvidence(report,[fixture.password,fixture.env.RAINSYNC_CONTROL_PEER_TOKEN]),null,2));
 }
}
