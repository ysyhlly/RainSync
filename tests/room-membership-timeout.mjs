import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedServer,delay} from './fixtures/server.mjs';
let fixture; const report={schema_version:1,result:'running',checks:[]};
try{await isolatedServer('room-membership-timeout',async f=>{
 fixture=f; const admin=f.client();await admin.login();const room=await admin.request('/rooms','POST',{name:'owned membership timeouts'});const sockets=[];
 const until=async(check,label,timeout=6000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(30)}throw Error(label)};
 try{
  for(let n=0;n<24;n++){
   const ws=new WebSocket(f.origin.replace('http','ws')+'/api/v1/ws',{headers:{Origin:f.origin,Cookie:admin.cookie}});const frames=[];ws.on('message',b=>frames.push(JSON.parse(b)));ws.on('error',()=>{});sockets.push({ws,frames});
   await new Promise((done,reject)=>{ws.once('open',done);ws.once('error',reject)});ws.send(JSON.stringify({type:'JOIN',room_id:room.id}));await until(()=>frames.some(v=>v.type==='SNAPSHOT'),'initial snapshot');
  }
  const marker='owned_membership_table_timeout';
  const blocker=f.sqlProcess(`BEGIN; LOCK TABLE room_members IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(9) /* ${marker} */; COMMIT;`);
  await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${marker}%'`,'1');
  const began=Date.now();for(const {ws}of sockets)ws.send(JSON.stringify({type:'CLOCK_SYNC',t1:began}));
  await until(()=>sockets.every(s=>s.frames.some(v=>v.type==='ERROR'&&v.error.code==='SERVICE_UNAVAILABLE')),'all saturated checks fail closed');
  assert.ok(Date.now()-began<5000);
  assert.equal(f.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${marker}%'`),'1','table remains locked');
  // This authenticated request needs the same shared pool but no room table.
  await admin.request('/auth/me');
  await until(async()=>{const r=await fetch(f.origin+'/ready',{signal:AbortSignal.timeout(1000)});return r.status===200},'shared pool recovers while membership lock is still held',4000);
  assert.equal(f.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%${marker}%'`),'1','recovery precedes table unlock');
  report.checks.push('24 sockets fail closed under actual ACCESS EXCLUSIVE membership lock in under 5 seconds');
  report.checks.push('authenticated same-pool request and readiness recover before lock release');
  await blocker.done;report.result='passed';
 }finally{for(const {ws}of sockets)ws.terminate()}
})}catch(e){report.result='failed';report.failure=String(e.stack??e);process.exitCode=1}
finally{if(fixture){report.cleanup=await fixture.verifyStopped();report.postgres=fixture.postgresDiagnostics();await writeFile(resolve(fixture.root,'report.json'),JSON.stringify(report,null,2));console.log(`${report.result}: ${resolve(fixture.root,'report.json')}`)}}
