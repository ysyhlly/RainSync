// External proposal: real original HTTP attempt upload/renew; full schema and owned PG.
// Not executed. Server verification/FFmpeg/ACK gates are specified separately.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedServer, delay } from './fixtures/server.mjs';
import { loadOwnerBinding, sha256 } from '../scripts/native-owner-binding.mjs';
import { withTerminationSignal } from '../deploy/owned-process.mjs';
import { verifyPidAbsent } from './fixtures/postgres.mjs';
const repo=process.cwd();
assert.equal(process.env.DATABASE_URL,undefined);
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN);
assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT,'1');
assert.equal(process.argv.length,2);
const binding=await loadOwnerBinding({root:repo,target:process.env.CARGO_TARGET_DIR,path:process.env.W03_BACKEND_BINDING,requireTest:true});
const rawBinding=JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
const allArtifacts=[...rawBinding.binaries,...rawBinding.test_helpers,...rawBinding.owner_fixtures];
const verifyArtifacts=async()=>{for(const a of allArtifacts)assert.equal(sha256(await readFile(a.path)),a.sha256,'Full producer artifact drift');};
await verifyArtifacts();
const summaryPath=resolve(process.env.RAINSYNC_ARTIFACT_DIR,`compute-attempt-upload-coordinator-${randomUUID()}.json`);
const sources=['tests/distributed-compute-attempt-upload-native.mjs','tests/fixtures/server.mjs','tests/fixtures/postgres.mjs','tests/fixtures/unused-port.mjs','scripts/native-owner-binding.mjs','deploy/owned-process.mjs'];
const snapshot=()=>Promise.all(sources.map(async path=>({path,sha256:sha256(await readFile(resolve(repo,path)))})));
const initial=await snapshot();
const tables=['agents','distributed_compute_policy','distributed_compute_nodes','distributed_compute_sources','distributed_compute_jobs','distributed_compute_attempts','distributed_compute_files','sources','media_items','rooms','room_snapshots','room_members','sessions','private_libraries','library_grants','playback_sessions','playback_requests'];
const report={result:'running',scope:'original HTTP renew/upload plus actual uploaded bytes and SQL rollback; no encoder, finish ACK, browser or global deadlock proof',cases:[],binding:binding.summary,coordinator:initial,all_artifacts:allArtifacts.map(({name,test_name,path,sha256})=>({name,test_name,path,sha256})),summary_path:summaryPath};
const recipe='remux_hls_v1',hd='h264_2160p_hls_v1',version=`stat-v1:${'a'.repeat(64)}`,digest='b'.repeat(64);
// Private snapshots intentionally retain complete rows, including synthetic credentials.
async function run(name,body,signal){
 const parentSignal=signal;const local=new AbortController();const timer=setTimeout(()=>local.abort(Error('placement_case_deadline')),180000);signal=AbortSignal.any([parentSignal,local.signal]);
 let fixture,failed=false,primary,evidenceErrors=[],logStates=[],entry={name,result:'running'};report.cases.push(entry);
 try{await isolatedServer('compute-attempt-upload-'+name,async f=>{
 fixture=f;await binding.verify();
 const exe=await readlink(`/proc/${f.serverPid}/exe`),bytes=await readFile(`/proc/${f.serverPid}/exe`);
 assert.equal(exe,binding.server);assert.equal(sha256(bytes),binding.summary.binaries.find(x=>x.name==='rainsync-server').sha256);
 entry.executable={pid:f.serverPid,path:exe,sha256:sha256(bytes)};
 const observe=()=>JSON.parse(f.sql('SELECT jsonb_build_object('+tables.map(t=>`'${t}',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM ${t} x),'[]'::jsonb)`).concat("'clock',clock_timestamp()").join(',')+')'));
 const save=async(label)=>{const rows=observe();const path=resolve(f.root,label+'.private.json');const bytes=JSON.stringify(rows)+'\n';await writeFile(path,bytes,{flag:'wx',mode:0o600});entry.snapshots??=[];entry.snapshots.push({label,path,sha256:sha256(bytes)});return rows;};
 const admin=f.client();await admin.login();
 const makeAgent=async(label)=>{const a=await admin.request('/agents','POST',{name:label});return{id:a.id,...await admin.request('/agents/pair','POST',{code:a.pair_code}),connection:randomUUID()};};
 const origin=await makeAgent('origin'),node=await makeAgent('replica');
 const api=async(a,path,body,expected=200)=>{await save('http-before-'+randomUUID());const response=await fetch(f.origin+'/api/v1'+path,{method:'POST',headers:{Authorization:`Bearer ${a.token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});const value=await response.json();const after=await save('http-after-'+randomUUID());entry.http??=[];entry.http.push({path,status:response.status,value});if(Array.isArray(expected))assert.ok(expected.includes(response.status),`${path} observed status`);else assert.equal(response.status,expected,`${path} status`);return value;};
 const policy=(a,budget=67108864,slots=1)=>admin.request(`/agents/${a.id}/compute-policy`,'POST',{enabled:true,slots,output_budget_bytes:budget});
 const advertisedCapabilities=new Map();
 const beat=async(a,caps=advertisedCapabilities.get(a.id)??[recipe,hd])=>{
   const value=await api(a,'/agent-compute/heartbeat',{connection_id:a.connection,capabilities:caps,self_test:{}});
   // Record only a successfully accepted advertisement; freshness preserves it.
   advertisedCapabilities.set(a.id,[...caps]);return value;
 };
 for(const a of[origin,node]){await policy(a);await beat(a);f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${a.id}','${a===origin?'origin':'replica'}','agent','synthetic-placement')`);}
 const media=randomUUID(),replica=randomUUID();
 for(const[a,m,resource]of[[origin,media,'origin.mp4'],[node,replica,'replica.mp4']]){
 f.sql(`INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${m}','${a.id}','placement','${resource}','${version}')`);
 await api(a,'/agent-compute/catalog',{media_id:m,source_version:version,content_sha256:digest,size_bytes:1024});}
 const room=await admin.request('/rooms','POST',{name:'placement'});
 f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1) WHERE room_id='${room.id}'`);
 const duration=n=>f.sql(`UPDATE media_items SET metadata='${JSON.stringify({capability_source_version:version,format:{duration:String(n)},streams:[{index:0,codec_type:'video'}]})}'::jsonb WHERE id='${media}'`);duration(1);
 const prepare=async(r=recipe)=>{await beat(origin);await beat(node);return admin.request(`/rooms/${room.id}/compute`,'POST',{media_generation:1,recipe:r});};
 const claim=async(a=node,connection=a.connection,expected=200,refresh=true)=>{if(refresh)await beat(a);return api(a,'/agent-compute/claim',{connection_id:connection},expected);};
 const cancel=j=>admin.request(`/rooms/${room.id}/compute/${j.id}`,'DELETE');
 const sql=f.sql;
 await body({f,origin,node,media,replica,room,observe,save,policy,beat,prepare,claim,cancel,duration,sql,signal,entry,agentRequest:api});
 await save('final');entry.executable_after={pid:f.serverPid,path:await readlink(`/proc/${f.serverPid}/exe`),sha256:sha256(await readFile(`/proc/${f.serverPid}/exe`))};assert.deepEqual(entry.executable_after,entry.executable);await binding.verify();assert.deepEqual(await snapshot(),initial);
 },{binary:binding.server,signal,beforeStart:f=>{fixture=f;f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT=resolve(f.root,'published');},observeServerLog:(stream,path)=>{const x={path,finished:false,closed:false,failed:false};logStates.push(x);stream.once('finish',()=>x.finished=true);stream.once('close',()=>x.closed=true);stream.once('error',()=>x.failed=true);}});
 }catch(error){failed=true;primary=error;if(fixture)try{await writeFile(resolve(fixture.root,'failure.private.log'),String(error.stack??error),{flag:'wx',mode:0o600});}catch(e){evidenceErrors.push(e);}}
 finally{clearTimeout(timer);const errors=[...evidenceErrors];if(fixture){try{entry.cleanup=await fixture.verifyStopped();}catch(e){errors.push(e);}for(const x of logStates){try{const end=Date.now()+5000;while(!x.closed&&Date.now()<end)await delay(10);assert.ok(x.closed&&x.finished&&!x.failed);const bytes=await readFile(x.path);entry.logs??=[];entry.logs.push({...x,bytes:bytes.length,sha256:sha256(bytes)});}catch(e){errors.push(e);}}entry.result=failed||errors.length?'failed':'passed';try{await writeFile(resolve(fixture.root,'evidence.json'),JSON.stringify({schema_version:1,...entry,scope:report.scope,binding:binding.summary,coordinator:initial})+'\n',{flag:'wx',mode:0o600});}catch(e){errors.push(e);}}if(errors.length)throw new AggregateError([...(failed?[primary]:[]),...errors],'placement cleanup failed');}
 if(failed)throw primary;
}
// Actual owned lock: full uncapped stdout/stderr file; fresh statement waiter witness.
async function locked(c,table,idColumn,id,action,{holdMs=0,afterWitness}={}){
 const tag='placement-'+randomUUID(),child=c.f.sqlProcess(undefined,{interactive:true});
 const chunks=[];child.stdout.on('data',x=>chunks.push(x));child.stderr.on('data',x=>chunks.push(x));
 let close;const closed=new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{close={pid:child.pid,code,signal};done();});});closed.catch(()=>{});
 let pending,failed=false,primary,witness,releaseWitness,holderIdentity,blockedBackendPid;const lockStarted=Date.now();
 try{child.stdin.write(`SET application_name='${tag}'; BEGIN; SELECT ${idColumn} FROM ${table} WHERE ${idColumn}='${id}' FOR UPDATE; SELECT 'OWNED_LOCK_READY';\n`);
 const until=async(test)=>{const end=Date.now()+5000;while(!test()&&Date.now()<end)await delay(10);assert.ok(test(),'owned lock witness');};
 await until(()=>Buffer.concat(chunks).toString().includes('OWNED_LOCK_READY'));
 holderIdentity={child_pid:child.pid,backend_pid:Number(c.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${tag}'`)),application_name:tag};
 assert.ok(Number.isInteger(holderIdentity.child_pid)&&holderIdentity.child_pid>0);assert.ok(Number.isInteger(holderIdentity.backend_pid)&&holderIdentity.backend_pid>0);
 pending=action();pending.catch(()=>{});
 await until(()=>Number(c.sql(`SELECT count(*) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND '${tag}'=(SELECT b.application_name FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid)) LIMIT 1)`))===1);
 witness=JSON.parse(c.sql(`SELECT jsonb_agg(jsonb_build_object('pid',a.pid,'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,'blocker_pids',pg_blocking_pids(a.pid),'query',a.query,'clock',clock_timestamp())) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND '${tag}'=(SELECT b.application_name FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid)) LIMIT 1)`));assert.equal(witness.length,1);blockedBackendPid=Number(witness[0].pid);assert.ok(Number.isInteger(blockedBackendPid)&&blockedBackendPid>0);assert.ok(witness[0].blocker_pids.includes(holderIdentity.backend_pid));assert.equal(Number(c.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${tag}'`)),holderIdentity.backend_pid);
 if(afterWitness)await afterWitness();
 if(holdMs)await delay(holdMs);
 // Fresh real relation after expiry/witness callback and immediately before release.
 releaseWitness=JSON.parse(c.sql(`SELECT jsonb_agg(jsonb_build_object('pid',a.pid,'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,'blocker_pids',pg_blocking_pids(a.pid),'query',a.query,'clock',clock_timestamp())) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND '${tag}'=(SELECT b.application_name FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid)) LIMIT 1)`));
 assert.ok(Array.isArray(releaseWitness));assert.equal(releaseWitness.length,1);assert.equal(Number(releaseWitness[0].pid),blockedBackendPid);assert.ok(releaseWitness[0].blocker_pids.includes(holderIdentity.backend_pid));assert.equal(Number(c.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${tag}'`)),holderIdentity.backend_pid);assert.equal(child.pid,holderIdentity.child_pid);
 }catch(e){failed=true;primary=e;}
 finally{
 const errors=[];child.stdin.end('ROLLBACK;\n\\q\n');let closeTimer;
 try{await Promise.race([Promise.all([child.done,closed]),new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(Error('owned lock close deadline')),10000);})]);}catch(error){errors.push(error);child.kill('SIGTERM');let killTimer;try{await Promise.race([closed,new Promise((_,reject)=>{killTimer=setTimeout(()=>reject(Error('owned lock signal close unconfirmed')),5000);})]);}catch(e){errors.push(e);}finally{clearTimeout(killTimer);}}finally{clearTimeout(closeTimer);}
 try{assert.ok(close&&verifyPidAbsent(child.pid));assert.equal(close.code,0);}catch(e){errors.push(e);}
 try{await writeFile(resolve(c.f.root,tag+'.private.log'),Buffer.concat(chunks),{flag:'wx',mode:0o600});c.entry.locks??=[];c.entry.locks.push({...close,holder_identity:holderIdentity,blocked_backend_pid:blockedBackendPid,witness,release_witness:releaseWitness,elapsed_ms:Date.now()-lockStarted,pid_absent:verifyPidAbsent(child.pid),log_sha256:sha256(Buffer.concat(chunks))});}catch(e){errors.push(e);}
 if(errors.length){if(pending)await pending.catch(()=>{});throw new AggregateError([...(failed?[primary]:[]),...errors],'owned lock cleanup failure');}
 }
 if(failed){if(pending)await pending.catch(()=>{});throw primary;}return await pending;
}
async function attempt(c){
 await c.beat(c.node);const j=await c.prepare(),claimed=(await c.claim()).job;
 assert.equal(claimed.id,j.id);return {job:j,fence:{connection_id:c.node.connection,attempt:claimed.attempt,output_generation:claimed.output_generation}};
}
async function upload(c,a,bytes,expected=200){
 const headers={Authorization:`Bearer ${c.node.token}`,'Content-Type':'application/octet-stream','x-compute-connection':a.fence.connection_id,'x-compute-attempt':String(a.fence.attempt),'x-compute-generation':a.fence.output_generation,'x-content-sha256':sha256(bytes)};
 const response=await fetch(c.f.origin+`/api/v1/agent-compute/jobs/${a.job.id}/files/segment00000.ts`,{method:'POST',headers,body:bytes,signal:c.signal});
 const value=await response.json();c.entry.http??=[];c.entry.http.push({path:`/agent-compute/jobs/${a.job.id}/files/segment00000.ts`,status:response.status,value,sha256:sha256(bytes),size_bytes:bytes.length});assert.equal(response.status,expected);return value;
}
const disk=(c,a)=>resolve(c.f.root,'published',a.job.id,a.fence.output_generation,'segment00000.ts');
const fileRow=(c,a)=>c.sql(`SELECT count(*) FROM distributed_compute_files WHERE job_id='${a.job.id}' AND output_generation='${a.fence.output_generation}'`);
const independentReceipts=(c,a)=>assert.equal(c.sql(`SELECT process_reaped_at IS NULL AND files_removed_at IS NULL AND server_verification_id IS NULL AND server_verification_reaped_at IS NULL FROM distributed_compute_attempts WHERE job_id='${a.job.id}' AND attempt=${a.fence.attempt}`),'t');
const exactLease=(c,a)=>c.sql(`SELECT to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM distributed_compute_jobs WHERE id='${a.job.id}'`);
function recordExactLease(c,a){
 const value=exactLease(c,a);assert.match(value,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
 c.entry.original_lease={job_id:a.job.id,attempt:a.fence.attempt,output_generation:a.fence.output_generation,lease_until_utc_microseconds:value};
}
function assertExactLease(c,a){assert.equal(c.entry.original_lease.job_id,a.job.id);assert.equal(exactLease(c,a),c.entry.original_lease.lease_until_utc_microseconds);}
async function waitRealExpiry(c,a){
 assertExactLease(c,a);
 const end=Date.now()+10000;
 while(c.sql(`SELECT clock_timestamp()>=lease_until FROM distributed_compute_jobs WHERE id='${a.job.id}'`)!=='t'&&Date.now()<end)await delay(10);
 assert.equal(c.sql(`SELECT clock_timestamp()>=lease_until FROM distributed_compute_jobs WHERE id='${a.job.id}'`),'t');
 c.entry.natural_expiry=JSON.parse(c.sql(`SELECT jsonb_build_object('clock',clock_timestamp(),'lease_until',lease_until,'heartbeat_fresh',(SELECT heartbeat_at>clock_timestamp()-interval '12 seconds' FROM distributed_compute_nodes WHERE agent_id='${c.node.id}')) FROM distributed_compute_jobs WHERE id='${a.job.id}'`));
 assert.equal(c.entry.natural_expiry.heartbeat_fresh,true);assertExactLease(c,a);
}
const cases=[
 ['upload_success_idempotent_immutable',async c=>{
 const a=await attempt(c),bytes=Buffer.from('owned exact artifact bytes');const first=await upload(c,a,bytes);assert.equal(first.sha256,sha256(bytes));assert.equal(fileRow(c,a),'1');assert.deepEqual(await readFile(disk(c,a)),bytes);
 const before=c.sql(`SELECT to_jsonb(x)::text FROM distributed_compute_files x WHERE job_id='${a.job.id}'`);
 await upload(c,a,bytes);assert.equal(c.sql(`SELECT to_jsonb(x)::text FROM distributed_compute_files x WHERE job_id='${a.job.id}'`),before);
 assert.equal((await upload(c,a,Buffer.from('different bytes'),409)).error.code,'COMPUTE_ARTIFACT_IMMUTABLE');assert.deepEqual(await readFile(disk(c,a)),bytes);independentReceipts(c,a);
 await c.save('positive-idempotent-immutable');await c.cancel(a.job);
 }],
 ['upload_sql_after_rename',async c=>{
 const a=await attempt(c),bytes=Buffer.from('owned rollback leaves published bytes');
 c.sql(`CREATE FUNCTION fixture_upload_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id='${a.job.id}' AND NEW.output_generation='${a.fence.output_generation}' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='owned_upload_insert_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_upload_insert_failure BEFORE INSERT ON distributed_compute_files FOR EACH ROW EXECUTE FUNCTION fixture_upload_insert_failure()`);
 try{assert.equal((await upload(c,a,bytes,500)).error.code,'DATABASE_ERROR');assert.equal(fileRow(c,a),'0');assert.deepEqual(await readFile(disk(c,a)),bytes);independentReceipts(c,a);await c.save('insert-error-file-present');}
 finally{c.sql('DROP TRIGGER fixture_upload_insert_failure ON distributed_compute_files; DROP FUNCTION fixture_upload_insert_failure()');}
 // Original retry renames fresh bytes and then inserts metadata; no production repair.
 await upload(c,a,bytes);assert.equal(fileRow(c,a),'1');assert.deepEqual(await readFile(disk(c,a)),bytes);independentReceipts(c,a);await c.save('insert-error-retry');await c.cancel(a.job);
 }],
 ['upload_natural_expiry_after_rename',async c=>{
 const a=await attempt(c),bytes=Buffer.from('owned naturally expired upload');
 c.sql(`CREATE TABLE fixture_upload_gate(job_id uuid PRIMARY KEY);INSERT INTO fixture_upload_gate VALUES('${a.job.id}');CREATE FUNCTION fixture_upload_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_id='${a.job.id}' AND NEW.output_generation='${a.fence.output_generation}' THEN PERFORM job_id FROM fixture_upload_gate WHERE job_id=NEW.job_id FOR UPDATE; END IF;RETURN NEW;END $$;CREATE TRIGGER fixture_upload_wait BEFORE INSERT ON distributed_compute_files FOR EACH ROW EXECUTE FUNCTION fixture_upload_wait()`);
 await c.beat(c.node);c.sql(`UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()+interval '3 seconds' WHERE id='${a.job.id}'`);recordExactLease(c,a);await c.save('upload-before-pending-three-second-deadline');
 try{const value=await locked(c,'fixture_upload_gate','job_id',a.job.id,()=>upload(c,a,bytes,409),{afterWitness:async()=>{assert.deepEqual(await readFile(disk(c,a)),bytes);assert.equal(fileRow(c,a),'0');await c.save('insert-wait-renamed-bytes');await waitRealExpiry(c,a);}});assert.equal(value.error.code,'COMPUTE_LEASE_LOST');assert.equal(fileRow(c,a),'0');assert.deepEqual(await readFile(disk(c,a)),bytes);independentReceipts(c,a);assertExactLease(c,a);await c.save('final-recheck-rollback');}
 finally{c.sql('DROP TRIGGER fixture_upload_wait ON distributed_compute_files;DROP FUNCTION fixture_upload_wait();DROP TABLE fixture_upload_gate');}
 }],
 ['renew_natural_expiry_after_policy_wait',async c=>{
 const a=await attempt(c);await c.beat(c.node);c.sql(`UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()+interval '3 seconds' WHERE id='${a.job.id}'`);recordExactLease(c,a);const before=await c.save('renew-before-pending-three-second-deadline');
 const value=await locked(c,'distributed_compute_policy','agent_id',c.node.id,()=>c.agentRequest(c.node,`/agent-compute/jobs/${a.job.id}/renew`,a.fence,409),{afterWitness:()=>waitRealExpiry(c,a)});
 assert.equal(value.error.code,'COMPUTE_LEASE_LOST');assert.equal(c.sql(`SELECT status FROM distributed_compute_jobs WHERE id='${a.job.id}'`),'running');const after=await c.save('renew-expired-unextended');assert.equal(after.distributed_compute_jobs.find(x=>x.id===a.job.id).lease_until,before.distributed_compute_jobs.find(x=>x.id===a.job.id).lease_until);independentReceipts(c,a);assertExactLease(c,a);
 }],
];
try{await withTerminationSignal(async signal=>{for(const[name,body]of cases)await run(name,body,signal);
 });await binding.verify();await verifyArtifacts();assert.deepEqual(await snapshot(),initial);report.result='passed_selected_attempt_upload_contracts';}
catch(error){report.result='failed';report.failure='inspect owned private logs';process.exitCode=1;}
finally{try{await binding.verify();await verifyArtifacts();assert.deepEqual(await snapshot(),initial);report.inputs_unchanged=true;}catch{report.inputs_unchanged=false;report.result='failed';process.exitCode=1;}await writeFile(summaryPath,JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({summary_path:summaryPath,result:report.result,cases:report.cases.map(x=>({name:x.name,result:x.result}))}));}
