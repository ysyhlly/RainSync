import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

assert.equal(
  process.platform,
  "win32",
  "this entry validates a real Windows console SIGINT",
);
const execute = promisify(execFile);
const root = resolve(".runtime/control-interrupt", randomUUID());
await mkdir(root, { recursive: true });
const image = process.env.WORKER_TEST_IMAGE;
assert.ok(image, "WORKER_TEST_IMAGE is required");
const loadRoot = resolve(".runtime/control-load");
await mkdir(loadRoot, { recursive: true });
const before = new Set(await readdir(loadRoot));
const report = {
  started_at: new Date().toISOString(),
  image,
  source_sha256: Object.fromEntries(
    await Promise.all(
      [
        "tests/control-load.mjs",
        "tests/control-load-interrupt.mjs",
        "tests/fixtures/control-load-console.py",
        "tests/windows-console.py",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  ),
  scope:
    "Real Windows Ctrl+C while queue-proof ACKs are pending; isolated hidden console",
};
const specPath = resolve(root, "launch.json");
const spec = {
  exe: process.execPath,
  args: [
    resolve("tests/control-load.mjs"),
    "--duration-seconds=25",
    "--topology=10x10",
  ],
  cwd: process.cwd(),
  env: {
    WORKER_TEST_IMAGE: image,
    ...(process.env.VALIDATION_CANDIDATE
      ? { VALIDATION_CANDIDATE: process.env.VALIDATION_CANDIDATE }
      : {}),
  },
  log: resolve(root, "runner.log"),
};
await writeFile(specPath, JSON.stringify(spec));
const helper = spawn(
  "python",
  ["tests/fixtures/control-load-console.py", specPath],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let servicePid,
  childExit,
  helperError = "",
  namespace;
helper.stderr.on("data", (data) => {
  helperError += data.toString();
});
createInterface({ input: helper.stdout }).on("line", (line) => {
  const value = JSON.parse(line);
  if (value.pid) servicePid = value.pid;
  if (value.exit_code !== undefined) childExit = value.exit_code;
});
const helperDone = new Promise((resolve, reject) => {
  helper.once("close", resolve);
  helper.once("error", reject);
});
helperDone.catch(() => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function command(exe, args) {
  return (
    await execute(exe, args, {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();
}
async function until(check, label, timeout = 45000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await check()) return;
    if (childExit !== undefined)
      throw Error("runner exited early: " + childExit + "; " + label);
    await delay(100);
  }
  throw Error("deadline: " + label);
}
try {
  await until(() => servicePid, "hidden test console PID", 5000);
  await until(
    async () => {
      const names = (await readdir(loadRoot)).filter(
        (name) => !before.has(name) && /^rainsync-load-[0-9a-f]{8}$/.test(name),
      );
      assert.ok(names.length <= 1, "exclusive runner namespace");
      namespace = names[0];
      return Boolean(namespace);
    },
    "isolated resource namespace",
    5000,
  );
  await until(
    async () => {
      try {
        const result = JSON.parse(
          await command("docker", [
            "exec",
            namespace + "-db",
            "psql",
            "-U",
            "rainsync",
            "-At",
            "-c",
            "SELECT json_build_object('sleeping',count(*) FILTER (WHERE application_name='queue_proof' AND wait_event='PgSleep'),'blocked',count(*) FILTER (WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE datname='rainsync'",
          ]),
        );
        return result.sleeping === 1 && result.blocked >= 1;
      } catch {
        return false;
      }
    },
    "queue proof owns snapshot lock and ACK is blocked",
    90000,
  );
  // The first ACK is blocked before its Promise is awaited. Allow the second
  // command to enter the same queue, then signal this exact isolated console.
  await delay(200);
  const signalAt = performance.now();
  assert.deepEqual(
    JSON.parse(
      await command("python", [
        "tests/windows-console.py",
        "signal",
        String(servicePid),
        "0",
      ]),
    ),
    { delivered: true },
  );
  await until(
    () => childExit !== undefined,
    "interrupted runner exits through finally",
    15000,
  );
  await helperDone;
  const failed = JSON.parse(
    await readFile(resolve(loadRoot, namespace, "failed-report.json"), "utf8"),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.interrupted_by, "SIGINT");
  assert.notEqual(childExit, 0);
  assert.equal(
    await command("docker", [
      "ps",
      "-a",
      "--filter",
      "name=^/" + namespace + "-",
      "--format",
      "{{.Names}}",
    ]),
    "",
    "containers removed",
  );
  assert.equal(
    await command("docker", [
      "network",
      "ls",
      "--filter",
      "name=^" + namespace + "$",
      "--format",
      "{{.Name}}",
    ]),
    "",
    "network removed",
  );
  Object.assign(report, {
    status: "passed",
    runner_namespace: namespace,
    runner_exit_code: childExit,
    signal_to_exit_ms: performance.now() - signalAt,
    failed_report: resolve(loadRoot, namespace, "failed-report.json"),
  });
  console.log(
    "PASS: queue-proof pending ACK SIGINT marks failed and cleans all isolated resources",
  );
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  if (childExit === undefined) helper.stdin.write("kill\n");
  helper.stdin.end();
  await Promise.race([helperDone.catch(() => {}), delay(5000)]);
  // Last resort cleanup is constrained to the namespace returned by this run.
  // A test requiring this path has already failed.
  if (report.status !== "passed" && namespace) {
    for (const container of [namespace + "-server", namespace + "-db"])
      await command("docker", ["rm", "-f", "-v", container]).catch(() => {});
    await command("docker", ["network", "rm", namespace]).catch(() => {});
  }
  report.finished_at = new Date().toISOString();
  if (helperError) report.helper_stderr = helperError;
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log("Evidence: " + root);
}
