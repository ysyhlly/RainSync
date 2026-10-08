import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

// Required local fixture configuration; no machine-specific defaults.
const runtime = (() => {
  const required = (name, pattern, description) => {
    const value = process.env[name];
    assert.ok(
      typeof value === "string" && value.length <= 4096 &&
        !/[\x00-\x1f\x7f]/.test(value) && pattern.test(value),
      `Set ${name} to ${description}`,
    );
    return value;
  };
  const absolutePath = (name) => required(
    name,
    /^(?:\/[^\x00-\x1f\x7f:]+|[A-Za-z]:[\\/][^\x00-\x1f\x7f:]+)$/,
    "an absolute local fixture path without control characters",
  );
  const imageReference = (name) => required(
    name,
    /^(?:sha256:[0-9a-f]{64}|(?=.{1,255}$)(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?)$/,
    "a valid local Docker image reference",
  );
  const imageId = (name) => required(
    name, /^sha256:[0-9a-f]{64}$/, "an exact local sha256 image ID",
  );
  return Object.freeze({
    image: imageReference("RAINSYNC_NATIVE_TEST_IMAGE"),
    registry: absolutePath("RAINSYNC_OWNER_TEST_REGISTRY"),
    cargoConfig: absolutePath("RAINSYNC_OWNER_TEST_CARGO_CONFIG"),
    postgresImage: imageReference("RAINSYNC_SQL_POSTGRES_IMAGE"),
    imageId: imageId("RAINSYNC_NATIVE_TEST_IMAGE_ID"),
    postgresImageId: imageId("RAINSYNC_SQL_POSTGRES_IMAGE_ID"),
  });
})();
// End required fixture configuration.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID();
const database = `rainsync_pending_${runId.replaceAll("-", "")}`;
const evidence = join(root, ".runtime", "public-prepare", runId);
const target = join(root, ".runtime", "public-prepare-target");
mkdirSync(evidence, { recursive: true });
mkdirSync(target, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schemaVersion: 1,
  runId,
  database,
  scope: "actual-server-public-prepare-and-ordinary-fallback",
  startedAt: new Date().toISOString(),
  commands: [],
  cleanup: {},
  limitations: [
    "Owned synthetic login/source/room; production Server handlers and actual Worker, no deployment",
    "First prepare and ordinary fallback only; child, recipe, queue, selection and rollout excluded",
    "No historical responsibility closure or long soak",
  ],
};
const save = () =>
  writeFileSync(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
let number = 0,
  postgres,
  builder,
  driver;
let driverTerminal = false;
async function command(
  program,
  args,
  { input, live = false, allowFailure = false } = {},
) {
  const child = spawn(program, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
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
    child.once("error", (error) => done({ error: error.message }));
    child.once("close", (status, signal) => done({ status, signal }));
  });
  const path = `${String(++number).padStart(3, "0")}.json`;
  writeFileSync(
    join(evidence, path),
    JSON.stringify(
      {
        program,
        args,
        ...result,
        inputSha256: input === undefined ? undefined : hash(input),
        stdout,
        stderr,
      },
      null,
      2,
    ) + "\n",
  );
  report.commands.push({
    path,
    sha256: hash(readFileSync(join(evidence, path))),
  });
  save();
  if (!allowFailure && result.status !== 0)
    throw new Error(
      `${program} failed (${result.status}): ${stderr || result.error}`,
    );
  return { stdout, stderr, ...result };
}
async function inspect(id) {
  return JSON.parse((await command("docker", ["inspect", id])).stdout)[0];
}
async function create(args) {
  const id = (await command("docker", ["create", ...args])).stdout.trim();
  assert.match(id, /^[0-9a-f]{64}$/);
  return id;
}
async function sql(input, { allowFailure = false } = {}) {
  return command(
    "docker",
    [
      "exec",
      "-i",
      postgres,
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
      "-A",
      "-t",
      "-f",
      "-",
    ],
    { input, allowFailure },
  );
}
async function retire(id, kind, { requireSuccess = true } = {}) {
  const state = await inspect(id);
  assert.equal(state.Id, id);
  assert.equal(state.Config.Labels["io.rainsync.native-run"], runId);
  report.cleanup[kind] = {
    id,
    state: state.State,
    mounts: state.Mounts,
    network: state.HostConfig.NetworkMode,
  };
  save();
  assert.equal(state.State.Running, false);
  assert.equal(state.State.Pid, 0);
  assert.equal(state.State.OOMKilled, false);
  if (requireSuccess) assert.equal(state.State.ExitCode, 0);
  if (state.State.ExitCode === 0) {
    await command("docker", ["rm", id]);
    report.cleanup[kind].removed = true;
    save();
  }
}
try {
  report.sourceCommit = (
    await command("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  const files = (
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
      files.filter(
        (path) =>
          /^(apps|crates)\/.*(\.rs|Cargo\.toml|\.json)$/.test(path) ||
          /^migrations\/.*\.sql$/.test(path) ||
          [
            "Cargo.toml",
            "Cargo.lock",
            "tests/static-hls-public-prepare.mjs",
            "tests/sql/static_hls_pending_custody.sql",
          ].includes(path),
      ),
    ),
  ].sort();
  report.inputs = paths.map((path) => ({
    path,
    sha256: hash(readFileSync(join(root, path))),
  }));
  const frozenSource = join(evidence, "source");
  for (const { path, sha256 } of report.inputs) {
    const destination = join(frozenSource, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, path), destination);
    const originalStat = statSync(join(root, path));
    utimesSync(destination,originalStat.atime,originalStat.mtime);
    assert.equal(hash(readFileSync(destination)), sha256);
  }
  report.frozenSource = frozenSource;
  report.inputDigest = hash(report.inputs.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join(""));
  const image = JSON.parse(
    (
      await command("docker", [
        "image",
        "inspect",
        runtime.image,
      ])
    ).stdout,
  )[0];
  assert.equal(image.Os, "linux");
  assert.equal(image.Id, runtime.imageId, "Configured native image changed");
  report.nativeImageId = image.Id;
  const registry = runtime.registry;
  const config = runtime.cargoConfig;
  report.cargoConfigSha256 = hash(readFileSync(config));
  builder = await create([
    "--name",
    `rainsync-native-build-${runId}`,
    "--label",
    `io.rainsync.native-run=${runId}`,
    "--network",
    "none",
    "--memory",
    "4g",
    "--pids-limit",
    "256",
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,source=${frozenSource},target=/workspace,readonly`,
    "--mount",
    `type=bind,source=${registry},target=/usr/local/cargo/registry,readonly`,
    "--mount",
    `type=bind,source=${config},target=/usr/local/cargo/config.toml,readonly`,
    "--mount",
    `type=bind,source=${target},target=/target`,
    "--env",
    "CARGO_TARGET_DIR=/target",
    "--env",
    "CARGO_BUILD_JOBS=4",
    "--env",
    "CARGO_INCREMENTAL=0",
    "--env",
    "CARGO_PROFILE_DEV_DEBUG=0",
    "--env",
    "CARGO_PROFILE_TEST_DEBUG=0",
    image.Id,
    "/bin/sh",
    "-c",
    `set -eu; rustc -vV; ffprobe -version; cargo test --offline --locked -p rainsync-server --bin rainsync-server --no-run --message-format=json > /target/server-test-artifacts-${runId}.json; cargo build --offline --locked -p rainsync-media-worker --bin rainsync-media-worker; cargo clippy --offline --locked -p rainsync-server --all-targets -- -D warnings; cargo clippy --offline --locked -p rainsync-media-worker --bin rainsync-media-worker -- -D warnings; cargo test --offline --locked -p rainsync-server static_hls_public::tests -- --nocapture; cargo test --offline --locked -p media-core --lib static_hls::contracts -- --nocapture`,
  ]);
  report.builderId = builder;
  save();
  const build = await command("docker", ["start", "-a", builder], { live: true, allowFailure: true });
  const compilerMessages = readFileSync(join(target, `server-test-artifacts-${runId}.json`));
  writeFileSync(join(evidence, "server-test-artifacts.json"), compilerMessages);
  report.compilerMessages = { path: "server-test-artifacts.json", sha256: hash(compilerMessages) };
  save();
  assert.equal(build.status, 0, "Public prepare compilation or strict Clippy failed; compiler diagnostics retained");
  await retire(builder, "builder");
  builder = undefined;
  const compiled = readFileSync(
    join(target, `server-test-artifacts-${runId}.json`),
    "utf8",
  )
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter(
      (x) =>
        x.reason === "compiler-artifact" &&
        x.profile.test &&
        x.target.name === "rainsync-server" &&
        x.executable,
    );
  assert.equal(compiled.length, 1);
  assert.match(
    compiled[0].executable,
    /^\/target\/debug\/deps\/rainsync_server-[0-9a-f]+$/,
  );
  const insideBinary = compiled[0].executable;
  const binary = join(
    target,
    ...insideBinary.slice("/target/".length).split("/"),
  );
  report.binary = { path: binary, sha256: hash(readFileSync(binary)) };
  copyFileSync(binary, join(evidence, "verify_static_hls_pending"));
  report.binary.frozenPath = join(evidence, "verify_static_hls_pending");
  const workerBinary = join(target,"debug","rainsync-media-worker");
  report.workerBinary = {path:workerBinary,sha256:hash(readFileSync(workerBinary)),frozenPath:join(evidence,"rainsync-media-worker")};
  copyFileSync(workerBinary,report.workerBinary.frozenPath);
  const pgImage = JSON.parse(
    (
      await command("docker", [
        "image",
        "inspect",
        runtime.postgresImage,
      ])
    ).stdout,
  )[0];
  assert.equal(pgImage.Config.StopSignal, "SIGINT");
  assert.equal(pgImage.Id, runtime.postgresImageId, "Configured isolated PostgreSQL image changed");
  report.postgresImageId = pgImage.Id;
  postgres = await create([
    "--name",
    `rainsync-native-pg-${runId}`,
    "--label",
    `io.rainsync.native-run=${runId}`,
    "--network",
    "none",
    "--memory",
    "1g",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=1073741824",
    "--tmpfs",
    "/var/run/postgresql",
    "--tmpfs",
    "/tmp",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    `POSTGRES_DB=${database}`,
    pgImage.Id,
  ]);
  report.postgresId = postgres;
  save();
  await command("docker", ["start", postgres]);
  const until = performance.now() + 30000;
  let ready = false;
  while (performance.now() < until) {
    const check = await sql("SELECT 1;", { allowFailure: true });
    if (check.status === 0 && check.stdout.trim() === "1") {
      ready = true;
      break;
    }
    await delay(200);
  }
  assert.ok(ready, "final TCP PG never became ready");
  report.postgresVersion = (await sql("SHOW server_version;")).stdout.trim();
  for (const { path } of report.inputs.filter(({ path }) =>
    /^migrations\//.test(path),
  ))
    await sql(`BEGIN;\n${readFileSync(join(frozenSource, path), "utf8")}\nCOMMIT;`);
  await sql(
    `CREATE TABLE rainsync_owned_test_binding(singleton boolean PRIMARY KEY CHECK(singleton),run_id uuid NOT NULL); INSERT INTO rainsync_owned_test_binding VALUES(true,'${runId}');`,
  );
  driver = await create([
    "--name",
    `rainsync-native-driver-${runId}`,
    "--label",
    `io.rainsync.native-run=${runId}`,
    "--network",
    `container:${postgres}`,
    "--memory",
    "2g",
    "--pids-limit",
    "128",
    "--mount",
    `type=bind,source=${evidence},target=/owned-run,readonly`,
    "--env",
    `RAINSYNC_OWNED_TEST_RUN_ID=${runId}`,
    "--env",
    `RAINSYNC_OWNED_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/${database}`,
    "--env",
    "RAINSYNC_OWNED_TEST_REPORT=/tmp/driver.json",
    "--env",
    "CACHE_MAX_BYTES=536870912",
    "--env", "STATIC_HLS_PARENT_PREPARE_ENABLED=1",
    "--env", "CACHE_ROOT=/tmp/rainsync-public-prepare/cache",
    "--env", "WORKER_URL=http://127.0.0.1:8081",
    "--env",
    "RAINSYNC_OWNED_TEST_NATIVE=1",
    "--env",
    "RAINSYNC_OWNED_TEST_NATIVE_ROOT=/tmp/rainsync-native-db",
    image.Id,
    "/owned-run/verify_static_hls_pending",
    "static_hls_public::native_tests::owned_public_prepare_round_trip",
    "--ignored",
    "--nocapture",
    "--test-threads=1",
  ]);
  report.driverId = driver;
  report.binary.executedPath = "/owned-run/verify_static_hls_pending";
  assert.equal(hash(readFileSync(report.binary.frozenPath)), report.binary.sha256);
  save();
  await command("docker", ["start", "-a", driver], { live: true });
  await command("docker", [
    "cp",
    `${driver}:/tmp/driver.json`,
    join(evidence, "driver.json"),
  ]);
  report.driver = JSON.parse(
    readFileSync(join(evidence, "driver.json"), "utf8"),
  );
  assert.equal(report.driver.runId, runId);
  assert.equal(report.driver.complete, true);
  assert.equal(report.driver.physicalDisposalProven, true);
  assert.equal(report.driver.workerExited, true);
  assert.equal(report.driver.passed.length, 7);
  assert.equal(
    (
      await sql(
        `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND application_name='rs_pending_rust_${runId.replaceAll("-", "")}';`,
      )
    ).stdout.trim(),
    "0",
  );
  report.inputsUnchanged = report.inputs.every(
    ({ path, sha256 }) => hash(readFileSync(join(root, path))) === sha256,
  );
  assert.ok(report.inputsUnchanged);
  assert.equal(hash(readFileSync(binary)), report.binary.sha256);
  assert.equal(hash(readFileSync(report.binary.frozenPath)), report.binary.sha256);
  report.binaryUnchanged = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    if (report.inputs) {
      report.inputsUnchanged = report.inputs.every(({ path, sha256 }) => hash(readFileSync(join(root, path))) === sha256);
      report.frozenInputsUnchanged = report.inputs.every(({ path, sha256 }) => hash(readFileSync(join(report.frozenSource, path))) === sha256);
      assert.ok(report.inputsUnchanged && report.frozenInputsUnchanged, "Current/frozen input hash changed");
    }
    if (report.workerBinary) {
      assert.equal(hash(readFileSync(report.workerBinary.path)),report.workerBinary.sha256);
      assert.equal(hash(readFileSync(report.workerBinary.frozenPath)),report.workerBinary.sha256);
    }
    if (report.binary) {
      report.binaryUnchanged = hash(readFileSync(report.binary.path)) === report.binary.sha256;
      report.frozenBinaryUnchanged = hash(readFileSync(report.binary.frozenPath)) === report.binary.sha256;
      assert.ok(report.binaryUnchanged && report.frozenBinaryUnchanged, "Compiled/frozen binary hash changed");
    }
  } catch (error) {
    report.integrityError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  if (builder) {
    try {
      await retire(builder, "builder");
    } catch (error) {
      report.cleanup.builderError = error.message;
    }
  }
  if (driver) {
    try {
      const state = await inspect(driver);
      assert.equal(state.Id, driver);
      assert.equal(state.Config.Labels["io.rainsync.native-run"], runId);
      report.cleanup.driver = { id: driver, state: state.State, mounts: state.Mounts,
        network: state.HostConfig.NetworkMode, removed: false };
      save();
      assert.equal(state.State.Running, false);
      assert.equal(state.State.Pid, 0);
      driverTerminal = true;
      await command(
        "docker",
        ["cp", `${driver}:/tmp/driver.json`, join(evidence, "driver.json")],
        { allowFailure: true },
      );
      try {
        report.driver = JSON.parse(
          readFileSync(join(evidence, "driver.json"), "utf8"),
        );
      } catch {}
      const artifacts = join(evidence, "artifacts");
      mkdirSync(artifacts, { recursive: true });
      const copied = await command(
        "docker",
        ["cp", `${driver}:/tmp/rainsync-public-prepare/.`, artifacts],
        { allowFailure: true },
      );
      report.artifactsCopied = copied.status === 0;
    } catch (error) {
      report.cleanup.driverError = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  if (postgres) {
    try {
      const state = await inspect(postgres);
      assert.equal(state.Id, postgres);
      assert.equal(state.Config.Labels["io.rainsync.native-run"], runId);
      report.cleanup.postgres = { id: postgres, state: state.State, mounts: state.Mounts,
        network: state.HostConfig.NetworkMode, removed: false };
      save();
      if (driver) {
        const snapshot = await sql(
          "SELECT jsonb_build_object('observed_ms',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'requests',(SELECT jsonb_agg(jsonb_build_object('session_id',session_id,'status',status,'error_code',error_code,'root_deadline_ms',floor(extract(epoch FROM static_hls_root_expires_at)*1000)::bigint,'prepare_deadline_ms',floor(extract(epoch FROM static_hls_prepare_expires_at)*1000)::bigint)) FROM playback_requests),'captures',(SELECT jsonb_agg(to_jsonb(c)-'inventory_encrypted') FROM static_hls_captures c),'reservations',(SELECT jsonb_agg(to_jsonb(r)) FROM cache_write_reservations r),'budget',(SELECT to_jsonb(b) FROM cache_budget b WHERE singleton));",
          { allowFailure: true },
        );
        if (snapshot.status === 0)
          report.finalDatabaseState = JSON.parse(snapshot.stdout.trim());
        else report.finalDatabaseSnapshotError = snapshot.stderr || snapshot.error;
      }
      const databaseState = report.finalDatabaseState;
      const originalProof = databaseState &&
        (databaseState.reservations ?? []).length === 0 &&
        (databaseState.captures ?? []).every((capture) =>
          capture.state === "disposed" && capture.streams_closed_at &&
          capture.process_closed_at && ["never_started", "reaped"].includes(capture.process_disposition) &&
          capture.files_removed_at && capture.disposed_at);
      if (!report.passed || !driverTerminal || !report.driver?.physicalDisposalProven || !originalProof) {
        report.retainedUnknownScope = { runId, driverId: driver, postgresId: postgres,
          reason: "Fixture failed, driver terminal unconfirmed, or original positive resource proof is incomplete; retained without stop/remove" };
        report.passed = false;
        process.exitCode = 1;
        save();
        throw new Error(report.retainedUnknownScope.reason);
      }
      await retire(driver, "driver");
      await command("docker", ["stop", "--time", "10", postgres]);
      const logs = await command("docker", ["logs", postgres]);
      assert.match(logs.stdout + logs.stderr, /database system is shut down/);
      assert.doesNotMatch(
        logs.stdout + logs.stderr,
        /abnormal database system shutdown/,
      );
      await retire(postgres, "postgres");
    } catch (error) {
      report.cleanup.postgresError = error.message;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`Evidence: ${join(evidence, "report.json")}`);
}
