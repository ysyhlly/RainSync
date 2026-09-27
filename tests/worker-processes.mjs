import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const tag = process.env.WORKER_TEST_IMAGE ?? "rainsync-worker-validation:local";
const options = {
  encoding: "utf8",
  windowsHide: true,
  timeout: 30000,
  maxBuffer: 4 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
};
const docker = (...args) => execFileSync("docker", args, options).trim();
const image = docker("image", "inspect", "--format", "{{.Id}}", tag);
const name = `rainsync-process-${randomUUID().slice(0, 8)}`;
const db = `${name}-db`,
  server = `${name}-server`;
const root = resolve(".runtime/worker-processes", name);
await mkdir(root, { recursive: true });
const cache = resolve(root, "cache");
await mkdir(cache);
const password = randomBytes(20).toString("hex");
const env = [
  "-e",
  `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
  "-e",
  `SOURCE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  "-e",
  `ADMIN_PASSWORD=${password}`,
  "-e",
  "PUBLIC_ORIGIN=http://localhost:8080",
];
const sql = (query) =>
  docker(
    "exec",
    db,
    "psql",
    "-U",
    "rainsync",
    "-d",
    "rainsync",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  );
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, description, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await delay(250);
  }
  throw new Error(`deadline: ${description}`);
}
const children = [];
const report = { image, cases: [] };
function ffmpegPids(worker) {
  return docker(
    "exec",
    worker,
    "sh",
    "-c",
    'for p in /proc/[0-9]*/comm; do if [ "$(cat "$p" 2>/dev/null)" = ffmpeg ]; then echo "$p"; fi; done',
  );
}
async function startWorker(
  scenario,
  existingId,
  attempt = 1,
  tinyCache = false,
) {
  const id = existingId ?? randomUUID(),
    worker = `${name}-${scenario}`;
  if (!existingId)
    sql(
      `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"root":"/media","resource":"source.mp4","transcode":true,"start_seconds":${tinyCache ? 150 : 0}}')`,
    );
  children.push(worker);
  docker(
    "run",
    "-d",
    "--init",
    "--name",
    worker,
    "--network",
    name,
    "--cpus",
    tinyCache ? "1" : "0.5",
    "--memory",
    "512m",
    ...env,
    "--mount",
    `type=bind,source=${root},target=/media,readonly`,
    ...(tinyCache
      ? ["--tmpfs", "/cache:size=8m,uid=10001,gid=10001,mode=0700"]
      : ["--mount", `type=bind,source=${cache},target=/cache`]),
    image,
    "rainsync-media-worker",
  );
  await until(() => ffmpegPids(worker).length > 0, "real FFmpeg started");
  const pid = ffmpegPids(worker);
  await until(
    () => {
      try {
        docker(
          "exec",
          worker,
          "test",
          "-s",
          `/cache/${id}/${attempt}/index.m3u8`,
        );
        return true;
      } catch {
        return false;
      }
    },
    "first real HLS output",
    60000,
  );
  assert.ok(
    ffmpegPids(worker),
    "FFmpeg must still be executing when fault is injected",
  );
  const command = docker(
    "exec",
    worker,
    "cat",
    pid.replace("/comm", "/cmdline"),
  );
  assert.ok(command.includes(`/cache/${id}/${attempt}/index.m3u8`));
  const workerPid = docker("exec", worker, "cat", "/proc/1/task/1/children");
  assert.match(workerPid, /^\d+$/);
  return { id, worker, pid, workerPid };
}
try {
  docker("network", "create", name);
  docker(
    "run",
    "-d",
    "--name",
    db,
    "--network",
    name,
    "--network-alias",
    "db",
    "-e",
    "POSTGRES_USER=rainsync",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:17",
  );
  await until(() => {
    try {
      return docker("exec", db, "pg_isready", "-U", "rainsync").includes(
        "accepting connections",
      );
    } catch {
      return false;
    }
  }, "database ready");
  // Generate actual media separately from Worker execution, with no network.
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0",
      "--mount",
      `type=bind,source=${root},target=/media`,
      image,
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24",
      "-t",
      "180",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "2",
      "/media/source.mp4",
    ],
    { ...options, timeout: 90000 },
  );
  report.source_sha256 = createHash("sha256")
    .update(await readFile(resolve(root, "source.mp4")))
    .digest("hex");
  report.ffmpeg = docker(
    "run",
    "--rm",
    "--network",
    "none",
    image,
    "ffmpeg",
    "-version",
  ).split("\n")[0];
  docker(
    "run",
    "-d",
    "--name",
    server,
    "--network",
    name,
    ...env,
    image,
    "rainsync-server",
  );
  await until(() => {
    try {
      return (
        sql(
          "SELECT count(*) FROM _sqlx_migrations WHERE version=10 AND success",
        ) === "1"
      );
    } catch {
      return false;
    }
  }, "production migrations");

  const disk = await startWorker("disk", undefined, 1, true);
  docker(
    "exec",
    "--user",
    "0",
    disk.worker,
    "sh",
    "-c",
    `kill -STOP ${disk.workerPid}`,
  );
  assert.match(
    docker("exec", disk.worker, "cat", `/proc/${disk.workerPid}/status`),
    /State:\s+T/,
  );
  let noSpace = false;
  try {
    docker(
      "exec",
      disk.worker,
      "dd",
      "if=/dev/zero",
      "of=/cache/fill",
      "bs=1M",
      "count=16",
    );
  } catch (error) {
    noSpace = String(error.stderr).includes("No space left on device");
  }
  assert.ok(noSpace, "isolated tmpfs must actually return ENOSPC");
  // Force FFmpeg to exit before the Worker can run its periodic capacity check.
  await until(
    () =>
      /State:\s+Z/.test(
        docker(
          "exec",
          disk.worker,
          "cat",
          disk.pid.replace("/comm", "/status"),
        ),
      ),
    "FFmpeg exited on full disk",
    20000,
  );
  docker(
    "exec",
    "--user",
    "0",
    disk.worker,
    "sh",
    "-c",
    `kill -CONT ${disk.workerPid}`,
  );
  await until(
    () =>
      ["failed", "succeeded", "cancelled"].includes(
        sql(`SELECT status FROM media_jobs WHERE id='${disk.id}'`),
      ),
    "disk-full terminal state",
  );
  assert.equal(
    sql(
      `SELECT status||':'||coalesce(error,'') FROM media_jobs WHERE id='${disk.id}'`,
    ),
    "failed:cache_capacity_exceeded",
  );
  assert.equal(ffmpegPids(disk.worker), "");
  report.cases.push({
    scenario: "disk_full_during_encoding",
    enospc: true,
    child_exited_before_health_check: true,
    error: "cache_capacity_exceeded",
    remaining_ffmpeg: 0,
  });
  docker("kill", "--signal=TERM", disk.worker);
  assert.equal(docker("wait", disk.worker), "0");
  console.log(
    "PASS: actual ENOSPC during encoding persists capacity failure after FFmpeg exits and is reaped",
  );
  const completed = await startWorker("complete", undefined, 1, true);
  await until(
    () =>
      sql(`SELECT status FROM media_jobs WHERE id='${completed.id}'`) ===
      "succeeded",
    "real complete output passes structural validation",
  );
  assert.equal(ffmpegPids(completed.worker), "");
  const publishedBytes = execFileSync(
    "docker",
    ["exec", completed.worker, "cat", `/cache/${completed.id}/1/index.m3u8`],
    { ...options, encoding: null },
  );
  const publishedDigest = createHash("sha256")
    .update(publishedBytes)
    .digest("hex");
  assert.equal(
    sql(
      `SELECT manifest_sha256 FROM media_outputs WHERE job_id='${completed.id}' AND attempt=1 AND status='published' AND validation_version=1 AND segment_count>0`,
    ),
    publishedDigest,
  );
  report.cases.push({
    scenario: "validated_complete_output",
    status: "succeeded",
  });
  docker("kill", "--signal=TERM", completed.worker);
  assert.equal(docker("wait", completed.worker), "0");
  const missing = await startWorker("missing", undefined, 1, true);
  docker(
    "exec",
    "--user",
    "0",
    missing.worker,
    "sh",
    "-c",
    `kill -STOP ${missing.workerPid}`,
  );
  assert.match(
    docker("exec", missing.worker, "cat", `/proc/${missing.workerPid}/status`),
    /State:\s+T/,
  );
  await until(
    () =>
      /State:\s+Z/.test(
        docker(
          "exec",
          missing.worker,
          "cat",
          missing.pid.replace("/comm", "/status"),
        ),
      ),
    "encoder finished before output tampering",
    20000,
  );
  docker("exec", missing.worker, "rm", `/cache/${missing.id}/1/index0.m4s`);
  docker(
    "exec",
    "--user",
    "0",
    missing.worker,
    "sh",
    "-c",
    `kill -CONT ${missing.workerPid}`,
  );
  await until(
    () =>
      ["succeeded", "failed"].includes(
        sql(`SELECT status FROM media_jobs WHERE id='${missing.id}'`),
      ),
    "missing output terminal state",
  );
  assert.equal(
    sql(
      `SELECT status||':'||coalesce(error,'') FROM media_jobs WHERE id='${missing.id}'`,
    ),
    "failed:media_job_failed",
  );
  assert.equal(ffmpegPids(missing.worker), "");
  assert.equal(
    sql(
      `SELECT status FROM media_outputs WHERE job_id='${missing.id}' AND attempt=1`,
    ),
    "failed",
  );
  report.cases.push({
    scenario: "missing_segment_after_encoder_exit",
    status: "failed",
  });
  docker("kill", "--signal=TERM", missing.worker);
  assert.equal(docker("wait", missing.worker), "0");
  console.log(
    "PASS: real completed output succeeds; missing segment after encoder exit prevents success",
  );
  const graceful = await startWorker("term");
  let started = Date.now();
  docker("kill", "--signal=TERM", graceful.worker);
  assert.equal(
    docker("wait", graceful.worker),
    "0",
    "SIGTERM must exit normally",
  );
  assert.equal(
    sql(
      `SELECT status||':'||attempt||':'||(owner_id IS NULL)::text FROM media_jobs WHERE id='${graceful.id}'`,
    ),
    "queued:1:true",
  );
  report.cases.push({
    scenario: "sigterm",
    pid: graceful.pid,
    elapsed_ms: Date.now() - started,
    exit_code: 0,
    released: true,
  });
  sql(`UPDATE playback_sessions SET stopped=true WHERE id='${graceful.id}'`);
  console.log(
    "PASS: SIGTERM during real HLS encoding exits normally and releases current attempt",
  );

  const lost = await startWorker("database");
  started = Date.now();
  docker("pause", db);
  await until(
    () => ffmpegPids(lost.worker) === "",
    "FFmpeg killed and reaped on stalled database",
    15000,
  );
  report.cases.push({
    scenario: "database_paused",
    pid: lost.pid,
    elapsed_ms: Date.now() - started,
    remaining_ffmpeg: 0,
  });
  docker("unpause", db);
  assert.equal(
    sql(`SELECT status FROM media_jobs WHERE id='${lost.id}'`),
    "running",
  );
  assert.equal(
    sql(`SELECT error IS NULL FROM media_jobs WHERE id='${lost.id}'`),
    "t",
  );
  sql(
    `UPDATE media_jobs SET lease_until=now()-interval '1 second' WHERE id='${lost.id}'`,
  );
  await until(
    () =>
      Number(sql(`SELECT attempt FROM media_jobs WHERE id='${lost.id}'`)) >= 2,
    "lease interruption retries instead of terminal encoding failure",
    20000,
  );
  sql(`UPDATE playback_sessions SET stopped=true WHERE id='${lost.id}'`);
  docker("kill", "--signal=TERM", lost.worker);
  assert.equal(docker("wait", lost.worker), "0");
  console.log(
    "PASS: database partition terminates real FFmpeg; no running or zombie FFmpeg remains",
  );
  const fullId = randomUUID(),
    fullWorker = `${name}-capacity`;
  sql(
    `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${fullId}',0,'${fullId}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${fullId}','${fullId}','queued','{"root":"/media","resource":"source.mp4","transcode":true}')`,
  );
  children.push(fullWorker);
  docker(
    "run",
    "-d",
    "--init",
    "--name",
    fullWorker,
    "--network",
    name,
    ...env,
    "-e",
    "CACHE_MAX_BYTES=0",
    "--mount",
    `type=bind,source=${root},target=/media,readonly`,
    image,
    "rainsync-media-worker",
  );
  await until(
    () =>
      sql(
        `SELECT status||':'||coalesce(error,'') FROM media_jobs WHERE id='${fullId}'`,
      ) === "failed:cache_capacity_exceeded",
    "quota refusal persists specific error",
  );
  assert.equal(ffmpegPids(fullWorker), "");
  report.cases.push({
    scenario: "cache_quota_zero",
    error: "cache_capacity_exceeded",
    remaining_ffmpeg: 0,
  });
  docker("kill", "--signal=TERM", fullWorker);
  assert.equal(docker("wait", fullWorker), "0");
  console.log(
    "PASS: real Worker quota check records capacity error and leaves no FFmpeg",
  );
  const old = await startWorker("old");
  docker(
    "exec",
    "--user",
    "0",
    old.worker,
    "sh",
    "-c",
    `kill -STOP ${old.workerPid}`,
  );
  assert.match(
    docker("exec", old.worker, "cat", `/proc/${old.workerPid}/status`),
    /State:\s+T/,
  );
  // The FFmpeg child continues while only the Worker process is suspended.
  await until(
    () =>
      sql(
        `SELECT lease_until<clock_timestamp() FROM media_jobs WHERE id='${old.id}'`,
      ) === "t",
    "real lease expiry",
    35000,
  );
  assert.ok(ffmpegPids(old.worker), "old FFmpeg must survive suspension");
  const replacement = await startWorker("replacement", old.id, 2);
  assert.equal(sql(`SELECT attempt FROM media_jobs WHERE id='${old.id}'`), "2");
  assert.equal(
    sql(
      `SELECT status FROM media_outputs WHERE job_id='${old.id}' AND attempt=1`,
    ),
    "abandoned",
  );
  assert.equal(
    sql(
      `SELECT status FROM media_outputs WHERE job_id='${old.id}' AND attempt=2`,
    ),
    "writing",
  );
  const init = await readFile(resolve(cache, old.id, "2", "init.mp4"));
  started = Date.now();
  docker(
    "exec",
    "--user",
    "0",
    old.worker,
    "sh",
    "-c",
    `kill -CONT ${old.workerPid}`,
  );
  await until(
    () => ffmpegPids(old.worker) === "",
    "resumed old worker reaps stale FFmpeg",
    12000,
  );
  assert.equal(
    sql(`SELECT attempt||':'||status FROM media_jobs WHERE id='${old.id}'`),
    "2:running",
  );
  assert.ok(ffmpegPids(replacement.worker));
  assert.deepEqual(
    await readFile(resolve(cache, old.id, "2", "init.mp4")),
    init,
  );
  report.cases.push({
    scenario: "expired_old_worker_resumed",
    elapsed_ms: Date.now() - started,
    current_attempt: 2,
    old_ffmpeg: 0,
    current_ffmpeg_running: true,
    init_sha256: createHash("sha256").update(init).digest("hex"),
  });
  docker("kill", "--signal=TERM", old.worker);
  assert.equal(docker("wait", old.worker), "0");
  docker("kill", "--signal=TERM", replacement.worker);
  assert.equal(docker("wait", replacement.worker), "0");
  console.log(
    "PASS: suspended Worker expires; replacement writes attempt 2; resumed old FFmpeg is reaped without changing current output",
  );
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${resolve(root, "report.json")}`);
} finally {
  try {
    docker("unpause", db);
  } catch {}
  for (const container of [...children, server, db]) {
    try {
      docker("rm", "-f", "-v", container);
    } catch {}
  }
  try {
    docker("network", "rm", name);
  } catch {}
}
