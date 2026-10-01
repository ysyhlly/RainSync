// Finite actual API observations against a centrally built, frozen native binding.
// Persisted job rows are explicitly synthetic inventory fixtures, never executed
// jobs or transition evidence. Worker cache evidence uses its existing scan loop.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const states = ["queued", "running", "succeeded", "failed", "cancelled", "other"];
const ownerNames = ["rainsync_process_owner_observation_available", "rainsync_owned_process_tree_owners",
  "rainsync_process_admission_closed", "rainsync_process_cleanup_failed"];
const cacheNames = ["rainsync_cache_inventory_available", "rainsync_cache_regular_files",
  "rainsync_cache_logical_bytes", "rainsync_cache_inventory_age_seconds"];
const bindingFile = process.env.RAINSYNC_TASK_HEALTH_BINDING_FILE ?? process.env.W03_BACKEND_BINDING;
assert.ok(bindingFile, "Set the central successful native binding; this fixture never builds");
assert.ok(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "Use owned native PostgreSQL");
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Use an external artifact directory");
assert.equal(process.platform, "linux", "Owned process PID witnesses require Linux");
const bindingBytes = await readFile(bindingFile), binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.ok(binding.source?.length > 0 && binding.binaries?.length > 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const path of ["apps/server/src/metrics.rs", "apps/media-worker/src/metrics.rs",
  "apps/media-worker/src/readiness.rs", "apps/media-worker/src/readiness_cache.rs",
  "crates/media-core/src/child_process.rs", "crates/persistence/src/lib.rs"])
  assert.ok(binding.source.some((item) => item.path === path), `Binding includes ${path}`);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker"])
  assert.equal(resolve(binding.binaries.find((item) => item.name === name)?.path ?? "missing"),
    resolve(target, name), `Binding identifies executed ${name}`);
const coordinatorInputs = await Promise.all(["tests/task-health-observations.mjs",
  "tests/fixtures/server.mjs", "tests/fixtures/media-stack.mjs", "tests/fixtures/postgres.mjs"]
  .map(async (path) => ({ path, sha256: digest(await readFile(resolve(repo, path))) })));
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingFile)), digest(bindingBytes), "Binding remains frozen");
  for (const input of [...binding.source, ...coordinatorInputs])
    assert.equal(await hashFile(resolve(repo, input.path)), input.sha256, `Frozen input ${input.path}`);
  for (const binary of binding.binaries)
    assert.equal(await hashFile(binary.path), binary.sha256, `Frozen binary ${binary.name}`);
}
await verifyBinding();
const configuredPool = /\.max_connections\((\d+)\)/.exec(
  await readFile(resolve(repo, "crates/persistence/src/lib.rs"), "utf8"));
const configuredPermits = /Semaphore::const_new\((\d+)\)/.exec(
  await readFile(resolve(repo, "apps/server/src/metrics.rs"), "utf8"));
assert.ok(configuredPool && configuredPermits, "Read actual frozen pool and scrape limits");
const poolLimit = Number(configuredPool[1]), scrapePermits = Number(configuredPermits[1]);
assert.equal(poolLimit, 12, "Current shared Server pool bound");
assert.equal(scrapePermits, 16, "Current Server scrape permit bound");

