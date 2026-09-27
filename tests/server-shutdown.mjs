import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WS from "ws";

// Disposable database, actual Server and native process trees. The container
// remains alive after Server exits so teardown cannot hide leaked descendants.
const image =
  process.env.SERVER_TEST_IMAGE ?? "rainsync-worker-validation:local";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const name = `rainsync-shutdown-${randomUUID().slice(0, 8)}`,
  db = `${name}-db`;
const root = resolve(".runtime/server-shutdown", name);
const password = randomBytes(24).toString("hex"),
  key = randomBytes(32).toString("base64");
const origin = "http://shutdown.test";
const children = [],
  sockets = [];
const report = {
  image: docker("image", "inspect", "--format", "{{.Id}}", image),
  cases: [],
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`deadline: ${description}`);
}
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
await mkdir(root, { recursive: true });
await writeFile(resolve(root, "fixture.mp4"), "probe input fixture");
await writeFile(
  resolve(root, "ffprobe"),
  `#!/bin/sh
sleep 120 &
leaf=$!
printf '%s\\n%s\\n' "$$" "$leaf" > /state/probe.pids.tmp
mv /state/probe.pids.tmp /state/probe.pids
wait "$leaf"
`,
  { mode: 0o755 },
);
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
      return docker(
        "exec",
        db,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "rainsync",
      ).includes("accepting connections");
    } catch {
      return false;
    }
  }, "database ready");
  const cases = process.argv.includes("--lock-loss-only")
    ? ["LOCK_LOSS"]
    : ["TERM", "INT", "LOCK_LOSS", "LOCK_STALL", "LOCK_DURING_DRAIN"];
  for (const signal of cases) {
    const server = `${name}-${signal.toLowerCase()}`,
      state = resolve(root, signal);
    await mkdir(state);
    children.push(server);
    docker(
      "run",
      "-d",
      "--name",
      server,
      "--network",
      name,
      "-p",
      "127.0.0.1::8080",
      "-e",
      `DATABASE_URL=postgres://rainsync:${password}@db/rainsync`,
      "-e",
      `SOURCE_ENCRYPTION_KEY=${key}`,
      "-e",
      `ADMIN_PASSWORD=${password}`,
      "-e",
      `PUBLIC_ORIGIN=${origin}`,
      "-e",
      "PATH=/media:/usr/local/bin:/usr/bin:/bin",
      "--mount",
      `type=bind,source=${root},target=/media,readonly`,
      "--mount",
      `type=bind,source=${state},target=/state`,
      image,
      "sh",
      "-c",
      'rainsync-server & server=$!; printf "%s" "$server" > /state/server.pid; wait "$server"; code=$?; printf "%s" "$code" > /state/server.exit; exec sleep 120',
    );
    const base = `http://${docker("port", server, "8080/tcp")}`;
    await until(async () => {
      try {
        return (
          await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
        ).ok;
      } catch {
        return false;
      }
    }, "server ready");
    let cookie = "",
      csrf = "";
    async function api(path, body) {
      const response = await fetch(`${base}/api/v1${path}`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "x-csrf-token": csrf,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      if (response.headers.has("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      assert.equal(
        response.status,
        200,
        `${path}: ${await response.clone().text()}`,
      );
      return response.json();
    }
    csrf = (await api("/auth/login", { username: "admin", password })).csrf;
    const room = await api("/rooms", { name: `Shutdown ${signal}` });
    const socket = new WS(base.replace("http", "ws") + "/api/v1/ws", {
      headers: { Origin: origin, Cookie: cookie },
    });
    sockets.push(socket);
    let snapshot = false,
      closed = false;
    socket.on("message", (data) => {
      if (JSON.parse(data).type === "SNAPSHOT") snapshot = true;
    });
    socket.on("close", () => {
      closed = true;
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    await until(() => snapshot, "room snapshot");
    const source = await api("/sources", {
      name: "Stalled local probe",
      kind: "local",
      config: { root: "/media" },
    });
    const scan = api(`/sources/${source.id}/test`).catch(() => null);
    await until(() => {
      try {
        docker("exec", server, "test", "-s", "/state/probe.pids");
        return true;
      } catch {
        return false;
      }
    }, "local probe started");
    const pids = docker("exec", server, "cat", "/state/probe.pids").split(
      /\s+/,
    );
    assert.equal(pids.length, 2);
    for (const pid of pids) {
      assert.match(pid, /^\d+$/);
      docker("exec", server, "test", "-d", `/proc/${pid}`);
    }
    const pid = docker("exec", server, "cat", "/state/server.pid");
    assert.match(pid, /^\d+$/);
    const began = Date.now();
    const lockFailure = signal.startsWith("LOCK_");
    let stoppedBackend;
    if (!lockFailure || signal === "LOCK_DURING_DRAIN") {
      const osSignal = lockFailure ? "TERM" : signal;
      docker("exec", server, "sh", "-c", `kill -${osSignal} "$1"`, "sh", pid);
      await delay(300);
      assert.equal(
        sql("SELECT pg_try_advisory_lock(72614931)"),
        "f",
        "instance lock remains held during healthy drain",
      );
    }
    if (lockFailure) {
      const backend = sql(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=72614931 AND granted",
      );
      assert.match(backend, /^\d+$/);
      if (signal === "LOCK_STALL") {
        stoppedBackend = backend;
        docker(
          "exec",
          "-u",
          "postgres",
          db,
          "sh",
          "-c",
          'kill -STOP "$1"',
          "sh",
          backend,
        );
      } else {
        assert.equal(sql(`SELECT pg_terminate_backend(${backend})`), "t");
      }
    }
    await until(
      () => {
        try {
          docker("exec", server, "test", "-s", "/state/server.exit");
          return true;
        } catch {
          return false;
        }
      },
      "server shutdown",
      lockFailure ? 8000 : 20000,
    );
    assert.equal(
      docker("exec", server, "cat", "/state/server.exit"),
      lockFailure ? "1" : "0",
    );
    for (const child of pids)
      docker("exec", server, "test", "!", "-e", `/proc/${child}`);
    assert.equal(
      docker("inspect", "--format", "{{.State.Running}}", server),
      "true",
    );
    await until(() => closed, "watching socket closed", 3000);
    await scan;
    if (stoppedBackend)
      docker(
        "exec",
        "-u",
        "postgres",
        db,
        "sh",
        "-c",
        'kill -CONT "$1"',
        "sh",
        stoppedBackend,
      );
    await until(
      () => sql("SELECT pg_try_advisory_lock(72614931)") === "t",
      "instance lock released after exit",
      3000,
    );
    report.cases.push({
      signal,
      elapsed_ms: Date.now() - began,
      container_still_running: true,
      remaining_processes: 0,
      websocket_closed: true,
      exit_code: lockFailure ? 1 : 0,
      lock_held_during_drain: !lockFailure || signal === "LOCK_DURING_DRAIN",
      lock_released_after_exit: true,
    });
  }
  await writeFile(
    resolve(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `PASS: ${cases.join("/")} close watching sockets and reap stalled probe trees before exit\nEvidence: ${resolve(root, "report.json")}`,
  );
} catch (error) {
  report.failure = String(error?.stack ?? error);
  await writeFile(
    resolve(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw error;
} finally {
  sockets.forEach((socket) => socket.terminate());
  for (const container of [...children, db]) {
    try {
      docker("rm", "-f", "-v", container);
    } catch {}
  }
  try {
    docker("network", "rm", name);
  } catch {}
}
