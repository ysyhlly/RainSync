// Actual HTTP/SQL on an owned loopback PostgreSQL + Server fixture only.
// Uses a tiny synthetic local clip; never touches a deployment or existing DB.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedMediaStack } from './fixtures/media-stack.mjs';
import { delay } from './fixtures/server.mjs';

const fields = ['playback_session_limit', 'media_queue_limit', 'registration_validate_per_minute', 'registration_per_ten_minutes'];
const report = { result: 'running', checks: [] };
let fixture;
const hash = value => createHash('sha256').update(value).digest('hex');
const loginHash = client => hash(client.cookie.split('=')[1]);
async function hold(f, sql) {
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stdin.write(`BEGIN; ${sql}; SELECT 'settings-lock-held';\n`);
  const deadline = Date.now() + 10000;
  while (!output.includes('settings-lock-held')) {
    if (Date.now() > deadline) throw Error('owned lock was not acquired');
    await delay(20);
  }
  return async extra => { child.stdin.end(`${extra ?? ''}; COMMIT;\n`); await child.done; };
}
async function blocked(f, contains) {
  await f.waitForSql(`SELECT count(*)>0 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%${contains}%'`, 't');
}
try {
  await isolatedMediaStack('admin-settings', async f => {
    fixture = f;
    const admin = f.client();
    const me = await admin.login();
    const path = '/admin/settings';
    const guestPolicy = () => f.client().request('/auth/registration-policy');
    let detail = await admin.request(path);
    assert.equal(detail.revision, '1');
    assert.equal(detail.updated_at, null);
    assert.deepEqual(detail.values, detail.defaults);
    assert.deepEqual(fields.map(k => detail.defaults[k]), [8, 7, 8, 9]);
    assert.deepEqual(fields.map(k => detail.overrides[k]), [null, null, null, null]);
    assert.deepEqual(fields.map(k => detail.origins[k]), Array(4).fill('deployment'));
    assert.match((await admin.raw(path)).headers.get('cache-control'), /no-store/);
    assert.doesNotMatch(JSON.stringify(detail), /SOURCE_ENCRYPTION_KEY|DATABASE_URL|PUBLIC_ORIGIN|MEDIA_ROOT|secret|postgres:|password|token|\/workspace|\/tmp/);
    assert.equal(detail.values.registration_mode, 'invite_only');
    assert.equal(detail.values.guests_enabled, false);
    assert.deepEqual(await guestPolicy(), {registration_mode:'invite_only',guests_enabled:false});
    assert.deepEqual(Object.keys(detail).sort(), ['bounds','defaults','deployment','origins','overrides','revision','updated_at','values']);
    report.checks.push('initial settings preserve actual deployment defaults; allowlisted projection contains no secret/path/config dump and is no-store');

    const guest = f.client();
    await guest.request(path, 'GET', undefined, 401);
    await guest.request(path, 'PATCH', { expected_revision: '1', changes: {media_queue_limit:2} }, 401);
    await admin.request('/users', 'POST', {username:'settings-viewer',password:f.password});
    const viewer = f.client(); const person = await viewer.login('settings-viewer');
    await viewer.request(path, 'GET', undefined, 403);
    await viewer.request(path, 'PATCH', {expected_revision:'1',changes:{media_queue_limit:2}}, 403);
    await admin.request(path, 'PATCH', {expected_revision:'1',changes:{media_queue_limit:2}}, 403, {'x-csrf-token':''});
    await admin.request(path, 'PATCH', {expected_revision:'1',changes:{media_queue_limit:2}}, 403, {Origin:'https://foreign.invalid'});
    for (const changes of [{}, {database_url:'no'}, {media_queue_limit:0}, {media_queue_limit:10001}, {media_queue_limit:'2'}, {media_queue_limit:1.5}, {media_queue_limit:true}, {media_queue_limit:2,private_libraries_enabled:true}, {registration_mode:'anonymous'}, {registration_mode:true}, {guests_enabled:'true'}, {guests_enabled:1}]) {
      assert.equal((await admin.request(path,'PATCH',{expected_revision:'1',changes},400)).error.code,'INVALID_ADMIN_SETTINGS');
    }
    for (const expected_revision of ['01','0','-1','1.0','9223372036854775808']) await admin.request(path,'PATCH',{expected_revision,changes:{media_queue_limit:2}},400);
    assert.equal((await admin.request(path)).revision,'1');
    report.checks.push('login/admin/origin/CSRF enforced; closed fields, integer bounds, revision spelling, and atomic invalid-patch rejection');

    const save = async changes => {
      detail = await admin.request(path,'PATCH',{expected_revision:detail.revision,changes});
      return detail;
    };
    await save({media_queue_limit:3,playback_session_limit:4});
    assert.equal(detail.revision,'2'); assert.equal(detail.values.media_queue_limit,3);
    assert.equal(detail.defaults.media_queue_limit,7); assert.equal(detail.origins.media_queue_limit,'override');
    assert.ok(detail.updated_at > 1700000000000);
    const previous = structuredClone(detail);
    await save({media_queue_limit:3}); assert.deepEqual(detail,previous);
    const race = await Promise.all([5,6].map(value => admin.raw(path,{method:'PATCH',body:{expected_revision:detail.revision,changes:{media_queue_limit:value}}})));
    assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    assert.equal((await race.find(r=>r.status===409).json()).error.code,'SETTINGS_REVISION_CONFLICT');
    detail=await admin.request(path);
    await save({media_queue_limit:null});
    assert.equal(detail.values.media_queue_limit,7); assert.equal(detail.overrides.media_queue_limit,null);
    await f.startServer({MEDIA_QUEUE_LIMIT:'11'});
    detail=await admin.request(path);
    assert.equal(detail.values.media_queue_limit,11); assert.equal(detail.values.playback_session_limit,4);
    assert.equal(detail.defaults.media_queue_limit,11); assert.equal(detail.origins.media_queue_limit,'deployment');
    report.checks.push('partial atomic saves, no-op revision retention, concurrent CAS, persisted restart overrides, and null inheritance from changed deployment baseline');

    // Current role and exact session/CSRF are re-read after waiting on their rows.
    f.sql(`UPDATE users SET admin=true WHERE id='${person.id}'`);
    let release=await hold(f,`SELECT id FROM users WHERE id='${person.id}' FOR UPDATE`);
    let pending=viewer.raw(path,{method:'PATCH',body:{expected_revision:detail.revision,changes:{media_queue_limit:12}}});
    await blocked(f,'SELECT admin FROM users');
    await release(`UPDATE users SET admin=false WHERE id='${person.id}'`);
    assert.equal((await pending).status,403);
    const changing=f.client(); await changing.login();
    release=await hold(f,`SELECT token_hash FROM sessions WHERE token_hash='${loginHash(changing)}' FOR UPDATE`);
    pending=changing.raw(path,{method:'PATCH',body:{expected_revision:detail.revision,changes:{media_queue_limit:12}}});
    await blocked(f,'SELECT csrf FROM sessions');
    await release(`UPDATE sessions SET csrf='replaced-in-owned-fixture' WHERE token_hash='${loginHash(changing)}'`);
    assert.equal((await pending).status,403);
    const expiring=f.client(); await expiring.login();
    f.sql(`UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE token_hash='${loginHash(expiring)}'`);
    release=await hold(f,'SELECT singleton FROM admin_settings FOR UPDATE');
    pending=expiring.raw(path,{method:'PATCH',body:{expected_revision:detail.revision,changes:{media_queue_limit:12}}});
    await blocked(f,'FROM admin_settings WHERE singleton');
    await delay(2200); await release();
    assert.equal((await pending).status,401);
    assert.equal((await admin.request(path)).revision,detail.revision);
    report.checks.push('held-lock demotion, rotated CSRF, and natural login expiry reject without persisting a write');

    // Real anonymous endpoints retain spent attempts across lower/raise edits.
    await save({registration_validate_per_minute:8,registration_per_ten_minutes:8});
    const validate=()=>guest.raw('/auth/registration-invites/validate',{method:'POST',body:{code:'invalid'}});
    for(let i=0;i<5;i++) assert.equal((await validate()).status,400);
    await save({registration_validate_per_minute:2});
    assert.equal((await validate()).status,429);
    assert.equal(f.sql("SELECT attempts FROM account_rate_limits WHERE scope='invite-validate'"),'6');
    await save({registration_validate_per_minute:8});
    assert.equal((await validate()).status,400); assert.equal((await validate()).status,400);
    const limited=await validate(); assert.equal(limited.status,429); assert.ok(Number(limited.headers.get('retry-after'))>0);
    await save({registration_per_ten_minutes:1});
    const register=()=>guest.raw('/auth/register',{method:'POST',body:{code:'invalid',username:'settings-new',password:f.password}});
    assert.equal((await register()).status,400); assert.equal((await register()).status,429);
    // A request queued behind the actual shared rate limiter uses the new limit.
    f.sql("DELETE FROM account_rate_limits WHERE scope='invite-validate'");
    await save({registration_validate_per_minute:8}); await validate();
    release=await hold(f,'LOCK TABLE account_rate_limits IN SHARE ROW EXCLUSIVE MODE');
    pending=validate(); await blocked(f,'LOCK TABLE account_rate_limits');
    await save({registration_validate_per_minute:1}); await release();
    assert.equal((await pending).status,429);
    report.checks.push('both real registration gates use saved limits; spent attempts remain monotonic; waiting admission observes a newer limit');

    // Public policy stays minimal; open signup uses a real account and no invite.
    await save({registration_per_ten_minutes:100,registration_validate_per_minute:100});
    f.sql("DELETE FROM account_rate_limits WHERE scope IN ('register','invite-validate')");
    const signup=(username,extra={},client=f.client())=>client.raw('/auth/register',{method:'POST',body:{username,password:f.password,...extra}});
    assert.equal((await signup('needs-invite')).status,400);
    await save({registration_mode:'closed'});
    assert.equal((await signup('closed-signup')).status,403);
    assert.equal((await validate()).status,403);
    assert.equal((await guestPolicy()).registration_mode,'closed');
    await save({registration_mode:'open',guests_enabled:true});
    assert.deepEqual(await guestPolicy(),{registration_mode:'open',guests_enabled:true});
    const newClient=f.client();
    const registered=await signup('open-member',{},newClient);
    assert.equal(registered.status,201);
    const account=await registered.json(); newClient.csrf=account.csrf;
    assert.equal(account.admin,false); assert.equal((await newClient.request('/auth/me')).id,account.id);
    assert.equal(f.sql(`SELECT admin FROM users WHERE id='${account.id}'`),'f');
    assert.equal((await signup('open-member')).status,409);
    assert.equal((await signup('invalid', {admin:true})).status,422);
    const issued=await admin.request('/admin/registration-invites','POST',{batch_id:randomUUID(),count:1,valid_days:1},201);
    const supplied=await signup('open-with-code',{code:issued.items[0].code});
    assert.equal(supplied.status,201);
    assert.equal(f.sql(`SELECT used_at IS NULL FROM registration_invites WHERE id='${issued.items[0].id}'`),'t');
    // Simulate a committed mode change while issuance waits on its policy row.
    for (const [mode,status,name] of [['closed',403,'race-closed'],['invite_only',400,'race-invite']]) {
      detail=await admin.request(path); await save({registration_mode:'open'});
      release=await hold(f,'SELECT singleton FROM admin_settings FOR UPDATE');
      pending=signup(name); await blocked(f,'SELECT singleton FROM admin_settings');
      await release(`UPDATE admin_settings SET registration_mode='${mode}',revision=revision+1 WHERE singleton`);
      assert.equal((await pending).status,status);
      assert.equal(f.sql(`SELECT count(*) FROM users WHERE username='${name}'`),'0');
    }
    detail=await admin.request(path);
    const invited=await signup('invite-member',{code:issued.items[0].code});
    assert.equal(invited.status,201);
    assert.equal(f.sql(`SELECT used_at IS NOT NULL FROM registration_invites WHERE id='${issued.items[0].id}'`),'t');
    await save({registration_mode:null,guests_enabled:null});
    assert.deepEqual(await guestPolicy(),{registration_mode:'invite_only',guests_enabled:false});
    report.checks.push('public minimal policy; explicit closed/invite/open modes; real code-less non-admin signup; invite-only atomic consumption; no invite consumed in open; issuance lock waits reject stale open forms; reset preserves invite-only/guest-off defaults');

    // Tiny local media exercises real session and job admission with no Worker.
    await f.makeClip('settings-fixture.mp4',{width:160,height:90,pictureSeconds:1});
    const source=await admin.request('/sources','POST',{name:'settings fixture',kind:'local',config:{root:f.root}});
    await admin.request(`/sources/${source.id}/test`,'POST');
    const media=(await admin.request('/media')).find(item=>item.title.includes('settings-fixture'));
    assert.ok(media);
    const room=await viewer.request('/rooms','POST',{name:'settings capacity'});
    f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media.id}','media_generation',1) WHERE room_id='${room.id}'`);
    const play=(mode='direct')=>viewer.raw('/playback-sessions',{method:'POST',body:{room_id:room.id,media_generation:1,mode,position_ms:0,idempotency_key:randomUUID()}});
    await save({playback_session_limit:4,media_queue_limit:3});
    const first=await play(); assert.equal(first.status,200); const session=await first.json();
    await save({playback_session_limit:1});
    assert.equal(f.sql(`SELECT stopped FROM playback_sessions WHERE id='${session.session_id}'`),'f');
    const denied=await play(); assert.equal(denied.status,429); assert.equal((await denied.json()).error.code,'TOO_MANY_PLAYBACK_SESSIONS');
    await save({playback_session_limit:4});
    release=await hold(f,`SELECT id FROM users WHERE id='${person.id}' FOR NO KEY UPDATE`);
    pending=play(); await blocked(f,"SELECT id FROM users");
    await save({playback_session_limit:1}); await release();
    assert.equal((await pending).status,429);
    await save({playback_session_limit:8,media_queue_limit:1});
    const queued=await play('transcode'); assert.equal(queued.status,200); const job=await queued.json();
    const queueFull=await play('transcode'); assert.equal(queueFull.status,503); assert.equal((await queueFull.json()).error.code,'MEDIA_QUEUE_FULL');
    assert.equal(f.sql(`SELECT status FROM media_jobs WHERE session_id='${job.session_id}'`),'queued');
    await save({media_queue_limit:2});
    const nextJob=await play('transcode'); assert.equal(nextJob.status,200);
    report.checks.push('saved session cap and global queue cap control real playback/job admissions without stopping existing playback; session lock waits use current saved cap');

    // No row is not the same as inherited defaults: unavailable settings fail closed.
    f.sql('DELETE FROM admin_settings');
    await admin.request(path,'GET',undefined,500);
    await f.client().request('/auth/registration-policy','GET',undefined,500);
    const failed=await validate(); assert.equal(failed.status,500);
    assert.equal((await play()).status,500);
    report.checks.push('missing durable settings fail closed in administrator reads, registration, and playback admission');
    await writeFile(resolve(f.root,'report.json'),JSON.stringify({...report,result:'passed'},null,2)+'\n');
  }, {env:{PLAYBACK_SESSION_LIMIT:'8',MEDIA_QUEUE_LIMIT:'7',REGISTRATION_VALIDATE_PER_MINUTE:'8',REGISTRATION_PER_TEN_MINUTES:'9'}});
  report.cleanup=await fixture.verifyStopped(); report.result='passed';
} catch(error) { report.result='failed'; report.error=String(error.stack??error); throw error; }
finally { if(fixture) await writeFile(resolve(fixture.root,'report.json'),JSON.stringify(report,null,2)+'\n'); }
console.log(JSON.stringify(report,null,2));
