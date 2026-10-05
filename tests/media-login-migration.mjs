// Owned PostgreSQL upgrade; seeded legacy rows are not historical identity proof.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isolatedPostgres} from './fixtures/postgres.mjs';
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const id=randomUUID(),root=resolve(process.env.RAINSYNC_ARTIFACT_DIR,'media-login-migration',id);
await mkdir(root,{recursive:true});
const db=isolatedPostgres({root,name:'media-login-migration',id});
const q=v=>`'${String(v).replaceAll("'","''")}'`, sha=v=>createHash('sha256').update(v).digest('hex');
const user=randomUUID(),room=randomUUID(),source=randomUUID(),media=randomUUID(),old=randomUUID(),oldKey=randomUUID(),epoch=randomUUID();
const loginA=sha('owned A '+id),loginB=sha('owned B '+id), fresh=randomUUID(),key=randomUUID();
const report={result:'running',scope:'disposable owned PostgreSQL; explicit pre-0041 fixtures; no product/API acceptance',checks:[],migrations:[]};
const check=(name,fn)=>{fn();report.checks.push(name);console.log('PASS: '+name)};
let failure;
try {
 await db.start();
 for(const name of (await readdir('migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&Number(n.slice(0,4))<41).sort()) {
  const bytes=await readFile('migrations/'+name);db.sql(`BEGIN;${bytes};COMMIT;`);report.migrations.push({name,sha256:sha(bytes)});
 }
 db.sql(`INSERT INTO users(id,username,password_hash) VALUES(${q(user)},'owned-login-migration','not-for-login');
 INSERT INTO sessions VALUES(${q(loginA)},${q(user)},'owned csrf A',clock_timestamp()+interval '1 hour'),(${q(loginB)},${q(user)},'owned csrf B',clock_timestamp()+interval '1 hour');
 INSERT INTO rooms(id,name,owner_id) VALUES(${q(room)},'owned migration',${q(user)});
 INSERT INTO room_members(room_id,user_id) VALUES(${q(room)},${q(user)});
 INSERT INTO sources(id,name,kind,config_encrypted) VALUES(${q(source)},'owned HTTP','http','unchanged-ciphertext');
 INSERT INTO media_items(id,source_id,title,resource,metadata) VALUES(${q(media)},${q(source)},'owned media','fixture.mp4','{}');
 INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${q(old)},${q(user)},${q(room)},${q(media)},1,'owned-old-ticket','{"encrypted":"old-ciphertext","source_policy_revision":0}',clock_timestamp()+interval '1 hour');
 INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,response_encrypted,lease_until,expires_at,room_id) VALUES(${q(user)},${q(oldKey)},'old-digest',${q(old)},${q(epoch)},'completed','old-response',clock_timestamp(),clock_timestamp()+interval '48 hours',${q(room)});`);
 const before=db.sql(`SELECT jsonb_build_object('grant',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(old)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(old)}),'logins',(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM sessions s))`);
 const bytes=await readFile('migrations/0041_media_login_binding.sql');
 db.sql(`BEGIN;${bytes};ROLLBACK;`);
 check('migration rollback does not alter legacy data or schema',()=>assert.equal(db.sql(`SELECT jsonb_build_object('grant',(SELECT to_jsonb(p) FROM playback_sessions p WHERE id=${q(old)}),'request',(SELECT to_jsonb(r) FROM playback_requests r WHERE session_id=${q(old)}),'logins',(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM sessions s))`),before));
 db.sql(`BEGIN;${bytes};COMMIT;`);report.migrations.push({name:'0041_media_login_binding.sql',sha256:sha(bytes)});
 check('upgrade preserves every legacy value including exact expiry and sessions layout',()=>assert.equal(db.sql(`SELECT jsonb_build_object('grant',(SELECT to_jsonb(p)-ARRAY['auth_login_hash','auth_membership_epoch'] FROM playback_sessions p WHERE id=${q(old)}),'request',(SELECT to_jsonb(r)-ARRAY['auth_login_hash','auth_membership_epoch'] FROM playback_requests r WHERE session_id=${q(old)}),'logins',(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM sessions s))`),before));
 check('legacy origin remains NULL and source gate stays usable before expiry',()=>assert.equal(db.sql(`SELECT auth_login_hash IS NULL AND playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=${q(old)}`),'t'));
 check('legacy expiry cannot be extended by old SQL writer',()=>assert.throws(()=>db.sql(`UPDATE playback_sessions SET expires_at=expires_at+interval '1 second' WHERE id=${q(old)}`),/legacy_playback_session_not_renewable/));
 check('legacy request cannot mint a new attempt session',()=>assert.throws(()=>db.sql(`UPDATE playback_requests SET session_id=${q(randomUUID())} WHERE session_id=${q(old)}`),/legacy_playback_request_requires_fresh_key/));
 check('old writer cannot insert new unbound request',()=>assert.throws(()=>db.sql(`INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at) VALUES(${q(user)},${q(randomUUID())},'old-writer',${q(randomUUID())},${q(epoch)},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 hour')`),/media_login_binding_required/));
 const membership=db.sql(`SELECT membership_epoch FROM room_members WHERE room_id=${q(room)} AND user_id=${q(user)}`);
 db.sql(`INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,auth_login_hash,auth_membership_epoch) VALUES(${q(user)},${q(key)},'fresh',${q(fresh)},${q(epoch)},'pending',clock_timestamp()+interval '1 minute',clock_timestamp()+interval '48 hours',${q(room)},${q(loginA)},${q(membership)});
 INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES(${q(fresh)},${q(user)},${q(room)},${q(media)},1,'owned-fresh-ticket','{"encrypted":"new-ciphertext","source_policy_revision":0}',clock_timestamp()+interval '30 minutes');`);
 check('provisional/final origin is inherited from exact admitted request',()=>assert.equal(db.sql(`SELECT auth_login_hash=${q(loginA)} AND resource->'auth_context'->>'login_hash'=${q(loginA)} AND auth_membership_epoch=${q(membership)} FROM playback_sessions WHERE id=${q(fresh)}`),'t'));
 check('same-account caller B cannot use A grant while both logins are live',()=>assert.equal(db.sql(`SELECT playback_caller_allowed(resource,user_id,${q(loginB)}) FROM playback_sessions WHERE id=${q(fresh)}`),'f'));
 for(const table of ['playback_requests','playback_sessions']) check(table+' cannot drop/reassign bound origin',()=>assert.throws(()=>db.sql(`UPDATE ${table} SET auth_login_hash=NULL WHERE ${table==='playback_sessions'?'id':'session_id'}=${q(fresh)}`),/media_login_origin_immutable/));
 db.sql(`UPDATE playback_sessions SET resource=resource-'auth_context' WHERE id=${q(fresh)}`);
 check('resource replacement cannot erase the restriction',()=>assert.equal(db.sql(`SELECT resource->'auth_context'->>'login_hash'=${q(loginA)} FROM playback_sessions WHERE id=${q(fresh)}`),'t'));
 check('explicit malformed context fails closed',()=>assert.throws(()=>db.sql(`UPDATE playback_sessions SET resource=jsonb_set(resource,'{auth_context}','null') WHERE id=${q(fresh)}`),/media_login_origin_immutable/));
 db.sql(`DELETE FROM sessions WHERE token_hash=${q(loginA)}`);
 check('logout A revokes A bound grant while B and legacy origin remain unchanged',()=>assert.equal(db.sql(`SELECT NOT playback_source_allowed(media_id,resource) AND auth_login_hash=${q(loginA)} AND playback_login_allowed(user_id,${q(loginB)}) FROM playback_sessions WHERE id=${q(fresh)}`),'t'));
 check('legacy expiry stays unchanged after logout of an unknowable origin',()=>assert.equal(db.sql(`SELECT expires_at=${q(JSON.parse(before).grant.expires_at)}::timestamptz FROM playback_sessions WHERE id=${q(old)}`),'t'));
 report.result='passed';
} catch(error){failure=error;report.result='failed';report.error=String(error.stack??error)}
finally {await db.stop();report.cleanup=await db.verifyStopped();report.finished_at=new Date().toISOString();await writeFile(resolve(root,'report.json'),JSON.stringify(report,null,2)+'\n')}
console.log(resolve(root,'report.json'));if(failure)throw failure;
