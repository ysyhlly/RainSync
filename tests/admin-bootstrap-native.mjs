// Actual first-account initialization against owned native PostgreSQL + real PTYs.
// No existing DB, user password, production environment, or Docker daemon needed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const bin = process.env.RAINSYNC_NATIVE_POSTGRES_BIN;
const pgPath = process.env.RAINSYNC_PG_MODULE;
const artifacts = process.env.RAINSYNC_ARTIFACT_DIR;
assert.ok(bin && pgPath && artifacts, "set native PG binary/module and artifact paths");
const { default: pg } = await import(pathToFileURL(resolve(pgPath)).href);
const serverBinary = resolve(process.env.RAINSYNC_SERVER_BINARY || "target/debug/rainsync-server");
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(resolve(artifacts, "admin-bootstrap-"));
// Deliberately enumerate ordinary environment fields. Do not inherit credential
// variables such as ADMIN_PASSWORD, DATABASE_URL, or SSH/cloud secrets.
const ordinaryEnv = { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" };
async function unusedPort() {
  const listener = createServer();
  await new Promise((done, reject) => listener.once("error", reject).listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}
const pgPort = await unusedPort(), httpPort = await unusedPort();
const init = spawnSync(resolve(bin, "initdb"), ["-D", root + "/data", "-A", "trust", "-U", "postgres", "--no-locale", "--encoding=UTF8"],
  { env: ordinaryEnv, encoding: "utf8", timeout: 60000 });
assert.equal(init.status, 0, init.stderr);
const database = spawn(resolve(bin, "postgres"), ["-D", root + "/data", "-h", "127.0.0.1", "-p", String(pgPort), "-k", ""],
  { env: ordinaryEnv, stdio: ["ignore", "pipe", "pipe"] });
const databaseDone = once(database, "close");
let dbLog = "", serverLog = "", client, server;
database.stdout.on("data", (b) => dbLog += b);
database.stderr.on("data", (b) => dbLog += b);
const report = { started_at: new Date().toISOString(), scope: "Owned fresh native PostgreSQL + actual RainSync binary + synthetic interactive PTYs; no production accounts or passwords", passed: false, cases: [], cleanup: {} };
const drivers = new Set();
const terminalProcesses = [];
const password = "  synth-" + randomBytes(24).toString("hex") + "  ";
const mismatch = "different-synth-" + randomBytes(24).toString("hex");
const allSecrets = [password, mismatch];
let assertions = 0;
function check(condition, label) { assert.ok(condition, label); assertions++; }
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
function terminal(username, secrets = allSecrets, extra = {}) {
  const driver = spawn("python3", [resolve("tests/fixtures/admin-bootstrap-pty.py")], { env: ordinaryEnv, stdio: ["pipe", "pipe", "pipe"] });
  const events = [], waiting = [], outputs = [];
  let lines = "", error = "";
  const finished = once(driver, "close");
  drivers.add(driver);
  const identity = { driver_pid: driver.pid, child_pid: null, close_observed: false };
  terminalProcesses.push(identity);
  finished.then(() => {
    drivers.delete(driver); identity.close_observed = true;
    for (const waiter of waiting.splice(0)) { clearTimeout(waiter.timer); waiter.reject(Error("terminal driver closed before " + waiter.stage + ": " + error)); }
  });
  driver.stderr.on("data", (b) => error += b);
  driver.stdout.on("data", (b) => {
    lines += b;
    while (lines.includes("\n")) {
      const n = lines.indexOf("\n");
      const value = JSON.parse(lines.slice(0, n));
      lines = lines.slice(n + 1);
      if (value.stage === "started") identity.child_pid = value.pid;
      events.push(value);
      outputs.push(value);
      for (const waiter of [...waiting]) if (value.stage === waiter.stage) {
        waiting.splice(waiting.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.done(value);
      }
    }
  });
  driver.stdin.write(JSON.stringify({ binary: serverBinary, username, env: bootstrapEnv, secret_markers: secrets, ...extra }) + "\n");
  return {
    send(command) { driver.stdin.write(JSON.stringify(command) + "\n"); },
    async stage(stage) {
      const old = events.find((event) => event.stage === stage);
      if (old) return old;
      return new Promise((done, reject) => {
        const waiter = { stage, done, reject, timer: setTimeout(() => reject(Error("missing PTY stage " + stage + ": " + error)), 50000) };
        waiting.push(waiter);
      });
    },
    async finish(label, expected) {
      const result = await this.stage("finished");
      driver.stdin.end();
      await finished;
      check(!result.driver_error, label + ": terminal driver completed");
      check(result.terminal_settings_restored, label + ": complete terminal settings restored");
      check(result.terminal_flags_restored, label + ": terminal descriptor flags restored");
      check(!result.secret_echo_detected, label + ": no synthetic secret echoed");
      check(verifyPidAbsent(result.pid), label + ": bootstrap PID absent after close");
      check(expected(result), label + ": expected result");
      report.cases.push({ name: label, ...result });
      return result;
    },
  };
}
let bootstrapEnv;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = new pg.Client({ host: "127.0.0.1", port: pgPort, user: "postgres", database: "postgres", connectionTimeoutMillis: 500 });
    try { await candidate.connect(); client = candidate; break; }
    catch { await candidate.end().catch(() => {}); await pause(100); }
  }
  check(client, "native PostgreSQL ready");
  await client.query("CREATE DATABASE rainsync_bootstrap_fixture");
  await client.end();
  client = new pg.Client({ host: "127.0.0.1", port: pgPort, user: "postgres", database: "rainsync_bootstrap_fixture" });
  await client.connect();
  bootstrapEnv = { ...ordinaryEnv, DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/rainsync_bootstrap_fixture`, RUST_LOG: "warn" };
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(serverBinary)) hash.update(chunk);
  report.server_binary = { path: serverBinary, sha256: hash.digest("hex") };
  report.postgres = { pid: database.pid, port: pgPort, version: (await client.query("SELECT version()")).rows[0].version };

  const redirected = spawnSync(serverBinary, ["init-admin", "--username", "fixture-admin"], { env: ordinaryEnv, input: password + "\n" + password + "\n", encoding: "utf8", timeout: 15000 });
  check(redirected.status !== 0 && redirected.stderr.includes("requires an interactive terminal"), "non-TTY refused before database access");
  check(!redirected.stderr.includes(password) && !redirected.stdout.includes(password), "non-TTY no secret output");
  report.cases.push({ name: "redirected-stdin", code: redirected.status, output: redirected.stderr, secret_echo_detected: false });

  const stderrRedirected = terminal("fixture-admin", allSecrets, { redirect_stderr: true });
  await stderrRedirected.finish("redirected-stderr", (result) => result.code !== 0 && result.output.includes("requires an interactive terminal"));

  async function entry(label, first, second, expected) {
    const t = terminal("fixture-admin", [...allSecrets, first, second].filter(Boolean));
    check(!(await t.stage("password")).echo_enabled, label + ": prompt hides input echo");
    t.send({ input: first + "\n" });
    if (second !== null) {
      check(!(await t.stage("confirmation")).echo_enabled, label + ": confirmation hides input echo");
      t.send({ input: second + "\n" });
    }
    return t.finish(label, expected);
  }
  await entry("password-mismatch", password, mismatch, (r) => r.code !== 0 && r.output.includes("passwords do not match"));
  check((await client.query("SELECT count(*) FROM users")).rows[0].count === "0", "mismatch inserted no account");
  await entry("non-ASCII-rejected", "synthetic-ø-password", null, (r) => r.code !== 0 && r.output.includes("printable ASCII"));
  await entry("oversized-rejected", "x".repeat(1025), null, (r) => r.code !== 0 && r.output.includes("password is too long"));
  for (const interruption of ["EOF", "Ctrl-C", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    const t = terminal("fixture-admin");
    check(!(await t.stage("password")).echo_enabled, interruption + ": prompt hides input echo");
    t.send(interruption === "EOF" ? { input: "\u0004" } : interruption === "Ctrl-C" ? { input: "\u0003" } : { signal: interruption });
    await t.finish(interruption, (r) => r.code !== 0 && r.output.includes("password input interrupted"));
    check((await client.query("SELECT count(*) FROM users")).rows[0].count === "0", interruption + ": no account inserted");
  }

  // Both initial checks observe an empty users table. The transaction table lock
  // + locked recheck allows exactly one administrator, never a second insert.
  const first = terminal("fixture-admin"), second = terminal("fixture-race");
  check(!(await first.stage("password")).echo_enabled && !(await second.stage("password")).echo_enabled, "both racing initializations begin before account creation");
  first.send({ input: password + "\n" }); second.send({ input: password + "\n" });
  await Promise.all([first.stage("confirmation"), second.stage("confirmation")]);
  first.send({ input: password + "\n" }); second.send({ input: password + "\n" });
  const races = await Promise.all([first.finish("racing-first", (r) => r.code === 0 || r.output.includes("another account was created")), second.finish("racing-second", (r) => r.code === 0 || r.output.includes("another account was created"))]);
  check(races.filter((r) => r.code === 0).length === 1, "exactly one racing initialization succeeds");
  const accounts = (await client.query("SELECT id, username, password_hash, admin FROM users")).rows;
  check(accounts.length === 1 && accounts[0].admin, "exactly one administrative account persisted");
  check(accounts[0].password_hash.startsWith("$argon2id$") && !accounts[0].password_hash.includes(password), "only Argon2id hash persisted");
  const stored = JSON.stringify(accounts);
  const again = terminal("replacement-admin");
  const refused = await again.finish("second-initialization-refused", (r) => r.code !== 0 && r.output.includes("never replaces or resets"));
  check(!refused.output.includes("Administrator password:"), "second init refuses before asking for secret");
  check(JSON.stringify((await client.query("SELECT id, username, password_hash, admin FROM users")).rows) === stored, "second initialization leaves account/hash unchanged");

  // Exercise the shipped release entrypoint and its real offline Server/Worker
  // probes with the same effective argv as the manual one-off Compose command.
  const routed = terminal("entrypoint-admin", allSecrets, {
    binary: "/bin/sh",
    args: [resolve("deploy/backend-entrypoint.sh"), "rainsync-server", "init-admin", "--username", "entrypoint-admin"],
    env: { ...bootstrapEnv, PATH: resolve("target/debug") + ":" + ordinaryEnv.PATH },
  });
  await routed.finish("release-entrypoint-init-admin-routing", (r) => r.code !== 0 && r.output.includes("never replaces or resets"));
  check(JSON.stringify((await client.query("SELECT id, username, password_hash, admin FROM users")).rows) === stored, "release entrypoint CLI route preserves existing account/hash");

  const origin = `http://127.0.0.1:${httpPort}`;
  const serverEnv = { ...bootstrapEnv, SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PUBLIC_ORIGIN: origin, BIND: `127.0.0.1:${httpPort}`, MEDIA_ROOT: root, CACHE_ROOT: root + "/cache" };
  check(!Object.hasOwn(serverEnv, "ADMIN_PASSWORD") && !Object.hasOwn(serverEnv, "ADMIN_USERNAME"), "normal startup has no plaintext admin env");
  server = spawn(serverBinary, [], { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  const serverDone = once(server, "close");
  server.done = serverDone;
  server.stdout.on("data", (b) => serverLog += b);
  server.stderr.on("data", (b) => serverLog += b);
  let healthy = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    check(server.exitCode === null, "normal server stays running during readiness");
    try { healthy = (await fetch(origin + "/health", { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (healthy) break;
    await pause(100);
  }
  check(healthy, "normal app startup succeeds after interactive initialization");
  const login = await fetch(origin + "/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ username: accounts[0].username, password }) });
  check(login.ok, "synthetic administrator can log in after passwordless-env startup");
  check(login.headers.get("set-cookie")?.includes("HttpOnly"), "login returns protected session cookie");
  check(!serverLog.includes(password), "normal server logs contain no synthetic password");
  report.cases.push({ name: "normal-startup-without-admin-env-and-login", health: healthy, login_status: login.status, plaintext_admin_env_present: false, server_pid: server.pid, server_port: httpPort });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  for (const identity of terminalProcesses) {
    if (identity.child_pid && !verifyPidAbsent(identity.child_pid)) process.kill(identity.child_pid, "SIGTERM");
  }
  for (const driver of drivers) {
    driver.stdin.end();
    await once(driver, "close");
  }
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (server) await server.done;
  await client?.end().catch(() => {});
  if (database.exitCode === null) database.kill("SIGINT");
  const [pgCode, pgSignal] = await databaseDone;
  const ctl = spawnSync(resolve(bin, "pg_ctl"), ["-D", root + "/data", "status"], { env: ordinaryEnv, encoding: "utf8", timeout: 5000 });
  report.cleanup = {
    server_pid: server?.pid ?? null, server_pid_absent: !server || verifyPidAbsent(server.pid),
    server_close_observed: !server || server.exitCode !== null || server.signalCode !== null,
    server_port: httpPort, server_port_closed: await verifyClosedPort(httpPort),
    postgres_pid: database.pid, postgres_pid_absent: verifyPidAbsent(database.pid), postgres_close_observed: true,
    postgres_exit_code: pgCode, postgres_signal: pgSignal, pg_ctl_status: ctl.status,
    postgres_port: pgPort, postgres_port_closed: await verifyClosedPort(pgPort),
    terminal_processes: terminalProcesses.map((identity) => ({ ...identity, driver_pid_absent: verifyPidAbsent(identity.driver_pid), child_pid_absent: identity.child_pid !== null && verifyPidAbsent(identity.child_pid) })),
    terminal_driver_pids_absent: drivers.size === 0,
  };
  let cleanupError;
  try {
    check(report.cleanup.terminal_processes.every((p) => p.close_observed && p.driver_pid_absent && p.child_pid_absent), "all terminal driver/child PIDs absent with close observed");
    check(report.cleanup.server_pid_absent && report.cleanup.server_close_observed && report.cleanup.server_port_closed, "positive server PID/close/port shutdown receipts");
    check(report.cleanup.postgres_pid_absent && report.cleanup.postgres_port_closed && ctl.status === 3, "positive PostgreSQL PID/port/pg_ctl shutdown receipts");
  } catch (error) {
    cleanupError = error; report.passed = false; report.cleanup_error = error.stack;
  }
  report.assertions = assertions;
  report.finished_at = new Date().toISOString();
  // Redact synthetic markers even if a regression leaked one into diagnostics.
  const redact = (value) => allSecrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED SYNTHETIC INPUT]"), value);
  await writeFile(root + "/postgres.log", redact(dbLog));
  await writeFile(root + "/server.log", redact(serverLog));
  await writeFile(root + "/report.json", redact(JSON.stringify(report, null, 2)) + "\n");
  console.log(`${report.passed ? "PASS" : "FAIL"} ${assertions} interactive admin bootstrap assertions`);
  console.log("REPORT " + root + "/report.json");
  if (cleanupError && !report.error) throw cleanupError;
}
