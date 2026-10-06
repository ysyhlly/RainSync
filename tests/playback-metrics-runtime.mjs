// Public-API regression against an owned native PostgreSQL/Server/Worker stack.
// The Jellyfin peer is explicitly controlled protocol, not product compatibility.
// No successful grant, observation, account-policy row or metrics slot is seeded.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingPath =
  process.env.RAINSYNC_PLAYBACK_METRICS_BINDING ??
  process.env.RAINSYNC_SOURCE_ACCESS_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
assert.ok(
  bindingPath,
  "A successful frozen backend binding is required; this test never builds",
);
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "An external artifact root is required",
);
const bindingBytes = await readFile(bindingPath);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const required of [
  "apps/server/src/playback_metrics.rs",
  "migrations/0035_playback_metrics.sql",
  "crates/protocol/src/playback_metrics.rs",
  "crates/media-core/src/runtime_metrics.rs",
])
  assert.ok(
    binding.source.some((entry) => entry.path === required),
    `Binding includes ${required}`,
  );
const coordinator = await Promise.all(
  [
    "tests/playback-metrics-runtime.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/postgres.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of ["rainsync-server", "rainsync-media-worker"])
  assert.equal(
    resolve(binding.binaries.find((b) => b.name === name)?.path ?? "missing"),
    resolve(target, name + (process.platform === "win32" ? ".exe" : "")),
  );
async function verifyBinding() {
  assert.equal(digest(await readFile(bindingPath)), digest(bindingBytes));
  for (const input of [...binding.source, ...coordinator])
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      input.path,
    );
  for (const binary of binding.binaries)
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      binary.name,
    );
}
await verifyBinding();
const report = {
  schema_version: 1,
  result: "running",
  started_at: new Date().toISOString(),
  checks: [],
  scope:
    "Real owned PostgreSQL and public RainSync APIs; generated H264 local source, controlled Jellyfin account-policy protocol, intentional owned SQL authority/constraint/lock fault injection. No production, browser decode or upstream product compatibility claim.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
  rate_contract: {
    requests: 6,
    window_ms: 10000,
    maximum_in_flight: 32,
    minimum_nonfinal_delta_ms: 1000,
  },
};
let fixture, workerPid, workerPort, controlled, primaryError;
const sockets = new Set();
async function until(probe, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(15);
  }
  throw Error(`Deadline: ${label}`);
}
async function checked(response, status, code) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  const body = text ? JSON.parse(text) : null;
  if (code) assert.equal(body.error.code, code);
  return body;
}
async function roomController(f, client, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: client.cookie },
  });
  sockets.add(ws);
  ws.on("error", () => {});
  ws.once("close", () => sockets.delete(ws));
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  const next = (predicate) =>
    until(() => {
      const index = frames.findIndex(predicate);
      return index < 0 ? null : frames.splice(index, 1)[0];
    }, "public room response");
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((v) => v.type === "SNAPSHOT");
  let state = snapshot.state,
    epoch = snapshot.control_epoch.id;
  return {
    get state() {
      return state;
    },
    async select(media) {
      const command = {
        protocol_version: 1,
        room_id: room.id,
        command_id: randomUUID(),
        control_epoch: epoch,
        expected_revision: state.revision,
        media_generation: state.media_generation,
        type: "CHANGE_MEDIA",
        payload: { media_id: media.id },
      };
      ws.send(JSON.stringify(command));
      let answer = await next((v) => v.command_id === command.command_id);
      if (
        answer.type === "ERROR" &&
        answer.control_epoch &&
        ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
          answer.error?.code,
        )
      ) {
        epoch = answer.control_epoch.id;
        ws.send(JSON.stringify({ ...command, control_epoch: epoch }));
        answer = await next((v) => v.command_id === command.command_id);
      }
      assert.equal(answer.type, "ACK", JSON.stringify(answer));
      state = answer.state;
      assert.equal(state.media_id, media.id);
      return state.media_generation;
    },
  };
}
function totals(elapsed, extra = {}) {
  return {
    startup_ms: elapsed,
    autoplay_blocked_ms: 0,
    background_ms: 0,
    paused_ms: 0,
    seeking_ms: 0,
    rebuffer_ms: 0,
    playing_ms: 0,
    unobserved_ms: 0,
    ...extra,
  };
}
function sample(grant, seq = 1, elapsed = 1000, extra = {}) {
  return {
    version: 1,
    media_generation: grant.plan.media_generation,
    plan_generation: grant.plan.plan_generation,
    meter_start_generation: grant.input.playback_metrics.meter_start_generation,
    seq,
    startup_origin: grant.input.playback_metrics.startup_origin,
    elapsed_ms: elapsed,
    totals: totals(elapsed),
    final: false,
    ...extra,
  };
}
function observation(grant, seq = 1, extra = {}) {
  return {
    media_generation: grant.plan.media_generation,
    seq,
    event: "progress",
    media_time_ms: 100,
    paused: false,
    seeking: false,
    buffering: false,
    playback_rate: 1,
    has_played: true,
    ...extra,
  };
}
async function lock(f, sql) {
  const marker = `metrics_lock_${randomUUID().replaceAll("-", "")}`;
  const child = f.sqlProcess(undefined, { interactive: true });
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stdin.write(
    `BEGIN; SET application_name=${quote(marker)}; ${sql}; SELECT ${quote(marker)};\n`,
  );
  await until(() => output.includes(marker), "owned lock acquired");
  return {
    async finish(commit = true) {
      if (child.exitCode !== null) return child.done;
      child.stdin.end(`${commit ? "COMMIT" : "ROLLBACK"};\n`);
      await child.done;
    },
  };
}
async function waiting(f, sqlPattern) {
  await until(
    () =>
      Number(
        f.sql(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
    AND wait_event_type='Lock' AND application_name NOT LIKE 'metrics_lock_%'
    AND query LIKE ${quote("%" + sqlPattern + "%")}`),
      ) > 0,
    `actual blocked ${sqlPattern}`,
    400,
  );
}
async function controlledJellyfin(clip) {
  const account = randomUUID(),
    token = randomBytes(24).toString("hex");
  const policy = { IsDisabled: false, EnableMediaPlayback: true };
  const faults = { metadataFailure: false };
  const events = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    events.push({ method: request.method, path, at: Date.now() });
    const auth =
      request.headers.authorization ??
      request.headers["x-emby-authorization"] ??
      "";
    if (
      (request.headers["x-emby-token"] ?? /Token="([^"]+)"/.exec(auth)?.[1]) !==
      token
    )
      return response.writeHead(401).end();
    const json = (body) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (path === `/Users/${account}`)
      return json({ Id: account, Policy: policy });
    if (path === `/Users/${account}/Items`)
      return json({
        TotalRecordCount: 1,
        Items: [
          {
            Id: "metrics-h264",
            Name: "controlled-metrics-h264",
            RunTimeTicks: 20000000,
          },
        ],
      });
    if (
      path === `/Users/${account}/Items/metrics-h264` &&
      faults.metadataFailure
    )
      return response.writeHead(502).end();
    if (path === `/Users/${account}/Items/metrics-h264`)
      return json({
        Id: "metrics-h264",
        MediaSources: [
          {
            Id: "metrics-source",
            MediaStreams: [{ Type: "Audio", Index: 1, Codec: "aac" }],
          },
        ],
      });
    if (path === "/Items/metrics-h264/PlaybackInfo")
      return json({
        PlaySessionId: randomUUID(),
        MediaSources: [
          {
            Id: "metrics-source",
            SupportsDirectPlay: true,
            DefaultAudioStreamIndex: 1,
            TranscodingUrl: `http://${request.headers.host}/Videos/metrics-h264/master.m3u8`,
            RunTimeTicks: 20000000,
            MediaStreams: [{ Type: "Audio", Index: 1, Codec: "aac" }],
          },
        ],
      });
    if (path === "/Videos/metrics-h264/stream.mp4")
      return response
        .writeHead(200, {
          "content-type": "video/mp4",
          "content-length": clip.length,
        })
        .end(clip);
    if (
      path.startsWith("/Sessions/Playing") ||
      path === "/Videos/ActiveEncodings"
    )
      return response.writeHead(204).end();
    response.writeHead(404).end();
  });
  await new Promise((done, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", done),
  );
  const port = server.address().port,
    origin = `http://127.0.0.1:${port}`;
  return {
    policy,
    faults,
    events,
    port,
    config: {
      url: origin,
      token,
      user_id: account,
      access_policy: {
        schema_version: 1,
        origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
      },
    },
    async close() {
      const closed = new Promise((done) => server.close(done));
      server.closeAllConnections();
      await closed;
      assert.equal(await verifyClosedPort(port), true);
    },
  };
}

