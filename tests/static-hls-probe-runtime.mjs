// Explicit current-admin diagnostic against owned actual old/new Workers only.
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {isolatedMediaStack} from './fixtures/media-stack.mjs';
import {verifyPidAbsent,verifyClosedPort} from './fixtures/postgres.mjs';
import {delay} from './fixtures/server.mjs';
for(const key of ['RAINSYNC_ARTIFACT_DIR','RAINSYNC_NATIVE_POSTGRES_BIN','RAINSYNC_STATIC_OLD_BINDING','CARGO_TARGET_DIR'])assert.ok(process.env[key],key);
const old=JSON.parse(await readFile(process.env.RAINSYNC_STATIC_OLD_BINDING,'utf8'));
const oldWorker=old.binaries.find(b=>b.name==='rainsync-media-worker');
const sha=b=>createHash('sha256').update(b).digest('hex');assert.equal(sha(await readFile(oldWorker.path)),oldWorker.sha256);
const root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'static-hls-probe-runtime',randomUUID());await mkdir(root,{recursive:true});
const report={result:'running',scope:'owned actual Worker compatibility, current-admin gates and fresh DB/cache proof; admission always disabled; no real account/role/deployment',checks:[],old_worker:oldWorker};
const check=name=>{report.checks.push(name);console.log('PASS: '+name)};
let fixture,failure,ownedOld,oldDone,oldLog,peer,peerPort;
const stopOld=async()=>{
 if(!ownedOld)return;
 if(ownedOld.exitCode===null&&ownedOld.signalCode===null)ownedOld.kill();await oldDone;
 assert.ok(verifyPidAbsent(ownedOld.pid));assert.equal(await verifyClosedPort(Number(new URL(fixture.workerOrigin).port)),true);
 report.old_worker_cleanup={close_observed:true,pid:ownedOld.pid,pid_absent:true,port_closed:true};
 await new Promise(done=>oldLog.end(done));ownedOld=null;
};
try{
 await isolatedMediaStack('static-hls-probe-runtime',async f=>{
  fixture=f;const client=f.client();await client.login();
  const migration=await readFile('migrations/0043_static_hls_foundation.sql');
  assert.equal(f.sql("SELECT encode(checksum,'hex') FROM _sqlx_migrations WHERE version=43"),createHash('sha384').update(migration).digest('hex'),'actual Server embedded migration matches current0043');
  report.migration={sha256:sha(migration),embedded_checksum_matches:true};
  for(const name of ['rainsync-server','rainsync-media-worker']){const path=resolve(f.target,name);(report.new_binaries??=[]).push({name,path,sha256:sha(await readFile(path))})}
  await f.startServer({WORKER_URL:f.workerOrigin});
  const route='/deployment/static-hls-contract';
  await f.client().request(route,'POST',undefined,401);
  await client.request(route,'POST',undefined,403,{'x-csrf-token':'wrong'});
  await client.request(route,'POST',undefined,403,{Origin:'http://untrusted.invalid'});
  await client.request(route,'POST',{url:'http://untrusted.invalid'},400);
  const viewerName='owned_probe_'+randomUUID().replaceAll('-','');
  f.sql(`INSERT INTO users(id,username,password_hash,admin) SELECT '${randomUUID()}','${viewerName}',password_hash,false FROM users WHERE username='admin'`);
  const viewer=f.client();await viewer.login(viewerName);await viewer.request(route,'POST',undefined,403);
  check('explicitPOST requires exact live login/current-admin/Origin/CSRF and accepts no caller URL');
  oldLog=createWriteStream(resolve(f.root,'old-worker-probe.log'));
  ownedOld=spawn(oldWorker.path,[],{env:{...f.env,WORKER_BIND:new URL(f.workerOrigin).host,PUBLIC_ORIGIN:f.workerOrigin},stdio:['ignore','pipe','pipe']});
  ownedOld.stdout.pipe(oldLog,{end:false});ownedOld.stderr.pipe(oldLog,{end:false});oldDone=new Promise(done=>ownedOld.once('close',done));
  for(let i=0;i<100;i++){if(ownedOld.exitCode!==null)throw Error('owned old Worker exited');try{if((await fetch(f.workerOrigin+'/health')).ok)break}catch{}await delay(50)}
  const refused=await client.request(route,'POST');assert.deepEqual(refused,{compatible:false,admission:'disabled',drain:'unknown'});
  check('actual old WORKER_URL endpoint keeps gate off despite nearby new executables');
  await stopOld();await f.startWorker();
  const matched=await client.request(route,'POST');assert.deepEqual(matched,{compatible:true,admission:'disabled',drain:'unknown'});
  assert.equal(f.sql('SELECT probe_challenge IS NULL AND probe_sha256 IS NULL AND probe_until IS NULL FROM static_hls_database_binding'),'t');
  assert.equal((await readdir(f.env.CACHE_ROOT)).some(v=>v.startsWith('.static-hls-probe-')),false);
  check('actual new Worker reads fresh same DB/cache challenge; positive compatibility still has admission disabled and unknown drain');
  await f.stopWorker();await f.startWorker({CACHE_ROOT:resolve(f.root,'different-cache')});
  assert.deepEqual(await client.request(route,'POST'),{compatible:false,admission:'disabled',drain:'unknown'});
  check('actual new Worker with different configured cache remains incompatible');
  await f.stopWorker();
  const database=f.postgresDiagnostics(),other=database.database+'_probe_clone';f.sql(`CREATE DATABASE ${other}`);
  const psql=resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN,'psql');
  const queryOther=sql=>execFileSync(psql,['-X','-w','-h','127.0.0.1','-p',String(database.port),'-U','rainsync','-d',other,'-At','-v','ON_ERROR_STOP=1','-c',sql],{env:{...process.env,PGPASSWORD:f.password},encoding:'utf8',timeout:20000}).trim();
  for(const name of(await readdir('migrations')).filter(v=>/^\d+_.+\.sql$/.test(v)).sort())queryOther(`BEGIN;${await readFile('migrations/'+name,'utf8')};COMMIT;`);
  const dbIdentity=f.sql('SELECT id FROM static_hls_database_binding');queryOther(`UPDATE static_hls_database_binding SET id='${dbIdentity}'`);
  const otherURL=new URL(f.env.DATABASE_URL);otherURL.pathname='/'+other;
  await f.startWorker({DATABASE_URL:otherURL.toString()});
  assert.deepEqual(await client.request(route,'POST'),{compatible:false,admission:'disabled',drain:'unknown'});
  check('cloned persistent DB UUID and same cache cannot substitute for fresh actual database proof');
  await f.stopWorker();
  const key=Buffer.from(f.env.SOURCE_ENCRYPTION_KEY,'base64');
  const unseal=text=>{const b=Buffer.from(text,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString())};
  const seal=value=>{const n=randomBytes(12),c=createCipheriv('aes-256-gcm',key,n),b=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([n,b,c.getAuthTag()]).toString('base64')};
  let mode='replay',cached,started,release;
  peer=createServer(async(req,res)=>{
   try{let body='';for await(const chunk of req)body+=chunk;const request=unseal(body);
    const path=resolve(f.env.CACHE_ROOT,'.static-hls-probe-'+request.challenge),bytes=await readFile(path);
    const response=seal({purpose:'rainsync-static-hls-contract-response-v1',contract:{version:1,instance:randomUUID(),database:dbIdentity,cache_identity:sha(bytes),challenge:request.challenge}});
    if(mode==='replace'){await rename(path,path+'.original');await writeFile(path,Buffer.alloc(64,99));report.replaced_file=path}
    if(mode==='late'){started();await new Promise(done=>release=done)}
    res.end(mode==='replay'&&cached?cached:response);cached=response;
   }catch(e){res.statusCode=503;res.end('owned peer refused')}
  });
  await new Promise(done=>peer.listen(0,'127.0.0.1',done));peerPort=peer.address().port;await f.startServer({WORKER_URL:'http://127.0.0.1:'+peerPort});
  assert.equal((await client.request(route,'POST')).compatible,true);
  assert.deepEqual(await client.request(route,'POST'),{compatible:false,admission:'disabled',drain:'unknown'});
  check('a stale authenticated prior-instance/challenge response cannot keep compatibility or admission on');
  mode='replace';assert.deepEqual(await client.request(route,'POST'),{compatible:false,admission:'disabled',drain:'unknown'});
  assert.deepEqual(await readFile(report.replaced_file),Buffer.alloc(64,99));
  check('late basename replacement is preserved and produces cleanup_unknown/incompatible');
  mode='late';const began=new Promise(done=>started=done);const pending=client.raw(route,{method:'POST'});await began;await client.request('/auth/logout','POST');release();
  const revoked=await pending;assert.equal(revoked.status,401);await revoked.arrayBuffer();
  check('late network completion rechecks original exact login and withholds diagnostic after logout');
  await new Promise(done=>peer.close(done));peer=null;
  report.peer_cleanup={closed:true,port_closed:await verifyClosedPort(peerPort)};
 },{env:{WORKER_URL:'http://127.0.0.1:9'}});
 report.cleanup=await fixture.verifyStopped();report.result='passed';
}catch(e){failure=e;report.result='failed';report.error=String(e.stack??e)}
finally{try{await stopOld()}catch(e){report.old_cleanup_error=String(e)}if(peer){peer.closeAllConnections();await new Promise(done=>peer.close(done));peer=null}if(fixture)try{report.cleanup=await fixture.verifyStopped()}catch(e){report.cleanup_error=String(e)}report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
