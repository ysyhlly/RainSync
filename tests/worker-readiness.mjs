import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";
import { safeFailure } from "./fixtures/safe-failure.mjs";

assert.notEqual(process.platform, "win32", "This focused POSIX fault fixture uses shell tool wrappers");
const report = { schema_version: 1, result: "running", active_stage: "fixture-start", checks: [] };
let fixture;
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const until = async (predicate, label, timeout = 18000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw Error(label);
};
try {
  await isolatedMediaStack("worker-readiness", async f => {
    fixture = f;
    const workerBinary = resolve(f.target, "rainsync-media-worker");
    report.active_stage = "bounded-database-tests";
    const rust = execFileSync("cargo", ["test", "--offline", "-p", "rainsync-media-worker", "--test", "readiness_runtime", "postgres_timeout_cancellation_and_pool_exhaustion_recover", "--", "--ignored", "--nocapture"], {
      env: { ...process.env, RAINSYNC_READINESS_TEST_DATABASE_URL: f.env.DATABASE_URL },
      timeout: 60000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    await writeFile(resolve(f.root, "bounded-database-tests.log"), rust);
    report.checks.push("real SQL statement timeout, canceled query socket disposal, one-slot pool recovery and cached monitor exhaustion/recovery");
    // A package-scoped Cargo test can relink the non-test Worker with a narrower
    // dependency feature set. Restore the complete workspace build before
    // hashing or launching the services used by the HTTP fixture.
    report.active_stage = "workspace-restore";
    const build = execFileSync("cargo", ["build", "--workspace", "--bins", "--examples", "--locked"], {
      env: process.env, timeout: 120000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    await writeFile(resolve(f.root, "workspace-build.log"), build);
    report.worker_sha256 = createHash("sha256").update(await readFile(workerBinary)).digest("hex");


    const tools = resolve(f.root, "tools");
    await mkdir(tools);
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const actual = execFileSync("which", [tool], { encoding: "utf8" }).trim();
      await writeFile(resolve(tools, tool), `#!/bin/sh\nif [ -e ${quote(resolve(tools, tool + "-fail"))} ]; then exit 1; fi\nif [ -e ${quote(resolve(tools, tool + "-hang"))} ]; then\n  echo $$ > ${quote(resolve(tools, tool + "-pid"))}\n  sleep 120 &\n  echo $! > ${quote(resolve(tools, tool + "-child-pid"))}\n  wait\n  exit 1\nfi\nexec ${quote(actual)} "$@"\n`, { mode: 0o700 });
    }
    report.active_stage = "worker-start";
    await f.startWorker({ PATH: tools + delimiter + process.env.PATH, CACHE_MAX_BYTES: "1048576" });
    const workerPid = f.workerPid;
    const workerPort = Number(new URL(f.workerOrigin).port);
    report.worker = { pid: workerPid, port: workerPort };
    report.active_stage = "functional-checks";
    const ready = async () => {
      const response = await fetch(f.workerOrigin + "/ready", { signal: AbortSignal.timeout(1500) });
      assert.equal(response.headers.get("cache-control"), "no-store");
      const value = await response.json();
      // The route stays outside generic error normalization so 503 keeps checks.
      return { status: response.status, ...value };
    };
    await until(async () => (await ready()).status === 200, "first actual Worker probes and idle poll ready");
    const healthy = await ready();
    assert.equal(healthy.ready, true);
    assert.deepEqual(Object.keys(healthy.checks).sort(), ["database", "writable_cache", "ffmpeg", "ffprobe", "claim_loop", "task_ownership", "accepting_work", "resource_drain", "preview_queue_running", "cache_cleaner_running"].sort());
    assert.ok(Object.values(healthy.checks).every(v => v === "ready"));
    report.checks.push("HTTP /ready uses only low-cardinality cached evidence; successful empty queue poll is healthy");

    await writeFile(resolve(tools, "ffmpeg-fail"), "");
    await until(async () => (await ready()).checks.ffmpeg === "failed", "removed executable capability fails readiness");
    const started = performance.now();
    const burst = await Promise.all(Array.from({ length: 80 }, () => ready()));
    assert.ok(burst.every(v => v.status === 503 && v.ready === false));
    assert.ok(performance.now() - started < 3000, "ready request burst cannot wait for external probes");
    assert.equal((await fetch(f.workerOrigin + "/health")).status, 200);
    await unlink(resolve(tools, "ffmpeg-fail"));
    await until(async () => (await ready()).status === 200, "tool recovery returns ready");
    report.checks.push("FFmpeg exit failure returns 503, 80 concurrent readiness reads stay bounded, liveness remains 200, tool recovery works");

    await writeFile(resolve(tools, "ffprobe-hang"), "");
    await until(async () => (await ready()).checks.ffprobe === "failed", "hung ffprobe times out");
    const descendants = [Number(await readFile(resolve(tools, "ffprobe-pid"), "utf8")), Number(await readFile(resolve(tools, "ffprobe-child-pid"), "utf8"))];
    for (const pid of descendants) await until(() => verifyPidAbsent(pid), "timed-out tool tree is physically reaped");
    await unlink(resolve(tools, "ffprobe-hang"));
    await until(async () => (await ready()).status === 200, "ffprobe recovery returns ready");
    report.tool_descendant_pids = descendants;
    report.checks.push("hung ffprobe deadline fails closed and both actual wrapper/descendant PIDs disappear before recovery");

    const cache = f.env.CACHE_ROOT;
    await writeFile(resolve(cache, "owned-quota-fixture"), Buffer.alloc(1048576));
    await until(async () => (await ready()).checks.writable_cache === "failed", "real cache quota pressure fails readiness");
    assert.equal((await readFile(resolve(cache, "owned-quota-fixture"))).length, 1048576, "readiness never evicts data");
    await unlink(resolve(cache, "owned-quota-fixture"));
    await until(async () => (await ready()).status === 200, "cache quota recovery ready");
    const retained = cache + "-retained";
    await rename(cache, retained);
    await writeFile(cache, "not a directory");
    await until(async () => (await ready()).checks.writable_cache === "failed", "lost cache directory fails readiness");
    await unlink(cache);
    await rename(retained, cache);
    await until(async () => (await ready()).status === 200, "owned cache directory recovery ready");
    assert.deepEqual(await readdir(cache), [], "probe leaves no files");
    report.checks.push("cache access and configured quota use actual filesystem probes, never evict data, and recover without residue");

    const marker = "worker_readiness_owned_claim_lock";
    const blocker = f.sqlProcess(`BEGIN; SELECT pg_advisory_xact_lock(72614933); SELECT pg_sleep(8) /* ${marker} */; COMMIT;`);
    await f.waitForSql(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND wait_event='PgSleep'`, "1");
    await until(async () => (await ready()).checks.claim_loop === "failed", "actual blocked claim loop fails readiness");
    assert.equal((await ready()).checks.database, "ready", "SELECT true alone cannot prove queue progress");
    await blocker.done;
    await until(async () => (await ready()).status === 200, "claim loop recovers after owned lock release");
    report.checks.push("real claim advisory-lock fault returns 503 despite healthy independent DB probe, then queue recovers");

    report.active_stage = "worker-stop";
    report.worker_stop = await f.stopWorker();
    report.worker_stop_recorded_at = new Date().toISOString();
    report.active_stage = "worker-pid-absence";
    report.worker_pid_absent = verifyPidAbsent(workerPid);
    assert.ok(report.worker_pid_absent);
    report.active_stage = "worker-port-closure";
    const portProbeStarted = performance.now();
    report.worker_port_probe = { port: workerPort, started_at: new Date().toISOString(), outcome: "pending" };
    try {
      const closed = await verifyClosedPort(workerPort);
      report.worker_port_probe.outcome = closed ? "closed" : "connected";
      assert.ok(closed);
    } catch (error) {
      if (report.worker_port_probe.outcome === "pending") {
        report.worker_port_probe.outcome = error.message === "Owned fixture port closure unconfirmed" ? "timeout" : "probe-failed";
      }
      throw error;
    } finally {
      report.worker_port_probe.finished_at = new Date().toISOString();
      report.worker_port_probe.elapsed_ms = performance.now() - portProbeStarted;
    }
    report.active_stage = "cache-residue";
    assert.deepEqual(await readdir(cache), []);
    report.worker_cleanup = { pid: workerPid, pid_absent: true, port_closed: true, cache_probe_files: 0 };
    report.checks.push("shutdown closes owned Worker process/listener and leaves no cache probe files");
    report.active_stage = "completed";
    report.result = "passed";
  }, { binary: process.env.RAINSYNC_READINESS_SERVER_BINARY });
} catch (error) {
  report.result = "failed";
  report.failure = safeFailure(error);
  process.exitCode = 1;
} finally {
  if (fixture) {
    try {
      report.cleanup = await fixture.verifyStopped();
    } catch (error) {
      report.result = "failed";
      report.cleanup = { completed: false, verification: "unconfirmed" };
      report.cleanup_failure = safeFailure(error);
      process.exitCode = 1;
    }
    report.postgres = fixture.postgresDiagnostics();
    await writeFile(resolve(fixture.root, "report.json"), JSON.stringify(report, null, 2));
    console.log(`${report.result}: ${resolve(fixture.root, "report.json")}`);
  }
}
