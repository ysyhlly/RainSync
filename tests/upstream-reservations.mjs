// Isolated native Server/PostgreSQL and controlled HTTP contracts.
// This does not claim compatibility or decoding against real Jellyfin/Emby.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import WS from "ws";
import { isolatedServer } from "./fixtures/server.mjs";

const artifacts = resolve(".runtime/upstream-reservations");
const crashUnknownOnly = process.argv.slice(2).includes("--crash-unknown-only");
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--crash-unknown-only"),
  "only the optional isolated crash scenario selector is supported",
);
process.env.RAINSYNC_ARTIFACT_DIR = artifacts;
const runRoot = resolve(artifacts, randomUUID());
await mkdir(runRoot, { recursive: true });
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const entry = resolve("tests/upstream-reservations.mjs");
const fixtureEntry = resolve("tests/fixtures/server.mjs");
const binarySource = resolve(
  process.env.CARGO_TARGET_DIR ?? "target",
  "debug",
  `rainsync-server${process.platform === "win32" ? ".exe" : ""}`,
);
const binary = resolve(
  runRoot,
  `server-under-test${process.platform === "win32" ? ".exe" : ""}`,
);
await copyFile(binarySource, binary);
const report = {
  started_at: new Date().toISOString(),
  scope:
    "native Server + isolated PostgreSQL; controlled Jellyfin/Emby HTTP contracts; no real upstream/Worker/browser decode claim",
  result: "running",
  selection: crashUnknownOnly ? "crash-unknown-only" : "all",
  entry_sha256: await digest(entry),
  fixture_entry_sha256: await digest(fixtureEntry),
  binary: {
    source: binarySource,
    tested_copy: binary,
    sha256: await digest(binary),
  },
  cases: [],
  failures: [],
  cleanup: { completed: false, volumes: [] },
};
const save = () =>
  writeFile(
    resolve(runRoot, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const deferred = () => {
  let release;
  const promise = new Promise((done) => {
    release = done;
  });
  return { promise, release };
};
const observePending = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
async function consumePending(promise) {
  const outcome = await promise;
  if (outcome.error) throw outcome.error;
  return outcome.value;
}
async function until(check, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`deadline: ${label}`);
}
const docker = (...args) =>
  execFileSync("docker", args, {
    windowsHide: true,
    timeout: 30000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const sqlUuid = (id) => {
  assert.match(id, /^[0-9a-f-]{36}$/);
  return `'${id}'`;
};
const token = randomBytes(24).toString("hex");
const contract = {
  queue: [],
  requests: [],
  negotiations: [],
  stops: [],
  sessions: new Map(),
  failures: [],
};
function playbackInfo(sid, kind, origin) {
  return {
    PlaySessionId: sid,
    MediaSources: [
      {
        Id: `source-${kind}`,
        SupportsDirectPlay: true,
        RunTimeTicks: 600000000,
        TranscodingUrl: `${origin}/${kind}/Videos/fixture/master.m3u8?PlaySessionId=${sid}`,
        MediaStreams: [
          {
            Type: "Audio",
            Index: 1,
            Codec: "aac",
            Language: "eng",
            DisplayTitle: "Fixture audio",
          },
          {
            Type: "Subtitle",
            Index: 2,
            Codec: "vtt",
            Language: "eng",
            DisplayTitle: "Fixture subtitle",
            IsTextSubtitleStream: true,
          },
        ],
      },
    ],
  };
}
let upstreamOrigin;
const upstream = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, upstreamOrigin);
    const [kind, ...parts] = url.pathname.slice(1).split("/");
    assert.ok(["jellyfin", "emby"].includes(kind), "known contract namespace");
    const path = "/" + parts.join("/");
    const authorization =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    assert.ok(
      authorization.includes(`Token=\"${token}\"`) ||
        request.headers["x-emby-token"] === token,
      "fixture credential is forwarded",
    );
    const device =
      /DeviceId="([^"]+)"/.exec(authorization)?.[1] ??
      url.searchParams.get("DeviceId") ??
      request.headers["x-emby-device-id"];
    let body = null;
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      body = text ? JSON.parse(text) : {};
    }
    const event = {
      at: new Date().toISOString(),
      monotonic_ms: performance.now(),
      kind,
      method: request.method,
      path,
      device_id: device ?? null,
      play_session_id:
        body?.PlaySessionId ?? url.searchParams.get("PlaySessionId") ?? null,
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
    if (path === "/Users/fixture-user/Items") {
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture",
            Name: `${kind} reservation fixture`,
            RunTimeTicks: 600000000,
          },
        ],
      });
    }
    if (path === "/Items/fixture/PlaybackInfo") {
      assert.match(device ?? "", /^rainsync-[0-9a-f-]{36}$/);
      const fault = contract.queue.shift() ?? { name: "normal" };
      const sid = randomUUID();
      Object.assign(event, {
        scenario: fault.name,
        play_session_id: sid,
        request: {
          IsPlayback: body.IsPlayback,
          AutoOpenLiveStream: body.AutoOpenLiveStream,
        },
      });
      contract.negotiations.push(event);
      contract.sessions.set(sid, {
        kind,
        device,
        stopped: false,
        encoding_active: false,
        fault,
      });
      fault.received = event;
      if (fault.hold) await fault.hold.promise;
      const value = playbackInfo(sid, kind, upstreamOrigin);
      if (fault.empty_sources) value.MediaSources = [];
      if (fault.no_sid) delete value.PlaySessionId;
      if (fault.conflicting_url_sid)
        value.MediaSources[0].TranscodingUrl = `${upstreamOrigin}/${kind}/Videos/fixture/master.m3u8?PlaySessionId=${randomUUID()}`;
      return json(value);
    }
    if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
      ].includes(path)
    ) {
      const session = contract.sessions.get(body.PlaySessionId);
      assert.ok(session, "report references a negotiated SID");
      assert.equal(
        device,
        session.device,
        "negotiation and playback report device match",
      );
      if (path === "/Sessions/Playing") {
        if (session.fault.start_hold) await session.fault.start_hold.promise;
        session.encoding_active = true;
        session.stopped = false;
        event.applied_at_ms = performance.now();
      }
      if (path.endsWith("Stopped")) {
        contract.stops.push(event);
        if (session.fault.stop_hold) await session.fault.stop_hold.promise;
        if (session.fault.accept_stop_once && session.stop_successes)
          return json({ error: "fixture repeated Stop rejected" }, 409);
        if (session.fault.stop_failure)
          return json({ error: "fixture stop failure" }, 503);
        session.stopped = true;
        session.stop_successes = (session.stop_successes ?? 0) + 1;
        if (kind === "jellyfin") session.encoding_active = false;
      }
      event.response_status = 204;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "DELETE" && path === "/Videos/ActiveEncodings") {
      const sid = url.searchParams.get("PlaySessionId");
      const session = contract.sessions.get(sid);
      assert.ok(session, "encoding stop requires known SID");
      assert.equal(url.searchParams.get("DeviceId"), session.device);
      assert.equal(device, session.device);
      session.encoding_stop_requests =
        (session.encoding_stop_requests ?? 0) + 1;
      if (
        session.fault.fail_first_encoding_stop &&
        session.encoding_stop_requests === 1
      )
        return json({ error: "fixture first encoding stop failed" }, 503);
      if (session.fault.stop_failure)
        return json({ error: "fixture encoding stop failure" }, 503);
      session.stopped = true;
      session.encoding_active = false;
      event.response_status = 200;
      response.writeHead(200).end();
      return;
    }
    json({ error: "unhandled fixture route" }, 404);
  } catch (error) {
    contract.failures.push(String(error.stack ?? error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

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
    }, "room control response");
  }
  async join(room) {
    this.room = room;
    this.inbox = [];
    this.state = null;
    this.epoch = null;
    this.socket = new WS(
      this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      {
        headers: { Origin: this.fixture.origin, Cookie: this.client.cookie },
      },
    );
    this.socket.on("message", (bytes) => this.inbox.push(JSON.parse(bytes)));
    await new Promise((done, reject) => {
      this.socket.once("open", done);
      this.socket.once("error", reject);
    });
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.wait((v) => v.type === "SNAPSHOT");
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
    const answer = await this.wait((v) => v.command_id === id);
    assert.equal(answer.type, "ACK", "real generation change is accepted");
    this.state = answer.state;
  }
  close() {
    this.socket?.terminate();
  }
}