try {
  await isolatedMediaStack(
    "playback-metrics-runtime",
    async (f) => {
      fixture = f;
      report.fixture = { id: f.id, root: f.root };
      const admin = f.client(),
        identity = await admin.login();
      const clipPath = await f.makeClip("owned-metrics.mp4", {
        pictureSeconds: 2,
      });
      const clip = await readFile(clipPath);
      report.media = {
        generated_owned_h264: true,
        sha256: digest(clip),
        bytes: clip.length,
      };
      await f.startWorker();
      workerPid = f.workerPid;
      workerPort = Number(new URL(f.workerOrigin).port);
      await f.startServer({ WORKER_URL: f.workerOrigin });
      const localSource = async (name = "owned metrics local") => {
        const source = await admin.request("/sources", "POST", {
          name,
          kind: "local",
          config: { root: f.root },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const mediaId = f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND title LIKE '%owned-metrics%'`,
        );
        const media = (await admin.request("/media")).find(
          (m) => m.id === mediaId,
        );
        assert.ok(media, "generated local media discovered through source API");
        return { source, media };
      };
      const local = await localSource();
      const makeRoom = async (media = local.media, name = "metrics scope") => {
        const room = await admin.request("/rooms", "POST", { name });
        const controller = await roomController(f, admin, room);
        await controller.select(media);
        return { room, controller, media };
      };
      const scope = await makeRoom();
      const makeInput = (current = scope, extra = {}) => ({
        room_id: current.room.id,
        media_generation: current.controller.state.media_generation,
        viewer_id: randomUUID(),
        plan_generation: 1,
        idempotency_key: randomUUID(),
        mode: "direct",
        position_ms: 0,
        observation_version: 1,
        playback_metrics_version: 1,
        playback_metrics: {
          meter_start_generation: 1,
          startup_origin: "user_intent",
        },
        ...extra,
      });
      const prepare = async (
        input = makeInput(),
        client = admin,
        expected = 200,
      ) => {
        const plan = await client.request(
          "/playback-sessions",
          "POST",
          input,
          expected,
        );
        if (expected === 200 && input.playback_metrics_version === 1) {
          assert.equal(plan.playback_metrics_version, input.playback_metrics_supported_versions?.includes(2) ? 2 : 1);
          assert.equal(
            plan.playback_metrics.meter_start_generation,
            input.playback_metrics.meter_start_generation,
          );
          assert.equal(
            plan.playback_metrics.startup_origin,
            input.playback_metrics.startup_origin,
          );
          assert.ok(Number.isSafeInteger(plan.playback_metrics.metrics_seq));
          assert.equal(typeof plan.playback_metrics.closed, "boolean");
        }
        return { input, client, plan };
      };
      const post = (grant, packet = sample(grant), status = 200, code) => {
        const pending = grant.client
          .raw(`/playback-sessions/${grant.plan.session_id}/metrics`, {
            method: "POST",
            body: packet,
          })
          .then((r) => checked(r, status, code));
        // Preserve the rejection for the caller while lock-fault cleanup runs.
        pending.catch(() => {});
        return pending;
      };
      const slot = (grant) =>
        JSON.parse(
          f.sql(`SELECT jsonb_build_object('plan',plan_generation,'start',metrics_meter_start_generation,
      'seq',metrics_seq,'closed',metrics_closed,'payload',metrics_payload,'admitted',metrics_admitted_at,
      'anchor_elapsed',metrics_anchor_elapsed_ms,'anchor_received',metrics_anchor_received_at)
      FROM playback_viewer_plans WHERE user_id=${quote(identity.id)} AND room_id=${quote(grant.input.room_id)}
      AND viewer_id=${quote(grant.input.viewer_id)}`),
        );
      const stop = (grant, body) =>
        grant.client.request(
          `/playback-sessions/${grant.plan.session_id}`,
          "DELETE",
          body,
        );
      const check = (name, evidence = {}) => {
        report.checks.push({ name, ...evidence });
        console.log(`PASS: ${name}`);
      };
      const scrape = async () => {
        const response = await admin.raw("/metrics");
        assert.equal(response.status, 200);
        const rows = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("rainsync_client_reported_"));
        const accepted = rows.filter(
          (line) =>
            !line.startsWith("rainsync_client_reported_playback_dropped_total"),
        );
        for (const line of rows) {
          assert.ok(
            !line.includes(identity.id) && !line.includes(scope.room.id),
            "identity is never a label",
          );
          assert.ok(
            Number.isFinite(Number(line.split(" ").at(-1))),
            "finite metric value",
          );
        }
        return {
          rows,
          accepted,
          value: (name, labels = "") => {
            const renderedLabels = labels
              ? `${labels.slice(0, -1)},process="server"}`
              : '{process="server"}';
            return Number(
              rows
                .find((line) => line.startsWith(`${name}${renderedLabels} `))
                ?.split(" ")
                .at(-1) ?? 0,
            );
          },
        };
      };
      const count = (s, origin = "user_intent") =>
        s.value(
          "rainsync_client_reported_playback_samples_total",
          `{origin="${origin}"}`,
        );
      const elapsed = (s, origin = "user_intent") =>
        s.value(
          "rainsync_client_reported_playback_elapsed_milliseconds_total",
          `{origin="${origin}"}`,
        );
      const unchanged = async (grant, beforeSlot, beforeMetrics) => {
        assert.deepEqual(slot(grant), beforeSlot);
        assert.deepEqual((await scrape()).accepted, beforeMetrics.accepted);
      };

      const v2input = (extra = {}) => makeInput(scope, { playback_metrics_supported_versions: [1, 2], ...extra });
      const v2sample = (grant, seq = 1, elapsed = 1000, extra = {}) => sample(grant, seq, elapsed, {
        version: 2,
        startup_phases: { preparation_ms: Math.min(500, elapsed), loading_ms: Math.max(0,elapsed-500), unobserved_ms:0 },
        ...extra,
      });
      const negotiatedV2 = await prepare(v2input());
      assert.equal(f.sql(`SELECT metrics_version FROM playback_viewer_plans WHERE viewer_id=${quote(negotiatedV2.input.viewer_id)}`),"2");
      assert.equal(f.sql(`SELECT metrics_source_kind||':'||metrics_delivery_mode FROM playback_sessions WHERE id=${quote(negotiatedV2.plan.session_id)}`),"local:direct");
      await prepare({...negotiatedV2.input,playback_metrics_supported_versions:[1]},admin,409);
      const initialV2 = v2sample(negotiatedV2);
      const beforeV2 = await scrape();
      await post(negotiatedV2,initialV2);
      await post(negotiatedV2,initialV2);
      assert.equal(count(await scrape())-count(beforeV2),1);
      assert.deepEqual((await prepare(negotiatedV2.input)).plan.playback_metrics.last_sample,initialV2);
      await post(negotiatedV2,v2sample(negotiatedV2,2,2000,{startup_phases:{preparation_ms:499,loading_ms:1501,unobserved_ms:0}}),409,"PLAYBACK_METRICS_CONFLICT");
      await post(negotiatedV2,sample(negotiatedV2,2,2000),400,"PLAYBACK_METRICS_NOT_NEGOTIATED");
      await post(negotiatedV2,v2sample(negotiatedV2,2,2000));
      await stop(negotiatedV2);
      check("negotiated v2 real receiver persists phases/version/server facts, exact retry gives one credit, v1 packet and phase regression reject");

      // The first frame occurs on the first grant, but is first sent on fallback.
      const originGrant = await prepare(v2input());
      const nextInput = { ...originGrant.input, idempotency_key:randomUUID(),plan_generation:2,mode:"remux" };
      const successor = await prepare(nextInput);
      const framePacket = v2sample(successor,1,1000,{
        first_frame:{elapsed_ms:800,confirmed_elapsed_ms:1000,evidence:"video_frame_callback"},
        first_frame_plan_generation:1,
      });
      const frameBefore=await scrape();
      // A live login for the same account is not authority for A's current
      // grant or its historical first-frame attribution. Repeated B reports
      // must not consume A's six-request viewer allowance before admission.
      const otherLogin = f.client();
      assert.equal((await otherLogin.login()).id, identity.id);
      const beforeCrossLogin = slot(successor);
      for (let attempt = 0; attempt < 7; attempt++)
        await post({ ...successor, client: otherLogin }, framePacket, 410, "INVALID_PLAYBACK_SESSION");
      await unchanged(successor, beforeCrossLogin, frameBefore);
      await otherLogin.request(`/playback-sessions/${successor.plan.session_id}`, "DELETE", observation(successor), 410);
      await unchanged(successor, beforeCrossLogin, frameBefore);
      check("same-account B cannot report A's earlier frame on A's current grant, consume A's rate allowance, or Stop A");
      await post(successor,framePacket);
      assert.equal(f.sql(`SELECT metrics_first_frame_source||':'||metrics_first_frame_mode FROM playback_viewer_plans WHERE viewer_id=${quote(successor.input.viewer_id)}`),"local:direct");
      assert.equal(f.sql(`SELECT metrics_delivery_mode FROM playback_sessions WHERE id=${quote(successor.plan.session_id)}`),"remux");
      const attributed=(await scrape()).rows.filter(line=>line.startsWith("rainsync_client_reported_playback_first_frame_attributed_milliseconds_count"));
      assert.ok(attributed.some(line=>line.includes('source="local",mode="direct",evidence="video_frame_callback"')&&line.endsWith(" 1")),JSON.stringify(attributed));
      assert.ok(!attributed.some(line=>line.includes('mode="remux"')));
      await post(originGrant,v2sample(originGrant),410,"INVALID_PLAYBACK_SESSION");
      const later={...framePacket,seq:2,elapsed_ms:2000,totals:totals(1000,{playing_ms:1000})};
      await post(successor,{...later,first_frame_plan_generation:2},409,"PLAYBACK_METRICS_CONFLICT");
      await post(successor,later);
      const afterFrame=await scrape();
      assert.equal(count(afterFrame)-count(frameBefore),2);
      await f.startServer({WORKER_URL:f.workerOrigin});
      scope.controller=await roomController(f,admin,scope.room);
      await post(successor,later);
      assert.equal(count(await scrape()),0);
      assert.deepEqual((await prepare(nextInput)).plan.playback_metrics.last_sample,later);
      const finalV2={...later,seq:3,elapsed_ms:2001,totals:totals(1000,{playing_ms:1001}),final:true};
      await post(successor,finalV2);
      await stop(successor,observation(successor));
      check("earlier v2 frame reported on later remux grant retains direct attribution, no old authority, immutable origin, restart dedup and unchanged Stop");

      const pinnedV1=await prepare();
      const laterV2Offer={...pinnedV1.input,idempotency_key:randomUUID(),plan_generation:2,playback_metrics_supported_versions:[1,2]};
      const pinnedV1Plan=await admin.request("/playback-sessions","POST",laterV2Offer);
      assert.equal(pinnedV1Plan.playback_metrics_version,1);
      assert.equal(f.sql(`SELECT metrics_version FROM playback_viewer_plans WHERE viewer_id=${quote(pinnedV1.input.viewer_id)}`),"1");
      await stop({client:admin,plan:pinnedV1Plan});
      check("first selected version remains frozen across fallback even when a later request offers v2; same-key offer changes conflict");

      const legacyInput = {
        room_id: scope.room.id,
        media_generation: scope.controller.state.media_generation,
        mode: "direct",
        idempotency_key: randomUUID(),
      };
      const legacy = await prepare(legacyInput);
      assert.equal(legacy.plan.playback_metrics_version, undefined);
      assert.equal(legacy.plan.playback_metrics, undefined);
      assert.equal(legacy.plan.plan_generation, undefined);
      const canonical = `{"idempotency_key":null,"room_id":"${legacyInput.room_id}","media_generation":${legacyInput.media_generation},"mode":"direct","position_ms":0.0,"audio_index":null,"capabilities":null}`;
      assert.equal(
        f.sql(
          `SELECT request_hash FROM playback_requests WHERE idempotency_key=${quote(legacyInput.idempotency_key)}`,
        ),
        digest(canonical),
      );
      assert.equal(
        (await prepare(legacyInput)).plan.session_id,
        legacy.plan.session_id,
      );
      await stop(legacy);
      check(
        "legacy omitted fields retain the exact canonical hash, plan and empty final Stop",
      );

      for (const extra of [
        { playback_metrics: undefined },
        { playback_metrics_version: undefined },
        { playback_metrics_version: 2 },
        { viewer_id: undefined, plan_generation: undefined },
        {
          playback_metrics: {
            meter_start_generation: 0,
            startup_origin: "user_intent",
          },
        },
        {
          playback_metrics: {
            meter_start_generation: 2,
            startup_origin: "user_intent",
          },
        },
      ]) {
        const invalid = makeInput(scope, extra);
        const rejected = await prepare(invalid, admin, 400);
        assert.ok(
          [
            "INVALID_PLAYBACK_METRICS",
            "UNSUPPORTED_PLAYBACK_METRICS_VERSION",
          ].includes(rejected.plan.error.code),
        );
        assert.equal(
          f.sql(
            `SELECT count(*) FROM playback_requests WHERE idempotency_key=${quote(invalid.idempotency_key)}`,
          ),
          "0",
        );
      }
      check(
        "metrics negotiation is paired, versioned and requires valid viewer/plan/start generations before preparation",
      );

      const unnegotiated = await prepare(
        makeInput(scope, {
          playback_metrics_version: undefined,
          playback_metrics: undefined,
        }),
      );
      const fabricatedPacket = {
        ...sample({ ...unnegotiated, input: makeInput() }),
      };
      await post(
        unnegotiated,
        fabricatedPacket,
        400,
        "PLAYBACK_METRICS_NOT_NEGOTIATED",
      );
      assert.equal(slot(unnegotiated).start, null);
      await stop(unnegotiated, observation(unnegotiated));
      assert.equal(
        f.sql(
          `SELECT seq FROM playback_observations WHERE session_id=${quote(unnegotiated.plan.session_id)}`,
        ),
        "1",
      );
      check(
        "observation-v1 final DELETE stays independent and unnegotiated grants cannot post metrics",
      );

      const strict = await prepare();
      const strictBefore = slot(strict),
        strictMetrics = await scrape();
      for (const packet of [
        { ...sample(strict), extra: true },
        { ...sample(strict), seq: -1 },
        { ...sample(strict), totals: { ...totals(1000), playing_ms: -1 } },
      ]) {
        const response = await strict.client.raw(
          `/playback-sessions/${strict.plan.session_id}/metrics`,
          { method: "POST", body: packet },
        );
        assert.equal(response.status, 422);
        await response.arrayBuffer();
      }
      await post(
        strict,
        sample(strict, 1, 1000, { totals: totals(999) }),
        400,
        "INVALID_PLAYBACK_METRICS",
      );
      await post(
        strict,
        sample(strict, 1, 604800001),
        400,
        "INVALID_PLAYBACK_METRICS",
      );
      await post(
        strict,
        sample(strict, 9007199254740992),
        400,
        "INVALID_PLAYBACK_METRICS",
      );
      const oversized = await strict.client.raw(
        `/playback-sessions/${strict.plan.session_id}/metrics`,
        {
          method: "POST",
          body: Buffer.from(JSON.stringify(sample(strict)) + " ".repeat(4096)),
        },
      );
      assert.equal(oversized.status, 413);
      await oversized.arrayBuffer();
      await unchanged(strict, strictBefore, strictMetrics);
      await stop(strict);
      check(
        "strict packets reject unknown/unsigned/out-of-horizon/nonconserving/oversized input without durable or aggregate credit",
      );

      const failedInput = makeInput(scope, { audio_index: 999 });
      const failed = await prepare(failedInput, admin, 400);
      assert.equal(failed.plan.error.code, "INVALID_AUDIO_TRACK");
      const fakeScope = { input: failedInput };
      const failedSlot = slot(fakeScope);
      assert.equal(failedSlot.seq, 0);
      assert.equal(failedSlot.start, 1);
      assert.equal(failedSlot.closed, false);
      const fallback = await prepare({
        ...failedInput,
        audio_index: undefined,
        plan_generation: 2,
        idempotency_key: randomUUID(),
      });
      assert.equal(fallback.plan.playback_metrics.metrics_seq, 0);
      assert.equal(slot(fallback).admitted, failedSlot.admitted);
      await post(fallback);
      await stop(fallback);
      check(
        "failed preparation retains an unsampled meter and higher-plan fallback admits its first sample",
      );

      const sequences = await prepare(),
        first = sample(sequences, 3),
        before = await scrape();
      const receipts = await Promise.all([
        post(sequences, first),
        post(sequences, { ...first }),
      ]);
      assert.deepEqual(receipts[0], receipts[1]);
      assert.equal(slot(sequences).seq, 3);
      const after = await scrape();
      assert.equal(count(after) - count(before), 1);
      assert.equal(elapsed(after) - elapsed(before), 1000);
      const savedSeq = slot(sequences);
      await post(
        sequences,
        sample(sequences, 3, 1001),
        409,
        "PLAYBACK_METRICS_CONFLICT",
      );
      await post(
        sequences,
        sample(sequences, 2),
        409,
        "PLAYBACK_METRICS_SEQUENCE_STALE",
      );
      await unchanged(sequences, savedSeq, after);
      await post(sequences, sample(sequences, 7, 2000));
      assert.equal(slot(sequences).seq, 7);
      await stop(sequences);
      check(
        "concurrent equal-sequence replay credits once; conflict/stale reject and sequence gaps commit",
      );

      const conservation = await prepare();
      await post(
        conservation,
        sample(conservation, 1, 1000, {
          totals: totals(0, { playing_ms: 1000 }),
        }),
      );
      const beforeConservation = slot(conservation),
        conservationMetrics = await scrape();
      await post(
        conservation,
        sample(conservation, 2, 2000, {
          totals: totals(1100, { playing_ms: 900 }),
        }),
        409,
        "PLAYBACK_METRICS_CONFLICT",
      );
      await post(
        conservation,
        sample(conservation, 2, 1999, {
          totals: totals(0, { playing_ms: 1999 }),
        }),
        429,
        "RATE_LIMITED",
      );
      await unchanged(conservation, beforeConservation, conservationMetrics);
      await stop(conservation);
      check(
        "cumulative category regression and sub-1000ms nonfinal deltas reject without credit",
      );

      const framed = await prepare(),
        frame = {
          elapsed_ms: 0,
          confirmed_elapsed_ms: 100,
          evidence: "video_frame_callback",
        };
      const frameCountName =
        "rainsync_client_reported_playback_first_frame_elapsed_milliseconds_count";
      const frameLabels =
        '{origin="user_intent",evidence="video_frame_callback"}';
      const beforeFrameCount = (await scrape()).value(
        frameCountName,
        frameLabels,
      );
      await post(framed, sample(framed, 1, 100000, { first_frame: frame }));
      const anchor = slot(framed);
      await post(framed, sample(framed, 2, 101000, { first_frame: frame }));
      const seq2 = slot(framed),
        frameMetrics = await scrape();
      assert.equal(
        frameMetrics.value(frameCountName, frameLabels) - beforeFrameCount,
        1,
      );
      assert.equal(seq2.anchor_elapsed, anchor.anchor_elapsed);
      assert.equal(seq2.anchor_received, anchor.anchor_received);
      for (const packet of [
        sample(framed, 3, 102000),
        sample(framed, 3, 102000, {
          first_frame: { ...frame, confirmed_elapsed_ms: 101 },
        }),
      ])
        await post(framed, packet, 409, "PLAYBACK_METRICS_CONFLICT");
      await post(
        framed,
        sample(framed, 3, 160000, { first_frame: frame }),
        409,
        "PLAYBACK_METRICS_TIME_INVALID",
      );
      await unchanged(framed, seq2, frameMetrics);
      await stop(framed);
      check(
        "initial prefix is bounded client data; seq2 keeps a fixed anchor and immutable first frame; anchor allowance is never renewed",
      );

      const zero = await prepare(
        makeInput(scope, {
          playback_metrics: {
            meter_start_generation: 1,
            startup_origin: "automatic_load",
          },
        }),
      );
      const zeroBefore = await scrape();
      await post(
        zero,
        sample(zero, 1, 0, {
          first_frame: {
            elapsed_ms: 0,
            confirmed_elapsed_ms: 0,
            evidence: "playing_time_advance",
          },
        }),
      );
      const zeroAfter = await scrape();
      assert.equal(
        count(zeroAfter, "automatic_load") -
          count(zeroBefore, "automatic_load"),
        1,
      );
      assert.equal(
        elapsed(zeroAfter, "automatic_load") -
          elapsed(zeroBefore, "automatic_load"),
        0,
      );
      assert.equal(
        zeroAfter.value(
          "rainsync_client_reported_playback_first_frame_elapsed_milliseconds_count",
          '{origin="automatic_load",evidence="playing_time_advance"}',
        ),
        1,
      );
      await stop(zero);
      check(
        "measured zero and zero first-frame evidence are counted separately from absent samples, with fixed origin/evidence labels",
      );

      const closed = await prepare();
      await post(closed);
      const final = sample(closed, 2, 1000, { final: true });
      await post(closed, final);
      const closedSlot = slot(closed),
        closedMetrics = await scrape();
      assert.equal(closedSlot.closed, true);
      await post(closed, final);
      await post(
        closed,
        sample(closed, 3, 2000),
        409,
        "PLAYBACK_METRICS_CLOSED",
      );
      const closedReplay = (await prepare(closed.input)).plan;
      assert.equal(closedReplay.playback_metrics.closed, true);
      assert.equal(closedReplay.playback_metrics.metrics_seq, 2);
      assert.deepEqual(closedReplay.playback_metrics.last_sample, final);
      await unchanged(closed, closedSlot, closedMetrics);
      await stop(closed);
      await post(closed, final, 410, "INVALID_PLAYBACK_SESSION");
      check(
        "one zero-delta final closes durably; exact authorized replay and same-key plan refresh never reopen or recredit it",
      );

      const continuing = await prepare();
      await post(continuing);
      const finalOldObservation = observation(continuing);
      await continuing.client.request(
        `/playback-sessions/${continuing.plan.session_id}/observations`,
        "POST",
        finalOldObservation,
      );
      const continuingAnchor = slot(continuing);
      const next = await prepare({
        ...continuing.input,
        plan_generation: 2,
        idempotency_key: randomUUID(),
      });
      assert.equal(next.plan.playback_metrics.metrics_seq, 1);
      assert.equal(slot(next).admitted, continuingAnchor.admitted);
      const nextBefore = slot(next),
        nextMetrics = await scrape();
      await post(
        continuing,
        sample(continuing, 2, 2000),
        410,
        "INVALID_PLAYBACK_SESSION",
      );
      await unchanged(next, nextBefore, nextMetrics);
      await post(next, sample(next, 2, 2000));
      assert.equal(
        slot(next).anchor_received,
        continuingAnchor.anchor_received,
      );
      check(
        "a higher plan continues one meter, while late old-grant samples cannot mutate the continuing slot",
      );
      await stop(continuing, finalOldObservation);
      await f.waitForSql(
        `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id=${quote(continuing.plan.session_id)}`,
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT seq FROM playback_observations WHERE session_id=${quote(continuing.plan.session_id)}`,
        ),
        "1",
      );
      assert.equal(
        f.sql(
          `SELECT stopped FROM playback_sessions WHERE id=${quote(next.plan.session_id)}`,
        ),
        "f",
      );
      await stop(next);
      check(
        "owned old observation-v1 final Stop still succeeds after a new plan and preserves successor ownership",
      );

      const replaced = await prepare();
      await post(replaced);
      const replacement = await prepare({
        ...replaced.input,
        plan_generation: 2,
        idempotency_key: randomUUID(),
        playback_metrics: {
          meter_start_generation: 2,
          startup_origin: "automatic_load",
        },
      });
      const replacedSlot = slot(replacement);
      assert.equal(replacedSlot.seq, 0);
      assert.equal(replacedSlot.start, 2);
      assert.equal(replacedSlot.anchor_received, null);
      const resurrection = await prepare(
        {
          ...replaced.input,
          plan_generation: 3,
          idempotency_key: randomUUID(),
        },
        admin,
        409,
      );
      assert.equal(resurrection.plan.error.code, "STALE_PLAYBACK_METRICS");
      assert.deepEqual(slot(replacement), replacedSlot);
      await stop(replacement);
      check(
        "a newer meter replaces the single slot; an older descriptor cannot resurrect it or advance high-water on rejected admission",
      );

      const omitted = await prepare();
      await post(omitted);
      const omissionInput = {
        ...omitted.input,
        plan_generation: 2,
        idempotency_key: randomUUID(),
        playback_metrics_version: undefined,
        playback_metrics: undefined,
      };
      const omission = await prepare(omissionInput);
      const omittedSlot = slot(omission);
      assert.equal(omittedSlot.closed, true);
      assert.equal(omission.plan.playback_metrics, undefined);
      await prepare(omissionInput);
      assert.equal(
        (
          await prepare(
            {
              ...omitted.input,
              plan_generation: 3,
              idempotency_key: randomUUID(),
            },
            admin,
            409,
          )
        ).plan.error.code,
        "PLAYBACK_METRICS_CLOSED",
      );
      assert.deepEqual(slot(omission), omittedSlot);
      await stop(omission);
      check(
        "omitting metrics on a higher plan closes the prior slot without a final sample; retries and old descriptors cannot reopen it",
      );

      const rollback = await prepare(),
        rollbackSlot = slot(rollback),
        rollbackMetrics = await scrape();
      f.sql(
        `ALTER TABLE playback_viewer_plans ADD CONSTRAINT reject_owned_metrics_commit CHECK (viewer_id<>${quote(rollback.input.viewer_id)} OR metrics_seq=0) NOT VALID`,
      );
      try {
        await post(rollback, sample(rollback), 500, "DATABASE_ERROR");
        await unchanged(rollback, rollbackSlot, rollbackMetrics);
      } finally {
        f.sql(
          "ALTER TABLE playback_viewer_plans DROP CONSTRAINT reject_owned_metrics_commit",
        );
      }
      await post(rollback);
      assert.equal(count(await scrape()) - count(rollbackMetrics), 1);
      await stop(rollback);
      check(
        "actual PostgreSQL write failure rolls back payload/anchor/seq and emits no credit; retry commits once",
      );

      const rateGrant = await prepare(),
        ratePacket = sample(rateGrant);
      for (let i = 0; i < 6; i++) await post(rateGrant, ratePacket);
      const rateSlot = slot(rateGrant),
        rateMetrics = await scrape();
      await post(rateGrant, ratePacket, 429, "RATE_LIMITED");
      await unchanged(rateGrant, rateSlot, rateMetrics);
      const independent = await prepare();
      await post(independent);
      await stop(independent);
      await stop(rateGrant);
      check(
        "six requests per viewer window includes duplicate replays; the seventh is bounded and independent viewers remain admitted",
      );

      const expired = await prepare(),
        expiredSlot = slot(expired),
        expiryMetrics = await scrape();
      f.sql(
        `UPDATE playback_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${quote(expired.plan.session_id)}`,
      );
      await post(expired, sample(expired), 410, "INVALID_PLAYBACK_SESSION");
      await unchanged(expired, expiredSlot, expiryMetrics);
      check(
        "expired current grants reject without durable or aggregate changes",
      );

      const mediaScope = await makeRoom(),
        oldMedia = await prepare(makeInput(mediaScope));
      const oldMediaSlot = slot(oldMedia),
        mediaMetrics = await scrape();
      await mediaScope.controller.select(local.media);
      const response = await oldMedia.client.raw(
        `/playback-sessions/${oldMedia.plan.session_id}/metrics`,
        { method: "POST", body: sample(oldMedia) },
      );
      assert.ok([409, 410].includes(response.status));
      await response.arrayBuffer();
      await unchanged(oldMedia, oldMediaSlot, mediaMetrics);
      check(
        "public media change fences the old media generation without inventing a new sample",
      );

      const epochScope = await makeRoom(),
        epochGrant = await prepare(makeInput(epochScope));
      const epochSlot = slot(epochGrant),
        epochMetrics = await scrape();
      f.sql(
        `UPDATE rooms SET lifecycle_epoch=lifecycle_epoch+1 WHERE id=${quote(epochScope.room.id)}`,
      );
      await post(epochGrant, sample(epochGrant), 409, "STALE_PLAYBACK_METRICS");
      await unchanged(epochGrant, epochSlot, epochMetrics);
      check(
        "lifecycle epoch changes fence an otherwise owned grant and retain meter high-water",
      );

      const authGrant = await prepare(),
        authSlot = slot(authGrant),
        authMetrics = await scrape();
      await checked(
        await admin.raw(
          `/playback-sessions/${authGrant.plan.session_id}/metrics`,
          {
            method: "POST",
            body: sample(authGrant),
            headers: { "x-csrf-token": "invalid" },
          },
        ),
        403,
        "CSRF_REJECTED",
      );
      const unauthenticated = f.client();
      await checked(
        await unauthenticated.raw(
          `/playback-sessions/${authGrant.plan.session_id}/metrics`,
          {
            method: "POST",
            body: sample(authGrant),
          },
        ),
        401,
        "LOGIN_REQUIRED",
      );
      const otherName = `metrics-viewer-${randomUUID().slice(0, 8)}`;
      await admin.request("/users", "POST", {
        username: otherName,
        password: f.password,
      });
      const otherUser = f.client();
      await otherUser.login(otherName);
      await checked(
        await otherUser.raw(
          `/playback-sessions/${authGrant.plan.session_id}/metrics`,
          {
            method: "POST",
            body: sample(authGrant),
          },
        ),
        410,
        "INVALID_PLAYBACK_SESSION",
      );
      await unchanged(authGrant, authSlot, authMetrics);
      await stop(authGrant);
      check(
        "authentication, authenticated ownership and CSRF fences reject before meter mutation or accepted credit",
      );

      const sourceLocal = await localSource("owned source fence"),
        sourceScope = await makeRoom(sourceLocal.media);
      const sourceGrant = await prepare(makeInput(sourceScope)),
        sourceSlot = slot(sourceGrant),
        sourceMetrics = await scrape();
      // Use another real server-encrypted generated configuration. Appending a
      // byte would test corrupt ciphertext and correctly prevent later restart.
      const rotatedSource = await localSource("owned source revision ciphertext");
      const heldSource = await lock(
        f,
        `UPDATE sources SET config_encrypted=(SELECT config_encrypted FROM sources WHERE id=${quote(rotatedSource.source.id)}) WHERE id=${quote(sourceLocal.source.id)}`,
      );
      try {
        const pending = post(
          sourceGrant,
          sample(sourceGrant),
          410,
          "INVALID_PLAYBACK_SESSION",
        );
        await waiting(f, "FROM sources WHERE id=$1 FOR SHARE");
        await heldSource.finish();
        await pending;
      } finally {
        await heldSource.finish(false);
      }
      await unchanged(sourceGrant, sourceSlot, sourceMetrics);
      check(
        "actual contended source lock rechecks committed access revision before accepting a packet",
      );

      const memberScope = await makeRoom(),
        memberGrant = await prepare(makeInput(memberScope));
      const memberSlot = slot(memberGrant),
        memberMetrics = await scrape();
      const heldMember = await lock(
        f,
        `DELETE FROM room_members WHERE room_id=${quote(memberScope.room.id)} AND user_id=${quote(identity.id)}`,
      );
      try {
        const pending = post(
          memberGrant,
          sample(memberGrant),
          403,
          "NOT_A_MEMBER",
        );
        await waiting(f, "FROM room_members WHERE room_id=$1");
        await heldMember.finish();
        await pending;
      } finally {
        await heldMember.finish(false);
      }
      await unchanged(memberGrant, memberSlot, memberMetrics);
      check(
        "actual contended membership removal is rechecked after its lock and rejects without credit",
      );

      const lockExpiry = await prepare(),
        expirySlot = slot(lockExpiry),
        lockExpiryMetrics = await scrape();
      f.sql(
        `UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=${quote(lockExpiry.plan.session_id)}`,
      );
      const heldExpiry = await lock(
        f,
        `SELECT id FROM playback_sessions WHERE id=${quote(lockExpiry.plan.session_id)} FOR UPDATE`,
      );
      try {
        const pending = post(
          lockExpiry,
          sample(lockExpiry),
          410,
          "INVALID_PLAYBACK_SESSION",
        );
        await waiting(f, "SELECT * FROM playback_sessions WHERE id=$1");
        await until(
          () =>
            f.sql(
              `SELECT expires_at<=clock_timestamp() FROM playback_sessions WHERE id=${quote(lockExpiry.plan.session_id)}`,
            ) === "t",
          "expiry passes while lock held",
          450,
        );
        await heldExpiry.finish();
        await pending;
      } finally {
        await heldExpiry.finish(false);
      }
      await unchanged(lockExpiry, expirySlot, lockExpiryMetrics);
      check(
        "grant expiry is evaluated after a real contended session lock, using current database time",
      );

      const authenticationRaces = [];
      for (const invalidation of ["expiry", "logout"]) {
        const currentLogin = f.client();
        await currentLogin.login();
        const loginHash = digest(currentLogin.cookie.split("=")[1]);
        assert.equal(
          f.sql(
            `SELECT count(*) FROM sessions WHERE token_hash=${quote(loginHash)}`,
          ),
          "1",
        );
        const loginGrant = await prepare(makeInput(), currentLogin);
        const loginSlot = slot(loginGrant),
          loginMetrics = await scrape();
        const heldLogin = await lock(
          f,
          invalidation === "logout"
            ? `SELECT id FROM rooms WHERE id=${quote(loginGrant.input.room_id)} FOR NO KEY UPDATE`
            : `SELECT id FROM playback_sessions WHERE id=${quote(loginGrant.plan.session_id)} FOR UPDATE`,
        );
        try {
          if (invalidation === "expiry")
            f.sql(
              `UPDATE sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=${quote(loginHash)}`,
            );
          const pending = post(
            loginGrant,
            sample(loginGrant),
            invalidation === "logout" ? 401 : 410,
            invalidation === "logout" ? "SESSION_EXPIRED" : "INVALID_PLAYBACK_SESSION",
          );
          await waiting(f, invalidation === "logout" ? "FROM rooms WHERE id=$1 FOR NO KEY UPDATE" : "SELECT * FROM playback_sessions WHERE id=$1");
          if (invalidation === "logout") {
            await currentLogin.request("/auth/logout", "POST");
            assert.equal(
              f.sql(
                `SELECT count(*) FROM sessions WHERE token_hash=${quote(loginHash)}`,
              ),
              "0",
            );
          } else {
            await until(
              () =>
                f.sql(
                  `SELECT expires_at<=clock_timestamp() FROM sessions WHERE token_hash=${quote(loginHash)}`,
                ) === "t",
              "current authentication session expires during grant lock wait",
              450,
            );
          }
          await heldLogin.finish();
          await pending;
        } finally {
          await heldLogin.finish(false);
        }
        await unchanged(loginGrant, loginSlot, loginMetrics);
        await admin.request(`/playback-sessions/${loginGrant.plan.session_id}`, "DELETE", undefined, 410);
        // Cleanup belongs to server retirement, not another login pretending to
        // be the origin. The revoked caller must not lose cleanup responsibility.
        await f.waitForSql(`SELECT stopped FROM playback_sessions WHERE id=${quote(loginGrant.plan.session_id)}`, "t", 8000);

        authenticationRaces.push({
          invalidation,
          actual_authority_lock_wait: invalidation === "logout" ? "room" : "grant",
          metrics_status: invalidation === "logout" ? 401 : 410,
          server_retirement_observed: true,
          durable_and_aggregate_credit: false,
        });
      }
      check(
        "current login expiry and public logout during real authority-lock waits reject metrics without credit; server retires the grant",
        { variants: authenticationRaces },
      );

      const timeoutGrant = await prepare(),
        timeoutSlot = slot(timeoutGrant),
        timeoutMetrics = await scrape();
      const heldTimeout = await lock(
        f,
        `SELECT * FROM playback_viewer_plans WHERE viewer_id=${quote(timeoutGrant.input.viewer_id)} FOR UPDATE`,
      );
      try {
        const started = Date.now();
        // The receiver's 500 ms lock_timeout raises SQLSTATE 55P03, which
        // the Server classifies as transient contention. The CHECK-constraint
        // rollback fixture above remains a distinct 500 DATABASE_ERROR.
        const rejection = await post(timeoutGrant, sample(timeoutGrant), 503, "SERVICE_UNAVAILABLE");
        report.lock_timeout_response = {
          status: 503,
          error_code: rejection.error.code,
          retryable: rejection.error.retryable,
          elapsed_ms: Date.now() - started,
        };
        assert.equal(rejection.error.retryable, true);
        assert.ok(report.lock_timeout_response.elapsed_ms < 3500, "whole request remains bounded");
        await unchanged(timeoutGrant, timeoutSlot, timeoutMetrics);
        const aborted = admin
          .raw(`/playback-sessions/${timeoutGrant.plan.session_id}/metrics`, {
            method: "POST",
            body: sample(timeoutGrant),
            signal: AbortSignal.timeout(100),
          })
          .then(
            () => false,
            () => true,
          );
        assert.equal(await aborted, true);
        await until(
          () =>
            f.sql(
              "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND application_name NOT LIKE 'metrics_lock_%'",
            ) === "0",
          "cancelled/timeout queries release locks",
          2000,
        );
      } finally {
        await heldTimeout.finish(false);
      }
      await unchanged(timeoutGrant, timeoutSlot, timeoutMetrics);
      await post(timeoutGrant);
      await stop(timeoutGrant);
      assert.equal(
        f.sql(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
        ),
        "0",
      );
      check(
        "lock timeouts and client cancellation are bounded, roll back, release locks/pool state, and permit subsequent real work",
      );

      controlled = await controlledJellyfin(clip);
      const upstreamSource = await admin.request("/sources", "POST", {
        name: "controlled metrics account",
        kind: "jellyfin",
        config: controlled.config,
      });
      await admin.request(`/sources/${upstreamSource.id}/test`, "POST");
      const upstreamMediaId = f.sql(
        `SELECT id FROM media_items WHERE source_id=${quote(upstreamSource.id)}`,
      );
      const upstreamMedia = (await admin.request("/media")).find(
        (m) => m.id === upstreamMediaId,
      );
      assert.ok(upstreamMedia);
      const upstreamScope = await makeRoom(upstreamMedia);
      const upstreamInput = makeInput(upstreamScope, { audio_index: 1 });
      controlled.faults.metadataFailure = true;
      const transient = await prepare(upstreamInput, admin, 502);
      assert.equal(transient.plan.error.code, "UPSTREAM_PLAYBACK_FAILED");
      const admitted = slot(transient);
      assert.equal(admitted.seq, 0);
      controlled.faults.metadataFailure = false;
      const upstreamGrant = await prepare(upstreamInput);
      assert.equal(slot(upstreamGrant).admitted, admitted.admitted);
      assert.equal(
        f.sql(
          `SELECT attempt FROM playback_requests WHERE idempotency_key=${quote(upstreamInput.idempotency_key)}`,
        ),
        "2",
      );
      const grantedGeneration = f.sql(
        `SELECT resource->>'account_policy_generation' FROM playback_sessions WHERE id=${quote(upstreamGrant.plan.session_id)}`,
      );
      assert.ok(Number(grantedGeneration) > 0);
      await post(upstreamGrant);
      const upstreamSlot = slot(upstreamGrant),
        upstreamMetrics = await scrape();
      const sourceRevision = f.sql(
        `SELECT access_policy_revision FROM sources WHERE id=${quote(upstreamSource.id)}`,
      );
      controlled.policy.EnableMediaPlayback = false;
      await f.waitForSql(
        `SELECT state FROM source_account_policies WHERE source_id=${quote(upstreamSource.id)}`,
        "denied",
        8000,
      );
      assert.equal(
        f.sql(
          `SELECT access_policy_revision FROM sources WHERE id=${quote(upstreamSource.id)}`,
        ),
        sourceRevision,
      );
      assert.ok(
        Number(
          f.sql(
            `SELECT generation FROM source_account_policies WHERE source_id=${quote(upstreamSource.id)}`,
          ),
        ) > Number(grantedGeneration),
      );
      await post(
        upstreamGrant,
        sample(upstreamGrant, 2, 2000),
        410,
        "INVALID_PLAYBACK_SESSION",
      );
      await unchanged(upstreamGrant, upstreamSlot, upstreamMetrics);
      await stop(upstreamGrant);
      await f.waitForSql(
        `SELECT state FROM upstream_reservations WHERE id=${quote(upstreamGrant.plan.session_id)}`,
        "closed",
        10000,
      );
      check(
        "controlled Jellyfin same-key transient retry preserves its meter; observed account-generation denial revokes the real grant without changing source revision",
        {
          account_policy_protocol: "controlled",
          policy_reads: controlled.events.filter((e) =>
            /^\/Users\/[^/]+$/.test(e.path),
          ).length,
        },
      );
      report.controlled_upstream_events = controlled.events;
      await controlled.close();
      controlled = undefined;

      const restart = await prepare(),
        restartPacket = sample(restart, 1, 5000);
      await post(restart, restartPacket);
      const restartSlot = slot(restart);
      for (const socket of sockets) socket.terminate();
      await f.startServer({ WORKER_URL: f.workerOrigin });
      const resetMetrics = await scrape();
      assert.equal(count(resetMetrics), 0);
      await post(restart, restartPacket);
      assert.equal(count(await scrape()), 0);
      assert.deepEqual(slot(restart), restartSlot);
      const replay = (await prepare(restart.input)).plan;
      assert.equal(replay.playback_metrics.metrics_seq, 1);
      assert.deepEqual(replay.playback_metrics.last_sample, restartPacket);
      await post(restart, sample(restart, 2, 6000));
      assert.equal(count(await scrape()), 1);
      assert.equal(elapsed(await scrape()), 1000);
      assert.equal(slot(restart).anchor_received, restartSlot.anchor_received);
      await stop(restart);
      check(
        "real Server restart retains dedup/payload/fixed anchor; replay gives no new process credit and next packet credits only its delta",
      );

      const racing = await prepare(),
        finalObservation = observation(racing);
      const holder = await lock(
        f,
        `SELECT id FROM rooms WHERE id=${quote(racing.input.room_id)} FOR NO KEY UPDATE`,
      );
      let lateFinal;
      try {
        const stopping = stop(racing, finalObservation);
        await waiting(f, "FROM rooms WHERE id=$1 FOR NO KEY UPDATE");
        lateFinal = post(
          racing,
          sample(racing, 1, 1000, { final: true }),
          410,
          "INVALID_PLAYBACK_SESSION",
        );
        await delay(30);
        const released = Date.now();
        await holder.finish();
        await stopping;
        assert.ok(
          Date.now() - released < 1500,
          "owned Stop releases without waiting for final-metrics delivery",
        );
        await lateFinal;
      } finally {
        await holder.finish(false);
      }
      assert.equal(
        f.sql(
          `SELECT stopped FROM playback_sessions WHERE id=${quote(racing.plan.session_id)}`,
        ),
        "t",
      );
      assert.equal(
        f.sql(
          `SELECT seq FROM playback_observations WHERE session_id=${quote(racing.plan.session_id)}`,
        ),
        "1",
      );
      assert.equal(slot(racing).seq, 0);
      check(
        "a real final-metrics/owned Stop race can lose the exact final packet while observation-v1 cleanup completes promptly",
      );

      // No telemetry rate-limit configuration is changed: distinct real viewers
      // exercise the 32 global permits while a public room authority is locked.
      const capacityGrants = [];
      for (let i = 0; i < 36; i++) capacityGrants.push(await prepare());
      const capacityBefore = await scrape();
      const capacityHolder = await lock(
        f,
        `SELECT id FROM rooms WHERE id=${quote(scope.room.id)} FOR NO KEY UPDATE`,
      );
      try {
        const requests = capacityGrants.map(async (grant) => {
          const response = await grant.client.raw(
            `/playback-sessions/${grant.plan.session_id}/metrics`,
            { method: "POST", body: sample(grant) },
          );
          const body = await response.json();
          return { status: response.status, code: body.error?.code, retryable: body.error?.retryable };
        });
        const responses = await Promise.all(requests);
        assert.ok(
          responses.filter(
            (r) => r.status === 503 && r.code === "SERVICE_UNAVAILABLE",
          ).length >= 4,
          "36 concurrent requests exceed 32 in-flight permits",
        );
        assert.ok(
          responses.every((r) => r.status === 503 && r.code === "SERVICE_UNAVAILABLE" && r.retryable === true),
          JSON.stringify(responses),
        );
        for (const grant of capacityGrants) assert.equal(slot(grant).seq, 0);
        assert.deepEqual((await scrape()).accepted, capacityBefore.accepted);
        report.capacity_responses = responses;
      } finally {
        await capacityHolder.finish(false);
      }
      for (const grant of capacityGrants) await stop(grant);
      const recovery = await prepare();
      await post(recovery);
      await stop(recovery);
      check(
        "36 actual concurrent requests enforce the 32 in-flight bound with no locked-request credit and recover cleanly",
      );

      await verifyBinding();
      report.result = "passed";
      await f.stopWorker();
    },
    { env: { PLAYBACK_SESSION_LIMIT: "128" } },
  );
} catch (error) {
  primaryError = error;
  report.result = "failed";
  report.error = error.stack ?? String(error);
} finally {
  const cleanupErrors = [];
  const cleanup = async action => {
    try { await action(); }
    catch (error) { cleanupErrors.push(error.stack ?? String(error)); }
  };
  for (const socket of sockets) await cleanup(() => socket.terminate());
  if (controlled) {
    report.controlled_upstream_events = controlled.events;
    await cleanup(() => controlled.close());
  }
  if (fixture) {
    report.postgres = fixture.postgresDiagnostics();
    await cleanup(async () => { report.cleanup = await fixture.verifyStopped(); });
  }
  report.cleanup ??= {};
  report.cleanup.worker = { state: workerPid === undefined ? "never_started" : "unknown", pid: workerPid ?? null, port: workerPort ?? null };
  if (workerPid !== undefined) await cleanup(async () => {
    report.cleanup.worker.pid_absent = verifyPidAbsent(workerPid);
    report.cleanup.worker.state = report.cleanup.worker.pid_absent ? "pid_absent" : "still_present";
    assert.equal(report.cleanup.worker.pid_absent, true);
  });
  if (workerPort !== undefined) await cleanup(async () => {
    report.cleanup.worker.port_closed = await verifyClosedPort(workerPort);
    assert.equal(report.cleanup.worker.port_closed, true);
  });
  if (cleanupErrors.length) {
    report.cleanup_errors = cleanupErrors;
    report.result = "failed";
    primaryError ??= new Error("Owned metrics fixture cleanup failed; inspect separate cleanup_errors");
  }
  report.completed_at = new Date().toISOString();
  report.check_count = report.checks.length;
  const root = fixture?.root ?? resolve(process.env.RAINSYNC_ARTIFACT_DIR, "playback-metrics-runtime", randomUUID());
  await mkdir(root, { recursive: true });
  const path = resolve(root, "report.json");
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
  console.log(`Evidence: ${path}`);
}
if (primaryError) throw primaryError;
