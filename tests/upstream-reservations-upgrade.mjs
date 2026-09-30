// Real pre-W03 native Server -> migration 25, with isolated PostgreSQL and
// controlled HTTP contracts. This does not claim real Jellyfin/Emby decoding.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createHash,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import WS from "ws";
import { isolatedServer } from "./fixtures/server.mjs";

const repo = resolve(".");
const artifacts = resolve(".runtime/upstream-reservations-upgrade");
process.env.RAINSYNC_ARTIFACT_DIR = artifacts;
const runRoot = resolve(artifacts, randomUUID());
await mkdir(runRoot, { recursive: true });
const oldSource = resolve(
  ".runtime/frontend-merge/float-roundtrip/room-state-roundtrip/fd3ba80d-42de-48ad-a8f1-4e9ac3b952f8/server-under-test.exe",
);
const oldSha =
  "a4efce0dc7845a4cf369777dba22f37534277db9eebda98789dcde880614e0e9";
const bindingPath = resolve(
  process.env.W03_BACKEND_BINDING ??
    ".runtime/w03-backend/backend-binding.json",
);
const bindingBoundary = relative(resolve(".runtime/w03-backend"), bindingPath);
assert.ok(
  bindingBoundary &&
    !bindingBoundary.startsWith("..") &&
    !isAbsolute(bindingBoundary),
  "backend binding stays inside the explicit W03 evidence directory",
);
const oldCopy = resolve(runRoot, "pre-w03-server.exe");
const newCopy = resolve(runRoot, "migration25-server.exe");
const entry = resolve("tests/upstream-reservations-upgrade.mjs");
const fixtureEntry = resolve("tests/fixtures/server.mjs");
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const report = {
  started_at: new Date().toISOString(),
  result: "running",
  scope:
    "actual pre-W03 Windows Server, real migrations 1-24 -> 25 and real API/DB/WS; isolated controlled upstream HTTP contracts, no real Jellyfin/Emby or decode claim",
  old_binary_identity: {
    source: oldSource,
    tested_copy: oldCopy,
    expected_sha256: oldSha,
    source_identity:
      "binary-only frozen evidence; f64 fixed, W03 before; no checkout commit inferred",
  },
  new_binary_identity: { binding: bindingPath, tested_copy: newCopy },
  cases: [],
  failures: [],
  cleanup: { completed: false, steps: [], volumes: [] },
};
const save = () =>
  writeFile(
    resolve(runRoot, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
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
function sourcePath(path) {
  assert.equal(isAbsolute(path), false, "binding source is relative");
  const absolute = resolve(repo, path);
  const boundary = relative(repo, absolute);
  assert.ok(
    boundary && !boundary.startsWith("..") && !isAbsolute(boundary),
    "binding source stays inside repository",
  );
  return absolute;
}
function decryptResource(fixture, envelope) {
  const bytes = Buffer.from(envelope.encrypted, "base64");
  assert.ok(bytes.length > 28, "legacy resource is AES-GCM ciphertext");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(fixture.env.SOURCE_ENCRYPTION_KEY, "base64"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]),
  );
}
function publicRow(row) {
  const { encrypted, ...flags } = row.resource;
  return {
    id: row.id,
    user_id: row.user_id,
    stopped: row.stopped,
    generation: row.generation,
    expires_at: row.expires_at,
    encrypted_sha256: createHash("sha256").update(encrypted).digest("hex"),
    flags,
  };
}

const token = randomBytes(24).toString("hex");
const contract = {
  queue: [],
  requests: [],
  negotiations: [],
  sessions: new Map(),
  failures: [],
};
let upstreamOrigin,
  upstream,
  listening = false;
