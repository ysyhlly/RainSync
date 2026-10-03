// Actual Worker producers on generated local output, not browser/cache-hotness evidence.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyPidAbsent, verifyClosedPort } from "./fixtures/postgres.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bindingPath =
  process.env.RAINSYNC_PLAYBACK_METRICS_BINDING ??
  process.env.W03_BACKEND_BINDING;
assert.ok(bindingPath);
assert.ok(process.env.RAINSYNC_ARTIFACT_DIR);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bytes = await readFile(bindingPath),
  binding = JSON.parse(bytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingPath)), digest(bytes));
  assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
  for (const input of binding.source)
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      input.path,
    );
  for (const binary of binding.binaries)
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      binary.name,
    );
}
await verifyBinding();
const report = {
  result: "running",
  checks: [],
  binding: { path: bindingPath, source_digest: binding.source_digest },
  scope:
    "Generated local remux output; actual authorized Worker index reads and compulsory admission receipts. SQL fault injection is confined to this owned fixture. No Agent/browser/upstream-product or general cache-hotness acceptance.",
};
const sockets = new Set();
let fixture, workerPid, workerPort, primaryError;
const check = (name, evidence = {}) => {
  report.checks.push({ name, ...evidence });
  console.log(`PASS: ${name}`);
};
async function until(probe, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(15);
  }
  throw Error(`Deadline: ${label}`);
}
async function checked(response, status, code) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  const body = text ? JSON.parse(text) : null;
  if (code) assert.equal(body.error.code, code);
  return body;
}
async function roomController(f, client, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  sockets.add(ws);
  ws.on("error", () => {});
  ws.once("close", () => sockets.delete(ws));
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  const next = (predicate) =>
    until(() => {
      const index = frames.findIndex(predicate);
      return index < 0 ? null : frames.splice(index, 1)[0];
    }, "public room response");
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((v) => v.type === "SNAPSHOT");
  let state = snapshot.state,
    epoch = snapshot.control_epoch.id;
  return {
    get state() {
      return state;
    },
    async select(media) {
      const command = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: epoch,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media.id },
      };
      ws.send(JSON.stringify(command));
      let answer = await next((v) => v.command_id === command.command_id);
      if (
        answer.type === "ERROR" &&
        answer.control_epoch &&
        ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
          answer.error?.code,
        )
      ) {
        epoch = answer.control_epoch.id;
        ws.send(JSON.stringify({ ...command, control_epoch: epoch }));
        answer = await next((v) => v.command_id === command.command_id);
      }
      assert.equal(answer.type, "ACK", JSON.stringify(answer));
      state = answer.state;
      assert.equal(state.media_id, media.id);
      return state.media_generation;
    },
  };
}

