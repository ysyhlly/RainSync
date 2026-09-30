import assert from "node:assert/strict";
import { randomBytes,randomUUID,createCipheriv } from "node:crypto";
import { createServer } from "node:http";
import { isolatedServer,delay } from "./fixtures/server.mjs";
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
async function until(check,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await delay(30);}throw Error(`deadline: ${label}`)}
await isolatedServer("upstream-graceful-shutdown",async f=>{
  const client=f.client();await client.login();
  let holdNegotiation=false,holdStart=false,holdProgress=false;
  let replyNegotiation,replyStart,replyProgress;
  const upstream=createServer((req,res)=>{
    req.resume();
    if(req.url==="/Users/fixture") {res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({Id:"fixture",Policy:{IsDisabled:false,EnableMediaPlayback:true}}));return;}
    if(req.url.endsWith("/PlaybackInfo")) {
      const reply=()=>{if(res.writableEnded||res.destroyed)return;res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({PlaySessionId:randomUUID(),MediaSources:[{Id:"fixed",SupportsDirectPlay:true,MediaStreams:[],RunTimeTicks:300000000}]}));};
      if(holdNegotiation)replyNegotiation=reply;else reply();return;
    }
    const reply=()=>{if(!res.writableEnded&&!res.destroyed)res.writeHead(204).end();};
    if(req.url==="/Sessions/Playing"&&holdStart){replyStart=reply;return;}
    if(req.url==="/Sessions/Playing/Progress"&&holdProgress){replyProgress=reply;return;}
    reply();
  });
  await new Promise(done=>upstream.listen(0,"127.0.0.1",done));
  const remote=`http://127.0.0.1:${upstream.address().port}`;
  const encrypt=value=>{const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",Buffer.from(f.env.SOURCE_ENCRYPTION_KEY,"base64"),nonce);return Buffer.concat([nonce,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString("base64")};
  async function createRoom(name){
    const room=await client.request("/rooms","POST",{name}),source=randomUUID(),media=randomUUID();
    f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','fixture','jellyfin',${quote(encrypt({url:remote,token:"fixture",user_id:"fixture"}))}); INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES('${media}','${source}','fixture','${media}',30000); UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${room.id}'`);
    return room;
  }
  const view=id=>client.request(`/rooms/${id}/lifecycle`);
  const close=async room=>client.request(`/rooms/${room.id}/close`,"POST",{expected_revision:(await view(room.id)).state.revision});
  async function holdShutdown(release,minimum){
    let exited=false;
    const stopping=f.stopServer().then(()=>{exited=true});
    await delay(minimum);
    assert.equal(exited,false,"planned shutdown must wait for its actual upstream owner");
    release();await stopping;
  }
  try{
    const negotiationRoom=await createRoom("negotiation drain beyond HTTP grace"),key=randomUUID();
    holdNegotiation=true;
    const preparing=client.raw("/playback-sessions",{method:"POST",body:{room_id:negotiationRoom.id,media_generation:1,idempotency_key:key,mode:"direct"},signal:AbortSignal.timeout(50000)}).then(response=>({status:response.status}),error=>({error:String(error)}));
    await until(()=>replyNegotiation,"upstream negotiation owned");
    const session=f.sql(`SELECT id FROM upstream_reservations WHERE request_key='${key}'`);
    await close(negotiationRoom);
    await holdShutdown(()=>replyNegotiation(),11500);holdNegotiation=false;
    const outcome=await preparing;assert.notEqual(outcome.status,200);
    assert.equal(f.sql(`SELECT negotiation FROM upstream_reservations WHERE id='${session}'`),"received");
    assert.equal(f.sql(`SELECT play_session_id IS NOT NULL AND NOT io_uncertain FROM upstream_reservations WHERE id='${session}'`),"t");
    assert.equal(f.sql(`SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id='${session}'`),"t");
    await f.startServer();
    await until(async()=> (await view(negotiationRoom.id)).lifecycle==="closed","restart cleans known delayed negotiation");
    console.log("PASS: planned SIGTERM waits beyond10s HTTP grace, captures delayed SID and preparation receipt; restart stops known session and closes room without unknown");

    const reportRoom=await createRoom("actual Start and Progress owner drain");
    let plan=await client.request("/playback-sessions","POST",{room_id:reportRoom.id,media_generation:1,mode:"direct",observation_version:1});
    const sample={media_generation:1,seq:1,event:"playing",media_time_ms:1200,paused:false,seeking:false,buffering:false,playback_rate:1,has_played:true};
    holdStart=true;
    await client.request(`/playback-sessions/${plan.session_id}/observations`,"POST",sample);
    await until(()=>replyStart,"Start owner in flight");
    await holdShutdown(()=>replyStart(),250);holdStart=false;
    assert.equal(f.sql(`SELECT start_reported AND NOT io_uncertain AND io_claim IS NULL FROM upstream_reservations WHERE id='${plan.session_id}'`),"t");
    assert.equal(f.sql(`SELECT reported_seq FROM playback_observations WHERE session_id='${plan.session_id}'`),"1");
    await f.startServer();
    assert.equal((await client.raw(`/playback-sessions/${plan.session_id}`)).status,410,"restart invalidates the old account authorization");
    const originalPlan=plan;
    plan=await client.request("/playback-sessions","POST",{room_id:reportRoom.id,media_generation:1,mode:"direct",observation_version:1});
    await client.request(`/playback-sessions/${plan.session_id}/observations`,"POST",sample);
    await until(()=>f.sql(`SELECT start_reported FROM upstream_reservations WHERE id='${plan.session_id}'`)==="t","new grant Start confirmed");
    assert.equal(f.sql(`SELECT reported_seq FROM playback_observations WHERE session_id='${originalPlan.session_id}'`),"1","old observation receipt survives restart");
    holdProgress=true;
    await client.request(`/playback-sessions/${plan.session_id}/observations`,"POST",{...sample,seq:2,event:"pause",media_time_ms:2300,paused:true});
    await until(()=>replyProgress,"Progress owner in flight");
    await holdShutdown(()=>replyProgress(),250);holdProgress=false;
    assert.equal(f.sql(`SELECT NOT io_uncertain AND io_claim IS NULL FROM upstream_reservations WHERE id='${plan.session_id}'`),"t");
    assert.equal(f.sql(`SELECT reported_seq FROM playback_observations WHERE session_id='${plan.session_id}'`),"2");
    await f.startServer();await close(reportRoom);
    await until(async()=> (await view(reportRoom.id)).lifecycle==="closed","reported room closes after ordinary restarts");
    console.log("PASS: planned SIGTERM drains delayed Start and Progress through finish_report/observation ACK; restart retires old grant while retaining actual report receipts and no fabricated uncertain operation");
  }finally{replyNegotiation?.();replyStart?.();replyProgress?.();upstream.closeAllConnections();await new Promise(done=>upstream.close(done));}
});
