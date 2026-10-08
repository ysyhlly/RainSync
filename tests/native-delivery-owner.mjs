// Fresh owned PostgreSQL + real loopback HTTP reads; no provider network.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ownedProcess } from "../deploy/owned-process.mjs";
import { assertOwnerRun, nativeOwnerCases, nativeOwnerTest } from "../scripts/native-owner-binding.mjs";
import { nativeOwnerGate } from "./fixtures/native-owner-gate.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
import { withPlaybackAdmission,testLoginHash } from "./fixtures/playback-admission.mjs";
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
    let result;
    try {
      result=await ownedProcess(binding.owner.path,[nativeOwnerTest,"--exact","--ignored","--nocapture"],{
        timeoutMs:120000,signal,
        env:{...f.env,RAINSYNC_ISOLATED_TEST:"1",RAINSYNC_NATIVE_DELIVERY_TEST_DATABASE:f.env.DATABASE_URL,RAINSYNC_NATIVE_DELIVERY_REQUEST:requestFile},
      });
      const {output,...receipt}=result;
      report.driver={...receipt,pid_absent:verifyPidAbsent(result.pid)};
      process.stdout.write(output);
      assert.equal(result.exit_code,0,"native HTTP owner fixture failed");
      assert.equal(result.signal,null);
      assertOwnerRun(output);
      assert.equal(report.driver.pid_absent,true);
    } catch(error) {
      if(error.cleanup) report.driver={...error.cleanup,pid_absent:verifyPidAbsent(error.cleanup.pid)};
      throw error;
    }
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
