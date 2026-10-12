// One identical original/candidate assertion set for the complete kick operation.
// Test-only owned rows and real PG blockers; original auth, locks and deadlines unchanged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeOwnerGate } from './fixtures/native-owner-gate.mjs';
import { testLoginHash, withPlaybackAdmission } from './fixtures/playback-admission.mjs';
import { sourceMedia } from './fixtures/source-grant.mjs';
import { verifyPidAbsent } from './fixtures/postgres.mjs';
import { sha256 } from '../scripts/native-owner-binding.mjs';

assert.equal(process.argv.length,2,'One identical original/candidate assertion set');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const uuid=value=>{assert.match(value,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);return quote(value);};
const cases=[
  {name:'kick_exact_login_expiry_target_epoch_delete_wait',boundary:'epoch',expiry:'login',status:401,code:'SESSION_EXPIRED'},
  {name:'kick_delegated_grant_expiry_target_epoch_delete_wait',boundary:'epoch',expiry:'grant',status:403,code:'CONTROLLER_REQUIRED'},
  {name:'kick_login_and_grant_expiry_final_priority',boundary:'epoch',expiry:'both',status:401,code:'SESSION_EXPIRED'},
  {name:'kick_first_admin_snapshot_current_demotion_delegated_control',boundary:'principal',expiry:null,status:200,code:null},
];
await nativeOwnerGate('room-kick-authority-native',async(f,{report,check,signal})=>{
  report.scope='Six finite kick checks: two ingress groups, original target epoch DELETE natural login/grant/both expiry rollback, and pre-SHARE current-role demotion preserving FIRST admin snapshot. Real registered targets with synthetic playback rows admitted by actual exact cookies. No media process, WS broadcast/absence, guest-target release, P08/P09 or complete-race claim.';
  report.boundary_cases=[];report.ingress=[];
  const helperPath=new URL('./fixtures/source-grant.mjs',import.meta.url);
  const helperSha=sha256(await readFile(helperPath));
  report.additional_coordinator=[{path:'tests/fixtures/source-grant.mjs',sha256:helperSha}];
  const progress=resolve(f.root,'room-kick-authority-progress.json');
  let serial=0;
  async function savePhase(phase){
    report.active_case.phase=phase;
    await writeFile(progress,JSON.stringify({active_case:report.active_case,boundary_cases:report.boundary_cases,ingress:report.ingress},null,2)+'\n');
  }
  async function bounded(work,ms=10000){
    let timer,abort,settled=false;
    return await new Promise((done,reject)=>{
      const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn(value);};
      abort=()=>finish(reject,signal.reason);
      timer=setTimeout(()=>finish(reject,Error('kick_boundary_deadline')),ms);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      Promise.resolve(work).then(value=>finish(done,value),error=>finish(reject,error));
    });
  }
  async function waitSql(sql){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){signal.throwIfAborted();if(f.sql(sql)==='t')return;await new Promise(done=>setTimeout(done,25));}
    throw Error('kick_boundary_witness_deadline');
  }
  async function privateFile(label,suffix,bytes){
    const body=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
    const path=resolve(f.root,`${label}.${suffix}`);
    await writeFile(path,body,{flag:'wx',mode:0o600});
    return {path,bytes:body.length,sha256:sha256(body)};
  }
  async function observeHttp(label,pending){
    const response=await bounded(pending);
    const bytes=Buffer.from(await bounded(response.text()));
    const value=JSON.parse(bytes);
    const full={status:response.status,status_text:response.statusText,headers:[...response.headers],body:value};
    const file=await privateFile(label,'http.private.json',JSON.stringify(full,null,2)+'\n');
    const exactBody=await privateFile(label,'http-body.private.json',bytes);
    return {response,value,receipt:{status:response.status,error_code:value?.error?.code??null,body_sha256:sha256(bytes),private_response:file,exact_body:exactBody}};
  }
  async function expectHttp(label,pending,status,code){
    const observed=await observeHttp(label,pending);
    report.ingress.push({name:label,...observed.receipt});
    assert.equal(observed.response.status,status);
    if(code)assert.equal(observed.value.error.code,code);
    return observed.value;
  }
  const admin=f.client();await admin.login();
  assert.equal(f.sql('SELECT count(*) FROM control_cluster_activation'),'0','Owned single-node boundary requires unactivated cluster mode; never disable a caller setting');
  async function person(){
    const username=`kick-boundary-${++serial}`;
    await admin.request('/users','POST',{username,password:f.password});
    const client=f.client(),live=f.client();const id=(await client.login(username)).id;
    await live.login(username);return {id,client,live};
  }
  async function subject({delegated=false,demotion=false,distinctController=false}={}){
    const owner=await person(),target=await person();
    const room=await owner.client.request('/rooms','POST',{name:'Owned kick authority boundary'});
    const invite=await owner.client.request(`/rooms/${room.id}/invites`,'POST',{max_uses:20});
    const join=person=>person.client.request(`/rooms/${room.id}/join`,'POST',{token:invite.token});
    await join(target);
    await owner.client.request(`/rooms/${room.id}/permissions/${target.id}`,'PUT',{role:'moderator',permissions:['pause'],expires_in_seconds:3600});
    await owner.client.request(`/rooms/${room.id}/invites`,'POST',{role:'moderator',permissions:['pause'],expires_in_seconds:3600});
    let actor=owner,controller=owner;
    if(delegated||demotion){
      actor=await person();await join(actor);
      await owner.client.request(`/rooms/${room.id}/permissions/${actor.id}`,'PUT',{role:'moderator',permissions:['kick'],expires_in_seconds:3600});
    }
    if(distinctController){
      controller=await person();await join(controller);
      // A test-only distinct current controller; no WS election/ACK receipt claimed.
      f.sql(`UPDATE room_snapshots SET state=jsonb_set(state,'{controller_user_id}',to_jsonb(${uuid(controller.id)}::text)) WHERE room_id=${uuid(room.id)}`);
    }
    if(demotion){
      f.sql(`UPDATE users SET admin=true WHERE id IN(${uuid(actor.id)},${uuid(target.id)})`);
      assert.equal((await actor.live.request('/auth/me')).admin,true);
      assert.equal((await target.live.request('/auth/me')).admin,true);
    }
    const epoch=randomUUID(),playback=randomUUID();
    f.sql(`INSERT INTO control_epochs(id,user_id,room_id) VALUES(${uuid(epoch)},${uuid(target.id)},${uuid(room.id)})`);
    const media=sourceMedia(f,{kind:'local',root:f.root,resource:'kick-owned-synthetic-resource'});
    const generation=Number(f.sql(`SELECT (state->>'media_generation')::bigint FROM room_snapshots WHERE room_id=${uuid(room.id)}`));
    assert.ok(Number.isSafeInteger(generation));
    const admission=withPlaybackAdmission(f,{client:target.client,user:target.id,room:room.id,session:playback},
      `INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${uuid(playback)},${uuid(target.id)},${uuid(room.id)},${uuid(media)},${generation},${quote('kick-fixture-'+playback)},'{}',clock_timestamp()+interval '1 hour')`);
    const source=f.sql(`SELECT source_id FROM media_items WHERE id=${uuid(media)}`);
    return {owner,target,actor,controller,room,epoch,playback,media,source,admission,invite,additional:[]};
  }
  function snapshotSql(s){
    const ids=[s.owner.id,s.target.id,s.actor.id,s.controller.id,...s.additional.map(p=>p.id)].filter((v,i,a)=>a.indexOf(v)===i).map(uuid).join(',');
    return `SELECT jsonb_build_object(
      'room',(SELECT to_jsonb(r) FROM rooms r WHERE r.id=${uuid(s.room.id)}),
      'members',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM room_members m WHERE m.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'grants',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id) FROM room_member_permissions p WHERE p.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'epochs',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM control_epochs e WHERE e.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'snapshot',(SELECT to_jsonb(rs) FROM room_snapshots rs WHERE rs.room_id=${uuid(s.room.id)}),
      'room_events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.revision) FROM room_events e WHERE e.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'ownership_events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.revision,e.id) FROM room_ownership_events e WHERE e.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'lifecycle_events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.revision,e.id) FROM room_lifecycle_events e WHERE e.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'invites',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.token_hash) FROM invites i WHERE i.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'invite_redemptions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.token_hash,d.user_id) FROM room_invite_redemptions d JOIN invites i ON i.token_hash=d.token_hash WHERE i.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'guest_access',(SELECT to_jsonb(a) FROM room_guest_access a WHERE a.room_id=${uuid(s.room.id)}),
      'guest_principals',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id) FROM guest_principals g WHERE g.user_id IN(${ids}) OR g.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'profiles',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id) FROM user_profiles p WHERE p.user_id IN(${ids})),'[]'::jsonb),
      'avatars',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.user_id) FROM user_avatars a WHERE a.user_id IN(${ids})),'[]'::jsonb),
      'users',COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM users u WHERE u.id IN(${ids})),'[]'::jsonb),
      'sessions',COALESCE((SELECT jsonb_agg(to_jsonb(login) ORDER BY login.token_hash) FROM sessions login WHERE login.user_id IN(${ids})),'[]'::jsonb),
      'playback_sessions',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM playback_sessions p WHERE p.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'playback_requests',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id,p.idempotency_key) FROM playback_requests p WHERE p.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'media',(SELECT to_jsonb(m) FROM media_items m WHERE m.id=${uuid(s.media)}),
      'source',(SELECT to_jsonb(src) FROM sources src WHERE src.id=${uuid(s.source)}))::text`;
  }
  async function takeSnapshot(s,label){
    const raw=f.sql(snapshotSql(s));
    return {raw,value:JSON.parse(raw),receipt:await privateFile(label,'rows.private.json',raw+'\n')};
  }
  const kick=(client,s,target=s.target.id,room=s.room.id,headers={})=>client.raw(`/rooms/${room}/members/${target}`,{method:'DELETE',headers});
  function successfulRows(before,s,{demotion=false}={}){
    const expected=structuredClone(before);
    if(demotion)expected.users.find(u=>u.id===s.actor.id).admin=false;
    expected.epochs=expected.epochs.filter(e=>e.user_id!==s.target.id);
    expected.members=expected.members.filter(m=>m.user_id!==s.target.id);
    expected.grants=expected.grants.filter(g=>g.user_id!==s.target.id);
    for(const playback of expected.playback_sessions)if(playback.user_id===s.target.id)playback.stopped=true;
    return expected;
  }
  function assertKickEffects(before,after,s,{demotion=false}={}){
    assert.equal(before.epochs.some(e=>e.id===s.epoch&&e.user_id===s.target.id),true);
    assert.equal(before.members.some(m=>m.user_id===s.target.id),true);
    assert.equal(before.grants.some(g=>g.user_id===s.target.id),true);
    assert.equal(before.playback_sessions.find(p=>p.id===s.playback).stopped,false);
    assert.deepEqual(after,successfulRows(before,s,{demotion}),'Every selected complete row unchanged except intentional demotion and complete target kick effects');
    assert.equal(after.epochs.filter(e=>e.user_id===s.target.id).length,0);
    assert.equal(after.members.filter(m=>m.user_id===s.target.id).length,0);
    assert.equal(after.grants.filter(g=>g.user_id===s.target.id).length,0);
    assert.equal(after.playback_sessions.find(p=>p.id===s.playback).stopped,true);
  }
  // Two groups retain all original ingress facts; assertions are never baseline-specialcased.
  const ingress=await subject({delegated:true,distinctController:true}),outsider=await person(),missing=randomUUID();
  f.sql(`UPDATE users SET admin=true WHERE id=${uuid(ingress.target.id)}`);
  const settings=await admin.request('/admin/settings');
  await admin.request('/admin/settings','PATCH',{expected_revision:settings.revision,changes:{guests_enabled:true}});
  await ingress.owner.client.request(`/rooms/${ingress.room.id}/guest-access`,'PUT',{enabled:true});
  const guest=f.client();const guestIdentity=await guest.request(`/rooms/${ingress.room.id}/guest-session`,'POST',{token:ingress.invite.token,display_name:'Owned kick ingress guest'},201);
  guest.csrf=guestIdentity.csrf;assert.equal(guestIdentity.guest,true);ingress.additional.push({id:guestIdentity.id});
  const beforeIngress=await takeSnapshot(ingress,'ingress.before');
  report.active_case={name:'kick_auth_member_lifecycle_ingress',phase:'running',result:'running'};
  await expectHttp('kick_missing_cookie_precedes_origin_csrf_room',kick(ingress.owner.client,ingress,missing,missing,{Cookie:'',Origin:'','x-csrf-token':''}),401,'LOGIN_REQUIRED');
  await expectHttp('kick_origin_precedes_csrf_and_missing_room',kick(ingress.owner.client,ingress,missing,missing,{Origin:'http://127.0.0.1:1','x-csrf-token':'wrong'}),403,'ORIGIN_REJECTED');
  await expectHttp('kick_csrf_precedes_missing_room',kick(ingress.owner.client,ingress,missing,missing,{'x-csrf-token':'wrong'}),403,'CSRF_REJECTED');
  await expectHttp('kick_guest_precedes_origin_csrf_member',kick(guest,ingress,ingress.target.id,missing,{Origin:'http://127.0.0.1:1','x-csrf-token':'wrong'}),403,'GUEST_RESTRICTED');
  await expectHttp('kick_admin_nonmember_still_not_member',kick(admin,ingress),403,'NOT_A_MEMBER');
  await expectHttp('kick_ordinary_missing_room_fast_member',kick(outsider.client,ingress,missing,missing),403,'NOT_A_MEMBER');
  const afterIngress=await takeSnapshot(ingress,'ingress.auth-after');assert.equal(afterIngress.raw,beforeIngress.raw);
  const inactive=await subject();
  // A settled test-only inactive row exercises admission; this is no physical close/retry receipt.
  f.sql(`UPDATE rooms SET lifecycle='closed' WHERE id=${uuid(inactive.room.id)}`);
  const inactiveBefore=await takeSnapshot(inactive,'inactive.before');
  await expectHttp('kick_inactive_member_room',kick(inactive.owner.client,inactive),409,'ROOM_NOT_ACTIVE');
  const inactiveAfter=await takeSnapshot(inactive,'inactive.after');assert.equal(inactiveAfter.raw,inactiveBefore.raw);
  report.auth_ingress_rows={before:beforeIngress.receipt,after:afterIngress.receipt,byte_equal:true,inactive_before:inactiveBefore.receipt,inactive_after:inactiveAfter.receipt,inactive_byte_equal:true};
  check('kick_auth_member_lifecycle_ingress');report.active_case.result='passed';await savePhase('complete');
  report.active_case={name:'kick_protected_and_missing_target_ingress',phase:'running',result:'running'};
  await expectHttp('kick_owner_protected',kick(ingress.owner.client,ingress,ingress.owner.id),403,'FORBIDDEN');
  await expectHttp('kick_controller_protected',kick(ingress.owner.client,ingress,ingress.controller.id),403,'FORBIDDEN');
  await expectHttp('kick_actor_self_protected',kick(ingress.actor.client,ingress,ingress.actor.id),403,'FORBIDDEN');
  await expectHttp('kick_nonadmin_delegated_admin_target_protected',kick(ingress.actor.client,ingress),403,'FORBIDDEN');
  const absent=await observeHttp('kick_missing_target_original_ok',kick(ingress.owner.client,ingress,missing));
  assert.equal(absent.response.status,200);assert.deepEqual(absent.value,{ok:true});report.ingress.push({name:'kick_missing_target_original_ok',...absent.receipt});
  const noChange=await takeSnapshot(ingress,'ingress.protected-after');assert.equal(noChange.raw,beforeIngress.raw);
  const ordinarySuccess=await subject();const ordinaryBefore=await takeSnapshot(ordinarySuccess,'ingress.success-before');
  const success=await observeHttp('kick_owner_live_registered_target_success',kick(ordinarySuccess.owner.live,ordinarySuccess));
  assert.equal(success.response.status,200);assert.deepEqual(success.value,{ok:true});
  const committedIngress=await takeSnapshot(ordinarySuccess,'ingress.success-committed');assertKickEffects(ordinaryBefore.value,committedIngress.value,ordinarySuccess);
  report.protected_ingress_rows={before:beforeIngress.receipt,after_rejections_and_missing_target:noChange.receipt,byte_equal:true,successful_before:ordinaryBefore.receipt,successful_http:success.receipt,complete_committed_rows:committedIngress.receipt};
  check('kick_protected_and_missing_target_ingress');report.active_case.result='passed';await savePhase('complete');
  async function holder(spec,s){
    const marker=`kick_holder_${randomUUID().replaceAll('-','')}`;
    const child=f.sqlProcess(undefined,{interactive:true});
    assert.ok(Number.isInteger(child.pid)&&child.pid>0);
    const stdout=[],stderr=[];let output='',releasePromise,backend;
    const record={holder_child_pid:child.pid,holder_backend_pid:null,close_observed:false,exit_code:null,signal:null,pid_absent:false,backend_pid_absent:false};
    child.once('close',(code,signal)=>Object.assign(record,{close_observed:true,exit_code:code,signal,closed_at:new Date().toISOString()}));
    child.stdin.on('error',()=>{});child.stderr.on('data',bytes=>stderr.push(Buffer.from(bytes)));
    const ready=new Promise((done,reject)=>{
      child.stdout.on('data',bytes=>{stdout.push(Buffer.from(bytes));output+=bytes.toString();if(output.includes(marker+'_ready'))done();});
      child.once('error',reject);
      child.done.then(()=>reject(Error('kick_holder_closed_before_ready')),reject);
    });
    const lock=spec.boundary==='epoch'
      ?`SELECT id FROM control_epochs WHERE id=${uuid(s.epoch)} FOR UPDATE`
      :`UPDATE users SET admin=false WHERE id=${uuid(s.actor.id)}; SELECT ${quote(marker+'_staged_admin=')}||admin::text FROM users WHERE id=${uuid(s.actor.id)}`;
    child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`);
    async function release(){
      if(!releasePromise)releasePromise=(async()=>{
        const errors=[];
        try{child.stdin.end('COMMIT;\n\\q\n');let timer;
          try{await Promise.race([child.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('kick_holder_close_deadline')),12000);})]);}
          finally{clearTimeout(timer);}
          assert.equal(record.close_observed,true);assert.equal(record.exit_code,0);assert.equal(record.signal,null);assert.equal(child.exitCode,0);
          record.pid_absent=verifyPidAbsent(child.pid);assert.equal(record.pid_absent,true);
          if(backend){record.backend_pid_absent=f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend})`)==='t';assert.equal(record.backend_pid_absent,true);}
        }catch(error){errors.push(error);}
        finally{
          try{record.stdout=await privateFile(spec.name,'holder.stdout.private.log',Buffer.concat(stdout));record.stderr=await privateFile(spec.name,'holder.stderr.private.log',Buffer.concat(stderr));}
          catch(error){errors.push(error);}
        }
        if(errors.length)throw new AggregateError(errors,'kick_holder_cleanup_failed');return record;
      })();return releasePromise;
    }
    try{
      await bounded(ready);
      backend=Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name=${quote(marker)}`));
      assert.ok(Number.isInteger(backend)&&backend>0);record.holder_backend_pid=backend;
      if(spec.boundary==='principal')assert.ok(output.includes(marker+'_staged_admin=false'),'Real uncommitted holder demotion observed');
    }catch(error){try{report.active_case.blocker_cleanup=await release();}catch(cleanupError){report.active_case.blocker_cleanup={...record,completed:false,code:'owned_psql_setup_cleanup_unconfirmed'};throw new AggregateError([error,cleanupError],'kick_holder_setup_and_cleanup_failed');}throw error;}
    const prefix=spec.boundary==='epoch'?'DELETE FROM control_epochs WHERE room_id=%'
      :'SELECT admin FROM users WHERE id=% FOR SHARE';
    const blockedWhere=`blocked.wait_event_type='Lock' AND blocked.query LIKE ${quote(prefix)} AND ${backend}=ANY(pg_blocking_pids(blocked.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${backend} AND held.application_name=${quote(marker)})`;
    const blockedPidsSql=`SELECT COALESCE(jsonb_agg(blocked.pid ORDER BY blocked.pid),'[]'::jsonb)::text FROM pg_stat_activity blocked WHERE ${blockedWhere}`;
    return {release,record,blockedWhere,blockedPidsSql,
      witness:`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE ${blockedWhere})`,
      blocked_query:spec.boundary==='epoch'?'target_control_epochs_delete':'current_admin_for_share'};
  }
  function deadlineQueries(s,spec){
    const login=testLoginHash(f,s.actor.client);
    const loginSelector=`FROM sessions WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)}`;
    const grantSelector=`FROM room_member_permissions WHERE room_id=${uuid(s.room.id)} AND user_id=${uuid(s.actor.id)}`;
    const selectors=spec.expiry==='both'?[{name:'login',selector:loginSelector},{name:'grant',selector:grantSelector}]
      :[{name:spec.expiry,selector:spec.expiry==='login'?loginSelector:grantSelector}];
    return selectors.map(item=>({...item,
      valueSql:`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${item.selector}`,
      reachedSql:`SELECT expires_at<=clock_timestamp() ${item.selector}`,
      stableSql:exact=>`SELECT expires_at=${quote(exact)}::timestamptz AND clock_timestamp()>=${quote(exact)}::timestamptz ${item.selector}`}));
  }
  for(const spec of cases){
    signal.throwIfAborted();
    const s=await subject({delegated:spec.expiry==='grant'||spec.expiry==='both',demotion:spec.boundary==='principal'});
    const active={name:spec.name,method:'DELETE',phase:'setup',result:'running',room_id:s.room.id,target_id:s.target.id,actor_id:s.actor.id};
    report.active_case=active;report.boundary_cases.push(active);await savePhase('setup');
    let block,pending,requestSettled=false,failure,responseObserved=false,cleanup;
    try{
      let deadlines=[];
      if(spec.expiry){
        const login=testLoginHash(f,s.actor.client);
        if(spec.expiry==='both'){
          f.sql(`WITH deadline AS MATERIALIZED(SELECT clock_timestamp()+interval '3 seconds' AS at), login_changed AS (UPDATE sessions SET expires_at=(SELECT at FROM deadline) WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)} RETURNING expires_at) UPDATE room_member_permissions SET expires_at=(SELECT expires_at FROM login_changed) WHERE room_id=${uuid(s.room.id)} AND user_id=${uuid(s.actor.id)}`);
        }else if(spec.expiry==='login')f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)}`);
        else f.sql(`UPDATE room_member_permissions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE room_id=${uuid(s.room.id)} AND user_id=${uuid(s.actor.id)}`);
        deadlines=deadlineQueries(s,spec);
        active.exact_expiries=deadlines.map(d=>({column:d.name,utc:f.sql(d.valueSql)}));
        for(const d of active.exact_expiries)assert.match(d.utc,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        if(spec.expiry==='both')assert.equal(active.exact_expiries[0].utc,active.exact_expiries[1].utc,'Both exact original columns have the same natural deadline');
      }
      const before=await takeSnapshot(s,`${spec.name}.before`);active.before=before.receipt;
      assert.equal(before.value.playback_sessions.find(p=>p.id===s.playback).auth_login_hash,s.admission.loginHash);
      block=await holder(spec,s);
      if(spec.boundary==='principal'){
        assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'t','Both entry auths see committed original admin true');
        assert.equal(f.sql(`SELECT room_permission_allowed(${uuid(s.room.id)},${uuid(s.actor.id)},'kick')`),'t','Current-role fallback has a real live delegated Kick grant');
        active.committed_admin_before_request=true;active.holder_staged_admin=false;active.target_admin=true;active.live_delegated_kick_before_request=true;
      }else{
        for(let i=0;i<deadlines.length;i++)assert.equal(f.sql(deadlines[i].stableSql(active.exact_expiries[i].utc).replace('clock_timestamp()>=','clock_timestamp()<')),'t','Exact original expiry column is still live before HTTP starts');
      }
      active.holder_backend_pid=block.record.holder_backend_pid;active.holder_child_pid=block.record.holder_child_pid;active.blocked_query=block.blocked_query;
      await savePhase('http_pending');
      pending=kick(s.actor.client,s);pending.then(()=>{requestSettled=true;},()=>{requestSettled=true;});
      await waitSql(block.witness);
      const pids=JSON.parse(f.sql(block.blockedPidsSql));assert.equal(pids.length,1);const blocked=pids[0];
      assert.ok(Number.isInteger(blocked)&&blocked>0);assert.notEqual(blocked,block.record.holder_backend_pid);
      active.blocked_backend_pid=blocked;active.initial_blocked_backend_pids=pids;active.initial_witnessed_at=new Date().toISOString();
      const witnessSql=`SELECT jsonb_build_object(
        'database_clock_utc',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'holder',(SELECT to_jsonb(held) FROM (SELECT pid,application_name,backend_start,state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=${block.record.holder_backend_pid}) held),
        'blocked',(SELECT to_jsonb(waiting) FROM (SELECT pid,application_name,backend_start,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blocking_pids FROM pg_stat_activity WHERE pid=${blocked}) waiting))::text`;
      const witnessReceipt=async label=>{
        const raw=f.sql(witnessSql),value=JSON.parse(raw);
        assert.equal(value.holder.pid,block.record.holder_backend_pid);assert.equal(value.blocked.pid,blocked);
        assert.equal(value.blocked.wait_event_type,'Lock');assert.ok(value.blocked.blocking_pids.includes(block.record.holder_backend_pid));
        return {database_clock_utc:value.database_clock_utc,private_witness:await privateFile(label,'pg-witness.private.json',raw+'\n')};
      };
      active.initial_pg_witness=await witnessReceipt(`${spec.name}.initial`);assert.equal(requestSettled,false);
      await savePhase('unique_actual_blocking_edge');
      if(spec.boundary==='principal'){
        assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'t');
        assert.equal(f.sql(`SELECT room_permission_allowed(${uuid(s.room.id)},${uuid(s.actor.id)},'kick')`),'t');
        active.committed_admin_before_release=true;active.live_delegated_kick_before_release=true;
      }else{
        for(let i=0;i<deadlines.length;i++){
          await waitSql(deadlines[i].reachedSql);
          assert.equal(f.sql(deadlines[i].valueSql),active.exact_expiries[i].utc,'Exact column was not rotated during wait');
          assert.equal(f.sql(deadlines[i].stableSql(active.exact_expiries[i].utc)),'t');
        }
        active.expiry_columns_unchanged_at_release=true;active.database_clock_reached_all_exact_expiries=true;
      }
      assert.equal(f.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE blocked.pid=${blocked} AND ${block.blockedWhere})`),'t');
      assert.deepEqual(JSON.parse(f.sql(block.blockedPidsSql)),[blocked]);assert.equal(requestSettled,false);
      active.same_blocking_edge_before_release=true;active.pre_release_witnessed_at=new Date().toISOString();
      active.pre_release_pg_witness=await witnessReceipt(`${spec.name}.pre-release`);
      await savePhase(spec.boundary==='principal'?'same_edge_before_actual_demotion_commit':'same_edge_after_natural_expiry');
      cleanup=await block.release();active.blocker_cleanup=cleanup;
      const observed=await observeHttp(spec.name,pending);responseObserved=true;active.observed=observed.receipt;
      assert.equal(observed.response.status,spec.status);
      if(spec.code)assert.equal(observed.value.error.code,spec.code);else assert.deepEqual(observed.value,{ok:true});
      const after=await takeSnapshot(s,`${spec.name}.after`);active.after=after.receipt;
      if(spec.boundary==='principal'){
        assertKickEffects(before.value,after.value,s,{demotion:true});
        assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'f');
        const actorMe=await observeHttp(`${spec.name}.actor_current_live_identity`,s.actor.live.raw('/auth/me'));
        assert.equal(actorMe.response.status,200);assert.equal(actorMe.value.id,s.actor.id);assert.equal(actorMe.value.admin,false);
        active.current_actor_identity=actorMe.receipt;active.only_intentional_demotion_and_complete_kick_effects=true;
      }else{
        assert.equal(after.raw,before.raw,'All complete selected room/member/grant/epoch/playback/profile/session/invite rows remain byte equal after original rollback');
        active.full_selected_rows_byte_equal=true;
        if(spec.expiry!=='grant'){
          const repeat=await observeHttp(`${spec.name}.expired_exact_cookie_new_request`,s.actor.client.raw('/auth/me'));
          assert.equal(repeat.response.status,401);assert.equal(repeat.value.error.code,'SESSION_EXPIRED');active.expired_cookie_new_request=repeat.receipt;
        }else{
          const repeat=await observeHttp(`${spec.name}.expired_grant_new_kick`,kick(s.actor.client,s));
          assert.equal(repeat.response.status,403);assert.equal(repeat.value.error.code,'CONTROLLER_REQUIRED');active.expired_grant_new_kick=repeat.receipt;
          const repeated=await takeSnapshot(s,`${spec.name}.repeated-after`);assert.equal(repeated.raw,before.raw);active.repeated_rejection_complete_rows=repeated.receipt;
        }
        const live=await observeHttp(`${spec.name}.independent_owner_live_identity`,s.owner.live.raw('/auth/me'));
        assert.equal(live.response.status,200);assert.equal(live.value.id,s.owner.id);active.independent_owner_live_identity=live.receipt;
        const committedHttp=await observeHttp(`${spec.name}.independent_owner_live_kick`,kick(s.owner.live,s));
        assert.equal(committedHttp.response.status,200);assert.deepEqual(committedHttp.value,{ok:true});
        const committed=await takeSnapshot(s,`${spec.name}.committed`);assertKickEffects(before.value,committed.value,s);
        active.independent_owner_live_kick={http:committedHttp.receipt,complete_committed_rows:committed.receipt,target_epochs_zero:true,target_member_zero:true,target_grant_cascade_zero:true,target_playback_stopped:true};
      }
      active.result='passed';check(spec.name);await savePhase('complete');
    }catch(error){failure=error;active.result='failed';active.failure={code:'kick_boundary_failed',phase:active.phase};}
    finally{
      const errors=[];
      if(block){try{cleanup=await block.release();active.blocker_cleanup=cleanup;}catch(error){errors.push(error);active.blocker_cleanup={...block.record,completed:false,code:'owned_psql_cleanup_unconfirmed'};}}
      if(pending){
        try{const response=await pending;if(!responseObserved&&!response.bodyUsed){const raw=Buffer.from(await response.text());active.cleanup_http={status:response.status,private_response:await privateFile(`${spec.name}.cleanup`,'http.private.json',JSON.stringify({status:response.status,status_text:response.statusText,headers:[...response.headers],body:raw.toString()},null,2)+'\n'),exact_body:await privateFile(`${spec.name}.cleanup`,'http-body.private.json',raw)};}}
        catch(error){if(!failure)errors.push(error);active.cleanup_http_transport_failed=true;}
      }
      await savePhase(active.phase);
      if(errors.length)throw new AggregateError([...(failure?[failure]:[]),...errors],'kick_boundary_run_and_cleanup_failed');
    }
    if(failure)throw failure;
    delete report.active_case;
  }
  assert.equal(sha256(await readFile(helperPath)),helperSha,'Synthetic media helper source unchanged');
  report.additional_coordinator_unchanged=true;
  assert.equal(report.checks.length,6,'Exactly the frozen six checks completed');
});
