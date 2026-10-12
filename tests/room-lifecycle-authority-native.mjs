// Finite lifecycle authority fixture; validate original and candidate bindings independently.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import WebSocket from 'ws';
import {nativeOwnerGate} from './fixtures/native-owner-gate.mjs';
import {testLoginHash} from './fixtures/playback-admission.mjs';
import {verifyPidAbsent} from './fixtures/postgres.mjs';
import {sha256} from '../scripts/native-owner-binding.mjs';
import {lifecycleSnapshotSql} from './fixtures/room-lifecycle-snapshot.mjs';
assert.equal(process.argv.length,2);
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const uuid=value=>{assert.match(value,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);return quote(value);};
const cases=[
 ...['close','reopen','archive'].map(action=>({name:`${action}_after_snapshot_wait_samples_monotonic_time`,action,boundary:'clock',status:200})),
 {name:'close_exact_login_expiry_final_epoch_delete_wait',action:'close',boundary:'epoch',expiry:'login',status:401,code:'SESSION_EXPIRED'},
 {name:'close_delegated_grant_expiry_final_epoch_delete_wait',action:'close',boundary:'epoch',expiry:'grant',status:403,code:'FORBIDDEN'},
 {name:'retry_exact_login_expiry_cleanup_task_update_wait',action:'retry-cleanup',boundary:'retry',expiry:'login',status:401,code:'SESSION_EXPIRED'},
 {name:'retry_delegated_grant_expiry_cleanup_task_update_wait',action:'retry-cleanup',boundary:'retry',expiry:'grant',status:403,code:'FORBIDDEN'},
 {name:'status_exact_login_expiry_cleanup_select_wait',action:'lifecycle',boundary:'read',expiry:'login',status:200},
 {name:'change_admin_demotion_principal_share_wait',action:'close',boundary:'principal',status:403,code:'FORBIDDEN'},
 {name:'retry_admin_demotion_principal_share_wait',action:'retry-cleanup',boundary:'principal',status:403,code:'FORBIDDEN'},
];
// This fixed set is independent of dynamic case lists: missing, duplicate, or unknown checks fail.
const requiredChecks = [
  "close_after_snapshot_wait_samples_monotonic_time",
  "reopen_after_snapshot_wait_samples_monotonic_time",
  "archive_after_snapshot_wait_samples_monotonic_time",
  "close_exact_login_expiry_final_epoch_delete_wait",
  "close_delegated_grant_expiry_final_epoch_delete_wait",
  "retry_exact_login_expiry_cleanup_task_update_wait",
  "retry_delegated_grant_expiry_cleanup_task_update_wait",
  "status_exact_login_expiry_cleanup_select_wait",
  "change_admin_demotion_principal_share_wait",
  "retry_admin_demotion_principal_share_wait"
];
await nativeOwnerGate('room-lifecycle-authority-native',async(f,{report,check,signal})=>{
 report.coordinator.push({path:'tests/fixtures/room-lifecycle-snapshot.mjs',sha256:sha256(await readFile(new URL('./fixtures/room-lifecycle-snapshot.mjs',import.meta.url)))});
 report.scope='Finite lifecycle late-clock/final-login/delegated-grant/current-role/status-entry-only boundaries. Empty playback/job collections are checked as setup and never asserted as populated cancellation/physical-drain coverage. No WS broadcast non-delivery/full races/unknown commit transport claim.';
 report.boundary_cases=[];report.ingress=[];let serial=0;
 const progress=resolve(f.root,'room-lifecycle-authority-progress.json');
 async function savePhase(phase){report.active_case.phase=phase;await writeFile(progress,JSON.stringify(report,null,2)+'\n');}
  async function bounded(work,ms=10000){
    let timer,abort,settled=false;
    return await new Promise((done,reject)=>{
      const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);fn(value);};
      abort=()=>finish(reject,signal.reason);
      timer=setTimeout(()=>finish(reject,Error('lifecycle_boundary_deadline')),ms);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      Promise.resolve(work).then(value=>finish(done,value),error=>finish(reject,error));
    });
  }
  async function cleanupBound(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned_cleanup_deadline')),12000);})]);}finally{clearTimeout(timer);}}
  async function waitSql(sql){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){signal.throwIfAborted();if(f.sql(sql)==='t')return;await new Promise(done=>setTimeout(done,25));}
    throw Error('lifecycle_boundary_witness_deadline');
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
  assert.equal(f.sql('SELECT count(*) FROM control_cluster_activation'),'0','Never override activated cluster policy');
  async function person(){const username=`lifecycle-boundary-${++serial}`;await admin.request('/users','POST',{username,password:f.password});const client=f.client(),live=f.client();const id=(await client.login(username)).id;await live.login(username);return {id,client,live};}
  async function subject(spec){
    const owner=await person(),member=await person();const room=await owner.client.request('/rooms','POST',{name:'Lifecycle authority boundary'});
    const invite=await owner.client.request(`/rooms/${room.id}/invites`,'POST');await member.client.request(`/rooms/${room.id}/join`,'POST',{token:invite.token});
    let actor=owner;
    if(spec.expiry==='grant'){actor=member;await owner.client.request(`/rooms/${room.id}/permissions/${member.id}`,'PUT',{role:'moderator',permissions:['close'],expires_in_seconds:3600});}
    if(spec.boundary==='principal'){actor=member;f.sql(`UPDATE users SET admin=true WHERE id=${uuid(member.id)}`);assert.equal((await member.live.request('/auth/me')).admin,true);}
    const epoch=randomUUID();f.sql(`INSERT INTO control_epochs(id,user_id,room_id) VALUES(${uuid(epoch)},${uuid(owner.id)},${uuid(room.id)})`);
    if(spec.action==='retry-cleanup'||spec.action==='reopen'||spec.action==='archive'){
      const life=spec.action==='retry-cleanup'?'closing':'closed';
      f.sql(`UPDATE rooms SET lifecycle=${quote(life)},lifecycle_epoch=1 WHERE id=${uuid(room.id)}; INSERT INTO room_cleanup_tasks(room_id,lifecycle_epoch,next_attempt_at,completed_at) VALUES(${uuid(room.id)},1,clock_timestamp()+interval '1 day',${life==='closed'?'clock_timestamp()':'NULL'})`);
    }
    // Synthetic future task for exactly the next closing epoch. Existing enqueue
    // ON CONFLICT DO NOTHING preserves this; original background claim cannot
    // immediately finish the empty fixture and race the committed clock snapshot.
    if(spec.boundary==='clock'&&spec.action==='close')f.sql(`INSERT INTO room_cleanup_tasks(room_id,lifecycle_epoch,next_attempt_at) SELECT id,lifecycle_epoch+1,clock_timestamp()+interval '1 day' FROM rooms WHERE id=${uuid(room.id)}`);
    return {owner,member,actor,room,epoch};
  }
  // Whole rows, no cap. Every current public application table with a direct room_id
  // is selected; session/job descendants are selected by genuine playback IDs.
  async function takeSnapshot(s,label){
    const room=uuid(s.room.id),ids=[s.owner.id,s.member.id].map(uuid).join(',');
    const columns=JSON.parse(f.sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name) ORDER BY table_name,column_name),'[]'::jsonb)::text FROM information_schema.columns WHERE table_schema='public' AND column_name IN('room_id','session_id','job_id') AND table_name IN(SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')`));
    const filters=new Map([['rooms',`id=${room}`],['users',`id IN(${ids})`],['sessions',`user_id IN(${ids})`],['user_profiles',`user_id IN(${ids})`]]);
    const session=`SELECT id FROM playback_sessions WHERE room_id=${room}`,job=`SELECT id FROM media_jobs WHERE session_id IN(${session})`;
    for(const c of columns){assert.match(c.table,/^[a-z_][a-z_0-9]*$/);const clause=c.column==='room_id'?`room_id=${room}`:c.column==='session_id'?`session_id IN(${session})`:`job_id IN(${job})`;filters.set(c.table,[filters.get(c.table),clause].filter(Boolean).join(' OR '));}
    filters.set('playback_requests',`room_id=${room}`);filters.set('playback_sessions',`room_id=${room}`);
    const pairs=[...filters].sort(([a],[b])=>a.localeCompare(b)).map(([table,where])=>`${quote(table)},COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM "${table}" x WHERE ${where}),'[]'::jsonb)`);
    const raw=f.sql(lifecycleSnapshotSql(pairs));return {raw,value:JSON.parse(raw),receipt:await privateFile(label,'rows.private.json',raw+'\n')};
  }
  async function clockSocket(s,label){
    const ws=new WebSocket(f.origin.replace('http','ws')+'/api/v1/ws',{headers:{Origin:f.origin,Cookie:s.owner.live.cookie}});const frames=[];let closed=false,socketError;
    const closePromise=new Promise(done=>ws.once('close',(code,reason)=>{closed=true;done({code,reason:reason.toString()});}));ws.on('error',error=>{socketError??=error;});ws.on('message',b=>{try{frames.push(JSON.parse(b));}catch(error){socketError??=error;}});
    const next=async(type,predicate=()=>true)=>{const until=Date.now()+10000;while(Date.now()<until){signal.throwIfAborted();if(socketError)throw socketError;const i=frames.findIndex(x=>x.type===type&&predicate(x));if(i>=0)return frames.splice(i,1)[0];if(closed)throw Error('clock_socket_closed');await new Promise(done=>setTimeout(done,10));}throw Error('clock_reply_deadline');};
    const close=async()=>{
      let receipt,cleanupError;
      try{if(!closed)ws.close(1000);receipt=await cleanupBound(closePromise);}catch(error){cleanupError=error;}
      // Observe failures even after the last sample, but finish owned close first.
      if(socketError&&cleanupError)throw new AggregateError([socketError,cleanupError],'clock_socket_error_and_cleanup_failed');
      if(cleanupError)throw cleanupError;if(socketError)throw socketError;
      return {...receipt,close_observed:closed};
    };
    try{await bounded(new Promise((done,reject)=>{ws.once('open',done);ws.once('error',reject);}));ws.send(JSON.stringify({type:'JOIN',room_id:s.room.id}));const snapshot=await next('SNAPSHOT');
      const sample=async suffix=>{const t1=randomUUID();ws.send(JSON.stringify({type:'CLOCK_SYNC',t1}));const reply=await next('CLOCK_SYNC_REPLY',x=>x.t1===t1);assert.equal(typeof reply.t3,'number');assert.ok(Number.isFinite(reply.t3));assert.equal(reply.clock_epoch,snapshot.state.clock_epoch);return {reply,receipt:await privateFile(label+'.'+suffix,'clock.private.json',JSON.stringify(reply)+'\n')};};
      return {snapshot,sample,close};
    }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'clock_socket_setup_cleanup_failed');}throw error;}
  }
  async function holder(spec,s){
    const marker=`lifecycle_holder_${randomUUID().replaceAll('-','')}`;
    const child=f.sqlProcess(undefined,{interactive:true});
    assert.ok(Number.isInteger(child.pid)&&child.pid>0);
    const stdout=[],stderr=[];let output='',releasePromise,backend;
    const record={holder_child_pid:child.pid,holder_backend_pid:null,close_observed:false,exit_code:null,signal:null,pid_absent:false,backend_pid_absent:false};
    child.once('close',(code,signal)=>Object.assign(record,{close_observed:true,exit_code:code,signal,closed_at:new Date().toISOString()}));
    child.stdin.on('error',()=>{});child.stderr.on('data',bytes=>stderr.push(Buffer.from(bytes)));
    const ready=new Promise((done,reject)=>{
      child.stdout.on('data',bytes=>{stdout.push(Buffer.from(bytes));output+=bytes.toString();if(output.includes(marker+'_ready'))done();});
      child.once('error',reject);
      child.done.then(()=>reject(Error('lifecycle_holder_closed_before_ready')),reject);
    });
    const login=testLoginHash(f,s.actor.client);
    const expirySelector=spec.expiry==='grant'?`FROM room_member_permissions WHERE room_id=${uuid(s.room.id)} AND user_id=${uuid(s.actor.id)}`:`FROM sessions WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)}`;
    const lock=spec.boundary==='epoch'?`SELECT id FROM control_epochs WHERE id=${uuid(s.epoch)} FOR UPDATE`
      :spec.boundary==='clock'?`SELECT room_id FROM room_snapshots WHERE room_id=${uuid(s.room.id)} FOR UPDATE`
      :spec.boundary==='read'?'LOCK TABLE room_cleanup_tasks IN ACCESS EXCLUSIVE MODE'
      :spec.boundary==='retry'?`SELECT room_id FROM room_cleanup_tasks WHERE room_id=${uuid(s.room.id)} FOR NO KEY UPDATE`
      :`UPDATE users SET admin=false WHERE id=${uuid(s.actor.id)}; SELECT ${quote(marker+'_staged_admin=')}||admin::text FROM users WHERE id=${uuid(s.actor.id)}`;
    child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`);
    async function release(){
      if(!releasePromise)releasePromise=(async()=>{
        const errors=[];
        try{child.stdin.end('COMMIT;\n\\q\n');let timer;
          try{await Promise.race([child.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('lifecycle_holder_close_deadline')),12000);})]);}
          finally{clearTimeout(timer);}
          assert.equal(record.close_observed,true);assert.equal(record.exit_code,0);assert.equal(record.signal,null);assert.equal(child.exitCode,0);
          record.pid_absent=verifyPidAbsent(child.pid);assert.equal(record.pid_absent,true);
          if(backend){record.backend_pid_absent=f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend})`)==='t';assert.equal(record.backend_pid_absent,true);}
        }catch(error){errors.push(error);}
        finally{
          try{record.stdout=await privateFile(spec.name,'holder.stdout.private.log',Buffer.concat(stdout));record.stderr=await privateFile(spec.name,'holder.stderr.private.log',Buffer.concat(stderr));}
          catch(error){errors.push(error);}
        }
        if(errors.length)throw new AggregateError(errors,'lifecycle_holder_cleanup_failed');return record;
      })();return releasePromise;
    }
    try{
      await bounded(ready);
      backend=Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name=${quote(marker)}`));
      assert.ok(Number.isInteger(backend)&&backend>0);record.holder_backend_pid=backend;
      if(spec.boundary==='principal')assert.ok(output.includes(marker+'_staged_admin=false'),'Real uncommitted holder demotion observed');
    }catch(error){try{report.active_case.blocker_cleanup=await release();}catch(cleanupError){report.active_case.blocker_cleanup={...record,completed:false,code:'owned_psql_setup_cleanup_unconfirmed'};throw new AggregateError([error,cleanupError],'lifecycle_holder_setup_and_cleanup_failed');}throw error;}
    const prefix=spec.boundary==='epoch'?'DELETE FROM control_epochs WHERE room_id=%'
      :spec.boundary==='principal'?'SELECT admin FROM users WHERE id=% FOR SHARE'
      :spec.boundary==='clock'?'SELECT state FROM room_snapshots WHERE room_id=% FOR UPDATE'
      :spec.boundary==='retry'?'UPDATE room_cleanup_tasks SET next_attempt_at=clock_timestamp()%'
      :'SELECT attempts,last_error,completed_at IS NOT NULL AS completed,%FROM room_cleanup_tasks%';
    const blockedWhere=`blocked.wait_event_type='Lock' AND blocked.query LIKE ${quote(prefix)} AND ${backend}=ANY(pg_blocking_pids(blocked.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${backend} AND held.application_name=${quote(marker)})`;
    const blockedPidsSql=`SELECT COALESCE(jsonb_agg(blocked.pid ORDER BY blocked.pid),'[]'::jsonb)::text FROM pg_stat_activity blocked WHERE ${blockedWhere}`;
    const expiryValueSql=`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${expirySelector}`;
    return {release,record,blockedWhere,blockedPidsSql,
      witness:`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE ${blockedWhere})`,
      expiryValueSql,expiry:`SELECT expires_at<=clock_timestamp() ${expirySelector}`,
      stableExpiry:exact=>`SELECT expires_at=${quote(exact)}::timestamptz AND clock_timestamp()>=${quote(exact)}::timestamptz ${expirySelector}`,
      blocked_query:spec.boundary==='epoch'?'control_epochs_delete':spec.boundary==='principal'?'current_admin_for_share':spec.boundary==='clock'?'snapshot_for_update':spec.boundary==='retry'?'cleanup_task_update':'cleanup_task_plain_select'};
  }

  for(const spec of cases){
    signal.throwIfAborted();const s=await subject(spec);
    const active={name:spec.name,action:spec.action,boundary:spec.boundary,room_id:s.room.id,actor_id:s.actor.id,phase:'setup',result:'running'};
    report.active_case=active;report.boundary_cases.push(active);await savePhase('setup');
    let block,pending,clock,requestSettled=false,responseObserved=false,failure;
    try{
      // Connect the independent clock observer BEFORE taking snapshot row locks.
      if(spec.boundary==='clock'){
        clock=await clockSocket(s,spec.name);
        active.observer_qualification=await clock.sample('qualification');
        assert.equal(clock.snapshot.lifecycle,spec.action==='close'?'active':'closed');
      }
      if(spec.expiry){
        const login=testLoginHash(f,s.actor.client);
        f.sql(spec.expiry==='grant'?`UPDATE room_member_permissions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE room_id=${uuid(s.room.id)} AND user_id=${uuid(s.actor.id)}`:`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(s.actor.id)} AND token_hash=${quote(login)}`);
      }
      const before=await takeSnapshot(s,spec.name+'.before');active.before=before.receipt;
      assert.deepEqual(before.value.playback_sessions,[]);assert.deepEqual(before.value.playback_requests,[]);
      active.empty_playback_job_setup=true;
      block=await holder(spec,s);active.holder_backend_pid=block.record.holder_backend_pid;active.holder_child_pid=block.record.holder_child_pid;
      if(spec.expiry){active.exact_expiry_utc=f.sql(block.expiryValueSql);assert.match(active.exact_expiry_utc,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);assert.equal(f.sql(block.stableExpiry(active.exact_expiry_utc).replace('clock_timestamp()>=','clock_timestamp()<')),'t');}
      if(spec.boundary==='principal'){assert.equal(f.sql(`SELECT admin FROM users WHERE id=${uuid(s.actor.id)}`),'t');active.committed_admin_before_request=true;}
      const revision=before.value.room_snapshots[0].state.revision;
      pending=s.actor.client.raw(`/rooms/${s.room.id}/${spec.action==='retry-cleanup'?'cleanup/retry':spec.action}`,{method:spec.action==='lifecycle'?'GET':'POST',body:spec.action==='lifecycle'?undefined:{expected_revision:revision},headers:spec.action==='lifecycle'?{Origin:'','x-csrf-token':''}:undefined});
      pending.then(()=>{requestSettled=true;},()=>{requestSettled=true;});await waitSql(block.witness);
      const pids=JSON.parse(f.sql(block.blockedPidsSql));assert.equal(pids.length,1);const blocked=pids[0];assert.ok(Number.isInteger(blocked)&&blocked>0);assert.notEqual(blocked,block.record.holder_backend_pid);
      active.blocked_backend_pid=blocked;active.actual_blocked_sql_qualification=spec.boundary;
      const witnessSql=`SELECT jsonb_build_object('database_clock_utc',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'holder',(SELECT to_jsonb(x) FROM (SELECT pid,application_name,backend_start,state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=${block.record.holder_backend_pid}) x),'blocked',(SELECT to_jsonb(x) FROM (SELECT pid,application_name,backend_start,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blocking_pids FROM pg_stat_activity WHERE pid=${blocked}) x))::text`;
      const witness=async suffix=>{const raw=f.sql(witnessSql),value=JSON.parse(raw);assert.equal(value.holder.pid,block.record.holder_backend_pid);assert.equal(value.blocked.pid,blocked);assert.equal(value.blocked.wait_event_type,'Lock');assert.ok(value.blocked.blocking_pids.includes(block.record.holder_backend_pid));return {value,receipt:await privateFile(spec.name+'.'+suffix,'pg-witness.private.json',raw+'\n')};};
      const first=await witness('initial');active.initial_pg_witness=first.receipt;assert.equal(requestSettled,false);await savePhase('qualified_actual_pending_edge');
      if(spec.expiry){assert.ok(first.value.database_clock_utc<active.exact_expiry_utc);await waitSql(block.expiry);assert.equal(f.sql(block.expiryValueSql),active.exact_expiry_utc);assert.equal(f.sql(block.stableExpiry(active.exact_expiry_utc)),'t');active.expiry_unchanged=true;}
      if(spec.boundary==='clock'){active.late_clock=await clock.sample('pending');assert.ok(active.late_clock.reply.t3>=active.observer_qualification.reply.t3);}
      assert.deepEqual(JSON.parse(f.sql(block.blockedPidsSql)),[blocked]);assert.equal(requestSettled,false);
      const second=await witness('pre-release');active.pre_release_pg_witness=second.receipt;
      assert.equal(first.value.holder.backend_start,second.value.holder.backend_start);assert.equal(first.value.blocked.backend_start,second.value.blocked.backend_start);active.same_blocking_edge_before_release=true;
      if(spec.expiry)assert.ok(second.value.database_clock_utc>=active.exact_expiry_utc);
      await savePhase('same_edge_before_release');active.blocker_cleanup=await block.release();
      const observed=await observeHttp(spec.name,pending);responseObserved=true;active.observed=observed.receipt;assert.equal(observed.response.status,spec.status);if(spec.code)assert.equal(observed.value.error.code,spec.code);
      const after=await takeSnapshot(s,spec.name+'.after');active.after=after.receipt;
      if(spec.boundary==='clock'){
        const value=observed.value,original=before.value.room_snapshots[0].state;
        assert.equal(value.lifecycle,spec.action==='close'?'closing':spec.action==='reopen'?'active':'archived');
        assert.equal(value.lifecycle_epoch,before.value.rooms[0].lifecycle_epoch+(spec.action==='archive'?0:1));
        assert.equal(value.state.revision,original.revision+1);assert.equal(value.state.playback_status,'paused');
        assert.equal(value.state.clock_epoch,active.late_clock.reply.clock_epoch);
        assert.ok(value.state.anchor_server_time_ms>=active.late_clock.reply.t3,'Clock sampled after actual pending snapshot wait');
        assert.deepEqual(after.value.room_snapshots[0].state,value.state);
        const diagnostic=after.value.room_events.find(e=>e.revision===value.state.revision);assert.ok(diagnostic);assert.equal(diagnostic.diagnostic.event_id,value.event_id);
        // Diagnostic operation's exact wire structure is required, not a search
        // for an unrelated number anywhere in the JSON envelope.
        active.committed_diagnostic=await privateFile(spec.name,'diagnostic.private.json',JSON.stringify(diagnostic)+'\n');
        assert.equal(diagnostic.diagnostic.operation.server_time_ms,value.state.anchor_server_time_ms);
        assert.ok(diagnostic.diagnostic.operation.server_time_ms>=active.late_clock.reply.t3);
        const life=after.value.room_lifecycle_events.find(e=>e.id===value.event_id);assert.ok(life);assert.equal(life.revision,value.state.revision);active.late_clock_both_snapshot_and_diagnostic=true;
      }else if(spec.boundary==='principal'){
        const expected=structuredClone(before.value);expected.users.find(u=>u.id===s.actor.id).admin=false;assert.deepEqual(after.value,expected);active.only_holder_admin_change=true;
      }else{assert.equal(after.raw,before.raw,'Complete selected rows unchanged, including original exact expiry');active.full_selected_rows_byte_equal=true;}
      if(spec.action==='lifecycle'){
        assert.deepEqual(observed.value.state,before.value.room_snapshots[0].state);assert.equal(observed.value.lifecycle,'active');assert.equal(observed.value.cleanup,null);
        active.entry_only_expired_response200=true;
      }
      if(spec.expiry==='login'){
        const repeat=await observeHttp(spec.name+'.expired-new',s.actor.client.raw(`/rooms/${s.room.id}/lifecycle`,{headers:{Origin:'','x-csrf-token':''}}));assert.equal(repeat.response.status,401);assert.equal(repeat.value.error.code,'SESSION_EXPIRED');active.expired_cookie_new_request=repeat.receipt;
      }
      const live=await observeHttp(spec.name+'.live-status',s.owner.live.raw(`/rooms/${s.room.id}/lifecycle`,{headers:{Origin:'','x-csrf-token':''}}));assert.equal(live.response.status,200);active.live_owner_status_control=live.receipt;
      active.result='passed';check(spec.name);await savePhase('complete');
    }catch(error){failure=error;active.result='failed';active.failure={code:'lifecycle_boundary_failed',phase:active.phase};try{active.private_first_failure=await privateFile(spec.name,'first-failure.private.json',JSON.stringify({name:error.name,message:error.message,stack:error.stack})+'\n');}catch(privateError){failure=new AggregateError([error,privateError],'lifecycle_first_failure_private_receipt_failed');}}
    finally{
      const errors=[];
      if(block){try{active.blocker_cleanup=await block.release();}catch(error){errors.push(error);active.blocker_cleanup={...block.record,completed:false};}}
      if(pending){try{const response=await cleanupBound(pending);if(!responseObserved&&!response.bodyUsed){const bytes=Buffer.from(await cleanupBound(response.text()));active.cleanup_http={status:response.status,body:await privateFile(spec.name+'.cleanup','http-body.private.json',bytes)};}}catch(error){active.cleanup_http_transport_failed=true;if(!failure)errors.push(error);}}
      if(clock){try{active.clock_socket_cleanup=await clock.close();}catch(error){errors.push(error);}}
      try{await savePhase(active.phase);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError([...(failure?[failure]:[]),...errors],'lifecycle_first_failure_and_owned_cleanup');
    }
    if(failure)throw failure;delete report.active_case;
  }
  assert.deepEqual(report.checks, requiredChecks.map((name) => ({ name, result: "passed" })),
    "Every frozen native check must complete exactly once");
});
