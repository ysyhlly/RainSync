// Runs against the deployed Compose stack and real FFmpeg. No public media required.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { promisify } from "node:util";
const execAsync = promisify(execFile);
import WS from "ws";

const base = "http://localhost:8088";
const env = Object.fromEntries(
  (await readFile(".env", "utf8"))
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
let cookie = "",
  csrf = "",
  agent,
  pair,
  socket,
  room,
  original,
  state;
const sessions = [];
const compatibleFixture = await readFile("media/rainsync-demo.mp4");
await execAsync(
  "docker",
  [
    "run",
    "--rm",
    "-v",
    `${process.cwd()}/media:/media`,
    "rainsync-server:dev",
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-i",
    "/media/rainsync-demo.mp4",
    "-c:v",
    "mpeg4",
    "-q:v",
    "5",
    "-c:a",
    "aac",
    "/media/rainsync-incompatible.mp4",
  ],
  { timeout: 60000 },
);
const incompatibleFixture = await readFile("media/rainsync-incompatible.mp4");
let reads = 0;
const source = createServer((req, res) => {
  if (req.headers["x-source-key"] !== "fixture-only") {
    res.writeHead(403).end();
    return;
  }
  reads++;
  const fixture = req.url.startsWith("/legacy.mp4")
    ? incompatibleFixture
    : compatibleFixture;
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2]
    ? Math.min(Number(match[2]), fixture.length - 1)
    : fixture.length - 1;
  if (start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${fixture.length}` }).end();
    return;
  }
  res.writeHead(match ? 206 : 200, {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    ...(match
      ? { "Content-Range": `bytes ${start}-${end}/${fixture.length}` }
      : {}),
  });
  res.end(req.method === "HEAD" ? undefined : fixture.subarray(start, end + 1));
});
await new Promise((r) => source.listen(18089, "0.0.0.0", r));
async function api(path, method = "GET", body) {
  const r = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      Origin: base,
      Cookie: cookie,
      "x-csrf-token": csrf,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.headers.get("set-cookie"))
    cookie = r.headers.get("set-cookie").split(";")[0];
  const value = await r.json();
  assert.equal(r.status, 200, `${path}: ${JSON.stringify(value)}`);
  return value;
}
const inbox = [];
async function wait(type) {
  for (let i = 0; i < 100; i++) {
    const index = inbox.findIndex((v) => v.type === type);
    if (index >= 0) return inbox.splice(index, 1)[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("missing " + type);
}
async function change(media_id) {
  socket.send(
    JSON.stringify({
      protocol_version: 1,
      room_id: room.id,
      command_id: randomUUID(),
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id },
    }),
  );
  state = (await wait("ACK")).state;
}
try {
  csrf = (
    await api("/auth/login", "POST", {
      username: "admin",
      password: env.ADMIN_PASSWORD,
    })
  ).csrf;
  room =
    (await api("/rooms")).find(
      (r) => r.name === "Remote playback verification",
    ) ??
    (await api("/rooms", "POST", { name: "Remote playback verification" }));
  socket = new WS(base.replace("http", "ws") + "/api/v1/ws", {
    headers: { Origin: base, Cookie: cookie },
  });
  socket.on("message", (b) => inbox.push(JSON.parse(b)));
  await new Promise((r, j) => {
    socket.once("open", r);
    socket.once("error", j);
  });
  socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  state = (await wait("SNAPSHOT")).state;
  original = state.media_id;
  let httpSource = (await api("/sources")).find(
    (s) => s.name === "Remote HTTP verification",
  );
  httpSource ??= await api("/sources", "POST", {
    name: "Remote HTTP verification",
    kind: "http",
    config: {
      url: "http://host.docker.internal:18089/fixture.mp4",
      headers: { "x-source-key": "fixture-only" },
    },
  });
  await api(`/sources/${httpSource.id}/test`, "POST");
  // Source IDs are intentionally not exposed by the library endpoint: resolve in the test database.
  const httpId = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "rainsync",
      "-Atc",
      `SELECT id FROM media_items WHERE source_id='${httpSource.id}'`,
    ],
    { encoding: "utf8" },
  ).trim();
  pair = await api("/agents", "POST", { name: "Remote playback test agent" });
  const name = "rainsync-test-agent-" + randomUUID().slice(0, 8);
  agent = { name };
  // Pass the pairing code through process environment, never command output.
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "-e",
      "PAIR_CODE",
      "-e",
      "SERVER_URL=http://host.docker.internal:8088",
      "-e",
      "MEDIA_ROOT=/media",
      "-e",
      "AGENT_CREDENTIAL_FILE=/tmp/credentials.json",
      "-v",
      `${process.cwd()}/media:/media:ro`,
      "rainsync-server:dev",
      "rainsync-nas-agent",
    ],
    { env: { ...process.env, PAIR_CODE: pair.pair_code }, stdio: "ignore" },
  );
  agent.child = child;
  let agentId;
  for (let i = 0; i < 40; i++) {
    agentId = execFileSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "rainsync",
        "-Atc",
        `SELECT id FROM media_items WHERE source_id='${pair.id}' AND resource='rainsync-demo.mp4'`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (agentId) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(agentId, "outbound agent registered and indexed");
  let legacySource = (await api("/sources")).find(
    (s) => s.name === "Remote legacy verification",
  );
  legacySource ??= await api("/sources", "POST", {
    name: "Remote legacy verification",
    kind: "http",
    config: {
      url: "http://host.docker.internal:18089/legacy.mp4",
      headers: { "x-source-key": "fixture-only" },
    },
  });
  await api(`/sources/${legacySource.id}/test`, "POST");
  const lookup = (sourceId, file) =>
    execFileSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "psql",
        "-U",
        "rainsync",
        "-Atc",
        `SELECT id FROM media_items WHERE source_id='${sourceId}'${file ? ` AND resource='${file}'` : ""}`,
      ],
      { encoding: "utf8" },
    ).trim();
  const legacyHttpId = lookup(legacySource.id);
  const legacyAgentId = lookup(pair.id, "rainsync-incompatible.mp4");
  assert.ok(legacyAgentId);

  for (const [kind, id, incompatible] of [
    ["HTTP", httpId],
    ["NAS", agentId],
    ["HTTP incompatible", legacyHttpId, true],
    ["NAS incompatible", legacyAgentId, true],
  ]) {
    await change(id);
    for (const mode of incompatible
      ? ["auto"]
      : ["auto", "remux", "transcode"]) {
      const plan = await api("/playback-sessions", "POST", {
        room_id: room.id,
        media_generation: state.media_generation,
        mode,
        position_ms: 4000,
      });
      sessions.push(plan.session_id);
      assert.ok(plan.duration_ms > 19000, "remote probe duration");
      assert.equal(
        plan.delivery_mode,
        mode === "auto" ? (incompatible ? "transcode" : "direct") : mode,
      );
      if (plan.delivery_mode !== "direct") {
        assert.equal(plan.timeline_origin_ms, 4000);
        assert.equal(plan.rebuild_on_seek, true);
      }
      const response = await fetch(base + plan.playback_url);
      assert.equal(response.status, 200);
      if (plan.delivery_mode === "direct") {
        assert.ok((await response.arrayBuffer()).byteLength > 10000);
      } else {
        assert.ok((await response.text()).startsWith("#EXTM3U"));
        await execAsync(
          "docker",
          [
            "run",
            "--rm",
            "rainsync-server:dev",
            "ffmpeg",
            "-v",
            "error",
            "-i",
            "http://host.docker.internal:8088" + plan.playback_url,
            "-t",
            "1",
            "-f",
            "null",
            "-",
          ],
          { stdio: "pipe", timeout: 60000 },
        );
      }
      await api(`/playback-sessions/${plan.session_id}`, "DELETE");
      assert.equal(
        (await fetch(base + plan.playback_url)).status,
        401,
        "stopped session rejected",
      );
      console.log(`PASS ${kind}: ${mode}, real decode and session revocation`);
    }
  }
  assert.ok(
    reads > 3,
    "worker forwards administrator-configured source headers",
  );
} finally {
  for (const id of sessions)
    await api(`/playback-sessions/${id}`, "DELETE").catch(() => {});
  if (original && state) await change(original).catch(() => {});
  socket?.close();
  if (pair) await api(`/agents/${pair.id}`, "DELETE").catch(() => {});
  if (agent) {
    try {
      execFileSync("docker", ["stop", agent.name], {
        stdio: "ignore",
        timeout: 15000,
      });
    } catch {}
  }
  source.closeAllConnections();
  source.close();
}
