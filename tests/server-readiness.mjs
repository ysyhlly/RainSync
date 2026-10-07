import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedServer,delay} from './fixtures/server.mjs';
let fixture;
const queryEvidence={last:null,peak:null};
const report={schema_version:1,result:'running',checks:[]};
try{
 await isolatedServer('server-readiness',async f=>{
  fixture=f;
  const ready=async()=>{const r=await fetch(f.origin+'/ready',{signal:AbortSignal.timeout(1000)});assert.equal(r.headers.get('cache-control'),'no-store');return {status:r.status,...await r.json()}};
  const until=async(check,label)=>{const end=Date.now()+12000;while(Date.now()<end){if(await check())return;await delay(50)}throw Error(label)};
  await until(async()=> (await ready()).status===200,'fresh server ready');
  assert.deepEqual((await ready()).checks,{accepting_work:'ready',database:'ready',instance_ownership:'ready'});
  report.checks.push('HTTP /ready reports only current low-cardinality checks with no-store');
  const admin=f.client();await admin.login();
  const marker='readiness_pool_block';
  const blocker=f.sqlProcess(`BEGIN; LOCK TABLE room_snapshots IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8) /* ${marker} */; COMMIT;`);
  await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND wait_event='PgSleep'`,'1');
  const pending=Array.from({length:12},(_,i)=>admin.request('/rooms','POST',{name:`readiness-owned-${i}`}));
  const settled=Promise.allSettled(pending);
  // Guest-aware login authority reads rooms, so locking that table can stop
  // requests before creation. Block the later snapshot INSERT instead; all
  // owned requests must still occupy the shared pool before probing /ready.
  const admittedBy=Date.now()+10000;
  let saturated=false;
  while(Date.now()<admittedBy){
   const counts=JSON.parse(f.sql("SELECT json_build_object('snapshot_insert',count(*) FILTER(WHERE query LIKE 'INSERT INTO room_snapshots%'),'room_insert',count(*) FILTER(WHERE query LIKE 'INSERT INTO rooms%'),'login_admission',count(*) FILTER(WHERE query LIKE 'SELECT u.id,u.admin,s.csrf,u.principal_kind FROM sessions%'),'other',count(*) FILTER(WHERE query NOT LIKE 'INSERT INTO room_snapshots%' AND query NOT LIKE 'INSERT INTO rooms%' AND query NOT LIKE 'SELECT u.id,u.admin,s.csrf,u.principal_kind FROM sessions%')) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"));
   queryEvidence.last=counts;
   const total=value=>Object.values(value??{}).reduce((sum,count)=>sum+count,0);
   if(total(counts)>total(queryEvidence.peak))queryEvidence.peak=counts;
   // Creation admission serializes peers behind the first snapshot waiter.
   // Count all 11 occupied post-auth creation connections, not one SQL phase.
   if(counts.snapshot_insert>0&&counts.snapshot_insert+counts.room_insert===11){saturated=true;break}
   await delay(30);
  }
  assert.equal(saturated,true,'11 owned post-auth room creations must occupy the shared pool');
  let failed;
  await until(async()=>{failed=await ready();return failed.status===503},'pool exhaustion must fail readiness');
  assert.equal(failed.ready,false);assert.equal(failed.checks.database,'failed');assert.equal(failed.checks.instance_ownership,'ready');
  assert.equal((await fetch(f.origin+'/health')).status,200);
  report.checks.push('bounded real exhausted-pool probe returns 503 while actual owner remains healthy and liveness responds');
  await blocker.done;const results=await settled;assert.ok(results.every(x=>x.status==='fulfilled'));
  await until(async()=> (await ready()).status===200,'released pool recovers readiness');
  report.checks.push('all pending owned requests complete and readiness recovers after pool release');
  report.result='passed';
 });
}catch(e){report.result='failed';report.failure=String(e.stack??e);report.observed_query_counts=queryEvidence;console.error('FAIL server-readiness: '+JSON.stringify({failure:String(e.message??e).slice(0,1000),observed_query_counts:queryEvidence}));process.exitCode=1}
finally{if(fixture){report.cleanup=await fixture.verifyStopped();report.postgres=fixture.postgresDiagnostics();await writeFile(resolve(fixture.root,'report.json'),JSON.stringify(report,null,2));console.log(`${report.result}: ${resolve(fixture.root,'report.json')}`);console.log('server-readiness summary: '+JSON.stringify({result:report.result,checks_passed:report.checks.length,cleanup_completed:report.cleanup.completed}))}}
