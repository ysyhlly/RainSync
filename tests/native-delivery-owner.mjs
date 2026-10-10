// Fresh owned PostgreSQL + real loopback HTTP reads; no provider network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { unlink, writeFile, readFile, stat } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { ownedProcess } from "../deploy/owned-process.mjs";
import { assertOwnerRun, nativeOwnerCases, nativeOwnerTest, sha256 } from "../scripts/native-owner-binding.mjs";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
import { withPlaybackAdmission,testLoginHash } from "./fixtures/playback-admission.mjs";
const args=process.argv.slice(2);
assert.ok(args.length===0 || (args.length===1 && args[0]==="--baseline-no-ack-observations"));
const baseline=args.length===1;

async function ackObservations(f,cases,report){
  const path=resolve(f.root,"native-ack-observation.private.log");
  const bytes=await readFile(path),text=bytes.toString("utf8");
  if(process.platform!=="win32") assert.equal((await stat(path)).mode & 0o777,0o600);
  const events=text.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const probes=events.filter(e=>e.target==="native_delivery_ack_capture_probe");
  assert.equal(probes.length,1,"global capture observes the awaited spawned probe");
  assert.deepEqual(probes[0],{target:"native_delivery_ack_capture_probe",level:"DEBUG",probe:1});
  const knownSecrets=[f.password,f.env.SOURCE_ENCRYPTION_KEY,...cases.flatMap(c=>[c.token,c.login])];
  for(const secret of knownSecrets) assert.ok(!text.includes(secret),"typed ACK capture excludes fixture credentials");
  const native=events.filter(e=>e.target==="native_delivery_ack");
  assert.equal(events.length,probes.length+native.length,"capture contains only the two exact targets");
  const groups=new Map();
  for(const event of native){
    const {target,level,room_id,execution_id,ack_age_ms,failed_calls,...outcome}=event;
    assert.ok(cases.some(c=>c.room===room_id));
    assert.match(execution_id,/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/);
    assert.ok(Number.isSafeInteger(ack_age_ms)&&ack_age_ms>=0);
    assert.ok(Number.isSafeInteger(failed_calls)&&failed_calls>=1);
    if(level==="WARN"){
      assert.deepEqual(Object.keys(outcome),["failure"]);
      assert.ok(["ack_error","timeout"].includes(outcome.failure));
      const count=BigInt(failed_calls);assert.equal(count&(count-1n),0n,"warnings remain sparse at powers of two");
    } else {assert.equal(level,"INFO");assert.deepEqual(outcome,{outcome:"recovered"});}
    const list=groups.get(execution_id)??[];list.push(event);groups.set(execution_id,list);
  }
  for(const list of groups.values()){
    const warnings=list.filter(e=>e.level==="WARN"),recovered=list.filter(e=>e.level==="INFO");
    assert.ok(warnings.length>=1);assert.equal(warnings[0].failed_calls,1);
    assert.equal(recovered.length,1);assert.equal(list.at(-1),recovered[0]);
    for(let i=1;i<list.length;i++){
      assert.ok(list[i].ack_age_ms>=list[i-1].ack_age_ms);
      assert.ok(list[i].failed_calls>=list[i-1].failed_calls);
      if(list[i].level==="WARN")assert.ok(list[i].failed_calls>list[i-1].failed_calls);
      assert.equal(list[i].room_id,list[0].room_id);
    }
  }
  const faults=[];
  if(baseline) assert.equal(native.length,0,"original complete finish has no ACK observation fields");
  for(const name of ["receipt_failure","receipt_suppressed"]){
    const c=cases.find(c=>c.name===name);
    const rows=JSON.parse(f.sql(`SELECT COALESCE(json_agg(json_build_object('id',e.id,'room',p.room_id,'reaped',e.reaped_at IS NOT NULL)),'[]'::json) FROM media_executions e JOIN playback_sessions p ON p.id=e.session_id WHERE e.session_id='${c.session}'`));
    assert.equal(rows.length,1);assert.equal(rows[0].room,c.room);assert.equal(rows[0].reaped,true);
    if(baseline){faults.push({name,receipts:1,reaped:true,native_events:0});continue;}
    const actual=groups.get(rows[0].id);assert.ok(actual,"actual execution fault/recovery has typed ACK events");
    assert.ok(actual.filter(e=>e.level==="WARN").every(e=>e.failure==="ack_error"));
    faults.push({name,warnings:actual.filter(e=>e.level==="WARN").length,last_failed_calls:actual.at(-1).failed_calls,first_ack_age_ms:actual[0].ack_age_ms,recovered_ack_age_ms:actual.at(-1).ack_age_ms,failure_class:"ack_error",reaped:true});
  }
  report.ack_observation={mode:baseline?"original_no_native_fields":"acceptance",capture_sha256:sha256(bytes),capture_bytes:bytes.length,probe_events:1,native_events:native.length,faults,outer_timeout_observed:native.some(e=>e.failure==="timeout"),raw_private_not_ci_uploaded:true};
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
await nativeOwnerGate("native-delivery-owner",async (f, {binding, report, check, signal})=>{
  const client=f.client(),user=await client.login(),nonce=randomUUID();
  const records=[];
  const upstream=createServer((request,response)=>{
    const name=request.url.split("/").at(-1);
    const record={name,method:request.method,range:request.headers.range,credential_received:request.headers.cookie!==undefined,closed:false,writes:0};records.push(record);
    let timer;
    response.once("close",()=>{record.closed=true;clearInterval(timer);});
    if(name.startsWith("send_"))return;
    response.writeHead(200,{"Content-Type":"video/mp4","Content-Length":"1000000"});response.flushHeaders();
    if(name==="body_close") {
      // Distinct source chunks fill the one-slot Rust body channel. Keep the
      // source open; closing the room must cancel an actually blocked send.
      timer=setInterval(()=>{
        if(record.writes<16 && !response.destroyed) {
          response.write(Buffer.alloc(16*1024));record.writes++;
        } else clearInterval(timer);
      },20);
    } else response.write(Buffer.alloc(16));
  });
  await new Promise(done=>upstream.listen(0,"127.0.0.1",done));
  const upstreamPort=upstream.address().port;
  let requestFile;
  try {
    f.sql(`CREATE TABLE native_delivery_fixture_identity(id uuid PRIMARY KEY,nonce text NOT NULL);INSERT INTO native_delivery_fixture_identity VALUES('${f.id}','${nonce}');`);
    const cases=[];
    for(const name of nativeOwnerCases){
      const room=await client.request("/rooms","POST",{name:`owned native delivery ${name}`});
      const session=randomUUID(),media=randomUUID(),viewer=randomUUID(),token=randomUUID().replaceAll("-","")+randomUUID().replaceAll("-","");
      const login=testLoginHash(f,client);
      f.sql(`INSERT INTO media_items(id,title,resource) VALUES('${media}','平台影片','platform:${media}');
        INSERT INTO room_platform_media(media_id,room_id,provider,content_id,part,cid,title,created_by) VALUES('${media}','${room.id}','bilibili','BV1GJ411x7h7',1,12345,'owned HTTP lifetime fixture','${user.id}');
        UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${room.id}';`);
      const context={version:1,provider:"bilibili",media_id:media,room_id:room.id,user_id:user.id,entry_revision:"1",credential_mode:"anonymous",account_id:null,account_revision:null};
      withPlaybackAdmission(f,{client,user:user.id,room:room.id,session},`
        UPDATE playback_requests SET viewer_id='${viewer}',plan_generation=1 WHERE session_id='${session}';
        INSERT INTO playback_viewer_plans(user_id,room_id,viewer_id,plan_generation,auth_login_hash) VALUES('${user.id}','${room.id}','${viewer}',1,'${login}');
        INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,viewer_id,plan_generation,delivery_token_hash,resource,expires_at)
        VALUES('${session}','${user.id}','${room.id}','${media}',1,'${viewer}',1,encode(sha256(convert_to('${token}','UTF8')),'hex'),${quote(JSON.stringify({encrypted:"owned-native-fixture",native_platform_context:context}))},clock_timestamp()+interval '5 minutes');
      `);
      cases.push({name,room:room.id,session,user:user.id,login,token,url:`http://127.0.0.1:${upstream.address().port}/source/${name}`});
    }
    // Each isolatedServer exposes root through its configured owned MEDIA_ROOT.
    requestFile=resolve(f.env.MEDIA_ROOT,"native-delivery-request.json");
    await writeFile(requestFile,JSON.stringify({id:f.id,nonce,origin:f.origin,cookie:client.cookie,csrf:client.csrf,cases}),{encoding:"utf8",mode:0o600,flag:"wx"});
    let result,driverFailure;
    const driverLog=resolve(f.root,"native-delivery-driver.private.log");
    const outputFd=openSync(driverLog,"wx",0o600);
    try {
      result=await ownedProcess(binding.owner.path,[nativeOwnerTest,"--exact","--ignored","--nocapture"],{
        timeoutMs:120000,signal,outputFd,
        env:{...f.env,RAINSYNC_ISOLATED_TEST:"1",RAINSYNC_NATIVE_DELIVERY_TEST_DATABASE:f.env.DATABASE_URL,RAINSYNC_NATIVE_DELIVERY_REQUEST:requestFile},
      });
      const {output,...receipt}=result;
      report.driver={...receipt,pid_absent:verifyPidAbsent(result.pid)};
      assert.equal(output,"","driver stdout/stderr are retained through the borrowed descriptor");
      assert.equal(result.exit_code,0,"native HTTP owner fixture failed");
      assert.equal(result.signal,null);
      assert.equal(report.driver.pid_absent,true);
    } catch(error) {
      if(error.cleanup) report.driver={...error.cleanup,pid_absent:verifyPidAbsent(error.cleanup.pid)};
      driverFailure=error;
    } finally {
      try {
        closeSync(outputFd);
        const bytes=await readFile(driverLog);
        report.driver_log={bytes:bytes.length,sha256:sha256(bytes),parent_descriptor_closed:true,driver_close_observed:report.driver?.observed_close===true,raw_private_not_ci_uploaded:true};
        process.stdout.write(bytes);
        if(!driverFailure) assertOwnerRun(bytes.toString("utf8"));
      } catch(logError){
        driverFailure=driverFailure?new AggregateError([driverFailure,logError],"native driver and complete-log capture failed"):logError;
      }
    }
    if(driverFailure)throw driverFailure;
    await ackObservations(f,cases,report);
    assert.ok(!(await readFile(resolve(f.root,"native-ack-observation.private.log"),"utf8")).includes(nonce),"spawned probe secret stays outside typed capture");
    assert.equal(records.filter(record=>record.name.startsWith("reject_")).length,0);
    assert.ok(records.every(record=>!record.credential_received),"loopback native source sees no RainSync login credential");
    const closeDeadline=Date.now()+2000;
    while(!records.every(record=>record.closed)&&Date.now()<closeDeadline)
      await new Promise(done=>setTimeout(done,20));
    assert.ok(records.every(record=>record.closed),"all owned raw source sockets closed after disposal");
    assert.ok(records.find(record=>record.name==="body_close").writes>=4,"backpressure uses multiple actual source chunks");
    assert.equal(records.find(record=>record.name==="send_head").method,"HEAD");
    assert.equal(records.find(record=>record.name==="send_range_drop").range,"bytes=0-31");
    for(const name of nativeOwnerCases) check(name);
    console.log("PASS: real source sockets, deferred HEAD/Range requests, receipt failure/recovery, caller cancellation and denied admission all preserve authoritative room closure");
  } finally {
    upstream.closeAllConnections();await new Promise(done=>upstream.close(done));
    report.upstream={port:upstreamPort,port_closed:await verifyClosedPort(upstreamPort),requests:records};
    assert.equal(report.upstream.port_closed,true);
    if(requestFile) await unlink(requestFile);
  }
},{requireTest:true});
