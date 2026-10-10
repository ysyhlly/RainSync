// Proposed original placement baseline. Full migrations, synthetic HTTP and owned PG.
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
assert.ok(process.argv.slice(2).every(x=>x==='--observe-stale-heartbeat-wait'));
const binding=await loadOwnerBinding({root:repo,target:process.env.CARGO_TARGET_DIR,path:process.env.W03_BACKEND_BINDING,requireTest:true});
const rawBinding=JSON.parse(await readFile(process.env.W03_BACKEND_BINDING));
const allArtifacts=[...rawBinding.binaries,...rawBinding.test_helpers,...rawBinding.owner_fixtures];
const verifyArtifacts=async()=>{for(const a of allArtifacts)assert.equal(sha256(await readFile(a.path)),a.sha256,'Full producer artifact drift');};
await verifyArtifacts();
const summaryPath=resolve(process.env.RAINSYNC_ARTIFACT_DIR,`compute-placement-coordinator-${randomUUID()}.json`);
const sources=['tests/distributed-compute-placement-native.mjs','tests/fixtures/server.mjs','tests/fixtures/postgres.mjs','tests/fixtures/unused-port.mjs','scripts/native-owner-binding.mjs','deploy/owned-process.mjs'];
const snapshot=()=>Promise.all(sources.map(async path=>({path,sha256:sha256(await readFile(resolve(repo,path)))})));
const initial=await snapshot();
const tables=['agents','distributed_compute_policy','distributed_compute_nodes','distributed_compute_sources','distributed_compute_jobs','distributed_compute_attempts','distributed_compute_files','sources','media_items','rooms','room_snapshots','room_members','sessions','private_libraries','library_grants','playback_sessions','playback_requests'];
const report={result:'running',scope:'original HTTP placement only; no encoder/browser/artifact qualification or global deadlock proof',cases:[],binding:binding.summary,coordinator:initial,all_artifacts:allArtifacts.map(({name,test_name,path,sha256})=>({name,test_name,path,sha256})),summary_path:summaryPath};
const recipe='remux_hls_v1',hd='h264_2160p_hls_v1',version=`stat-v1:${'a'.repeat(64)}`,digest='b'.repeat(64);
// Private snapshots intentionally retain complete rows, including synthetic credentials.
async function run(name,body,signal){
 const parentSignal=signal;const local=new AbortController();const timer=setTimeout(()=>local.abort(Error('placement_case_deadline')),180000);signal=AbortSignal.any([parentSignal,local.signal]);
 let fixture,failed=false,primary,evidenceErrors=[],logStates=[],entry={name,result:'running'};report.cases.push(entry);
 try{await isolatedServer('compute-placement-'+name,async f=>{
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
 await body({f,origin,node,media,replica,room,observe,save,policy,beat,prepare,claim,cancel,duration,sql,signal,entry});
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
 let pending,failed=false,primary,witness;const lockStarted=Date.now();
 try{child.stdin.write(`SET application_name='${tag}'; BEGIN; SELECT ${idColumn} FROM ${table} WHERE ${idColumn}='${id}' FOR UPDATE; SELECT 'OWNED_LOCK_READY';\n`);
 const until=async(test)=>{const end=Date.now()+5000;while(!test()&&Date.now()<end)await delay(10);assert.ok(test(),'owned lock witness');};
 await until(()=>Buffer.concat(chunks).toString().includes('OWNED_LOCK_READY'));
 pending=action();pending.catch(()=>{});
 await until(()=>Number(c.sql(`SELECT count(*) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND '${tag}'=(SELECT b.application_name FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid)) LIMIT 1)`))===1);
 witness=JSON.parse(c.sql(`SELECT jsonb_agg(jsonb_build_object('pid',a.pid,'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,'blocker_pids',pg_blocking_pids(a.pid),'query',a.query,'clock',clock_timestamp())) FROM pg_stat_activity a WHERE a.wait_event_type='Lock' AND '${tag}'=(SELECT b.application_name FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(a.pid)) LIMIT 1)`));assert.equal(witness.length,1);assert.ok(witness[0].blocker_pids.includes(Number(c.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${tag}'`))));
 if(afterWitness)await afterWitness();
 if(holdMs)await delay(holdMs);
 }catch(e){failed=true;primary=e;}
 finally{
 const errors=[];child.stdin.end('ROLLBACK;\n\\q\n');let closeTimer;
 try{await Promise.race([Promise.all([child.done,closed]),new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(Error('owned lock close deadline')),10000);})]);}catch(error){errors.push(error);child.kill('SIGTERM');let killTimer;try{await Promise.race([closed,new Promise((_,reject)=>{killTimer=setTimeout(()=>reject(Error('owned lock signal close unconfirmed')),5000);})]);}catch(e){errors.push(e);}finally{clearTimeout(killTimer);}}finally{clearTimeout(closeTimer);}
 try{assert.ok(close&&verifyPidAbsent(child.pid));assert.equal(close.code,0);}catch(e){errors.push(e);}
 try{await writeFile(resolve(c.f.root,tag+'.private.log'),Buffer.concat(chunks),{flag:'wx',mode:0o600});c.entry.locks??=[];c.entry.locks.push({...close,witness,elapsed_ms:Date.now()-lockStarted,pid_absent:verifyPidAbsent(child.pid),log_sha256:sha256(Buffer.concat(chunks))});}catch(e){errors.push(e);}
 if(errors.length){if(pending)await pending.catch(()=>{});throw new AggregateError([...(failed?[primary]:[]),...errors],'owned lock cleanup failure');}
 }
 if(failed){if(pending)await pending.catch(()=>{});throw primary;}return await pending;
}
const cases=[
 ['empty',async c=>{assert.deepEqual(await c.claim(),{job:null});}],
 ['wrong_connection',async c=>{assert.equal((await c.claim(c.node,randomUUID(),403)).error.code,'COMPUTE_NODE_UNHEALTHY');}],
 ['capability_filter',async c=>{await c.prepare();await c.beat(c.node,[hd]);assert.deepEqual(await c.claim(),{job:null});}],
 ['node_full',async c=>{const j=await c.prepare();assert.equal((await c.claim()).job.id,j.id);assert.equal((await c.claim()).reason,'node_full');}],
 ['original_source_preference',async c=>{const duplicate=randomUUID();c.sql(`INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${duplicate}','${c.origin.id}','same node replica','same-node-replica.mp4','${version}'); INSERT INTO distributed_compute_sources(agent_id,media_id,source_version,content_sha256,size_bytes) VALUES('${c.origin.id}','${duplicate}','${version}','${digest}',1024)`);const j=await c.prepare();const x=(await c.claim(c.origin)).job;assert.equal(x.id,j.id);assert.equal(x.resource,'origin.mp4');assert.equal(x.attempt,1);assert.equal(x.lease_ms,20000);assert.equal(c.sql(`SELECT owner_agent::text||':'||input_media_id::text FROM distributed_compute_jobs WHERE id='${j.id}'`),`${c.origin.id}:${c.media}`);}],
 ['exact_replica',async c=>{const j=await c.prepare();const x=(await c.claim()).job;assert.equal(x.id,j.id);assert.equal(x.resource,'replica.mp4');assert.equal(x.content_sha256,digest);assert.equal(x.source_bytes,1024);assert.equal(c.sql(`SELECT count(*) FROM distributed_compute_attempts WHERE job_id='${j.id}' AND attempt=1`),'1');}],
 ['hash_size_filter',async c=>{const j=await c.prepare();c.sql(`UPDATE distributed_compute_sources SET content_sha256='${'c'.repeat(64)}' WHERE agent_id='${c.node.id}'`);assert.deepEqual(await c.claim(),{job:null});c.sql(`UPDATE distributed_compute_sources SET content_sha256='${digest}',size_bytes=2048 WHERE agent_id='${c.node.id}'`);assert.deepEqual(await c.claim(),{job:null});assert.equal(c.sql(`SELECT status||':'||attempt FROM distributed_compute_jobs WHERE id='${j.id}'`),'queued:0');}],
 ['attempt_ceiling',async c=>{const j=await c.prepare();c.sql(`UPDATE distributed_compute_jobs SET attempt=3 WHERE id='${j.id}'`);assert.deepEqual(await c.claim(),{job:null});}],
 ['expired_lease_reclaim',async c=>{const j=await c.prepare();const first=(await c.claim()).job;c.sql(`UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id='${j.id}'`);const next=(await c.claim()).job;assert.equal(next.id,j.id);assert.equal(next.attempt,2);assert.notEqual(next.output_generation,first.output_generation);assert.equal(c.sql(`SELECT count(*) FROM distributed_compute_attempts WHERE job_id='${j.id}'`),'2');}],
 ['budget_rejection',async c=>{const j=await c.prepare(hd);await c.policy(c.node,1048576);const x=await c.claim();assert.equal(x.job,null);assert.equal(x.reason,'compute_output_budget_insufficient');assert.equal(c.sql(`SELECT status||':'||attempt||':'||error FROM distributed_compute_jobs WHERE id='${j.id}'`),'queued:0:compute_output_budget_insufficient');}],
 ['late_metadata_rejection',async c=>{const j=await c.prepare(hd);c.duration(1801);assert.equal((await c.claim()).reason,'compute_source_duration_unsupported');assert.equal(c.sql(`SELECT error FROM distributed_compute_jobs WHERE id='${j.id}'`),'compute_source_duration_unsupported');}],
 ['candidate_changed_after_room_wait',async c=>{const j=await c.prepare();const x=await locked(c,'rooms','id',c.room.id,()=>c.claim(),{afterWitness:()=>c.sql(`UPDATE distributed_compute_jobs SET status='cancelled' WHERE id='${j.id}'`)});assert.equal(x.reason,'candidate_changed');assert.equal(c.sql(`SELECT count(*) FROM distributed_compute_attempts WHERE job_id='${j.id}'`),'0');}],
];
try{await withTerminationSignal(async signal=>{for(const[name,body]of cases)await run(name,body,signal);
 if(process.argv.includes('--observe-stale-heartbeat-wait'))await run('known_stale_heartbeat_wait',async c=>{await c.prepare();await c.beat(c.node);const start=await c.save('heartbeat-before');const response=await locked(c,'distributed_compute_policy','agent_id',c.node.id,()=>c.claim(c.node,c.node.connection,[200,403],false),{holdMs:13000});const after=await c.save('heartbeat-after');c.entry.known_limitation={scope:'raw original behavior; no fail-closed promise',response,heartbeat_before:start.distributed_compute_nodes.find(x=>x.agent_id===c.node.id)?.heartbeat_at,after_clock:after.clock,claimed:Boolean(response.job),node_current_healthy:c.sql(`SELECT heartbeat_at>clock_timestamp()-interval '12 seconds' FROM distributed_compute_nodes WHERE agent_id='${c.node.id}'`)};report.placement_complete=false;},signal);
 });await binding.verify();await verifyArtifacts();assert.deepEqual(await snapshot(),initial);report.result='passed_selected_original_contracts';}
catch(error){report.result='failed';report.failure='inspect owned private logs';process.exitCode=1;}
finally{try{await binding.verify();await verifyArtifacts();assert.deepEqual(await snapshot(),initial);report.inputs_unchanged=true;}catch{report.inputs_unchanged=false;report.result='failed';process.exitCode=1;}await writeFile(summaryPath,JSON.stringify(report)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({summary_path:summaryPath,result:report.result,cases:report.cases.map(x=>({name:x.name,result:x.result}))}));}