let fixtureIdentity;
let ownedVolumes = [];
let controller;
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
try {
  const bindingPath = resolve(
    process.env.W03_BACKEND_BINDING ??
      ".runtime/w03-backend/backend-binding.json",
  );
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  report.backend_binding = {
    path: bindingPath,
    sha256: await digest(bindingPath),
    source_digest: binding.source_digest,
  };
  for (const file of binding.source)
    assert.equal(
      await digest(resolve(file.path)),
      file.sha256,
      `compiled backend input matches ${file.path}`,
    );
  const builtServer = binding.binaries.find(
    (item) => item.name === "rainsync-server",
  );
  assert.equal(
    report.binary.sha256,
    builtServer.sha256,
    "tested copy matches successful native build binding",
  );
  await isolatedServer(
    "upstream-reservations",
    async (fixture) => {
      const admin = fixture.client();
      await admin.login();
      const guestName = `upstream-${randomUUID().slice(0, 8)}`;
      const guestPassword = randomBytes(24).toString("hex");
      await admin.request("/users", "POST", {
        username: guestName,
        password: guestPassword,
      });
      const guest = fixture.client();
      await guest.login(guestName, guestPassword);
      controller = new Controller(fixture, admin);
      const room = await admin.request("/rooms", "POST", {
        name: "upstream durable reservation regression",
      });
      const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
      await guest.request(`/rooms/${room.id}/join`, "POST", {
        token: invite.token,
      });
      await controller.join(room);
      const sources = {};
      const media = {};
      for (const kind of ["jellyfin", "emby"]) {
        sources[kind] = await admin.request("/sources", "POST", {
          name: `${kind} isolated contract`,
          kind,
          config: {
            url: `${upstreamOrigin}/${kind}`,
            user_id: "fixture-user",
            token,
          },
        });
        await admin.request(`/sources/${sources[kind].id}/test`, "POST");
        media[kind] = fixture.sql(
          `SELECT id FROM media_items WHERE source_id=${sqlUuid(sources[kind].id)}`,
        );
        assert.match(media[kind], /^[0-9a-f-]{36}$/);
      }
      const record = (id) =>
        JSON.parse(
          fixture.sql(
            `SELECT row_to_json(u) FROM upstream_reservations u WHERE id=${sqlUuid(id)}`,
          ),
        );
      const byKey = (key) =>
        JSON.parse(
          fixture.sql(
            `SELECT row_to_json(u) FROM upstream_reservations u WHERE request_key=${sqlUuid(key)} ORDER BY created_at DESC LIMIT 1`,
          ),
        );
      const prepare = async (
        key,
        extra = {},
        signal = AbortSignal.timeout(65000),
        client = admin,
      ) => {
        const response = await client.raw("/playback-sessions", {
          method: "POST",
          signal,
          body: {
            room_id: room.id,
            media_generation: controller.state.media_generation,
            idempotency_key: key,
            mode: "auto",
            position_ms: 1200,
            ...extra,
          },
        });
        return { status: response.status, body: await response.json() };
      };
      const closed = (id) =>
        until(
          () => {
            const row = record(id);
            return row.state === "closed" ? row : null;
          },
          "known upstream reservation closes",
          15000,
        );
      function assertKnownStop(id) {
        const row = record(id);
        const remote = contract.sessions.get(row.play_session_id);
        assert.ok(
          remote,
          "closed record has an independently known negotiated SID",
        );
        assert.equal(remote.stopped, true, "controlled upstream received Stop");
        assert.equal(
          remote.encoding_active,
          false,
          "controlled encoding cleanup contract completed",
        );
        assert.ok(
          contract.stops.some(
            (v) =>
              v.play_session_id === row.play_session_id &&
              v.device_id === row.device_id &&
              v.kind === row.kind &&
              v.path === "/Sessions/Playing/Stopped" &&
              v.response_status === 204,
          ),
          "exact SID/device/kind received a successful Stop response",
        );
        if (row.kind === "emby")
          assert.ok(
            contract.requests.some(
              (v) =>
                v.play_session_id === row.play_session_id &&
                v.device_id === row.device_id &&
                v.kind === "emby" &&
                v.method === "DELETE" &&
                v.path === "/Videos/ActiveEncodings" &&
                v.response_status === 200,
            ),
            "Emby encoding cleanup is independently observed",
          );
      }
      if (!crashUnknownOnly) {
        for (const kind of ["jellyfin", "emby"]) {
          await controller.change(media[kind]);
          await scenario(
            `${kind}: independent attempts, encrypted checkpoint and idempotent replay`,
            async (result) => {
              const key = randomUUID();
              const first = await prepare(key);
              assert.equal(first.status, 200);
              const firstRow = record(first.body.session_id);
              assert.equal(firstRow.state, "active");
              assert.equal(firstRow.negotiation, "received");
              assert.equal(
                firstRow.device_id,
                `rainsync-${first.body.session_id}`,
              );
              assert.ok(
                firstRow.response_encrypted && firstRow.scope_encrypted,
              );
              assert.ok(
                !JSON.stringify(firstRow).includes(token),
                "upstream credentials are not plaintext in reservation",
              );
              const sid = firstRow.play_session_id;
              assert.equal(
                contract.sessions.get(sid).encoding_active,
                true,
                "normal plan issued the current Start contract",
              );
              const count = contract.negotiations.length;
              const replay = await prepare(key);
              assert.equal(replay.status, 200);
              assert.equal(replay.body.session_id, first.body.session_id);
              assert.equal(
                contract.negotiations.length,
                count,
                "completed replay emits no new negotiation",
              );
              const second = await prepare(
                randomUUID(),
                {},
                AbortSignal.timeout(65000),
                guest,
              );
              assert.equal(second.status, 200);
              const secondRow = record(second.body.session_id);
              assert.notEqual(firstRow.device_id, secondRow.device_id);
              assert.notEqual(sid, secondRow.play_session_id);
              await admin.request(
                `/playback-sessions/${first.body.session_id}`,
                "DELETE",
              );
              await closed(first.body.session_id);
              assertKnownStop(first.body.session_id);
              assert.equal(
                contract.sessions.get(sid).encoding_active,
                false,
                "fixture encoding stop contract completed",
              );
              assert.equal(
                record(second.body.session_id).state,
                "active",
                "stopping one attempt leaves other grant active",
              );
              assert.equal(
                contract.sessions.get(secondRow.play_session_id).stopped,
                false,
              );
              await guest.request(
                `/playback-sessions/${second.body.session_id}`,
                "DELETE",
              );
              await closed(second.body.session_id);
              assertKnownStop(second.body.session_id);
              Object.assign(result, {
                session_ids: [first.body.session_id, second.body.session_id],
                device_ids: [firstRow.device_id, secondRow.device_id],
                encrypted_checkpoint_retained: true,
              });
            },
          );
          await scenario(
            `${kind}: invalid media response retains SID for compensation`,
            async (result) => {
              const fault = {
                name: `${kind}-empty-source`,
                empty_sources: true,
              };
              contract.queue.push(fault);
              const key = randomUUID();
              const response = await prepare(key);
              assert.equal(response.status, 502);
              const row = byKey(key);
              assert.equal(row.play_session_id, fault.received.play_session_id);
              assert.ok(row.response_encrypted);
              await closed(row.id);
              assertKnownStop(row.id);
              assert.equal(
                fixture.sql(
                  `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(row.id)} AND NOT stopped`,
                ),
                "0",
              );
              result.session_id = row.id;
            },
          );
          await scenario(
            `${kind}: cancel before late negotiation never activates`,
            async (result) => {
              const fault = { name: `${kind}-late-cancel`, hold: deferred() };
              contract.queue.push(fault);
              const key = randomUUID();
              const pending = observePending(prepare(key));
              await until(
                () => fault.received,
                "negotiation owns HTTP request",
              );
              const before = byKey(key);
              assert.equal(before.state, "preparing");
              const cancelStart = performance.now();
              await admin.request(`/playback-requests/${key}`, "DELETE");
              const cancellationApiMs = performance.now() - cancelStart;
              const afterCancel = byKey(key);
              assert.equal(afterCancel.state, "closing");
              assert.notEqual(afterCancel.negotiation, "received");
              fault.hold.release();
              const answer = await consumePending(pending);
              assert.notEqual(
                answer.status,
                200,
                "canceled caller receives no usable plan",
              );
              const final = await closed(before.id);
              assertKnownStop(before.id);
              assert.equal(
                final.play_session_id,
                fault.received.play_session_id,
              );
              assert.equal(
                fixture.sql(
                  `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(before.id)} AND NOT stopped`,
                ),
                "0",
              );
              await admin.request(
                "/playback-sessions",
                "POST",
                {
                  room_id: room.id,
                  media_generation: controller.state.media_generation,
                  idempotency_key: key,
                  mode: "auto",
                  position_ms: 1200,
                },
                410,
              );
              Object.assign(result, {
                session_id: before.id,
                cancellation_api_ms: cancellationApiMs,
                canceled_http_status: answer.status,
              });
            },
          );
        }
        await controller.change(media.emby);
        await scenario(
          "Emby cleanup retains partial success and retries only the unconfirmed step",
          async (result) => {
            const fault = {
              name: "emby-partial-confirmation",
              accept_stop_once: true,
              fail_first_encoding_stop: true,
            };
            contract.queue.push(fault);
            const answer = await prepare(randomUUID());
            assert.equal(answer.status, 200);
            await admin.request(
              `/playback-sessions/${answer.body.session_id}`,
              "DELETE",
            );
            const final = await closed(answer.body.session_id);
            assertKnownStop(final.id);
            assert.equal(final.stop_confirmed, true);
            assert.equal(final.encoding_stop_confirmed, true);
            assert.equal(final.cleanup_attempts, 2);
            assert.equal(
              contract.stops.filter(
                (v) => v.play_session_id === final.play_session_id,
              ).length,
              1,
              "known confirmed Stop is not replayed into a service that rejects it",
            );
            assert.equal(
              contract.sessions.get(final.play_session_id)
                .encoding_stop_requests,
              2,
            );
            Object.assign(result, {
              session_id: final.id,
              cleanup_attempts: final.cleanup_attempts,
            });
          },
        );
        for (const kind of ["jellyfin", "emby"]) {
          await controller.change(media[kind]);
          await scenario(
            `${kind}: audio validation fails after durable SID checkpoint`,
            async (result) => {
              const key = randomUUID();
              const answer = await prepare(key, { audio_index: 999 });
              assert.equal(answer.status, 400);
              const row = byKey(key);
              assert.ok(row.response_encrypted && row.play_session_id);
              await closed(row.id);
              assertKnownStop(row.id);
              assert.equal(
                fixture.sql(
                  `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(row.id)} AND NOT stopped`,
                ),
                "0",
              );
              result.session_id = row.id;
            },
          );
          await scenario(
            `${kind}: another URL's SID is rejected and the negotiated SID is cleaned`,
            async (result) => {
              const fault = {
                name: `${kind}-conflicting-url-sid`,
                conflicting_url_sid: true,
              };
              contract.queue.push(fault);
              const key = randomUUID();
              const answer = await prepare(key, { mode: "transcode" });
              assert.notEqual(answer.status, 200);
              const row = byKey(key);
              assert.equal(row.play_session_id, fault.received.play_session_id);
              assert.ok(row.response_encrypted);
              await closed(row.id);
              assertKnownStop(row.id);
              assert.equal(
                fixture.sql(
                  `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(row.id)} AND NOT stopped`,
                ),
                "0",
              );
              Object.assign(result, {
                session_id: row.id,
                http_status: answer.status,
              });
            },
          );
        }
        await scenario(
          "final plan INSERT failure compensates the persisted negotiation",
          async (result) => {
            const key = randomUUID();
            fixture.sql(
              `CREATE FUNCTION upstream_fixture_reject_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.room_id=${sqlUuid(room.id)} THEN RAISE EXCEPTION 'fixture final plan write failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER upstream_fixture_reject_plan BEFORE INSERT ON playback_sessions FOR EACH ROW EXECUTE FUNCTION upstream_fixture_reject_plan()`,
            );
            let answer;
            try {
              answer = await prepare(key);
            } finally {
              fixture.sql(
                "DROP TRIGGER upstream_fixture_reject_plan ON playback_sessions; DROP FUNCTION upstream_fixture_reject_plan()",
              );
            }
            assert.equal(answer.status, 500);
            const row = byKey(key);
            assert.ok(row.response_encrypted && row.play_session_id);
            await closed(row.id);
            assertKnownStop(row.id);
            assert.equal(
              fixture.sql(
                `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(row.id)} AND NOT stopped`,
              ),
              "0",
            );
            result.session_id = row.id;
          },
        );
        await scenario(
          "generation revocation fences an old attempt with a late response",
          async (result) => {
            const key = randomUUID();
            const fault = { name: "late-generation", hold: deferred() };
            contract.queue.push(fault);
            const pending = observePending(prepare(key));
            await until(
              () => fault.received,
              "old generation negotiation is running",
            );
            const before = byKey(key);
            await controller.change(media.jellyfin);
            assert.equal(record(before.id).state, "closing");
            fault.hold.release();
            const answer = await consumePending(pending);
            assert.notEqual(answer.status, 200);
            const final = await closed(before.id);
            assertKnownStop(before.id);
            assert.equal(final.play_session_id, fault.received.play_session_id);
            assert.equal(
              fixture.sql(
                `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(before.id)} AND NOT stopped`,
              ),
              "0",
            );
            const current = await prepare(randomUUID());
            assert.equal(current.status, 200);
            assert.equal(
              record(current.body.session_id).generation,
              controller.state.media_generation,
            );
            await admin.request(
              `/playback-sessions/${current.body.session_id}`,
              "DELETE",
            );
            await closed(current.body.session_id);
            assertKnownStop(current.body.session_id);
            Object.assign(result, {
              old_session_id: before.id,
              new_session_id: current.body.session_id,
              old_http_status: answer.status,
            });
          },
        );
        await scenario(
          "restart resumes known cleanup and preserves another completed grant",
          async (result) => {
            const failure = {
              name: "restart-known-cleanup",
              stop_failure: true,
            };
            contract.queue.push(failure);
            const retired = await prepare(randomUUID());
            assert.equal(retired.status, 200);
            const surviving = await prepare(
              randomUUID(),
              {},
              AbortSignal.timeout(65000),
              guest,
            );
            assert.equal(surviving.status, 200);
            await admin.request(
              `/playback-sessions/${retired.body.session_id}`,
              "DELETE",
            );
            await until(
              () =>
                contract.stops.some(
                  (v) => v.play_session_id === failure.received.play_session_id,
                ),
              "first cleanup attempt reached upstream",
            );
            await fixture.stopServer();
            failure.stop_failure = false;
            await fixture.startServer({}, binary);
            await closed(retired.body.session_id);
            assertKnownStop(retired.body.session_id);
            const negotiationCount = contract.negotiations.length;
            const survivedRow = record(surviving.body.session_id);
            const ready = await guest.request(
              `/playback-sessions/${surviving.body.session_id}`,
            );
            assert.equal(ready.status, "ready");
            assert.equal(ready.session_id, surviving.body.session_id);
            await guest.request(
              `/playback-sessions/${surviving.body.session_id}`,
              "POST",
            );
            assert.equal(
              contract.negotiations.length,
              negotiationCount,
              "restart ready/renew reuses the original negotiation",
            );
            assert.equal(
              record(surviving.body.session_id).device_id,
              survivedRow.device_id,
            );
            assert.equal(
              record(surviving.body.session_id).play_session_id,
              survivedRow.play_session_id,
            );
            assert.equal(record(surviving.body.session_id).state, "active");
            assert.equal(
              fixture.sql(
                `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(surviving.body.session_id)} AND NOT stopped AND expires_at>clock_timestamp()`,
              ),
              "1",
            );
            assert.equal(
              contract.sessions.get(
                record(surviving.body.session_id).play_session_id,
              ).stopped,
              false,
            );
            // Reconnect with a new control epoch after the real process restart.
            controller.close();
            await controller.join(room);
            await guest.request(
              `/playback-sessions/${surviving.body.session_id}`,
              "DELETE",
            );
            await closed(surviving.body.session_id);
            assertKnownStop(surviving.body.session_id);
            Object.assign(result, {
              retired_session_id: retired.body.session_id,
              surviving_session_id: surviving.body.session_id,
            });
          },
        );
        await scenario(
          "slow failing cleanup does not serialize an independent cleanup; retry exhaustion stays failed",
          async (result) => {
            const fault = {
              name: "held-stop-retry-exhaustion",
              stop_failure: true,
              stop_hold: deferred(),
            };
            contract.queue.push(fault);
            const slow = await prepare(randomUUID());
            assert.equal(slow.status, 200);
            const healthy = await prepare(
              randomUUID(),
              {},
              AbortSignal.timeout(65000),
              guest,
            );
            assert.equal(healthy.status, 200);
            const healthySid = record(healthy.body.session_id).play_session_id;
            await admin.request(
              `/playback-sessions/${slow.body.session_id}`,
              "DELETE",
            );
            const slowStop = await until(
              () =>
                contract.stops.find(
                  (v) => v.play_session_id === fault.received.play_session_id,
                ),
              "slow upstream is holding a cleanup response",
            );
            const start = performance.now();
            await guest.request(
              `/playback-sessions/${healthy.body.session_id}`,
              "DELETE",
            );
            await closed(healthy.body.session_id);
            assertKnownStop(healthy.body.session_id);
            const healthyClosedMs = performance.now() - start;
            const healthyStop = contract.stops.find(
              (v) => v.play_session_id === healthySid,
            );
            assert.ok(
              healthyStop,
              "healthy cleanup reaches the independent upstream session",
            );
            await until(
              () => slowStop.connection_closed_at_ms,
              "slow Stop reaches its real network deadline",
              10000,
            );
            assert.ok(
              healthyStop.monotonic_ms < slowStop.connection_closed_at_ms,
              "healthy Stop is sent while the slow HTTP request is still held, before its timeout",
            );
            fault.stop_hold.release();
            const failed = await until(
              () => {
                const row = record(slow.body.session_id);
                return row.state === "cleanup_failed" ? row : null;
              },
              "cleanup has a finite retry limit",
              65000,
            );
            assert.equal(failed.cleanup_attempts, 5);
            assert.notEqual(failed.last_error, null);
            assert.equal(failed.stop_confirmed, false);
            assert.equal(failed.closed_at, null);
            assert.equal(
              contract.stops.filter(
                (v) => v.play_session_id === fault.received.play_session_id,
              ).length,
              5,
            );
            Object.assign(result, {
              slow_session_id: slow.body.session_id,
              healthy_session_id: healthy.body.session_id,
              healthy_cleanup_ms: healthyClosedMs,
              attempts: failed.cleanup_attempts,
              error: failed.last_error,
            });
          },
        );
        await scenario(
          "negotiation timeout with an unknown SID remains observable and cannot deliver a plan",
          async (result) => {
            const fault = {
              name: "unknown-negotiation-timeout",
              hold: deferred(),
            };
            contract.queue.push(fault);
            const key = randomUUID();
            const start = performance.now();
            const pending = observePending(prepare(key));
            await until(
              () => fault.received,
              "timed-out negotiation reached the upstream",
            );
            const initial = byKey(key);
            const answer = await consumePending(pending);
            const receivedToAnswerMs =
              performance.now() - fault.received.monotonic_ms;
            assert.ok(
              receivedToAnswerMs >= 29000 && receivedToAnswerMs <= 35000,
              "held negotiation uses the real thirty-second production deadline",
            );
            await until(
              () => fault.received.connection_closed_at_ms,
              "timed-out negotiation connection closes",
              10000,
            );
            assert.notEqual(answer.status, 200);
            const failed = await until(
              () => {
                const row = record(initial.id);
                return row.state === "cleanup_failed" ? row : null;
              },
              "unknown negotiation is explicitly failed",
              65000,
            );
            assert.equal(failed.negotiation, "unknown");
            assert.equal(failed.play_session_id, null);
            assert.equal(failed.closed_at, null);
            assert.equal(
              fixture.sql(
                `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(initial.id)} AND NOT stopped`,
              ),
              "0",
            );
            assert.equal(
              contract.stops.filter(
                (v) => v.play_session_id === fault.received.play_session_id,
              ).length,
              0,
              "unknown SID is not fabricated into a Stop request",
            );
            fault.hold.release();
            await delay(200);
            assert.equal(
              record(initial.id).state,
              "cleanup_failed",
              "late remote work is not assumed atomic with local checkpoint",
            );
            Object.assign(result, {
              session_id: initial.id,
              real_elapsed_ms: performance.now() - start,
              http_status: answer.status,
              error: failed.last_error,
              received_to_answer_ms: receivedToAnswerMs,
              received_to_connection_close_ms:
                fault.received.connection_closed_at_ms -
                fault.received.monotonic_ms,
            });
          },
        );
        await scenario(
          "received response without a SID is saved, rejected and never falsely closed",
          async (result) => {
            const fault = { name: "missing-negotiated-sid", no_sid: true };
            contract.queue.push(fault);
            const key = randomUUID();
            const answer = await prepare(key);
            assert.notEqual(answer.status, 200);
            const initial = byKey(key);
            const failed = await until(
              () => {
                const row = record(initial.id);
                return row.state === "cleanup_failed" ? row : null;
              },
              "missing SID preserves cleanup uncertainty",
              65000,
            );
            assert.ok(
              failed.response_encrypted,
              "whole response is checkpointed even when its SID is absent",
            );
            assert.equal(failed.play_session_id, null);
            assert.equal(failed.closed_at, null);
            assert.notEqual(failed.negotiation, "not_sent");
            assert.equal(
              fixture.sql(
                `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(initial.id)} AND NOT stopped`,
              ),
              "0",
            );
            Object.assign(result, {
              session_id: initial.id,
              http_status: answer.status,
              error: failed.last_error,
            });
          },
        );
        await scenario(
          "local IO lease is not claimed as a remote fence after a late Start",
          async (result) => {
            const fault = { name: "late-remote-start", start_hold: deferred() };
            contract.queue.push(fault);
            const key = randomUUID();
            const pending = observePending(prepare(key));
            await until(
              () =>
                fault.received &&
                contract.requests.some(
                  (v) =>
                    v.path === "/Sessions/Playing" &&
                    v.play_session_id === fault.received.play_session_id,
                ),
              "remote Start owns a held response",
            );
            const answer = await consumePending(pending);
            assert.equal(
              answer.status,
              200,
              "first batch retains existing prepare Start behavior",
            );
            const active = record(answer.body.session_id);
            assert.equal(
              active.io_uncertain,
              true,
              "timed-out Start is durably uncertain",
            );
            await admin.request(`/playback-sessions/${active.id}`, "DELETE");
            const failed = await until(
              () => {
                const row = record(active.id);
                return row.state === "cleanup_failed" ? row : null;
              },
              "Stop cannot erase unknown late remote IO",
              65000,
            );
            assert.equal(failed.io_uncertain, true);
            assert.equal(
              failed.stop_confirmed,
              true,
              "compensation Stop still obtains a real response",
            );
            assert.equal(failed.closed_at, null);
            const stop = contract.stops.find(
              (v) =>
                v.play_session_id === active.play_session_id &&
                v.response_status === 204,
            );
            assert.ok(stop);
            fault.start_hold.release();
            const late = await until(
              () =>
                contract.requests.find(
                  (v) =>
                    v.path === "/Sessions/Playing" &&
                    v.play_session_id === active.play_session_id &&
                    v.applied_at_ms,
                ),
              "held remote Start eventually applies",
            );
            assert.ok(
              late.applied_at_ms > stop.monotonic_ms,
              "controlled remote really executes Start after Stop",
            );
            assert.equal(
              contract.sessions.get(active.play_session_id).encoding_active,
              true,
              "the fixture demonstrates the remote uncertainty instead of pretending atomic cancellation",
            );
            assert.equal(record(active.id).state, "cleanup_failed");
            Object.assign(result, {
              session_id: active.id,
              error: failed.last_error,
              late_remote_start_observed: true,
            });
          },
        );
      }
      await controller.change(media.jellyfin);
      await scenario(
        "process death before SID checkpoint remains unknown after recovery and same-key retry",
        async (result) => {
          const fault = { name: "crash-before-sid", hold: deferred() };
          contract.queue.push(fault);
          const key = randomUUID();
          const pending = observePending(prepare(key));
          await until(
            () => fault.received,
            "negotiation reached held upstream",
          );
          const initial = byKey(key);
          assert.equal(initial.state, "preparing");
          assert.equal(initial.negotiation, "running");
          assert.equal(initial.play_session_id, null);
          assert.equal(initial.response_encrypted, null);
          await fixture.stopServer();
          const interrupted = await pending;
          assert.ok(
            interrupted.error || interrupted.value.status !== 200,
            "terminated process did not deliver a usable plan",
          );
          await until(
            () => fault.received.connection_closed_at_ms,
            "terminated owner's upstream connection closes",
          );
          await fixture.startServer({}, binary);
          const recovered = record(initial.id);
          assert.equal(recovered.state, "cleanup_failed");
          assert.equal(recovered.negotiation, "unknown");
          assert.equal(recovered.play_session_id, null);
          assert.equal(recovered.response_encrypted, null);
          assert.equal(recovered.closed_at, null);
          assert.equal(recovered.last_error, "upstream_session_unknown");
          assert.equal(
            fixture.sql(
              `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(initial.id)} AND NOT stopped`,
            ),
            "0",
          );
          assert.equal(
            fixture.sql(
              `SELECT error_code FROM playback_requests WHERE session_id=${sqlUuid(initial.id)}`,
            ),
            "playback_request_interrupted",
          );
          fault.hold.release();
          await until(
            () => fault.received.response_status === 200,
            "old controlled upstream completes after its owner died",
          );
          controller.close();
          await controller.join(room);
          const retry = await prepare(key);
          assert.equal(retry.status, 200);
          assert.notEqual(retry.body.session_id, initial.id);
          const current = record(retry.body.session_id);
          assert.equal(current.state, "active");
          assert.equal(current.negotiation, "received");
          assert.notEqual(current.device_id, initial.device_id);
          assert.notEqual(
            current.play_session_id,
            fault.received.play_session_id,
          );
          await until(
            () =>
              contract.requests.some(
                (v) =>
                  v.path === "/Sessions/Playing" &&
                  v.play_session_id === current.play_session_id &&
                  v.device_id === current.device_id &&
                  v.response_status === 204,
              ),
            "new attempt independently receives a successful Start",
          );
          assert.equal(
            contract.sessions.get(current.play_session_id).encoding_active,
            true,
            "new attempt is remotely active before its Stop",
          );
          assert.equal(record(initial.id).state, "cleanup_failed");
          assert.equal(record(initial.id).play_session_id, null);
          assert.equal(record(initial.id).closed_at, null);
          assert.equal(
            fixture.sql(
              `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(initial.id)} AND NOT stopped`,
            ),
            "0",
          );
          assert.equal(
            contract.stops.filter(
              (v) => v.play_session_id === fault.received.play_session_id,
            ).length,
            0,
            "unknown old SID is neither fabricated nor borrowed from retry",
          );
          await admin.request(`/playback-sessions/${current.id}`, "DELETE");
          await closed(current.id);
          assertKnownStop(current.id);
          const oldAfterStop = record(initial.id);
          assert.equal(oldAfterStop.state, "cleanup_failed");
          assert.equal(oldAfterStop.negotiation, "unknown");
          assert.equal(oldAfterStop.play_session_id, null);
          assert.equal(oldAfterStop.response_encrypted, null);
          assert.equal(oldAfterStop.closed_at, null);
          assert.equal(oldAfterStop.last_error, "upstream_session_unknown");
          assert.equal(
            fixture.sql(
              `SELECT count(*) FROM playback_sessions WHERE id=${sqlUuid(initial.id)} AND NOT stopped`,
            ),
            "0",
          );
          assert.equal(
            contract.stops.filter(
              (v) => v.play_session_id === fault.received.play_session_id,
            ).length,
            0,
            "stopping the new attempt never borrows or closes the unknown old identity",
          );
          Object.assign(result, {
            old_session_id: initial.id,
            old_owner_epoch: initial.owner_epoch,
            observed_remote_sid_unavailable_to_server:
              fault.received.play_session_id,
            recovered_error: recovered.last_error,
            new_session_id: current.id,
            new_owner_epoch: current.owner_epoch,
            real_upstream_connection_closed_at_ms:
              fault.received.connection_closed_at_ms,
            interrupted_http_status: interrupted.value?.status ?? null,
            request_failed_on_process_death: Boolean(interrupted.error),
          });
          assert.notEqual(current.owner_epoch, initial.owner_epoch);
        },
      );
      assert.deepEqual(
        contract.failures,
        [],
        "HTTP fixture identity assertions all pass",
      );
      report.negotiations = contract.negotiations;
      report.stop_requests = contract.stops;
      controller.close();
    },
    {
      binary,
      beforeStart(fixture) {
        fixtureIdentity = {
          id: fixture.id,
          container: fixture.container,
          root: fixture.root,
        };
        report.fixture = fixtureIdentity;
        ownedVolumes = JSON.parse(
          docker("inspect", fixture.container, "--format", "{{json .Mounts}}"),
        )
          .filter((mount) => mount.Type === "volume")
          .map((mount) => mount.Name);
      },
    },
  );
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failures.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  const cleanupStep = async (label, action) => {
    try {
      await action();
    } catch (error) {
      report.result = "failed";
      report.failures.push(`${label}: ${String(error.stack ?? error)}`);
      process.exitCode = 1;
    }
  };
  await cleanupStep("controller cleanup", () => controller?.close());
  for (const pending of contract.sessions.values()) {
    pending.fault.hold?.release();
    pending.fault.stop_hold?.release();
    pending.fault.start_hold?.release();
  }
  await cleanupStep("controlled upstream cleanup", async () => {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  });
  try {
    if (fixtureIdentity) {
      assert.equal(
        docker(
          "ps",
          "-a",
          "--filter",
          `name=^/${fixtureIdentity.container}$`,
          "--format",
          "{{.Names}}",
        ),
        "",
      );
      for (const volume of ownedVolumes) {
        const alreadyRemoved =
          docker(
            "volume",
            "ls",
            "--filter",
            `name=^${volume}$`,
            "--format",
            "{{.Name}}",
          ) === "";
        if (!alreadyRemoved) docker("volume", "rm", volume);
        const absent =
          docker(
            "volume",
            "ls",
            "--filter",
            `name=^${volume}$`,
            "--format",
            "{{.Name}}",
          ) === "";
        assert.equal(
          absent,
          true,
          "only the observed fixture's volume is removed",
        );
        report.cleanup.volumes.push({
          name: volume,
          removed: absent,
          already_removed: alreadyRemoved,
        });
      }
      report.cleanup.completed = true;
    }
  } catch (error) {
    report.result = "failed";
    report.failures.push(`cleanup: ${String(error.stack ?? error)}`);
    process.exitCode = 1;
  }
  await cleanupStep("entry hash", async () => {
    report.final_entry_sha256 = await digest(entry);
  });
  await cleanupStep("fixture hash", async () => {
    report.final_fixture_entry_sha256 = await digest(fixtureEntry);
  });
  await cleanupStep("binary hash", async () => {
    report.binary.final_sha256 = await digest(binary);
  });
  await cleanupStep("compiled backend source hashes", async () => {
    if (report.backend_binding) {
      const binding = JSON.parse(
        await readFile(report.backend_binding.path, "utf8"),
      );
      assert.equal(
        await digest(report.backend_binding.path),
        report.backend_binding.sha256,
      );
      for (const file of binding.source)
        assert.equal(
          await digest(resolve(file.path)),
          file.sha256,
          `backend input remains stable ${file.path}`,
        );
      report.backend_source_unchanged = true;
    }
  });
  if (
    report.entry_sha256 !== report.final_entry_sha256 ||
    report.fixture_entry_sha256 !== report.final_fixture_entry_sha256 ||
    report.binary.sha256 !== report.binary.final_sha256
  ) {
    report.result = "failed";
    report.failures.push("entry/fixture/binary changed during this run");
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  report.controlled_remote_final = [...contract.sessions.entries()].map(
    ([sid, session]) => ({
      play_session_id: sid,
      kind: session.kind,
      device_id: session.device,
      stopped: session.stopped,
      encoding_active: session.encoding_active,
      scenario: session.fault.name,
    }),
  );
  report.fixture_assertion_failures = contract.failures;
  await save();
  console.log(`Evidence: ${runRoot}`);
}
