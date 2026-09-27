import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createHash,
} from "node:crypto";
import { mkdir, writeFile, readFile, copyFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import net from "node:net";

assert.equal(process.platform, "win32", "Windows native test only");
const root = resolve(".runtime/windows-shutdown", randomUUID()),
  db = `rainsync-win-${randomUUID().slice(0, 8)}`;
const password = randomBytes(24).toString("hex"),
  key = randomBytes(32);
const helpers = [],
  services = [],
  requests = [];
const report = { platform: process.platform, cases: [] };
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`deadline: ${description}`);
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function helper(...args) {
  const child = spawn(
    process.env.PYTHON ?? "python",
    ["tests/windows-console.py", ...args],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const state = { child, events: [], stderr: "", done: false };
  let pending = "";
  child.stdout.on("data", (bytes) => {
    pending += bytes.toString();
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n");
      state.events.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  child.stderr.on("data", (bytes) => {
    state.stderr = (state.stderr + bytes.toString()).slice(-16000);
  });
  child.on("error", (error) => {
    state.stderr += String(error);
    state.done = true;
  });
  child.on("exit", (code) => {
    state.code = code;
    state.done = true;
  });
  helpers.push(state);
  return state;
}
await mkdir(join(root, "bin"), { recursive: true });
await mkdir(join(root, "media"));
await writeFile(join(root, "media", "fixture.mp4"), "controlled probe input");
await copyFile(
  "target/debug/examples/probe_tree_fixture.exe",
  join(root, "bin", "ffprobe.exe"),
);
for (const program of ["rainsync-server", "rainsync-media-worker"]) {
  report[`${program}_sha256`] = createHash("sha256")
    .update(await readFile(`target/debug/${program}.exe`))
    .digest("hex");
}
try {
  docker(
    "run",
    "-d",
    "--name",
    db,
    "-p",
    "127.0.0.1::5432",
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
  const database = `postgres://rainsync:${password}@${docker("port", db, "5432/tcp")}/rainsync?sslmode=disable`;
  let room;
  for (const program of ["rainsync-server", "rainsync-media-worker"]) {
    for (const [event, label] of [
      [0, "ctrl-c"],
      [1, "ctrl-break"],
      ["close", "console-close"],
      ...(program === "rainsync-server" ? [["lock-loss", "lock-loss"]] : []),
    ]) {
      const state = join(root, `${program}-${label}`),
        selectedPort = await port();
      await mkdir(state);
      await mkdir(join(state, "cache"));
      const base = `http://127.0.0.1:${selectedPort}`,
        origin = "http://native-shutdown.test";
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          [
            "systemroot",
            "windir",
            "systemdrive",
            "comspec",
            "pathext",
            "temp",
            "tmp",
            "userprofile",
            "localappdata",
            "appdata",
            "programdata",
          ].includes(key.toLowerCase()),
        ),
      );
      Object.assign(env, {
        Path: `${join(root, "bin")};${process.env.Path ?? process.env.PATH}`,
        DATABASE_URL: database,
        ADMIN_PASSWORD: password,
        SOURCE_ENCRYPTION_KEY: key.toString("base64"),
        PUBLIC_ORIGIN: origin,
        BIND: `127.0.0.1:${selectedPort}`,
        WORKER_BIND: `127.0.0.1:${selectedPort}`,
        MEDIA_ROOT: join(root, "media"),
        CACHE_ROOT: join(state, "cache"),
        RAINSYNC_NATIVE_PROBE: state,
        RUST_LOG: "warn",
      });
      const spec = join(state, "launch.json");
      await writeFile(
        spec,
        JSON.stringify({
          exe: resolve(`target/debug/${program}.exe`),
          env,
          log: join(state, "service.log"),
        }),
      );
      const service = helper("launch", spec);
      services.push(service);
      await until(
        () => service.events.some((e) => e.pid),
        "hidden service created",
      );
      await unlink(spec);
      const pid = service.events.find((e) => e.pid).pid;
      await until(async () => {
        try {
          return (
            await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
          ).ok;
        } catch {
          return false;
        }
      }, "native service ready");
      if (program === "rainsync-server") {
        let cookie = "",
          csrf = "";
        const api = async (path, body) => {
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
          assert.equal(response.status, 200, await response.clone().text());
          return response.json();
        };
        csrf = (await api("/auth/login", { username: "admin", password })).csrf;
        room = (await api("/rooms", { name: "Native shutdown" })).id;
        const source = await api("/sources", {
          name: "Native probe",
          kind: "local",
          config: { root: join(root, "media") },
        });
        requests.push(api(`/sources/${source.id}/test`).catch(() => null));
      } else {
        const id = randomUUID(),
          token = randomBytes(24).toString("hex"),
          nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        const encrypted = Buffer.concat([
          nonce,
          cipher.update(
            JSON.stringify({
              kind: "local",
              root: join(root, "media"),
              resource: "fixture.mp4",
            }),
          ),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64");
        const user = sql("SELECT id FROM users WHERE admin LIMIT 1");
        sql(
          `INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${id}','${user}','${room}',0,'${createHash("sha256").update(token).digest("hex")}',jsonb_build_object('encrypted','${encrypted}'),now()+interval '1 hour')`,
        );
        requests.push(
          fetch(`${base}/media-delivery/${id}/probe?token=${token}`, {
            signal: AbortSignal.timeout(45000),
          })
            .then((response) => response.text())
            .catch(() => null),
        );
      }
      let pids;
      await until(async () => {
        try {
          pids = JSON.parse(await readFile(join(state, "pids.json"), "utf8"));
          return pids.length === 2;
        } catch {
          return false;
        }
      }, "probe descendants started");
      const witness = helper("watch", JSON.stringify(pids));
      await until(
        () => witness.events.some((e) => e.watching),
        "process handles retained",
      );
      const started = Date.now();
      if (event === "lock-loss") {
        assert.equal(
          sql(
            "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=72614931 AND granted",
          ),
          "t",
        );
      } else {
        const sender = helper("signal", String(pid), String(event));
        await until(() => sender.done, "console event delivered", 5000);
        assert.equal(sender.code, 0, sender.stderr);
        assert.ok(sender.events.some((e) => e.delivered));
      }
      await until(
        () => service.done,
        "native shutdown",
        event === "lock-loss" ? 8000 : 20000,
      );
      assert.equal(service.code, 0, service.stderr);
      assert.equal(
        service.events.find((e) => Object.hasOwn(e, "exit_code"))?.exit_code,
        event === "lock-loss" ? 1 : 0,
        service.stderr,
      );
      await until(() => witness.done, "descendants exited", 5000);
      assert.equal(witness.code, 0, witness.stderr);
      assert.ok(witness.events.some((e) => e.exited));
      if (event === "close")
        assert.ok(
          Date.now() - started < 5000,
          "console close must not spend the normal 10-second HTTP grace",
        );
      report.cases.push({
        program,
        event: label,
        elapsed_ms: Date.now() - started,
        exit_code: event === "lock-loss" ? 1 : 0,
        retained_process_handles_signalled: true,
      });
      console.log(
        `PASS: native ${program} ${label} drains blocked probe and descendant`,
      );
    }
  }
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`Evidence: ${join(root, "report.json")}`);
} catch (error) {
  report.failure = String(error?.stack ?? error);
  await writeFile(
    join(root, "failed-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  throw error;
} finally {
  for (const service of services)
    if (!service.done) service.child.stdin.end("kill\n");
  await until(
    () => services.every((service) => service.done),
    "fixture process cleanup",
    10000,
  ).catch(() => {});
  for (const state of helpers) if (!state.done) state.child.kill();
  await Promise.all(requests);
  try {
    docker("rm", "-f", "-v", db);
  } catch {}
}
