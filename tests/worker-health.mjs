import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { isolatedPostgres, verifyPidAbsent } from "./fixtures/postgres.mjs";

// A disposable PostgreSQL database and native test child, never a user service.
const runId = `rainsync-worker-health-${randomUUID().slice(0, 8)}`;
const native = Boolean(process.env.RAINSYNC_NATIVE_POSTGRES_BIN);
const root = resolve(
  native ? (process.env.RAINSYNC_ARTIFACT_DIR ?? ".runtime") : ".runtime",
  "worker-health",
  runId,
);
const database = runId.replaceAll("-", "_");
const password = randomBytes(24).toString("hex");
const image = process.env.WORKER_HEALTH_DATABASE_IMAGE ?? "postgres:17-alpine";
const nativeDatabase = native
  ? isolatedPostgres({
      root,
      name: "worker-health",
      id: runId.slice("rainsync-".length).replaceAll("-", "_"),
      password,
    })
  : null;
const exec = promisify(execFile);
const report = {
  schema_version: 1,
  run_id: runId,
  started_at: new Date().toISOString(),
  phase: "preparing",
  database_kind: native ? "native" : "docker",
  database_image: native ? null : image,
  commands: [],
  cleanup: [],
};
const redact = (value) => String(value).replaceAll(password, "[redacted]");
await mkdir(root, { recursive: true });
const save = () =>
  writeFile(resolve(root, "report.json"), JSON.stringify(report, null, 2));
