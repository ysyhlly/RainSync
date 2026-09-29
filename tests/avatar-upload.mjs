import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";
import { png } from "./fixtures/png.mjs";

await isolatedServer("avatars", async (f) => {
  const admin=f.client(); const identity=await admin.login();
  const headers=(version=null, operation=randomUUID()) => ({ "Content-Type":"image/png", "If-Match":`"${version ?? "none"}"`, "x-avatar-operation-id":operation });
  const readProfile=()=>admin.request("/users/me/profile");
  const upload=async (bytes, h, expected=200) => {
    const response=await admin.raw("/users/me/avatar",{method:"PUT",body:bytes,headers:h});
    const result=await response.json();
    assert.equal(response.status,expected,`avatar upload: ${result.error?.code ?? "success"}`);
    return result;
  };
  const normal=png(512,512,{marker:"private-gps-fixture"});
  const firstHeaders=headers();
  const first=await upload(normal,firstHeaders);
  assert.match(first.avatar_version,/^[0-9a-f-]{36}$/);
  assert.equal(first.avatar_url,`/api/v1/users/${identity.id}/avatar?v=${first.avatar_version}`);
  const file=await admin.raw(first.avatar_url.replace("/api/v1",""));
  assert.equal(file.status,200); assert.equal(file.headers.get("content-type"),"image/webp");
  assert.equal(file.headers.get("cache-control"),"private, no-cache"); assert.equal(file.headers.get("x-content-type-options"),"nosniff");
  const etag=file.headers.get("etag"); const bytes=Buffer.from(await file.arrayBuffer());
  assert.ok(bytes.length<=256*1024); assert.equal(bytes.subarray(8,12).toString(),"WEBP");
  assert.equal(bytes.includes(Buffer.from("private-gps-fixture")),false);
  const stored=resolve(f.root,"stored.webp"); await writeFile(stored,bytes);
  const probe=JSON.parse(execFileSync("ffprobe",["-v","error","-show_streams","-of","json",stored],{encoding:"utf8",timeout:10000,windowsHide:true}));
  assert.equal(probe.streams[0].width,512); assert.equal(probe.streams[0].height,512);
  const decoded=execFileSync("ffmpeg",["-v","error","-i",stored,"-frames:v","1","-f","rawvideo","-pix_fmt","rgba","pipe:1"],{timeout:10000,maxBuffer:2*1024*1024,windowsHide:true});
  assert.equal(decoded.length,512*512*4); assert.equal(decoded[3],96);
  const cached=await admin.raw(first.avatar_url.replace("/api/v1",""),{headers:{"If-None-Match":etag}}); assert.equal(cached.status,304);
  const anonymous=await f.client().raw(first.avatar_url.replace("/api/v1",""),{headers:{"If-None-Match":etag}}); assert.equal(anonymous.status,401); await anonymous.arrayBuffer();
  const unauthorized=await f.client().raw("/users/me/avatar",{method:"PUT",body:normal,headers:headers()});assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();
  const room=await admin.request("/rooms","POST",{name:"avatar-chat"});
  const ws=new WebSocket(f.origin.replace("http","ws")+"/api/v1/ws",{headers:{Origin:f.origin,Cookie:admin.cookie}});
  const next=(type)=>new Promise((done,reject)=>{
    const timer=setTimeout(()=>{ws.off("message",read);reject(new Error(`Missing ${type}`))},5000);
    const read=(bytes)=>{const value=JSON.parse(bytes);if(value.type===type){clearTimeout(timer);ws.off("message",read);done(value)}};
    ws.on("message",read);
  });
  try{
    await new Promise((done,reject)=>{ws.once("open",done);ws.once("error",reject)});
    const snapshot=next("SNAPSHOT");ws.send(JSON.stringify({type:"JOIN",room_id:room.id}));await snapshot;
    const message=next("CHAT");ws.send(JSON.stringify({type:"CHAT",body:"avatar identity",client_message_id:randomUUID()}));
    const chat=await message;assert.equal(chat.user_id,identity.id);assert.equal(chat.avatar_url,first.avatar_url);assert.equal(chat.avatar_version,first.avatar_version);
    const history=await admin.request(`/rooms/${room.id}/messages`);assert.equal(history[0].avatar_version,first.avatar_version);
  }finally{ws.terminate()}
  assert.equal((await upload(normal,firstHeaders)).avatar_version,first.avatar_version);
  await upload(png(512,512,{alpha:255}),firstHeaders,409);
  for (const invalid of [Buffer.from("GIF89a"),Buffer.from("<svg/>"),png(256,512),png(512,512,{animated:true}),normal.subarray(0,normal.length-20)]) {
    await upload(invalid,headers(first.avatar_version),400);
    assert.equal((await readProfile()).avatar_version,first.avatar_version);
  }
  const corrupt=Buffer.from(normal); corrupt[corrupt.length-20]^=127;
  await upload(corrupt,headers(first.avatar_version),400);
  await upload(Buffer.alloc(2*1024*1024+1),headers(first.avatar_version),413);
  await admin.request("/users/me/profile","PATCH",{display_name:"x".repeat(66000)},413);
  await upload(normal,{...headers(first.avatar_version),"Content-Type":"image/jpeg"},415);
  await upload(normal,{...headers(first.avatar_version),"x-csrf-token":"wrong"},403);
  await upload(normal,{...headers(first.avatar_version),Origin:"https://wrong.invalid"},403);
  const noVersion=await admin.raw("/users/me/avatar",{method:"PUT",body:normal,headers:{"Content-Type":"image/png"}}); assert.equal(noVersion.status,400); await noVersion.arrayBuffer();
  await admin.request("/users/me/profile","PATCH",{display_name:"avatar-independent"});
  const noise=png(512,512,{noisy:true,alpha:255}); assert.ok(noise.length>65536);
  const current=await upload(noise,headers(first.avatar_version));
  assert.equal((await readProfile()).display_name,"avatar-independent");
  const old=await admin.raw(first.avatar_url.replace("/api/v1","")); assert.equal(old.status,404); await old.arrayBuffer();
  const raced=await Promise.all([headers(current.avatar_version),headers(current.avatar_version)].map((h)=>admin.raw("/users/me/avatar",{method:"PUT",body:normal,headers:h})));
  assert.deepEqual(raced.map(r=>r.status).sort(),[200,409]); await Promise.all(raced.map(r=>r.arrayBuffer()));
  const afterRace=await readProfile();
  await f.startServer(); assert.equal((await readProfile()).avatar_version,afterRace.avatar_version);
  const persisted=await admin.raw(afterRace.avatar_url.replace("/api/v1","")); assert.equal(persisted.status,200); await persisted.arrayBuffer();
  const removeHeaders=headers(afterRace.avatar_version);
  const removed=await admin.request("/users/me/avatar","DELETE",undefined,200,removeHeaders);
  assert.equal(removed.avatar_url,null); assert.notEqual(removed.avatar_version,null);
  assert.equal((await admin.request("/users/me/avatar","DELETE",undefined,200,removeHeaders)).avatar_version,removed.avatar_version);
  assert.equal((await readProfile()).display_name,"avatar-independent");
  await upload(normal,headers(afterRace.avatar_version),409);
  assert.equal(f.sql(`SELECT content IS NULL FROM user_avatars WHERE user_id='${identity.id}'`),"t");
  // Old successful operations cannot change the latest tombstone on replay.
  assert.equal((await upload(normal,firstHeaders)).avatar_version,removed.avatar_version);
  assert.equal((await readProfile()).avatar_url,null);
  await admin.request("/users","POST",{username:"fresh-avatar",password:"12345678"});
  const fresh=f.client(); await fresh.login("fresh-avatar","12345678");
  assert.equal((await fresh.request("/users/me/profile")).avatar_version,null);
  const fake=resolve(f.target,"examples",`avatar_encoder_fixture${process.platform==="win32"?".exe":""}`);
  await f.startServer({AVATAR_FFMPEG_BIN:fake,RAINSYNC_ISOLATED_TEST:"1",RAINSYNC_AVATAR_FIXTURE_DIR:f.root,AVATAR_PROCESS_TIMEOUT_MS:"10000"});
  const delayedHeaders=headers(null);
  const delayed=fresh.raw("/users/me/avatar",{method:"PUT",body:png(512,512,{marker:"fixture-delay"}),headers:delayedHeaders});
  const pidPath=resolve(f.root,"encoder.pid");
  let delayedPid;
  for(let i=0;i<100;i++){try{delayedPid=Number(await readFile(pidPath,"utf8"));break}catch{await delay(30)}}
  assert.ok(delayedPid>0,"delayed upload entered the real encoder process");
  const newerResponse=await fresh.raw("/users/me/avatar",{method:"PUT",body:normal,headers:headers(null)});
  assert.equal(newerResponse.status,200); const newer=await newerResponse.json();
  const newest=await fresh.request("/users/me/avatar","DELETE",undefined,200,headers(newer.avatar_version));
  await writeFile(resolve(f.root,"encoder.release"),"release");
  const stale=await delayed; assert.equal(stale.status,409); await stale.arrayBuffer();
  assert.equal((await fresh.request("/users/me/profile")).avatar_version,newest.avatar_version); assert.equal((await fresh.request("/users/me/profile")).avatar_url,null);
  for(const mode of ["fail-encode","oversize","sleep"]){
    await f.startServer({AVATAR_FFMPEG_BIN:fake,RAINSYNC_ISOLATED_TEST:"1",RAINSYNC_AVATAR_FIXTURE_DIR:f.root,RAINSYNC_AVATAR_FIXTURE_MODE:mode,AVATAR_PROCESS_TIMEOUT_MS:"1000"});
    const before=await readProfile();
    const response=await admin.raw("/users/me/avatar",{method:"PUT",body:normal,headers:headers(before.avatar_version)});
    assert.ok([413,503,504].includes(response.status),`${mode}: ${response.status}`); await response.arrayBuffer();
    assert.equal((await readProfile()).avatar_version,before.avatar_version);
    if(mode==="sleep"){
      const pid=Number(await readFile(pidPath,"utf8"));
      assert.throws(()=>process.kill(pid,0),"timed-out process must have been reaped before response");
    }
  }
  await rm(pidPath,{force:true});
  await f.startServer({AVATAR_FFMPEG_BIN:fake,RAINSYNC_ISOLATED_TEST:"1",RAINSYNC_AVATAR_FIXTURE_DIR:f.root,RAINSYNC_AVATAR_FIXTURE_MODE:"sleep",AVATAR_PROCESS_TIMEOUT_MS:"2000"});
  const abort=new AbortController();
  const interrupted=admin.raw("/users/me/avatar",{method:"PUT",body:normal,headers:headers((await readProfile()).avatar_version),signal:abort.signal});
  let interruptedPid;
  for(let i=0;i<100;i++){try{interruptedPid=Number(await readFile(pidPath,"utf8"));break}catch{await delay(20)}}
  assert.ok(interruptedPid>0); abort.abort(); await assert.rejects(interrupted);
  let alive=true;
  for(let i=0;i<150;i++){try{process.kill(interruptedPid,0)}catch{alive=false;break}await delay(20)}
  assert.equal(alive,false,"interrupted request's child is reaped within its configured processing deadline");
  await f.startServer();
  const final=await upload(normal,headers((await readProfile()).avatar_version));
  await admin.request("/users/me/profile","PATCH",{display_name:""});
  assert.equal((await readProfile()).avatar_version,final.avatar_version);
  const faultOperation=randomUUID();
  f.sql("ALTER TABLE user_avatars ADD CONSTRAINT fixture_fail CHECK(false) NOT VALID");
  try { await upload(normal,headers(final.avatar_version,faultOperation),500); }
  finally { f.sql("ALTER TABLE user_avatars DROP CONSTRAINT fixture_fail"); }
  assert.equal((await readProfile()).avatar_version,final.avatar_version);
  assert.equal(f.sql(`SELECT count(*) FROM avatar_operations WHERE operation_id='${faultOperation}'`),"0");
  await f.startServer({AVATAR_WRITES_PER_MINUTE:"1"}); f.sql("DELETE FROM account_rate_limits");
  const defaultAgain=await admin.request("/users/me/avatar","DELETE",undefined,200,headers(final.avatar_version));
  await upload(normal,headers(defaultAgain.avatar_version),429);
  console.log("PASS: real PNG decoding/WebP encoding, exact 512x512/alpha/size, authentication/cache, malformed/animated/large rejection, route size isolation, version and operation idempotency, racing uploads/delete tombstone, timeout reaping, independent nickname and restart persistence");
},{env:{AVATAR_WRITES_PER_MINUTE:"200"}});
