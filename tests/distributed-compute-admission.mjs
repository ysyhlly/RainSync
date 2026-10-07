// Owned isolated SQLx upgrade + HTTP admission/fencing; no encoder or production state.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedServer, delay } from './fixtures/server.mjs';

const recipes = ['remux_hls_v1', 'h264_480p_hls_v1', 'h264_720p_hls_v1', 'h264_1080p_hls_v1', 'h264_2160p_hls_v1'];
const legacyAgent = randomUUID(), legacyConnection = randomUUID();
const report = { result: 'running', checks: [], scope: 'isolated synthetic PostgreSQL + real Server HTTP admission; encoder output is tested separately' };
let fixture;
try {
  await isolatedServer('distributed-compute-admission', async f => {
    fixture = f;
    assert.equal(f.sql('SELECT max(version) FROM _sqlx_migrations'), '86');
    assert.equal(f.sql('SELECT count(*) FROM _sqlx_migrations WHERE version=82 AND success'), '1');
    assert.equal(f.sql(`SELECT enabled||':'||slots||':'||output_budget_bytes FROM distributed_compute_policy WHERE agent_id='${legacyAgent}'`), 'false:1:67108864');
    assert.equal(f.sql(`SELECT array_to_string(capabilities,',') FROM distributed_compute_nodes WHERE agent_id='${legacyAgent}'`), recipes.slice(0, 2).join(','));
    report.checks.push('SQLx upgrades immutable 1–81 schema through 86 including HD migration 82; legacy capabilities and disabled 1-slot/64-MiB policy remain unchanged');
    const admin = f.client(); await admin.login();
    const created = await admin.request('/agents', 'POST', { name: 'owned HD admission node' });
    const agent = { id: created.id, ...(await admin.request('/agents/pair', 'POST', { code: created.pair_code })) };
    const connection = randomUUID();
    const agentRequest = async (path, body, expected = 200, headers = {}) => {
      const response = await fetch(f.origin + '/api/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', ...headers }, body: body instanceof Uint8Array ? body : JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result;
    };
    const heartbeat = (caps = recipes, expected = 200) => agentRequest('/agent-compute/heartbeat', { connection_id: connection, capabilities: caps, self_test: {} }, expected);
    const policy = (output_budget_bytes = 67108864, enabled = true, expected = 200) => admin.request(`/agents/${agent.id}/compute-policy`, 'POST', { enabled, slots: 1, output_budget_bytes }, expected);
    await heartbeat(recipes, 403);
    await policy();
    for (const caps of [[], ['unknown'], [recipes[0], recipes[0]], [...recipes, 'h264_8k_hls_v1']]) await heartbeat(caps, 400);
    await heartbeat();
    const media = randomUUID(), version = `stat-v1:${'a'.repeat(64)}`, hash = 'b'.repeat(64);
    f.sql(`INSERT INTO sources(id,name,kind,config_encrypted) VALUES('${agent.id}','owned synthetic NAS','agent','unused-owned-fixture'); INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${media}','${agent.id}','owned synthetic clip','clip.mp4','${version}')`);
    const source = { media_id: media, source_version: version, content_sha256: hash, size_bytes: 1024 };
    await agentRequest('/agent-compute/catalog', source);
    const room = await admin.request('/rooms', 'POST', { name: 'owned HD admission' });
    f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1) WHERE room_id='${room.id}'`);
    const setDuration = duration => f.sql(`UPDATE media_items SET metadata='${JSON.stringify({ capability_source_version: version, format: { duration: String(duration) }, streams: [{ index: 0, codec_type: 'video' }] })}'::jsonb WHERE id='${media}'`);
    setDuration(1);
    const prepare = (recipe, expected = 200, client = admin) => client.request(`/rooms/${room.id}/compute`, 'POST', { media_generation: 1, recipe }, expected);
    const cancel = job => admin.request(`/rooms/${room.id}/compute/${job.id}`, 'DELETE');
    assert.equal((await prepare('h264_8k_hls_v1', 400)).error.code, 'INVALID_COMPUTE_RECIPE');
    await heartbeat(recipes.slice(0, 2));
    for (const recipe of recipes.slice(2)) assert.equal((await prepare(recipe, 409)).error.code, 'COMPUTE_RECIPE_UNAVAILABLE');
    await heartbeat();
    await admin.request('/users', 'POST', { username: 'compute-outsider', password: f.password });
    const outsider = f.client(); await outsider.login('compute-outsider', f.password);
    for (const recipe of recipes) {
      await prepare(recipe, 409, outsider);
      const job = await prepare(recipe);
      assert.equal(f.sql(`SELECT recipe FROM distributed_compute_jobs WHERE id='${job.id}'`), recipe);
      // Old companions never claim a queued HD recipe even after advertisement changes.
      if (recipes.indexOf(recipe) >= 2) {
        await heartbeat(recipes.slice(0, 2));
        assert.equal((await agentRequest('/agent-compute/claim', { connection_id: connection })).job, null);
        await heartbeat();
      }
      const claimed = (await agentRequest('/agent-compute/claim', { connection_id: connection })).job;
      assert.equal(claimed.id, job.id); assert.equal(claimed.recipe, recipe); assert.equal(claimed.output_budget_bytes, 67108864);
      assert.equal((await agentRequest('/agent-compute/claim', { connection_id: connection })).reason, 'node_full');
      const fence = { connection_id: connection, attempt: claimed.attempt, output_generation: claimed.output_generation };
      await agentRequest(`/agent-compute/jobs/${job.id}/renew`, { ...fence, output_generation: randomUUID() }, 409);
      await cancel(job);
      await agentRequest(`/agent-compute/jobs/${job.id}/renew`, fence, 409);
    }
    report.checks.push('all five recipes persist and claim; unknown recipes and duplicate capabilities rejected; old advertisements cannot enqueue or claim HD; membership, generation fence, cancellation and one-slot cap retained');
    // Database constraints independently reject arbitrary recipe/capability strings.
    assert.throws(() => f.sql(`UPDATE distributed_compute_nodes SET capabilities=ARRAY['unknown'] WHERE agent_id='${agent.id}'`), /check constraint/);
    const immutableColumns = 'room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,selected_video_index,selected_audio_index';
    assert.throws(() => f.sql(`INSERT INTO distributed_compute_jobs(id,${immutableColumns},recipe) SELECT gen_random_uuid(),${immutableColumns},'h264_8k_hls_v1' FROM distributed_compute_jobs LIMIT 1`), /check constraint/);
    const jobConstraint = f.sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='distributed_compute_jobs'::regclass AND conname='distributed_compute_jobs_recipe_check'");
    for (const recipe of recipes) assert.ok(jobConstraint.includes(recipe));
    assert.ok(!jobConstraint.includes('h264_8k'));
    setDuration(600);
    const legacy480 = await prepare(recipes[1]);
    assert.equal(f.sql(`SELECT output_budget_bytes FROM distributed_compute_jobs WHERE id='${legacy480.id}'`), '67108864');
    await cancel(legacy480);
    await policy(1048576);
    for (const recipe of recipes.slice(2)) {
      setDuration(10);
      const result = await prepare(recipe, 413);
      assert.equal(result.error.code, 'COMPUTE_OUTPUT_BUDGET_INSUFFICIENT');
      assert.match(result.error.message, /配额|容量/); assert.equal(result.error.retryable, false);
    }
    await policy();
    setDuration(1801);
    for (const recipe of recipes) assert.equal((await prepare(recipe, 422)).error.code, 'COMPUTE_SOURCE_DURATION_UNSUPPORTED');
    setDuration(1);
    assert.equal((await agentRequest('/agent-compute/catalog', { ...source, size_bytes: 16 * 1024 ** 3 + 1 }, 413)).error.code, 'COMPUTE_SOURCE_TOO_LARGE');
    await policy(1048575, true, 400); await policy(1024 ** 3 + 1, true, 400);
    const pending = await prepare(recipes[4]);
    await policy(1048576);
    assert.equal((await agentRequest('/agent-compute/claim', { connection_id: connection })).reason, 'compute_output_budget_insufficient');
    assert.equal(f.sql(`SELECT status||':'||attempt FROM distributed_compute_jobs WHERE id='${pending.id}'`), 'queued:0');
    const fitting = await prepare(recipes[0]);
    f.sql(`UPDATE distributed_compute_jobs SET error=NULL WHERE id='${pending.id}'`);
    const lock = f.sqlProcess(undefined, { interactive: true });
    let lockOutput = ''; lock.stdout.on('data', chunk => { lockOutput += chunk; });
    lock.stdin.write(`BEGIN; SELECT id FROM distributed_compute_jobs WHERE id='${pending.id}' FOR UPDATE; SELECT 'locked-head';\n`);
    try {
      const lockDeadline = Date.now() + 5000;
      while (!lockOutput.includes('locked-head') && Date.now() < lockDeadline) await delay(20);
      assert.ok(lockOutput.includes('locked-head'));
      const claimStarted = Date.now();
      assert.equal((await agentRequest('/agent-compute/claim', { connection_id: connection })).job.id, fitting.id, 'a blocked HD head never starves a later fitting job');
      assert.ok(Date.now() - claimStarted < 1000, 'advisory diagnostic cannot delay the committed lease behind a locked rejected job');
    } finally { lock.stdin.end('ROLLBACK;\n\\q\n'); await lock.done; }
    await cancel(fitting);
    await policy(); await cancel(pending);
    const lateInvalid = await prepare(recipes[2]);
    setDuration(1801);
    const fittingMedia = randomUUID(), fittingVersion = `stat-v1:${'c'.repeat(64)}`;
    f.sql(`INSERT INTO media_items(id,source_id,title,resource,source_version) VALUES('${fittingMedia}','${agent.id}','valid later source','fit.mp4','${fittingVersion}')`);
    await agentRequest('/agent-compute/catalog', { media_id: fittingMedia, source_version: fittingVersion, content_sha256: 'd'.repeat(64), size_bytes: 2048 });
    const fittingRoom = await admin.request('/rooms', 'POST', { name: 'valid source after late probe' });
    f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${fittingMedia}','media_generation',1) WHERE room_id='${fittingRoom.id}'`);
    const laterValid = await admin.request(`/rooms/${fittingRoom.id}/compute`, 'POST', { media_generation: 1, recipe: recipes[0] });
    assert.equal((await agentRequest('/agent-compute/claim', { connection_id: connection })).job.id, laterValid.id, 'late invalid metadata cannot poison the claim loop');
    assert.equal(f.sql(`SELECT status||':'||attempt||':'||error FROM distributed_compute_jobs WHERE id='${lateInvalid.id}'`), 'queued:0:compute_source_duration_unsupported');
    await admin.request(`/rooms/${fittingRoom.id}/compute/${laterValid.id}`, 'DELETE');
    await cancel(lateInvalid); setDuration(1);
    // Actual artifact checks remain independent of estimates (remux has no fixed bitrate).
    for (const [budget, code] of [[1048576, 'COMPUTE_OUTPUT_BUDGET_EXCEEDED'], [2097152, 'COMPUTE_GLOBAL_BUDGET_EXCEEDED']]) {
      await policy(budget);
      const job = await prepare(recipes[0]);
      const claimed = (await agentRequest('/agent-compute/claim', { connection_id: connection })).job;
      const bytes = Buffer.alloc(1048577, 7);
      const result = await agentRequest(`/agent-compute/jobs/${job.id}/files/segment00000.ts`, bytes, 413, {
        'Content-Type': 'application/octet-stream', 'x-compute-connection': connection,
        'x-compute-attempt': String(claimed.attempt), 'x-compute-generation': claimed.output_generation,
        'x-content-sha256': createHash('sha256').update(bytes).digest('hex'),
      });
      assert.equal(result.error.code, code);
      assert.equal(f.sql(`SELECT count(*) FROM distributed_compute_files WHERE job_id='${job.id}'`), '0');
      await cancel(job);
    }
    await policy();
    const diagnosticJob = await prepare(recipes[2]);
    const diagnosticClaim = (await agentRequest('/agent-compute/claim', { connection_id: connection })).job;
    const diagnosticFence = { connection_id: connection, attempt: diagnosticClaim.attempt, output_generation: diagnosticClaim.output_generation };
    const diagnosticBody = { ...diagnosticFence, failure_reason: 'compute_output_budget_exceeded' };
    await agentRequest(`/agent-compute/jobs/${diagnosticJob.id}/fail`, { ...diagnosticFence, failure_reason: 'arbitrary_exception_text' }, 422);
    const foreignCreated = await admin.request('/agents', 'POST', { name: 'owned foreign node' });
    const foreign = await admin.request('/agents/pair', 'POST', { code: foreignCreated.pair_code });
    await agentRequest(`/agent-compute/jobs/${diagnosticJob.id}/fail`, diagnosticBody, 409, { Authorization: `Bearer ${foreign.token}` });
    await agentRequest(`/agent-compute/jobs/${diagnosticJob.id}/fail`, { ...diagnosticBody, output_generation: randomUUID() }, 409);
    f.sql(`UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id='${diagnosticJob.id}'`);
    await agentRequest(`/agent-compute/jobs/${diagnosticJob.id}/fail`, diagnosticBody, 409);
    assert.equal(f.sql(`SELECT status FROM distributed_compute_jobs WHERE id='${diagnosticJob.id}'`), 'running');
    f.sql(`UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()+interval '20 seconds' WHERE id='${diagnosticJob.id}'`);
    await agentRequest(`/agent-compute/jobs/${diagnosticJob.id}/fail`, diagnosticBody);
    const failed = await admin.request(`/rooms/${room.id}/compute/${diagnosticJob.id}`);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'compute_output_budget_exceeded');
    assert.equal((await admin.request(`/rooms/${room.id}/compute`)).jobs.find(j => j.id === diagnosticJob.id).error, 'compute_output_budget_exceeded');
    await agentRequest(`/agent-compute/jobs/${diagnosticJob.id}/fail`, diagnosticBody, 409);
    assert.equal(f.sql(`SELECT process_reaped_at IS NULL AND files_removed_at IS NULL FROM distributed_compute_attempts WHERE job_id='${diagnosticJob.id}'`), 't');
    const oldClientJob = await prepare(recipes[0]);
    const oldClientClaim = (await agentRequest('/agent-compute/claim', { connection_id: connection })).job;
    await agentRequest(`/agent-compute/jobs/${oldClientJob.id}/fail`, { connection_id: connection, attempt: oldClientClaim.attempt, output_generation: oldClientClaim.output_generation });
    assert.equal((await admin.request(`/rooms/${room.id}/compute/${oldClientJob.id}`)).error, 'node_execution_failed');
    const readyJob = await prepare(recipes[2]);
    const readyClaim = (await agentRequest('/agent-compute/claim', { connection_id: connection })).job;
    // Synthetic ready state isolates mutation fencing; this does not claim output qualification.
    f.sql(`UPDATE distributed_compute_jobs SET status='ready',lease_until=NULL WHERE id='${readyJob.id}'`);
    await agentRequest(`/agent-compute/jobs/${readyJob.id}/fail`, { connection_id: connection, attempt: readyClaim.attempt, output_generation: readyClaim.output_generation, failure_reason: 'compute_output_budget_exceeded' }, 409);
    assert.equal(f.sql(`SELECT status FROM distributed_compute_jobs WHERE id='${readyJob.id}'`), 'ready');
    await cancel(readyJob);
    const authorityJob = await prepare(recipes[2]);
    f.sql(`UPDATE sources SET config_encrypted='changed-owned-fixture' WHERE id='${agent.id}'`);
    assert.equal((await agentRequest('/agent-compute/claim', { connection_id: connection })).job, null);
    assert.equal(f.sql(`SELECT distributed_compute_authorized('${authorityJob.id}')`), 'f');
    f.sql(`UPDATE sources SET config_encrypted='unused-owned-fixture' WHERE id='${agent.id}'`);
    assert.equal(f.sql(`SELECT distributed_compute_authorized('${authorityJob.id}')`), 'f');
    await cancel(authorityJob);
    await policy(67108864, false);
    assert.equal((await prepare(recipes[4], 409)).error.code, 'COMPUTE_RECIPE_UNAVAILABLE');
    await heartbeat(recipes, 403);
    report.checks.push('legacy 480p keeps runtime quota, incompatible heads and late invalid probes cannot starve fitting jobs, allowlisted failure diagnostics retain independent drain obligations, actual upload owner/global budgets, source policy revision revoke/restore fencing, explicit node quota bounds, conservative known-duration admission, lowered-policy recheck, 30-minute/16-GiB limits and revoked compute opt-in fail closed without increasing defaults');
    report.result = 'passed';
  }, { beforeStart: async f => {
    f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT = resolve(f.root, 'published');
    f.env.RAINSYNC_COMPUTE_TOTAL_BYTES = '1048576';
    f.sql('CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY,description TEXT NOT NULL,installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),success BOOLEAN NOT NULL,checksum BYTEA NOT NULL,execution_time BIGINT NOT NULL)');
    for (const name of (await readdir('migrations')).filter(name => /^\d+_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 81).sort()) {
      const bytes = await readFile('migrations/' + name); const version = Number(name.slice(0, 4)); const description = name.slice(5, -4).replaceAll('_', ' '); const checksum = createHash('sha384').update(bytes).digest('hex');
      f.sql(`BEGIN; ${bytes}; INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(${version},'${description}',true,decode('${checksum}','hex'),0); COMMIT;`);
    }
    f.sql(`INSERT INTO agents(id,name) VALUES('${legacyAgent}','legacy disabled compute'); INSERT INTO distributed_compute_policy(agent_id) VALUES('${legacyAgent}'); INSERT INTO distributed_compute_nodes(agent_id,connection_id,capabilities,self_test) VALUES('${legacyAgent}','${legacyConnection}',ARRAY['remux_hls_v1','h264_480p_hls_v1'],'{}')`);
  } });
  report.cleanup = await fixture.verifyStopped();
} catch (error) { report.result = 'failed'; report.error = String(error); if (fixture) report.cleanup = await fixture.verifyStopped(); throw error; }
finally { if (fixture) { await writeFile(resolve(fixture.root, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); } }
