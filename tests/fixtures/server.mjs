import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  isolatedPostgres,
  verifyClosedPort,
  verifyPidAbsent,
} from "./postgres.mjs";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";

export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function unusedPort() {
  const listener = createServer();
  await new Promise((done, reject) =>
    listener.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}

export class Client {
  cookie = "";
  csrf = "";
  constructor(fixture) {
    this.fixture = fixture;
  }
  async raw(path, { method = "GET", body, headers = {}, signal } = {}) {
    const response = await fetch(this.fixture.origin + "/api/v1" + path, {
      method,
      headers: {
        Origin: this.fixture.env?.PUBLIC_ORIGIN ?? this.fixture.origin,
        "Content-Type": "application/json",
        Cookie: this.cookie,
        "x-csrf-token": this.csrf,
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : body instanceof Uint8Array
            ? body
            : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20000),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0];
    return response;
  }
  async request(path, method = "GET", body, expected = 200, headers = {}) {
    const response = await this.raw(path, { method, body, headers });
    const value = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${path}: ${response.status}; error=${value?.error?.code ?? "none"}`,
    );
    return value;
  }
  async login(username = "admin", password = this.fixture.password) {
    this.csrf = (
      await this.request("/auth/login", "POST", { username, password })
    ).csrf;
    return this.request("/auth/me");
  }
}

/**
 * Owns a new database, random secrets and child processes. Never accepts a DB URL.
 * Set RAINSYNC_NATIVE_POSTGRES_BIN to a PostgreSQL bin directory to create a
 * disposable local cluster instead of Docker. It binds only a random loopback
 * port, authenticates with a random password, and is stopped after each test.
 */
export async function isolatedServer(name, run, options = {}) {
  assert.ok(
    process.env.RAINSYNC_ARTIFACT_DIR,
    "Set RAINSYNC_ARTIFACT_DIR before integration tests",
  );
  const id = randomUUID();
  const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, name, id);
  await mkdir(root, { recursive: true });
  const password = randomBytes(24).toString("hex");
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const children = new Set();
  const processes = [];
  const streams = [];
  let cleanupCompleted = false;
  let server,
    launches = 0;
  const database = isolatedPostgres({ root, name, id, password });
  const container = database.container;
  const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
  const fixture = {
    id,
    root,
    container,
    password,
    origin,
    env: null,
    get serverPid() { return server?.exitCode === null ? server.pid : undefined; },
    target,
    databaseKind: database.kind,
    postgresDiagnostics: database.diagnostics,
    async verifyStopped() {
      assert.equal(
        cleanupCompleted,
        true,
        "owned Server fixture cleanup completed",
      );
      assert.equal(children.size, 0, "all owned Server processes closed");
      const servers = processes.map((record) => {
        assert.ok(record.closed_at, "owned Server close event observed");
        const pidAbsent = !record.pid || verifyPidAbsent(record.pid);
        assert.equal(pidAbsent, true, "owned Server PID no longer exists");
        return { ...record, pid_absent: pidAbsent };
      });
      const listenerClosed = await verifyClosedPort(port);
      assert.equal(
        listenerClosed,
        true,
        "owned Server loopback listener is closed",
      );
      return {
        completed: true,
        servers,
        server_port: port,
        server_port_closed: listenerClosed,
        postgres: await database.verifyStopped(),
      };
    },
    client() {
      return new Client(fixture);
    },
    legacyPasswordHash(password) {
      return execFileSync(
        resolve(
          target,
          "examples",
          `fixture_password${process.platform === "win32" ? ".exe" : ""}`,
        ),
        [],
        {
          env: {
            ...process.env,
            RAINSYNC_ISOLATED_TEST: "1",
            RAINSYNC_FIXTURE_PASSWORD: password,
          },
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    },
    sql: database.sql,
    sqlProcess: database.sqlProcess,
    async waitForSql(query, expected, timeout = 10000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (fixture.sql(query) === expected) return;
        await delay(30);
      }
      throw new Error("Database condition did not become true");
    },
    async stopServer({ signal = "SIGTERM" } = {}) {
      if (!server || server.exitCode !== null) return;
      const child = server;
      const closed = new Promise((done) => child.once("close", done));
      child.kill(signal);
      await closed;
      server = undefined;
    },
    async startServer(
      extra = {},
      binary = resolve(
        target,
        `rainsync-server${process.platform === "win32" ? ".exe" : ""}`,
      ),
    ) {
      await fixture.stopServer();
      const log = createWriteStream(resolve(root, `server-${++launches}.log`));
      streams.push(log);
      server = spawn(binary, [], {
        env: { ...fixture.env, ...extra },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const child = server;
      const record = {
        pid: child.pid ?? null,
        binary,
        launch: launches,
        started_at: new Date().toISOString(),
        closed_at: null,
        exit_code: null,
        signal: null,
      };
      processes.push(record);
      children.add(child);
      let failure;
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code, signal) => {
        children.delete(child);
        Object.assign(record, {
          closed_at: new Date().toISOString(),
          exit_code: code,
          signal,
        });
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      for (let i = 0; i < 120; i++) {
        if (failure || child.exitCode !== null)
          throw new Error(`Fixture Server failed to start; inspect ${root}`);
        try {
          if (
            (
              await fetch(origin + "/health", {
                signal: AbortSignal.timeout(500),
              })
            ).ok
          )
            return;
        } catch {}
        await delay(100);
      }
      throw new Error(`Fixture Server startup timed out; inspect ${root}`);
    },
  };
  try {
    await database.start();
    fixture.env = {
      ...process.env,
      DATABASE_URL: database.url,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: password,
      SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      PUBLIC_ORIGIN: origin,
      BIND: `127.0.0.1:${port}`,
      MEDIA_ROOT: root,
      CACHE_ROOT: resolve(root, "cache"),
      RUST_LOG: "warn",
      TRUSTED_PROXY_CIDRS: "",
      ...options.env,
    };
    if (options.beforeStart) await options.beforeStart(fixture);
    await fixture.startServer({}, options.binary);
    await run(fixture);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(
      [...children].map((child) =>
        child.exitCode === null
          ? new Promise((done) => child.once("close", done))
          : undefined,
      ),
    );
    await database.stop();
    for (const stream of streams) await new Promise((done) => stream.end(done));
    cleanupCompleted = true;
  }
}
