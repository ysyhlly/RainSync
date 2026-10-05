// Successful client-reported control timings on real isolated PostgreSQL/WS.
// No physical network-restoration or playback-recovery measurement claim.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { isolatedServer, delay } from "./fixtures/server.mjs";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingPath = process.env.W03_BACKEND_BINDING;
assert.ok(bindingPath, "Use a successful frozen backend binding");
const bindingBytes = await readFile(bindingPath);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(
  sha(Buffer.from(JSON.stringify(binding.source))),
  binding.source_digest,
);
assert.ok(
  binding.source.some(
    (input) => input.path === "apps/server/src/control_recovery_metrics.rs",
  ),
);
assert.ok(
  binding.binaries.some(
    (binary) =>
      binary.name === "rainsync-server" &&
      resolve(binary.path) ===
        resolve(process.env.CARGO_TARGET_DIR, "debug", "rainsync-server"),
  ),
);
const coordinatorInputs = await Promise.all(
  [
    "tests/control-recovery-runtime.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/postgres.mjs",
  ].map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
);
const verifyBinding = async () => {
  assert.equal(sha(await readFile(bindingPath)), sha(bindingBytes));
  for (const input of [...binding.source, ...coordinatorInputs])
    assert.equal(
      sha(await readFile(input.path)),
      input.sha256,
      `bound source ${input.path}`,
    );
  for (const binary of binding.binaries)
    assert.equal(
      sha(await readFile(binary.path)),
      binary.sha256,
      `bound binary ${binary.name}`,
    );
};
await verifyBinding();
let fixture;
const report = {
  schema_version: 1,
  result: "running",
  checks: [],
  binding: sha(bindingBytes),
  coordinator_inputs: coordinatorInputs,
};
const sockets = new Set();
const locks = new Set();
async function until(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  throw Error(label);
}
async function lock(f, sql) {
  const marker = "transport_metric_lock_" + randomUUID().replaceAll("-", "");
  const child = f.sqlProcess(undefined, { interactive: true });
  locks.add(child);
  let output = "";
  child.stdout.on("data", (bytes) => (output += bytes));
  child.stdin.write(
    `BEGIN; SET application_name=${quote(marker)}; ${sql}; SELECT ${quote(marker)};\n`,
  );
  await until(() => output.includes(marker), "owned lock ready");
  return async (commit = true) => {
    if (child.exitCode === null)
      child.stdin.end(`${commit ? "COMMIT" : "ROLLBACK"};\n`);
    await child.done;
    locks.delete(child);
  };
}
try {
  await isolatedServer("control-recovery-runtime", async (f) => {
    fixture = f;
    try {
      const admin = f.client();
      await admin.login();
      const room = await admin.request("/rooms", "POST", {
        name: "control timing",
      });
      const metric = "rainsync_client_reported_control_recovery_milliseconds";
      const scrape = async () => {
        const response = await fetch(f.origin + "/api/v1/metrics", {
          headers: { Cookie: admin.cookie },
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(response.status, 200);
        return response.text();
      };
      const value = (
        text,
        suffix = "count",
        boundary = "socket_open_to_state_applied",
        background = false,
      ) => {
        const line = text
          .split("\n")
          .find(
            (line) =>
              line.startsWith(metric + "_" + suffix + "{") &&
              line.includes(`boundary="${boundary}"`) &&
              line.includes(`background="${background}"`),
          );
        return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
      };
      const count = async () => value(await scrape());
      const denied = async () => {
        const line = (await scrape())
          .split("\n")
          .find(
            (line) =>
              line.startsWith(
                "rainsync_client_reported_control_recovery_dropped_total{",
              ) && line.includes('reason="unauthorized"'),
          );
        return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
      };
      const packet = (extra) => ({
        type: "CONTROL_RECOVERY_METRICS",
        version: 1,
        socket_open_to_state_applied_ms: 12,
        background: false,
        ...extra,
      });
      const connect = async (
        client = admin,
        {
          version = 1,
          presence = false,
          autoPong = true,
          targetRoom = room.id,
        } = {},
      ) => {
        const ws = new WebSocket(
          f.origin.replace("http", "ws") + "/api/v1/ws",
          {
            headers: { Origin: f.origin, Cookie: client.cookie },
            autoPong,
          },
        );
        sockets.add(ws);
        const frames = [];
        ws.on("message", (bytes) => {
          if (frames.length < 256) frames.push(JSON.parse(bytes));
        });
        ws.on("error", () => {});
        await new Promise((done, reject) => {
          ws.once("open", done);
          ws.once("error", reject);
        });
        const send = (value) =>
          ws.send(typeof value === "string" ? value : JSON.stringify(value));
        send({
          type: "JOIN",
          room_id: targetRoom,
          ...(version === null
            ? {}
            : { control_recovery_metrics_version: version }),
          ...(presence ? { presence_version: 1 } : {}),
        });
        await until(
          () => frames.some((frame) => frame.type === "SNAPSHOT"),
          "initial authoritative snapshot",
        );
        return {
          ws,
          frames,
          send,
          initial: frames.find((frame) => frame.type === "SNAPSHOT"),
        };
      };
      const clock = async (socket) => {
        const t1 = Date.now();
        socket.send({ type: "CLOCK_SYNC", t1 });
        await until(
          () =>
            socket.frames.some(
              (frame) => frame.type === "CLOCK_SYNC_REPLY" && frame.t1 === t1,
            ),
          "normal clock reply remains responsive",
        );
      };
      const check = async (name, run) => {
        const started = Date.now();
        await run();
        report.checks.push({ name, elapsed_ms: Date.now() - started });
      };
      await check(
        "legacy socket does not negotiate or credit; clock control remains usable",
        async () => {
          assert.equal(await count(), 0);
          const legacy = await connect(admin, { version: null });
          assert.equal(
            legacy.initial.control_recovery_metrics_version,
            undefined,
          );
          legacy.send(packet());
          await clock(legacy);
          assert.equal(await count(), 0);
        },
      );
      await check(
        "one current socket credits exactly once, with optional outage and background separated",
        async () => {
          const current = await connect();
          assert.equal(current.initial.control_recovery_metrics_version, 1);
          current.send(packet({ disconnect_observed_to_state_applied_ms: 45 }));
          await until(
            async () => (await count()) === 1,
            "first timing credited",
          );
          current.send(packet({ disconnect_observed_to_state_applied_ms: 45 }));
          current.send(packet({ socket_open_to_state_applied_ms: 999 }));
          await clock(current);
          await delay(50);
          const text = await scrape();
          assert.equal(value(text), 1);
          assert.equal(value(text, "sum"), 12);
          assert.equal(
            value(text, "sum", "disconnect_observed_to_state_applied"),
            45,
          );
          const background = await connect();
          background.send(
            packet({ background: true, socket_open_to_state_applied_ms: 30 }),
          );
          await until(
            async () =>
              value(
                await scrape(),
                "count",
                "socket_open_to_state_applied",
                true,
              ) === 1,
            "background timing credited separately",
          );
          assert.equal(
            value(
              await scrape(),
              "count",
              "disconnect_observed_to_state_applied",
              true,
            ),
            0,
          );
          assert.equal(
            f.sql(
              `SELECT state->>'revision' FROM room_snapshots WHERE room_id=${quote(room.id)}`,
            ),
            "0",
          );
          assert.ok(
            !current.frames.some((v) => v.type === "CONTROL_RECOVERY_METRICS"),
            "no telemetry broadcast/ack",
          );
        },
      );
      await check(
        "invalid, unknown, duplicate JSON fields and oversized timing fail softly",
        async () => {
          const before = await count();
          for (const malformed of [
            packet({ version: 2 }),
            packet({ room_id: randomUUID() }),
            packet({ disconnect_observed_to_state_applied_ms: 1 }),
            JSON.stringify(packet()) + " ".repeat(4096),
            JSON.stringify(packet()).replace(
              '"version":1',
              '"version":1,"version":1',
            ),
          ]) {
            const socket = await connect();
            socket.send(malformed);
            await clock(socket);
          }
          await delay(50);
          assert.equal(await count(), before);
        },
      );
      await check(
        "logout and member deletion queued ahead of report deny aggregate admission",
        async () => {
          await admin.request("/users", "POST", {
            username: "timing-viewer",
            password: f.password,
          });
          const viewer = f.client();
          const user = await viewer.login("timing-viewer", f.password);
          const invite = await admin.request(
            `/rooms/${room.id}/invites`,
            "POST",
          );
          await viewer.request(`/rooms/${room.id}/join`, "POST", {
            token: invite.token,
          });
          const before = await count();
          const loggedOut = await connect(viewer);
          const deniedBefore = await denied();
          await viewer.request("/auth/logout", "POST");
          loggedOut.send(packet());
          await until(
            async () => (await denied()) === deniedBefore + 1,
            "logout metric rejection",
          );
          await viewer.login("timing-viewer", f.password);
          const removed = await connect(viewer);
          const release = await lock(
            f,
            `DELETE FROM room_members WHERE room_id=${quote(room.id)} AND user_id=${quote(user.id)}`,
          );
          removed.send(packet());
          await until(
            () =>
              Number(
                f.sql(
                  "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT user_id FROM room_members%FOR KEY SHARE'",
                ),
              ) > 0,
            "metric member lookup actually waits",
            400,
          );
          await release();
          await until(
            async () => (await denied()) === deniedBefore + 2,
            "member removal rejects pending timing",
          );
          assert.equal(await count(), before);
        },
      );
      await check(
        "expiry committed while session lock is contended is checked after waiting",
        async () => {
          const login = f.client();
          await login.login();
          const socket = await connect(login);
          const token = login.cookie.split("=")[1];
          const hash = sha(token);
          const before = await count();
          const deniedBefore = await denied();
          const release = await lock(
            f,
            `UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=${quote(hash)}`,
          );
          socket.send(packet());
          await until(
            () =>
              Number(
                f.sql(
                  "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT token_hash FROM sessions%FOR SHARE'",
                ),
              ) > 0,
            "metric login check actually waits",
            400,
          );
          await release();
          await until(
            async () => (await denied()) === deniedBefore + 1,
            "post-wait expiry rejection",
          );
          assert.equal(await count(), before);
        },
      );
      await check(
        "contended metric checks release pool capacity while ordinary clocks proceed",
        async () => {
          const login = f.client();
          await login.login();
          const loginHash = sha(login.cookie.split("=")[1]);
          const clients = [];
          for (let i = 0; i < 10; i++) clients.push(await connect(login));
          const before = await count();
          // A separate authenticated login isolates metric admission contention
          // from the administrator scrape; ordinary membership reads still run.
          const release = await lock(
            f,
            `SELECT token_hash FROM sessions WHERE token_hash=${quote(loginHash)} FOR UPDATE`,
          );
          const started = Date.now();
          for (const socket of clients) socket.send(packet());
          await clock(clients[0]);
          assert.ok(
            Date.now() - started < 1000,
            "telemetry does not block normal socket input",
          );
          await delay(2300);
          // /ready and ordinary authentication SELECT remain available while the
          // owning lock is held, including after cancelled query connections close.
          const ready = await fetch(f.origin + "/ready", {
            signal: AbortSignal.timeout(1000),
          });
          assert.equal(ready.status, 200);
          await admin.request("/auth/me");
          assert.equal(await count(), before);
          await release();
        },
      );
      await check(
        "reported metrics do not renew negotiated presence lease",
        async () => {
          const lease = await connect(admin, {
            presence: true,
            autoPong: false,
          });
          const began = Date.now();
          await delay(40000);
          lease.send(packet());
          await until(
            () => lease.ws.readyState === WebSocket.CLOSED,
            "metrics do not extend 45s presence deadline",
            8000,
          );
          const elapsed = Date.now() - began;
          assert.ok(elapsed >= 44000 && elapsed < 48000);
          report.presence_lease_ms = elapsed;
        },
      );
      await verifyBinding();
      report.result = "passed";
    } finally {
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      for (const child of locks)
        if (child.exitCode === null) {
          child.stdin.end("ROLLBACK;\n");
          await child.done.catch(() => {});
        }
      locks.clear();
    }
  });
} catch (error) {
  report.result = "failed";
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  for (const child of locks)
    if (child.exitCode === null) {
      child.stdin.end("ROLLBACK;\n");
      await child.done.catch(() => {});
    }
  if (fixture) {
    report.cleanup = await fixture.verifyStopped();
    await writeFile(
      resolve(fixture.root, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(`${report.result}: ${resolve(fixture.root, "report.json")}`);
    if (report.failure) console.error(report.failure);
  }
}