const docker = async (args) => {
  const { stdout } = await exec("docker", args, {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const execute = async (command, args, name, env = process.env) => {
  const activity = {
    argv: [command, ...args],
    started_at: new Date().toISOString(),
  };
  report.commands.push(activity);
  await save();
  let stdout = "";
  let stderr = "";
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  activity.pid = child.pid ?? null;
  child.stdout.on("data", (bytes) => (stdout += bytes));
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const timer = setTimeout(
    () => {
      activity.timed_out = true;
      if (process.platform === "win32") {
        void exec("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10_000,
        }).catch(() => child.kill());
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    },
    name === "build" ? 300_000 : 120_000,
  );
  let code;
  try {
    code = await new Promise((done, failed) => {
      child.on("error", failed);
      child.on("close", (code, signal) => {
        activity.process_close_observed = true;
        activity.signal = signal;
        done(code);
      });
    });
  } finally {
    clearTimeout(timer);
  }
  activity.finished_at = new Date().toISOString();
  activity.exit_code = code;
  activity.pid_absent = !child.pid || verifyPidAbsent(child.pid);
  assert.equal(activity.pid_absent, true, "owned test/build child has exited");
  await writeFile(resolve(root, `${name}.stdout`), redact(stdout));
  await writeFile(resolve(root, `${name}.stderr`), redact(stderr));
  await save();
  assert.equal(code, 0, `${name} failed; see preserved stdout/stderr`);
  assert.notEqual(
    activity.timed_out,
    true,
    `${name} exceeded its bounded deadline`,
  );
  return stdout;
};

try {
  const ownFiles = [
    "apps/media-worker/src/process.rs",
    "apps/media-worker/src/main.rs",
    "apps/media-worker/src/output_publish.rs",
    "crates/persistence/src/media_jobs.rs",
  ];
  report.source = await Promise.all(
    ownFiles.map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    })),
  );
  report.phase = "building";
  const output = await execute(
    "cargo",
    [
      "test",
      "--locked",
      "-p",
      "rainsync-media-worker",
      "-j2",
      "--no-run",
      "--message-format=json",
    ],
    "build",
  );
  let binary;
  for (const line of output.split(/\r?\n/)) {
    const item = JSON.parse(line || "{}");
    if (
      item.reason === "compiler-artifact" &&
      item.target?.name === "rainsync-media-worker" &&
      item.profile?.test
    ) {
      binary = item.executable;
    }
  }
  assert.ok(binary, "native Worker test executable was built");
  const binarySource = resolve(binary);
  binary = resolve(
    root,
    `worker-test-under-test${process.platform === "win32" ? ".exe" : ""}`,
  );
  await copyFile(binarySource, binary);
  report.test_binary = {
    source: binarySource,
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  };
  report.phase = "database-starting";
  await save();
  let databaseUrl;
  if (nativeDatabase) {
    await nativeDatabase.start();
    assert.equal(nativeDatabase.database, database);
    report.postgresql = nativeDatabase.diagnostics();
    databaseUrl = nativeDatabase.url;
  } else {
    await docker([
      "run",
      "--detach",
      "--name",
      runId,
      "--label",
      `org.rainsync.worker-health=${runId}`,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=rainsync",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      `POSTGRES_DB=${database}`,
      image,
    ]);
    report.database_image_id = await docker([
      "inspect",
      "--format",
      "{{.Image}}",
      runId,
    ]);
    const address = await docker(["port", runId, "5432/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1];
    assert.ok(
      port,
      "database is bound only to loopback on an owned random port",
    );
    const began = performance.now();
    while (true) {
      try {
        await docker([
          "exec",
          runId,
          "pg_isready",
          "-U",
          "rainsync",
          "-d",
          database,
        ]);
        break;
      } catch {
        assert.ok(
          performance.now() - began < 30_000,
          "test database became ready",
        );
        await delay(200);
      }
    }
    databaseUrl = `postgres://rainsync:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
  }
  report.phase = "testing";
  await execute(
    binary,
    [
      "--ignored",
      "--exact",
      "process::tests::postgres_worker_health",
      "--nocapture",
    ],
    "regression",
    {
      ...process.env,
      RAINSYNC_ISOLATED_TEST: "1",
      WORKER_HEALTH_DATABASE_URL: databaseUrl,
      WORKER_HEALTH_REPORT: resolve(root, "cases.json"),
    },
  );
  report.cases = JSON.parse(
    await readFile(resolve(root, "cases.json"), "utf8"),
  );
  assert.equal(report.cases.length, 6);
  report.final_test_binary_sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  assert.equal(
    report.final_test_binary_sha256,
    report.test_binary.sha256,
    "executed binary identity remained stable",
  );
  for (const source of report.source) {
    source.final_sha256 = createHash("sha256")
      .update(await readFile(source.path))
      .digest("hex");
    assert.equal(
      source.final_sha256,
      source.sha256,
      "worker health source remained unchanged during execution",
    );
  }
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  report.phase = "cleanup";
  if (nativeDatabase) {
    try {
      await nativeDatabase.stop();
      report.cleanup.push(await nativeDatabase.verifyStopped());
    } catch (error) {
      report.cleanup.push({
        kind: "native",
        stopped: false,
        error: redact(error.message),
      });
      report.result = "failed";
      process.exitCode = 1;
    }
  } else {
    try {
      await writeFile(
        resolve(root, "postgres.log"),
        redact(await docker(["logs", runId])),
      );
    } catch {
      // Container creation failures still reach the same named cleanup below.
    }
    try {
      const owned = await docker([
        "ps",
        "--all",
        "--filter",
        `label=org.rainsync.worker-health=${runId}`,
        "--format",
        "{{.Names}}",
      ]);
      let volumes = [];
      if (owned) {
        assert.equal(
          owned,
          runId,
          "cleanup owns only its exact random namespace",
        );
        volumes = JSON.parse(
          await docker(["inspect", "--format", "{{json .Mounts}}", runId]),
        )
          .filter((mount) => mount.Type === "volume")
          .map((mount) => mount.Name);
        await docker(["rm", "--force", "--volumes", runId]);
      }
      const remaining = await docker([
        "ps",
        "--all",
        "--filter",
        `label=org.rainsync.worker-health=${runId}`,
        "--format",
        "{{.Names}}",
      ]);
      assert.equal(remaining, "");
      const volumeChecks = [];
      for (const volume of volumes) {
        const names = await docker([
          "volume",
          "ls",
          "--filter",
          `name=${volume}`,
          "--format",
          "{{.Name}}",
        ]);
        assert.ok(
          !names.split(/\r?\n/).includes(volume),
          "owned volume was removed",
        );
        volumeChecks.push({ name: volume, removed: true });
      }
      report.cleanup.push({
        container: runId,
        removed: true,
        already_removed: !owned,
        remaining,
        volumes: volumeChecks,
      });
    } catch (error) {
      report.cleanup.push({
        container: runId,
        removed: false,
        error: redact(error.message),
      });
      report.result = "failed";
      process.exitCode = 1;
    }
  }
  report.phase = "finished";
  report.finished_at = new Date().toISOString();
  await save();
  console.log(
    `${report.result.toUpperCase()}: Worker health; evidence ${resolve(root, "report.json")}`,
  );
}