const report = {
  schema_version: 1, result: "failed", started_at: new Date().toISOString(), checks: [],
  scope: "Finite owned native PostgreSQL, Server and Worker API observations. Synthetic persisted job inventory is not execution or transition evidence. Cache counts are regular directory entries and logical bytes from the existing bounded readiness scan, not allocated or inode-unique bytes. Process owners are registered process-tree owners, not all OS descendants or drain proof. No build, production, stress or long-run acceptance.",
  binding: { file: resolve(bindingFile), sha256: digest(bindingBytes), source_digest: binding.source_digest,
    binaries: binding.binaries, coordinator_inputs: coordinatorInputs },
  limitations: ["Exact stale/monotonic cache boundaries and cleanup-failure owner branches belong to core tests; this actual API fixture exercises successful empty/small scans, real failure and recovery",
    "The current schema rejects unknown persisted job states; the fixed other series is observed at zero without relaxing its constraint",
    "Finite tool wrappers delay only real -version checks to expose a real registered owner; no media jobs are executed"],
};
let fixture, failure, tempRoot;
const workerPids = [], sqlPids = [], locks = new Set();
async function until(probe, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(20);
  }
  throw Error(`Deadline: ${label}`);
}
async function check(name, run) {
  const row = { name, result: "failed" }, began = Date.now();
  report.checks.push(row);
  try { Object.assign(row, await run(), { result: "passed" }); console.log(`PASS: ${name}`); }
  catch (error) { row.error = error.message; throw error; }
  finally { row.elapsed_ms = Date.now() - began; }
}
function parseMetrics(text, processLabel) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(\w+)(?:\{([^}]*)\})? ([^ ]+)$/.exec(line);
    assert.ok(match, "Valid exposition line");
    const labels = {};
    for (const label of match[2]?.split(",") ?? []) {
      const pair = /^(\w+)="([^"]*)"$/.exec(label);
      assert.ok(pair, "Simple bounded labels");
      assert.equal(labels[pair[1]], undefined, "No duplicate labels");
      labels[pair[1]] = pair[2];
    }
    const name = match[1], value = Number(match[3]);
    assert.ok(Number.isFinite(value) && value >= 0, "Finite nonnegative exposition sample");
    if (name === "rainsync_media_jobs") {
      assert.deepEqual(Object.keys(labels), ["state"]);
      assert.ok(states.includes(labels.state), "Closed job-state label");
      assert.equal(processLabel, "server");
    } else if (name.startsWith("rainsync_media_jobs_")) {
      assert.deepEqual(labels, {}, "Global inventory has no process or arbitrary labels");
      assert.equal(processLabel, "server");
    } else if (ownerNames.includes(name) || cacheNames.includes(name)) {
      assert.deepEqual(labels, { process: processLabel }, "Fixed process label only");
      if (cacheNames.includes(name)) assert.equal(processLabel, "worker");
    }
    rows.push({ name, labels, value });
  }
  assert.equal(new Set(rows.map((row) => JSON.stringify([row.name, row.labels]))).size,
    rows.length, "Unique series");
  return rows;
}
function sample(rows, name, labels = {}) {
  const matches = rows.filter((row) => row.name === name &&
    JSON.stringify(row.labels) === JSON.stringify(labels));
  assert.equal(matches.length, 1, `Exactly one ${name} sample`);
  return matches[0].value;
}
function absent(rows, name) { assert.equal(rows.some((row) => row.name === name), false, `Absent ${name}`); }
function inventory(rows, expected) {
  assert.equal(rows.filter((row) => row.name === "rainsync_media_jobs").length, states.length);
  for (const state of states) assert.equal(sample(rows, "rainsync_media_jobs", { state }), expected[state]);
  assert.equal(sample(rows, "rainsync_media_jobs_queued"), expected.queued, "Existing queued gauge preserved");
}
function unavailableAge(rows) {
  assert.equal(sample(rows, "rainsync_media_jobs_oldest_queued_age_available"), 0);
  absent(rows, "rainsync_media_jobs_oldest_queued_age_seconds");
}
function owner(rows, processLabel) {
  const labels = { process: processLabel };
  const available = sample(rows, ownerNames[0], labels);
  assert.ok(available === 0 || available === 1, "Owner availability is boolean");
  if (available === 0) {
    for (const name of ownerNames.slice(1)) absent(rows, name);
    return null;
  }
  for (const name of ownerNames.slice(2)) assert.equal(sample(rows, name, labels), 0);
  const count = sample(rows, ownerNames[1], labels);
  assert.ok(Number.isInteger(count));
  return count;
}
function cache(rows, files, bytes) {
  const labels = { process: "worker" };
  assert.equal(sample(rows, cacheNames[0], labels), 1);
  assert.equal(sample(rows, cacheNames[1], labels), files);
  assert.equal(sample(rows, cacheNames[2], labels), bytes);
  const age = sample(rows, cacheNames[3], labels);
  assert.ok(age <= 6, "Fresh complete scan within existing six-second age bound");
  return age;
}
async function jobsLock(f) {
  const child = f.sqlProcess(undefined, { interactive: true });
  sqlPids.push(child.pid);
  const held = new Promise((done, reject) => {
    let output = "";
    child.stdout.on("data", (bytes) => { output += bytes; if (output.includes("OWNED_JOBS_LOCKED")) done(); });
    child.once("error", reject);
    child.done.then(() => reject(Error("Owned lock ended before witness")), reject);
  });
  let released = false;
  const lock = { async release() {
    if (released) return;
    released = true;
    child.stdin.end("COMMIT;\n\\q\n");
    await child.done;
    locks.delete(lock);
  } };
  locks.add(lock);
  child.stdin.write("BEGIN;\nLOCK TABLE media_jobs IN ACCESS EXCLUSIVE MODE;\n\\echo OWNED_JOBS_LOCKED\n");
  await held;
  return lock;
}
const inventoryWaiters = (f) => JSON.parse(f.sql("SELECT coalesce(json_agg(pid ORDER BY pid),'[]'::json) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%WITH observed AS MATERIALIZED%'"));
const waitingInventory = (f) => inventoryWaiters(f).length;

