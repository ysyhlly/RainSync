import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { processTrees } from "./process-trees.mjs";
import { execFileSync } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
} from "node:crypto";
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
const sourceKey = randomBytes(32);
const env = [
  "-e",
  `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
  "-e",
  `SOURCE_ENCRYPTION_KEY=${sourceKey.toString("base64")}`,
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
async function cacheAccessFaults() {
  for (const [scenario, mount, expected, reason] of [
    [
      "read-only-cache",
      "/cache:ro,size=64m,uid=10001,gid=10001,mode=0700",
      /Read-only file system/,
      "cache_read_only",
    ],
    [
      "unwritable-cache",
      "/cache:rw,size=64m,uid=10001,gid=10001,mode=0500",
      /Permission denied/,
      "cache_permission_denied",
    ],
  ]) {
    const id = randomUUID();
    const worker = `${name}-${scenario}`;
    // Small reservation keeps the test focused on access failure, not admission.
    sql(
      `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"root":"/media","resource":"source.mp4","transcode":true,"estimated_output_bytes":65536,"start_seconds":150}')`,
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
      "0.5",
      "--memory",
      "512m",
      ...env,
      "--mount",
      `type=bind,source=${root},target=/media,readonly`,
      "--tmpfs",
      mount,
      image,
      "rainsync-media-worker",
    );
    assert.equal(docker("exec", worker, "id", "-u"), "10001");
    let failure;
    try {
      docker("exec", worker, "touch", "/cache/access-probe");
    } catch (error) {
      failure = String(error.stderr);
    }
    assert.match(
      failure ?? "unexpectedly writable",
      expected,
      "confirm the actual filesystem failure",
    );
    await until(
      () => sql(`SELECT status FROM media_jobs WHERE id='${id}'`) === "failed",
      `${scenario} reaches a terminal state`,
    );
    assert.equal(sql(`SELECT error FROM media_jobs WHERE id='${id}'`), reason);
    assert.equal(
      sql(
        `SELECT count(*) FROM media_outputs WHERE job_id='${id}' AND visible_manifest IS NOT NULL`,
      ),
      "0",
    );
    assert.equal(
      sql(`SELECT count(*) FROM cache_write_reservations WHERE job_id='${id}'`),
      "0",
    );
    assert.equal(
      ffmpegPids(worker),
      "",
      "filesystem failure leaves no live or zombie encoder",
    );
    assert.equal(
      docker("inspect", "-f", "{{.State.Running}}", worker),
      "true",
      "one unwritable cache job does not crash the Worker",
    );
    docker("stop", "--time", "5", worker);
    assert.equal(docker("inspect", "-f", "{{.State.ExitCode}}", worker), "0");
    sql(`UPDATE playback_sessions SET stopped=true WHERE id='${id}'`);
    report.cases.push({
      scenario,
      access_error_confirmed: true,
      no_published_output: true,
      reservation_released: true,
      no_encoder_remaining: true,
      failure_reason: reason,
      normal_shutdown: true,
    });
  }
  console.log(
    "PASS: real read-only and unwritable tmpfs caches fail without published output, leaked reservation or surviving FFmpeg",
  );
}
async function firstDecodeFaults() {
  for (const scenario of [
    "invalid-init",
    "decoder-timeout",
    "decoder-shutdown",
  ]) {
    const id = randomUUID();
    const worker = `${name}-${scenario}`;
    const shim = resolve(root, scenario);
    const volume = resolve(root, `${scenario}-cache`);
    await mkdir(shim);
    await mkdir(volume);
    const script =
      scenario === "invalid-init"
        ? [
            "#!/bin/bash",
            "set -e",
            'case " $* " in *" framehash "*) echo started > /cache/decode-ran; exec /usr/bin/ffmpeg "$@" ;; esac',
            'args=("$@")',
            'out="${args[-1]}"',
            'dir="$(dirname "$out")"',
            '/usr/bin/ffmpeg "${args[@]:0:${#args[@]}-1}" -hls_segment_filename "$dir/index%d.m4s" "$dir/private.m3u8"',
            // Valid nonempty top-level ftyp/moov boxes, but no decodable movie inside.
            "printf '\\000\\000\\000\\011ftyp\\000\\000\\000\\000\\011moov\\000' > \"$dir/init.mp4\"",
            'mv "$dir/private.m3u8" "$out"',
          ]
        : [
            "#!/bin/sh",
            'case " $* " in *" framehash "*) echo $$ > /cache/decoder.pid; exec sleep 120 ;; esac',
            'exec /usr/bin/ffmpeg "$@"',
          ];
    await writeFile(resolve(shim, "ffmpeg"), script.join("\n") + "\n", {
      mode: 0o755,
    });
    sql(
      `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"root":"/media","resource":"source.mp4","transcode":true,"estimated_output_bytes":268435456,"start_seconds":150}')`,
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
      "1",
      "--memory",
      "512m",
      ...env,
      "-e",
      `PATH=/media/${scenario}:/usr/local/bin:/usr/bin:/bin`,
      "--mount",
      `type=bind,source=${root},target=/media,readonly`,
      "--mount",
      `type=bind,source=${volume},target=/cache`,
      image,
      "rainsync-media-worker",
    );
    if (scenario === "invalid-init") {
      await until(
        () =>
          sql(`SELECT status FROM media_jobs WHERE id='${id}'`) === "failed",
        "undecodable first fragment fails publication",
        45000,
      );
      assert.equal(
        sql(`SELECT error FROM media_jobs WHERE id='${id}'`),
        "media_job_failed",
      );
      docker("exec", worker, "test", "-f", "/cache/decode-ran");
    } else {
      await until(
        () => {
          try {
            docker("exec", worker, "test", "-f", "/cache/decoder.pid");
            return true;
          } catch {
            return false;
          }
        },
        "first-fragment decoder started",
        45000,
      );
      const decoder = docker("exec", worker, "cat", "/cache/decoder.pid");
      assert.match(decoder, /^\d+$/);
      if (scenario === "decoder-timeout") {
        await until(
          () => {
            try {
              docker("exec", worker, "test", "!", "-e", `/proc/${decoder}`);
              return ffmpegPids(worker) === "";
            } catch {
              return false;
            }
          },
          "decode deadline reaps decoder and encoder",
          20000,
        );
        assert.equal(
          sql(`SELECT status FROM media_jobs WHERE id='${id}'`),
          "running",
          "deadline retains recoverable execution lease",
        );
      }
    }
    assert.equal(
      sql(
        `SELECT visible_manifest IS NULL AND ready_segments=0 FROM media_outputs WHERE job_id='${id}' AND attempt=1`,
      ),
      "t",
    );
    const shutdownAt = Date.now();
    docker("kill", "--signal=TERM", worker);
    assert.equal(docker("wait", worker), "0");
    if (scenario === "decoder-shutdown") {
      assert.ok(
        Date.now() - shutdownAt < 5000,
        "shutdown must not wait for the ten-second decode deadline",
      );
      assert.equal(
        sql(`SELECT status FROM media_jobs WHERE id='${id}'`),
        "queued",
      );
    }
    assert.equal(
      sql(`SELECT count(*) FROM cache_write_reservations WHERE job_id='${id}'`),
      "0",
    );
    sql(
      `UPDATE playback_sessions SET stopped=true WHERE id='${id}'; UPDATE media_jobs SET status='cancelled',owner_id=NULL,lease_until=NULL WHERE id='${id}'`,
    );
    report.cases.push({
      scenario,
      visible_before_decode: false,
      normal_shutdown: true,
    });
  }
  console.log(
    "PASS: undecodable first init cannot publish; decoder deadline reaps both children and stays recoverable; shutdown interrupts pending decode",
  );
}
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
      // Deliberately underestimate the tiny-volume case to retain actual ENOSPC
      // coverage after admission control; this is not the Server's estimate.
      `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"root":"/media","resource":"source.mp4","transcode":true,"estimated_output_bytes":${tinyCache ? 1048576 : 268435456},"start_seconds":${tinyCache ? 150 : 0}}')`,
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
    ...(scenario === "complete" ? ["-p", "127.0.0.1::8081"] : []),
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
          "SELECT count(*) FROM _sqlx_migrations WHERE version=17 AND success",
        ) === "1"
      );
    } catch {
      return false;
    }
  }, "production migrations");

  await firstDecodeFaults();
  await cacheAccessFaults();
  await processTrees({ docker, image, root, env, name, sql, children, until, report });

  const evictionCache = resolve(root, "eviction-cache");
  const protectedId = randomUUID(),
    idleId = randomUUID(),
    triggerId = randomUUID();
  for (const id of [protectedId, idleId]) {
    await mkdir(resolve(evictionCache, id), { recursive: true });
    await writeFile(
      resolve(evictionCache, id, "segment"),
      Buffer.alloc(1024 * 1024),
    );
  }
  sql(`INSERT INTO cache_entries(id,cache_key,path) VALUES('${protectedId}','${protectedId}','${protectedId}');
    INSERT INTO cache_read_leases(id,cache_id,expires_at) VALUES(gen_random_uuid(),'${protectedId}',now()+interval '1 hour');
    INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${triggerId}',0,'${triggerId}','{}',now()+interval '1 hour');
    INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${triggerId}','${triggerId}','queued','{"root":"/media","resource":"absent.mp4"}')`);
  const cleaner = `${name}-eviction`;
  children.push(cleaner);
  docker(
    "run",
    "-d",
    "--name",
    cleaner,
    "--network",
    name,
    ...env,
    "-e",
    "CACHE_MAX_BYTES=1048576",
    "--mount",
    `type=bind,source=${evictionCache},target=/cache`,
    "--mount",
    `type=bind,source=${root},target=/media,readonly`,
    image,
    "rainsync-media-worker",
  );
  await until(
    () =>
      sql(`SELECT status FROM media_jobs WHERE id='${triggerId}'`) === "failed",
    "protected reader keeps quota occupied",
  );
  assert.equal(
    sql(`SELECT error FROM media_jobs WHERE id='${triggerId}'`),
    "cache_capacity_exceeded",
  );
  assert.equal(
    sql(`SELECT state FROM cache_entries WHERE id='${idleId}'`),
    "evicted",
  );
  docker("exec", cleaner, "test", "-f", `/cache/${protectedId}/segment`);
  docker("exec", cleaner, "test", "!", "-e", `/cache/${idleId}`);
  docker("stop", "--time", "10", cleaner);
  sql(
    `UPDATE cache_read_leases SET expires_at=now()-interval '1 second' WHERE cache_id='${protectedId}'; UPDATE media_jobs SET status='queued' WHERE id='${triggerId}'`,
  );
  docker("start", cleaner);
  await until(
    () =>
      sql(`SELECT state FROM cache_entries WHERE id='${protectedId}'`) ===
      "evicted",
    "crashed reader expiry permits cleanup",
  );
  docker("exec", cleaner, "test", "!", "-e", `/cache/${protectedId}`);
  docker("stop", "--time", "10", cleaner);
  const interrupted = randomUUID();
  sql(
    `INSERT INTO cache_entries(id,cache_key,path,state,eviction_owner,eviction_until) VALUES('${interrupted}','${interrupted}','${interrupted}','evicting',gen_random_uuid(),now()-interval '1 second'); UPDATE media_jobs SET status='queued' WHERE id='${triggerId}'`,
  );
  docker("start", cleaner);
  await until(
    () =>
      sql(`SELECT state FROM cache_entries WHERE id='${interrupted}'`) ===
      "evicted",
    "recover deletion completed before database acknowledgement even without quota pressure",
  );
  docker("stop", "--time", "10", cleaner);
  report.cases.push({
    scenario: "cache_reader_eviction",
    protected_during_lease: true,
    idle_removed: true,
    expired_reader_removed: true,
    interrupted_deletion_reconciled: true,
  });
  console.log(
    "PASS: real cache deletion skips leased files and reclaims them after lease expiry",
  );

  const admissionCache = resolve(root, "admission-cache"),
    idleBudget = randomUUID();
  await mkdir(resolve(admissionCache, idleBudget), { recursive: true });
  await writeFile(
    resolve(admissionCache, idleBudget, "idle"),
    Buffer.alloc(3 * 1024 * 1024),
  );
  const budgetWorker = `${name}-admission`;
  const addBudgetJob = (bytes) => {
    const id = randomUUID();
    sql(
      `INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}',0,'${id}','{}',now()+interval '1 hour'); INSERT INTO media_jobs(id,session_id,status,spec) VALUES('${id}','${id}','queued','{"root":"/media","resource":"absent.mp4","estimated_output_bytes":${bytes}}')`,
    );
    return id;
  };
  const oversized = addBudgetJob(8 * 1024 * 1024);
  children.push(budgetWorker);
  docker(
    "run",
    "-d",
    "--name",
    budgetWorker,
    "--network",
    name,
    ...env,
    "-e",
    "CACHE_MAX_BYTES=4194304",
    "--mount",
    `type=bind,source=${admissionCache},target=/cache`,
    "--mount",
    `type=bind,source=${root},target=/media,readonly`,
    image,
    "rainsync-media-worker",
  );
  await until(
    () =>
      sql(`SELECT status FROM media_jobs WHERE id='${oversized}'`) === "failed",
    "oversized output admission rejected",
  );
  assert.equal(
    sql(`SELECT error FROM media_jobs WHERE id='${oversized}'`),
    "cache_capacity_exceeded",
  );
  docker("exec", budgetWorker, "test", "-f", `/cache/${idleBudget}/idle`);
  assert.equal(ffmpegPids(budgetWorker), "");
  const reclaimable = addBudgetJob(2 * 1024 * 1024);
  await until(
    () =>
      sql(`SELECT status FROM media_jobs WHERE id='${reclaimable}'`) ===
      "failed",
    "reservation passes after reclaim and then encounters controlled missing input",
  );
  assert.equal(
    sql(`SELECT error FROM media_jobs WHERE id='${reclaimable}'`),
    "media_job_failed",
  );
  assert.equal(
    sql(`SELECT state FROM cache_entries WHERE id='${idleBudget}'`),
    "evicted",
  );
  await until(
    () =>
      sql(
        `SELECT count(*) FROM cache_write_reservations WHERE job_id='${reclaimable}'`,
      ) === "0",
    "preparation failure releases reservation",
  );
  docker("stop", "--time", "10", budgetWorker);
  report.cases.push({
    scenario: "cache_write_admission",
    oversized_rejected: true,
    reclaimable_idle_evicted: true,
    failed_preparation_released: true,
  });
  console.log(
    "PASS: output admission rejects oversized jobs, reclaims idle cache and releases failed preparations",
  );

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
  assert.equal(
    sql(
      `SELECT count(*) FROM cache_write_reservations WHERE job_id='${disk.id}'`,
    ),
    "0",
  );
  console.log(
    "PASS: actual ENOSPC during encoding persists capacity failure after FFmpeg exits and is reaped",
  );
  const completed = await startWorker("complete", undefined, 1, true);
  const room = randomUUID();
  const user = sql("SELECT id FROM users WHERE admin LIMIT 1");
  const deliveryToken = randomBytes(24).toString("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sourceKey, nonce);
  const encrypted = Buffer.concat([
    nonce,
    cipher.update(JSON.stringify({ job_id: completed.id })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  sql(`INSERT INTO rooms(id,name,owner_id) VALUES('${room}','Output validation','${user}');
    INSERT INTO room_members(room_id,user_id) VALUES('${room}','${user}');
    INSERT INTO room_snapshots(room_id,state) VALUES('${room}','{"media_generation":0}');
    UPDATE playback_sessions SET user_id='${user}',room_id='${room}',delivery_token_hash='${createHash("sha256").update(deliveryToken).digest("hex")}',resource=jsonb_build_object('encrypted','${encrypted}') WHERE id='${completed.id}'`);
  const deliveryOrigin = `http://${docker("port", completed.worker, "8081/tcp")}`;
  const deliveryPath = `/media-delivery/${completed.id}/index.m3u8?token=${deliveryToken}`;
  const encoderPid = completed.pid.split("/")[2];
  docker("exec", completed.worker, "sh", "-c", `kill -STOP ${encoderPid}`);
  try {
    assert.equal(
      sql(`SELECT status FROM media_jobs WHERE id='${completed.id}'`),
      "running",
    );
    const live = await fetch(deliveryOrigin + deliveryPath);
    assert.equal(live.status, 200);
    const liveManifest = await live.text();
    assert.ok(!liveManifest.includes("#EXT-X-ENDLIST"));
    const firstSegment = liveManifest
      .split("\n")
      .find((line) => line.startsWith("/"));
    assert.ok(firstSegment);
    const segment = await fetch(deliveryOrigin + firstSegment);
    assert.equal(segment.status, 200);
    const segmentBytes = Buffer.from(await segment.arrayBuffer());
    assert.ok(segmentBytes.length > 0);
    assert.equal(
      sql(
        `SELECT size_bytes||':'||sha256 FROM media_output_files WHERE job_id='${completed.id}' AND attempt=1 AND segment_index=0`,
      ),
      `${segmentBytes.length}:${createHash("sha256").update(segmentBytes).digest("hex")}`,
    );
    assert.equal(
      sql(
        `SELECT count(*)=o.ready_segments+1 FROM media_outputs o JOIN media_output_files f ON f.job_id=o.job_id AND f.attempt=o.attempt WHERE o.job_id='${completed.id}' AND o.attempt=1 GROUP BY o.ready_segments`,
      ),
      "t",
    );
    const privatePath = `/cache/${completed.id}/1/index.m3u8`;
    const privateManifest =
      docker("exec", completed.worker, "cat", privatePath) + "\n";
    try {
      docker(
        "exec",
        completed.worker,
        "sh",
        "-c",
        'printf %s "$1" > "$2"',
        "sh",
        "#EXTM",
        privatePath,
      );
      const duringRewrite = await fetch(deliveryOrigin + deliveryPath);
      assert.equal(
        duringRewrite.status,
        200,
        "committed live snapshot survives a torn encoder playlist",
      );
      assert.ok((await duringRewrite.text()).includes("index0.m4s"));
    } finally {
      docker(
        "exec",
        completed.worker,
        "sh",
        "-c",
        'printf %s "$1" > "$2"',
        "sh",
        privateManifest,
        privatePath,
      );
    }
  } finally {
    docker("exec", completed.worker, "sh", "-c", `kill -CONT ${encoderPid}`);
  }
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
      `SELECT manifest_sha256 FROM media_outputs WHERE job_id='${completed.id}' AND attempt=1 AND status='published' AND validation_version=3 AND segment_count>0`,
    ),
    publishedDigest,
  );
  const published = await fetch(deliveryOrigin + deliveryPath);
  assert.equal(published.status, 200);
  const deliveredManifest = await published.text();
  assert.ok(deliveredManifest.includes("#EXT-X-ENDLIST"));
  const segmentUrl = deliveredManifest
    .split("\n")
    .find((line) => line.startsWith("/"));
  const initUrl = deliveredManifest.match(/URI="([^"]+)"/)[1];
  for (const child of [initUrl, segmentUrl]) {
    assert.equal(
      (await fetch(deliveryOrigin + child, { method: "HEAD" })).status,
      200,
    );
    const range = await fetch(deliveryOrigin + child, {
      headers: { Range: "bytes=0-7" },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 8);
  }
  docker(
    "exec",
    completed.worker,
    "ffmpeg",
    "-v",
    "error",
    "-nostdin",
    "-i",
    `http://127.0.0.1:8081${deliveryPath}`,
    "-f",
    "null",
    "-",
  );
  report.cases.push({
    scenario: "incremental_output_delivery",
    live_segment: true,
    completed_http_decode: true,
    range_and_head: true,
    persisted_live_snapshot: true,
    segment_sha256_matches: true,
  });
  console.log(
    "PASS: real live HLS segments pass incremental checks; completed HTTP playlist decodes with Range and HEAD enabled",
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
  assert.equal(
    sql(
      `SELECT count(*) FROM cache_write_reservations WHERE job_id='${graceful.id}'`,
    ),
    "0",
    "SIGTERM releases the reaped writer's budget",
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
  await until(
    () => !existsSync(resolve(cache, old.id, "1")),
    "obsolete output reclaimed while replacement session remains active",
    15000,
  );
  assert.deepEqual(await readFile(resolve(cache, old.id, "2", "init.mp4")), init);
  report.cases.push({
    scenario: "expired_old_worker_resumed",
    elapsed_ms: Date.now() - started,
    current_attempt: 2,
    old_ffmpeg: 0,
    current_ffmpeg_running: true,
    obsolete_directory_removed: true,
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
