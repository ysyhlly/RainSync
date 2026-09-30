import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedServer,delay} from './fixtures/server.mjs';
let fixture;
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
  const blocker=f.sqlProcess(`BEGIN; LOCK TABLE rooms IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(8) /* ${marker} */; COMMIT;`);
  await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND wait_event='PgSleep'`,'1');
  const pending=Array.from({length:12},(_,i)=>admin.request('/rooms','POST',{name:`readiness-owned-${i}`}));
  const settled=Promise.allSettled(pending);
  await f.waitForSql("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO rooms%'",'11');
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
}catch(e){report.result='failed';report.failure=String(e.stack??e);process.exitCode=1}
finally{if(fixture){report.cleanup=await fixture.verifyStopped();report.postgres=fixture.postgresDiagnostics();await writeFile(resolve(fixture.root,'report.json'),JSON.stringify(report,null,2));console.log(`${report.result}: ${resolve(fixture.root,'report.json')}`)}}