async function holdClaim(f) {
  const marker = `entry_lock_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "";
  child.stdout.on("data", (bytes) => (output += bytes));
  child.stdin.write(
    `BEGIN;SELECT pg_advisory_xact_lock(72614933);SELECT '${marker}';\n`,
  );
  await until(() => output.includes(marker), "owned claim lock");
  let done = false;
  return async () => {
    if (!done) {
      done = true;
      child.stdin.end("COMMIT;\n");
      await child.done;
    }
  };
}
try {
  await isolatedMediaStack("playback-output-entry-runtime", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, root: f.root };
    const admin = f.client();
    const owner = await admin.login();
    await f.makeClip("owned-entry.mp4", { pictureSeconds: 4 });
    await f.startWorker();
    workerPid = f.workerPid;
    workerPort = Number(new URL(f.workerOrigin).port);
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const source = await admin.request("/sources", "POST", {
      name: "owned entry source",
      kind: "local",
      config: { root: f.root },
    });
    await admin.request(`/sources/${source.id}/test`, "POST");
    const mediaId = f.sql(
      `SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND title LIKE '%owned-entry%'`,
    );
    const media = (await admin.request("/media")).find(
      (item) => item.id === mediaId,
    );
    assert.ok(media);
    const room = await admin.request("/rooms", "POST", { name: "entry scope" });
    const controller = await roomController(f, admin, room);
    await controller.select(media);
    const prepare = async (mode = "remux") => {
      const input = {
        room_id: room.id,
        media_generation: controller.state.media_generation,
        viewer_id: randomUUID(),
        plan_generation: 1,
        idempotency_key: randomUUID(),
        mode,
        position_ms: 0,
        playback_metrics_version: 1,
        playback_metrics_supported_versions: [1, 2],
        playback_metrics: {
          meter_start_generation: 1,
          startup_origin: "user_intent",
        },
      };
      const plan = await admin.request("/playback-sessions", "POST", input);
      assert.equal(plan.playback_metrics_version, 2);
      return { input, plan };
    };
    const snapshot = (grant) =>
      JSON.parse(
        f.sql(
          `SELECT jsonb_build_object('availability',metrics_output_entry_availability,'completed',metrics_output_entry_completed,'queue',metrics_output_entry_queue_ms) FROM playback_sessions WHERE id=${quote(grant.plan.session_id)}`,
        ),
      );
    const ready = (grant) =>
      until(
        () => {
          const job = JSON.parse(
            f.sql(
              `SELECT jsonb_build_object('status',status,'error',error,'attempt',attempt,'queue_ms',metrics_queue_ms,'queue_complete',metrics_queue_complete) FROM media_jobs WHERE id=${quote(grant.plan.session_id)}`,
            ),
          );
          if (["failed", "cancelled"].includes(job.status)) {
            (report.job_failures ??= []).push(job);
            throw new Error(`Owned output job ended: ${JSON.stringify(job)}`);
          }
          return job.status === "succeeded";
        },
        "owned remux completion",
        30000,
      );
    const get = async (grant, options = {}) => {
      const response = await fetch(
        new URL(grant.plan.playback_url, f.workerOrigin),
        options,
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      if (options.method !== "HEAD") assert.match(text, /#EXTM3U/);
      return text;
    };
    const frame = async (grant) => {
      const sample = {
        version: 2,
        media_generation: grant.plan.media_generation,
        plan_generation: 1,
        meter_start_generation: 1,
        seq: 1,
        startup_origin: "user_intent",
        elapsed_ms: 1000,
        totals: {
          startup_ms: 1000,
          autoplay_blocked_ms: 0,
          background_ms: 0,
          paused_ms: 0,
          seeking_ms: 0,
          rebuffer_ms: 0,
          playing_ms: 0,
          unobserved_ms: 0,
        },
        startup_phases: {
          preparation_ms: 500,
          loading_ms: 500,
          unobserved_ms: 0,
        },
        first_frame: {
          elapsed_ms: 900,
          confirmed_elapsed_ms: 1000,
          evidence: "video_frame_callback",
        },
        first_frame_plan_generation: 1,
        final: false,
      };
      await admin.request(
        `/playback-sessions/${grant.plan.session_id}/metrics`,
        "POST",
        sample,
      );
      return JSON.parse(
        f.sql(
          `SELECT jsonb_build_object('availability',metrics_first_frame_output_entry,'queue',metrics_first_frame_queue_ms) FROM playback_viewer_plans WHERE user_id=${quote(owner.id)} AND viewer_id=${quote(grant.input.viewer_id)}`,
        ),
      );
    };
    const warm = await prepare();
    await ready(warm);
    await get(warm, { method: "HEAD" });
    assert.equal(snapshot(warm).availability, null);
    await Promise.all([get(warm), get(warm)]);
    await until(() => snapshot(warm).completed, "initial warm classification");
    assert.equal(snapshot(warm).availability, "warm");
    assert.ok(Number.isInteger(snapshot(warm).queue));
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_executions WHERE session_id=${quote(warm.plan.session_id)} AND metrics_entry_candidate=true`,
      ),
      "2",
    );
    assert.deepEqual(await frame(warm), {
      availability: "warm",
      queue: snapshot(warm).queue,
    });
    check(
      "HEAD does not consume eligibility; concurrent completed validated reads produce one warm cohort and complete pinned queue",
    );
    await admin.request(`/playback-sessions/${warm.plan.session_id}`, "DELETE");

    const unlock = await holdClaim(f);
    let cold;
    try {
      cold = await prepare();
      const pending = get(cold);
      pending.catch(() => {});
      await until(
        () => snapshot(cold).availability === "cold_waiting",
        "actual queued entry lookup",
      );
      await unlock();
      await pending;
    } finally {
      await unlock();
    }
    await until(
      () => snapshot(cold).completed,
      "cold validated response cutoff",
    );
    await get(cold);
    assert.equal(snapshot(cold).availability, "cold_waiting");
    assert.ok(snapshot(cold).queue >= 0);
    assert.deepEqual(await frame(cold), {
      availability: "cold_waiting",
      queue: snapshot(cold).queue,
    });
    check(
      "initial queued lookup stays cold after output warms and response freezes overlapping queue",
    );
    await admin.request(`/playback-sessions/${cold.plan.session_id}`, "DELETE");

    const cancelledUnlock = await holdClaim(f);
    let cancelled;
    try {
      cancelled = await prepare();
      const abort = new AbortController();
      const pending = fetch(
        new URL(cancelled.plan.playback_url, f.workerOrigin),
        { signal: abort.signal },
      );
      pending.catch(() => {});
      await until(
        () => snapshot(cancelled).availability === "cold_waiting",
        "cancelled initial lookup",
      );
      abort.abort();
      await assert.rejects(pending);
      await until(
        () =>
          f.sql(
            `SELECT count(*) FROM media_executions WHERE session_id=${quote(cancelled.plan.session_id)} AND kind='delivery' AND reaped_at IS NULL`,
          ) === "0",
        "cancelled delivery positively drained",
      );
    } finally {
      await cancelledUnlock();
    }
    await ready(cancelled);
    await get(cancelled);
    await delay(200);
    assert.deepEqual(snapshot(cancelled), {
      availability: "cold_waiting",
      completed: false,
      queue: null,
    });
    assert.deepEqual(await frame(cancelled), {
      availability: "cold_waiting",
      queue: null,
    });
    check(
      "failed first output request leaves queue unknown; later ready request cannot capture replacement startup queue",
    );
    await admin.request(
      `/playback-sessions/${cancelled.plan.session_id}`,
      "DELETE",
    );

    const lost = await prepare();
    await ready(lost);
    f.sql(
      `CREATE FUNCTION owned_entry_write_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${quote(lost.plan.session_id)}::uuid AND (NEW.metrics_output_entry_availability IS DISTINCT FROM OLD.metrics_output_entry_availability OR NEW.metrics_output_entry_completed IS DISTINCT FROM OLD.metrics_output_entry_completed) THEN RAISE EXCEPTION 'owned_output_metrics_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_entry_write_fault BEFORE UPDATE ON playback_sessions FOR EACH ROW EXECUTE FUNCTION owned_entry_write_fault();`,
    );
    await get(lost);
    await until(
      async () =>
        String(await readFile(resolve(f.root, "postgres.log"))).includes(
          "owned_output_metrics_failure",
        ),
      "actual optional write fault",
    );
    assert.equal(snapshot(lost).availability, null);
    f.sql(
      "DROP TRIGGER owned_entry_write_fault ON playback_sessions;DROP FUNCTION owned_entry_write_fault();",
    );
    await until(
      () =>
        f.sql(
          `SELECT count(*) FROM media_executions WHERE session_id=${quote(lost.plan.session_id)} AND kind='delivery' AND reaped_at IS NULL`,
        ) === "0",
      "lost classification delivery drained",
    );
    f.sql(`UPDATE media_executions SET reaped_at=clock_timestamp()-interval '3 days' WHERE session_id=${quote(lost.plan.session_id)} AND kind='delivery';
   INSERT INTO media_executions(id,session_id,kind,owner_id,reaped_at,metrics_entry_candidate) SELECT md5('owned-prune-${randomUUID()}:'||n)::uuid,${quote(lost.plan.session_id)},'delivery',${quote(owner.id)},clock_timestamp()-interval '3 days',false FROM generate_series(1,20)n;`);
    const pruneSource = await readFile(
      resolve(repo, "crates/persistence/src/room_cleanup.rs"),
      "utf8",
    );
    const lockRoomsSql = pruneSource.match(
      /pub const LOCK_PRUNE_ROOMS_SQL: &str = r#"([\s\S]+?)"#;/,
    )[1];
    const deleteSql = pruneSource.match(
      /pub const PRUNE_EXECUTIONS_SQL: &str = r#"([\s\S]+?)"#;/,
    )[1];
    const prune = `BEGIN ISOLATION LEVEL READ COMMITTED;CREATE TEMP TABLE owned_prune_rooms ON COMMIT DROP AS ${lockRoomsSql};${deleteSql.replaceAll("$1", "ARRAY(SELECT id FROM owned_prune_rooms)")};COMMIT;`;
    f.sql(prune);
    assert.equal(
      f.sql(
        `SELECT count(*) FROM media_executions WHERE session_id=${quote(lost.plan.session_id)} AND kind='delivery'`,
      ),
      "1",
    );
    const stopped = await f.stopWorker();
    assert.equal(verifyPidAbsent(stopped.pid), true);
    await f.startWorker();
    workerPid = f.workerPid;
    await get(lost);
    await delay(200);
    assert.deepEqual(snapshot(lost), {
      availability: null,
      completed: false,
      queue: null,
    });
    assert.deepEqual(await frame(lost), {
      availability: "unknown",
      queue: null,
    });
    check(
      "optional classification failure leaves playback successful; retained admission sentinel prevents false warm after pruning and Worker restart",
    );

    const direct = await prepare("direct");
    assert.deepEqual(snapshot(direct), {
      availability: "not_applicable",
      completed: false,
      queue: null,
    });
    assert.deepEqual(await frame(direct), {
      availability: "not_applicable",
      queue: null,
    });
    const response = await admin.raw("/metrics");
    assert.equal(response.status, 200);
    const rendered = await response.text();
    assert.match(rendered, /entry_availability="unknown"/);
    assert.match(rendered, /coverage="complete"/);
    assert.match(rendered, /coverage="not_applicable"/);
    assert.match(rendered, /coverage="unknown"/);
    assert.ok(!rendered.includes(lost.plan.session_id));
    for (const grant of [lost, direct])
      await admin.request(
        `/playback-sessions/${grant.plan.session_id}`,
        "DELETE",
      );
    check(
      "server freezes Worker cohorts and incomplete/absent queue distinctly, with no identity or generalized cache-hotness labels",
    );
    await verifyBinding();
    report.result = "passed";
    await f.stopWorker();
  });
} catch (error) {
  primaryError = error;
  report.result = "failed";
  report.error = error.stack ?? String(error);
} finally {
  const cleanupErrors = [];
  const cleanup = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error.stack ?? String(error));
    }
  };
  for (const socket of sockets) await cleanup(() => socket.terminate());
  if (fixture)
    await cleanup(async () => {
      report.cleanup = await fixture.verifyStopped();
    });
  report.cleanup ??= {};
  report.cleanup.worker = {
    state: workerPid === undefined ? "never_started" : "unknown",
    pid: workerPid ?? null,
    port: workerPort ?? null,
  };
  if (workerPid !== undefined)
    await cleanup(() => {
      report.cleanup.worker.pid_absent = verifyPidAbsent(workerPid);
      assert.equal(report.cleanup.worker.pid_absent, true);
      report.cleanup.worker.state = "pid_absent";
    });
  if (workerPort !== undefined)
    await cleanup(async () => {
      report.cleanup.worker.port_closed = await verifyClosedPort(workerPort);
      assert.equal(report.cleanup.worker.port_closed, true);
    });
  if (cleanupErrors.length) {
    report.cleanup_errors = cleanupErrors;
    report.result = "failed";
    primaryError ??= new Error(
      "Owned output-entry cleanup failed; inspect cleanup_errors",
    );
  }
  const root =
    fixture?.root ??
    resolve(
      process.env.RAINSYNC_ARTIFACT_DIR,
      "playback-output-entry-runtime",
      randomUUID(),
    );
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${root}/report.json`);
}
if (primaryError) throw primaryError;
