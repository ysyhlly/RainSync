// Own real NAS files/Agent, native Worker and disposable PostgreSQL. A queued
// request is deliberately admitted before the restarted Agent indexes a new
// source version, preserving the observed scheduling race without clock jumps.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

const report = { schema_version: 1, started_at: new Date().toISOString(), result: "running", checks: [], states: [], limitations: ["Isolated Linux local filesystem; no production NAS, long run or old-C failure attribution"] };
let fixture;
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
async function until(check, label, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (await check()) return; await delay(50); }
  throw Error(`deadline: ${label}`);
}
try {
  await isolatedMediaStack("preview-queue-recovery", async f => {
    fixture = f;
    const files = execFileSync("git", ["ls-files", "apps/server", "apps/media-worker", "apps/nas-agent", "crates", "migrations", "Cargo.toml", "Cargo.lock", "tests/fixtures"], { encoding: "utf8" }).trim().split(/\r?\n/).sort();
    files.push("tests/preview-queue-recovery.mjs");
    report.source = await Promise.all(files.map(async path => ({ path, sha256: await hash(path) })));
    report.binaries = await Promise.all(["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"].map(async name => ({ name, sha256: await hash(resolve(f.target, name)) })));
    const admin = f.client(); await admin.login();
    await f.makeClip("recover.mp4", { color: "red" });
    const { agentId } = await f.startAgent();
    await f.waitForSql(`SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND resource='recover.mp4' AND source_version IS NOT NULL`, "1", 20000);
    const media = f.sql(`SELECT id FROM media_items WHERE source_id='${agentId}' AND resource='recover.mp4'`);
    const state = () => JSON.parse(f.sql(`SELECT json_build_object('generation',m.preview_generation,'source_version',m.source_version,'status',p.status,'source_generation',p.source_generation,'attempt',p.attempt,'attempt_id',p.attempt_id,'owner_id',p.owner_id,'lease_live',p.lease_until>clock_timestamp(),'image_present',p.image IS NOT NULL,'error_code',p.error_code) FROM media_items m LEFT JOIN media_previews p ON p.media_id=m.id WHERE m.id='${media}'`));
    await admin.request("/media/previews", "POST", { media_ids: [media] });
    const queued = state();
    assert.equal(queued.status, "queued");
    assert.equal(queued.source_generation, queued.generation);
    report.states.push({ stage: "requested-before-restart", ...queued });
    await f.stopAgent();
    await f.makeClip("recover.mp4", { color: "blue" });
    await f.startAgent();
    await until(() => state().source_version !== queued.source_version && state().generation > queued.generation, "restarted Agent commits changed source version");
    const changed = state();
    assert.equal(changed.status, "queued");
    assert.ok(changed.source_generation < changed.generation);
    report.states.push({ stage: "real-index-advanced-after-request", ...changed });
    await f.startWorker();
    // Preserve the failure-state evidence rather than issuing another POST:
    // that would hide a stranded queued request by creating a fresh generation.
    let cover;
    try { cover = await f.waitForPreview(media, "ready", 10000); }
    catch (error) { report.states.push({ stage: "failed-auto-recovery", ...state() }); throw error; }
    const response = await admin.raw(cover.url.replace("/api/v1", ""));
    assert.equal(response.status, 200);
    const path = resolve(f.root, "recovered.webp"); await writeFile(path, Buffer.from(await response.arrayBuffer()));
    const pixel = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { timeout: 10000, maxBuffer: 2e6 });
    const rgb = pixel.subarray((180 * 640 + 320) * 3, (180 * 640 + 320) * 3 + 3);
    assert.ok(rgb[2] > 180 && rgb[0] < 50, "recovered preview uses the actual blue replacement");
    const recovered = state();
    assert.equal(recovered.source_generation, recovered.generation);
    assert.equal(recovered.attempt, 1, "a new source starts its own bounded retry budget");
    report.states.push({ stage: "recovered-without-new-post", ...recovered });
    report.checks.push("queued request survives real Agent replacement/restart; latest source used; no second POST");
    // No Worker can race these synthetic queue-only rows. Real transfer work
    // above is complete; the example does not start or acknowledge resources.
    await f.stopWorker();
    const example = resolve(f.target, "examples/verify_preview_recovery");
    report.queue_example = { path: example, sha256: await hash(example) };
    const output = execFileSync(example, [], { env: { ...f.env, RAINSYNC_ISOLATED_TEST: "1", RAINSYNC_FIXTURE_DATABASE: f.env.DATABASE_URL }, encoding: "utf8", timeout: 30000 });
    await writeFile(resolve(f.root, "queue-fencing.stdout"), output);
    report.checks.push(...output.trim().split(/\r?\n/));
    for (const entry of report.source) assert.equal(await hash(entry.path), entry.sha256, `source stayed unchanged: ${entry.path}`);
    for (const entry of report.binaries) assert.equal(await hash(resolve(f.target, entry.name)), entry.sha256, `binary stayed unchanged: ${entry.name}`);
    assert.equal(await hash(report.queue_example.path), report.queue_example.sha256, "queue example binary stayed unchanged");
    report.result = "passed";
  }, { env: { MEDIA_PREVIEW_TIMEOUT_SECONDS: "5" } });
} catch (error) { report.result = "failed"; report.failure = String(error.stack ?? error); process.exitCode = 1; }
finally {
  if (fixture) {
    report.postgres = fixture.postgresDiagnostics();
    try { report.cleanup = await fixture.verifyStopped(); }
    catch (error) { report.result = "failed"; report.cleanup_error = String(error.message); process.exitCode = 1; }
    report.finished_at = new Date().toISOString();
    await writeFile(resolve(fixture.root, "report.json"), JSON.stringify(report, null, 2));
    console.log(`${report.result.toUpperCase()}: preview queue recovery; ${resolve(fixture.root, "report.json")}`);
  }
}
