import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function unusedPort() {
  const listener = createServer();
  await new Promise((done, reject) =>
    listener.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}

export async function verifyClosedPort(port) {
  return new Promise((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", (error) =>
      error.code === "ECONNREFUSED" ? done(true) : reject(error),
    );
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(Error("Owned fixture port closure unconfirmed"));
    });
  });
}
export function verifyPidAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

/** Owns a fresh cluster. No caller-supplied database URL or existing DB accepted. */
export function isolatedPostgres({
  root,
  name = "test",
  id = randomUUID(),
  password = randomBytes(24).toString("hex"),
}) {
  const native = process.env.RAINSYNC_NATIVE_POSTGRES_BIN;
  const container = native ? null : `rainsync-${name}-${id.slice(0, 8)}`;
  const database = native ? `rainsync_${id.replaceAll("-", "")}` : "rainsync";
  const children = new Set();
  let mapping,
    port,
    postgres,
    postgresDone,
    postgresFailure,
    log,
    containerStarted = false;
  let initialized = false,
    stopCompleted = false;
  const diagnostic = {
    schema_version: 1,
    kind: native ? "native" : "docker",
    fixture_id: id,
    database,
    host: "127.0.0.1",
    port: null,
    container,
    ready: false,
    server_version: null,
    native: null,
    docker: null,
  };
  const execOptions = {
    timeout: 30000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  };
  const pgEnv = () => ({
    ...process.env,
    PGPASSWORD: password,
    PGCONNECT_TIMEOUT: "2",
  });
  const docker = (args, extra = {}) =>
    execFileSync("docker", args, { ...execOptions, ...extra }).trim();
  const connectionArgs = () => [
    "-w",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "rainsync",
  ];
  const sqlArgs = (query, db = database) => [
    "-X",
    ...(native ? connectionArgs() : ["-U", "rainsync"]),
    "-d",
    db,
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    ...(query === undefined ? [] : ["-c", query]),
  ];
  const sql = (query, db = database) =>
    native
      ? execFileSync(resolve(native, "psql"), sqlArgs(query, db), {
          ...execOptions,
          env: pgEnv(),
        }).trim()
      : docker(["exec", container, "psql", ...sqlArgs(query, db)]);
  const fixture = {
    container,
    password,
    database,
    kind: diagnostic.kind,
    diagnostics() {
      return structuredClone(diagnostic);
    },
    async verifyStopped() {
      assert.equal(
        stopCompleted,
        true,
        "owned PostgreSQL fixture stop completed",
      );
      assert.equal(children.size, 0, "all owned psql processes closed");
      if (native) {
        const identity = diagnostic.native;
        const closeObserved = !postgres || identity?.closed_at != null;
        assert.equal(
          closeObserved,
          true,
          "owned native PostgreSQL close event observed",
        );
        const pidAbsent = !postgres?.pid || verifyPidAbsent(postgres.pid);
        assert.equal(
          pidAbsent,
          true,
          "owned native PostgreSQL PID no longer exists",
        );
        let ctlStatus = null;
        if (initialized) {
          try {
            execFileSync(
              resolve(native, "pg_ctl"),
              ["-D", resolve(root, "postgres"), "status"],
              execOptions,
            );
            ctlStatus = 0;
          } catch (error) {
            ctlStatus = error.status;
          }
          assert.equal(
            ctlStatus,
            3,
            "pg_ctl positively reports owned cluster not running",
          );
        }
        const portClosed = port == null || (await verifyClosedPort(port));
        assert.equal(
          portClosed,
          true,
          "owned PostgreSQL loopback listener is closed",
        );
        return {
          kind: "native",
          stopped: true,
          process_close_observed: closeObserved,
          pid: postgres?.pid ?? null,
          pid_absent: pidAbsent,
          pg_ctl_status: ctlStatus,
          port,
          port_closed: portClosed,
          exit_code: identity?.exit_code ?? null,
          signal: identity?.signal ?? null,
          data_directory_retained: initialized,
          data_directory: initialized ? resolve(root, "postgres") : null,
        };
      }
      const remaining = docker([
        "ps",
        "-aq",
        "--filter",
        `name=^/${container}$`,
      ]);
      assert.equal(remaining, "", "owned PostgreSQL container was removed");
      return {
        kind: "docker",
        stopped: true,
        container,
        removed: true,
        remaining,
      };
    },
    get url() {
      assert.ok(mapping, "Start the owned PostgreSQL fixture first");
      return `postgres://rainsync:${password}@${mapping}/${database}?sslmode=disable`;
    },
    sql(query) {
      return sql(query);
    },
    sqlProcess(query, { interactive = false } = {}) {
      const child = native
        ? spawn(resolve(native, "psql"), sqlArgs(query), {
            env: pgEnv(),
            windowsHide: true,
            stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
          })
        : spawn(
            "docker",
            ["exec", "-i", container, "psql", ...sqlArgs(query)],
            {
              windowsHide: true,
              stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
            },
          );
      if (!interactive) child.stdout.resume();
      child.stderr.resume();
      children.add(child);
      child.done = new Promise((done, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          children.delete(child);
          code === 0 ? done() : reject(new Error("SQL fixture process failed"));
        });
      });
      // Cleanup can terminate an unawaited lock; callers still observe rejection.
      child.done.catch(() => {});
      return child;
    },
    async start() {
      await mkdir(root, { recursive: true });
      if (native) {
        port = await unusedPort();
        const data = resolve(root, "postgres"),
          passwordFile = resolve(root, "postgres-password");
        await writeFile(passwordFile, password + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        try {
          execFileSync(
            resolve(native, "initdb"),
            [
              "-D",
              data,
              "-U",
              "rainsync",
              "--auth-host=scram-sha-256",
              "--auth-local=scram-sha-256",
              "--encoding=UTF8",
              "--no-locale",
              `--pwfile=${passwordFile}`,
            ],
            { ...execOptions, timeout: 60000 },
          );
          initialized = true;
        } finally {
          await unlink(passwordFile);
        }
        diagnostic.native = {
          binary: resolve(native, "postgres"),
          binary_sha256: createHash("sha256")
            .update(await readFile(resolve(native, "postgres")))
            .digest("hex"),
          data_directory: data,
          pid: null,
          started_at: new Date().toISOString(),
          closed_at: null,
          exit_code: null,
          signal: null,
        };
        log = createWriteStream(resolve(root, "postgres.log"));
        postgres = spawn(
          resolve(native, "postgres"),
          ["-D", data, "-h", "127.0.0.1", "-p", String(port), "-k", ""],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        diagnostic.native.pid = postgres.pid ?? null;
        postgresDone = new Promise((done) =>
          postgres.once("close", (code, signal) => {
            Object.assign(diagnostic.native, {
              closed_at: new Date().toISOString(),
              exit_code: code,
              signal,
            });
            done();
          }),
        );
        postgres.once("error", (error) => {
          postgresFailure = error;
        });
        postgres.stdout.pipe(log, { end: false });
        postgres.stderr.pipe(log, { end: false });
        mapping = `127.0.0.1:${port}`;
      } else {
        docker(
          [
            "run",
            "--detach",
            "--rm",
            "--name",
            container,
            "--label",
            `rainsync.fixture=${id}`,
            "-p",
            "127.0.0.1::5432",
            "-e",
            "POSTGRES_USER=rainsync",
            "-e",
            "POSTGRES_DB=rainsync",
            "-e",
            "POSTGRES_PASSWORD",
            "postgres:17",
          ],
          {
            env: { ...process.env, POSTGRES_PASSWORD: password },
            timeout: 120000,
          },
        );
        containerStarted = true;
        mapping = docker(["port", container, "5432/tcp"]);
        diagnostic.docker = {
          image: "postgres:17",
          image_id: docker(["inspect", "--format", "{{.Image}}", container]),
          container_id: docker(["inspect", "--format", "{{.Id}}", container]),
        };
      }
      diagnostic.port = Number(mapping.split(":").at(-1));
      assert.match(mapping, /^127\.0\.0\.1:\d+$/);
      for (let i = 0; i < 100; i++) {
        if (postgresFailure || (postgres && postgres.exitCode !== null))
          throw new Error(`Disposable PostgreSQL failed; inspect ${root}`);
        try {
          sql("SELECT 1", native ? "postgres" : database);
          break;
        } catch {
          if (i === 99) throw new Error("Disposable PostgreSQL did not start");
          await delay(100);
        }
      }
      if (native) sql(`CREATE DATABASE ${database}`, "postgres");
      diagnostic.server_version = sql("SELECT version()");
      diagnostic.ready = true;
      return fixture;
    },
    backupRestore() {
      const restored = `${database}_restore`;
      const dump = native ? resolve(root, "backup.dump") : "/tmp/backup.dump";
      for (const [command, args] of [
        ["pg_dump", ["-Fc", "-f", dump, database]],
        ["createdb", [restored]],
        ["pg_restore", ["--exit-on-error", "-d", restored, dump]],
      ]) {
        if (native)
          execFileSync(
            resolve(native, command),
            [...connectionArgs(), ...args],
            { ...execOptions, env: pgEnv(), timeout: 120000 },
          );
        else
          docker(["exec", container, command, "-U", "rainsync", ...args], {
            timeout: 120000,
          });
      }
      const url = new URL(fixture.url);
      url.pathname = `/${restored}`;
      return url.toString();
    },
    async stop() {
      for (const child of children) child.kill();
      await Promise.allSettled([...children].map((child) => child.done));
      if (postgres && postgres.exitCode === null && !postgresFailure)
        postgres.kill("SIGINT");
      await postgresDone;
      if (log) await new Promise((done) => log.end(done));
      if (containerStarted) {
        docker(["rm", "-f", container]);
        containerStarted = false;
      }
      stopCompleted = true;
    },
  };
  return fixture;
}
