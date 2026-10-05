import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID();
const database = `rainsync_pending_${runId.replaceAll("-", "")}`;
const evidence = join(root, ".runtime", "0044-rust", runId);
const target = join(root, ".runtime", "0044-rust-target");
mkdirSync(evidence, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schemaVersion: 1,
  runId,
  database,
  startedAt: new Date().toISOString(),
  scope: "production-rust-database-functions",
  commands: [],
  cleanup: {},
  limitations: [
    "Synthetic ciphertext and validated graph statements",
    "No Server HTTP builder acceptance",
    "No scanner or active physical capture; actual NeverStarted proof only",
    "No HLS activation or actual playback",
    "Historical unknown F2/HLS responsibilities remain unchanged",
  ],
};
const checkpoint = () =>
  writeFileSync(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
let number = 0;
let container;

async function command(
  program,
  args,
  { input, env = {}, timeout = 30000, allowFailure = false, live = false } = {},
) {
  const started = performance.now();
  const child = spawn(program, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    timedOut = false;
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
    if (live) process.stdout.write(bytes);
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
    if (live) process.stderr.write(bytes);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const result = await new Promise((done) => {
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeout)
        : undefined;
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ error: error.message });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      done({ status, signal });
    });
  });
  const record = {
    program,
    args,
    elapsedMs: Math.round(performance.now() - started),
    ...result,
    timedOut,
    inputSha256: input === undefined ? undefined : hash(input),
    stdout,
    stderr,
  };
  const path = `${String(++number).padStart(3, "0")}.json`;
  writeFileSync(join(evidence, path), JSON.stringify(record, null, 2) + "\n");
  report.commands.push({
    path,
    sha256: hash(readFileSync(join(evidence, path))),
  });
  checkpoint();
  if (!allowFailure && (result.status !== 0 || result.error || timedOut))
    throw new Error(
      `${program} failed (${result.status}): ${stderr || result.error || "timeout"}`,
    );
  return record;
}
async function sql(input, options = {}) {
  return command(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-A",
      "-t",
      "-f",
      "-",
    ],
    { ...options, input },
  );
}

