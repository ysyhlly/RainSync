import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { open, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";

if (process.platform !== "linux") {
  console.log(
    "SKIP: SIGTERM and real NAS file-descriptor witness require Linux",
  );
  process.exit(0);
}
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(25);
  }
  throw Error(`deadline: ${label}`);
}
await isolatedMediaStack("agent-graceful-shutdown", async (f) => {
  const admin = f.client(),
    user = await admin.login();
  const filePath = resolve(f.root, "long.mp4");
  const file = await open(filePath, "w");
  await file.truncate(1024 * 1024 * 1024);
  await file.close();
  const encrypt = (value) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(f.env.SOURCE_ENCRYPTION_KEY, "base64"),
        nonce,
      );
    return Buffer.concat([
      nonce,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  };
  async function sourceOpen() {
    for (const fd of await readdir(`/proc/${f.agentPid}/fd`)) {
      try {
        if ((await readlink(`/proc/${f.agentPid}/fd/${fd}`)) === filePath)
          return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return false;
  }
  let req;
  try {
    await f.startWorker();
    const { agentId } = await f.startAgent();
    await until(
      () =>
        f.sql(
          `SELECT count(*) FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4' AND source_version IS NOT NULL`,
        ) === "1",
      "NAS index",
    );
    const sourceVersion = f.sql(
      `SELECT source_version FROM media_items WHERE source_id='${agentId}' AND resource='long.mp4'`,
    );
    const room = await admin.request("/rooms", "POST", {
      name: "graceful NAS restart",
    });
    const session = randomUUID(),
      token = randomBytes(32).toString("hex");
    const resource = {
      kind: "agent",
      agent_id: agentId,
      resource: "long.mp4",
      source_version: sourceVersion,
    };
    f.sql(
      `INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES('${session}','${user.id}','${room.id}',0,'${createHash("sha256").update(token).digest("hex")}','{"encrypted":"${encrypt(resource)}","upstream_closed":true}',now()+interval '1 hour')`,
    );
    let response,
      aborted = false;
    req = request(
      `${f.workerOrigin}/media-delivery/${session}/source?token=${token}`,
      (res) => {
        response = res;
        res.on("error", () => {});
        res.on("aborted", () => {
          aborted = true;
        });
        res.pause();
      },
    );
    req.on("error", () => {});
    req.end();
    await until(() => response, "NAS response");
    assert.equal(response.statusCode, 200);
    await until(sourceOpen, "paused NAS owns open source");
    const transfer = f.sql(
      `SELECT id FROM agent_transfer_runs WHERE session_id='${session}'`,
    );
    assert.equal(
      f.sql(
        `SELECT agent_drained_at IS NULL FROM agent_transfer_runs WHERE id='${transfer}'`,
      ),
      "t",
    );
    const began = Date.now();
    await f.stopAgent();
    const shutdownMs = Date.now() - began;
    let saved = [];
    try {
      saved = JSON.parse(
        await readFile(resolve(f.root, "agent-token.drained.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const persistedBeforeRestart = saved.includes(transfer);
    response.resume();
    await until(() => aborted, "old NAS response aborts");
    await f.startAgent();
    const current = await admin.request(`/rooms/${room.id}/lifecycle`);
    await admin.request(`/rooms/${room.id}/close`, "POST", {
      expected_revision: current.state.revision,
    });
    await delay(8000);
    const status = await admin.request(`/rooms/${room.id}/lifecycle`);
    const acknowledged =
      f.sql(
        `SELECT agent_drained_at IS NOT NULL FROM agent_transfer_runs WHERE id='${transfer}'`,
      ) === "t";
    const result = {
      shutdown_ms: shutdownMs,
      persisted_before_restart: persistedBeforeRestart,
      acknowledged_after_restart: acknowledged,
      lifecycle: status.lifecycle,
      cleanup_error: status.cleanup?.last_error,
    };
    await writeFile(
      resolve(f.root, "agent-graceful-shutdown.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(JSON.stringify(result));
    assert.ok(shutdownMs < 5000, "healthy Agent shutdown is bounded");
    assert.equal(
      persistedBeforeRestart,
      true,
      "SIGTERM drains and persists its positive receipt",
    );
    assert.equal(
      acknowledged,
      true,
      "restarted Agent replays its completed receipt",
    );
    assert.equal(status.lifecycle, "closed");
    assert.equal(
      f.sql(
        `SELECT t.agent_drained_at<=e.created_at FROM agent_transfer_runs t JOIN room_lifecycle_events e ON e.room_id='${room.id}' AND e.lifecycle='closed' WHERE t.id='${transfer}'`,
      ),
      "t",
    );
    console.log(
      "PASS: paused real NAS SIGTERM drains/persists receipt; Agent restart replays it and room close completes",
    );
    result.signal_cases = [];
    for (const phase of ["connecting", "retry-sleep"]) {
      let contacted = false;
      const peers = new Set();
      const mock = createServer((socket) => {
        peers.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => peers.delete(socket));
        socket.on("data", () => {
          contacted = true;
          // For connecting, leave the WebSocket handshake pending. For retry,
          // reject it so the process reaches its ordinary two-second backoff.
          if (phase === "retry-sleep")
            socket.end(
              "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
            );
        });
      });
      await new Promise((done) => mock.listen(0, "127.0.0.1", done));
      const child = spawn(resolve(f.target, "rainsync-nas-agent"), [], {
        env: {
          ...f.env,
          SERVER_URL: `http://127.0.0.1:${mock.address().port}`,
          MEDIA_ROOT: f.root,
          AGENT_TOKEN: "isolated-signal-fixture",
          AGENT_CREDENTIAL_FILE: resolve(f.root, `${phase}-credential`),
        },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      try {
        await until(() => contacted, `${phase}: initial connection`);
        await delay(100);
        const began = Date.now();
        child.kill("SIGTERM");
        let timeout;
        const exit = await Promise.race([
          done,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(Error(`${phase}: SIGTERM did not interrupt waiting`)),
              2000,
            );
          }),
        ]).finally(() => clearTimeout(timeout));
        const elapsed = Date.now() - began;
        assert.equal(exit.code, 0, `${phase}: cooperative signal exit`);
        assert.equal(exit.signal, null);
        result.signal_cases.push({
          phase,
          shutdown_ms: elapsed,
          exit_code: exit.code,
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await done;
        for (const socket of peers) socket.destroy();
        await new Promise((done) => mock.close(done));
      }
    }
    await writeFile(
      resolve(f.root, "agent-graceful-shutdown.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      "PASS: SIGTERM interrupts a pending connect and retry sleep with successful cooperative exits",
    );
  } finally {
    req?.destroy();
  }
});
