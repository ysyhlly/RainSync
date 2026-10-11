// Local authority fixture. Real database execution remains separately gated.
import assert from 'node:assert/strict';
import {randomUUID,createDecipheriv} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {nativeOwnerGate} from './fixtures/native-owner-gate.mjs';
import {testLoginHash} from './fixtures/playback-admission.mjs';
import {verifyPidAbsent} from './fixtures/postgres.mjs';
import {sha256} from '../scripts/native-owner-binding.mjs';
import {parseAccountSnapshot,assertImportRateIncrement} from './fixtures/short-platform-account-snapshot.mjs';
import {trackResponseBody,cleanupShortAccountCase,privateFailureDetails} from './fixtures/short-platform-account-response.mjs';
assert.equal(process.argv.length,2);
const quote=v=>`'${String(v).replaceAll("'","''")}'`;
const uuid=v=>{assert.match(v,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);return quote(v);};
const providers=['douyin','tiktok'];
const cookie='sessionid=owned-synthetic-session-1234567890; ttwid=fixture';
const body=(revision=null)=>({cookie,consent_to_store:true,expected_revision:revision});
const path=(provider,action)=>`/platform-accounts/${provider}${action==='import'?'/credential':''}`;
const method=action=>action==='status'?'GET':action==='import'?'PUT':'DELETE';
const SELECT='SELECT id FROM platform_accounts WHERE user_id=$1 AND provider=$2 FOR UPDATE';
const IMPORT="UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=NULL,revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND provider=$6 AND playback_login_allowed($5,$7)";
const UNLINK="UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider=$5 AND playback_login_allowed($4,$6)";
// This fixed set is independent of dynamic case lists: missing, duplicate, or unknown checks fail.
const requiredChecks = [
  "two_provider_complete_ingress_and_revision_wire",
  "provider_auth_csrf_json_priority",
  "status_exact_login_expiry_account_row_wait",
  "import_exact_login_expiry_account_admission_wait",
  "unlink_exact_login_expiry_account_admission_wait",
  "import_final_update_wait_exact_login_expiry",
  "unlink_final_update_wait_exact_login_expiry",
  "credential_expiry_and_overflow_projection"
];
await nativeOwnerGate('short-platform-account-authority-native',async(f,{report,check,signal})=>{
 report.scope='Eight finite groups, both short providers; real owned PostgreSQL/loopback HTTP. Synthetic local import only, no upstream validity/playback/provider network claim.';
 for(const name of ['short-platform-account-snapshot','short-platform-account-response'])report.coordinator.push({path:`tests/fixtures/${name}.mjs`,sha256:sha256(await readFile(new URL(`./fixtures/${name}.mjs`,import.meta.url)))});
 report.groups=[];let serial=0;
 async function privateFile(label,suffix,bytes){const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);const p=resolve(f.root,`${label}.${suffix}`);await writeFile(p,b,{flag:'wx',mode:0o600});return {path:p,bytes:b.length,sha256:sha256(b)};}
 async function bounded(work,ms=10000){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('short_fixture_deadline')),ms);})]);}finally{clearTimeout(timer);}}
 async function waitSql(sql){const until=Date.now()+10000;while(Date.now()<until){signal.throwIfAborted();if(f.sql(sql)==='t')return;await new Promise(done=>setTimeout(done,25));}throw Error('short_sql_witness_deadline');}
 async function http(label,pending,status,code,body=trackResponseBody(pending)){const response=await bounded(pending);const bytes=Buffer.from(await bounded(body.read()));let value;try{value=JSON.parse(bytes);}catch{value=null;}
  const receipt=await privateFile(label,'http.private.json',JSON.stringify({status:response.status,headers:[...response.headers],body_base64:bytes.toString('base64')})+'\n');
  report.active.receipts.push(receipt);assert.equal(response.status,status);if(code)assert.equal(value?.error?.code,code);return {value,response};}
 async function group(name,run){
  const active={name,phase:'setup',receipts:[],result:'running'};report.active=active;report.groups.push(active);
  try{await run();active.result='passed';check(name);}
  catch(error){
   active.result='failed';active.failure={code:'short_group_failed',phase:active.phase};
   const errors=[error];let bytes;
   try{bytes=JSON.stringify(privateFailureDetails(error))+'\n';}
   catch(serializationError){errors.push(serializationError);bytes='{"code":"private_failure_serialization_failed"}\n';}
   try{active.first_failure=await privateFile(name,'first-failure.private.json',bytes);}
   catch(receiptError){errors.push(receiptError);}
   throw new AggregateError(errors,'short_group_failed');
  }finally{delete report.active;}
 }
 const admin=f.client();await admin.login();assert.equal(f.sql('SELECT count(*) FROM control_cluster_activation'),'0');
 async function person(){const username=`short-account-${++serial}`;await admin.request('/users','POST',{username,password:f.password});const client=f.client(),live=f.client();const id=(await client.login(username)).id;await live.login(username);return {id,client,live};}
 async function snapshot(s,label){const filters={users:`id=${uuid(s.id)}`,sessions:`user_id=${uuid(s.id)}`,user_profiles:`user_id=${uuid(s.id)}`,platform_accounts:`user_id=${uuid(s.id)}`,platform_login_requests:`user_id=${uuid(s.id)}`,account_rate_limits:'true'};
  const pairs=Object.entries(filters).map(([t,w])=>`${quote(t)},COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM ${t} x WHERE ${w}),'[]'::jsonb)`);
  const captured=f.sql(`SELECT jsonb_build_object('rows',jsonb_build_object(${pairs.join(',')})::text,'clock',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text`);
  const capture=JSON.parse(captured);assert.equal(typeof capture.rows,'string');assert.match(capture.clock,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  const raw=capture.rows,receipt=await privateFile(label,'rows.private.json',captured+'\n');report.active.receipts.push(receipt);return {raw,value:parseAccountSnapshot(raw),databaseClock:capture.clock};}
 function account(rows,p){return rows.value.platform_accounts.find(x=>x.provider===p);}
 function dto(value,p,state,revision,id=null){assert.deepEqual(value,{id,provider:p,revision,state,credential_expires_at:null,login_method:'cookie_import',qr_available:false,verification:state==='connected'?'unverified':'none'});}
 function decrypt(row){const bytes=Buffer.from(row.credential_encrypted,'base64');assert.ok(bytes.length>28);const d=createDecipheriv('aes-256-gcm',Buffer.from(f.env.SOURCE_ENCRYPTION_KEY,'base64'),bytes.subarray(0,12));d.setAuthTag(bytes.subarray(-16));return JSON.parse(Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]));}
 async function imported(s,p,label){const response=await http(label,s.client.raw(path(p,'import'),{method:'PUT',body:body()}),200);const rows=await snapshot(s,label+'.stored');const row=account(rows,p);dto(response.value,p,'connected','2',row.id);assert.deepEqual(decrypt(row),{version:1,user_id:s.id,provider:p,account_id:row.id,revision:'2',cookies:cookie});return row;}
 function rateChange(before,after,s){assertImportRateIncrement(before.raw,after.raw,s.id,{before:before.databaseClock,after:after.databaseClock});}
 await group('two_provider_complete_ingress_and_revision_wire',async()=>{for(const p of providers){const s=await person();let v=await http(`${p}.missing`,s.client.raw(path(p,'status')),200);dto(v.value,p,'revoked',null);
  const before=await snapshot(s,`${p}.ingress-before`);
  await http(`${p}.consent`,s.client.raw(path(p,'import'),{method:'PUT',body:{...body(),consent_to_store:false}}),400);
  for(const invalid of ['', 'sessionid=short','ttwid=anonymous',cookie+';',cookie+'; sessionid=duplicate-private-session',cookie+'; SessionId=case-alias-private-session',cookie+'; Domain=.example.com',cookie+'; msToken=challenge',cookie+'\r\nHost:invalid.example','sessionid='+ 'x'.repeat(2049),cookie+'; '+(p==='douyin'?'tt_csrf_token':'passport_auth_status')+'=cross-provider'])await http(`${p}.cookie-${++serial}`,s.client.raw(path(p,'import'),{method:'PUT',body:{...body(),cookie:invalid}}),400);
  for(const revision of [2,'02','+2',' 2','0','-2','9223372036854775808',true,{}])await http(`${p}.revision-${++serial}`,s.client.raw(path(p,'import'),{method:'PUT',body:body(revision)}),400);
  assert.equal((await snapshot(s,`${p}.ingress-after`)).raw,before.raw);
  const row=await imported(s,p,`${p}.import`);v=await http(`${p}.status`,s.client.raw(path(p,'status')),200);dto(v.value,p,'connected','2',row.id);
  let prev=await snapshot(s,`${p}.conflict-before`);await http(`${p}.null-existing`,s.client.raw(path(p,'import'),{method:'PUT',body:body()}),409);rateChange(prev,await snapshot(s,`${p}.conflict-after`),s);
  v=await http(`${p}.unlink`,s.client.raw(path(p,'unlink'),{method:'DELETE',body:{expected_revision:'2'}}),200);dto(v.value,p,'revoked','3',row.id);
  prev=await snapshot(s,`${p}.stale-before`);await http(`${p}.stale`,s.client.raw(path(p,'unlink'),{method:'DELETE',body:{expected_revision:'2'}}),409);assert.equal((await snapshot(s,`${p}.stale-after`)).raw,prev.raw);
  v=await http(`${p}.noop-revoke`,s.client.raw(path(p,'unlink'),{method:'DELETE',body:{expected_revision:'3'}}),200);dto(v.value,p,'revoked','4',row.id);
  const replacement=await person(),first=await imported(replacement,p,`${p}.replace-seed`);const replaced=await http(`${p}.replace`,replacement.client.raw(path(p,'import'),{method:'PUT',body:body('2')}),200);const stored=account(await snapshot(replacement,`${p}.replace-stored`),p);dto(replaced.value,p,'connected','3',first.id);assert.deepEqual(decrypt(stored),{version:1,user_id:replacement.id,provider:p,account_id:first.id,revision:'3',cookies:cookie});assert.notEqual(stored.credential_encrypted,first.credential_encrypted);assert.notDeepEqual(Buffer.from(stored.credential_encrypted,'base64').subarray(0,12),Buffer.from(first.credential_encrypted,'base64').subarray(0,12));
  for(const session of ['sid_tt','sessionid_ss']){const parser=await person(),fields=['sid_guard','uid_tt','uid_tt_ss','sid_ucp_v1','ssid_ucp_v1','passport_csrf_token','passport_csrf_token_default','ttwid',...(p==='douyin'?['passport_auth_status','passport_auth_status_ss']:['tt_csrf_token','tt_chain_token'])];const pairs=[[session,'owned-synthetic-session-1234567890'],...fields.map(name=>[name,'fixture%3D'])];const raw=pairs.slice().reverse().map(([name,v])=>`${name}=${v}`).join('; ');const canonical=pairs.sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,v])=>`${name}=${v}`).join('; ');await http(`${p}.parser-${session}`,parser.client.raw(path(p,'import'),{method:'PUT',body:{...body(),cookie:' '+raw+' '}}),200);const r=account(await snapshot(parser,`${p}.parser-${session}.stored`),p);assert.equal(decrypt(r).cookies,canonical);}
  const absent=await person();v=await http(`${p}.absent-delete`,absent.client.raw(path(p,'unlink'),{method:'DELETE',body:{expected_revision:null}}),200);dto(v.value,p,'revoked','2',v.value.id);
  const mismatch=await person();prev=await snapshot(mismatch,`${p}.absent-string-before`);await http(`${p}.absent-string`,mismatch.client.raw(path(p,'unlink'),{method:'DELETE',body:{expected_revision:'1'}}),409);assert.equal((await snapshot(mismatch,`${p}.absent-string-after`)).raw,prev.raw);
 }});
 await group('provider_auth_csrf_json_priority',async()=>{const s=await person(),anonymous=f.client();for(const p of providers){for(const action of ['status','import','unlink']){const options={method:method(action),body:action==='import'?body():action==='unlink'?{expected_revision:null}:undefined};await http(`${p}.${action}.anonymous`,anonymous.raw(path(p,action),options),401);await http(`${p}.${action}.invalid-provider`,anonymous.raw(path('invalid',action),options),400);}
  for(const action of ['import','unlink']){const payload=action==='import'?body():{expected_revision:null};await http(`${p}.${action}.origin`,s.client.raw(path(p,action),{method:method(action),body:payload,headers:{Origin:'https://invalid.example'}}),403);await http(`${p}.${action}.csrf`,s.client.raw(path(p,action),{method:method(action),body:payload,headers:{'x-csrf-token':''}}),403);
  for(const bad of [{},{...payload,unknown:true}])await http(`${p}.${action}.json-${++serial}`,anonymous.raw(path('invalid',action),{method:method(action),body:bad}),422);
  await http(`${p}.${action}.cap`,anonymous.raw(path('invalid',action),{method:method(action),body:Buffer.from(JSON.stringify({...payload,padding:'x'.repeat(action==='import'?16384:1024)}))}),413);}
  await http(`${p}.read-origin-csrf`,s.client.raw(path(p,'status'),{headers:{Origin:'https://invalid.example','x-csrf-token':''}}),200);
 }
 const room=await admin.request('/rooms','POST',{name:'Short guest auth'}),invite=await admin.request(`/rooms/${room.id}/invites`,'POST',{max_uses:2});const settings=await admin.request('/admin/settings');await admin.request('/admin/settings','PATCH',{expected_revision:settings.revision,changes:{guests_enabled:true}});await admin.request(`/rooms/${room.id}/guest-access`,'PUT',{enabled:true});const guest=f.client();const entered=await guest.request(`/rooms/${room.id}/guest-session`,'POST',{token:invite.token,display_name:'Short synthetic guest'},201);guest.csrf=entered.csrf;
 for(const p of providers)for(const action of ['status','import','unlink'])await http(`${p}.${action}.guest`,guest.raw(path(p,action),{method:method(action),body:action==='import'?body():action==='unlink'?{expected_revision:null}:undefined}),403);
 });
 async function holder(s,row,boundary,label){const marker=`short_holder_${randomUUID().replaceAll('-','')}`,key=123456789;const child=f.sqlProcess(undefined,{interactive:true});const out=[],err=[];let text='',backend,releasePromise;const record={close_observed:false,exit_code:null,signal:null,pid_absent:false,backend_absent:false};child.once('close',(code,signal)=>Object.assign(record,{close_observed:true,exit_code:code,signal}));child.stdin.on('error',()=>{});child.stderr.on('data',b=>err.push(Buffer.from(b)));
  const ready=new Promise((done,reject)=>{child.stdout.on('data',b=>{out.push(Buffer.from(b));text+=b.toString();if(text.includes(marker+'_ready'))done();});child.once('error',reject);child.done.then(()=>reject(Error('holder_early_close')),reject);});
  const lock=boundary==='final'?`SELECT pg_advisory_xact_lock(${key})`:`SELECT id FROM platform_accounts WHERE id=${uuid(row.id)} FOR NO KEY UPDATE`;
  child.stdin.write(`BEGIN; SET LOCAL application_name=${quote(marker)}; SET LOCAL statement_timeout='12s'; SET LOCAL idle_in_transaction_session_timeout='15s'; ${lock};\n\\echo ${marker}_ready\n`);
  async function release(){return releasePromise??=(async()=>{
   const errors=[];
   try{child.stdin.end('COMMIT;\n\\q\n');await bounded(child.done,12000);assert.equal(record.close_observed,true);assert.equal(record.exit_code,0);assert.equal(record.signal,null);assert.equal(child.exitCode,0);record.pid_absent=verifyPidAbsent(child.pid);assert.equal(record.pid_absent,true);if(backend){record.backend_absent=f.sql(`SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${backend})`)==='t';assert.equal(record.backend_absent,true);}}
   catch(error){errors.push(error);}
   try{record.stdout=await privateFile(label,'holder.stdout.private.log',Buffer.concat(out));}catch(error){errors.push(error);}
   try{record.stderr=await privateFile(label,'holder.stderr.private.log',Buffer.concat(err));}catch(error){errors.push(error);}
   if(errors.length)throw new AggregateError(errors,'short_holder_cleanup_failed');return record;
  })();}
  try{await bounded(ready);backend=Number(f.sql(`SELECT pid FROM pg_stat_activity WHERE application_name=${quote(marker)}`));assert.ok(Number.isInteger(backend)&&backend>0);}catch(e){try{await release();}catch(cleanup){throw new AggregateError([e,cleanup],'holder_setup_cleanup');}throw e;}
  return {backend,marker,key,release,record};
 }
 async function expiryCase(action,boundary){for(const p of providers){const label=`${action}.${boundary}.${p}`,s=await person(),row=await imported(s,p,label+'.seed');let h,pending,responseBody,observed=false,failure,primaryFailed=false,trigger;
  try{if(boundary==='final'){const suffix=randomUUID().replaceAll('-','');trigger={name:`zz_short_boundary_${suffix}`,fn:`short_boundary_${suffix}`};f.sql(`CREATE FUNCTION ${trigger.fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${uuid(row.id)} THEN PERFORM pg_advisory_xact_lock(123456789); END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger.name} BEFORE UPDATE ON platform_accounts FOR EACH ROW EXECUTE FUNCTION ${trigger.fn}()`);}
   h=await holder(s,row,boundary,label);const login=testLoginHash(f,s.client);f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE user_id=${uuid(s.id)} AND token_hash=${quote(login)}`);
   const selector=`FROM sessions WHERE user_id=${uuid(s.id)} AND token_hash=${quote(login)}`,expiry=f.sql(`SELECT to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ${selector}`);assert.match(expiry,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);const before=await snapshot(s,label+'.before');report.active.phase='pending';let settled=false;
   pending=s.client.raw(path(p,action),{method:method(action),body:action==='import'?body('2'):action==='unlink'?{expected_revision:'2'}:undefined});responseBody=trackResponseBody(pending);pending.then(()=>settled=true,()=>settled=true);
   const exact=boundary==='final'?(action==='import'?IMPORT:UNLINK):SELECT;
   const where=`a.wait_event_type='Lock' AND a.query=${quote(exact)} AND ${h.backend}=ANY(pg_blocking_pids(a.pid)) AND EXISTS(SELECT 1 FROM pg_stat_activity held WHERE held.pid=${h.backend} AND held.application_name=${quote(h.marker)})`;
   const pids=()=>JSON.parse(f.sql(`SELECT COALESCE(jsonb_agg(a.pid ORDER BY a.pid),'[]'::jsonb)::text FROM pg_stat_activity a WHERE ${where}`));await waitSql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${where})`);const ids=pids();assert.equal(ids.length,1);const blocked=ids[0];assert.notEqual(blocked,h.backend);
   async function witness(suffix){assert.deepEqual(pids(),ids);assert.equal(settled,false);const raw=f.sql(`SELECT jsonb_build_object('clock',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'holder',(SELECT to_jsonb(x) FROM (SELECT pid,backend_start,application_name,state,query FROM pg_stat_activity WHERE pid=${h.backend}) x),'blocked',(SELECT to_jsonb(x) FROM (SELECT pid,backend_start,wait_event_type,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=${blocked}) x))::text`);const v=JSON.parse(raw);assert.equal(v.holder.pid,h.backend);assert.equal(v.holder.application_name,h.marker);assert.equal(v.blocked.pid,blocked);assert.equal(v.blocked.query,exact);assert.equal(v.blocked.wait_event_type,'Lock');assert.deepEqual(v.blocked.blockers,[h.backend]);report.active.receipts.push(await privateFile(label+'.'+suffix,'witness.private.json',raw+'\n'));return v;}
   const first=await witness('initial');assert.ok(first.clock<expiry);await waitSql(`SELECT clock_timestamp()>expires_at ${selector}`);assert.equal(f.sql(`SELECT expires_at=${quote(expiry)}::timestamptz AND clock_timestamp()>expires_at ${selector}`),'t');const second=await witness('expired');assert.ok(second.clock>expiry);assert.equal(first.holder.backend_start,second.holder.backend_start);assert.equal(first.blocked.backend_start,second.blocked.backend_start);
   report.active.receipts.push(await privateFile(label,'deadline.private.json',JSON.stringify({expiry,first,second})+'\n'));await h.release();await http(label,pending,401,'SESSION_EXPIRED',responseBody);observed=true;
   const after=await snapshot(s,label+'.after');if(action==='import')rateChange(before,after,s);else assert.equal(after.raw,before.raw);
   await http(label+'.sibling',s.live.raw(path(p,'status')),200);await http(label+'.expired-repeat',s.client.raw(path(p,'status')),401,'SESSION_EXPIRED');
  }catch(e){failure=e;primaryFailed=true;}finally{
   await cleanupShortAccountCase({pending,body:responseBody,wait:bounded,primaryError:failure,primaryFailed,
    release:h?async()=>{report.active.receipts.push(await privateFile(label,'holder-cleanup.private.json',JSON.stringify(await h.release())+'\n'));}:undefined,
    record:!observed?async(response,text)=>{report.active.receipts.push(await privateFile(label,'cleanup-http.private.json',JSON.stringify({status:response.status,body:text})+'\n'));}:undefined,
    drop:trigger?()=>{f.sql(`DROP TRIGGER ${trigger.name} ON platform_accounts; DROP FUNCTION ${trigger.fn}()`);}:undefined});
  }
 }}
 for(const [name,action,boundary] of [['status_exact_login_expiry_account_row_wait','status','admission'],['import_exact_login_expiry_account_admission_wait','import','admission'],['unlink_exact_login_expiry_account_admission_wait','unlink','admission'],['import_final_update_wait_exact_login_expiry','import','final'],['unlink_final_update_wait_exact_login_expiry','unlink','final']])await group(name,()=>expiryCase(action,boundary));
 await group('credential_expiry_and_overflow_projection',async()=>{for(const p of providers){const s=await person(),row=await imported(s,p,`${p}.expiry.seed`);f.sql(`UPDATE platform_accounts SET credential_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 WHERE id=${uuid(row.id)}`);const before=await snapshot(s,`${p}.expiry.before`);const v=await http(`${p}.expiry.status`,s.client.raw(path(p,'status')),200);assert.equal(v.value.state,'expired');assert.equal(v.value.revision,'4');assert.equal(v.value.verification,'none');const after=await snapshot(s,`${p}.expiry.after`);const prior=account(before,p),now=account(after,p);assert.equal(now.credential_encrypted,null);assert.equal(now.credential_expires_at,prior.credential_expires_at);assert.equal(now.revision,4n);const expected=structuredClone(before.value);Object.assign(expected.platform_accounts.find(x=>x.id===row.id),{state:'expired',revision:4n,credential_encrypted:null,updated_at:now.updated_at});assert.deepEqual(after.value,expected);
  const overflow=await person(),id=randomUUID();f.sql(`INSERT INTO platform_accounts(id,user_id,provider,state,revision) VALUES(${uuid(id)},${uuid(overflow.id)},${quote(p)},'revoked',9223372036854775807)`);
  let prev=await snapshot(overflow,`${p}.overflow.before`);await http(`${p}.overflow.unlink`,overflow.client.raw(path(p,'unlink'),{method:'DELETE',body:{expected_revision:'9223372036854775807'}}),500);assert.equal((await snapshot(overflow,`${p}.overflow.after`)).raw,prev.raw);
  prev=await snapshot(overflow,`${p}.overflow.import.before`);await http(`${p}.overflow.import`,overflow.client.raw(path(p,'import'),{method:'PUT',body:body('9223372036854775807')}),500);rateChange(prev,await snapshot(overflow,`${p}.overflow.import.after`),overflow);
 }});
  assert.deepEqual(report.checks, requiredChecks.map((name) => ({ name, result: "passed" })),
    "Every frozen native check must complete exactly once");
});
