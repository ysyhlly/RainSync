// Complete original/candidate assertion set for room permissions authority.
// Test-only row/table blockers; no production hook, timer, owner or framework change.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nativeOwnerGate } from './fixtures/native-owner-gate.mjs';
import { testLoginHash } from './fixtures/playback-admission.mjs';
import { verifyPidAbsent } from './fixtures/postgres.mjs';
import { sha256 } from '../scripts/native-owner-binding.mjs';

assert.equal(process.argv.length,2,'One identical original/candidate assertion set');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const uuid=value=>{assert.match(value,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);return quote(value);};
const cases=[
  {name:'put_exact_login_expiry_control_epoch_delete_wait',method:'PUT',boundary:'epoch',status:401,code:'SESSION_EXPIRED'},
  {name:'delete_exact_login_expiry_control_epoch_delete_wait',method:'DELETE',boundary:'epoch',status:401,code:'SESSION_EXPIRED'},
  {name:'put_admin_demotion_principal_share_wait',method:'PUT',boundary:'principal',status:403,code:'FORBIDDEN'},
  {name:'delete_admin_demotion_principal_share_wait',method:'DELETE',boundary:'principal',status:403,code:'FORBIDDEN'},
  {name:'get_exact_login_expiry_permissions_select_wait',method:'GET',boundary:'read',status:200,code:null},
];
await nativeOwnerGate('room-permissions-authority-native',async(f,{report,check,signal})=>{
  report.scope='Registered-account room permissions GET/PUT/DELETE: finite real natural-expiry and current-role lock boundaries, exact PG PID correlation and owned psql cleanup. No guest, kick, P08/P09, all-race, WebSocket broadcast or physical owner-drain claim.';
  report.boundary_cases=[];report.ingress=[];
  const progress=resolve(f.root,'room-permissions-authority-progress.json');
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
      timer=setTimeout(()=>finish(reject,Error('permissions_boundary_deadline')),ms);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      Promise.resolve(work).then(value=>finish(done,value),error=>finish(reject,error));
    });
  }
  async function waitSql(sql){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){signal.throwIfAborted();if(f.sql(sql)==='t')return;await new Promise(done=>setTimeout(done,25));}
    throw Error('permissions_boundary_witness_deadline');
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
  assert.equal(f.sql('SELECT count(*) FROM control_cluster_activation'),'0','This owned single-node boundary fixture requires unactivated cluster mode; never disable a caller setting');
  async function person(){
    const username=`permission-boundary-${++serial}`;
    await admin.request('/users','POST',{username,password:f.password});
    const client=f.client(),live=f.client();const id=(await client.login(username)).id;
    await live.login(username);return {id,client,live};
  }
  async function subject(needsActor=false){
    const owner=await person(),target=await person();
    const room=await owner.client.request('/rooms','POST',{name:'Owned room permissions boundary'});
    const invite=await owner.client.request(`/rooms/${room.id}/invites`,'POST');
    await target.client.request(`/rooms/${room.id}/join`,'POST',{token:invite.token});
    await owner.client.request(`/rooms/${room.id}/permissions/${target.id}`,'PUT',{role:'moderator',permissions:['pause'],expires_in_seconds:3600});
    let actor=owner;
    if(needsActor){actor=await person();await actor.client.request(`/rooms/${room.id}/join`,'POST',{token:invite.token});
      f.sql(`UPDATE users SET admin=true WHERE id=${uuid(actor.id)}`);
      assert.equal((await actor.live.request('/auth/me')).admin,true);
    }
    const epoch=randomUUID();
    // A synthetic, active registered target's real control_epochs row; no WS/process receipt claim.
    f.sql(`INSERT INTO control_epochs(id,user_id,room_id) VALUES(${uuid(epoch)},${uuid(target.id)},${uuid(room.id)})`);
    return {owner,target,actor,room,epoch};
  }
  const grant={role:'moderator',permissions:['seek'],expires_in_seconds:3600};
  const ingress=await subject();const outsider=await person();const missing=randomUUID();
  report.active_case={name:'get_ingress_and_original_missing_room_priority',phase:'running',result:'running'};
  const get=(client,room=ingress.room.id,headers={})=>client.raw(`/rooms/${room}/permissions`,{headers});
  const ownerGet=await expectHttp('get_owner_cookie_only',get(ingress.owner.client,undefined,{Origin:'','x-csrf-token':''}),200);
  assert.equal(ownerGet.owner_id,ingress.owner.id);
  const viewerGet=await expectHttp('get_member_cookie_only',get(ingress.target.client,undefined,{Origin:'','x-csrf-token':''}),200);
  assert.deepEqual(viewerGet.self_permissions,['pause']);
  const adminGet=await expectHttp('get_admin_without_membership',get(admin,undefined,{Origin:'','x-csrf-token':''}),200);
  assert.equal(adminGet.owner_id,ingress.owner.id);
  await expectHttp('get_outsider_denied',get(outsider.client),403,'NOT_A_MEMBER');
  await expectHttp('get_missing_room_nonadmin_membership_first',get(outsider.client,missing),403,'NOT_A_MEMBER');
  // Preserve the original fetch_one missing-row failure; do not improve it to 404.
  await expectHttp('get_missing_room_admin_database_error',get(admin,missing),500,'DATABASE_ERROR');
  await expectHttp('get_missing_cookie_precedes_room',get(ingress.owner.client,missing,{Cookie:'',Origin:'','x-csrf-token':''}),401,'LOGIN_REQUIRED');
  check('get_ingress_and_original_missing_room_priority');report.active_case.result='passed';await savePhase('complete');
  report.active_case={name:'put_validation_before_request_auth',phase:'running',result:'running'};
  await expectHttp('put_invalid_grant_precedes_auth',ingress.owner.client.raw(`/rooms/${ingress.room.id}/permissions/${ingress.target.id}`,{
    method:'PUT',body:{role:'viewer',permissions:['play']},headers:{Cookie:'',Origin:'','x-csrf-token':''}}),400,'INVALID_REQUEST');
  check('put_validation_before_request_auth');report.active_case.result='passed';await savePhase('complete');
  report.active_case={name:'write_request_auth_origin_csrf_priority',phase:'running',result:'running'};
  await expectHttp('put_valid_grant_missing_cookie_first',ingress.owner.client.raw(`/rooms/${ingress.room.id}/permissions/${ingress.target.id}`,{
    method:'PUT',body:grant,headers:{Cookie:'',Origin:'','x-csrf-token':''}}),401,'LOGIN_REQUIRED');
  await expectHttp('put_origin_precedes_csrf',ingress.owner.client.raw(`/rooms/${ingress.room.id}/permissions/${ingress.target.id}`,{
    method:'PUT',body:grant,headers:{Origin:'http://127.0.0.1:1','x-csrf-token':'wrong'}}),403,'ORIGIN_REJECTED');
  await expectHttp('put_current_origin_bad_csrf',ingress.owner.client.raw(`/rooms/${ingress.room.id}/permissions/${ingress.target.id}`,{
    method:'PUT',body:grant,headers:{'x-csrf-token':'wrong'}}),403,'CSRF_REJECTED');
  await expectHttp('delete_missing_cookie_first',ingress.owner.client.raw(`/rooms/${ingress.room.id}/permissions/${ingress.target.id}`,{
    method:'DELETE',headers:{Cookie:'',Origin:'','x-csrf-token':''}}),401,'LOGIN_REQUIRED');
  check('write_request_auth_origin_csrf_priority');report.active_case.result='passed';await savePhase('complete');

  function snapshotSql(s){
    const ids=[s.owner.id,s.target.id,s.actor.id].filter((v,i,a)=>a.indexOf(v)===i).map(uuid).join(',');
    return `SELECT jsonb_build_object(
      'room',(SELECT to_jsonb(r) FROM rooms r WHERE r.id=${uuid(s.room.id)}),
      'members',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM room_members m WHERE m.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'grants',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.user_id) FROM room_member_permissions p WHERE p.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'epochs',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM control_epochs e WHERE e.room_id=${uuid(s.room.id)}),'[]'::jsonb),
      'snapshot',(SELECT to_jsonb(rs) FROM room_snapshots rs WHERE rs.room_id=${uuid(s.room.id)}),
      'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM users u WHERE u.id IN(${ids})),
      'sessions',(SELECT jsonb_agg(to_jsonb(login) ORDER BY login.token_hash) FROM sessions login WHERE login.user_id IN(${ids})))::text`;
  }
  async function takeSnapshot(s,label){
    const raw=f.sql(snapshotSql(s));
    return {raw,value:JSON.parse(raw),receipt:await privateFile(label,'rows.private.json',raw+'\n')};
  }
  async function holder(spec,s){
    const marker=`permission_holder_${randomUUID().replaceAll('-','')}`;
    const child=f.sqlProcess(undefined,{interactive:true});
    assert.ok(Number.isInteger(child.pid)&&child.pid>0);
    const stdout=[],stderr=[];let output='',releasePromise,backend;
    const record={holder_child_pid:child.pid,holder_backend_pid:null,close_observed:false,exit_code:null,signal:null,pid_absent:false,backend_pid_absent:false};
    child.once('close',(code,signal)=>Object.assign(record,{close_observed:true,exit_code:code,signal,closed_at:new Date().toISOString()}));
    child.stdin.on('error',()=>{});child.stderr.on('data',bytes=>stderr.push(Buffer.from(bytes)));
    const ready=new Promise((done,reject)=>{
      child.stdout.on('data',bytes=>{stdout.push(Buffer.from(bytes));output+=bytes.toString();if(output.includes(marker+'_ready'))done();});
      child.once('error',reject);
      child.done.then(()=>reject(Error('permission_holder_closed_before_ready')),reject);
    });
    const login=testLoginHash(f,s.actor.client);
    const expirySelector=`FROM sessions WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)}`;
    const lock=spec.boundary==='epoch'
      ?`SELECT id FROM control_epochs WHERE id=${uuid(s.epoch)} FOR UPDATE`
      :spec.boundary==='read'?'LOCK TABLE room_member_permissions IN ACCESS EXCLUSIVE MODE'
      :`UPDATE users SET admin=false WHERE id=${uuid(s.actor.id)}; SELECT ${quote(marker+'_staged_admin=')}||admin::text FROM users WHERE id=${uuid(s.actor.id)}`;
    child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`);
    async function release(){
      if(!releasePromise)releasePromise=(async()=>{
        const errors=[];
        try{child.stdin.end('COMMIT;\n\\q\n');let timer;
          try{await Promise.race([child.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('permission_holder_close_deadline')),12000);})]);}
          finally{clearTimeout(timer);}
          assert.equal(record.close_observed,true);assert.equal(record.exit_code,0);assert.equal(record.signal,null);assert.equal(child.exitCode,0);
          record.pid_absent=verifyPidAbsent(child.pid);assert.equal(record.pid_absent,true);
          if(backend){record.backend_pid_absent=f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend})`)==='t';assert.equal(record.backend_pid_absent,true);}
        }catch(error){errors.push(error);}
        finally{
          try{record.stdout=await privateFile(spec.name,'holder.stdout.private.log',Buffer.concat(stdout));record.stderr=await privateFile(spec.name,'holder.stderr.private.log',Buffer.concat(stderr));}
          catch(error){errors.push(error);}
        }
        if(errors.length)throw new AggregateError(errors,'permission_holder_cleanup_failed');return record;
      })();return releasePromise;
    }
    try{
      await bounded(ready);
      backend=Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name=${quote(marker)}`));
      assert.ok(Number.isInteger(backend)&&backend>0);record.holder_backend_pid=backend;
      if(spec.boundary==='principal')assert.ok(output.includes(marker+'_staged_admin=false'),'Real uncommitted holder demotion observed');
    }catch(error){try{report.active_case.blocker_cleanup=await release();}catch(cleanupError){report.active_case.blocker_cleanup={...record,completed:false,code:'owned_psql_setup_cleanup_unconfirmed'};throw new AggregateError([error,cleanupError],'permission_holder_setup_and_cleanup_failed');}throw error;}
    const prefix=spec.boundary==='epoch'?'DELETE FROM control_epochs WHERE room_id=% AND user_id=%'
      :spec.boundary==='principal'?'SELECT admin FROM users WHERE id=% FOR SHARE'
      :"SELECT m.user_id,COALESCE(p.role,'viewer') AS role,%FROM room_members m LEFT JOIN room_member_permissions p%";
    const blockedWhere=`blocked.wait_event_type='Lock' AND blocked.query LIKE ${quote(prefix)} AND ${backend}=ANY(pg_blocking_pids(blocked.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${backend} AND held.application_name=${quote(marker)})`;
    const blockedPidsSql=`SELECT COALESCE(jsonb_agg(blocked.pid ORDER BY blocked.pid),'[]'::jsonb)::text FROM pg_stat_activity blocked WHERE ${blockedWhere}`;
    const expiryValueSql=`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${expirySelector}`;
    return {release,record,blockedWhere,blockedPidsSql,
      witness:`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE ${blockedWhere})`,
      expiryValueSql,expiry:`SELECT expires_at<=clock_timestamp() ${expirySelector}`,
      stableExpiry:exact=>`SELECT expires_at=${quote(exact)}::timestamptz AND clock_timestamp()>=${quote(exact)}::timestamptz ${expirySelector}`,
      blocked_query:spec.boundary==='epoch'?'control_epochs_delete':spec.boundary==='principal'?'current_admin_for_share':'permissions_plain_select'};
  }
  for(const spec of cases){
    signal.throwIfAborted();
    const s=await subject(spec.boundary==='principal');
    if(spec.boundary==='read')s.actor=s.target;
    const active={name:spec.name,method:spec.method,phase:'setup',result:'running',room_id:s.room.id,target_id:s.target.id,actor_id:s.actor.id};
    report.active_case=active;report.boundary_cases.push(active);await savePhase('setup');
    let block,pending,requestSettled=false,failure,responseObserved=false,cleanup;
    try{
      if(spec.boundary!=='principal'){
        const login=testLoginHash(f,s.actor.client);
        f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)}`);
      }
      // Read the complete snapshot before a GET table blocker; ACCESS EXCLUSIVE
      // would also block this independent ordinary snapshot SELECT.
      const before=await takeSnapshot(s,`${spec.name}.before`);active.before=before.receipt;
      block=await holder(spec,s);
      assert.equal(before.value.epochs.some(e=>e.id===s.epoch),true);
      if(spec.boundary==='principal'){
        assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'t','Request entrance sees committed pre-demotion role');
        active.committed_admin_before_request=true;active.holder_staged_admin=false;
      }else{
        active.exact_expiry_utc=f.sql(block.expiryValueSql);
        assert.match(active.exact_expiry_utc,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        assert.equal(f.sql(block.stableExpiry(active.exact_expiry_utc).replace('clock_timestamp()>=','clock_timestamp()<')),'t','Same exact login still live before starting HTTP');
      }
      active.holder_backend_pid=block.record.holder_backend_pid;active.holder_child_pid=block.record.holder_child_pid;active.blocked_query=block.blocked_query;
      await savePhase('http_pending');
      pending=s.actor.client.raw(`/rooms/${s.room.id}/permissions${spec.method==='GET'?'':`/${s.target.id}`}`,{
        method:spec.method,body:spec.method==='PUT'?grant:undefined,headers:spec.method==='GET'?{Origin:'','x-csrf-token':''}:undefined});
      pending.then(()=>{requestSettled=true;},()=>{requestSettled=true;});
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
      active.initial_pg_witness=await witnessReceipt(`${spec.name}.initial`);
      assert.equal(requestSettled,false);await savePhase('unique_actual_blocking_edge');
      if(spec.boundary==='principal'){
        assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'t');
        active.committed_admin_before_release=true;
      }else{
        await waitSql(block.expiry);
        assert.equal(f.sql(block.expiryValueSql),active.exact_expiry_utc);
        assert.equal(f.sql(block.stableExpiry(active.exact_expiry_utc)),'t');
        active.expiry_unchanged_at_release=true;active.database_clock_reached_exact_expiry=true;
      }
      assert.equal(f.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE blocked.pid=${blocked} AND ${block.blockedWhere})`),'t');
      assert.deepEqual(JSON.parse(f.sql(block.blockedPidsSql)),[blocked]);assert.equal(requestSettled,false);
      active.same_blocking_edge_before_release=true;active.pre_release_witnessed_at=new Date().toISOString();
      active.pre_release_pg_witness=await witnessReceipt(`${spec.name}.pre-release`);
      await savePhase(spec.boundary==='principal'?'same_edge_before_actual_demotion_commit':'same_edge_after_natural_expiry');
      cleanup=await block.release();active.blocker_cleanup=cleanup;
      const observed=await observeHttp(spec.name,pending);responseObserved=true;active.observed=observed.receipt;
      assert.equal(observed.response.status,spec.status);if(spec.code)assert.equal(observed.value.error.code,spec.code);
      if(spec.boundary==='read')assert.deepEqual(observed.value.self_permissions,['pause']);
      const after=await takeSnapshot(s,`${spec.name}.after`);active.after=after.receipt;
      if(spec.boundary==='principal'){
        const expected=structuredClone(before.value);expected.users.find(u=>u.id===s.actor.id).admin=false;
        assert.deepEqual(after.value,expected,'All complete selected rows equal except holder committed actor demotion');
        const business=raw=>f.sql(`SELECT (${quote(raw)}::jsonb-'users')::text`);
        assert.equal(business(after.raw),business(before.raw),'Every permission/epoch/member/room/snapshot/session byte equal');
        assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'f');active.only_intentional_admin_change=true;
      }else{assert.equal(after.raw,before.raw,'Full selected rows, including exact expiry, remain byte equal');active.full_selected_rows_byte_equal=true;}
      await savePhase('original_response_and_rows_observed');
      if(spec.boundary!=='principal'){
        const repeat=await observeHttp(`${spec.name}.expired_cookie_new_request`,s.actor.client.raw(`/rooms/${s.room.id}/permissions`,{headers:{Origin:'','x-csrf-token':''}}));
        assert.equal(repeat.response.status,401);assert.equal(repeat.value.error.code,'SESSION_EXPIRED');active.expired_cookie_new_request=repeat.receipt;
      }
      assert.equal((await s.actor.live.request('/auth/me')).id,s.actor.id);
      if(spec.boundary==='principal')assert.equal((await s.actor.live.request('/auth/me')).admin,false);
      const liveGet=await observeHttp(`${spec.name}.live_get`,s.target.live.raw(`/rooms/${s.room.id}/permissions`,{headers:{Origin:'','x-csrf-token':''}}));
      assert.equal(liveGet.response.status,200);assert.deepEqual(liveGet.value.self_permissions,['pause']);active.independent_live_get=liveGet.receipt;
      if(spec.method!=='GET'){
        const put=await observeHttp(`${spec.name}.owner_live_put`,s.owner.live.raw(`/rooms/${s.room.id}/permissions/${s.target.id}`,{method:'PUT',body:grant}));
        assert.equal(put.response.status,200);assert.equal(put.value.ok,true);
        assert.equal(f.sql(`SELECT count(*) FROM control_epochs WHERE id=${uuid(s.epoch)}`),'0');
        const freshEpoch=randomUUID();f.sql(`INSERT INTO control_epochs(id,user_id,room_id) VALUES(${uuid(freshEpoch)},${uuid(s.target.id)},${uuid(s.room.id)})`);
        const revoke=await observeHttp(`${spec.name}.owner_live_delete`,s.owner.live.raw(`/rooms/${s.room.id}/permissions/${s.target.id}`,{method:'DELETE'}));
        assert.equal(revoke.response.status,200);assert.equal(revoke.value.ok,true);
        assert.equal(f.sql(`SELECT count(*) FROM control_epochs WHERE id=${uuid(freshEpoch)}`),'0');
        assert.equal(f.sql(`SELECT revoked FROM room_member_permissions WHERE room_id=${uuid(s.room.id)} AND user_id=${uuid(s.target.id)}`),'t');
        active.independent_owner_live_write={put:put.receipt,delete:revoke.receipt,actual_epochs_removed:true};
      }
      active.result='passed';check(spec.name);await savePhase('complete');
    }catch(error){failure=error;active.result='failed';active.failure={code:'permissions_boundary_failed',phase:active.phase};}
    finally{
      const errors=[];
      if(block){try{cleanup=await block.release();active.blocker_cleanup=cleanup;}catch(error){errors.push(error);active.blocker_cleanup={...block.record,completed:false,code:'owned_psql_cleanup_unconfirmed'};}}
      if(pending){
        try{const response=await pending;if(!responseObserved&&!response.bodyUsed){const raw=Buffer.from(await response.text());active.cleanup_http={status:response.status,private_response:await privateFile(`${spec.name}.cleanup`,'http.private.json',JSON.stringify({status:response.status,status_text:response.statusText,headers:[...response.headers],body:raw.toString()},null,2)+'\n'),exact_body:await privateFile(`${spec.name}.cleanup`,'http-body.private.json',raw)};}}
        catch(error){if(!failure)errors.push(error);active.cleanup_http_transport_failed=true;}
      }
      await savePhase(active.phase);
      if(errors.length)throw new AggregateError([...(failure?[failure]:[]),...errors],'permissions_boundary_run_and_cleanup_failed');
    }
    if(failure)throw failure;
    delete report.active_case;
  }
});