try {
  tempRoot = await mkdtemp("/tmp/rainsync-task-health-");
  const cacheRoot = resolve(tempRoot, "cache"), heldCache = resolve(tempRoot, "cache-held");
  const tools = resolve(tempRoot, "tools"), toolWitness = resolve(tempRoot, "tool-pids");
  await mkdir(cacheRoot); await mkdir(tools);
  const realTools = [], toolWrappers = [];
  for (const name of ["ffmpeg", "ffprobe"]) {
    let binary;
    for (const entry of process.env.PATH.split(delimiter)) {
      const candidate = resolve(entry, name);
      try { await access(candidate); binary = candidate; break; } catch {}
    }
    assert.ok(binary, `Existing native ${name} required; no installation`);
    realTools.push({ name, path: binary, sha256: await hashFile(binary) });
    // This finite wrapper preserves the actual tool and its exit status.
    await writeFile(resolve(tools, name), `#!${process.execPath}\nconst fs = require('node:fs');\nconst cp = require('node:child_process');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(toolWitness)}, process.pid + '\\n');\nconst run = () => { const r = cp.spawnSync(${JSON.stringify(binary)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1); };\nif (args.length === 1 && args[0] === '-version') setTimeout(run, 650); else run();\n`, { mode: 0o700 });
    toolWrappers.push({ name, path: resolve(tools, name), sha256: await hashFile(resolve(tools, name)) });
  }
  report.tool_inputs = realTools;
  report.tool_wrappers = toolWrappers;
  await isolatedMediaStack("task-health-observations", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, database_kind: f.databaseKind };
    const admin = f.client(); await admin.login();
    const urlFor = (processLabel) => processLabel === "server" ? f.origin + "/api/v1/metrics" : f.workerOrigin + "/metrics";
    const responseFor = (processLabel, cookie, signal = AbortSignal.timeout(6000)) =>
      fetch(urlFor(processLabel), { headers: cookie ? { Cookie: cookie } : {}, signal });
    const scrape = async (processLabel) => {
      const response = await responseFor(processLabel, admin.cookie);
      assert.equal(response.status, 200, `${processLabel} admin scrape`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type"), /text\/plain; version=0\.0\.4/);
      return parseMetrics(await response.text(), processLabel);
    };
    const denial = async (processLabel, cookie, status) => {
      const response = await responseFor(processLabel, cookie);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.text()).includes("rainsync_media_jobs"), false, "No inventory on denial");
    };
    try {
      await check("empty persisted inventory has fixed zero states and unavailable age", async () => {
        assert.equal(f.workerPid, undefined, "Worker remains stopped during all static inventory assertions");
        const rows = await scrape("server");
        inventory(rows, Object.fromEntries(states.map((state) => [state, 0])));
        assert.equal(sample(rows, "rainsync_media_jobs_expired_running"), 0);
        assert.equal(sample(rows, "rainsync_media_jobs_missing_running_lease"), 0);
        unavailableAge(rows);
        await until(async () => owner(await scrape("server"), "server") === 0, "Available idle Server owner observation");
        return { state_series: 6, seeded_rows: 0, owner_count: 0 };
      });
      await check("synthetic mixed inventory uses database creation age and current leases", async () => {
        const rows = [
          ["queued", "clock_timestamp()-interval '120 seconds'", "NULL", "clock_timestamp()+interval '1 hour'"],
          ["queued", "clock_timestamp()-interval '30 seconds'", "NULL", "clock_timestamp()+interval '2 hours'"],
          ["running", "clock_timestamp()", "clock_timestamp()-interval '1 hour'", "clock_timestamp()"],
          ["running", "clock_timestamp()", "NULL", "clock_timestamp()"],
          ["running", "clock_timestamp()", "clock_timestamp()+interval '1 hour'", "clock_timestamp()"],
          ...["succeeded", "succeeded", "failed", "cancelled"].map((state) => [state, "clock_timestamp()", "NULL", "clock_timestamp()"]),
        ];
        f.sql(`INSERT INTO media_jobs(id,status,spec,created_at,lease_until,available_at) VALUES ${rows.map(([state, created, lease, available]) => `(${quote(randomUUID())},${quote(state)},'{}',${created},${lease},${available})`).join(",")}`);
        const beforeAge = Number(f.sql("SELECT extract(epoch FROM clock_timestamp()-min(created_at)) FROM media_jobs WHERE status='queued'"));
        const observed = await scrape("server");
        const afterAge = Number(f.sql("SELECT extract(epoch FROM clock_timestamp()-min(created_at)) FROM media_jobs WHERE status='queued'"));
        const counts = { queued: 2, running: 3, succeeded: 2, failed: 1, cancelled: 1, other: 0 };
        inventory(observed, counts);
        assert.equal(sample(observed, "rainsync_media_jobs_expired_running"), 1);
        assert.equal(sample(observed, "rainsync_media_jobs_missing_running_lease"), 1);
        assert.equal(sample(observed, "rainsync_media_jobs_oldest_queued_age_available"), 1);
        const age = sample(observed, "rainsync_media_jobs_oldest_queued_age_seconds");
        assert.ok(age >= beforeAge && age <= afterAge, "Age bracketed by the same database clock");
        assert.ok(age >= 120 && age < 130, "Creation age survives future retry eligibility");
        return { explicitly_synthetic_rows: rows.length, counts, expired_running: 1, missing_running_lease: 1,
          oldest_creation_age_seconds: age, retry_eligibility_future: true };
      });
      await check("future and nonfinite queued creation ages are absent without false zero", async () => {
        for (const created of ["clock_timestamp()+interval '1 hour'", "'infinity'::timestamptz", "'-infinity'::timestamptz"]) {
          f.sql(`UPDATE media_jobs SET created_at=${created} WHERE status='queued'`);
          const rows = await scrape("server");
          assert.equal(sample(rows, "rainsync_media_jobs", { state: "queued" }), 2);
          unavailableAge(rows);
        }
        f.sql("DELETE FROM media_jobs");
        return { cases: ["future", "positive_infinity", "negative_infinity"], optional_age_omitted: true };
      });
      const normal = f.client();
      await admin.request("/users", "POST", { username: "owned-normal", password: f.password });
      await normal.login("owned-normal");
      const expired = f.client(); await expired.login();
      f.sql(`UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${quote(digest(expired.cookie.split("=")[1]))}`);
      const loggedOut = f.client(); await loggedOut.login();
      const loggedOutCookie = loggedOut.cookie;
      await loggedOut.request("/auth/logout", "POST");
      await check("Server rejects missing normal expired and logged-out sessions", async () => {
        for (const [cookie, status] of [["", 401], [normal.cookie, 403], [expired.cookie, 401], [loggedOutCookie, 401]])
          await denial("server", cookie, status);
        return { denied_requests: 4 };
      });
      await check("authorization is rechecked after actual inventory wait before logout", async () => {
        const victim = f.client(); await victim.login();
        const cookie = victim.cookie, lock = await jobsLock(f);
        const pending = responseFor("server", cookie);
        try {
          await until(() => waitingInventory(f) > 0, "Actual inventory query blocked after first auth", 350);
          await victim.request("/auth/logout", "POST");
        } finally { await lock.release(); }
        const response = await pending;
        assert.equal(response.status, 401); await response.arrayBuffer();
        return { actual_inventory_lock_witness: true, revoked_between_authorization_and_exposition: "logout", final_status: 401 };
      });
      await check("authorization is rechecked after actual inventory wait before demotion", async () => {
        const victim = f.client(); await victim.login();
        const lock = await jobsLock(f), pending = responseFor("server", victim.cookie);
        try {
          await until(() => waitingInventory(f) > 0, "Actual inventory wait before demotion", 350);
          f.sql("UPDATE users SET admin=false WHERE username='admin'");
        } finally { await lock.release(); }
        try { const response = await pending; assert.equal(response.status, 403); await response.arrayBuffer(); }
        finally { f.sql("UPDATE users SET admin=true WHERE username='admin'"); }
        return { actual_inventory_lock_witness: true, revoked_between_authorization_and_exposition: "demotion", final_status: 403 };
      });
      await check("cancelled and timed-out inventory queries leave the auth pool usable while lock held", async () => {
        const lock = await jobsLock(f), controllers = [], timers = [];
        let cancelled = [], fresh = [];
        // The shared pool has twelve slots. Allow two for real background work;
        // sixteen scrape permits cannot produce sixteen simultaneous SQL waits.
        const minimumWaiters = poolLimit - 2;
        try {
          cancelled = Array.from({ length: scrapePermits }, () => {
            const controller = new AbortController(); controllers.push(controller);
            timers.push(setTimeout(() => controller.abort(), 2500));
            return responseFor("server", admin.cookie, controller.signal).then(async (response) => {
              await response.arrayBuffer(); return { status: response.status };
            }, (error) => ({ error: error.name }));
          });
          const firstBackendPids = await until(() => {
            const pids = inventoryWaiters(f); return pids.length >= minimumWaiters ? pids : null;
          }, "Exact inventory SQL occupies observed concurrent pool capacity before cancellation", 350);
          for (const controller of controllers) controller.abort();
          const cancelledResults = await Promise.all(cancelled);
          for (const result of cancelledResults) assert.equal(result.error, "AbortError", "Every owned cancelled request is awaited");
          await until(() => waitingInventory(f) === 0, "Cancelled scrape database work released", 3500);
          await until(() => f.sql(`SELECT count(*) FROM pg_stat_activity WHERE pid IN (${firstBackendPids.join(",")})`) === "0",
            "Every witnessed first-round backend connection is gone before fresh requests", 3500);
          const began = Date.now();
          fresh = Array.from({ length: scrapePermits }, () => responseFor("server", admin.cookie,
            AbortSignal.timeout(4000)).then(async (response) => {
            await response.arrayBuffer(); return response.status;
          }));
          const freshBackendPids = await until(() => {
            const pids = inventoryWaiters(f); return pids.length >= minimumWaiters ? pids : null;
          }, "Fresh requests reoccupy observed concurrent pool capacity under the same lock", 350);
          assert.equal(freshBackendPids.some((pid) => firstBackendPids.includes(pid)), false,
            "Fresh inventory waiters use distinct positively witnessed backend connections");
          const freshResults = await Promise.all(fresh);
          for (const status of freshResults) assert.equal(status, 503, "Fresh deadline requests terminate unavailable under held lock");
          const elapsed = Date.now() - began;
          assert.ok(elapsed < 3500, "Original three-second scrape bound with finite scheduling allowance");
          await until(() => waitingInventory(f) === 0, "Fresh deadline round releases inventory waits", 3500);
          const authResponses = await Promise.all(Array.from({ length: poolLimit }, async () => {
            const response = await admin.raw("/auth/me", { signal: AbortSignal.timeout(2500) });
            await response.arrayBuffer(); return response.status;
          }));
          for (const status of authResponses) assert.equal(status, 200, "Fresh shared-pool authorization works while jobs lock persists");
          return { configured_pool_limit: poolLimit, configured_scrape_permits: scrapePermits,
            cancelled_requests: cancelled.length, first_round_inventory_waiters: firstBackendPids.length,
            first_round_backend_pids: firstBackendPids, first_round_backends_gone_before_fresh_round: true,
            fresh_deadline_requests: fresh.length, reused_inventory_waiters: freshBackendPids.length,
            fresh_round_backend_pids: freshBackendPids, distinct_backend_connections: true,
            minimum_observed_reused_capacity: minimumWaiters, fresh_round_elapsed_ms: elapsed,
            fresh_auth_requests: authResponses.length, auth_pool_usable_with_lock_held: true,
            limit: "Client aborts and ordinary PostgreSQL lock deadlines; observed concurrent capacity reuse, not proof of every pool slot or blackholed-reply recovery" };
        } finally {
          for (const timer of timers) clearTimeout(timer);
          for (const controller of controllers) controller.abort();
          await Promise.allSettled([...cancelled, ...fresh]);
          await lock.release();
        }
      });
      await f.startWorker({ CACHE_ROOT: cacheRoot, PATH: tools + delimiter + f.env.PATH });
      workerPids.push(f.workerPid);
      await check("Worker rejects missing normal expired and logged-out sessions", async () => {
        for (const [cookie, status] of [["", 401], [normal.cookie, 403], [expired.cookie, 401], [loggedOutCookie, 401]])
          await denial("worker", cookie, status);
        return { denied_requests: 4 };
      });
      await check("Worker successful empty scan exposes known zero inventory", async () => {
        const rows = await until(async () => { const rows = await scrape("worker");
          return sample(rows, cacheNames[0], { process: "worker" }) === 1 ? rows : null; }, "Worker complete empty scan");
        const age = cache(rows, 0, 0); owner(rows, "worker");
        return { regular_files: 0, logical_bytes: 0, age_seconds: age };
      });
      await check("Worker existing scan counts small nested regular entries and skips symlinks", async () => {
        await mkdir(resolve(cacheRoot, "nested"));
        await writeFile(resolve(cacheRoot, "a"), "abc");
        await writeFile(resolve(cacheRoot, "nested", "b"), "12345");
        await writeFile(resolve(cacheRoot, "nested", "empty"), "");
        await link(resolve(cacheRoot, "nested", "b"), resolve(cacheRoot, "hardlink-b"));
        await writeFile(resolve(tempRoot, "outside"), "excluded outside bytes");
        await mkdir(resolve(tempRoot, "outside-dir"));
        await writeFile(resolve(tempRoot, "outside-dir", "excluded"), "excluded directory bytes");
        await symlink(resolve(tempRoot, "outside"), resolve(cacheRoot, "file-link"));
        await symlink(resolve(tempRoot, "outside-dir"), resolve(cacheRoot, "directory-link"));
        const rows = await until(async () => { const rows = await scrape("worker");
          return rows.some((row) => row.name === cacheNames[1] && row.value === 4) ? rows : null; }, "Existing scan updates known regular inventory");
        cache(rows, 4, 13);
        return { regular_files: 4, logical_bytes: 13, nested_empty_file_included: true,
          hardlink_counted_as_regular_entry: true, excluded_symlinks: 2 };
      });
      await check("Worker real scan failure omits counts and later recovery restores them", async () => {
        await rename(cacheRoot, heldCache); await writeFile(cacheRoot, "not a directory");
        try {
          const rows = await until(async () => { const rows = await scrape("worker");
            return sample(rows, cacheNames[0], { process: "worker" }) === 0 ? rows : null; }, "Existing scan records real root failure");
          for (const name of cacheNames.slice(1)) absent(rows, name);
          const readiness = await fetch(f.workerOrigin + "/ready");
          assert.equal((await readiness.json()).checks.writable_cache, "failed");
        } finally { await rm(cacheRoot, { force: true }); await rename(heldCache, cacheRoot); }
        const rows = await until(async () => { const rows = await scrape("worker");
          return sample(rows, cacheNames[0], { process: "worker" }) === 1 ? rows : null; }, "Existing scan recovers known inventory");
        cache(rows, 4, 13);
        return { failure_available: 0, failure_count_samples_omitted: 3, recovered_regular_files: 4, recovered_logical_bytes: 13 };
      });
      await check("real version-check process owner appears then is reaped", async () => {
        const positive = await until(async () => { const rows = await scrape("worker");
          const count = owner(rows, "worker"); return count > 0 ? count : null; }, "Registered real tool process owner", 10000);
        const zero = await until(async () => { const rows = await scrape("worker");
          return owner(rows, "worker") === 0 ? rows : null; }, "Version tool owner reaped");
        owner(zero, "worker");
        return { observed_registered_owners: positive, later_registered_owners: 0 };
      });
    } finally { for (const lock of [...locks]) await lock.release(); }
  });
  await verifyBinding();
  for (const input of [...realTools, ...toolWrappers])
    assert.equal(await hashFile(input.path), input.sha256, "Native tool and finite wrapper remain frozen");
  report.result = "passed";
} catch (error) { failure = error; report.failure = { message: error.message }; }
finally {
  const cleanupErrors = [];
  try {
    if (fixture) {
      const stack = await fixture.verifyStopped();
      const workerPortClosed = await verifyClosedPort(Number(new URL(fixture.workerOrigin).port));
      assert.equal(workerPortClosed, true);
      for (const pid of [...workerPids, ...sqlPids]) assert.equal(verifyPidAbsent(pid), true, "Owned process absent");
      let toolPids = [];
      try { toolPids = [...new Set((await readFile(resolve(tempRoot, "tool-pids"), "utf8")).trim().split("\n").filter(Boolean).map(Number))]; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const pid of toolPids) assert.equal(verifyPidAbsent(pid), true, "Owned tool wrapper PID absent");
      report.cleanup = { ...stack, worker_pids: workerPids, worker_pids_absent: true,
        worker_port_closed: workerPortClosed, sql_pids: sqlPids, sql_pids_absent: true,
        tool_wrapper_pids: toolPids, tool_wrapper_pids_absent: true };
    }
  } catch (error) { cleanupErrors.push(error.message); failure ??= error; }
  if (tempRoot) {
    try { await rm(tempRoot, { recursive: true, force: true });
      await assert.rejects(access(tempRoot), { code: "ENOENT" });
      (report.cleanup ??= {}).owned_tmp_cache_and_tools_removed = true;
    } catch (error) { cleanupErrors.push(error.message); failure ??= error; }
  }
  if (cleanupErrors.length) { report.cleanup_errors = cleanupErrors; report.result = "failed"; }
  report.finished_at = new Date().toISOString();
  if (fixture) { const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n"); console.log(`Evidence: ${path}`); }
}
if (failure) throw failure;
