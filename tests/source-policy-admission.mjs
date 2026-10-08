// Real isolated Server/PostgreSQL with a controlled loopback Jellyfin contract.
// Run with W03_BACKEND_BINDING (or RAINSYNC_SOURCE_ACCESS_BINDING_FILE),
// CARGO_TARGET_DIR, RAINSYNC_ARTIFACT_DIR and optionally RAINSYNC_NATIVE_POSTGRES_BIN.
// No builds, installs, existing database, private Rust calls or SQL state mutation.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WS from "ws";
import { delay, isolatedServer } from "./fixtures/server.mjs";
import { verifyClosedPort } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bindingPath =
  process.env.W03_BACKEND_BINDING ??
  process.env.RAINSYNC_SOURCE_ACCESS_BINDING_FILE;
assert.ok(bindingPath, "a successful frozen backend binding is required");
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "an external artifact directory is required",
);
const bindingBytes = await readFile(bindingPath);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.ok(binding.source.length > 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
assert.ok(
  binding.source.some(
    (entry) =>
      entry.path === "migrations/0032_source_access_policy_revisions.sql",
  ),
);
assert.equal(binding.binaries.length, 3);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
const suffix = process.platform === "win32" ? ".exe" : "";
for (const name of [
  "rainsync-server",
  "rainsync-media-worker",
  "rainsync-nas-agent",
]) {
  const binary = binding.binaries.find((entry) => entry.name === name);
  assert.ok(binary, `binding includes ${name}`);
  assert.equal(
    resolve(binary.path),
    resolve(target, name + suffix),
    `binding executes the configured ${name} path`,
  );
}
const coordinator = await Promise.all(
  [
    "tests/source-policy-admission.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/postgres.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(
    digest(await readFile(bindingPath)),
    digest(bindingBytes),
    "binding remains unchanged",
  );
  for (const input of [...binding.source, ...coordinator]) {
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `bound source unchanged: ${input.path}`,
    );
  }
  for (const binary of binding.binaries) {
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      `frozen binary unchanged: ${binary.name}`,
    );
  }
}
// Verify source equality and all three binary paths/hashes before starting I/O.
await verifyBinding();
const runId = randomUUID();
const root = resolve(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "source-policy-admission",
  runId,
);
await mkdir(root, { recursive: true });
const reportPath = resolve(root, "report.json");
const report = {
  schema_version: 1,
  run_id: runId,
  started_at: new Date().toISOString(),
  result: "running",
  scope:
    "Real isolated Server and PostgreSQL; controlled Jellyfin-like loopback upstream. No real external product, Worker, media decode or browser claim.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
  cases: [],
  failures: [],
  cleanup: {},
};
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(40);
  }
  throw Error(`Deadline: ${label}`);
}
const gates = new Set();
function gate() {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  const result = { promise, release };
  gates.add(result);
  return result;
}
async function scenario(name, run) {
  const record = {
    name,
    started_at: new Date().toISOString(),
    result: "running",
  };
  report.cases.push(record);
  await save();
  try {
    await run(record);
    record.result = "passed";
    console.log(`PASS ${name}`);
  } catch (error) {
    record.result = "failed";
    record.error = String(error.stack ?? error);
    report.failures.push({ name, error: record.error });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    record.finished_at = new Date().toISOString();
    await save();
  }
}

