// Actual frontend runtime/sampler/sender against an owned PostgreSQL/Server/Worker.
// The element and media events are synthetic: this is HTTP integration evidence,
// never browser decoding, frame presentation, or screen display evidence.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { effectScope, ref, watch } from "vue";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingPath =
  process.env.RAINSYNC_PLAYBACK_METRICS_BINDING ??
  process.env.W03_BACKEND_BINDING;
assert.ok(bindingPath, "A frozen backend binding is required; never builds");
assert.ok(
  process.env.RAINSYNC_ARTIFACT_DIR,
  "An external artifact root is required",
);
const bindingBytes = await readFile(bindingPath);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.equal(binding.build.exit_code, 0);
assert.equal(digest(JSON.stringify(binding.source)), binding.source_digest);
for (const name of ["rainsync-server", "rainsync-media-worker"])
  assert.equal(
    resolve(binding.binaries.find((entry) => entry.name === name).path),
    resolve(process.env.CARGO_TARGET_DIR, "debug", name),
  );
const frontendInputs = [
  "apps/web/src/features/playback/metrics-sender.ts",
  "apps/web/src/features/playback/playback-metrics.ts",
  "apps/web/src/features/playback/metrics-binding.ts",
  "apps/web/src/features/playback/playback-runtime.ts",
  "apps/web/src/features/playback/playback-session-controller.ts",
  "apps/web/src/features/playback/hls-driver-loader.ts",
  "apps/web/src/features/playback/drivers/hls-driver.ts",
  "apps/web/src/features/playback/drivers/native-driver.ts",
  "apps/web/src/features/playback/dash-driver-loader.ts",
  "apps/web/src/features/playback/drivers/dash-driver.ts",
  "packages/player-core/dash.ts",
  "packages/player-core/dash/loader.ts",
  "packages/player-core/dash/manifest.ts",
  "packages/player-core/dash/segment-base.ts",
  "apps/web/src/features/playback/room-p2p-loader.ts",
  "apps/web/src/features/playback/playback-runtime-types.ts",
  "apps/web/src/features/playback/playback-scope.ts",
  "apps/web/src/features/playback/playback-metric-runtime.ts",
  "apps/web/src/features/playback/playback-candidate-discovery.ts",
  "apps/web/src/features/playback/platform-text-runtime.ts",
  "apps/web/src/features/playback/live-window-recovery.ts",
  "apps/web/src/shared/action-error.ts",
  "apps/web/src/errors.ts",
  "apps/web/src/playback-request.ts",
  "tests/playback-metrics-wire.mjs",
  "tests/fixtures/media-stack.mjs",
  "tests/fixtures/server.mjs",
  "tests/fixtures/postgres.mjs",
];
const coordinator = await Promise.all(
  frontendInputs.map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
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
  scope:
    "Actual Vite SSR-loaded frontend runtime, sampler, media-event binding and sender, real public HTTP negotiation/POST/Stop, owned native PostgreSQL and frozen Server/Worker, generated H264 local source. Synthetic media events and controlled lost/delayed ACK transport faults; no browser decoding or presentation claim.",
  backend_binding: {
    path: resolve(bindingPath),
    sha256: digest(bindingBytes),
    source_digest: binding.source_digest,
    binaries: binding.binaries,
  },
  coordinator,
  checks: [],
};
const sockets = new Set();
const senders = new Set();
let vite, fixture, scope, workerPid, workerPort, releaseFinal;
const globals = new Map();
function setGlobal(name, value) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}
async function until(probe, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(20);
  }
  throw Error(`Deadline: ${label}`);
}
function check(name, evidence = {}) {
  report.checks.push({ name, ...evidence });
  console.log(`PASS: ${name}`);
}
async function controller(f, client, room) {
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
    until(
      () => {
        const index = frames.findIndex(predicate);
        return index < 0 ? undefined : frames.splice(index, 1)[0];
      },
      "public room command",
      5000,
    );
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next((frame) => frame.type === "SNAPSHOT");
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
      let answer = await next(
        (frame) => frame.command_id === command.command_id,
      );
      if (
        answer.type === "ERROR" &&
        answer.control_epoch &&
        ["CONTROL_EPOCH_EXPIRED", "CONTROL_EPOCH_REQUIRED"].includes(
          answer.error?.code,
        )
      ) {
        epoch = answer.control_epoch.id;
        ws.send(JSON.stringify({ ...command, control_epoch: epoch }));
        answer = await next((frame) => frame.command_id === command.command_id);
      }
      assert.equal(answer.type, "ACK", JSON.stringify(answer));
      state = answer.state;
      return state;
    },
  };
}
function syntheticVideo() {
  const callbacks = new Map();
  let nextFrameId = 0;
  const el = Object.assign(new EventTarget(), {
    src: "",
    readyState: 4,
    paused: true,
    seeking: false,
    currentTime: 0,
    duration: 60,
    ended: false,
    playbackRate: 1,
    buffered: { length: 0 },
    seekable: { length: 0 },
    querySelectorAll: () => [],
    canPlayType: () => "probably",
    load() {},
    getAttribute: (name) => (name === "src" ? el.src : null),
    removeAttribute(name) {
      if (name === "src") el.src = "";
    },
    pause() {
      el.paused = true;
      el.dispatchEvent(new Event("pause"));
    },
    async play() {
      el.paused = false;
      el.dispatchEvent(new Event("playing"));
    },
    requestVideoFrameCallback(next) {
      const id = ++nextFrameId;
      callbacks.set(id, next);
      return id;
    },
    cancelVideoFrameCallback(id) {
      callbacks.delete(id);
    },
  });
  return {
    el,
    frame() {
      // A real element supports independent RVFC registrations for both the
      // measurement binding and the separate first-frame deadline.
      const current = [...callbacks.values()];
      callbacks.clear();
      assert.ok(current.length);
      const presentedAt=performance.now();
      for(const next of current) next(presentedAt, { presentationTime: presentedAt });
    },
  };
}
try {
  vite = await createViteServer({
    root: repo,
    configFile: false,
    appType: "custom",
    cacheDir: resolve(process.env.RAINSYNC_ARTIFACT_DIR, "vite-wire-cache"),
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  assert.equal(vite.httpServer?.listening ?? false, false);
  report.module_loader = {
    supported_toolchain: "Vite ssrLoadModule",
    listening: false,
    synthetic_element: true,
  };
  const { createPlaybackRuntime } = await vite.ssrLoadModule(
    "/apps/web/src/features/playback/playback-runtime.ts",
  );
  const { createPlaybackMetricsSender } = await vite.ssrLoadModule(
    "/apps/web/src/features/playback/metrics-sender.ts",
  );
  const { createPlaybackMetrics } = await vite.ssrLoadModule(
    "/apps/web/src/features/playback/playback-metrics.ts",
  );
  const { RequestFailure } = await vite.ssrLoadModule(
    "/apps/web/src/errors.ts",
  );
  await isolatedMediaStack("playback-metrics-wire", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, root: f.root };
    const admin = f.client(),
      identity = await admin.login();
    const clipPath = await f.makeClip("owned-metrics-wire.mp4", {
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
    const source = await admin.request("/sources", "POST", {
      name: "owned wire local",
      kind: "local",
      config: { root: f.root },
    });
    await admin.request(`/sources/${source.id}/test`, "POST");
    const media = (await admin.request("/media")).find(
      (entry) =>
        entry.id ===
        f.sql(
          `SELECT id FROM media_items WHERE source_id=${quote(source.id)} AND title LIKE '%owned-metrics-wire%'`,
        ),
    );
    assert.ok(
      media,
      "generated source was discovered through public source API",
    );
    const room = await admin.request("/rooms", "POST", {
      name: "frontend metrics wire",
    });
    const roomController = await controller(f, admin, room);
    await roomController.select(media);
    const slot = (input) =>
      JSON.parse(
        f.sql(
          `SELECT jsonb_build_object('plan',plan_generation,'start',metrics_meter_start_generation,'seq',metrics_seq,'closed',metrics_closed,'payload',metrics_payload) FROM playback_viewer_plans WHERE user_id=${quote(identity.id)} AND room_id=${quote(input.room_id)} AND viewer_id=${quote(input.viewer_id)}`,
        ),
      );
    const scrape = async () => {
      const response = await admin.raw("/metrics");
      assert.equal(response.status, 200);
      const rows = (await response.text()).split("\n");
      const value = (name) =>
        Number(
          rows
            .find((line) =>
              line.startsWith(
                `${name}{origin="user_intent",process="server"} `,
              ),
            )
            ?.split(" ")
            .at(-1) ?? 0,
        );
      return {
        samples: value("rainsync_client_reported_playback_samples_total"),
        elapsed: value(
          "rainsync_client_reported_playback_elapsed_milliseconds_total",
        ),
      };
    };
    const calls = [],
      metricCalls = [],
      prepares = [],
      runErrors = [];
    let loseFirstAck = true,
      delayFinalAck = false,
      finalHeld = false;
    const finalGate = new Promise((done) => {
      releaseFinal = done;
    });
    async function api(path, method = "GET", body, signal) {
      const record = { path, method, body, at: Date.now() };
      calls.push(record);
      if (path.endsWith("/metrics")) metricCalls.push(record);
      const response = await admin.raw(path, { method, body, signal });
      const text = await response.text();
      const value = text ? JSON.parse(text) : undefined;
      Object.assign(record, { status: response.status, response: value });
      if (path.endsWith("/metrics") && body.final && delayFinalAck) {
        finalHeld = true;
        record.controlled_delayed_ack = true;
        await finalGate;
      }
      if (!response.ok) throw new RequestFailure(value);
      if (path === "/playback-sessions" && method === "POST")
        prepares.push(record);
      if (path.endsWith("/metrics") && loseFirstAck) {
        loseFirstAck = false;
        record.controlled_lost_ack = true;
        throw new TypeError(
          "controlled receipt loss after actual receiver commit",
        );
      }
      return value;
    }
    const storage = new Map();
    setGlobal("navigator", {
      mediaCapabilities: {
        decodingInfo: async () => ({
          supported: true,
          smooth: true,
          powerEfficient: true,
        }),
      },
    });
    setGlobal("location", { href: f.origin + "/rooms/" + room.id });
    setGlobal("sessionStorage", {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    });
    setGlobal(
      "document",
      Object.assign(new EventTarget(), { visibilityState: "visible" }),
    );
    const state = ref(roomController.state);
    const clock = { ready: true, now: () => state.value.anchor_server_time_ms };
    const video = syntheticVideo();
    scope = effectScope();
    const runtime = scope.run(() =>
      createPlaybackRuntime({
        identity: {
          current: () => ({ userId: identity.id, epoch: 1 }),
          invalidate: () => {},
          subscribeInvalidation: () => () => {},
        },
        api,
        timeline: { state, clock, connected: ref(true), active: ref(true) },
      }),
    );
    const error = runtime.playbackError;
    scope.run(() => watch(error, (message) => { if (message) runErrors.push(message); }, { flush: "sync" }));
    runtime.attach(video.el);
    const before = await scrape();
    await runtime.loadMedia();
    assert.equal(prepares.length, 1);
    const original = prepares[0];
    assert.equal(original.response.playback_metrics_version, 2);
    assert.deepEqual(original.body.playback_metrics_supported_versions,[1,2]);
    assert.equal(
      original.body.playback_metrics.meter_start_generation,
      original.body.plan_generation,
    );
    video.frame();
    await until(
      () => metricCalls.filter((entry) => entry.status === 200).length >= 2,
      "runtime cumulative POST and lost-ACK replay",
      18000,
    );
    const [first, replay] = metricCalls;
    assert.equal(first.controlled_lost_ack, true);
    assert.equal(
      first.body,
      replay.body,
      "actual sender retries the immutable packet object",
    );
    assert.equal(first.path, replay.path);
    assert.deepEqual(first.response, replay.response);
    const credited = await scrape();
    assert.equal(credited.samples - before.samples, 1);
    assert.equal(credited.elapsed - before.elapsed, first.body.elapsed_ms);
    assert.equal(slot(original.body).seq, first.body.seq);
    assert.equal(first.response.metrics_seq, first.body.seq);
    assert.equal(first.body.version,2);
    assert.equal(first.body.first_frame.evidence, "video_frame_callback");
    assert.equal(first.body.first_frame_plan_generation,original.response.plan_generation);
    assert.equal(Object.values(first.body.startup_phases).reduce((sum,value)=>sum+value,0),first.body.first_frame.confirmed_elapsed_ms);
    assert.ok(first.body.startup_phases.preparation_ms > 0);
    assert.equal(f.sql(`SELECT metrics_first_frame_source||':'||metrics_first_frame_mode FROM playback_viewer_plans WHERE viewer_id=${quote(original.body.viewer_id)}`),'local:direct');
    assert.equal(first.body.source, undefined);
    assert.equal(first.body.generation, undefined);
    check(
      "actual runtime POST receipt and lost ACK replay credit the cumulative sampler once",
      {
        seq: first.body.seq,
        elapsed_ms: first.body.elapsed_ms,
        synthetic_frame_evidence: true,
        receipt: replay.response,
      },
    );

    video.el.error = { code: 3 };
    video.el.onerror();
    await until(
      () =>
        prepares.length === 2 &&
        runtime.sessionId.value === prepares[1].response.session_id,
      "automatic decode fallback rebind",
      15000,
    );
    const fallback = prepares[1];
    assert.equal(fallback.body.viewer_id, original.body.viewer_id);
    assert.equal(
      fallback.body.plan_generation,
      original.body.plan_generation + 1,
    );
    assert.deepEqual(
      fallback.body.playback_metrics,
      original.body.playback_metrics,
    );
    assert.equal(
      fallback.response.playback_metrics.metrics_seq,
      first.body.seq,
    );
    assert.ok(
      fallback.body.candidate_report.excluded_candidates.includes(
        original.response.selected_candidate_id,
      ),
    );
    assert.notEqual(fallback.response.session_id, original.response.session_id);
    video.frame();
    await until(
      () =>
        metricCalls.some(
          (entry) =>
            entry.path.includes(fallback.response.session_id) &&
            entry.status === 200,
        ),
      "fallback cumulative POST",
      12000,
    );
    const continued = metricCalls.find(
      (entry) =>
        entry.path.includes(fallback.response.session_id) &&
        entry.status === 200,
    );
    assert.ok(continued.body.seq > first.body.seq);
    assert.ok(continued.body.elapsed_ms > first.body.elapsed_ms);
    assert.deepEqual(continued.body.first_frame, first.body.first_frame);
    assert.equal(continued.body.first_frame_plan_generation,original.response.plan_generation);
    assert.deepEqual(continued.body.startup_phases,first.body.startup_phases);
    assert.equal(
      continued.body.meter_start_generation,
      first.body.meter_start_generation,
    );
    assert.equal(slot(fallback.body).seq, continued.body.seq);
    const continuedCredit = await scrape();
    assert.equal(continuedCredit.samples - before.samples, 2);
    assert.equal(
      continuedCredit.elapsed - before.elapsed,
      continued.body.elapsed_ms,
    );
    assert.equal(
      f.sql(
        `SELECT stopped FROM playback_sessions WHERE id=${quote(original.response.session_id)}`,
      ),
      "t",
    );
    check(
      "automatic runtime decode fallback rebinds a negotiated grant and preserves cumulative seq, totals and first frame",
      {
        old_candidate: original.response.selected_candidate_id,
        next_candidate: fallback.response.selected_candidate_id,
        first_seq: first.body.seq,
        next_seq: continued.body.seq,
        elapsed_ms: continued.body.elapsed_ms,
      },
    );

    delayFinalAck = true;
    const stopStarted = Date.now();
    await runtime.reset();
    const stopMs = Date.now() - stopStarted;
    assert.equal(
      metricCalls.some((entry) => entry.body.final),
      true,
      "actual final HTTP POST started before owned Stop completed",
    );
    await until(
      () => finalHeld,
      "actual final metrics response held by controlled transport fault",
      2000,
    );
    const final = metricCalls.find((entry) => entry.body.final);
    const ownedStop = calls.find(
      (entry) =>
        entry.path === `/playback-sessions/${fallback.response.session_id}` &&
        entry.method === "DELETE",
    );
    assert.ok(
      final.at <= ownedStop.at,
      "final POST starts before owned DELETE",
    );
    assert.equal(
      typeof releaseFinal,
      "function",
      "final response remains held",
    );
    assert.ok(final.controlled_delayed_ack);
    assert.ok(
      [200, 410].includes(final.status),
      "final POST may commit or lose the Stop race",
    );
    assert.ok(
      stopMs < 1500,
      "runtime Stop is independent of outstanding final receipt",
    );
    assert.equal(
      f.sql(
        `SELECT stopped FROM playback_sessions WHERE id=${quote(fallback.response.session_id)}`,
      ),
      "t",
    );
    assert.equal(
      f.sql(
        `SELECT seq FROM playback_observations WHERE session_id=${quote(fallback.response.session_id)}`,
      ),
      String(
        calls.find(
          (entry) =>
            entry.path ===
              `/playback-sessions/${fallback.response.session_id}` &&
            entry.method === "DELETE",
        ).body.seq,
      ),
    );
    if (final.status === 200) {
      assert.equal(final.response.closed, true);
      assert.equal(slot(fallback.body).closed, true);
      assert.equal(slot(fallback.body).seq, final.body.seq);
    } else {
      assert.equal(final.response.error.code, "INVALID_PLAYBACK_SESSION");
      assert.equal(slot(fallback.body).seq, continued.body.seq);
      assert.deepEqual(await scrape(), continuedCredit);
    }
    releaseFinal();
    releaseFinal = undefined;
    scope.stop();
    scope = undefined;
    assert.deepEqual(runErrors, []);
    check(
      "actual final metrics POST and observation-v1 Stop do not wait for the delayed final response",
      {
        stop_ms: stopMs,
        final_post_started_before_delete: true,
        final_response_held_when_stop_completed: true,
        final_seq: final.body.seq,
        final_status: final.status,
        final_closed: final.status === 200,
      },
    );

    const makeGrant = async () => {
      const input = {
        room_id: room.id,
        media_generation: roomController.state.media_generation,
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
      };
      return {
        input,
        plan: await admin.request("/playback-sessions", "POST", input),
      };
    };
    async function rejectedSender(grant, reason) {
      const identityFence = {},
        fence = { identity: identityFence, generation: 1 };
      let now = 0;
      const observed = {
        foreground: true,
        expectedPlaying: false,
        paused: true,
        seeking: false,
        buffering: false,
        autoplayBlocked: false,
      };
      const meter = createPlaybackMetrics({
        t0: 0,
        startupOrigin: "user_intent",
        fence,
        current: () => fence,
        initial: observed,
        now: () => now,
      });
      const sender = createPlaybackMetricsSender((bound, body, signal) =>
        api(
          `/playback-sessions/${bound.sessionId}/metrics`,
          "POST",
          body,
          signal,
        ),
      );
      senders.add(sender);
      sender.bind({
        version:1,
        sessionId: grant.plan.session_id,
        planGeneration: grant.plan.plan_generation,
        mediaGeneration: grant.plan.media_generation,
        meterStartGeneration: 1,
        startupOrigin: "user_intent",
        current: () => true,
      });
      const slotBefore = slot(grant.input),
        totalsBefore = await scrape(),
        requestsBefore = metricCalls.length;
      now = 5000;
      assert.equal(sender.offer(meter.sample(fence, observed)), true);
      await until(
        () => sender.failure,
        `${reason} terminal sender failure`,
        2000,
      );
      assert.equal(sender.failure.code, "INVALID_PLAYBACK_SESSION");
      now = 10000;
      assert.equal(sender.offer(meter.sample(fence, observed)), false);
      assert.equal(
        metricCalls.length,
        requestsBefore + 1,
        "terminal rejection is not retried",
      );
      assert.deepEqual(slot(grant.input), slotBefore);
      assert.deepEqual(await scrape(), totalsBefore);
      sender.stop();
      senders.delete(sender);
      return {
        receiver_status: metricCalls.at(-1).status,
        code: sender.failure.code,
        requests: 1,
        unchanged_slot_and_credit: true,
      };
    }
    const cancelled = await makeGrant();
    await admin.request(
      `/playback-requests/${cancelled.input.idempotency_key}`,
      "DELETE",
    );
    check(
      "public request cancellation rejects the actual sender and disables further transport without credit",
      await rejectedSender(cancelled, "cancelled grant"),
    );
    const revoked = await makeGrant();
    await roomController.select(media);
    check(
      "public media-generation revocation rejects the actual sender and preserves durable high-water and aggregates",
      await rejectedSender(revoked, "revoked media grant"),
    );
    await admin.request(
      `/playback-sessions/${revoked.plan.session_id}`,
      "DELETE",
    );
    report.http = metricCalls.map(
      ({
        path,
        body,
        status,
        response,
        controlled_lost_ack,
        controlled_delayed_ack,
      }) => ({
        path,
        body,
        status,
        response,
        ...(controlled_lost_ack ? { controlled_lost_ack } : {}),
        ...(controlled_delayed_ack ? { controlled_delayed_ack } : {}),
      }),
    );
    await verifyBinding();
    report.result = "passed";
    await f.stopWorker();
  });
} catch (error) {
  report.result = "failed";
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  releaseFinal?.();
  scope?.stop();
  for (const sender of senders) sender.stop();
  for (const socket of sockets) socket.terminate();
  await vite?.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  if (fixture) {
    report.postgres = fixture.postgresDiagnostics();
    report.cleanup = await fixture.verifyStopped();
    if (workerPid) {
      report.cleanup.worker = {
        pid: workerPid,
        pid_absent: verifyPidAbsent(workerPid),
        port: workerPort,
        port_closed: await verifyClosedPort(workerPort),
      };
      assert.equal(report.cleanup.worker.pid_absent, true);
      assert.equal(report.cleanup.worker.port_closed, true);
    }
    report.completed_at = new Date().toISOString();
    report.check_count = report.checks.length;
    const path = resolve(fixture.root, "report.json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${path}`);
  }
}
