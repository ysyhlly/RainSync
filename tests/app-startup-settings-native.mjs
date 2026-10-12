// Real original Server startup; synthetic owned PG, no API settings projection.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServer } from './fixtures/server.mjs';
import { withTerminationSignal } from '../deploy/owned-process.mjs';
import { loadOwnerBinding, sha256 } from '../scripts/native-owner-binding.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.env.DATABASE_URL, undefined);
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN);
assert.equal(process.env.RAINSYNC_FIXTURE_CLEANUP_REPORT, '1');
const binding = await loadOwnerBinding({ root: repo, target: process.env.CARGO_TARGET_DIR, path: process.env.W03_BACKEND_BINDING });
const inputs = ['tests/app-startup-settings-native.mjs','tests/fixtures/server.mjs','tests/fixtures/postgres.mjs','tests/fixtures/unused-port.mjs','scripts/native-owner-binding.mjs','deploy/owned-process.mjs'];
const snapshot = () => Promise.all(inputs.map(async path => ({path, sha256:sha256(await readFile(resolve(repo,path)))})));
const before = await snapshot();
const names = ['RAINSYNC_YTDLP_BIN','RAINSYNC_YTDLP_DENO_BIN','RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES','RAINSYNC_OTHER_LIVE_ENABLED','TRUSTED_PROXY_CIDRS','ACCOUNT_HASH_CONCURRENCY','REGISTRATION_VALIDATE_PER_MINUTE','REGISTRATION_PER_TEN_MINUTES','AVATAR_PROCESS_CONCURRENCY','AVATAR_PROCESS_TIMEOUT_MS','AVATAR_WRITES_PER_MINUTE','AVATAR_FFMPEG_BIN','PLAYBACK_SESSION_LIMIT','MEDIA_QUEUE_LIMIT','MEDIA_PREVIEW_CONCURRENCY','MEDIA_PREVIEW_TIMEOUT_SECONDS','MEDIA_PREVIEW_CACHE_BYTES','MEDIA_PREVIEW_QUEUE_LIMIT','MEDIA_PREVIEW_INPUT_BYTES'];
for (const provider of ['DOUYIN','TIKTOK']) for (const suffix of ['APPLICATION_APPROVED','CLIENT_KEY','CLIENT_SECRET_FILE','REDIRECT_URI','IDENTITY_SCOPE_APPROVED','QR_APPROVED']) names.push(`${provider}_${suffix}`);
const matrix = [
 {name:'defaults',env:{}},
 {name:'legal',env:{RAINSYNC_OTHER_LIVE_ENABLED:'0',RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES:'0',ACCOUNT_HASH_CONCURRENCY:'1',AVATAR_PROCESS_CONCURRENCY:'1',AVATAR_PROCESS_TIMEOUT_MS:'100',PLAYBACK_SESSION_LIMIT:'3',MEDIA_QUEUE_LIMIT:'4',MEDIA_PREVIEW_CONCURRENCY:'2'}},
 {name:'youtube_before_other_live',env:{RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES:'bad',RAINSYNC_OTHER_LIVE_ENABLED:'bad'},error:'RAINSYNC_YTDLP_ALLOW_VIEWER_COOKIES must be 0 or 1'},
 {name:'other_live_before_security',env:{RAINSYNC_OTHER_LIVE_ENABLED:'bad',ACCOUNT_HASH_CONCURRENCY:'0'},error:'RAINSYNC_OTHER_LIVE_ENABLED must be 0 or 1'},
 {name:'security_before_avatar',env:{ACCOUNT_HASH_CONCURRENCY:'33',AVATAR_PROCESS_CONCURRENCY:'9'},error:'ACCOUNT_HASH_CONCURRENCY must be between 1 and 32'},
 {name:'avatar_before_session',env:{AVATAR_PROCESS_CONCURRENCY:'9',PLAYBACK_SESSION_LIMIT:'0'},error:'AVATAR_PROCESS_CONCURRENCY must be between 1 and 8'},
 {name:'session_before_queue',env:{PLAYBACK_SESSION_LIMIT:'0',MEDIA_QUEUE_LIMIT:'0'},error:'invalid PLAYBACK_SESSION_LIMIT'},
 {name:'queue_before_preview',env:{MEDIA_QUEUE_LIMIT:'0',MEDIA_PREVIEW_CONCURRENCY:'0'},error:'invalid MEDIA_QUEUE_LIMIT'},
 {name:'late_preview_failure',env:{MEDIA_PREVIEW_INPUT_BYTES:'0'},error:'invalid MEDIA_PREVIEW_INPUT_BYTES'},
];
await withTerminationSignal(async signal => {
 const deadline = new AbortController(); const timer = setTimeout(()=>deadline.abort(Error('startup_matrix_timeout')),180000);
 const ownedSignal = AbortSignal.any([signal,deadline.signal]);
 try { for (const item of matrix) {
  await binding.verify(); let fixture, error, failed=false, afterStartup, states=[], actualBinary;
  try { await isolatedServer(`app-startup-${item.name}`, async f => { assert.ok(!item.error); assert.ok((await fetch(f.origin+'/health')).ok); }, {
   binary:binding.server, signal:ownedSignal,
   observeServerLog(log,path) { const state={path,finish:false,close:false,error:false};states.push(state);log.on('finish',()=>state.finish=true);log.on('close',()=>state.close=true);log.on('error',()=>state.error=true); },
   beforeStart:async f => {
    fixture=f; await mkdir(resolve(f.root,'private'),{mode:0o700});
    for (const name of names) delete f.env[name]; Object.assign(f.env,item.env);
    const observe=()=>{ const tables=JSON.parse(f.sql("SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'")); const rows={}; for(const table of tables) { assert.match(table,/^[a-zA-Z0-9_]+$/); rows[table]=JSON.parse(f.sql(`SELECT COALESCE(json_agg(r ORDER BY r::text),'[]'::json) FROM (SELECT to_jsonb(t) r FROM "${table}" t) q`)); } return rows; };
    await writeFile(resolve(f.root,'private/before.json'),JSON.stringify(observe(),null,2)+'\n',{flag:'wx',mode:0o600});
    const original=f.startServer.bind(f); f.startServer=async(...args)=>{let result,failed=false,failure;const witness = setInterval(()=>{const pid=f.serverPid;if(pid&&!actualBinary) actualBinary={pid,promise:(async()=>({pid,path:await readlink(`/proc/${pid}/exe`),sha256:sha256(await readFile(`/proc/${pid}/exe`))}))().catch(()=>({pid,witness_failed:true}))};},10);try{result=await original(...args);}catch(e){failed=true;failure=e;}finally{clearInterval(witness);}if(actualBinary)actualBinary=await actualBinary.promise;try{afterStartup=observe();await writeFile(resolve(f.root,'private/after-startup.json'),JSON.stringify(afterStartup,null,2)+'\n',{flag:'wx',mode:0o600});}catch(e){throw new AggregateError([...(failed?[failure]:[]),e],'startup_observation_failed');}if(failed)throw failure;return result;};
   }
  }); } catch(e) {failed=true;error=e;}
  assert.ok(fixture,'setup must yield actual owned fixture');
  const cleanup=await fixture.verifyStopped();assert.ok(actualBinary,'actual /proc executable witness required');assert.equal(actualBinary.path,binding.server);assert.equal(actualBinary.sha256,binding.summary.binaries.find(x=>x.name==='rainsync-server').sha256);
  for(const state of states) {assert.ok(state.finish&&state.close&&!state.error);state.sha256=sha256(await readFile(state.path));}
  if(item.error) {assert.ok(failed);assert.ok((await readFile(states[0].path,'utf8')).includes(item.error));assert.equal(cleanup.servers[0].exit_code,1);} else {if(failed)throw error;assert.equal(cleanup.servers[0].exit_code,0);}
  assert.ok(afterStartup.users.length===1,'admin insert precedes App assembly even on late config failure');
  await binding.verify();assert.deepEqual(await snapshot(),before);
  await writeFile(resolve(fixture.root,'startup-evidence.json'),JSON.stringify({case:item.name,result:'passed',expected_startup_failure:!!item.error,binding:binding.summary,actual_binary:actualBinary,inputs:before,cleanup,logs:states,scope:'Actual Server startup and full public-table private snapshots; no claim internal owner destruction or config field values from /health'},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`PASS: original App startup ${item.name}`);
 } } finally {clearTimeout(timer);}
});
