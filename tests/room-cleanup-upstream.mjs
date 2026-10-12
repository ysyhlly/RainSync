// Owned native PostgreSQL/Server and HTTP contracts, not real-product decode.
import assert from "node:assert/strict";
import { randomBytes,randomUUID,createCipheriv } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isolatedServer,delay } from "./fixtures/server.mjs";
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
async function until(check,label) { const end=Date.now()+20000; while(Date.now()<end) { if(await check()) return; await delay(30); } throw Error(`deadline: ${label}`); }
await isolatedServer("room-cleanup-upstream",async f=>{
  const client=f.client(), user=await client.login(), records=[];
  let encodingOkay=false, stopOkay=true;
  const upstream=createServer((req,res)=>{
    const chunks=[];
    req.on("data",chunk=>chunks.push(chunk));
    req.on("end",()=>{
      const url=new URL(req.url,"http://fixture");
      const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
      const record={method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams),body}; records.push(record);
      if(url.pathname === "/Users/fixture") {res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({Id:"fixture",Policy:{IsDisabled:false,EnableMediaPlayback:true}}));return;}
      if(url.pathname.endsWith("/PlaybackInfo")) { res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({PlaySessionId:randomUUID(),MediaSources:[{Id:"source-fixed",SupportsDirectPlay:true,MediaStreams:[],RunTimeTicks:300000000}]})); return; }
      if(url.pathname.endsWith("/ActiveEncodings")) { record.response_status=encodingOkay?204:202; res.writeHead(record.response_status).end(); return; }
      if(url.pathname.endsWith("/Stopped")) { res.writeHead(stopOkay?204:503).end(); return; }
      res.writeHead(204).end();
    });
  });
  await new Promise(done=>upstream.listen(0,"127.0.0.1",done));
  const remote=`http://127.0.0.1:${upstream.address().port}`;
  const encrypt=value=>{const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",Buffer.from(f.env.SOURCE_ENCRYPTION_KEY,"base64"),nonce);return Buffer.concat([nonce,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString("base64")};
  const view=id=>client.request(`/rooms/${id}/lifecycle`);
  const close=async id=>client.request(`/rooms/${id}/close`,"POST",{expected_revision:(await view(id)).state.revision});
  async function prepare(kind,name) {
    const room=await client.request("/rooms","POST",{name}),source=randomUUID(),media=randomUUID();
    f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','${name}','${kind}',${quote(encrypt({url:remote,token:"fixture",user_id:"fixture"}))}); INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES('${media}','${source}','fixture','${media}',30000); UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${room.id}'`);
    const plan=await client.request("/playback-sessions","POST",{room_id:room.id,media_generation:1,mode:"direct",observation_version:1});
    const sid=f.sql(`SELECT play_session_id FROM upstream_reservations WHERE id='${plan.session_id}'`);
    return {room,plan,sid};
  }
  try {
    const jelly=await prepare("jellyfin","captured viewer observation cleanup");
    await delay(1200);
    assert.equal(records.filter(r=>r.path==="/Sessions/Playing"&&r.body?.PlaySessionId===jelly.sid).length,0,"preparation must not fabricate playback");
    const sample={media_generation:1,seq:1,event:"playing",media_time_ms:1234,paused:false,seeking:false,buffering:false,playback_rate:1.05,has_played:true};
    await client.request(`/playback-sessions/${jelly.plan.session_id}/observations`,"POST",sample);
    await f.waitForSql(`SELECT reported_seq FROM playback_observations WHERE session_id='${jelly.plan.session_id}'`,"1");
    const start=records.find(r=>r.path==="/Sessions/Playing"&&r.body?.PlaySessionId===jelly.sid);
    assert.equal(start.body.PositionTicks,12340000); assert.equal(start.body.IsPaused,false); assert.equal(start.body.PlaybackRate,1.05);
    await client.request(`/playback-sessions/${jelly.plan.session_id}/observations`,"POST",{...sample,seq:2,event:"pause",media_time_ms:2345,paused:true});
    await f.waitForSql(`SELECT reported_seq FROM playback_observations WHERE session_id='${jelly.plan.session_id}'`,"2");
    await close(jelly.room.id);
    await until(async()=> (await view(jelly.room.id)).lifecycle==="closed","observed Jellyfin room closed");
    const stopped=records.find(r=>r.path==="/Sessions/Playing/Stopped"&&r.body?.PlaySessionId===jelly.sid);
    assert.equal(stopped.body.PositionTicks,23450000); assert.equal(stopped.body.IsPaused,true); assert.equal(stopped.body.MediaSourceId,"source-fixed");
    console.log("PASS: lifecycle close uses399captured viewer observation/identity; preparation emits no invented Start; stop retains last fixed sample");

    const emby=await prepare("emby","Emby positive encoder stop proof");
    const device=f.sql(`SELECT device_id FROM upstream_reservations WHERE id='${emby.plan.session_id}'`);
    await close(emby.room.id);
    await until(()=>records.some(r=>r.path==="/Videos/ActiveEncodings"&&r.query.PlaySessionId===emby.sid),"first Emby encoding stop");
    await until(()=>f.sql(`SELECT stop_confirmed AND NOT encoding_stop_confirmed FROM upstream_reservations WHERE id='${emby.plan.session_id}'`)==="t","separate stop proof captured");
    assert.equal((await view(emby.room.id)).lifecycle,"closing","Stopped204 is insufficient for Emby encoder");
    const deletion=records.find(r=>r.path==="/Videos/ActiveEncodings"&&r.query.PlaySessionId===emby.sid);
    assert.equal(deletion.response_status,202,"accepted is not positive execution completion");
    assert.equal(deletion.method,"DELETE"); assert.equal(deletion.query.DeviceId,device);
    encodingOkay=true;
    f.sql(`UPDATE upstream_reservations SET cleanup_after=now() WHERE id='${emby.plan.session_id}'`);
    await until(async()=> (await view(emby.room.id)).lifecycle==="closed","Emby both positive receipts");
    assert.equal(records.filter(r=>r.path==="/Sessions/Playing/Stopped"&&r.body?.PlaySessionId===emby.sid).length,1,"retry preserves confirmed check-in");
    assert.equal(f.sql(`SELECT stop_confirmed AND encoding_stop_confirmed AND NOT io_uncertain FROM upstream_reservations WHERE id='${emby.plan.session_id}'`),"t");
    assert.equal(records.filter(r=>r.path==="/Videos/ActiveEncodings"&&r.query.PlaySessionId===emby.sid).at(-1).response_status,204);
    console.log("PASS: Emby requires check-in plus confirmed204 encoding DELETE with exact device/SID; 202 remains unconfirmed and retry preserves individual positive proofs");

    const retained=await prepare("jellyfin","positive upstream proof retention");
    f.sql(`CREATE FUNCTION reject_test_upstream_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${retained.plan.session_id}' AND NEW.resource @> '{"upstream_closed":true}'::jsonb THEN RAISE EXCEPTION 'fixture marker write blocked'; END IF; RETURN NEW; END; $$; CREATE TRIGGER reject_test_upstream_marker BEFORE UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION reject_test_upstream_marker()`);
    // Pause the room cleanup claim before publication so ledger completion and
    // retention can be inspected independently of the final lifecycle write.
    f.sql(`CREATE FUNCTION pause_test_room_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.room_id='${retained.room.id}' THEN NEW.lease_until=now()+interval '1 hour'; NEW.lease_owner='${randomUUID()}'; END IF; RETURN NEW; END; $$; CREATE TRIGGER pause_test_room_cleanup BEFORE INSERT ON room_cleanup_tasks FOR EACH ROW EXECUTE FUNCTION pause_test_room_cleanup()`);
    await close(retained.room.id);
    f.sql("DROP TRIGGER pause_test_room_cleanup ON room_cleanup_tasks; DROP FUNCTION pause_test_room_cleanup()");
    await until(()=>f.sql(`SELECT state FROM upstream_reservations WHERE id='${retained.plan.session_id}'`)==="closed","ledger stop positive even when marker write fails");
    assert.equal(f.sql(`SELECT resource ? 'upstream_closed' FROM playback_sessions WHERE id='${retained.plan.session_id}'`),"f");
    assert.equal((await view(retained.room.id)).lifecycle,"closing");
    const main=await readFile("apps/server/src/bootstrap/lifecycle.rs","utf8");
    const pruneLine=main.split("\n").find(line=>line.includes('"DELETE FROM upstream_reservations u WHERE'));
    const repairLine=main.split("\n").find(line=>line.includes('"UPDATE playback_sessions p SET stopped=true,resource=resource||'));
    const query=line=>JSON.parse(line.trim().replace(/,$/,""));
    assert.ok(pruneLine&&repairLine);
    f.sql(`UPDATE upstream_reservations SET closed_at=now()-interval '3 days' WHERE id='${retained.plan.session_id}'`);
    f.sql(query(pruneLine));
    assert.equal(f.sql(`SELECT count(*) FROM upstream_reservations WHERE id='${retained.plan.session_id}'`),"1","missing marker+paused cleanup retains positive proof");
    f.sql("DROP TRIGGER reject_test_upstream_marker ON playback_sessions; DROP FUNCTION reject_test_upstream_marker()");
    f.sql(query(repairLine)); f.sql(query(pruneLine));
    assert.equal(f.sql(`SELECT resource @> '{"upstream_closed":true}' FROM playback_sessions WHERE id='${retained.plan.session_id}'`),"t");
    assert.equal(f.sql(`SELECT count(*) FROM upstream_reservations WHERE id='${retained.plan.session_id}'`),"1","positive marker does not prune evidence during pending cleanup");
    f.sql(`UPDATE room_cleanup_tasks SET lease_until=now()-interval '1 second',next_attempt_at=now() WHERE room_id='${retained.room.id}'`);
    await until(async()=> (await view(retained.room.id)).lifecycle==="closed","paused cleanup resumes from retained positive proof");
    f.sql(query(pruneLine));
    assert.equal(f.sql(`SELECT count(*) FROM upstream_reservations WHERE id='${retained.plan.session_id}'`),"0","completed cleanup plus durable marker permits bounded pruning");
    console.log("PASS: injected marker-write failure retains positive ledger across48h/paused cleanup; repair uses proven closed state; resume closes and safe retention prunes");

    const exhausted=await prepare("jellyfin","finite upstream retry budget");
    stopOkay=false; await close(exhausted.room.id);
    for(let attempt=1;attempt<=5;attempt++) {
      await until(()=>Number(f.sql(`SELECT cleanup_attempts FROM upstream_reservations WHERE id='${exhausted.plan.session_id}'`))>=attempt,`cleanup attempt ${attempt}`);
      await until(()=>f.sql(`SELECT io_claim IS NULL FROM upstream_reservations WHERE id='${exhausted.plan.session_id}'`)==="t","attempt finalized");
      if(attempt<5) f.sql(`UPDATE upstream_reservations SET cleanup_after=now() WHERE id='${exhausted.plan.session_id}'`);
    }
    await until(()=>f.sql(`SELECT state FROM upstream_reservations WHERE id='${exhausted.plan.session_id}'`)==="cleanup_failed","bounded terminal cleanup failure");
    await until(async()=> (await view(exhausted.room.id)).cleanup?.last_error==="upstream_cleanup_failed","room exposes bounded upstream failure");
    assert.equal(records.filter(r=>r.path==="/Sessions/Playing/Stopped"&&r.body?.PlaySessionId===exhausted.sid).length,5);
    await f.startServer(); stopOkay=true; await delay(2200);
    assert.equal((await view(exhausted.room.id)).lifecycle,"closing");
    assert.equal(f.sql(`SELECT cleanup_attempts FROM upstream_reservations WHERE id='${exhausted.plan.session_id}'`),"5");
    assert.equal(records.filter(r=>r.path==="/Sessions/Playing/Stopped"&&r.body?.PlaySessionId===exhausted.sid).length,5,"room retries/restart must not reset upstream budget");
    console.log("PASS: five bounded failed stops remain observable cleanup_failed/closing through restart; room retries do not reset399budget");
  } finally { upstream.closeAllConnections(); await new Promise(done=>upstream.close(done)); }
});