try {
  report.sourceCommit = (
    await command("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  report.worktreeStatus = (await command("git", ["status", "--short"])).stdout;
  const all = (
    await command("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
  ).stdout
    .trim()
    .split(/\r?\n/);
  const paths = [
    ...new Set(
      all.filter(
        (path) =>
          /^(apps|crates)\/.*(\.rs|Cargo\.toml|\.json)$/.test(path) ||
          /^migrations\/.*\.sql$/.test(path) ||
          [
            "Cargo.toml",
            "Cargo.lock",
            "tests/static-hls-pending-rust.mjs",
            "tests/sql/static_hls_pending_custody.sql",
          ].includes(path),
      ),
    ),
  ].sort();
  report.inputs = paths.map((path) => ({
    path,
    sha256: hash(readFileSync(join(root, path))),
  }));
  report.rustc = (await command("rustc", ["-vV"])).stdout;
  console.log("Building isolated Rust production-function driver...");
  await command(
    "cargo",
    [
      "build",
      "--offline",
      "--locked",
      "-p",
      "persistence",
      "--example",
      "verify_static_hls_pending",
    ],
    {
      timeout: 0,
      live: true,
      env: {
        CARGO_TARGET_DIR: target,
        CARGO_INCREMENTAL: "0",
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
      },
    },
  );
  const binary = join(
    target,
    "debug",
    "examples",
    `verify_static_hls_pending${process.platform === "win32" ? ".exe" : ""}`,
  );
  report.binary = { path: binary, sha256: hash(readFileSync(binary)) };
  const image = JSON.parse(
    (
      await command("docker", [
        "image",
        "inspect",
        process.env.RAINSYNC_SQL_POSTGRES_IMAGE || "postgres:17",
      ])
    ).stdout,
  )[0];
  assert.equal(image.Os, "linux");
  assert.equal(image.Config.StopSignal, "SIGINT");
  report.image = {
    id: image.Id,
    repoDigests: image.RepoDigests,
    stopSignal: image.Config.StopSignal,
  };
  container = (
    await command("docker", [
      "create",
      "--name",
      `rainsync-pending-rust-${runId}`,
      "--label",
      `io.rainsync.rust-run=${runId}`,
      "--network",
      "bridge",
      "--publish",
      "127.0.0.1::5432",
      "--memory",
      "1g",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=536870912",
      "--tmpfs",
      "/var/run/postgresql",
      "--tmpfs",
      "/tmp",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      `POSTGRES_DB=${database}`,
      image.Id,
    ])
  ).stdout.trim();
  assert.match(container, /^[0-9a-f]{64}$/);
  report.containerId = container;
  checkpoint();
  await command("docker", ["start", container]);
  const started = JSON.parse(
    (await command("docker", ["inspect", container])).stdout,
  )[0];
  const binding = started.NetworkSettings.Ports["5432/tcp"];
  assert.equal(binding.length, 1);
  assert.equal(binding[0].HostIp, "127.0.0.1");
  assert.match(binding[0].HostPort, /^\d+$/);
  report.port = binding[0].HostPort;
  let ready = false;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const result = await sql("SELECT 1;", {
      timeout: 3000,
      allowFailure: true,
    });
    if (result.status === 0 && result.stdout.trim() === "1") {
      ready = true;
      break;
    }
    await delay(200);
  }
  assert.ok(ready, "final TCP PostgreSQL listener never became ready");
  report.postgresVersion = (await sql("SHOW server_version;")).stdout.trim();
  for (const { path } of report.inputs.filter(({ path }) =>
    /^migrations\//.test(path),
  )) {
    await sql(`BEGIN;\n${readFileSync(join(root, path), "utf8")}\nCOMMIT;`);
  }
  await sql(`CREATE TABLE rainsync_owned_test_binding(singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL);
    INSERT INTO rainsync_owned_test_binding VALUES(true,'${runId}');`);
  await command(binary, [], {
    timeout: 120000,
    live: true,
    env: {
      RAINSYNC_OWNED_TEST_RUN_ID: runId,
      RAINSYNC_OWNED_TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${report.port}/${database}`,
      RAINSYNC_OWNED_TEST_REPORT: join(evidence, "driver.json"),
    },
  });
  report.driver = JSON.parse(
    readFileSync(join(evidence, "driver.json"), "utf8"),
  );
  assert.equal(report.driver.runId, runId);
  assert.equal(report.driver.complete, true);
  const others = (
    await sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
    AND application_name='rs_pending_rust_${runId.replaceAll("-", "")}';`)
  ).stdout.trim();
  assert.equal(
    others,
    "0",
    "Rust pool left an original backend connection open",
  );
  report.inputsUnchanged = report.inputs.every(
    ({ path, sha256 }) => hash(readFileSync(join(root, path))) === sha256,
  );
  assert.ok(
    report.inputsUnchanged,
    "sources changed during build or execution",
  );
  assert.equal(
    hash(readFileSync(binary)),
    report.binary.sha256,
    "driver binary changed during execution",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  if (readFileSyncSafe(join(evidence, "driver.json")))
    report.driver = JSON.parse(
      readFileSync(join(evidence, "driver.json"), "utf8"),
    );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (container) {
    try {
      const before = JSON.parse(
        (await command("docker", ["inspect", container])).stdout,
      )[0];
      assert.equal(before.Id, container);
      assert.equal(before.Config.Labels["io.rainsync.rust-run"], runId);
      await command("docker", ["stop", "--time", "10", container]);
      const stopped = JSON.parse(
        (await command("docker", ["inspect", container])).stdout,
      )[0];
      report.cleanup = {
        id: stopped.Id,
        state: stopped.State,
        tmpfs: stopped.HostConfig.Tmpfs,
        mounts: stopped.Mounts,
      };
      const logs = await command("docker", ["logs", container]);
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.Pid, 0);
      assert.equal(stopped.State.ExitCode, 0);
      assert.equal(stopped.State.OOMKilled, false);
      assert.equal(stopped.Mounts.length, 0);
      assert.equal(
        stopped.HostConfig.Tmpfs["/var/lib/postgresql/data"],
        "rw,size=536870912",
      );
      assert.match(logs.stdout + logs.stderr, /database system is shut down/);
      assert.doesNotMatch(
        logs.stdout + logs.stderr,
        /abnormal database system shutdown/,
      );
      await command("docker", ["rm", container]);
      report.cleanup.removed = true;
    } catch (error) {
      report.cleanup.error = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  checkpoint();
  console.log(`Evidence: ${join(evidence, "report.json")}`);
}
function readFileSyncSafe(path) {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
