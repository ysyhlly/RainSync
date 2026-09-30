import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WS from "ws";
import { isolatedServer } from "./fixtures/server.mjs";

// A native Server, disposable real PostgreSQL and controlled upstream HTTP.
// This proves observation/IO contracts, not real Jellyfin/Emby versions or decoding.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = fileURLToPath(import.meta.url);
const fixtureEntry = resolve(root, "tests/fixtures/server.mjs");
const runId = randomUUID();
const runtime = resolve(process.env.RAINSYNC_RUNTIME_ROOT ?? resolve(root, ".runtime"));
const evidence = resolve(runtime, "upstream-observations", runId);
await mkdir(evidence, { recursive: true });
process.env.RAINSYNC_ARTIFACT_DIR = evidence;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => hash(await readFile(path));
const reportPath = resolve(evidence, "report.json");
const report = {
  started_at: new Date().toISOString(),
  result: "running",
  scope:
    "real authenticated API, PostgreSQL and native Server with controlled upstream HTTP; no real-product decode claim",
  run_id: runId,
  cases: [],
  failures: [],
  cleanup: { completed: false, steps: [], volumes: [] },
};
const save = () =>
  writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, seconds = 15) {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`deadline: ${label}`);
}
function deferred() {
  let release;
  const promise = new Promise((done) => (release = done));
  const result = { promise, release };
  holds.add(result);
  return result;
}
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const uuid = (id) => {
  assert.match(id, /^[0-9a-f-]{36}$/);
  return `'${id}'`;
};
const publicLedger = (row) =>
  Object.fromEntries(
    [
      "id",
      "kind",
      "state",
      "play_session_id",
      "device_id",
      "io_claim",
      "io_kind",
      "io_pending",
      "io_uncertain",
      "io_observation_seq",
      "io_observation",
      "stop_confirmed",
      "encoding_stop_confirmed",
      "cleanup_attempts",
      "closed_at",
      "last_error",
    ].map((key) => [key, row[key] ?? null]),
  );
const planFields = (plan) =>
  Object.fromEntries(
    [
      "session_id",
      "observation_version",
      "observation_seq",
      "timeline_origin_ms",
      "duration_ms",
    ].map((key) => [key, plan[key]]),
  );
async function scenario(name, run) {
  const result = {
    name,
    started_at: new Date().toISOString(),
    result: "running",
  };
  report.cases.push(result);
  await save();
  await run(result);
  result.result = "passed";
  result.finished_at = new Date().toISOString();
  await save();
  console.log(`PASS: ${name}`);
}

const token = randomBytes(24).toString("hex");
const holds = new Set();
const contract = { requests: [], queue: [], sessions: new Map(), failures: [] };
let upstreamOrigin;
let listening = false;
const upstream = createServer((request, response) => {
  (async () => {
    const url = new URL(request.url, upstreamOrigin);
    const [kind, ...parts] = url.pathname.slice(1).split("/");
    assert.ok(["jellyfin", "emby"].includes(kind));
    const path = "/" + parts.join("/");
    const authorization =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    assert.ok(
      authorization.includes(`Token="${token}"`) ||
        request.headers["x-emby-token"] === token,
    );
    const device =
      /DeviceId="([^"]+)"/.exec(authorization)?.[1] ??
      url.searchParams.get("DeviceId") ??
      request.headers["x-emby-device-id"] ??
      null;
    let body = {};
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        assert.ok(text.length <= 1024 * 1024);
      }
      body = text ? JSON.parse(text) : {};
    }
    const event = {
      at: new Date().toISOString(),
      monotonic_ms: performance.now(),
      kind,
      method: request.method,
      path,
      device_id: device,
      play_session_id:
        body.PlaySessionId ?? url.searchParams.get("PlaySessionId") ?? null,
      position_ticks: body.PositionTicks ?? null,
      paused: body.IsPaused ?? null,
      playback_rate: body.PlaybackRate ?? null,
      event_name: body.EventName ?? null,
    };
    contract.requests.push(event);
    response.once("close", () => {
      if (!response.writableEnded)
        event.connection_closed_at_ms = performance.now();
    });
    const json = (value, status = 200) => {
      event.response_status = status;
      response
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    };
    if (path === "/Users/fixture-user") return json({Id:"fixture-user",Policy:{IsDisabled:false,EnableMediaPlayback:true}});
    if (path === "/Users/fixture-user/Items")
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture",
            Name: `${kind} observation fixture`,
            RunTimeTicks: 600000000,
          },
        ],
      });
    if (path === "/Items/fixture/PlaybackInfo") {
      assert.match(device ?? "", /^rainsync-[0-9a-f-]{36}$/);
      const fault = contract.queue.shift() ?? { name: "normal" };
      assert.equal(
        fault.kind,
        kind,
        "queued preparation belongs to the real source",
      );
      event.scenario = fault.name;
      fault.negotiation = event;
      if (fault.temporary_failure)
        return json({ error: "controlled temporary negotiation failure" }, 503);
      const sid = randomUUID();
      event.play_session_id = sid;
      contract.sessions.set(sid, {
        kind,
        device,
        fault,
        stopped: false,
        encoding_active: false,
      });
      return json({
        PlaySessionId: sid,
        MediaSources: fault.empty_sources
          ? []
          : [
              {
                Id: `source-${kind}`,
                SupportsDirectPlay: true,
                RunTimeTicks: 600000000,
                TranscodingUrl: `${upstreamOrigin}/${kind}/Videos/fixture/master.m3u8?PlaySessionId=${sid}`,
                MediaStreams: [
                  { Type: "Audio", Index: 1, Codec: "aac", Language: "eng" },
                ],
              },
            ],
      });
    }
    if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
      ].includes(path)
    ) {
      const session = contract.sessions.get(body.PlaySessionId);
      assert.ok(session, "wire report references a genuinely negotiated SID");
      assert.equal(kind, session.kind);
      assert.equal(device, session.device);
      const slot =
        path === "/Sessions/Playing"
          ? "start_hold"
          : path.endsWith("Progress")
            ? "progress_hold"
            : "stop_hold";
      const held = session.fault[slot];
      if (held) {
        delete session.fault[slot];
        held.received = event;
        await held.promise;
      }
      if (path === "/Sessions/Playing") {
        session.encoding_active = true;
        session.stopped = false;
        event.applied_at_ms = performance.now();
      }
      if (path.endsWith("Stopped")) {
        session.stopped = true;
        if (kind === "jellyfin") session.encoding_active = false;
      }
      event.response_status = 204;
      response.writeHead(204).end();
      return;
    }
    if (path === "/Videos/ActiveEncodings" && request.method === "DELETE") {
      const session = contract.sessions.get(event.play_session_id);
      assert.ok(session);
      assert.equal(kind, "emby");
      assert.equal(url.searchParams.get("DeviceId"), session.device);
      assert.equal(device, session.device);
      session.encoding_active = false;
      session.stopped = true;
      event.response_status = 200;
      response.writeHead(200).end();
      return;
    }
    json({ error: "unhandled observation contract route" }, 404);
  })().catch((error) => {
    contract.failures.push(String(error.stack ?? error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
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
    }, "real controller response");
  }
  async join(room) {
    this.room = room;
    this.socket = new WS(
      this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      { headers: { Origin: this.fixture.origin, Cookie: this.client.cookie } },
    );
    this.socket.on("message", (bytes) => {
      const value = JSON.parse(bytes);
      if (value.control_epoch) this.epoch = value.control_epoch.id;
      this.inbox.push(value);
    });
    this.socket.on("error", () => {});
    await new Promise((done, reject) => {
      const deadline = setTimeout(
        () => reject(Error("real controller connection deadline")),
        15000,
      );
      this.socket.once("open", () => {
        clearTimeout(deadline);
        done();
      });
      this.socket.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.wait((v) => v.type === "SNAPSHOT");
    this.state = snapshot.state;
    this.epoch = snapshot.control_epoch.id;
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState === WS.OPEN)
        this.socket.send(
          JSON.stringify({ type: "CLOCK_SYNC", t1: Date.now() }),
        );
    }, 5000);
  }
  async change(media) {
    const id = randomUUID();
    const command = {
      protocol_version: 1,
      room_id: this.room.id,
      control_epoch: this.epoch,
      command_id: id,
      expected_revision: this.state.revision,
      media_generation: this.state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: media },
    };
    this.socket.send(JSON.stringify(command));
    let answer = await this.wait((v) => v.command_id === id);
    if (
      answer.type === "ERROR" &&
      ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
        answer.error?.code,
      ) &&
      answer.control_epoch
    ) {
      command.control_epoch = answer.control_epoch.id;
      this.socket.send(JSON.stringify(command));
      answer = await this.wait((v) => v.command_id === id);
    }
    assert.equal(answer.type, "ACK");
    this.state = answer.state;
  }
  close() {
    clearInterval(this.heartbeat);
    this.socket?.terminate();
  }
}

