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
import {redactEvidence} from '../scripts/acceptance-runtime.mjs';
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p}
async function until(fn,label,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100)}throw Error(`Timeout: ${label}`)}
const report={schema_version:1,result:'running',checks:[],scope:'Owned loopback two-server PostgreSQL/HTTP/WS control acceptance; SIGSTOP partition; no OS network changes, production accounts, cross-host TLS or performance claim'};
const nodes=[randomUUID(),randomUUID()];let secondaryPort,fixture,secondary,secondaryOrigin;const children=new Set(),streams=[],sockets=new Set();let launches=0;
try {
 await isolatedServer('control-cluster-runtime',async f=>{
  fixture=f;
  assert.equal(createHash('sha256').update(await readFile(resolve(f.target,'rainsync-server'))).digest('hex'),report.server_binary_sha256,'server binary unchanged after primary launch');
  try {
  const launch=(extra)=>{const log=createWriteStream(resolve(f.root,`extra-node-${++launches}.log`));streams.push(log);const child=spawn(resolve(f.target,'rainsync-server'),[],{env:{...f.env,...extra},stdio:['ignore','pipe','pipe']});const record={child,closed:new Promise(r=>child.once('close',(code,signal)=>r({code,signal}))),wasStopped:false};children.add(record);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});return record};
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
  report.result='passed';
  } finally {
   for(const ws of sockets)ws.terminate();
   for(const record of children)if(record.wasStopped){record.child.kill('SIGCONT');record.wasStopped=false;}
   await reapOwnedChildren([...children]);
  }
 },{beforeStart:async f=>{report.server_binary_sha256=createHash('sha256').update(await readFile(resolve(f.target,'rainsync-server'))).digest('hex');secondaryPort=await port();secondaryOrigin=`http://127.0.0.1:${secondaryPort}`;Object.assign(f.env,{TRUSTED_PROXY_CIDRS:'',RAINSYNC_CONTROL_CLUSTER:'1',RAINSYNC_CONTROL_NODE_ID:nodes[0],RAINSYNC_CONTROL_ROLE:'media',RAINSYNC_CONTROL_NODES:JSON.stringify({[nodes[0]]:f.origin,[nodes[1]]:secondaryOrigin}),RAINSYNC_CONTROL_PEER_TOKEN:randomBytes(32).toString('hex')})},signal:AbortSignal.timeout(150000)});
 report.cleanup=await fixture.verifyStopped();
}catch(error){report.result='failed';report.error=String(error);throw error}
finally {
 for(const ws of sockets){ws.terminate()}
 for(const record of children)if(record.wasStopped)record.child.kill('SIGCONT');
 await reapOwnedChildren([...children]);
 for(const stream of streams)await new Promise(r=>stream.end(r));
 if(fixture){report.extra_cleanup={pids_absent:[...children].every(r=>verifyPidAbsent(r.child.pid)),secondary_port_closed:await verifyClosedPort(secondaryPort)};await writeFile(resolve(fixture.root,'evidence.json'),JSON.stringify(redactEvidence(report,[fixture.password,fixture.env.RAINSYNC_CONTROL_PEER_TOKEN]),null,2));console.log(JSON.stringify(report,null,2))}
}
