import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";

export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function unusedPort() {
  const listener = createServer();
  await new Promise((done, reject) => listener.once("error", reject).listen(0, "127.0.0.1", done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}

export class Client {
  cookie = "";
  csrf = "";
  constructor(fixture) { this.fixture = fixture; }
  async raw(path, { method = "GET", body, headers = {}, signal } = {}) {
    const response = await fetch(this.fixture.origin + "/api/v1" + path, {
      method,
      headers: { Origin: this.fixture.env?.PUBLIC_ORIGIN ?? this.fixture.origin, "Content-Type": "application/json", Cookie: this.cookie, "x-csrf-token": this.csrf, ...headers },
      body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20000),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0];
    return response;
  }
  async request(path, method = "GET", body, expected = 200, headers = {}) {
    const response = await this.raw(path, { method, body, headers });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${response.status}; error=${value?.error?.code ?? "none"}`);
    return value;
  }
  async login(username = "admin", password = this.fixture.password) {
    this.csrf = (await this.request("/auth/login", "POST", { username, password })).csrf;
    return this.request("/auth/me");
  }
}

/** Owns a new database, random secrets and child processes. Never accepts a DB URL. */
export async function isolatedServer(name, run, options = {}) {
  assert.ok(process.env.RAINSYNC_ARTIFACT_DIR, "Set RAINSYNC_ARTIFACT_DIR before integration tests");
  const id = randomUUID();
  const container = `rainsync-${name}-${id.slice(0, 8)}`;
  const root = resolve(process.env.RAINSYNC_ARTIFACT_DIR, name, id);
  await mkdir(root, { recursive: true });
  const password = randomBytes(24).toString("hex");
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const children = new Set();
  const streams = [];
  let server, launches = 0, containerStarted = false;
  const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
  const docker = (args, extra = {}) => execFileSync("docker", args, { timeout: 30000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...extra }).trim();
  const fixture = {
    id, root, container, password, origin, env: null, target,
    client() { return new Client(fixture); },
    legacyPasswordHash(password) {
      return execFileSync(resolve(target, "examples", `fixture_password${process.platform === "win32" ? ".exe" : ""}`), [], {
        env: { ...process.env, RAINSYNC_ISOLATED_TEST: "1", RAINSYNC_FIXTURE_PASSWORD: password },
        encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    },
    sql(query) { return docker(["exec", container, "psql", "-U", "rainsync", "-d", "rainsync", "-At", "-v", "ON_ERROR_STOP=1", "-c", query]); },
    sqlProcess(query) {
      const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "rainsync", "-d", "rainsync", "-v", "ON_ERROR_STOP=1", "-c", query], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.resume(); child.stderr.resume();
      children.add(child);
      child.once("close", () => children.delete(child));
      child.done = new Promise((done, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? done() : reject(new Error("SQL lock process failed"))); });
      return child;
    },
    async waitForSql(query, expected, timeout = 10000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (fixture.sql(query) === expected) return; await delay(30); }
      throw new Error("Database condition did not become true");
    },
    async stopServer() {
      if (!server || server.exitCode !== null) return;
      const child = server;
      const closed = new Promise((done) => child.once("close", done));
      child.kill();
      await closed;
      server = undefined;
    },
    async startServer(extra = {}, binary = resolve(target, `rainsync-server${process.platform === "win32" ? ".exe" : ""}`)) {
      await fixture.stopServer();
      const log = createWriteStream(resolve(root, `server-${++launches}.log`)); streams.push(log);
      server = spawn(binary, [], { env: { ...fixture.env, ...extra }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const child = server;
      children.add(child);
      let failure;
      child.once("error", (error) => { failure = error; });
      child.once("close", () => children.delete(child));
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      for (let i = 0; i < 120; i++) {
        if (failure || child.exitCode !== null) throw new Error(`Fixture Server failed to start; inspect ${root}`);
        try { if ((await fetch(origin + "/health", { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
        await delay(100);
      }
      throw new Error(`Fixture Server startup timed out; inspect ${root}`);
    },
  };
  try {
    docker(["run", "--detach", "--rm", "--name", container, "--label", `rainsync.fixture=${id}`, "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=rainsync", "-e", "POSTGRES_DB=rainsync", "-e", "POSTGRES_PASSWORD", "postgres:17"], { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 120000 });
    containerStarted = true;
    const mapping = docker(["port", container, "5432/tcp"]);
    assert.match(mapping, /^127\.0\.0\.1:\d+$/);
    for (let i = 0; i < 100; i++) {
      try { fixture.sql("SELECT 1"); break; } catch { if (i === 99) throw new Error("Disposable PostgreSQL did not start"); await delay(100); }
    }
    fixture.env = {
      ...process.env,
      DATABASE_URL: `postgres://rainsync:${password}@${mapping}/rainsync?sslmode=disable`,
      ADMIN_USERNAME: "admin", ADMIN_PASSWORD: password,
      SOURCE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), PUBLIC_ORIGIN: origin,
      BIND: `127.0.0.1:${port}`, MEDIA_ROOT: root, CACHE_ROOT: resolve(root, "cache"),
      RUST_LOG: "warn", TRUSTED_PROXY_CIDRS: "", ...options.env,
    };
    if (options.beforeStart) await options.beforeStart(fixture);
    await fixture.startServer({}, options.binary);
    await run(fixture);
  } finally {
    for (const child of children) child.kill();
    await Promise.all([...children].map((child) => child.exitCode === null ? new Promise((done) => child.once("close", done)) : undefined));
    for (const stream of streams) await new Promise((done) => stream.end(done));
    if (containerStarted) docker(["rm", "-f", container]);
  }
}
