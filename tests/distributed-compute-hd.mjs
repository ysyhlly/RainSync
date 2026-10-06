// Real owned NAS -> compute node -> Server publication for each HD tier.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedMediaStack } from './fixtures/media-stack.mjs';
import { delay } from './fixtures/server.mjs';
import { reapOwnedChildren } from '../deploy/owned-process.mjs';

const recipes = [['h264_720p_hls_v1', 1280, 720], ['h264_1080p_hls_v1', 1920, 1080], ['h264_2160p_hls_v1', 3840, 2160]];
const report = { result: 'running', checks: [], scope: 'owned synthetic 4K source, one real local NAS/compute node, authenticated independent Server qualification; no hardware/performance claim' };
let fixture;
async function until(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(150); }
  throw Error(`Timed out: ${label}`);
}
try {
  await isolatedMediaStack('distributed-compute-hd', async f => {
    fixture = f;
    const source = resolve(f.root, 'source'); await mkdir(source);
    await f.makeClip('source/owned-4k.mp4', { width: 3840, height: 2160, pictureSeconds: 3 });
    const admin = f.client(); await admin.login();
    const { agentId } = await f.startAgent({ mediaRoot: source });
    const media = await until(() => f.sql(`SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='owned-4k.mp4' AND available AND source_version IS NOT NULL`), 'versioned owned NAS source');
    await admin.request(`/agents/${agentId}/compute-policy`, 'POST', { enabled: true, slots: 1, output_budget_bytes: 67108864 });
    const log = createWriteStream(resolve(f.root, 'compute-node.log'));
    const child = spawn(resolve(f.target, 'rainsync-compute-node'), [], { env: { ...f.env, SERVER_URL: f.origin, RAINSYNC_NAS_COMPUTE_ENABLED: '1', AGENT_CREDENTIAL_FILE: resolve(f.root, 'agent-token'), COMPUTE_MEDIA_ROOT: source, COMPUTE_OUTPUT_ROOT: resolve(f.root, 'node-output') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(r => child.once('close', r)); child.stdout.pipe(log); child.stderr.pipe(log);
    try {
      await until(() => {
        if (child.exitCode !== null) throw Error(`Compute node exited ${child.exitCode}; inspect owned node log`);
        return f.sql(`SELECT count(*) FROM distributed_compute_sources WHERE media_id='${media}'`) === '1';
      }, 'successful HD self-test and content registration');
      for (const [recipe, width, height] of recipes) {
        const room = await admin.request('/rooms', 'POST', { name: `owned ${recipe}` });
        f.sql(`UPDATE room_snapshots SET state=state||jsonb_build_object('media_id','${media}','media_generation',1) WHERE room_id='${room.id}'`);
        const job = await admin.request(`/rooms/${room.id}/compute`, 'POST', { media_generation: 1, recipe });
        const ready = await until(async () => {
          const status = await admin.request(`/rooms/${room.id}/compute/${job.id}`);
          if (status.status === 'failed' || status.status === 'cancelled') throw Error(`${recipe}: ${status.error}`);
          return status.status === 'ready' ? status : null;
        }, `independent Server qualification: ${recipe}`);
        const q = JSON.parse(f.sql(`SELECT qualification FROM distributed_compute_jobs WHERE id='${job.id}'`));
        assert.equal(q.recipe, recipe); assert.equal(q.output.video.width, width); assert.equal(q.output.video.height, height);
        assert.ok(Math.abs(q.output.format_duration_seconds - 3) <= 0.2); assert.equal(q.full_decode, true);
        assert.equal(f.sql(`SELECT output_budget_bytes FROM distributed_compute_jobs WHERE id='${job.id}'`), '67108864');
        const directory = await admin.request(`/rooms/${room.id}/compute/${job.id}/directory`);
        assert.equal(directory.output_generation, ready.output_generation);
        assert.ok(directory.files.length >= 2);
        assert.ok(directory.files.every(file => file.size_bytes > 0 && file.size_bytes <= 8388608));
        for (const file of directory.files) assert.equal((await admin.raw(file.url.replace('/api/v1', ''))).status, 200);
        await until(() => f.sql(`SELECT process_reaped_at IS NOT NULL AND files_removed_at IS NOT NULL AND server_verification_reaped_at IS NOT NULL FROM distributed_compute_attempts WHERE job_id='${job.id}'`) === 't', `owned process and verification drain: ${recipe}`);
        report.checks.push({ recipe, width, height, bytes: directory.files.reduce((n, file) => n + file.size_bytes, 0), server_qualified: true, drain_confirmed: true });
      }
    } finally { await reapOwnedChildren([{ child, closed }]); await new Promise(r => log.end(r)); }
    report.result = 'passed';
  }, { beforeStart: async f => { f.env.RAINSYNC_COMPUTE_OUTPUT_ROOT = resolve(f.root, 'published'); } });
  report.cleanup = await fixture.verifyStopped();
} catch (error) { report.result = 'failed'; report.error = String(error); if (fixture) report.cleanup = await fixture.verifyStopped(); throw error; }
finally { if (fixture) { await writeFile(resolve(fixture.root, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); } }