const token = randomBytes(24).toString("hex");
const contract = { queue: [], events: [], sessions: new Map(), failures: [] };
let upstreamOrigin;
const upstream = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, upstreamOrigin);
    const authorization =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    assert.ok(
      authorization.includes(`Token=\"${token}\"`) ||
        request.headers["x-emby-token"] === token,
      "fixture credential forwarded",
    );
    const device = /DeviceId="([^"]+)"/.exec(authorization)?.[1];
    let body = {};
    if (request.method === "POST") {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      body = bytes ? JSON.parse(bytes) : {};
    }
    const event = {
      at: new Date().toISOString(),
      path: url.pathname,
      method: request.method,
      device_id: device ?? null,
      sid: body.PlaySessionId ?? null,
    };
    contract.events.push(event);
    const json = (value) => {
      event.response_status = 200;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    };
    if (url.pathname === "/Users/fixture-user") return json({Id:"fixture-user",Policy:{IsDisabled:false,EnableMediaPlayback:true}});
    if (url.pathname === "/Users/fixture-user/Items") {
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture",
            Name: "Source policy fixture",
            RunTimeTicks: 600000000,
          },
        ],
      });
    }
    if (url.pathname === "/Items/fixture/PlaybackInfo") {
      assert.match(device ?? "", /^rainsync-[0-9a-f-]{36}$/);
      assert.equal(body.IsPlayback, true);
      const fault = contract.queue.shift() ?? { name: "normal" };
      const sid = randomUUID();
      Object.assign(event, { sid, scenario: fault.name });
      const session = {
        sid,
        device,
        fault,
        starts: 0,
        stops: 0,
        stopped: false,
      };
      contract.sessions.set(sid, session);
      fault.received = event;
      if (fault.playback) await fault.playback.promise;
      event.released_at = new Date().toISOString();
      return json({
        PlaySessionId: sid,
        MediaSources: [
          {
            Id: "fixture-media-source",
            SupportsDirectPlay: true,
            RunTimeTicks: 600000000,
            MediaStreams: [],
          },
        ],
      });
    }
    if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
      ].includes(url.pathname)
    ) {
      const session = contract.sessions.get(body.PlaySessionId);
      assert.ok(session, "reported SID belongs to a real fixture negotiation");
      assert.equal(
        device,
        session.device,
        "cleanup/report device matches exact negotiation",
      );
      assert.equal(body.ItemId, "fixture");
      assert.equal(body.MediaSourceId, "fixture-media-source");
      if (url.pathname === "/Sessions/Playing") session.starts++;
      if (url.pathname.endsWith("Stopped")) {
        session.fault.stop_received = event;
        if (session.fault.stop) await session.fault.stop.promise;
        session.stops++;
        session.stopped = true;
      }
      event.response_status = 204;
      event.confirmed_at = new Date().toISOString();
      response.writeHead(204).end();
      return;
    }
    throw Error(
      `Unexpected controlled upstream route ${request.method} ${url.pathname}`,
    );
  } catch (error) {
    contract.failures.push(String(error.stack ?? error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

class Controller {
  constructor(fixture, client) {
    this.fixture = fixture;
    this.client = client;
    this.inbox = [];
  }
  async wait(check) {
    return until(() => {
      const index = this.inbox.findIndex(check);
      return index < 0 ? null : this.inbox.splice(index, 1)[0];
    }, "room WebSocket response");
  }
  async join(room) {
    this.room = room;
    this.socket = new WS(
      this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      { headers: { Origin: this.fixture.origin, Cookie: this.client.cookie } },
    );
    this.socket.on("message", (bytes) => this.inbox.push(JSON.parse(bytes)));
    await new Promise((done, reject) => {
      this.socket.once("open", done);
      this.socket.once("error", reject);
    });
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.wait((entry) => entry.type === "SNAPSHOT");
    this.state = snapshot.state;
    this.epoch = snapshot.control_epoch.id;
  }
  async change(media) {
    const id = randomUUID();
    this.socket.send(
      JSON.stringify({
        protocol_version: 1,
        room_id: this.room.id,
        control_epoch: this.epoch,
        command_id: id,
        expected_revision: this.state.revision,
        media_generation: this.state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media },
      }),
    );
    const answer = await this.wait((entry) => entry.command_id === id);
    assert.equal(answer.type, "ACK");
    this.state = answer.state;
  }
  async close() {
    if (!this.socket || this.socket.readyState === WS.CLOSED) return;
    const closed = new Promise((done) => this.socket.once("close", done));
    this.socket.terminate();
    await closed;
  }
}

let fixture;
let upstreamPort;
const controllers = [];
try {
  await new Promise((done, reject) =>
    upstream.once("error", reject).listen(0, "127.0.0.1", done),
  );
  upstreamPort = upstream.address().port;
  upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;
  report.upstream = { origin: upstreamOrigin, port: upstreamPort };
  await isolatedServer(
    "source-policy-admission",
    async (f) => {
      fixture = f;
      report.fixture = {
        id: f.id,
        root: f.root,
        origin: f.origin,
        database: f.postgresDiagnostics(),
      };
      const admin = f.client();
      const user = await admin.login();
      const allowed = {
        schema_version: 1,
        origins: [{ origin: upstreamOrigin, cidrs: ["127.0.0.1/32"] }],
      };
      const denied = {
        schema_version: 1,
        origins: [{ origin: upstreamOrigin, cidrs: ["127.0.0.2/32"] }],
      };
      const read = (query) => JSON.parse(f.sql(query) || "null");
      const reservation = (id) =>
        read(
          `SELECT jsonb_build_object('id',id,'user_id',user_id,'request_key',request_key,'owner_epoch',owner_epoch,'room_id',room_id,'source_id',source_id,'source_policy_revision',source_policy_revision,'device_id',device_id,'state',state,'negotiation',negotiation,'negotiation_token',negotiation_token,'io_claim',io_claim,'io_kind',io_kind,'play_session_id',play_session_id,'media_source_id',media_source_id,'response_persisted',response_encrypted IS NOT NULL,'scope_persisted',scope_encrypted IS NOT NULL,'start_reported',start_reported,'stop_confirmed',stop_confirmed,'encoding_stop_confirmed',encoding_stop_confirmed,'cleanup_attempts',cleanup_attempts,'cleanup_deadline',cleanup_deadline,'close_reason',close_reason,'closed_at',closed_at,'last_error',last_error) FROM upstream_reservations WHERE id=${quote(id)}`,
        );
      const requestRow = (key) =>
        read(
          `SELECT jsonb_build_object('session_id',session_id,'room_id',room_id,'owner_epoch',owner_epoch,'status',status,'error_code',error_code,'error_status',error_status,'response_persisted',response_encrypted IS NOT NULL,'attempt',attempt,'viewer_id',viewer_id,'plan_generation',plan_generation,'preparation_drained_at',preparation_drained_at) FROM playback_requests WHERE idempotency_key=${quote(key)}`,
        );
      const highWater = (room, viewer) =>
        Number(
          f.sql(
            `SELECT plan_generation FROM playback_viewer_plans WHERE user_id=${quote(user.id)} AND room_id=${quote(room.id)} AND viewer_id=${quote(viewer)}`,
          ),
        );
      const session = (id) =>
        read(
          `SELECT jsonb_build_object('id',id,'stopped',stopped,'viewer_id',viewer_id,'plan_generation',plan_generation,'source_policy_revision',resource->'source_policy_revision') FROM playback_sessions WHERE id=${quote(id)}`,
        );
      const prepare = async (body) => {
        const response = await admin.raw("/playback-sessions", {
          method: "POST",
          body,
          signal: AbortSignal.timeout(40000),
        });
        return { status: response.status, body: await response.json() };
      };
      const expectError = (response, status, code) => {
        assert.equal(response.status, status);
        assert.equal(response.body.error?.code, code);
        assert.equal(response.body.session_id, undefined);
        assert.equal(response.body.playback_url, undefined);
      };
      const readiness = async (id, expected = 200) =>
        admin.request(`/playback-sessions/${id}`, "GET", undefined, expected);
      async function setup(name) {
        const source = await admin.request("/sources", "POST", {
          name,
          kind: "jellyfin",
          config: {
            url: upstreamOrigin,
            token,
            user_id: "fixture-user",
            access_policy: allowed,
          },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const media = f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(source.id)}`,
        );
        assert.match(media, /^[0-9a-f-]{36}$/);
        const room = await admin.request("/rooms", "POST", { name });
        const controller = new Controller(f, admin);
        controllers.push(controller);
        await controller.join(room);
        await controller.change(media);
        const body = (viewer, generation, key = randomUUID()) => ({
          room_id: room.id,
          media_generation: controller.state.media_generation,
          viewer_id: viewer,
          plan_generation: generation,
          idempotency_key: key,
          mode: "direct",
          position_ms: 1200,
        });
        return { source, room, controller, body };
      }
      async function revise(source, revision, policy) {
        const changed = await admin.request(
          `/sources/${source.id}/access-policy`,
          "POST",
          { expected_revision: revision, policy },
        );
        assert.equal(changed.access_policy_revision, revision + 1);
        assert.equal(
          f.sql(
            `SELECT access_policy_revision FROM sources WHERE id=${quote(source.id)}`,
          ),
          String(revision + 1),
        );
        assert.equal(
          f.sql(
            `SELECT revision FROM source_access_policy_snapshots WHERE source_id=${quote(source.id)}`,
          ),
          String(revision + 1),
        );
        return changed;
      }
      const control = await setup("unrelated source and viewer grants");
      const sharedViewer = randomUUID();
      const controlBodies = [
        control.body(sharedViewer, 3),
        control.body(randomUUID(), 4),
      ];
      const controls = [];
      for (const body of controlBodies) {
        const response = await prepare(body);
        assert.equal(response.status, 200);
        controls.push({
          body,
          plan: response.body,
          row: reservation(response.body.session_id),
        });
      }
      async function assertControls() {
        for (const current of controls) {
          assert.equal(
            (await readiness(current.plan.session_id)).plan_generation,
            current.body.plan_generation,
          );
          assert.equal(session(current.plan.session_id).stopped, false);
          assert.equal(reservation(current.plan.session_id).state, "active");
          assert.equal(
            highWater(control.room, current.body.viewer_id),
            current.body.plan_generation,
          );
          assert.equal(
            contract.sessions.get(current.row.play_session_id).stops,
            0,
          );
          assert.equal(
            contract.sessions.get(current.row.play_session_id).starts,
            1,
          );
        }
        assert.equal(
          f.sql(
            `SELECT access_policy_revision FROM sources WHERE id=${quote(control.source.id)}`,
          ),
          "1",
        );
      }

      for (const tighten of [false, true]) {
        await scenario(
          tighten
            ? "strict policy race retains denied late-SID cleanup without inventing receipts"
            : "same allowed policy race fences publication and owns late-SID cleanup",
          async (record) => {
            const subject = await setup(
              tighten ? "strict policy race" : "same allowed policy race",
            );
            const body = subject.body(sharedViewer, 5);
            const fault = {
              name: tighten ? "strict-policy-race" : "same-policy-race",
              playback: gate(),
              stop: tighten ? null : gate(),
            };
            contract.queue.push(fault);
            const pending = prepare(body).then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
            try {
              await until(
                () => fault.received,
                "PlaybackInfo is paused after durable admission",
              );
              const request = requestRow(body.idempotency_key);
              assert.ok(request);
              const before = reservation(request.session_id);
              record.before = before;
              assert.equal(request.status, "pending");
              assert.equal(request.preparation_drained_at, null);
              assert.equal(
                f.sql(
                  `SELECT drained_at IS NULL FROM playback_preparations WHERE session_id=${quote(request.session_id)}`,
                ),
                "t",
              );
              assert.equal(before.state, "preparing");
              assert.equal(before.negotiation, "running");
              assert.equal(before.io_kind, "negotiate");
              assert.ok(before.io_claim);
              assert.equal(before.io_claim, before.negotiation_token);
              assert.equal(before.owner_epoch, request.owner_epoch);
              assert.equal(before.user_id, user.id);
              assert.equal(before.request_key, body.idempotency_key);
              assert.equal(before.room_id, subject.room.id);
              assert.equal(before.source_id, subject.source.id);
              assert.equal(before.source_policy_revision, 1);
              assert.equal(before.device_id, fault.received.device_id);
              assert.equal(before.play_session_id, null);
              assert.equal(before.scope_persisted, true);
              assert.equal(session(request.session_id), null);
              assert.equal(highWater(subject.room, sharedViewer), 5);

              record.policy_change = await revise(
                subject.source,
                1,
                tighten ? denied : allowed,
              );
              record.policy_committed_at = new Date().toISOString();
              const revoked = reservation(request.session_id);
              record.revoked_while_paused = revoked;
              assert.equal(revoked.state, "closing");
              assert.equal(revoked.close_reason, "source_changed");
              assert.equal(revoked.negotiation, "running");
              assert.equal(revoked.play_session_id, null);
              assert.equal(revoked.io_claim, before.io_claim);
              assert.equal(revoked.closed_at, null);
              assert.equal(revoked.stop_confirmed, false);
              assert.equal(revoked.start_reported, false);
              assert.equal(
                requestRow(body.idempotency_key).preparation_drained_at,
                null,
              );
              assert.equal(
                f.sql(
                  `SELECT drained_at IS NULL FROM playback_preparations WHERE session_id=${quote(request.session_id)}`,
                ),
                "t",
                "revision cannot acknowledge a held preparation owner",
              );
              assert.equal(contract.sessions.get(fault.received.sid).starts, 0);
              assert.equal(contract.sessions.get(fault.received.sid).stops, 0);
              await assertControls();
              fault.playback.release();
              const outcome = await pending;
              if (outcome.error) throw outcome.error;
              record.response = {
                status: outcome.value.status,
                error: outcome.value.body.error,
              };
              assert.equal(outcome.value.status, 409);
              assert.ok(
                ["SOURCE_CHANGED", "PLAYBACK_REQUEST_INTERRUPTED"].includes(
                  outcome.value.body.error?.code,
                ),
                "policy retirement may precede the final source revision gate",
              );
              assert.equal(outcome.value.body.playback_url, undefined);
              assert.equal(outcome.value.body.session_id, undefined);
              const failed = requestRow(body.idempotency_key);
              record.failed_request = failed;
              assert.equal(failed.status, "failed");
              assert.equal(failed.response_persisted, false);
              assert.equal(
                failed.error_code.toUpperCase(),
                outcome.value.body.error.code,
              );
              assert.equal(failed.attempt, 1);
              assert.equal(
                session(request.session_id),
                null,
                "stale preparation publishes no session row",
              );
              assert.equal(
                f.sql(
                  `SELECT count(*) FROM media_jobs WHERE session_id=${quote(request.session_id)}`,
                ),
                "0",
              );
              assert.equal(
                f.sql(
                  `SELECT count(*) FROM playback_observations WHERE session_id=${quote(request.session_id)}`,
                ),
                "0",
              );
              const checkpoint = reservation(request.session_id);
              record.checkpoint = checkpoint;
              assert.equal(checkpoint.negotiation, "received");
              assert.equal(checkpoint.play_session_id, fault.received.sid);
              assert.equal(checkpoint.media_source_id, "fixture-media-source");
              assert.equal(checkpoint.response_persisted, true);
              assert.equal(
                checkpoint.source_policy_revision,
                1,
                "cleanup retains the captured admission revision",
              );
              assert.equal(checkpoint.close_reason, "source_changed");
              assert.equal(checkpoint.device_id, before.device_id);
              assert.equal(checkpoint.owner_epoch, before.owner_epoch);
              assert.equal(checkpoint.start_reported, false);
              assert.equal(checkpoint.closed_at, null);
              assert.equal(checkpoint.stop_confirmed, false);
              assert.equal(
                highWater(subject.room, sharedViewer),
                5,
                "failure never lowers viewer high-water",
              );
              if (tighten) {
                // The actual bounded cleanup owner must exhaust its own budget.
                // Do not accelerate leases or synthesize a stop/drain receipt in SQL.
                await until(
                  () =>
                    reservation(request.session_id).state === "cleanup_failed",
                  "denied cleanup reaches its real bounded terminal state",
                  70000,
                );
                const terminal = reservation(request.session_id);
                record.terminal = terminal;
                assert.equal(terminal.close_reason, "source_changed");
                assert.equal(terminal.play_session_id, fault.received.sid);
                assert.equal(terminal.negotiation, "received");
                assert.equal(terminal.stop_confirmed, false);
                assert.equal(terminal.encoding_stop_confirmed, false);
                assert.equal(terminal.closed_at, null);
                assert.ok(
                  terminal.cleanup_attempts > 0 &&
                    terminal.cleanup_attempts <= 5,
                );
                assert.equal(
                  contract.sessions.get(fault.received.sid).stops,
                  0,
                  "tightened policy prevents cleanup reaching the old destination",
                );
                assert.equal(
                  contract.events.filter(
                    (event) =>
                      event.sid === fault.received.sid &&
                      event.path !== "/Items/fixture/PlaybackInfo",
                  ).length,
                  0,
                );
              } else {
                await until(
                  () => fault.stop_received,
                  "late-SID Stop reaches its exact controlled owner",
                );
                const stopping = reservation(request.session_id);
                record.stop_pending = stopping;
                assert.equal(stopping.state, "closing");
                assert.equal(stopping.io_kind, "stop");
                assert.ok(stopping.io_claim);
                assert.equal(
                  stopping.stop_confirmed,
                  false,
                  "an in-flight Stop is not a receipt",
                );
                assert.equal(stopping.closed_at, null);
                assert.equal(fault.stop_received.sid, fault.received.sid);
                assert.equal(fault.stop_received.device_id, before.device_id);
                fault.stop.release();
                await until(
                  () => reservation(request.session_id).state === "closed",
                  "late-SID cleanup confirmed by the real Stop response",
                );
                record.terminal = reservation(request.session_id);
                assert.equal(record.terminal.stop_confirmed, true);
                assert.ok(record.terminal.closed_at);
                assert.equal(record.terminal.close_reason, "source_changed");
                assert.equal(
                  contract.sessions.get(fault.received.sid).stops,
                  1,
                );
                assert.equal(fault.stop_received.response_status, 204);
                assert.ok(fault.stop_received.confirmed_at);
              }
              assert.equal(
                contract.sessions.get(fault.received.sid).starts,
                0,
                "late rejected negotiation never invents Start",
              );
              await until(
                () => requestRow(body.idempotency_key).preparation_drained_at,
                "returned local preparation owner records its own drain",
              );
              record.preparation_drained_at = requestRow(
                body.idempotency_key,
              ).preparation_drained_at;
              assert.equal(
                f.sql(
                  `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id=${quote(request.session_id)}`,
                ),
                "t",
              );
              assert.ok(
                new Date(record.preparation_drained_at).getTime() >=
                  new Date(fault.received.released_at).getTime(),
              );
              const count = contract.events.filter((event) =>
                event.path.endsWith("PlaybackInfo"),
              ).length;
              expectError(
                await prepare({ ...body, idempotency_key: randomUUID() }),
                409,
                "STALE_PLAYBACK_PLAN",
              );
              expectError(
                await prepare({
                  ...body,
                  idempotency_key: randomUUID(),
                  plan_generation: 4,
                }),
                409,
                "STALE_PLAYBACK_PLAN",
              );
              assert.equal(
                contract.events.filter((event) =>
                  event.path.endsWith("PlaybackInfo"),
                ).length,
                count,
              );
              await assertControls();
              record.unrelated_grants_unchanged = true;
            } finally {
              fault.playback.release();
              fault.stop?.release();
              await pending;
            }
          },
        );
      }

      await scenario(
        "completed replay is denied after revision and higher viewer generation recovers",
        async (record) => {
          const subject = await setup("completed replay policy revision");
          const viewer = sharedViewer;
          const body = subject.body(viewer, 7);
          const first = await prepare(body);
          assert.equal(first.status, 200);
          const before = requestRow(body.idempotency_key);
          assert.equal(before.status, "completed");
          assert.equal(
            session(first.body.session_id).source_policy_revision,
            1,
          );
          const count = () =>
            contract.events.filter((event) =>
              event.path.endsWith("PlaybackInfo"),
            ).length;
          let negotiations = count();
          const replay = await prepare(body);
          assert.equal(replay.status, 200);
          assert.equal(replay.body.session_id, first.body.session_id);
          assert.equal(count(), negotiations);
          record.policy_change = await revise(subject.source, 1, allowed);
          assert.equal(
            (await readiness(first.body.session_id, 410)).error.code,
            "INVALID_PLAYBACK_SESSION",
          );
          assert.equal(
            (
              await admin.request(
                `/playback-sessions/${first.body.session_id}`,
                "POST",
                undefined,
                410,
              )
            ).error.code,
            "INVALID_PLAYBACK_SESSION",
          );
          const expired = await prepare(body);
          expectError(expired, 410, "PLAYBACK_REQUEST_EXPIRED");
          record.completed_replay = {
            status: expired.status,
            error: expired.body.error,
          };
          const retained = requestRow(body.idempotency_key);
          assert.equal(retained.session_id, before.session_id);
          assert.equal(retained.status, "completed");
          assert.equal(retained.attempt, before.attempt);
          assert.equal(highWater(subject.room, viewer), 7);
          expectError(
            await prepare(subject.body(viewer, 7)),
            409,
            "STALE_PLAYBACK_PLAN",
          );
          expectError(
            await prepare(subject.body(viewer, 6)),
            409,
            "STALE_PLAYBACK_PLAN",
          );
          assert.equal(
            count(),
            negotiations,
            "denied replay/equal/lower intents never renegotiate",
          );
          const nextBody = subject.body(viewer, 8);
          const next = await prepare(nextBody);
          assert.equal(next.status, 200);
          assert.equal(next.body.plan_generation, 8);
          assert.notEqual(next.body.session_id, first.body.session_id);
          assert.equal(highWater(subject.room, viewer), 8);
          assert.equal(session(next.body.session_id).source_policy_revision, 2);
          assert.equal(
            reservation(next.body.session_id).source_policy_revision,
            2,
          );
          assert.equal(
            (await readiness(next.body.session_id)).plan_generation,
            8,
          );
          negotiations = count();
          const lateOldReplay = await prepare(body);
          expectError(lateOldReplay, 409, "STALE_PLAYBACK_PLAN");
          expectError(
            await prepare(subject.body(viewer, 7)),
            409,
            "STALE_PLAYBACK_PLAN",
          );
          const nextReplay = await prepare(nextBody);
          assert.equal(nextReplay.status, 200);
          assert.equal(nextReplay.body.session_id, next.body.session_id);
          assert.equal(count(), negotiations);
          assert.equal(session(next.body.session_id).stopped, false);
          assert.equal(requestRow(nextBody.idempotency_key).attempt, 1);
          await until(
            () => reservation(first.body.session_id).state === "closed",
            "old completed grant cleanup",
          );
          await assertControls();
          record.old_session = first.body.session_id;
          record.new_session = next.body.session_id;
          record.new_revision = 2;
          record.high_water = 8;
          record.late_old_replay_error = lateOldReplay.body.error.code;
          record.unrelated_grants_unchanged = true;
        },
      );

      await scenario(
        "active fixture grants close through authenticated API cleanup",
        async (record) => {
          const active = read(
            "SELECT COALESCE(json_agg(id),'[]'::json) FROM playback_sessions WHERE NOT stopped",
          );
          for (const id of active) {
            await admin.request(`/playback-sessions/${id}`, "DELETE");
            await until(
              () => reservation(id).state === "closed",
              "owned active grant Stop receipt",
            );
          }
          assert.equal(
            f.sql("SELECT count(*) FROM playback_sessions WHERE NOT stopped"),
            "0",
          );
          assert.equal(
            f.sql(
              "SELECT count(*) FROM upstream_reservations WHERE state IN ('preparing','active','closing')",
            ),
            "0",
          );
          assert.equal(
            f.sql(
              "SELECT count(*) FROM upstream_reservations WHERE state='cleanup_failed' AND close_reason='source_changed' AND NOT stop_confirmed AND closed_at IS NULL",
            ),
            "1",
            "denied remote cleanup stays honestly unconfirmed",
          );
          record.stopped_sessions = active;
          record.denied_cleanup_unconfirmed = 1;
        },
      );
      assert.deepEqual(
        contract.failures,
        [],
        "controlled upstream contract failures",
      );
      for (const controller of controllers) await controller.close();
    },
    {
      binary: resolve(target, "rainsync-server" + suffix),
      env: { PLAYBACK_SESSION_LIMIT: "16" },
    },
  );
} catch (error) {
  report.failures.push({
    name: "setup or harness",
    error: String(error.stack ?? error),
  });
} finally {
  for (const pendingGate of gates) pendingGate.release();
  for (const controller of controllers) await controller.close();
  if (upstream.listening) {
    const closed = new Promise((done) => upstream.close(done));
    upstream.closeAllConnections();
    await closed;
  }
  try {
    if (fixture) report.cleanup.fixture = await fixture.verifyStopped();
    if (upstreamPort) {
      assert.equal(await verifyClosedPort(upstreamPort), true);
      report.cleanup.upstream_port_closed = true;
    }
    await verifyBinding();
    report.backend_source_and_three_binaries_unchanged = true;
    report.cleanup.completed = Boolean(
      fixture && report.cleanup.upstream_port_closed,
    );
  } catch (error) {
    report.failures.push({
      name: "cleanup or binding",
      error: String(error.stack ?? error),
    });
  }
  report.contract_events = contract.events;
  report.contract_failures = contract.failures;
  report.controlled_sessions = [...contract.sessions.values()].map(
    (session) => ({
      sid: session.sid,
      device_id: session.device,
      scenario: session.fault.name,
      starts: session.starts,
      stops: session.stops,
      stopped: session.stopped,
    }),
  );
  report.finished_at = new Date().toISOString();
  report.result =
    report.failures.length || contract.failures.length ? "failed" : "passed";
  await save();
  console.log(`Evidence: ${reportPath}`);
  if (report.result !== "passed") process.exitCode = 1;
}