function json(response, event, body, status = 200) {
  event.response_status = status;
  response
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}
function handler(request, response) {
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
      "original fixture credential remains valid",
    );
    const device =
      /DeviceId="([^"]+)"/.exec(authorization)?.[1] ??
      url.searchParams.get("DeviceId") ??
      request.headers["x-emby-device-id"] ??
      null;
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
      device_id: device,
      play_session_id:
        body?.PlaySessionId ?? url.searchParams.get("PlaySessionId") ?? null,
    };
    contract.requests.push(event);
    if (path === "/Users/fixture-user/Items")
      return json(response, event, {
        TotalRecordCount: 1,
        Items: [
          {
            Id: "fixture",
            Name: `${kind} legacy fixture`,
            RunTimeTicks: 600000000,
          },
        ],
      });
    if (path === "/Items/fixture/PlaybackInfo") {
      // Assert the wire identity actually produced by the frozen old binary.
      assert.equal(
        device,
        kind === "jellyfin" ? "rainsync" : null,
        "legacy negotiation uses its original identity",
      );
      const fault = contract.queue.shift() ?? {};
      assert.equal(
        fault.kind,
        kind,
        "negotiation belongs to queued legacy scenario",
      );
      const sid = randomUUID();
      Object.assign(event, { scenario: fault.name, play_session_id: sid });
      contract.negotiations.push(event);
      contract.sessions.set(sid, {
        kind,
        original_device: device,
        fault,
        stopped: false,
        encoding_active: false,
      });
      fault.negotiation = event;
      const value = {
        PlaySessionId: sid,
        MediaSources: [
          {
            Id: `source-${kind}`,
            SupportsDirectPlay: true,
            RunTimeTicks: 600000000,
            MediaStreams: [{ Type: "Audio", Index: 1, Codec: "aac" }],
          },
        ],
      };
      if (fault.no_sid) delete value.PlaySessionId;
      return json(response, event, value);
    }
    if (
      [
        "/Sessions/Playing",
        "/Sessions/Playing/Progress",
        "/Sessions/Playing/Stopped",
      ].includes(path)
    ) {
      const session = contract.sessions.get(body.PlaySessionId);
      if (!session) return json(response, event, { error: "unknown SID" }, 400);
      assert.equal(
        kind,
        session.kind,
        "report retains the original upstream kind",
      );
      if (path.endsWith("Stopped")) {
        assert.equal(
          device,
          session.original_device,
          "Stop targets the originally negotiated device",
        );
        if (session.fault.stop_failure)
          return json(
            response,
            event,
            { error: "controlled Stop failure" },
            503,
          );
        session.stopped = true;
        if (kind === "jellyfin") session.encoding_active = false;
      } else if (path === "/Sessions/Playing") {
        // Legacy Start may omit DeviceId; record that wire fact without changing
        // the negotiation's stored identity or helping the product recover it.
        session.encoding_active = true;
      }
      event.response_status = 204;
      response.writeHead(204).end();
      return;
    }
    if (path === "/Videos/ActiveEncodings") {
      assert.fail(
        "legacy Emby has no recoverable device: unsafe ActiveEncodings DELETE must never be sent",
      );
    }
    json(response, event, { error: "unhandled contract route" }, 404);
  })().catch((error) => {
    contract.failures.push(String(error.stack ?? error));
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
}

class Controller {
  constructor(fixture, client) {
    this.fixture = fixture;
    this.client = client;
    this.inbox = [];
  }
  async join(room) {
    this.room = room;
    this.socket = new WS(
      this.fixture.origin.replace("http", "ws") + "/api/v1/ws",
      {
        headers: { Origin: this.fixture.origin, Cookie: this.client.cookie },
      },
    );
    this.socket.on("message", (bytes) => this.inbox.push(JSON.parse(bytes)));
    this.socket.on("error", () => {});
    await new Promise((done, reject) => {
      this.socket.once("open", done);
      this.socket.once("error", reject);
    });
    this.socket.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
    const snapshot = await this.wait((value) => value.type === "SNAPSHOT");
    this.state = snapshot.state;
    this.epoch = snapshot.control_epoch.id;
  }
  wait(predicate) {
    return until(() => {
      const index = this.inbox.findIndex(predicate);
      return index < 0 ? null : this.inbox.splice(index, 1)[0];
    }, "authenticated control response");
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
    const answer = await this.wait((value) => value.command_id === id);
    assert.equal(answer.type, "ACK");
    this.state = answer.state;
  }
  close() {
    this.socket?.terminate();
  }
}

const controllers = [];
let fixtureIdentity,
  ownedVolumes = [],
  newSource,
  newSha,
  binding,
  bindingSha;
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
async function cleanupStep(name, run) {
  const result = { name, result: "running" };
  report.cleanup.steps.push(result);
  try {
    await run();
    result.result = "passed";
  } catch (error) {
    result.result = "failed";
    result.error = String(error.stack ?? error);
    report.failures.push({ cleanup: name, error: result.error });
    report.result = "failed";
    process.exitCode = 1;
  }
}

try {
  assert.equal(
    process.platform,
    "win32",
    "the pinned pre-W03 evidence is a Windows executable",
  );
  report.entry_sha256 = await digest(entry);
  report.fixture_entry_sha256 = await digest(fixtureEntry);
  assert.equal(
    await digest(oldSource),
    oldSha,
    "pre-W03 executable matches frozen evidence",
  );
  bindingSha = await digest(bindingPath);
  binding = JSON.parse(await readFile(bindingPath, "utf8"));
  const binary = binding.binaries.find(
    (item) => item.name === "rainsync-server",
  );
  assert.ok(binary && /^[a-f0-9]{64}$/.test(binary.sha256));
  newSource = resolve(binary.path);
  newSha = binary.sha256;
  assert.equal(
    await digest(newSource),
    newSha,
    "new native executable matches the final backend binding",
  );
  for (const item of binding.source)
    assert.equal(
      await digest(sourcePath(item.path)),
      item.sha256,
      `new backend source binding ${item.path}`,
    );
  Object.assign(report.new_binary_identity, {
    source: newSource,
    sha256: newSha,
    binding_sha256: bindingSha,
    source_digest: binding.source_digest,
    source_manifest: binding.source.map(({ path, sha256, bytes }) => ({
      path,
      sha256,
      bytes,
    })),
  });
  await copyFile(oldSource, oldCopy);
  await copyFile(newSource, newCopy);
  assert.equal(await digest(oldCopy), oldSha);
  assert.equal(await digest(newCopy), newSha);
  report.old_binary_identity.sha256 = oldSha;
  upstream = createServer(handler);
  await new Promise((done, reject) =>
    upstream.once("error", reject).listen(0, "127.0.0.1", done),
  );
  listening = true;
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  await save();
  await isolatedServer(
    "upstream-upgrade",
    async (fixture) => {
      const versions = () =>
        JSON.parse(
          fixture.sql(
            "SELECT json_agg(version ORDER BY version) FROM _sqlx_migrations WHERE success",
          ),
        );
      assert.deepEqual(
        versions(),
        Array.from({ length: 24 }, (_, i) => i + 1),
        "old executable actually installs precisely migrations 1-24",
      );
      report.migrations_before = versions();
      assert.equal(
        fixture.sql(
          "SELECT to_regclass('public.upstream_reservations') IS NULL",
        ),
        "t",
      );
      const admin = fixture.client();
      await admin.login();
      const groups = {},
        grants = [];
      const record = (id) =>
        JSON.parse(
          fixture.sql(
            `SELECT row_to_json(p) FROM playback_sessions p WHERE id=${sqlUuid(id)}`,
          ),
        );
      for (const kind of ["jellyfin", "emby"]) {
        const source = await admin.request("/sources", "POST", {
          name: `${kind} legacy upgrade contract`,
          kind,
          config: {
            url: `${upstreamOrigin}/${kind}`,
            user_id: "fixture-user",
            token,
          },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const media = fixture.sql(
          `SELECT id FROM media_items WHERE source_id=${sqlUuid(source.id)}`,
        );
        assert.match(media, /^[0-9a-f-]{36}$/);
        const room = await admin.request("/rooms", "POST", {
          name: `${kind} legacy upgrade`,
        });
        const invite = await admin.request(`/rooms/${room.id}/invites`, "POST");
        const controller = new Controller(fixture, admin);
        controllers.push(controller);
        await controller.join(room);
        await controller.change(media);
        groups[kind] = { room, invite, controller, media };
      }
      const densityGroups = new Map();
      for (const fault of [
        { name: "jellyfin-known-stop", kind: "jellyfin" },
        { name: "jellyfin-survivor", kind: "jellyfin" },
        { name: "jellyfin-stop-failure", kind: "jellyfin", stop_failure: true },
        { name: "jellyfin-unknown-sid", kind: "jellyfin", no_sid: true },
        { name: "emby-unknown-device", kind: "emby" },
        { name: "emby-survivor", kind: "emby" },
        ...Array.from({ length: 40 }, (_, index) => ({
          name: `jellyfin-density-${index}`,
          kind: "jellyfin",
        })),
      ]) {
        const username = `upgrade-${randomUUID().slice(0, 8)}`,
          password = randomBytes(24).toString("hex");
        await admin.request("/users", "POST", { username, password });
        const client = fixture.client();
        await client.login(username, password);
        let group = groups[fault.kind];
        let ownsRoom = false;
        if (fault.name.startsWith("jellyfin-density-")) {
          const index = Number(fault.name.slice("jellyfin-density-".length));
          const bucket = Math.floor(index / 8);
          group = densityGroups.get(bucket);
          if (!group) {
            const room = await client.request("/rooms", "POST", {
              name: `legacy density ${bucket}`,
            });
            const invite = await client.request(
              `/rooms/${room.id}/invites`,
              "POST",
            );
            const controller = new Controller(fixture, client);
            controllers.push(controller);
            await controller.join(room);
            await controller.change(groups.jellyfin.media);
            group = { room, invite, controller };
            densityGroups.set(bucket, group);
            ownsRoom = true;
          }
        }
        if (!ownsRoom)
          await client.request(`/rooms/${group.room.id}/join`, "POST", {
            token: group.invite.token,
          });
        contract.queue.push(fault);
        const plan = await client.request("/playback-sessions", "POST", {
          room_id: group.room.id,
          media_generation: group.controller.state.media_generation,
          idempotency_key: randomUUID(),
          mode: "auto",
          position_ms: 1200,
        });
        const row = record(plan.session_id),
          resource = decryptResource(fixture, row.resource);
        assert.equal(row.stopped, false);
        assert.equal(resource.kind, fault.kind);
        assert.equal(resource.upstream_base, `${upstreamOrigin}/${fault.kind}`);
        assert.equal(resource.upstream_item, "fixture");
        assert.equal(
          resource.upstream_session ?? null,
          fault.no_sid ? null : fault.negotiation.play_session_id,
        );
        assert.equal(
          resource.upstream_device,
          undefined,
          "test does not retrofit device identity into legacy resources",
        );
        assert.deepEqual(Object.keys(row.resource), ["encrypted"]);
        const headers = resource.headers;
        if (fault.kind === "jellyfin")
          assert.equal(headers.Authorization, `MediaBrowser Token="${token}"`);
        else assert.equal(headers["X-Emby-Token"], token);
        if (!fault.no_sid)
          await until(
            () =>
              contract.requests.find(
                (r) =>
                  r.path === "/Sessions/Playing" &&
                  r.play_session_id === fault.negotiation.play_session_id &&
                  r.response_status === 204,
              ),
            "old native Start confirmed",
          );
        grants.push({ fault, client, plan, encrypted: row.resource.encrypted });
        report.cases.push({
          name: `old API creates ${fault.name}`,
          result: "passed",
          session_id: row.id,
          original_scope: {
            kind: resource.kind,
            upstream_item: resource.upstream_item,
            upstream_base: resource.upstream_base,
            play_session_id: resource.upstream_session ?? null,
            negotiated_device_id: fault.negotiation.device_id,
            stored_header_names: Object.keys(headers),
            stored_upstream_device: resource.upstream_device ?? null,
          },
          old_row: publicRow(row),
        });
        await save();
      }
      assert.equal(contract.queue.length, 0);
      const beforeNegotiations = contract.negotiations.length;
      const upgradeRequestStart = contract.requests.length;
      for (const controller of controllers) controller.close();
      await fixture.stopServer();
      await fixture.startServer({}, newCopy);
      report.migrations_after = versions();
      assert.deepEqual(
        report.migrations_after,
        Array.from({ length: 25 }, (_, i) => i + 1),
      );
      assert.equal(
        fixture.sql("SELECT count(*) FROM upstream_reservations"),
        "0",
        "migration 25 keeps legacy resources out of the new ledger",
      );
      await scenario(
        "all 46 legacy grants survive the actual 1-24 -> 25 upgrade without negotiation",
        async (result) => {
          for (const grant of grants) {
            const ready = await grant.client.request(
              `/playback-sessions/${grant.plan.session_id}`,
            );
            assert.equal(ready.session_id, grant.plan.session_id);
            assert.equal(ready.status, "ready");
            const oldExpiry = Date.parse(
              record(grant.plan.session_id).expires_at,
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
            const row = record(grant.plan.session_id);
            assert.ok(Date.parse(row.expires_at) >= oldExpiry);
            assert.equal(row.stopped, false);
            assert.equal(
              row.resource.encrypted,
              grant.encrypted,
              "same encrypted original scope is preserved",
            );
          }
          assert.equal(contract.negotiations.length, beforeNegotiations);
          result.sessions = grants.map((g) => g.plan.session_id);
        },
      );
      const get = (name) => grants.find((g) => g.fault.name === name);
      // Choosing the largest of forty genuinely issued UUIDs gives a
      // deterministic starvation case without rewriting a session or scope.
      const density = grants.filter((g) =>
        g.fault.name.startsWith("jellyfin-density-"),
      );
      const known = density.reduce((largest, g) =>
        g.plan.session_id > largest.plan.session_id ? g : largest,
      );
      const failed = [
        get("jellyfin-stop-failure"),
        get("jellyfin-unknown-sid"),
        get("emby-unknown-device"),
      ];
      const survivors = grants.filter(
        (g) => g !== known && !failed.includes(g),
      );
      const smallerActive = Number(
        fixture.sql(
          `SELECT count(*) FROM playback_sessions WHERE NOT stopped AND expires_at>clock_timestamp() AND id<${sqlUuid(known.plan.session_id)}`,
        ),
      );
      assert.ok(
        smallerActive >= 39,
        "at least 39 smaller UUIDs stay active ahead of the selected Stop target",
      );
      await scenario(
        "more than 32 old grants receive fair real Progress across the full active set",
        async (result) => {
          await until(
            () =>
              survivors.every((g) =>
                contract.requests
                  .slice(upgradeRequestStart)
                  .some(
                    (r) =>
                      r.path === "/Sessions/Playing/Progress" &&
                      r.play_session_id ===
                        g.fault.negotiation.play_session_id &&
                      r.response_status === 204,
                  ),
              ),
            "all 42 independently authenticated active legacy grants receive Progress",
            45000,
          );
          const observed = survivors.map((g) => ({
            session_id: g.plan.session_id,
            play_session_id: g.fault.negotiation.play_session_id,
            progress_requests: contract.requests
              .slice(upgradeRequestStart)
              .filter(
                (r) =>
                  r.path === "/Sessions/Playing/Progress" &&
                  r.play_session_id === g.fault.negotiation.play_session_id &&
                  r.response_status === 204,
              ).length,
          }));
          assert.ok(observed.every((r) => r.progress_requests >= 1));
          result.active_progress = observed;
          result.stopped_target_with_larger_uuid = known.plan.session_id;
          result.smaller_active_grants = smallerActive;
        },
      );
      await scenario(
        "known old Jellyfin SID closes with its original device while other grants remain valid",
        async (result) => {
          await known.client.request(
            `/playback-sessions/${known.plan.session_id}`,
            "DELETE",
          );
          const row = await until(
            () => {
              const value = record(known.plan.session_id);
              return value.resource.upstream_closed === true ? value : null;
            },
            "confirmed legacy Jellyfin closure",
            25000,
          );
          const sid = known.fault.negotiation.play_session_id;
          const stop = contract.requests.find(
            (r) =>
              r.path === "/Sessions/Playing/Stopped" &&
              r.play_session_id === sid &&
              r.response_status === 204,
          );
          assert.ok(stop);
          assert.equal(stop.device_id, known.fault.negotiation.device_id);
          assert.equal(stop.device_id, "rainsync");
          assert.equal(contract.sessions.get(sid).stopped, true);
          assert.equal(contract.sessions.get(sid).encoding_active, false);
          assert.equal(row.stopped, true);
          assert.equal(row.resource.upstream_io_uncertain ?? false, false);
          assert.equal(row.resource.encrypted, known.encrypted);
          for (const survivor of survivors) {
            assert.equal(
              (
                await survivor.client.request(
                  `/playback-sessions/${survivor.plan.session_id}`,
                )
              ).status,
              "ready",
            );
            assert.equal(
              (
                await survivor.client.request(
                  `/playback-sessions/${survivor.plan.session_id}`,
                  "POST",
                )
              ).ok,
              true,
            );
            assert.equal(record(survivor.plan.session_id).stopped, false);
            assert.equal(
              contract.sessions.get(survivor.fault.negotiation.play_session_id)
                .stopped,
              false,
            );
          }
          assert.equal(contract.negotiations.length, beforeNegotiations);
          Object.assign(result, {
            row: publicRow(row),
            stop_request: stop,
            surviving_sessions: survivors.map((g) => g.plan.session_id),
            smaller_active_grants: smallerActive,
          });
        },
      );
      const failedStopStarted = performance.now();
      for (const grant of failed)
        await grant.client.request(
          `/playback-sessions/${grant.plan.session_id}`,
          "DELETE",
        );
      await scenario(
        "unknown SID, unknown Emby device and failed Stop reach a real bounded failed state",
        async (result) => {
          const stopRequests = (grant) =>
            contract.requests.filter(
              (r) =>
                r.path === "/Sessions/Playing/Stopped" &&
                r.play_session_id === grant.fault.negotiation.play_session_id,
            );
          await until(
            () => {
              const checkpoint = failed.map((g) => record(g.plan.session_id));
              const failureStops = stopRequests(get("jellyfin-stop-failure"));
              const embyStops = stopRequests(get("emby-unknown-device"));
              Object.assign(result, {
                failed_budget_checkpoint: checkpoint.map(publicRow),
                failed_stop_checkpoint: {
                  jellyfin: failureStops.length,
                  emby: embyStops.length,
                  unknown_sid: stopRequests(get("jellyfin-unknown-sid")).length,
                },
              });
              return (
                checkpoint.every(
                  ({ resource }) =>
                    resource.upstream_cleanup_attempts === 5 &&
                    resource.upstream_cleanup_failed === true &&
                    !resource.upstream_io_claim &&
                    !resource.upstream_io_pending,
                ) &&
                failureStops.length === 5 &&
                failureStops.every((r) => r.response_status === 503) &&
                embyStops.length === 5 &&
                embyStops.every((r) => r.response_status === 204)
              );
            },
            "five completed local claims and all five known-SID Stop responses",
            80000,
          );
          const rows = failed.map((g) => record(g.plan.session_id));
          for (const [index, row] of rows.entries()) {
            assert.equal(row.stopped, true);
            assert.equal(row.resource.upstream_cleanup_failed, true);
            assert.notEqual(row.resource.upstream_closed, true);
            assert.equal(row.resource.encrypted, failed[index].encrypted);
            assert.ok(
              Number.isFinite(
                Date.parse(row.resource.upstream_cleanup_deadline),
              ),
            );
          }
          assert.equal(stopRequests(get("jellyfin-stop-failure")).length, 5);
          assert.ok(
            stopRequests(get("jellyfin-stop-failure")).every(
              (r) => r.response_status === 503 && r.device_id === "rainsync",
            ),
          );
          assert.equal(stopRequests(get("emby-unknown-device")).length, 5);
          assert.ok(
            stopRequests(get("emby-unknown-device")).every(
              (r) => r.response_status === 204 && r.device_id === null,
            ),
          );
          assert.equal(
            contract.requests.filter(
              (r) => r.path === "/Videos/ActiveEncodings",
            ).length,
            0,
          );
          assert.equal(
            contract.requests.filter(
              (r) => r.path.endsWith("Stopped") && r.play_session_id === null,
            ).length,
            0,
            "unknown SID is never fabricated in a Stop",
          );
          assert.equal(
            stopRequests(get("jellyfin-unknown-sid")).length,
            0,
            "hidden fixture SID is never recovered by the test",
          );
          assert.equal(
            contract.sessions.get(
              get("emby-unknown-device").fault.negotiation.play_session_id,
            ).encoding_active,
            true,
            "Stop check-in alone never proves Emby encoder release",
          );
          const checkpoint = contract.requests.filter((r) =>
            r.path.endsWith("Stopped"),
          ).length;
          const stabilityStarted = performance.now();
          await delay(12500);
          assert.equal(
            contract.requests.filter((r) => r.path.endsWith("Stopped")).length,
            checkpoint,
            "no sixth Stop after more than one real maintenance period",
          );
          for (const grant of failed) {
            const row = record(grant.plan.session_id);
            assert.equal(row.resource.upstream_cleanup_attempts, 5);
            assert.notEqual(row.resource.upstream_closed, true);
          }
          for (const survivor of survivors) {
            assert.equal(
              (
                await survivor.client.request(
                  `/playback-sessions/${survivor.plan.session_id}`,
                )
              ).status,
              "ready",
            );
            assert.equal(
              (
                await survivor.client.request(
                  `/playback-sessions/${survivor.plan.session_id}`,
                  "POST",
                )
              ).ok,
              true,
            );
          }
          assert.equal(contract.negotiations.length, beforeNegotiations);
          assert.equal(
            fixture.sql("SELECT count(*) FROM upstream_reservations"),
            "0",
          );
          const progressDuringCleanup = contract.requests.filter(
            (r) =>
              r.path === "/Sessions/Playing/Progress" &&
              r.response_status === 204 &&
              r.monotonic_ms >= failedStopStarted,
          );
          assert.ok(
            survivors.every((g) =>
              progressDuringCleanup.some(
                (r) =>
                  r.play_session_id === g.fault.negotiation.play_session_id,
              ),
            ),
            "bounded failed cleanup never starves progress for any of the 42 active survivors",
          );
          Object.assign(result, {
            failed_rows: failed.map((g) =>
              publicRow(record(g.plan.session_id)),
            ),
            actual_elapsed_ms: performance.now() - failedStopStarted,
            actual_stability_window_ms: performance.now() - stabilityStarted,
          });
        },
      );
      assert.equal(
        contract.failures.length,
        0,
        "controlled HTTP handler assertions all pass",
      );
      report.result = "passed";
    },
    {
      binary: oldCopy,
      beforeStart: async (fixture) => {
        fixtureIdentity = {
          id: fixture.id,
          container: fixture.container,
          root: fixture.root,
        };
        const info = JSON.parse(
          docker("inspect", "--format", "{{json .Mounts}}", fixture.container),
        );
        ownedVolumes = info
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
  report.result = "failed";
  report.failures.push({ error: String(error.stack ?? error) });
  const current = report.cases.findLast((c) => c.result === "running");
  if (current) {
    current.result = "failed";
    current.finished_at = new Date().toISOString();
  }
  process.exitCode = 1;
} finally {
  for (const [index, controller] of controllers.entries())
    await cleanupStep(`controller ${index}`, async () => controller.close());
  if (listening)
    await cleanupStep("controlled upstream listener", async () => {
      upstream.closeAllConnections();
      await new Promise((done, reject) =>
        upstream.close((error) => (error ? reject(error) : done())),
      );
    });
  if (fixtureIdentity)
    await cleanupStep(
      "owned PostgreSQL container and anonymous volumes",
      async () => {
        const { container } = fixtureIdentity;
        const listed = docker(
          "ps",
          "-a",
          "--filter",
          `name=^/${container}$`,
          "--format",
          "{{.Names}}",
        );
        if (listed) {
          assert.equal(listed, container);
          docker("rm", "-f", container);
        }
        assert.equal(
          docker(
            "ps",
            "-a",
            "--filter",
            `name=^/${container}$`,
            "--format",
            "{{.Names}}",
          ),
          "",
        );
        for (const name of ownedVolumes) {
          const existing = docker(
            "volume",
            "ls",
            "--filter",
            `name=^${name}$`,
            "--format",
            "{{.Name}}",
          );
          if (existing) {
            assert.equal(existing, name);
            docker("volume", "rm", name);
          }
          assert.equal(
            docker(
              "volume",
              "ls",
              "--filter",
              `name=^${name}$`,
              "--format",
              "{{.Name}}",
            ),
            "",
          );
          report.cleanup.volumes.push({
            name,
            removed: true,
            already_removed: !existing,
          });
        }
        report.cleanup.container_removed = true;
      },
    );
  for (const [name, path, expected] of [
    ["entry", entry, report.entry_sha256],
    ["fixture entry", fixtureEntry, report.fixture_entry_sha256],
    ["old source executable", oldSource, oldSha],
    ["old tested executable", oldCopy, oldSha],
    ["new source executable", newSource, newSha],
    ["new tested executable", newCopy, newSha],
    ["new backend binding", bindingPath, bindingSha],
  ])
    if (path && expected)
      await cleanupStep(`${name} identity`, async () =>
        assert.equal(await digest(path), expected),
      );
  if (binding)
    for (const item of binding.source)
      await cleanupStep(`backend source ${item.path}`, async () =>
        assert.equal(await digest(sourcePath(item.path)), item.sha256),
      );
  report.requests = contract.requests;
  report.controlled_remote_final = [...contract.sessions].map(([sid, s]) => ({
    play_session_id: sid,
    kind: s.kind,
    original_device_id: s.original_device,
    stopped: s.stopped,
    encoding_active: s.encoding_active,
    scenario: s.fault.name,
  }));
  report.fixture_assertion_failures = contract.failures;
  if (contract.failures.length) {
    report.result = "failed";
    process.exitCode = 1;
  }
  report.cleanup.completed =
    !!fixtureIdentity &&
    report.cleanup.steps.every((s) => s.result === "passed");
  report.finished_at = new Date().toISOString();
  await save();
  console.log(`Evidence: ${resolve(runRoot, "report.json")}`);
}