let bindingPath, binding, nativeSource, nativeCopy, controller, fixtureIdentity, ownedFixture;
let fixtureHash,
  entryHash,
  bindingHash,
  ownedVolumes = [];
const binaryHashes = new Map();
const sourceHashes = new Map();
let fixtureInvoked = false;
async function cleanupStep(name, action) {
  const step = { name, result: "running" };
  report.cleanup.steps.push(step);
  try {
    await action(step);
    step.result = "passed";
  } catch (error) {
    step.result = "failed";
    step.error = String(error.stack ?? error);
    report.failures.push({ cleanup: name, error: step.error });
    report.result = "failed";
    process.exitCode = 1;
  }
}

try {
  entryHash = report.entry_sha256 = await digest(entry);
  fixtureHash = report.fixture_entry_sha256 = await digest(fixtureEntry);
  assert.ok(
    process.env.W03_BACKEND_BINDING,
    "set the new observation batch W03_BACKEND_BINDING; do not reuse the first-batch binding",
  );
  bindingPath = resolve(process.env.W03_BACKEND_BINDING);
  const bindingRelative = relative(
    resolve(runtime, "w03-viewer-backend"),
    bindingPath,
  );
  assert.ok(!isAbsolute(bindingRelative) && !bindingRelative.startsWith(".."));
  bindingHash = await digest(bindingPath);
  binding = JSON.parse(await readFile(bindingPath, "utf8"));
  assert.ok(
    binding.source.some((f) => /^migrations[\/]0026_/.test(f.path)),
    "compiled source binding includes observation migration 26",
  );
  for (const file of binding.source) {
    const path = resolve(root, file.path);
    const sourceRelative = relative(root, path);
    assert.ok(!isAbsolute(sourceRelative) && !sourceRelative.startsWith(".."));
    const actual = await digest(path);
    assert.equal(actual, file.sha256, `compiled input ${file.path}`);
    sourceHashes.set(path, actual);
  }
  for (const binary of binding.binaries) {
    const actual = await digest(binary.path);
    assert.equal(actual, binary.sha256, `compiled binary ${binary.name}`);
    binaryHashes.set(binary.path, actual);
  }
  const server = binding.binaries.find((b) => b.name === "rainsync-server");
  assert.ok(server);
  nativeSource = server.path;
  nativeCopy = resolve(
    evidence,
    `server-under-test${process.platform === "win32" ? ".exe" : ""}`,
  );
  await copyFile(nativeSource, nativeCopy);
  assert.equal(await digest(nativeCopy), server.sha256);
  report.backend_binding = {
    path: bindingPath,
    sha256: bindingHash,
    source_digest: binding.source_digest,
    source: binding.source,
    actual_binaries: binding.binaries,
    tested_copy: nativeCopy,
  };
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  listening = true;
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  fixtureInvoked = true;
  await isolatedServer(
    "upstream-observations",
    async (fixture) => {
      const boundMigrations=binding.source.map(file=>/^migrations[\/](\d+)_.*\.sql$/.exec(file.path)).filter(Boolean).map(match=>Number(match[1])).sort((a,b)=>a-b);
      assert.ok(boundMigrations.includes(26),"observation migration26 remains bound");
      assert.equal(
        fixture.sql("SELECT max(version) FROM _sqlx_migrations WHERE success"),
        String(Math.max(...boundMigrations)),
        "database matches the successful bound backend's latest migration",
      );
      assert.equal(
        fixture.sql(`SELECT count(*) FROM _sqlx_migrations WHERE success AND version IN(${boundMigrations.join(",")})`),
        String(boundMigrations.length),
        "every migration in the bound source is applied successfully",
      );
      const admin = fixture.client();
      const adminUser = await admin.login();
      const guestName = `observations-${runId.slice(0, 8)}`;
      const guestPassword = randomBytes(24).toString("hex");
      await admin.request("/users", "POST", {
        username: guestName,
        password: guestPassword,
      });
      const guest = fixture.client();
      const guestUser = await guest.login(guestName, guestPassword);
      assert.notEqual(adminUser.id, guestUser.id);
      report.authenticated_users = [adminUser.id, guestUser.id];
      const room = await admin.request("/rooms", "POST", {
        name: "Independent observation API contract",
      });
      const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
      await guest.request(`/rooms/${room.id}/join`, "POST", {
        token: invite.token,
      });
      controller = new Controller(fixture, admin);
      await controller.join(room);
      const media = {};
      for (const kind of ["jellyfin", "emby"]) {
        const source = await admin.request("/sources", "POST", {
          name: `${kind} observations`,
          kind,
          config: {
            url: `${upstreamOrigin}/${kind}`,
            user_id: "fixture-user",
            token,
          },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        media[kind] = fixture.sql(
          `SELECT id FROM media_items WHERE source_id=${uuid(source.id)}`,
        );
        uuid(media[kind]);
      }
      const ledger = (id) =>
        JSON.parse(
          fixture.sql(
            `SELECT row_to_json(u) FROM upstream_reservations u WHERE id=${uuid(id)}`,
          ),
        );
      const observation = (id) =>
        JSON.parse(
          fixture.sql(
            `SELECT row_to_json(o) FROM playback_observations o WHERE session_id=${uuid(id)}`,
          ),
        );
      const wire = (grant, path) =>
        contract.requests.filter(
          (e) => e.play_session_id === grant.sid && e.path === path,
        );
      const makeBody = (grant, seq, extra = {}) => ({
        media_generation: grant.generation,
        seq,
        event: "progress",
        media_time_ms: 1000,
        paused: false,
        seeking: false,
        buffering: false,
        playback_rate: 1,
        has_played: true,
        ...extra,
      });
      const observe = async (
        grant,
        body,
        status = 200,
        code,
        client = grant.client,
      ) => {
        const answer = await client.request(
          `/playback-sessions/${grant.plan.session_id}/observations`,
          "POST",
          body,
          status,
        );
        // Internal reasons map one-to-one to the public protocol's uppercase
        // variants. A generic HTTP-status fallback must fail this assertion.
        if (code) assert.equal(answer.error?.code, code.toUpperCase());
        if (status === 200) {
          assert.equal(answer.session_id, grant.plan.session_id);
          assert.equal(answer.observation_seq, body.seq);
          assert.equal(
            answer.has_played,
            observation(grant.plan.session_id).has_played,
          );
        }
        return answer;
      };
      const prepare = async (
        kind,
        client = admin,
        fault = {},
        key = randomUUID(),
        options = {},
      ) => {
        const queued = { name: `${kind}-${key}`, kind, ...fault };
        contract.queue.push(queued);
        const response = await client.request(
          "/playback-sessions",
          "POST",
          {
            room_id: room.id,
            media_generation: controller.state.media_generation,
            idempotency_key: key,
            mode: "auto",
            position_ms: 1200,
            observation_version: 1,
            ...options,
          },
          fault.empty_sources || fault.temporary_failure ? 502 : 200,
        );
        if (fault.empty_sources || fault.temporary_failure)
          return { fault: queued, key, error: response };
        assert.equal(response.observation_version, 1);
        assert.equal(response.observation_seq, 0);
        assert.ok(Number.isFinite(response.timeline_origin_ms));
        assert.ok(Number.isFinite(response.duration_ms));
        const row = ledger(response.session_id);
        assert.equal(row.play_session_id, queued.negotiation.play_session_id);
        assert.equal(row.device_id, queued.negotiation.device_id);
        return {
          kind,
          client,
          key,
          fault: queued,
          sid: row.play_session_id,
          device: row.device_id,
          generation: controller.state.media_generation,
          plan: response,
        };
      };
      const assertWire = (event, grant, body) => {
        assert.equal(event.device_id, grant.device);
        assert.equal(event.play_session_id, grant.sid);
        assert.equal(
          event.position_ticks,
          Math.round(
            (grant.plan.timeline_origin_ms + body.media_time_ms) * 10000,
          ),
        );
        assert.equal(
          event.paused,
          body.paused || body.seeking || body.buffering,
        );
        assert.equal(event.playback_rate, body.playback_rate);
        if (event.path.endsWith("Progress"))
          assert.equal(event.event_name, event.paused ? "Pause" : "TimeUpdate");
        assert.equal(event.response_status, 204);
      };
      const reported = async (
        grant,
        body,
        path = "/Sessions/Playing/Progress",
      ) => {
        const event = await until(() => {
          const row = observation(grant.plan.session_id);
          return row.reported_seq === body.seq
            ? wire(grant, path).findLast(
                (e) =>
                  e.position_ticks ===
                    Math.round(
                      (grant.plan.timeline_origin_ms + body.media_time_ms) *
                        10000,
                    ) && e.response_status === 204,
              )
            : null;
        }, `claimed seq ${body.seq} reaches real upstream and durable ACK`);
        assertWire(event, grant, body);
        return event;
      };
      const knownStop = async (grant) => {
        const row = await until(
          () => {
            const r = ledger(grant.plan.session_id);
            return r.state === "closed" ? r : null;
          },
          "known Stop and original identity release",
          65,
        );
        const remote = contract.sessions.get(grant.sid);
        assert.equal(remote.stopped, true);
        assert.equal(remote.encoding_active, false);
        assert.ok(
          wire(grant, "/Sessions/Playing/Stopped").some(
            (e) => e.response_status === 204 && e.device_id === grant.device,
          ),
        );
        if (grant.kind === "emby")
          assert.ok(
            wire(grant, "/Videos/ActiveEncodings").some(
              (e) => e.response_status === 200 && e.device_id === grant.device,
            ),
          );
        assert.ok(row.closed_at);
        return publicLedger(row);
      };

      for (const kind of ["jellyfin", "emby"]) {
        await controller.change(media[kind]);
        await scenario(
          `${kind}: unsupported observation version is rejected before negotiation`,
          async (result) => {
            const before = contract.requests.filter((e) =>
              e.path.endsWith("PlaybackInfo"),
            ).length;
            const rejected = await admin.request(
              "/playback-sessions",
              "POST",
              {
                room_id: room.id,
                media_generation: controller.state.media_generation,
                idempotency_key: randomUUID(),
                mode: "auto",
                observation_version: 2,
              },
              400,
            );
            assert.equal(
              rejected.error?.code,
              "UNSUPPORTED_OBSERVATION_VERSION",
            );
            assert.equal(
              contract.requests.filter((e) => e.path.endsWith("PlaybackInfo"))
                .length,
              before,
            );
            result.negotiations_unchanged = true;
          },
        );
        const first = await prepare(kind);
        const second = await prepare(kind, guest, {}, randomUUID(), {
          position_ms: 5000,
        });
        assert.notEqual(first.sid, second.sid);
        assert.notEqual(first.device, second.device);
        await scenario(
          `${kind}: metadata and never-played observations cause no Start`,
          async (result) => {
            for (const grant of [first, second]) {
              await observe(
                grant,
                makeBody(grant, 1, {
                  event: "buffering",
                  media_time_ms: 0,
                  buffering: true,
                  has_played: false,
                }),
              );
              assert.equal(
                (
                  await grant.client.request(
                    `/playback-sessions/${grant.plan.session_id}`,
                  )
                ).observation_seq,
                1,
              );
              assert.equal(
                (
                  await grant.client.request(
                    `/playback-sessions/${grant.plan.session_id}`,
                    "POST",
                  )
                ).ok,
                true,
              );
            }
            const started = performance.now();
            await delay(11000);
            for (const grant of [first, second]) {
              assert.equal(
                observation(grant.plan.session_id).has_played,
                false,
              );
              assert.equal(wire(grant, "/Sessions/Playing").length, 0);
              assert.equal(wire(grant, "/Sessions/Playing/Progress").length, 0);
              assert.equal(
                contract.sessions.get(grant.sid).encoding_active,
                false,
              );
              const replay = await grant.client.request(
                "/playback-sessions",
                "POST",
                {
                  room_id: room.id,
                  media_generation: grant.generation,
                  idempotency_key: grant.key,
                  mode: "auto",
                  position_ms: grant === second ? 5000 : 1200,
                  observation_version: 1,
                },
              );
              assert.equal(replay.session_id, grant.plan.session_id);
              assert.equal(replay.observation_seq, 1);
            }
            Object.assign(result, {
              actual_no_start_window_ms: performance.now() - started,
              plans: [planFields(first.plan), planFields(second.plan)],
            });
          },
        );
        let firstLatest;
        await scenario(
          `${kind}: two authenticated viewers report independent actual pause and seek positions`,
          async (result) => {
            const a2 = makeBody(first, 2, {
              event: "playing",
              media_time_ms: 1200,
            });
            const b2 = makeBody(second, 2, {
              event: "playing",
              media_time_ms: 7000,
              playback_rate: 1.25,
            });
            await observe(first, a2);
            await observe(second, b2);
            const starts = [
              await reported(first, a2, "/Sessions/Playing"),
              await reported(second, b2, "/Sessions/Playing"),
            ];
            const a3 = makeBody(first, 3, {
              event: "pause",
              media_time_ms: 2000,
              paused: true,
            });
            await observe(first, a3);
            const pause = await reported(first, a3);
            await observe(
              first,
              makeBody(first, 4, {
                event: "seeking",
                media_time_ms: 10000,
                seeking: true,
                paused: true,
              }),
            );
            const a5 = makeBody(first, 5, {
              event: "seeked",
              media_time_ms: 12000,
              paused: true,
            });
            const b3 = makeBody(second, 3, {
              media_time_ms: 9000,
              playback_rate: 1.25,
            });
            await observe(first, a5);
            await observe(second, b3);
            const seeks = [
              await reported(first, a5),
              await reported(second, b3),
            ];
            assert.notEqual(seeks[0].position_ticks, seeks[1].position_ticks);
            firstLatest = makeBody(first, 6, {
              media_time_ms: 13000,
              paused: true,
              playback_rate: 0.75,
              has_played: false,
            });
            const cumulative = await observe(first, firstLatest);
            assert.equal(cumulative.has_played, true);
            await reported(first, firstLatest);
            Object.assign(result, {
              starts,
              pause,
              seeks,
              cumulative_has_played_cannot_be_cleared: true,
            });
          },
        );
        await scenario(
          `${kind}: exact sequence retry is idempotent; conflict and stale samples are fenced`,
          async (result) => {
            const before = observation(first.plan.session_id);
            const wireCount = contract.requests.filter(
              (e) => e.play_session_id === first.sid,
            ).length;
            await observe(first, { ...firstLatest });
            await observe(
              first,
              { ...firstLatest, media_time_ms: firstLatest.media_time_ms + 1 },
              409,
              "observation_conflict",
            );
            await observe(
              first,
              { ...firstLatest, seq: 5 },
              409,
              "observation_sequence_stale",
            );
            const after = observation(first.plan.session_id);
            assert.deepEqual(after, before);
            await delay(1200);
            assert.equal(
              contract.requests.filter((e) => e.play_session_id === first.sid)
                .length,
              wireCount,
            );
            result.observation = after;
          },
        );
        await scenario(
          `${kind}: authentication, owner, generation, membership, expiry and numeric range are validated`,
          async (result) => {
            const next = makeBody(first, 7);
            await observe(first, next, 410, "invalid_playback_session", guest);
            await observe(
              first,
              { ...next, media_generation: first.generation + 1 },
              409,
              "stale_media",
            );
            await observe(
              first,
              { ...next, seq: 0 },
              400,
              "invalid_observation_sequence",
            );
            await observe(
              first,
              { ...next, seq: Number.MAX_SAFE_INTEGER + 1 },
              400,
              "invalid_observation_sequence",
            );
            await observe(first, { ...next, seq: 7.5 }, 422);
            await observe(
              first,
              { ...next, media_time_ms: -1 },
              400,
              "invalid_observation_position",
            );
            await observe(
              first,
              { ...next, media_time_ms: first.plan.duration_ms + 1001 },
              400,
              "invalid_observation_position",
            );
            for (const playback_rate of [0, 0.23749, 4.20001]) {
              await observe(
                first,
                { ...next, playback_rate },
                400,
                "invalid_observation_rate",
              );
            }
            // NaN/Infinity cannot be represented in JSON. The actual request
            // encodes each as null and must fail the typed decode.
            for (const playback_rate of [NaN, Infinity, -Infinity]) {
              await observe(first, { ...next, playback_rate }, 422);
            }
            await observe(first, { ...next, media_time_ms: null }, 422);
            const missing = { ...next };
            delete missing.event;
            await observe(first, missing, 422);
            await observe(first, { ...next, event: "unexpected" }, 422);
            await observe(first, { ...next, unsupported_field: true }, 422);
            const unauthenticated = fixture.client();
            await observe(first, next, 401, "login_required", unauthenticated);
            // Controlled DB revocation: all users, grants and memberships were created
            // through actual authenticated APIs. This is not a membership-removal API test.
            fixture.sql(
              `DELETE FROM room_members WHERE room_id=${uuid(room.id)} AND user_id=${uuid(guestUser.id)}`,
            );
            try {
              await observe(second, makeBody(second, 4), 403, "not_a_member");
            } finally {
              await guest.request(`/rooms/${room.id}/join`, "POST", {
                token: invite.token,
              });
            }
            const expires = fixture.sql(
              `SELECT expires_at FROM playback_sessions WHERE id=${uuid(first.plan.session_id)}`,
            );
            fixture.sql(
              `UPDATE playback_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${uuid(first.plan.session_id)}`,
            );
            try {
              await observe(first, next, 410, "invalid_playback_session");
            } finally {
              assert.match(expires, /^[0-9:T .+\-]+$/);
              fixture.sql(
                `UPDATE playback_sessions SET expires_at='${expires}'::timestamptz WHERE id=${uuid(first.plan.session_id)}`,
              );
            }
            assert.equal(observation(first.plan.session_id).seq, 6);
            result.controlled_db_faults = [
              "membership revocation",
              "grant expiry",
            ];
          },
        );
        await scenario(
          `${kind}: actual correction rates retain both valid endpoints in DB and upstream wire`,
          async (result) => {
            const corrected = await prepare(kind);
            const samples = [];
            for (const [offset, playback_rate] of [
              0.2375, 4.2, 4.1,
            ].entries()) {
              const body = makeBody(corrected, offset + 1, {
                event: offset === 0 ? "playing" : "progress",
                media_time_ms: 1500 + offset * 1000,
                playback_rate,
              });
              await observe(corrected, body);
              await reported(
                corrected,
                body,
                offset === 0
                  ? "/Sessions/Playing"
                  : "/Sessions/Playing/Progress",
              );
              const stored = observation(corrected.plan.session_id);
              assert.deepEqual(stored.payload, body);
              assert.equal(stored.payload.playback_rate, playback_rate);
              samples.push({ seq: body.seq, playback_rate, stored });
            }
            const finalBody = makeBody(corrected, 3, {
              media_time_ms: 3500,
              playback_rate: 4.1,
            });
            await corrected.client.request(
              `/playback-sessions/${corrected.plan.session_id}`,
              "DELETE",
              finalBody,
            );
            await knownStop(corrected);
            assertWire(
              wire(corrected, "/Sessions/Playing/Stopped").at(-1),
              corrected,
              finalBody,
            );
            result.samples = samples;
          },
        );
        await scenario(
          `${kind}: late Start and Progress completion only ACK their captured sequence`,
          async (result) => {
            const startHold = deferred();
            const slow = await prepare(kind, admin, { start_hold: startHold });
            const s1 = makeBody(slow, 1, {
              event: "playing",
              media_time_ms: 3000,
            });
            await observe(slow, s1);
            await until(() => startHold.received, "Start really in flight");
            const progressHold = deferred();
            slow.fault.progress_hold = progressHold;
            const s2 = makeBody(slow, 2, {
              event: "pause",
              media_time_ms: 8000,
              paused: true,
            });
            await observe(slow, s2);
            const duringStart = observation(slow.plan.session_id);
            assert.equal(duringStart.seq, 2);
            assert.equal(duringStart.reported_seq, 0);
            assert.equal(ledger(slow.plan.session_id).io_observation_seq, 1);
            startHold.release();
            await until(
              () => progressHold.received,
              "newer observation owns first Progress",
            );
            assert.equal(observation(slow.plan.session_id).reported_seq, 1);
            assert.equal(ledger(slow.plan.session_id).io_observation_seq, 2);
            const nextProgress = deferred();
            slow.fault.progress_hold = nextProgress;
            const s3 = makeBody(slow, 3, {
              event: "seeked",
              media_time_ms: 19000,
              paused: true,
            });
            await observe(slow, s3);
            assert.equal(observation(slow.plan.session_id).reported_seq, 1);
            progressHold.release();
            await until(
              () => nextProgress.received,
              "latest observation remains due after old IO completion",
            );
            assert.equal(observation(slow.plan.session_id).reported_seq, 2);
            assert.equal(ledger(slow.plan.session_id).io_observation_seq, 3);
            assertWire(startHold.received, slow, s1);
            assertWire(progressHold.received, slow, s2);
            nextProgress.release();
            await reported(slow, s3);
            const final = makeBody(slow, 4, {
              event: "ended",
              media_time_ms: 21000,
              paused: true,
            });
            await slow.client.request(
              `/playback-sessions/${slow.plan.session_id}`,
              "DELETE",
              final,
            );
            await knownStop(slow);
            assertWire(
              wire(slow, "/Sessions/Playing/Stopped").find(
                (e) => e.response_status === 204,
              ),
              slow,
              final,
            );
            assert.equal(observation(slow.plan.session_id).seq, 4);
            const count = wire(slow, "/Sessions/Playing/Stopped").length;
            await slow.client.request(
              `/playback-sessions/${slow.plan.session_id}`,
              "DELETE",
              { ...final },
            );
            assert.equal(wire(slow, "/Sessions/Playing/Stopped").length, count);
            await observe(
              slow,
              makeBody(slow, 5),
              410,
              "invalid_playback_session",
            );
            Object.assign(result, {
              captured_start_seq: 1,
              captured_progress_seq: 2,
              retained_newer_seq: 3,
              final_seq: 4,
              final_stop: wire(slow, "/Sessions/Playing/Stopped"),
            });
          },
        );
        await scenario(
          `${kind}: same-sequence final Stop is idempotent and rejected final samples still release owned resources`,
          async (result) => {
            const outcomes = [];
            for (const reason of [
              "exact",
              "conflict",
              "stale",
              "generation",
              "expiry",
              "membership",
              "malformed",
            ]) {
              const client = reason === "membership" ? guest : admin;
              const grant = await prepare(kind, client);
              const initial = makeBody(grant, 1, {
                event: "playing",
                media_time_ms: 1000,
              });
              await observe(grant, initial);
              await reported(grant, initial, "/Sessions/Playing");
              const accepted = makeBody(grant, 2, {
                event: "pause",
                media_time_ms: 2000,
                paused: true,
              });
              await observe(grant, accepted);
              await reported(grant, accepted);
              // Only the grant owner can stop it, including the final-observation
              // error path. Other credentials must not change stopped or resource IO.
              if (reason === "exact") {
                await guest.request(
                  `/playback-sessions/${grant.plan.session_id}`,
                  "DELETE",
                  accepted,
                  410,
                );
                await fixture
                  .client()
                  .request(
                    `/playback-sessions/${grant.plan.session_id}`,
                    "DELETE",
                    accepted,
                    401,
                  );
                assert.equal(
                  fixture.sql(
                    `SELECT stopped FROM playback_sessions WHERE id=${uuid(grant.plan.session_id)}`,
                  ),
                  "f",
                );
                assert.equal(ledger(grant.plan.session_id).state, "active");
                await observe(grant, { ...accepted });
              }
              let body = { ...accepted },
                status = 200,
                code;
              if (reason === "conflict") {
                body.media_time_ms += 1;
                status = 409;
                code = "observation_conflict";
              }
              if (reason === "stale") {
                body = initial;
                status = 409;
                code = "observation_sequence_stale";
              }
              if (reason === "generation") {
                body.seq = 3;
                body.media_generation += 1;
                status = 409;
                code = "stale_media";
              }
              if (reason === "expiry") {
                body.seq = 3;
                status = 410;
                code = "invalid_playback_session";
                fixture.sql(
                  `UPDATE playback_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${uuid(grant.plan.session_id)}`,
                );
              }
              if (reason === "membership") {
                body.seq = 3;
                status = 403;
                code = "not_a_member";
                fixture.sql(
                  `DELETE FROM room_members WHERE room_id=${uuid(room.id)} AND user_id=${uuid(guestUser.id)}`,
                );
              }
              if (reason === "malformed") {
                body = new TextEncoder().encode("{");
                status = 400;
                code = "invalid_observation";
              }
              const answer = await client.request(
                `/playback-sessions/${grant.plan.session_id}`,
                "DELETE",
                body,
                status,
              );
              if (code) assert.equal(answer.error?.code, code.toUpperCase());
              const closed = await knownStop(grant);
              assert.equal(
                fixture.sql(
                  `SELECT stopped FROM playback_sessions WHERE id=${uuid(grant.plan.session_id)}`,
                ),
                "t",
              );
              assert.equal(
                fixture.sql(
                  `SELECT count(*) FROM media_jobs WHERE session_id=${uuid(grant.plan.session_id)} AND status IN('queued','running')`,
                ),
                "0",
              );
              const stored = observation(grant.plan.session_id);
              assert.equal(stored.seq, 2);
              assert.deepEqual(stored.payload, accepted);
              const stop = wire(grant, "/Sessions/Playing/Stopped").find(
                (e) => e.response_status === 204,
              );
              assertWire(stop, grant, accepted);
              if (reason === "membership")
                await guest.request(`/rooms/${room.id}/join`, "POST", {
                  token: invite.token,
                });
              if (reason === "exact") {
                const requests = wire(
                  grant,
                  "/Sessions/Playing/Stopped",
                ).length;
                await client.request(
                  `/playback-sessions/${grant.plan.session_id}`,
                  "DELETE",
                  { ...accepted },
                );
                await client.request(
                  `/playback-sessions/${grant.plan.session_id}`,
                  "DELETE",
                  makeBody(grant, 3),
                  410,
                );
                assert.equal(
                  wire(grant, "/Sessions/Playing/Stopped").length,
                  requests,
                );
                assert.equal(ledger(grant.plan.session_id).state, "closed");
                assert.equal(observation(grant.plan.session_id).seq, 2);
              }
              outcomes.push({
                reason,
                http_status: status,
                persisted_final_seq: stored.seq,
                final_stop: stop,
                closed,
              });
            }
            result.outcomes = outcomes;
          },
        );
        await scenario(
          `${kind}: final Stop racing request cancellation preserves the accepted sample and cannot revive a grant`,
          async (result) => {
            const grant = await prepare(kind);
            const firstBody = makeBody(grant, 1, {
              event: "playing",
              media_time_ms: 1000,
            });
            await observe(grant, firstBody);
            await reported(grant, firstBody, "/Sessions/Playing");
            const held = deferred();
            grant.fault.progress_hold = held;
            const prior = makeBody(grant, 2, { media_time_ms: 5000 });
            await observe(grant, prior);
            await until(
              () => held.received,
              "Progress is really in flight before Stop/cancel race",
            );
            const final = makeBody(grant, 3, {
              event: "ended",
              media_time_ms: 8000,
              paused: true,
            });
            const readAnswer = async (response) => ({
              status: response.status,
              body: await response.json(),
            });
            const [stopAnswer, cancelAnswer] = await Promise.all([
              grant.client
                .raw(`/playback-sessions/${grant.plan.session_id}`, {
                  method: "DELETE",
                  body: final,
                })
                .then(readAnswer),
              grant.client
                .raw(`/playback-requests/${grant.key}`, { method: "DELETE" })
                .then(readAnswer),
            ]);
            held.release();
            assert.equal(cancelAnswer.status, 200);
            assert.equal(cancelAnswer.body.ok, true);
            assert.ok(
              [200, 410].includes(stopAnswer.status),
              "only the two specified atomic race orders are accepted",
            );
            if (stopAnswer.status === 410)
              assert.equal(
                stopAnswer.body.error?.code,
                "INVALID_PLAYBACK_SESSION",
              );
            const stored = observation(grant.plan.session_id);
            const accepted = stopAnswer.status === 200 ? final : prior;
            assert.equal(stored.seq, accepted.seq);
            assert.deepEqual(stored.payload, accepted);
            const row = await knownStop(grant);
            assert.equal(
              fixture.sql(
                `SELECT stopped FROM playback_sessions WHERE id=${uuid(grant.plan.session_id)}`,
              ),
              "t",
            );
            assertWire(
              wire(grant, "/Sessions/Playing/Stopped").find(
                (e) => e.response_status === 204,
              ),
              grant,
              accepted,
            );
            const startCount = wire(grant, "/Sessions/Playing").length;
            await observe(
              grant,
              makeBody(grant, accepted.seq + 1),
              410,
              "invalid_playback_session",
            );
            await grant.client.request(
              `/playback-sessions/${grant.plan.session_id}`,
              "DELETE",
              makeBody(grant, accepted.seq + 1),
              410,
            );
            await grant.client.request(
              "/playback-sessions",
              "POST",
              {
                room_id: room.id,
                media_generation: grant.generation,
                idempotency_key: grant.key,
                mode: "auto",
                position_ms: 1200,
                observation_version: 1,
              },
              410,
            );
            assert.equal(wire(grant, "/Sessions/Playing").length, startCount);
            assert.equal(ledger(grant.plan.session_id).state, "closed");
            Object.assign(result, {
              final_stop_status: stopAnswer.status,
              request_cancel_status: cancelAnswer.status,
              accepted_final_seq: stored.seq,
              row,
            });
          },
        );
        await scenario(
          `${kind}: same-key failed preparation retries a fresh session at seq zero without reviving tombstones`,
          async (result) => {
            const permanentKey = randomUUID();
            const permanent = await prepare(
              kind,
              admin,
              { empty_sources: true },
              permanentKey,
            );
            assert.equal(permanent.error.error?.code, "NO_MEDIA_SOURCE");
            assert.equal(permanent.error.error?.retryable, false);
            const compensated = JSON.parse(
              fixture.sql(
                `SELECT row_to_json(u) FROM upstream_reservations u WHERE request_key=${uuid(permanentKey)} ORDER BY created_at DESC LIMIT 1`,
              ),
            );
            await until(
              () => ledger(compensated.id).state === "closed",
              "failed preparation compensation completes",
              65,
            );
            const negotiations = contract.requests.filter((e) =>
              e.path.endsWith("PlaybackInfo"),
            ).length;
            const permanentReplay = await admin.request(
              "/playback-sessions",
              "POST",
              {
                room_id: room.id,
                media_generation: controller.state.media_generation,
                idempotency_key: permanentKey,
                mode: "auto",
                position_ms: 1200,
                observation_version: 1,
              },
              502,
            );
            assert.equal(permanentReplay.error?.code, "NO_MEDIA_SOURCE");
            assert.equal(permanentReplay.error?.retryable, false);
            assert.equal(
              contract.requests.filter((e) => e.path.endsWith("PlaybackInfo"))
                .length,
              negotiations,
            );

            const key = randomUUID();
            const failed = await prepare(
              kind,
              admin,
              { temporary_failure: true },
              key,
            );
            assert.equal(failed.error.error?.code, "UPSTREAM_PLAYBACK_FAILED");
            assert.equal(failed.error.error?.retryable, true);
            const old = JSON.parse(
              fixture.sql(
                `SELECT row_to_json(u) FROM upstream_reservations u WHERE request_key=${uuid(key)} ORDER BY created_at DESC LIMIT 1`,
              ),
            );
            assert.equal(old.state, "cleanup_failed");
            assert.equal(old.negotiation, "unknown");
            assert.equal(old.play_session_id, null);
            assert.equal(old.closed_at, null);
            const fresh = await prepare(kind, admin, {}, key);
            assert.notEqual(fresh.plan.session_id, old.id);
            assert.equal(fresh.plan.observation_seq, 0);
            assert.equal(observation(fresh.plan.session_id).seq, 0);
            assert.equal(observation(fresh.plan.session_id).payload, null);
            assert.equal(observation(fresh.plan.session_id).has_played, false);
            assert.equal(wire(fresh, "/Sessions/Playing").length, 0);
            assert.equal(ledger(old.id).state, "cleanup_failed");
            assert.equal(ledger(old.id).closed_at, null);
            assert.equal(
              contract.requests.filter(
                (e) =>
                  e.device_id === old.device_id &&
                  e.path === "/Sessions/Playing/Stopped",
              ).length,
              0,
            );
            await admin.request(`/playback-requests/${key}`, "DELETE");
            await knownStop(fresh);
            await admin.request(
              "/playback-sessions",
              "POST",
              {
                room_id: room.id,
                media_generation: controller.state.media_generation,
                idempotency_key: key,
                mode: "auto",
                position_ms: 1200,
                observation_version: 1,
              },
              410,
            );
            Object.assign(result, {
              permanent_nonretryable_id: compensated.id,
              permanent_same_key_error: permanentReplay.error?.code,
              old_id: old.id,
              old_unknown_not_closed: publicLedger(ledger(old.id)),
              old_unknown_stop_requests: 0,
              fresh: planFields(fresh.plan),
              failed_preparation_error: failed.error.error?.code,
              tombstone_preserved: true,
            });
          },
        );
        await scenario(
          `${kind}: unknown late IO and a final sample never fabricate remote closure`,
          async (result) => {
            const late = deferred();
            const unknown = await prepare(kind, admin, { start_hold: late });
            await observe(
              unknown,
              makeBody(unknown, 1, { event: "playing", media_time_ms: 7000 }),
            );
            await until(
              () => late.received?.connection_closed_at_ms,
              "real Start connection expires before late response",
              15,
            );
            const final = makeBody(unknown, 2, {
              event: "ended",
              media_time_ms: 9000,
              paused: true,
            });
            await unknown.client.request(
              `/playback-sessions/${unknown.plan.session_id}`,
              "DELETE",
              final,
            );
            const failed = await until(
              () => {
                const row = ledger(unknown.plan.session_id);
                return row.state === "cleanup_failed" ? row : null;
              },
              "unknown remote IO remains durable cleanup failure",
              65,
            );
            assert.equal(failed.io_uncertain, true);
            assert.equal(failed.closed_at, null);
            assert.equal(observation(unknown.plan.session_id).seq, 2);
            const stop = wire(unknown, "/Sessions/Playing/Stopped").find(
              (e) => e.response_status === 204,
            );
            assert.ok(stop);
            assertWire(stop, unknown, final);
            late.release();
            await until(
              () => late.received.applied_at_ms,
              "controlled remote really applies late Start",
            );
            assert.ok(late.received.applied_at_ms > stop.monotonic_ms);
            assert.equal(
              contract.sessions.get(unknown.sid).encoding_active,
              true,
            );
            assert.equal(
              ledger(unknown.plan.session_id).state,
              "cleanup_failed",
            );
            assert.equal(ledger(unknown.plan.session_id).closed_at, null);
            Object.assign(result, {
              row: publicLedger(failed),
              final: observation(unknown.plan.session_id),
              late_start: late.received,
              stop,
            });
          },
        );
        await scenario(
          `${kind}: old pages retain the unnegotiated playback and empty Stop contract`,
          async (result) => {
            const queued = { kind, name: `${kind}-old-page` };
            contract.queue.push(queued);
            const plan = await admin.request("/playback-sessions", "POST", {
              room_id: room.id,
              media_generation: controller.state.media_generation,
              idempotency_key: randomUUID(),
              mode: "auto",
              position_ms: 1200,
            });
            assert.equal(plan.observation_version, undefined);
            const legacy = {
              kind,
              client: admin,
              generation: controller.state.media_generation,
              plan,
              sid: ledger(plan.session_id).play_session_id,
              device: ledger(plan.session_id).device_id,
            };
            await until(
              () =>
                wire(legacy, "/Sessions/Playing").some(
                  (e) => e.response_status === 204,
                ),
              "old page still starts through existing room clock contract",
            );
            await observe(
              legacy,
              makeBody(legacy, 1),
              400,
              "observation_version_required",
            );
            await admin.request(
              `/playback-sessions/${plan.session_id}`,
              "DELETE",
            );
            result.legacy_stop = await knownStop(legacy);
          },
        );
        for (const grant of [first, second]) {
          await grant.client.request(
            `/playback-sessions/${grant.plan.session_id}`,
            "DELETE",
          );
          await knownStop(grant);
        }
      }
      assert.equal(contract.failures.length, 0);
      report.result = "passed";
    },
    {
      binary: nativeCopy,
      beforeStart: (fixture) => {
        ownedFixture=fixture;
        fixtureIdentity = {
          id: fixture.id,
          container: fixture.container,
          root: fixture.root,
          database_kind: fixture.databaseKind,
          postgres: fixture.postgresDiagnostics(),
        };
        if (fixture.databaseKind === "native") {
          assert.equal(fixture.container,null,"native runs must not invent a Docker identity");
          assert.equal(fixtureIdentity.postgres.kind,"native");
          ownedVolumes=[];
          report.fixture={...fixtureIdentity,owned_volume_names:[]};
          return;
        }
        assert.equal(fixture.databaseKind,"docker");
        const mounts = JSON.parse(
          docker("inspect", "--format", "{{json .Mounts}}", fixture.container),
        );
        ownedVolumes = mounts
          .filter((m) => m.Type === "volume")
          .map((m) => m.Name);
        assert.ok(ownedVolumes.every((v) => /^[a-zA-Z0-9_.-]+$/.test(v)));
        report.fixture = {
          ...fixtureIdentity,
          postgres_image_id: docker(
            "inspect",
            "--format",
            "{{.Image}}",
            fixture.container,
          ),
          owned_volume_names: ownedVolumes,
        };
      },
    },
  );
} catch (error) {
  const active = report.cases.findLast((c) => c.result === "running");
  const firstLine = String(error?.message ?? "").split("\n", 1)[0];
  const identityFailure =
    /^compiled binary rainsync-(?:server|media-worker|nas-agent)$/.test(firstLine) ||
    (Array.isArray(binding?.source) &&
      binding.source.some(
        (file) => typeof file?.path === "string" && firstLine === `compiled input ${file.path}`,
      ));
  const name = [
    "Error", "AssertionError", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError",
  ].includes(error?.name) ? error.name : "Error";
  const code = ["ERR_ASSERTION", "ENOENT", "EACCES", "EPERM"].includes(error?.code)
    ? ` (${error.code})`
    : "";
  console.error(
    `FAIL: ${active?.name ?? "backend preflight"}: ${name}${code}${identityFailure ? `; ${firstLine}` : ""}`,
  );
  report.result = "failed";
  report.failures.push({ error: String(error.stack ?? error) });
  if (active) {
    active.result = "failed";
    active.finished_at = new Date().toISOString();
  }
  process.exitCode = 1;
} finally {
  await cleanupStep("controller", async () => controller?.close());
  for (const hold of holds) hold.release();
  if (listening)
    await cleanupStep("controlled upstream", async () => {
      const closed = new Promise((done, reject) =>
        upstream.close((e) => (e ? reject(e) : done())),
      );
      upstream.closeAllConnections();
      await Promise.race([
        closed,
        delay(5000).then(() => {
          throw new Error("upstream close deadline");
        }),
      ]);
    });
  if (fixtureIdentity)
    await cleanupStep("owned PostgreSQL and anonymous volumes", async () => {
      if (fixtureIdentity.database_kind === "native") {
        report.cleanup.native=await ownedFixture.verifyStopped();
        return;
      }
      assert.match(
        fixtureIdentity.container,
        /^rainsync-upstream-observations-[0-9a-f]{8}$/,
      );
      if (
        docker(
          "ps",
          "-a",
          "--filter",
          `name=^${fixtureIdentity.container}$`,
          "--format",
          "{{.Names}}",
        )
      )
        docker("rm", "-f", fixtureIdentity.container);
      assert.equal(
        docker(
          "ps",
          "-a",
          "--filter",
          `name=^${fixtureIdentity.container}$`,
          "--format",
          "{{.Names}}",
        ),
        "",
      );
      for (const name of ownedVolumes) {
        assert.match(name, /^[a-zA-Z0-9_.-]+$/);
        const present = docker(
          "volume",
          "ls",
          "--filter",
          `name=${name}`,
          "--format",
          "{{.Name}}",
        )
          .split(/\r?\n/)
          .includes(name);
        if (present) docker("volume", "rm", name);
        assert.ok(
          !docker(
            "volume",
            "ls",
            "--filter",
            `name=${name}`,
            "--format",
            "{{.Name}}",
          )
            .split(/\r?\n/)
            .includes(name),
        );
        report.cleanup.volumes.push({
          name,
          removed: true,
          already_removed: !present,
        });
      }
    });
  for (const [name, path, expected] of [
    ["entry", entry, entryHash],
    ["fixture entry", fixtureEntry, fixtureHash],
    ["backend binding", bindingPath, bindingHash],
    [
      "tested native copy",
      nativeCopy,
      nativeCopy
        ? binding?.binaries.find((b) => b.name === "rainsync-server").sha256
        : null,
    ],
  ]) {
    if (path && expected)
      await cleanupStep(`${name} identity`, async () =>
        assert.equal(await digest(path), expected),
      );
  }
  for (const [path, expected] of sourceHashes)
    await cleanupStep(`backend source ${relative(root, path)}`, async () =>
      assert.equal(await digest(path), expected),
    );
  for (const [path, expected] of binaryHashes)
    await cleanupStep(`actual binary ${relative(root, path)}`, async () =>
      assert.equal(await digest(path), expected),
    );
  report.requests = contract.requests;
  report.fixture_assertion_failures = contract.failures;
  if (contract.failures.length) {
    report.result = "failed";
    report.failures.push({
      error: "controlled HTTP assertions failed",
      failures: contract.failures,
    });
    process.exitCode = 1;
  }
  if (fixtureInvoked && !fixtureIdentity) {
    report.cleanup.steps.push({
      name: "fixture creation identity",
      result: "failed",
      error:
        "fixture did not reach its backend identity registration; owned database cleanup is unknown",
    });
    report.result = "failed";
    process.exitCode = 1;
  }
  report.cleanup.completed = report.cleanup.steps.every(
    (s) => s.result === "passed",
  );
  report.finished_at = new Date().toISOString();
  await save();
  console.log(`Evidence: ${reportPath}`);
}
