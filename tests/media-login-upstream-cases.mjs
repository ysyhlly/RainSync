// Controlled owned peers only. This is not real Jellyfin/Emby acceptance.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
export async function mediaLoginUpstreamCases({fixture,controller,media,prepare,record,closed,assertKnownStop,contract,scenario,until,deferred}) {
 for(const kind of ['jellyfin','emby']) {
  await controller.change(media[kind]);
  await scenario(`${kind}: same-account login A/B exact grant control and independent logout cleanup`,async result=>{
   const a=fixture.client(),b=fixture.client();await a.login();await b.login();
   const key=randomUUID(),viewer=randomUUID(), extra={viewer_id:viewer,plan_generation:1,observation_version:1};
   const pa=await prepare(key,extra,undefined,a),pb=await prepare(randomUUID(),{...extra,viewer_id:randomUUID()},undefined,b);
   assert.equal(pa.status,200);assert.equal(pb.status,200);
   const aid=pa.body.session_id,bid=pb.body.session_id;
   const arow=record(aid),brow=record(bid);
   assert.notEqual(arow.auth_login_hash,brow.auth_login_hash);
   const hashCookie=c=>createHash('sha256').update(c.cookie.split('=')[1]).digest('hex');
   assert.equal(arow.auth_login_hash,hashCookie(a));assert.equal(brow.auth_login_hash,hashCookie(b));
   assert.equal(fixture.sql(`SELECT p.auth_login_hash=r.auth_login_hash AND p.auth_login_hash=u.auth_login_hash AND p.resource->'auth_context'->>'login_hash'=r.auth_login_hash FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id JOIN upstream_reservations u ON u.id=p.id WHERE p.id='${aid}'`),'t');
   const sample={media_generation:controller.state.media_generation,seq:1,event:'playing',media_time_ms:100,paused:false,seeking:false,buffering:false,playback_rate:1,has_played:true};
   await a.request(`/playback-sessions/${aid}/observations`,'POST',sample);
   await b.request(`/playback-sessions/${bid}/observations`,'POST',sample);
   await until(()=>record(aid).start_reported&&record(bid).start_reported,'independent actual playing Starts');
   const before=contract.negotiations.length;
   assert.notEqual((await prepare(key,extra,undefined,b)).status,200);
   assert.equal((await prepare(randomUUID(),{...extra,plan_generation:2},undefined,b)).status,409);
   for(const [path,method,body] of [[`/playback-sessions/${aid}`,'GET'],[`/playback-sessions/${aid}`,'POST'],[`/playback-sessions/${aid}`,'DELETE'],[`/playback-sessions/${aid}/observations`,'POST',{...sample,seq:2}],[`/playback-requests/${key}`,'DELETE']]) {
    await b.request(path,method,body,410);
   }
   assert.equal(contract.negotiations.length,before);
   assert.equal(record(aid).state,'active');assert.equal(record(bid).state,'active');
   await a.request('/auth/logout','POST');
   await closed(aid);assertKnownStop(aid);
   assert.equal(record(aid).auth_login_hash,arow.auth_login_hash,'logout preserves provenance');
   await b.request(`/playback-sessions/${bid}`);
   await b.request(`/playback-sessions/${bid}`,'POST');
   await b.request(`/playback-sessions/${bid}/observations`,'POST',{...sample,seq:2,event:'progress',media_time_ms:1500});
   assert.equal(record(bid).play_session_id,brow.play_session_id);
   assert.equal(record(bid).device_id,brow.device_id);
   assert.equal(record(bid).state,'active');
   assert.equal(contract.sessions.get(brow.play_session_id).stopped,false);
   await b.request(`/playback-sessions/${bid}`,'DELETE');await closed(bid);assertKnownStop(bid);
   Object.assign(result,{a_session:aid,b_session:bid,login_isolation:true,cleanup_after_logout:true,b_sid_unchanged:true});
  });
  await scenario(`${kind}: logout during held negotiation preserves late SID only for cleanup`,async result=>{
   const a=fixture.client();await a.login();
   const key=randomUUID(),fault={name:'login-revoked-before-checkpoint',hold:deferred()};contract.queue.push(fault);
   const pending=prepare(key,{},undefined,a);
   await until(()=>fault.received,'held negotiation reached owned peer');
   const id=fixture.sql(`SELECT id FROM upstream_reservations WHERE request_key='${key}'`);
   await a.request('/auth/logout','POST');
   fault.hold.release();const answer=await pending;assert.notEqual(answer.status,200);
   const final=await closed(id);assertKnownStop(id);
   assert.equal(final.play_session_id,fault.received.play_session_id);
   assert.ok(final.response_encrypted,'late checkpoint retained');
   assert.equal(fixture.sql(`SELECT count(*) FROM playback_sessions WHERE id='${id}' AND NOT stopped`),'0');
   assert.equal(contract.requests.filter(v=>v.play_session_id===final.play_session_id&&v.path==='/Sessions/Playing').length,0);
   Object.assign(result,{session_id:id,late_sid_retained:true,activated:false});
  });
 }
}
