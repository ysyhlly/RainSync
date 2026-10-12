// External complete test-only proposal; independent review and root execution pending.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {nativeOwnerGate} from './fixtures/native-owner-gate.mjs';
import {testLoginHash} from './fixtures/playback-admission.mjs';
import {verifyPidAbsent} from './fixtures/postgres.mjs';
import {privateFailureDetails} from './fixtures/short-platform-account-response.mjs';
import {sha256} from '../scripts/native-owner-binding.mjs';
assert.equal(process.argv.length,2);
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
const uuid=v=>{assert.match(v,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);return quote(v);};
const policySelect='SELECT EXISTS(SELECT 1 FROM room_guest_access WHERE room_id=$1 AND enabled)';
const policyWrite='INSERT INTO room_guest_access(room_id,enabled,updated_by) VALUES($1,$2,$3) ON CONFLICT(room_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()';
const adminSelect='SELECT admin FROM users WHERE id=$1 FOR SHARE';
// Diagnostic-only helpers. Never import this native entrypoint from a unit test.
const authSelect='SELECT u.id,u.admin,s.csrf,u.principal_kind FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>clock_timestamp() AND playback_login_allowed(u.id,s.token_hash) AND NOT EXISTS(SELECT 1 FROM account_exits e WHERE e.user_id=u.id)';
const boundaryFailureCodes=new Set([
 'guest_sql_witness_deadline','guest_boundary_deadline','owner_gate_timeout',
 'expiry_reached_before_request','unique_blocked_backend_failed','exact_pg_edge_failed',
 'request_settled_before_wait','first_witness_not_before_expiry','original_deadline_changed',
 'same_edge_no_longer_pending','backend_identity_changed','database_clock_not_reached',
]);
function safeBoundaryFailureCode(error){
 try{const code=error?.message;return boundaryFailureCodes.has(code)?code:'guest_boundary_failed';}
 catch{return 'guest_boundary_failed';}
}
const diagnosticRelations=['room_guest_access','sessions','users','guest_principals','account_exits','rooms','room_members','admin_settings'];
const diagnosticModes=['AccessShareLock','RowShareLock','RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'];
const diagnosticWaitEvents=['relation','extend','frozenid','page','tuple','transactionid','virtualxid','spectoken','object','userlock','advisory','applytransaction'];
function boundaryDiagnosticSql({pid,backendStart,marker},deadline){
 assert.ok(Number.isInteger(pid)&&pid>0);
 assert.match(marker,/^guest_policy_holder_[0-9a-f]{32}$/);
 if(deadline!==undefined)assert.match(deadline,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
 const timestamp=alias=>`to_char(${alias}.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
 // No session selector, SQL parameters, SQL text, database name, or arbitrary
 // relation names enter the result. Only waiters blocked by this owned identity.
 return `BEGIN READ ONLY;
SET LOCAL statement_timeout='1s'; SET LOCAL lock_timeout='250ms';
WITH owned_holder AS MATERIALIZED (
 SELECT pid,backend_start FROM pg_stat_activity
 WHERE pid=${pid} AND backend_start=${quote(backendStart)}::timestamptz
 AND datname=current_database() AND application_name=${quote(marker)}
), blocked AS MATERIALIZED (
 SELECT a.pid,a.backend_start,a.wait_event_type,a.wait_event,pg_blocking_pids(a.pid) AS blockers,
 CASE a.query WHEN ${quote(authSelect)} THEN 'auth_select' WHEN ${quote(policySelect)} THEN 'policy_select' ELSE 'other' END AS query_class
 FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock'
 AND EXISTS(SELECT 1 FROM owned_holder h WHERE h.pid=ANY(pg_blocking_pids(a.pid)))
 ORDER BY a.pid LIMIT 9
), selected_waiters AS MATERIALIZED (SELECT * FROM blocked ORDER BY pid LIMIT 8),
 relevant_locks AS MATERIALIZED (
 SELECT l.pid,CASE WHEN n.nspname='public' AND c.relname IN(${diagnosticRelations.map(quote).join(',')}) THEN c.relname ELSE 'other' END AS relation,l.mode,l.granted
 FROM pg_locks l LEFT JOIN pg_class c ON c.oid=l.relation LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE l.locktype='relation' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
 AND l.pid IN(SELECT pid FROM owned_holder UNION ALL SELECT pid FROM selected_waiters)
 ORDER BY l.pid,l.relation,l.mode,l.granted LIMIT 65
)
SELECT jsonb_build_object(
 'database_deadline_reached',${deadline===undefined?'NULL':`clock_timestamp()>=${quote(deadline)}::timestamptz`},
 'holder',(SELECT jsonb_build_object('pid',h.pid,'backend_start',${timestamp('h')}) FROM owned_holder h),
 'waiters',COALESCE((SELECT jsonb_agg(jsonb_build_object('pid',w.pid,'backend_start',${timestamp('w')},'query_class',w.query_class,'blocking_pids',w.blockers[1:8],'blockers_truncated',cardinality(w.blockers)>8,'wait_event_type',w.wait_event_type,'wait_event',w.wait_event) ORDER BY w.pid) FROM selected_waiters w),'[]'::jsonb),
 'waiters_truncated',(SELECT count(*)>8 FROM blocked),
 'locks',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM (SELECT * FROM relevant_locks LIMIT 64) l),'[]'::jsonb),
 'locks_truncated',(SELECT count(*)>64 FROM relevant_locks)
)::text;
ROLLBACK;`;
}
function safeBoundaryDiagnostic(value){
 const valid=ok=>{if(!ok)throw Error('guest_diagnostic_invalid_result');};
 const pid=value=>{valid(Number.isInteger(value)&&value>0);return value;};
 const flag=value=>{valid(typeof value==='boolean');return value;};
 const backend=value=>{valid(value&&typeof value==='object');valid(typeof value.backend_start==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.backend_start));return {pid:pid(value.pid),backend_start:value.backend_start};};
 const list=(value,max)=>{valid(Array.isArray(value)&&value.length<=max);return value;};
 const allowed=(value,choices)=>choices.includes(value)?value:'other';
 valid(value&&typeof value==='object');
 valid(value.database_deadline_reached===null||typeof value.database_deadline_reached==='boolean');
 return {
  database_deadline_reached:value.database_deadline_reached,
  holder:value.holder===null?null:backend(value.holder),
  waiters:list(value.waiters,8).map(w=>({...backend(w),query_class:allowed(w.query_class,['auth_select','policy_select']),blocking_pids:list(w.blocking_pids,8).map(pid),blockers_truncated:flag(w.blockers_truncated),wait_event_type:w.wait_event_type==='Lock'?'Lock':'other',wait_event:allowed(w.wait_event,diagnosticWaitEvents)})),
  waiters_truncated:flag(value.waiters_truncated),
  locks:list(value.locks,64).map(l=>({pid:pid(l.pid),relation:allowed(l.relation,diagnosticRelations),mode:allowed(l.mode,diagnosticModes),granted:flag(l.granted)})),
  locks_truncated:flag(value.locks_truncated),
 };
}
async function captureBoundaryDiagnostic(sqlProcess,sql){
 // A dedicated owned psql has a wall-clock bound even if connection/query/exit
 // stalls. The fixture remains responsible for its final positive cleanup.
 return await new Promise(resolve=>{
  let child,timer,cleanupTimer,stopping,finished=false,bytes=0,output='';
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(cleanupTimer);resolve(result);};
  const stop=code=>{
   if(finished||stopping)return;stopping=code;
   cleanupTimer=setTimeout(()=>finish({capture_code:'guest_diagnostic_cleanup_unconfirmed'}),500);
   try{child.kill('SIGKILL');}catch{finish({capture_code:'guest_diagnostic_cleanup_unconfirmed'});}
  };
  try{
   child=sqlProcess(undefined,{interactive:true});
   child.done.catch(()=>{});
   child.once('error',()=>stop('guest_diagnostic_query_failed'));
   child.stdin.on('error',()=>stop('guest_diagnostic_query_failed'));
   child.stdout.on('error',()=>stop('guest_diagnostic_query_failed'));
   child.once('close',(code,term)=>{
    if(stopping)return finish({capture_code:stopping});
    if(code!==0||term)return finish({capture_code:'guest_diagnostic_query_failed'});
    try{finish({capture_code:'guest_diagnostic_captured',...safeBoundaryDiagnostic(JSON.parse(output))});}
    catch{finish({capture_code:'guest_diagnostic_invalid_result'});}
   });
   child.stdout.on('data',chunk=>{
    if(stopping||finished)return;bytes+=chunk.length;
    if(bytes>65536)return stop('guest_diagnostic_output_limit');
    output+=chunk.toString();
   });
   timer=setTimeout(()=>stop('guest_diagnostic_timeout'),2000);
   child.stdin.end(`\\set QUIET on\n${sql}\n\\q\n`);
  }catch{
   if(child)stop('guest_diagnostic_query_failed');
   else finish({capture_code:'guest_diagnostic_unavailable'});
  }
 });
}
// This fixed set is independent of dynamic case lists: missing, duplicate, or unknown checks fail.
const requiredChecks = [
  "get_put_ingress_precedence",
  "get_entry_only_natural_expiry_policy_select",
  "disable_off_on_never_restores_exact_old_guest",
  "put_trigger_natural_expiry_full_rollback",
  "put_admin_demotion_before_share"
];
await nativeOwnerGate('room-guest-access-authority-native',async(f,{report,check,signal})=>{
 report.scope='Finite real native PostgreSQL and loopback guest-access GET/PUT ingress, entry-only expiry, final exact-login rollback through genuine policy trigger, current-admin SHARE, irreversible old guest revocation. Empty media is no physical drain or WS delivery evidence.';
 report.cases=[];report.ingress=[];let serial=0,fileSerial=0;
 let active;
 const fixed=(ok,code)=>{if(!ok)throw Error(code);};
 async function privateFile(label,suffix,raw){const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw),path=resolve(f.root,`${++fileSerial}.${label}.${suffix}`);await writeFile(path,bytes,{flag:'wx',mode:0o600});return {path,bytes:bytes.length,sha256:sha256(bytes)};}
 async function phase(name){active.phase=name;await writeFile(resolve(f.root,'guest-access-progress.safe.json'),JSON.stringify({cases:report.cases,ingress:report.ingress})+'\n');}
 async function bounded(work,ms=10000,aborting=true){let timer,abort,settled=false;return await new Promise((done,reject)=>{const finish=(fn,v)=>{if(settled)return;settled=true;clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);fn(v);};timer=setTimeout(()=>finish(reject,Error('guest_boundary_deadline')),ms);if(aborting){abort=()=>finish(reject,signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}Promise.resolve(work).then(v=>finish(done,v),e=>finish(reject,e));});}
 const cleanupBound=work=>bounded(work,12000,false);
 async function waitSql(sql){const until=Date.now()+10000;while(Date.now()<until){signal.throwIfAborted();if(f.sql(sql)==='t')return;await new Promise(done=>setTimeout(done,25));}throw Error('guest_sql_witness_deadline');}
 async function http(label,pending,status,code){const response=await bounded(pending),bytes=Buffer.from(await bounded(response.text()));let value;try{value=JSON.parse(bytes);}catch{value=null;}const receipt={status:response.status,private_http:await privateFile(label,'http.private.json',JSON.stringify({status:response.status,status_text:response.statusText,headers:[...response.headers],body_utf8:bytes.toString()})+'\n'),private_body:await privateFile(label,'body.private.bin',bytes)};report.ingress.push({name:label,...receipt});fixed(response.status===status,'guest_http_status_mismatch');if(code)fixed(value?.error?.code===code,'guest_http_code_mismatch');return {value,receipt,response};}
 const admin=f.client();await admin.login();fixed(f.sql('SELECT count(*) FROM control_cluster_activation')==='0','activated_cluster_policy_not_supported');
 async function person(){const username=`guest-access-boundary-${++serial}`;await admin.request('/users','POST',{username,password:f.password});const client=f.client(),live=f.client();const identity=await client.login(username);await live.login(username);return {id:identity.id,client,live};}
 async function global(enabled){const before=await admin.request('/admin/settings');await admin.request('/admin/settings','PATCH',{expected_revision:before.revision,changes:{guests_enabled:enabled}});}
 async function subject(withGuest=false){const owner=await person(),member=await person(),outside=await person();const room=await owner.client.request('/rooms','POST',{name:'Guest authority boundary'}),invite=await owner.client.request(`/rooms/${room.id}/invites`,'POST',{max_uses:100});await member.client.request(`/rooms/${room.id}/join`,'POST',{token:invite.token});const s={owner,member,outside,room,invite};if(withGuest){await global(true);await owner.client.request(`/rooms/${room.id}/guest-access`,'PUT',{enabled:true});const client=f.client(),identity=await client.request(`/rooms/${room.id}/guest-session`,'POST',{token:invite.token,display_name:'Private guest boundary'},201);client.csrf=identity.csrf;s.guest={id:identity.id,client};}return s;}
 const readOptions={headers:{Origin:'','x-csrf-token':''}};
 const path=s=>`/rooms/${s.room.id}/guest-access`;
 // Keep every selected table while bounding each jsonb_build_object to two arguments.
 async function snapshot(s,label){const room=uuid(s.room.id),people=[s.owner,s.member,s.outside,s.guest].filter(Boolean).map(x=>uuid(x.id)).join(',');const columns=JSON.parse(f.sql("SELECT COALESCE(jsonb_agg(jsonb_build_object('table',table_name,'column',column_name) ORDER BY table_name,column_name),'[]'::jsonb)::text FROM information_schema.columns WHERE table_schema='public' AND column_name IN('room_id','session_id','job_id') AND table_name IN(SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')"));const filters=new Map([['rooms',`id=${room}`],['users',`id IN(${people})`],['sessions',`user_id IN(${people})`],['user_profiles',`user_id IN(${people})`],['guest_principals',`user_id IN(${people})`]]),sessions=`SELECT id FROM playback_sessions WHERE room_id=${room}`,jobs=`SELECT id FROM media_jobs WHERE session_id IN(${sessions})`;for(const c of columns){fixed(/^[a-z_][a-z_0-9]*$/.test(c.table),'snapshot_identifier_invalid');const where=c.column==='room_id'?`room_id=${room}`:c.column==='session_id'?`session_id IN(${sessions})`:`job_id IN(${jobs})`;filters.set(c.table,[filters.get(c.table),where].filter(Boolean).join(' OR '));}const pairs=[...filters].sort(([a],[b])=>a.localeCompare(b)).map(([table,where])=>`${quote(table)},COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM "${table}" x WHERE ${where}),'[]'::jsonb)`);const objectSql=pairs.map(pair=>`jsonb_build_object(${pair})`).join(' || ');const sql=`SELECT (${objectSql})::text`,raw=f.sql(sql);return {raw,value:JSON.parse(raw),receipt:await privateFile(label,'rows.private.json',raw+'\n'),sql:await privateFile(label,'snapshot-sql.private.sql',sql+'\n')};}
 async function runCase(name,work){
  active={name,phase:'setup',result:'running'};report.cases.push(active);
  try{await phase('setup');await work();active.result='passed';check(name);await phase('complete');}
  catch(error){
   active.result='failed';active.failure={code:'guest_access_case_failed',phase:active.phase};
   const errors=[error];let bytes;
   try{bytes=JSON.stringify(privateFailureDetails(error))+'\n';}
   catch(serializationError){errors.push(serializationError);bytes='{"code":"private_failure_serialization_failed"}\n';}
   try{active.private_first_failure=await privateFile(name,'first-failure.private.json',bytes);}
   catch(receiptError){errors.push(receiptError);}
   try{await phase(active.phase);}catch(saveError){errors.push(saveError);}
   throw new AggregateError(errors,'guest_access_case_failed');
  }
 }
 await runCase('get_put_ingress_precedence',async()=>{
  const s=await subject(true),p=path(s),missing=`/rooms/${randomUUID()}/guest-access`;
  const get=await http('get_owner_cookie_only',s.owner.client.raw(p,readOptions),200);fixed(JSON.stringify(Object.keys(get.value).sort())===JSON.stringify(['enabled','guests_enabled','invite_required','session_ttl_seconds'].sort()),'get_wire_fields');fixed(get.value.enabled===true&&get.value.guests_enabled===true&&get.value.session_ttl_seconds===7200&&get.value.invite_required===true,'get_wire_values');
  // identity guest_restricted is internal: http-api::errors uses ErrorCode::from_reason,
  // whose unknown-reason HTTP 403 fallback is the exact public FORBIDDEN code.
  await http('get_member',s.member.client.raw(p,readOptions),403,'FORBIDDEN');await http('get_guest',s.guest.client.raw(p,readOptions),403,'FORBIDDEN');await http('get_no_cookie',f.client().raw(missing,readOptions),401,'LOGIN_REQUIRED');await http('get_missing_admin',admin.raw(missing,readOptions),404,'NOT_FOUND');await http('get_admin',admin.raw(p,readOptions),200);
  await http('put_guest_before_bad_origin',s.guest.client.raw(missing,{method:'PUT',body:{enabled:false},headers:{Origin:'','x-csrf-token':''}}),403,'FORBIDDEN');await http('put_origin_before_missing',s.owner.client.raw(missing,{method:'PUT',body:{enabled:false},headers:{Origin:'','x-csrf-token':''}}),403,'ORIGIN_REJECTED');await http('put_csrf_before_missing',s.owner.client.raw(missing,{method:'PUT',body:{enabled:false},headers:{'x-csrf-token':''}}),403,'CSRF_REJECTED');await http('put_missing',s.owner.client.raw(missing,{method:'PUT',body:{enabled:false}}),404,'NOT_FOUND');
  for(const [label,body] of [['unknown_field',{enabled:true,extra:true}],['boolean_type',{enabled:'true'}],['required_boolean',{}]])await http(label,s.owner.client.raw(missing,{method:'PUT',body,headers:{Origin:'','x-csrf-token':''}}),422);
  await http('put_member',s.member.client.raw(p,{method:'PUT',body:{enabled:true}}),403,'FORBIDDEN');await http('put_outside',s.outside.client.raw(p,{method:'PUT',body:{enabled:true}}),403,'NOT_A_MEMBER');
  await s.owner.client.request(`/rooms/${s.room.id}/permissions/${s.member.id}`,'PUT',{role:'moderator',permissions:['close'],expires_in_seconds:3600});await http('put_delegate_not_owner',s.member.client.raw(p,{method:'PUT',body:{enabled:true}}),403,'FORBIDDEN');await http('put_admin_nonmember',admin.raw(p,{method:'PUT',body:{enabled:true}}),200);
  // Closing through genuine HTTP preserves lifecycle gate without synthetic trigger bypass.
  const life=await s.owner.client.request(`/rooms/${s.room.id}/lifecycle`);await s.owner.client.request(`/rooms/${s.room.id}/close`,'POST',{expected_revision:life.state.revision});await http('put_inactive',s.owner.client.raw(p,{method:'PUT',body:{enabled:true}}),409,'ROOM_NOT_ACTIVE');await http('get_inactive_owner',s.owner.client.raw(p,readOptions),200);
  const orphan=await subject();f.sql(`DELETE FROM room_members WHERE room_id=${uuid(orphan.room.id)} AND user_id=${uuid(orphan.owner.id)}`);await http('get_owner_without_membership',orphan.owner.client.raw(path(orphan),readOptions),200);await http('put_owner_without_membership',orphan.owner.client.raw(path(orphan),{method:'PUT',body:{enabled:true}}),403,'NOT_A_MEMBER');
  const disabled=await subject();await global(false);await http('put_global_disabled_owner',disabled.owner.client.raw(path(disabled),{method:'PUT',body:{enabled:true}}),200);const disclosure=await http('get_global_disabled_disclosure',disabled.owner.client.raw(path(disabled),readOptions),200);fixed(disclosure.value.enabled===true&&disclosure.value.guests_enabled===false,'global_disabled_disclosure');await global(true);
 });
 async function holder(spec,s,actor){
  const marker=`guest_policy_holder_${randomUUID().replaceAll('-','')}`,child=f.sqlProcess(undefined,{interactive:true});fixed(Number.isInteger(child.pid)&&child.pid>0,'holder_child_pid_invalid');const stdout=[],stderr=[];let output='',backend,backendStart,releasePromise;const record={holder_child_pid:child.pid,holder_backend_pid:null,close_observed:false,exit_code:null,signal:null,pid_absent:false,backend_absent:false};
  child.once('close',(code,term)=>Object.assign(record,{close_observed:true,exit_code:code,signal:term}));child.stdin.on('error',()=>{});child.stderr.on('data',b=>stderr.push(Buffer.from(b)));
  const ready=new Promise((done,reject)=>{child.stdout.on('data',b=>{stdout.push(Buffer.from(b));output+=b.toString();if(output.includes(marker+'_ready'))done();});child.once('error',reject);child.done.then(()=>reject(Error('holder_closed_before_ready')),reject);});
  const lock=spec.boundary==='policy'?'LOCK TABLE room_guest_access IN ACCESS EXCLUSIVE MODE':spec.boundary==='trigger'?`SELECT user_id FROM guest_principals WHERE user_id=${uuid(s.guest.id)} FOR NO KEY UPDATE`:`UPDATE users SET admin=false WHERE id=${uuid(actor.id)}; SELECT ${quote(marker+'_staged_admin=')}||admin::text FROM users WHERE id=${uuid(actor.id)}`;
  const setup=`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`;
  child.stdin.write(setup);
  async function release(){if(!releasePromise)releasePromise=(async()=>{const errors=[];try{child.stdin.end('COMMIT;\n\\q\n');await cleanupBound(child.done);fixed(record.close_observed&&record.exit_code===0&&record.signal===null&&child.exitCode===0,'holder_positive_close_failed');record.pid_absent=verifyPidAbsent(child.pid);fixed(record.pid_absent,'holder_child_present');if(backend){record.backend_absent=f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend})`)==='t';fixed(record.backend_absent,'holder_backend_present');}}catch(e){errors.push(e);}finally{try{record.private_setup_sql=await privateFile(spec.name,'holder-setup.private.sql',setup);}catch(e){errors.push(e);}try{record.stdout=await privateFile(spec.name,'holder.stdout.private.log',Buffer.concat(stdout));}catch(e){errors.push(e);}try{record.stderr=await privateFile(spec.name,'holder.stderr.private.log',Buffer.concat(stderr));}catch(e){errors.push(e);}}if(errors.length)throw new AggregateError(errors,'holder_cleanup_failed');return record;})();return releasePromise;}
  try{await bounded(ready);const tuple=JSON.parse(f.sql(`SELECT COALESCE(jsonb_agg(jsonb_build_object('pid',pid,'datname',datname,'backend_start',backend_start) ORDER BY pid),'[]'::jsonb)::text FROM pg_stat_activity WHERE application_name=${quote(marker)} AND datname=current_database()`));fixed(tuple.length===1,'holder_backend_not_unique');backend=tuple[0].pid;fixed(Number.isInteger(backend)&&backend>0,'holder_backend_pid_invalid');record.holder_backend_pid=backend;backendStart=tuple[0].backend_start;if(spec.boundary==='principal')fixed(output.includes(marker+'_staged_admin=false'),'holder_real_demotion_not_observed');}catch(e){try{active.holder_cleanup=await release();}catch(c){throw new AggregateError([e,c],'holder_setup_and_cleanup_failed');}throw e;}
  const query=spec.boundary==='policy'?policySelect:spec.boundary==='trigger'?policyWrite:adminSelect;
  const where=`blocked.datname=current_database() AND blocked.wait_event_type='Lock' AND blocked.query=${quote(query)} AND pg_blocking_pids(blocked.pid)=ARRAY[${backend}]::integer[] AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${backend} AND held.datname=blocked.datname AND held.application_name=${quote(marker)})`;
  const pidsSql=`SELECT COALESCE(jsonb_agg(blocked.pid ORDER BY blocked.pid),'[]'::jsonb)::text FROM pg_stat_activity blocked WHERE ${where}`;
  return {release,record,where,pidsSql,query,diagnosticSql:deadline=>boundaryDiagnosticSql({pid:backend,backendStart,marker},deadline),witness:`SELECT EXISTS(SELECT 1 FROM pg_stat_activity blocked WHERE ${where})`};
 }
 const cases=[{name:'get_entry_only_natural_expiry_policy_select',boundary:'policy',expiry:true,status:200},{name:'put_trigger_natural_expiry_full_rollback',boundary:'trigger',expiry:true,status:401,code:'SESSION_EXPIRED'},{name:'put_admin_demotion_before_share',boundary:'principal',status:403,code:'FORBIDDEN'}];
 for(const spec of cases)await runCase(spec.name,async()=>{
  const s=await subject(spec.boundary==='trigger'),actor=spec.boundary==='principal'?s.member:s.owner;
  if(spec.boundary==='principal'){f.sql(`UPDATE users SET admin=true WHERE id=${uuid(actor.id)}`);fixed((await actor.live.request('/auth/me')).admin===true,'committed_admin_setup_failed');}
  const login=testLoginHash(f,actor.client),selector=`FROM sessions WHERE user_id=${uuid(actor.id)} AND token_hash=${quote(login)}`,expirySql=`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${selector}`;
  let deadline;if(spec.expiry){f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(actor.id)} AND token_hash=${quote(login)}`);deadline=f.sql(expirySql);fixed(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(deadline),'exact_utc6_deadline_invalid');active.private_exact_deadline=await privateFile(spec.name,'deadline.private.json',JSON.stringify({deadline,selector,expiry_sql:expirySql})+'\n');}
  const before=await snapshot(s,spec.name+'.before');active.before=before.receipt;active.snapshot_sql=before.sql;fixed(before.value.playback_sessions.length===0&&before.value.playback_requests.length===0,'empty_media_setup_failed');active.empty_media_setup=true;
  let block,pending,response,bodyConsumed=false,requestSettled=false,failure,primaryFailed=false;const evidenceErrors=[];
  try{
   block=await holder(spec,s,actor);active.holder_child_pid=block.record.holder_child_pid;active.holder_backend_pid=block.record.holder_backend_pid;
   if(spec.boundary==='principal')fixed(f.sql(`SELECT admin FROM users WHERE id=${uuid(actor.id)}`)==='t','demotion_committed_too_soon');
   if(spec.expiry)fixed(f.sql(`SELECT expires_at=${quote(deadline)}::timestamptz AND clock_timestamp()<expires_at ${selector}`)==='t','expiry_reached_before_request');
   pending=actor.client.raw(path(s),spec.boundary==='policy'?readOptions:{method:'PUT',body:{enabled:false}});pending.then(()=>requestSettled=true,()=>requestSettled=true);await phase('request_started');await phase(spec.boundary==='policy'?'waiting_exact_policy_edge':'waiting_exact_top_level_sql_edge');await waitSql(block.witness);const pids=JSON.parse(f.sql(block.pidsSql));fixed(pids.length===1&&Number.isInteger(pids[0])&&pids[0]>0&&pids[0]!==block.record.holder_backend_pid,'unique_blocked_backend_failed');const blocked=pids[0];active.blocked_backend_pid=blocked;
   const witnessSql=`SELECT jsonb_build_object('clock',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'holder',(SELECT to_jsonb(x) FROM (SELECT pid,datname,application_name,backend_start,state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=${block.record.holder_backend_pid}) x),'blocked',(SELECT to_jsonb(x) FROM (SELECT pid,datname,application_name,backend_start,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blocking_pids FROM pg_stat_activity WHERE pid=${blocked}) x))::text`;
   async function witness(suffix){const raw=f.sql(witnessSql),value=JSON.parse(raw);fixed(value.holder?.pid===block.record.holder_backend_pid&&value.blocked?.pid===blocked&&value.holder.datname===value.blocked.datname&&value.blocked.query===block.query&&value.blocked.wait_event_type==='Lock'&&JSON.stringify(value.blocked.blocking_pids)===JSON.stringify([block.record.holder_backend_pid]),'exact_pg_edge_failed');return {value,receipt:await privateFile(spec.name+'.'+suffix,'witness.private.json',raw+'\n')};}
   const first=await witness('initial');active.initial_witness=first.receipt;fixed(!requestSettled,'request_settled_before_wait');await phase('qualified_exact_top_level_sql_edge');
   if(spec.expiry){fixed(first.value.clock<deadline,'first_witness_not_before_expiry');await waitSql(`SELECT expires_at=${quote(deadline)}::timestamptz AND clock_timestamp()>=expires_at ${selector}`);fixed(f.sql(expirySql)===deadline,'original_deadline_changed');}
   fixed(JSON.stringify(JSON.parse(f.sql(block.pidsSql)))===JSON.stringify([blocked])&&!requestSettled,'same_edge_no_longer_pending');const second=await witness('pre-release');active.pre_release_witness=second.receipt;fixed(first.value.holder.backend_start===second.value.holder.backend_start&&first.value.blocked.backend_start===second.value.blocked.backend_start,'backend_identity_changed');if(spec.expiry)fixed(second.value.clock>=deadline,'database_clock_not_reached');active.same_blocking_tuple_twice=true;await phase('same_tuple_before_release');active.holder_cleanup=await block.release();
   response=await bounded(pending);const bytes=Buffer.from(await bounded(response.text()));bodyConsumed=true;active.private_http=await privateFile(spec.name,'http.private.json',JSON.stringify({status:response.status,headers:[...response.headers],body_utf8:bytes.toString()})+'\n');active.private_body=await privateFile(spec.name,'body.private.bin',bytes);const value=JSON.parse(bytes);fixed(response.status===spec.status,'boundary_http_status');if(spec.code)fixed(value?.error?.code===spec.code,'boundary_http_code');
   const after=await snapshot(s,spec.name+'.after');active.after=after.receipt;
   if(spec.boundary==='principal'){const expected=structuredClone(before.value);expected.users.find(u=>u.id===actor.id).admin=false;fixed(JSON.stringify(after.value)===JSON.stringify(expected),'selected_rows_only_holder_demotion');active.only_holder_admin_change=true;await http(spec.name+'.live_owner_put',s.owner.live.raw(path(s),{method:'PUT',body:{enabled:true}}),200);}else{fixed(after.raw===before.raw,'complete_selected_rows_changed');active.selected_rows_whole_byte_equal=true;}
   if(spec.boundary==='policy'){fixed(value.enabled===false&&value.guests_enabled===true&&value.session_ttl_seconds===7200&&value.invite_required===true,'get_entry_only_wire');active.entry_only_expired_response200=true;}
   if(spec.expiry){fixed(f.sql(expirySql)===deadline,'post_http_deadline_changed');await http(spec.name+'.new_expired_cookie',actor.client.raw(path(s),readOptions),401,'SESSION_EXPIRED');}await http(spec.name+'.live_owner',s.owner.live.raw(path(s),readOptions),200);
   if(spec.boundary==='trigger'){
    await http('live_owner_disable',s.owner.live.raw(path(s),{method:'PUT',body:{enabled:false}}),200);const revoked=await snapshot(s,'trigger.live-disable');active.live_disable_rows=revoked.receipt;fixed(revoked.value.room_guest_access.length===1&&revoked.value.room_guest_access[0].enabled===false,'successful_policy_disable_missing');fixed(revoked.value.sessions.filter(x=>x.user_id===s.guest.id).length===0,'guest_sessions_not_deleted');const principal=revoked.value.guest_principals.find(x=>x.user_id===s.guest.id);fixed(principal?.revoked_at!==null&&principal?.display_name==='游客','guest_principal_not_retired');fixed(principal.login_hash===before.value.guest_principals.find(x=>x.user_id===s.guest.id).login_hash,'guest_login_identity_changed');await http('old_guest_after_disable',s.guest.client.raw('/auth/me'),401,'SESSION_EXPIRED');
    await http('live_owner_reenable',s.owner.live.raw(path(s),{method:'PUT',body:{enabled:true}}),200);await http('old_guest_after_off_on',s.guest.client.raw('/auth/me'),401,'SESSION_EXPIRED');const restored=await snapshot(s,'trigger.reenabled');active.reenable_rows=restored.receipt;fixed(restored.value.sessions.filter(x=>x.user_id===s.guest.id).length===0,'guest_sessions_resurrected');fixed(JSON.stringify(restored.value.guest_principals.find(x=>x.user_id===s.guest.id))===JSON.stringify(principal),'guest_principal_resurrected');active.off_on_old_guest_never_restored=true;check('disable_off_on_never_restores_exact_old_guest');
   }
  }catch(e){
   failure=e;primaryFailed=true;let bytes;
   // Observe before finally releases the owned holder; a diagnostic failure can
   // neither replace the original error nor weaken any exact-edge assertion.
   if(block){
    active.boundary_diagnostic={schema_version:1,phase:active.phase,request_started:Boolean(pending),request_settled:requestSettled,capture_code:'guest_diagnostic_unavailable'};
    try{
     active.boundary_diagnostic.failure_code=safeBoundaryFailureCode(e);
     Object.assign(active.boundary_diagnostic,await captureBoundaryDiagnostic((...args)=>f.sqlProcess(...args),block.diagnosticSql(deadline)));
    }catch{/* Only the fixed unavailable code is public; retain the original. */}
    active.boundary_diagnostic.request_settled_after_capture=requestSettled;
   }
   try{bytes=JSON.stringify(privateFailureDetails(e))+'\n';}catch(error){evidenceErrors.push(error);bytes='{"code":"private_failure_serialization_failed"}\n';}
   try{active.private_boundary_first_failure=await privateFile(spec.name,'boundary-first-failure.private.json',bytes);}catch(error){evidenceErrors.push(error);}
  }
  finally{
   const errors=[...evidenceErrors];if(block){try{active.holder_cleanup=await block.release();}catch(e){errors.push(e);active.holder_cleanup={...block.record,completed:false,code:'owned_holder_cleanup_unconfirmed'};}}
   if(pending){try{response??=await cleanupBound(pending);if(!bodyConsumed){const bytes=Buffer.from(await cleanupBound(response.text()));bodyConsumed=true;active.cleanup_body=await privateFile(spec.name,'cleanup-body.private.bin',bytes);}fixed(bodyConsumed&&response.bodyUsed,'pending_http_body_not_consumed');active.pending_http_body_consumed=true;}catch(e){errors.push(e);active.pending_http_cleanup={completed:false,code:'pending_http_cleanup_unconfirmed'};}}
   if(errors.length){
    let bytes;try{bytes=JSON.stringify(errors.map(e=>privateFailureDetails(e)))+'\n';}catch(error){errors.push(error);bytes='{"code":"private_failure_serialization_failed"}\n';}
    try{active.private_cleanup_failures=await privateFile(spec.name,'cleanup-failures.private.json',bytes);}catch(error){errors.push(error);}
    throw new AggregateError([...(primaryFailed?[failure]:[]),...errors],'first_failure_and_owned_cleanup');
   }
  }
  if(primaryFailed)throw failure;
 });
  assert.deepEqual(report.checks, requiredChecks.map((name) => ({ name, result: "passed" })),
    "Every frozen native check must complete exactly once");
});
