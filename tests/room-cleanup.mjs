import assert from "node:assert/strict";
import { randomUUID, randomBytes, createCipheriv, createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
async function until(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw Error(`deadline: ${description}`);
}
async function childrenOf(parent) {
  const children=[];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat=await readFile(`/proc/${pid}/stat`,"utf8");
      const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
      if (Number(fields[1])===parent) children.push(Number(pid));
    } catch {}
  }
  return children;
}
const exists = async pid => { try { await readFile(`/proc/${pid}/stat`); return true; } catch { return false; } };

await isolatedMediaStack("room-cleanup", async f => {
  const client=f.client(), user=await client.login();
  const encryptionKey=Buffer.from(f.env.SOURCE_ENCRYPTION_KEY,"base64");
  const encrypt=value=>{ const nonce=randomBytes(12), cipher=createCipheriv("aes-256-gcm",encryptionKey,nonce); return Buffer.concat([nonce,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString("base64"); };
  let failStop=true, stops=0, starts=0, sourceRequests=0;
  let negotiation="immediate", releaseNegotiation, startMode="immediate", releaseStart;
  const sockets=new Set();
  const upstream=createServer((req,res)=>{
    if(req.url==="/source") { sourceRequests++; res.writeHead(200,{"Content-Type":"video/mp4","Content-Length":1024*1024*1024}); res.flushHeaders(); return; }
    req.resume();
    if(req.url.startsWith("/Items/") && req.url.endsWith("/PlaybackInfo")) {
      const reply=()=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({PlaySessionId:randomUUID(),MediaSources:[{Id:"fixture",SupportsDirectPlay:true,MediaStreams:[],RunTimeTicks:300000000}]}));
      if(negotiation==="defer") releaseNegotiation=reply;
      else if(negotiation==="lose") req.socket.destroy();
      else reply();
      return;
    }
    if(req.url==="/Sessions/Playing/Stopped") { stops++; res.writeHead(failStop?503:204).end(); return; }
    if(req.url==="/Sessions/Playing") { starts++; if(startMode==="defer") { releaseStart=()=>res.writeHead(204).end(); return; } }
    res.writeHead(204).end();
  });
  upstream.on("connection",socket=>{ sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); });
  await new Promise(done=>upstream.listen(0,"127.0.0.1",done));
  const remote=`http://127.0.0.1:${upstream.address().port}`;
  const room=async name=>client.request("/rooms","POST",{name});
  const lifecycle=id=>client.request(`/rooms/${id}/lifecycle`);
  const close=async id=>{ const current=await lifecycle(id); return client.request(`/rooms/${id}/close`,"POST",{expected_revision:current.state.revision}); };
  const waitClosed=async id=>until(async()=> (await lifecycle(id)).lifecycle==="closed","room cleanup completed");
  const seed=(id,room,resource)=>{
    const token=randomBytes(24).toString("hex");
    f.sql(`INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}','${user.id}','${room}',0,'${createHash("sha256").update(token).digest("hex")}',${quote(JSON.stringify({encrypted:encrypt(resource)}))},now()+interval '1 hour')`);
    return token;
  };
  let paused=false;
  try {
    await f.startWorker();
    const external=await room("upstream retry across restart"), session=randomUUID();
    const resource={kind:"jellyfin",upstream_base:remote,upstream_item:"fixture",upstream_session:randomUUID(),headers:{},transport:"progressive"};
    seed(session,external.id,resource);
    f.sql(`INSERT INTO upstream_reservations(id,user_id,request_key,owner_epoch,room_id,media_id,source_id,generation,kind,device_id,origin_key,scope_encrypted,play_session_id,state,negotiation,lifecycle_epoch,play_method,start_reported) VALUES('${session}','${user.id}','${randomUUID()}','${randomUUID()}','${external.id}','${randomUUID()}','${randomUUID()}',0,'jellyfin','fixture-${session}','fixture-origin',${quote(encrypt({config:{url:remote,token:"fixture",user_id:"fixture"},item:"fixture"}))},'${resource.upstream_session}','active','received',0,'DirectPlay',true)`);
    assert.equal((await close(external.id)).lifecycle,"closing");
    await until(()=>stops>0,"first upstream stop failure");
    await until(async()=>Boolean((await lifecycle(external.id)).cleanup?.last_error),"observable cleanup failure");
    assert.equal((await lifecycle(external.id)).lifecycle,"closing");
    assert.equal(f.sql(`SELECT resource ? 'upstream_closed' FROM playback_sessions WHERE id='${session}'`),"f");
    await f.startServer();
    assert.equal((await lifecycle(external.id)).lifecycle,"closing");
    failStop=false;
    f.sql(`UPDATE room_cleanup_tasks SET next_attempt_at=now(),lease_until=now()-interval '1 second' WHERE room_id='${external.id}'`);
    await waitClosed(external.id);
    assert.ok(stops>=2);
    assert.equal(starts,0);
    assert.equal(f.sql(`SELECT resource @> '{"upstream_closed":true}' FROM playback_sessions WHERE id='${session}'`),"t");
    assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events WHERE room_id='${external.id}' AND lifecycle='closed'`),"1");
    console.log("PASS: failed upstream stop stays closing, durable server restart retries, positive upstream stop ACK closes exactly once");

    const source=randomUUID();
    f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${source}','fake Jellyfin','jellyfin',${quote(encrypt({url:remote,token:"fixture",user_id:"fixture"}))})`);
    async function negotiatingRoom(name) {
      const value=await room(name), media=randomUUID();
      f.sql(`INSERT INTO media_items(id,source_id,title,resource,duration_ms) VALUES('${media}','${source}','upstream fixture','fixture-${media}',30000); UPDATE room_snapshots SET state=jsonb_set(jsonb_set(state,'{media_id}','"${media}"'),'{media_generation}','1') WHERE room_id='${value.id}'`);
      return value;
    }
    const pending=await negotiatingRoom("close during upstream negotiation");
    negotiation="defer";
    const startsBefore=starts, stopsBefore=stops;
    const preparing=client.raw("/playback-sessions",{method:"POST",body:{room_id:pending.id,media_generation:1,mode:"direct"}});
    await until(()=>typeof releaseNegotiation==="function","upstream negotiation has external side effect intent");
    await close(pending.id);
    await until(async()=> (await lifecycle(pending.id)).cleanup?.last_error==="playback_preparation_drain_unconfirmed","close waits for negotiating executor");
    assert.equal(stops,stopsBefore,"must not stop before future upstream identity is captured");
    releaseNegotiation(); negotiation="immediate";
    assert.notEqual((await preparing).status,200,"close fences late plan publication");
    await waitClosed(pending.id);
    assert.equal(starts,startsBefore,"late upstream start must not be sent");
    assert.equal(f.sql(`SELECT count(*) FROM playback_sessions WHERE room_id='${pending.id}'`),"0");
    assert.equal(f.sql(`SELECT state FROM upstream_reservations WHERE room_id='${pending.id}'`),"closed");
    console.log("PASS: close during real negotiation waits for immutable preparation, captures orphan identity, prevents late grant/start, then stops upstream");

    const starting=await negotiatingRoom("close during upstream start");
    startMode="defer";
    const playing=client.raw("/playback-sessions",{method:"POST",body:{room_id:starting.id,media_generation:1,mode:"direct"}});
    await until(()=>typeof releaseStart==="function","upstream start in flight");
    const beforeCloseStops=stops;
    await close(starting.id);
    await until(async()=>Boolean((await lifecycle(starting.id)).cleanup?.last_error),"close observes in-flight start");
    assert.equal((await lifecycle(starting.id)).lifecycle,"closing");
    assert.equal(stops,beforeCloseStops,"stop cannot race ahead of known in-flight start");
    releaseStart(); startMode="immediate";
    await playing;
    await waitClosed(starting.id);
    assert.equal(f.sql(`SELECT state FROM upstream_reservations WHERE room_id='${starting.id}'`),"closed");
    console.log("PASS: close cannot overtake upstream start; durable reporting state drains before idempotent stop");

    const unknown=await negotiatingRoom("lost upstream negotiation response");
    negotiation="lose";
    assert.equal((await client.raw("/playback-sessions",{method:"POST",body:{room_id:unknown.id,media_generation:1,mode:"direct"}})).status,502);
    negotiation="immediate";
    await close(unknown.id);
    await until(async()=> (await lifecycle(unknown.id)).cleanup?.last_error==="upstream_operation_unconfirmed","unknown upstream identity cannot be called closed");
    await f.startServer();
    assert.equal((await lifecycle(unknown.id)).lifecycle,"closing");
    console.log("PASS: lost upstream negotiation identity remains visibly unconfirmed across restart instead of falsely closed");

    const nas=await room("remote NAS drain evidence"), nasSession=randomUUID(), agent=randomUUID(), transfer=randomUUID();
    seed(nasSession,nas.id,{kind:"agent",agent_id:agent,resource:"fixture.mp4",headers:{}});
    f.sql(`INSERT INTO agents(id,name) VALUES('${agent}','unresponsive owned NAS fixture'); INSERT INTO agent_transfer_runs(id,agent_id,resource_hash,head,status,finished_at,lease_until,session_id,dispatched_at,legacy_unconfirmed) VALUES('${transfer}','${agent}','fixture',false,'cancelled',now()-interval '2 days',now()-interval '1 day','${nasSession}',now()-interval '2 days',false)`);
    await close(nas.id);
    await until(async()=> (await lifecycle(nas.id)).cleanup?.last_error==="agent_transfer_drain_unconfirmed","local cancellation cannot prove remote NAS file disposal");
    f.sql("DELETE FROM agent_transfer_runs WHERE NOT legacy_unconfirmed AND finished_at<now()-interval '24 hours' AND (session_id IS NULL OR agent_drained_at IS NOT NULL)");
    assert.equal(f.sql(`SELECT count(*) FROM agent_transfer_runs WHERE id='${transfer}'`),"1","retention must not erase missing remote ACK");
    await f.startServer();
    assert.equal((await lifecycle(nas.id)).lifecycle,"closing");
    console.log("PASS: mapped NAS cancellation/expiry/old history lacks a remote receipt, stays closing, and is retained across restart");

    if(process.platform!=="linux") { console.log("SKIP: SIGSTOP and /proc process witness require Linux"); return; }
    const local=await room("live FFmpeg process receipt"), job=randomUUID();
    const token=seed(job,local.id,{kind:"http",url:`${remote}/source`,headers:{},transport:"progressive"});
    f.sql(`INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${job}','${job}','queued',${quote(JSON.stringify({input_ticket:encrypt({token}),transcode:true,start_seconds:0,estimated_output_bytes:65536}))})`);
    await until(()=>sourceRequests>0,"actual FFmpeg waiting on HTTP source");
    const processes=await childrenOf(f.workerPid);
    assert.ok(processes.length>0,"real FFmpeg child must exist");
    assert.equal(f.sql(`SELECT count(*) FROM media_executions WHERE job_id='${job}' AND reaped_at IS NULL`),"1");
    process.kill(f.workerPid,"SIGSTOP"); paused=true;
    const closing=await close(local.id);
    assert.equal(closing.lifecycle,"closing");
    f.sql(`UPDATE media_jobs SET lease_until=now()-interval '1 hour' WHERE id='${job}'`);
    await until(async()=> (await lifecycle(local.id)).cleanup?.last_error==="media_execution_drain_unconfirmed","cancelled/expired job cannot prove process stop");
    assert.equal(f.sql(`SELECT status FROM media_jobs WHERE id='${job}'`),"cancelled");
    assert.ok((await Promise.all(processes.map(exists))).every(Boolean),"paused worker retains actual resource witnesses");
    await f.startServer();
    assert.equal((await lifecycle(local.id)).lifecycle,"closing");
    await delay(1500);
    assert.equal((await lifecycle(local.id)).lifecycle,"closing");
    process.kill(f.workerPid,"SIGCONT"); paused=false;
    await waitClosed(local.id);
    await until(async()=> (await Promise.all(processes.map(exists))).every(value=>!value),"OS process tree disappeared before closed");
    assert.equal(f.sql(`SELECT count(*) FROM media_executions WHERE session_id='${job}' AND reaped_at IS NULL`),"0");
    assert.equal(f.sql(`SELECT count(*) FROM media_outputs WHERE job_id='${job}' AND status='published'`),"0");
    const oldUrl=`${f.workerOrigin}/media-delivery/${job}/source?token=${token}`;
    assert.equal((await fetch(oldUrl)).status,401);
    const closed=await lifecycle(local.id);
    await client.request(`/rooms/${local.id}/reopen`,"POST",{expected_revision:closed.state.revision});
    assert.equal((await fetch(oldUrl)).status,401,"old grant remains revoked after reopen");
    assert.equal(f.sql(`SELECT count(*) FROM room_lifecycle_events WHERE room_id='${local.id}' AND lifecycle='closed'`),"1");
    console.log("PASS: SIGSTOP worker+expired lease+cancelled job stays closing; resume drains real FFmpeg/source, durable ACK permits close, no late output, old grant rejected after reopen");
  } finally {
    if(paused) process.kill(f.workerPid,"SIGCONT");
    for(const socket of sockets) socket.destroy();
    await new Promise(done=>upstream.close(done));
  }
});
