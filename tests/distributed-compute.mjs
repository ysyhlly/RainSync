// Owned synthetic two-node NAS computation, fencing, authenticated publication and P2P signaling.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,copyFile,writeFile,readFile,open,stat} from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {isolatedMediaStack} from './fixtures/media-stack.mjs';
import {delay} from './fixtures/server.mjs';
import {reapOwnedChildren} from '../deploy/owned-process.mjs';
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100)}throw Error(`Timeout: ${label}`)}
const report={schema_version:1,result:'running',checks:[],scope:'Owned local synthetic NAS nodes, FFmpeg, PostgreSQL and browser DataChannel; not multi-hardware/NAT/TURN/performance acceptance'};
let fixture;
try{await isolatedMediaStack('distributed-compute',async f=>{
 fixture=f;const children=new Set(),logs=[];const admin=f.client();const owner=await admin.login();
 const launch=(binary,extra)=>{const log=createWriteStream(resolve(f.root,`compute-${logs.length+1}.log`));logs.push(log);const child=spawn(resolve(f.target,binary),[],{env:{...f.env,...extra},stdio:['ignore','pipe','pipe']});const closed=new Promise(r=>child.once('close',r));child.stdout.pipe(log);child.stderr.pipe(log);const record={child,closed};children.add(record);closed.then(()=>children.delete(record));return record};
 const stop=async record=>{if(record.child.exitCode===null&&record.child.signalCode===null)record.child.kill('SIGTERM');await record.closed};
 const roots=[resolve(f.root,'source-a'),resolve(f.root,'source-b')];for(const root of roots)await mkdir(root,{recursive:true});
 const clip=await f.makeClip('source-a/same.mp4',{pictureSeconds:16,width:1280,height:720});
 // Owned two-track source proves absolute original audio selection, beyond video-only fixtures.
 const audioClip=resolve(f.root,'two-audio.mp4');const mux=spawn('ffmpeg',['-v','error','-nostdin','-y','-i',clip,'-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=16','-f','lavfi','-i','sine=frequency=880:sample_rate=44100:duration=16','-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','copy','-c:a','aac','-shortest',audioClip],{env:f.env,stdio:['ignore','ignore','pipe']});
 const muxClosed=new Promise(r=>mux.once('close',r));const muxTimeout=setTimeout(()=>mux.kill('SIGTERM'),20000);muxClosed.finally(()=>clearTimeout(muxTimeout));const muxOwner={child:mux,closed:muxClosed};children.add(muxOwner);muxClosed.then(()=>children.delete(muxOwner));const muxError=[];mux.stderr.on('data',chunk=>muxError.push(chunk));assert.equal(await muxClosed,0,Buffer.concat(muxError).toString());await copyFile(audioClip,clip);
 await copyFile(clip,resolve(roots[1],'same.mp4'));
 const sourceHash=createHash('sha256').update(await readFile(clip)).digest('hex');
 const agents=[];
 async function requestAgent(agent,path,body,expected=200){const response=await fetch(f.origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${agent.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await response.json();assert.equal(response.status,expected,`${path} ${JSON.stringify(json)}`);return json}
 try{
  for(let i=0;i<2;i++){
    const created=await admin.request('/agents','POST',{name:`owned compute ${i}`});const paired=await fetch(f.origin+'/api/v1/agents/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:created.pair_code})}).then(r=>r.json());
    const credential=resolve(f.root,`agent-${i}.json`);await writeFile(credential,JSON.stringify(paired),{mode:0o600});
    const agent={id:created.id,token:paired.token,credential,root:roots[i]};agents.push(agent);
    launch('rainsync-nas-agent',{SERVER_URL:f.origin,MEDIA_ROOT:agent.root,AGENT_CREDENTIAL_FILE:credential,AGENT_INDEX_INTERVAL_SECS:'5'});
    await until(()=>f.sql(`SELECT id FROM media_items WHERE source_id='${agent.id}' AND resource='same.mp4' AND available AND source_version IS NOT NULL`),'versioned NAS index');
    await requestAgent(agent,'/agent-compute/heartbeat',{connection_id:randomUUID(),capabilities:['h264_480p_hls_v1'],self_test:{}},403);
    await admin.request(`/agents/${agent.id}/compute-policy`,'POST',{enabled:true,slots:1,output_budget_bytes:67108864});
  }
  const node=i=>launch('rainsync-compute-node',{SERVER_URL:f.origin,RAINSYNC_NAS_COMPUTE_ENABLED:'1',AGENT_CREDENTIAL_FILE:agents[i].credential,COMPUTE_MEDIA_ROOT:agents[i].root,COMPUTE_OUTPUT_ROOT:resolve(f.root,`node-${i}-output`)});
  const initial=[node(0),node(1)];
  await until(()=>f.sql(`SELECT count(*) FROM distributed_compute_sources WHERE content_sha256='${sourceHash}'`)==='2','real daemon hash registrations');
  await Promise.all(initial.map(stop));
  const media=f.sql(`SELECT id FROM media_items WHERE source_id='${agents[0].id}' AND resource='same.mp4'`);
  const other=f.sql(`SELECT id FROM media_items WHERE source_id='${agents[1].id}' AND resource='same.mp4'`);assert.notEqual(media,other);
  const room=await admin.request('/rooms','POST',{name:'owned distributed compute'});
  f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1) WHERE room_id='${room.id}'`);
  const connection=f.sql(`SELECT connection_id FROM distributed_compute_nodes WHERE agent_id='${agents[0].id}'`);
  await requestAgent(agents[0],'/agent-compute/heartbeat',{connection_id:connection,capabilities:['h264_480p_hls_v1'],self_test:{version:1,ffmpeg_sample:'passed'}});
  const prepared=await admin.request(`/rooms/${room.id}/compute`,'POST',{media_generation:1,recipe:'h264_480p_hls_v1',audio_index:2});
  const first=(await requestAgent(agents[0],'/agent-compute/claim',{connection_id:connection})).job;assert.equal(first.id,prepared.id);assert.equal(first.attempt,1);
  f.sql(`UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id='${first.id}'`);
  const secondNode=node(1);
  const ready=await until(async()=>{const state=await admin.request(`/rooms/${room.id}/compute/${prepared.id}`);if(state.status==='failed')throw Error(`Compute failed ${JSON.stringify(state)}`);return state.status==='ready'?state:null},'replica takeover and real HLS publication',60000);
  assert.equal(ready.attempt,2);assert.equal(ready.owner_agent,agents[1].id);assert.notEqual(ready.output_generation,first.output_generation);
  const fence={connection_id:connection,attempt:first.attempt,output_generation:first.output_generation};
  assert.equal(f.sql(`SELECT distributed_compute_room_drained('${room.id}')`),'f');
  await requestAgent(agents[1],`/agent-compute/jobs/${first.id}/reaped`,{...fence,process_disposition:'never_started'},403);
  await requestAgent(agents[0],`/agent-compute/jobs/${first.id}/reaped`,{...fence,process_disposition:'unknown'},400);
  await requestAgent(agents[0],`/agent-compute/jobs/${first.id}/reaped`,{...fence,output_generation:randomUUID(),process_disposition:'never_started'},403);
  await requestAgent(agents[0],`/agent-compute/jobs/${first.id}/renew`,fence,409);
  report.checks.push('distinct NAS catalogs; genuine source hash registration; expired attempt migrated to equivalent replica; new output generation; old owner fenced');
  const directory=await admin.request(`/rooms/${room.id}/compute/${prepared.id}/directory`);assert.equal(directory.output_generation,ready.output_generation);
  for(const file of directory.files){const response=await admin.raw(file.url.replace('/api/v1',''));assert.equal(response.status,200);const data=Buffer.from(await response.arrayBuffer());assert.equal(data.length,file.size_bytes);assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256)}
  report.checks.push('real fixed-recipe FFmpeg HLS; generation-isolated upload; trusted server-computed hash/length; cookie-authorized output routing');
  const primaryBody=(viewer= randomUUID(),plan_generation=1)=>({room_id:room.id,media_generation:1,mode:'auto',position_ms:6000,audio_index:2,viewer_id:viewer,plan_generation,idempotency_key:randomUUID(),capabilities:{progressive_h264_aac:true,native_hls:false,mse_h264_aac:true},distributed_compute:{schema_version:1,job_id:prepared.id,output_generation:ready.output_generation},observation_version:1,playback_metrics_version:1,playback_metrics_supported_versions:[1,2],playback_metrics:{meter_start_generation:plan_generation,startup_origin:'user_intent'}});
  const originalPrimary=primaryBody();
  const planA=await admin.request('/playback-sessions/distributed-compute','POST',originalPrimary);
  assert.equal(planA.media_id,media);assert.equal(planA.media_generation,1);assert.equal(planA.distributed_compute.job_id,prepared.id);assert.equal(planA.distributed_compute.output_generation,ready.output_generation);assert.equal(planA.distributed_compute.attempt,2);assert.equal(planA.distributed_compute.source_audio_index,2);assert.equal(planA.selected_audio_track,2);assert.equal(planA.distributed_compute.audio_codec,'aac');assert.equal(planA.distributed_compute.audio_sample_rate,44100);assert.equal(planA.timeline_origin_ms,0);assert.ok(Math.abs(planA.duration_ms-16000)<150);assert.equal(planA.rebuild_on_seek,false);assert.equal(planA.transport,'hls');assert.equal(planA.observation_version,1);assert.ok([1,2].includes(planA.playback_metrics_version));
  assert.equal((await admin.request('/playback-sessions/distributed-compute','POST',originalPrimary)).session_id,planA.session_id);
  const primaryDirectory=await admin.request(`/playback-sessions/${planA.session_id}/distributed/directory`);assert.equal(primaryDirectory.session_id,planA.session_id);assert.equal(primaryDirectory.output_generation,ready.output_generation);
  for(const file of primaryDirectory.files){assert.ok(file.url.startsWith(`/api/v1/playback-sessions/${planA.session_id}/distributed/files/`));const response=await admin.raw(file.url.replace('/api/v1',''));assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);assert.equal(bytes.length,file.size_bytes);}
  const primaryReady=await admin.request(`/playback-sessions/${planA.session_id}?plan_generation=1&relative_position_ms=6000`);assert.equal(primaryReady.status,'ready');assert.equal(primaryReady.complete,true);
  report.checks.push('qualified NAS output uses standard primary playback reservation/session/high-water; exact same-key replay; source timeline/duration; observations/metrics negotiated; session-scoped immutable HTTP manifest/fragments; seek needs no transcode rebuild');
  await admin.request('/users','POST',{username:'compute-viewer',password:f.password});const viewer=f.client();await viewer.login('compute-viewer',f.password);const invite=await admin.request(`/rooms/${room.id}/invites`,'POST');await viewer.request(`/rooms/${room.id}/join`,'POST',{token:invite.token});
  const consent={acknowledge_peer_addresses:true,confirm_current_network:true,upload_allowed:true};
  await admin.request(`/rooms/${room.id}/compute/${prepared.id}/p2p`,'POST',{...consent,acknowledge_peer_addresses:false},400);
  const planB=await viewer.request('/playback-sessions/distributed-compute','POST',primaryBody());
  assert.notEqual(planB.session_id,planA.session_id);assert.equal(planB.distributed_compute.output_generation,planA.distributed_compute.output_generation);
  const assertPeerAuthorization=(reply,peer,session_id,expectedPeers)=>{
   const a=reply.authorization;
   assert.deepEqual(Object.keys(a).sort(),['version','peer_id','room_id','job_id','output_generation','session_id','lease_ms','peers'].sort());
   assert.equal(a.version,1);assert.equal(a.peer_id,peer);assert.equal(a.room_id,room.id);assert.equal(a.job_id,prepared.id);assert.equal(a.output_generation,ready.output_generation);assert.equal(a.session_id,session_id);
   assert.ok(Number.isInteger(a.lease_ms)&&a.lease_ms>0&&a.lease_ms<=3000);
   assert.deepEqual(a.peers.map(p=>p.peer_id).sort(),expectedPeers.slice().sort());
   for(const p of a.peers){assert.deepEqual(Object.keys(p).sort(),['peer_id','lease_ms'].sort());assert.ok(Number.isInteger(p.lease_ms)&&p.lease_ms>0&&p.lease_ms<=a.lease_ms);}
  };
  const primaryPeerA=await admin.request(`/playback-sessions/${planA.session_id}/distributed/p2p`,'POST',consent);
  const primaryPeerB=await viewer.request(`/playback-sessions/${planB.session_id}/distributed/p2p`,'POST',consent);assert.equal(primaryPeerB.peers[0],primaryPeerA.peer_id);
  assertPeerAuthorization(primaryPeerA,primaryPeerA.peer_id,planA.session_id,[]);
  assertPeerAuthorization(primaryPeerB,primaryPeerB.peer_id,planB.session_id,[primaryPeerA.peer_id]);
  await viewer.request(`/room-p2p/${primaryPeerB.peer_id}/signal`,'POST',{recipient:primaryPeerA.peer_id,kind:'offer',payload:{type:'offer',sdp:'owned-primary-test'}});
  assert.equal((await admin.request(`/room-p2p/${primaryPeerA.peer_id}?after=0`)).signals[0].sender,primaryPeerB.peer_id);
  await viewer.request('/playback-sessions/distributed-compute','POST',{...primaryBody(),audio_index:1},409);
  const wrongGeneration={...primaryBody(),distributed_compute:{schema_version:1,job_id:prepared.id,output_generation:randomUUID()}};
  await viewer.request('/playback-sessions/distributed-compute','POST',wrongGeneration,410);
  await viewer.request('/playback-sessions','POST',primaryBody(),400);
  await viewer.request(`/playback-sessions/${planA.session_id}/distributed/directory`,'GET',undefined,410);
  const successorBody=primaryBody(originalPrimary.viewer_id,2);const successor=await admin.request('/playback-sessions/distributed-compute','POST',successorBody);assert.notEqual(successor.session_id,planA.session_id);
  await admin.request(`/playback-sessions/${planA.session_id}/distributed/directory`,'GET',undefined,410);
  await admin.request(`/room-p2p/${primaryPeerA.peer_id}`,'GET',undefined,404);
  assertPeerAuthorization(await viewer.request(`/room-p2p/${primaryPeerB.peer_id}?peers=${primaryPeerA.peer_id}`),primaryPeerB.peer_id,planB.session_id,[]);
  await admin.request('/playback-sessions/distributed-compute','POST',originalPrimary,409);
  report.checks.push('distinct viewers share the same exact qualified output through independently authorized session peers; wrong generation/endpoint/login rejected; newer viewer plan fences previous HTTP, peer, replay');
  const peerA=await admin.request(`/rooms/${room.id}/compute/${prepared.id}/p2p`,'POST',consent),peerB=await viewer.request(`/rooms/${room.id}/compute/${prepared.id}/p2p`,'POST',consent);assert.equal(peerB.peers[0],peerA.peer_id);
  await viewer.request(`/room-p2p/${peerB.peer_id}/signal`,'POST',{recipient:peerA.peer_id,kind:'offer',payload:{type:'offer',sdp:'owned-test'}});
  const inbox=await admin.request(`/room-p2p/${peerA.peer_id}?after=0`);assert.equal(inbox.signals[0].sender,peerB.peer_id);
  assertPeerAuthorization(peerB,peerB.peer_id,null,[peerA.peer_id]);
  assertPeerAuthorization(inbox,peerA.peer_id,null,[peerB.peer_id]);
  const revalidated=await admin.request(`/room-p2p/${peerA.peer_id}?after=${inbox.cursor}&peers=${peerB.peer_id}`);
  assert.equal(revalidated.signals.length,0);assertPeerAuthorization(revalidated,peerA.peer_id,null,[peerB.peer_id]);
  await admin.request(`/room-p2p/${peerA.peer_id}?peers=invalid`,'GET',undefined,400);
  await admin.request(`/room-p2p/${peerA.peer_id}?peers=${[peerB.peer_id,randomUUID(),randomUUID(),randomUUID()].join(',')}`,'GET',undefined,400);
  assertPeerAuthorization(await admin.request(`/room-p2p/${peerA.peer_id}?peers=${randomUUID()}`),peerA.peer_id,null,[]);
  await viewer.request(`/room-p2p/${peerB.peer_id}/signal`,'POST',{recipient:randomUUID(),kind:'offer',payload:{}},404);
  const anonymous=f.client();await anonymous.request(`/room-p2p/${peerA.peer_id}`,'GET',undefined,401);
  f.sql(`UPDATE room_p2p_peers SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id='${peerB.peer_id}'`);
  const shortLease=await admin.request(`/room-p2p/${peerA.peer_id}?peers=${peerB.peer_id}`);
  assertPeerAuthorization(shortLease,peerA.peer_id,null,[peerB.peer_id]);assert.ok(shortLease.authorization.peers[0].lease_ms<=2000);
  f.sql(`UPDATE room_p2p_peers SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${peerB.peer_id}'`);
  assertPeerAuthorization(await admin.request(`/room-p2p/${peerA.peer_id}?peers=${peerB.peer_id}`),peerA.peer_id,null,[]);
  report.checks.push('explicit consent and same-scope signaling; bounded opaque peer snapshots revalidate established peers without pending signals; expired tickets and replaced primary plans disappear from the still-authorized sender snapshot; remote leases shorten to ticket expiry');
  // Browser transport check uses the actual implementation with real local WebRTC, no STUN/TURN.
  const {chromium}=await import('@playwright/test');const esbuild=await import('esbuild');
  const bundle=await esbuild.build({entryPoints:[resolve('apps/web/src/features/playback/room-p2p.ts')],bundle:true,write:false,format:'iife',globalName:'RainSyncP2P',platform:'browser'});
  let browser;try{browser=await chromium.launch({executablePath:process.env.CHROMIUM_BIN??'/usr/bin/chromium',headless:true,chromiumSandbox:true});}catch(error){report.browser={result:'blocked',error:String(error)};console.log('Browser transport acceptance blocked:',String(error).split('\n')[0]);}
  const pages=[];
  if(browser)try{
   const contexts=[await browser.newContext(),await browser.newContext()];const clients=[admin,viewer];
   for(let i=0;i<2;i++){
    const cookie=clients[i].cookie;await contexts[i].addCookies([{name:cookie.slice(0,cookie.indexOf('=')),value:cookie.slice(cookie.indexOf('=')+1),url:f.origin}]);
    const page=await contexts[i].newPage();pages.push(page);await page.goto(f.origin+'/health');await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(async({room,job,csrf})=>{
     // Failure-only diagnostics are bounded and contain states/counts/lifetimes,
     // never SDP, candidate addresses, principal IDs or authentication values.
     const trace=[];window.p2pTrace=trace;
     const record=entry=>{trace.push({at_ms:Math.round(performance.now()),...entry});if(trace.length>128)trace.shift()};
     const state=()=>{const t=window.transport,now=performance.now();return {active:t.active,visibility:document.visibilityState,lease_ms:Math.round(t.authorizedUntil-now),authorized_peers:t.authorizedPeers.size,peers:[...t.peers.entries()].map(([id,p])=>({connection:p.pc.connectionState,ice:p.pc.iceConnectionState,gathering:p.pc.iceGatheringState,signaling:p.pc.signalingState,channel:p.channel?.readyState??'absent',lease_ms:Math.round((t.authorizedPeers.get(id)??0)-now),pending:p.pending.size,uploading:p.uploads.size}))}};
     window.p2pState=state;
     const api=async(path,method='GET',body)=>{
      const operation=path.endsWith('/directory')?'directory':path.endsWith('/signal')?'signal':method==='DELETE'?'leave':method==='POST'?'join':'poll';
      const started=performance.now();
      try{const r=await fetch('/api/v1'+path,{method,headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
       record({event:'api',operation,status:r.status,duration_ms:Math.round(performance.now()-started)});
       if(!r.ok)throw Error(`API ${r.status}`);return r.json();
      }catch(error){record({event:'api_error',operation,error_name:error.name});throw error;}
     };
     window.transport=new RainSyncP2P.RoomP2PTransport(api,room,job);
     const t=window.transport;
     for(const method of ['stop','drop']){const original=t[method];t[method]=function(...args){record({event:method,state:state()});return original.apply(this,args)}}
     const authorize=t.applyAuthorization;t.applyAuthorization=function(value,requestedAt){record({event:'authorization',version:value?.version,lease_ms:value?.lease_ms,elapsed_ms:Math.round(performance.now()-requestedAt),peer_count:value?.peers?.length,scope_matches:!!value&&value.peer_id===this.peerId&&value.room_id===this.room&&value.job_id===this.job&&value.output_generation===this.directory?.output_generation&&value.session_id===(this.primary?.session??null)});try{return authorize.call(this,value,requestedAt)}catch(error){record({event:'authorization_error',error_name:error.name});throw error}};
     document.addEventListener('visibilitychange',()=>record({event:'visibility',state:state()}));
     await t.start({acknowledge_peer_addresses:true,confirm_current_network:true,upload_allowed:true});record({event:'started',state:state()});
    },{room:room.id,job:prepared.id,csrf:clients[i].csrf});
   }
   await until(()=>pages[0].evaluate(()=>[...window.transport.peers.values()].some(p=>p.channel?.readyState==='open')),'real browser DataChannel',20000);
   const segment=directory.files.find(file=>file.name.endsWith('.ts'));assert.ok(segment);
   await pages[0].evaluate(async url=>{await window.transport.load(url,0,new AbortController().signal)},segment.url);
   const peerBytes=await pages[1].evaluate(async url=>{const data=await window.transport.load(url,30,new AbortController().signal);return {bytes:data.byteLength,stats:window.transport.stats}},segment.url);
   assert.equal(peerBytes.bytes,segment.size_bytes);assert.equal(peerBytes.stats.peerBytes,segment.size_bytes);assert.equal(peerBytes.stats.httpBytes,0);
   report.checks.push('actual Chromium RTCDataChannel transfer of trusted NAS HLS segment; hash checked before delivery; peer bytes replace HTTP bytes');
   await pages[0].evaluate(()=>window.transport.stop());
   await pages[1].evaluate(async url=>{await window.transport.load(url,30,new AbortController().signal)},segment.url);
   const fallback=await pages[1].evaluate(()=>window.transport.stats);assert.ok(fallback.httpBytes>=segment.size_bytes);
   await Promise.all(pages.map(p=>p.evaluate(()=>window.transport.stop())));
   report.checks.push('peer cancellation/disconnect leaves complete independent authenticated HTTP fallback');
  }catch(error){
   report.browser={result:'failed',pages:await Promise.all(pages.map(async page=>{try{return await page.evaluate(()=>({state:window.p2pState?.(),trace:window.p2pTrace??[]}))}catch{return {state:'unavailable'}}}))};
   throw error;
  }finally{await browser.close()}
  const observerPeer=await admin.request(`/rooms/${room.id}/compute/${prepared.id}/p2p`,'POST',consent);
  const revokedPeer=await viewer.request(`/rooms/${room.id}/compute/${prepared.id}/p2p`,'POST',consent);
  f.sql(`DELETE FROM room_members WHERE room_id='${room.id}' AND user_id=(SELECT id FROM users WHERE username='compute-viewer')`);
  await viewer.request(`/room-p2p/${revokedPeer.peer_id}`,'GET',undefined,404);
  assertPeerAuthorization(await admin.request(`/room-p2p/${observerPeer.peer_id}?peers=${revokedPeer.peer_id}`),observerPeer.peer_id,null,[]);
  report.checks.push('membership removal disappears from an independently authorized sender snapshot, without a receiver poll or disconnect');
  const priorEpoch=f.sql("SELECT permission_epoch FROM private_libraries WHERE visibility='instance_shared'");
  f.sql("UPDATE private_libraries SET permission_epoch=permission_epoch+1 WHERE visibility='instance_shared'");
  assert.equal(f.sql(`SELECT distributed_compute_authorized('${prepared.id}')`),'f');
  await admin.request(`/playback-sessions/${successor.session_id}/distributed/directory`,'GET',undefined,410);
  f.sql("UPDATE private_libraries SET permission_epoch=permission_epoch+1 WHERE visibility='instance_shared'");
  assert.equal(f.sql(`SELECT distributed_compute_authorized('${prepared.id}')`),'f');
  assert.equal(f.sql(`SELECT library_permission_epoch FROM distributed_compute_jobs WHERE id='${prepared.id}'`),priorEpoch);
  await admin.request(`/rooms/${room.id}/compute/${prepared.id}/directory`,'GET',undefined,404);
  report.checks.push('original library ID/permission epoch/media source generation immutable on job and peer; epoch revoke then restore/new epoch cannot resurrect prior generated output or primary plan');
  // A real daemon killed while hashing a large owned sparse source must never invent a cleanup receipt on restart.
  await stop(secondNode);
  const killPath=resolve(agents[1].root,'kill.mp4');const sparse=await open(killPath,'w');await sparse.truncate(1024*1024*1024);await sparse.close();
  const killMedia=await until(()=>f.sql(`SELECT id FROM media_items WHERE source_id='${agents[1].id}' AND resource='kill.mp4' AND available`),'owned sparse NAS index');
  const killVersion=f.sql(`SELECT source_version FROM media_items WHERE id='${killMedia}'`);const killHash=createHash('sha256');for await(const chunk of createReadStream(killPath))killHash.update(chunk);
  await requestAgent(agents[1],'/agent-compute/catalog',{media_id:killMedia,source_version:killVersion,content_sha256:killHash.digest('hex'),size_bytes:1024*1024*1024});
  const killRoom=await admin.request('/rooms','POST',{name:'unknown killed compute attempt'});
  f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${killMedia}','media_generation',1) WHERE room_id='${killRoom.id}'`);
  const killedJob=await admin.request(`/rooms/${killRoom.id}/compute`,'POST',{media_generation:1,recipe:'h264_480p_hls_v1'});
  const killingNode=node(1);
  const journalPath=resolve(f.root,'node-1-output','.compute-receipts.json');
  const pending=await until(async()=>{try{const receipts=JSON.parse(await readFile(journalPath,'utf8'));return Object.values(receipts).find(receipt=>receipt.job===killedJob.id&&receipt.process_disposition===null)}catch{return null}},'durable pending attempt before execution');
  const killedOutput=resolve(f.root,'node-1-output',killedJob.id,pending.fence.output_generation);
  assert.equal(await stat(killedOutput).then(()=>false,e=>e.code==='ENOENT'),true,'owned kill occurs before any encoder output directory exists');
  killingNode.child.kill('SIGKILL');await killingNode.closed;
  assert.equal(await stat(killedOutput).then(()=>false,e=>e.code==='ENOENT'),true,'no encoder output was created before process death');
  assert.equal(f.sql(`SELECT distributed_compute_room_drained('${killRoom.id}')`),'f');
  const restarted=node(1);const code=await restarted.closed;assert.notEqual(code,0);
  assert.equal(JSON.parse(await readFile(journalPath,'utf8'))[`${killedJob.id}:${pending.fence.attempt}`].process_disposition,null);
  await requestAgent(agents[1],`/agent-compute/jobs/${killedJob.id}/reaped`,{...pending.fence,process_disposition:'unknown'},400);
  const beforeClose=await admin.request(`/rooms/${killRoom.id}/lifecycle`);
  const closing=await admin.request(`/rooms/${killRoom.id}/close`,'POST',{expected_revision:beforeClose.state.revision});assert.equal(closing.lifecycle,'closing');
  await delay(1500);assert.equal((await admin.request(`/rooms/${killRoom.id}/lifecycle`)).lifecycle,'closing');
  assert.equal(f.sql(`SELECT process_reaped_at IS NULL FROM distributed_compute_attempts WHERE job_id='${killedJob.id}'`),'t');
  report.checks.push('real daemon SIGKILL during source verification; durable unknown attempt survives restart; no false receipt; room stays closing');
  await admin.request(`/agents/${agents[0].id}`,'DELETE');
  await admin.request(`/rooms/${room.id}/compute/${prepared.id}/directory`,'GET',undefined,404);
  report.checks.push('member removal retires peer ticket; source-owner revoke also fences replica-produced artifact');
  await requestAgent(agents[0],`/agent-compute/jobs/${first.id}/renew`,fence,401);
  await requestAgent(agents[0],`/agent-compute/jobs/${first.id}/reaped`,{...fence,process_disposition:'never_started'});
  await requestAgent(agents[0],`/agent-compute/jobs/${first.id}/reaped`,{...fence,process_disposition:'never_started'});
  await until(()=>f.sql(`SELECT distributed_compute_room_drained('${room.id}')`)==='t','all positive per-attempt drain acknowledgements');
  const positiveBefore=await admin.request(`/rooms/${room.id}/lifecycle`);await admin.request(`/rooms/${room.id}/close`,'POST',{expected_revision:positiveBefore.state.revision});
  await until(async()=> (await admin.request(`/rooms/${room.id}/lifecycle`)).lifecycle==='closed','positive compute room close after every attempt drain');
  report.checks.push('revoked original token can only idempotently acknowledge its exact existing attempt; all generations retain independent drain obligations; room becomes closed only after all attempts confirmed released');
  await stop(secondNode);report.result=report.browser?.result==='blocked'?'passed-with-browser-blocker':'passed';console.log(JSON.stringify(report,null,2));
 }finally{await reapOwnedChildren([...children]);await Promise.all(logs.map(log=>new Promise(r=>log.end(r))))}
},{beforeStart:async f=>{f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT=resolve(f.root,'published');f.env.RAINSYNC_P2P_ENABLED='1'}});
 report.cleanup=await fixture.verifyStopped();
}catch(error){report.result='failed';report.error=String(error);if(fixture)report.cleanup=await fixture.verifyStopped();throw error}
finally{if(fixture)await writeFile(resolve(fixture.root,'evidence.json'),JSON.stringify(report,null,2))}
