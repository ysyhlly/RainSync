// Finite production-route verification against a successful frozen native build.
// Owns legal generated H264, PostgreSQL, HTTP origin, ports and all processes.
// No builds, fake playback grants, production writes or long-run acceptance.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isolatedMediaStack } from "./fixtures/media-stack.mjs";
import { delay } from "./fixtures/server.mjs";
import { verifyClosedPort, verifyPidAbsent } from "./fixtures/postgres.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const bindingFile =
  process.env.RAINSYNC_RUNTIME_METRICS_BINDING_FILE ??
  process.env.RAINSYNC_HTTP_PLAYBACK_BINDING_FILE ??
  process.env.W03_BACKEND_BINDING;
assert.ok(bindingFile, "Set a successful frozen native backend binding");
assert.ok(
  process.env.RAINSYNC_NATIVE_POSTGRES_BIN,
  "Use owned native PostgreSQL",
);
const bindingBytes = await readFile(bindingFile);
const binding = JSON.parse(bindingBytes);
assert.equal(binding.result, "passed");
assert.ok(binding.source?.length > 0);
assert.equal(
  digest(Buffer.from(JSON.stringify(binding.source))),
  binding.source_digest,
);
for (const path of [
  "crates/media-core/src/runtime_metrics.rs",
  "apps/media-worker/src/metrics.rs",
  "apps/media-worker/src/main.rs",
  "apps/server/src/playback_requests.rs",
])
  assert.ok(
    binding.source.some((v) => v.path === path),
    `Binding includes ${path}`,
  );
const target = resolve(process.env.CARGO_TARGET_DIR ?? "target", "debug");
for (const name of [
  "rainsync-server",
  "rainsync-media-worker",
  "rainsync-nas-agent",
])
  assert.ok(
    binding.binaries?.some(
      (v) =>
        resolve(v.path) ===
        resolve(target, name + (process.platform === "win32" ? ".exe" : "")),
    ),
    `Binding includes executed ${name}`,
  );
const coordinatorInputs = await Promise.all(
  [
    "tests/runtime-metrics-production.mjs",
    "tests/fixtures/server.mjs",
    "tests/fixtures/media-stack.mjs",
    "tests/fixtures/postgres.mjs",
  ].map(async (path) => ({
    path,
    sha256: digest(await readFile(resolve(repo, path))),
  })),
);
async function verifyBinding() {
  assert.equal(
    digest(await readFile(bindingFile)),
    digest(bindingBytes),
    "Build binding remained frozen",
  );
  for (const input of [...binding.source, ...coordinatorInputs])
    assert.equal(
      digest(await readFile(resolve(repo, input.path))),
      input.sha256,
      `Frozen source/test: ${input.path}`,
    );
  for (const binary of binding.binaries)
    assert.equal(
      digest(await readFile(binary.path)),
      binary.sha256,
      "Executed binary remained frozen",
    );
}
await verifyBinding();

const report = {
  schema_version: 1,
  started_at: new Date().toISOString(),
  result: "failed",
  tests: [],
  origin_requests: [],
};
const workerPids = [],
  peers = new Set(),
  timers = new Set(),
  offers = [];
let fixture, upstream, upstreamPort, failure, cacheLock;
const runtimeName = (name) =>
  /^rainsync_(metric_|transfer_|cache_|playback_preparation_)/.test(name);
const allowedLabels = {
  process: ["server", "worker"],
  layer: ["worker_egress", "nas_uplink", "upstream_read"],
  outcome: ["complete", "failed", "cancelled"],
  result: ["hit", "miss"],
  reason: ["prepare", "upstream", "capacity", "other"],
  le: ["0.01", "0.05", "0.1", "0.5", "1", "5", "30", "120", "600", "+Inf"],
};
function parseMetrics(text, processLabel) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(\w+)(?:\{([^}]*)\})? ([^ ]+)$/.exec(line);
    assert.ok(match, `Valid exposition line: ${line}`);
    const labels = {};
    for (const label of match[2]?.split(",") ?? []) {
      const pair = /^(\w+)="([^"]*)"$/.exec(label);
      assert.ok(pair, "Fixed simple labels");
      assert.equal(labels[pair[1]], undefined, "No duplicate labels");
      labels[pair[1]] = pair[2];
    }
    const value = Number(match[3]);
    assert.ok(
      Number.isFinite(value) && value >= 0,
      "Bounded finite metric sample",
    );
    if (runtimeName(match[1])) {
      assert.equal(
        labels.process,
        processLabel,
        "Independent process-local samples",
      );
      for (const [key, label] of Object.entries(labels))
        assert.ok(
          allowedLabels[key]?.includes(label),
          `Closed metric label ${key}=${label}`,
        );
      assert.notEqual(
        labels.layer,
        "nas_uplink",
        "This HTTP-only fixture must not emit NAS send measurements",
      );
    }
    rows.push({ name: match[1], labels, value });
  }
  assert.ok(
    rows.filter((v) => runtimeName(v.name)).length <= 136,
    "Runtime series cardinality is fixed",
  );
  assert.equal(
    new Set(rows.map((v) => JSON.stringify([v.name, v.labels]))).size,
    rows.length,
    "Unique series",
  );
  for (const row of rows.filter(
    (v) => v.name === "rainsync_transfer_duration_seconds_count",
  )) {
    let previous = 0;
    for (const le of allowedLabels.le) {
      const count = value(rows, "rainsync_transfer_duration_seconds_bucket", {
        ...row.labels,
        le,
      });
      assert.ok(
        count >= previous && count <= row.value,
        "Histogram buckets are cumulative and bounded by count",
      );
      previous = count;
    }
    assert.equal(
      previous,
      row.value,
      "Infinite duration bucket equals terminal count",
    );
  }
  return rows;
}
function value(rows, name, labels = {}) {
  return rows
    .filter(
      (v) =>
        v.name === name &&
        Object.entries(labels).every(([key, label]) => v.labels[key] === label),
    )
    .reduce((sum, v) => sum + v.value, 0);
}
const bodyBytes = (rows, layer) =>
  value(rows, "rainsync_transfer_body_bytes_total", { layer });
const endedBytes = (rows, layer, outcome) =>
  value(rows, "rainsync_transfer_bytes_total", {
    layer,
    ...(outcome ? { outcome } : {}),
  });
const endedCount = (rows, layer, outcome) =>
  value(rows, "rainsync_transfer_duration_seconds_count", {
    layer,
    ...(outcome ? { outcome } : {}),
  });
const active = (rows) => value(rows, "rainsync_metric_active_transfers");
const failures = (rows) =>
  value(rows, "rainsync_playback_preparation_failures_total");
const runtimeRows = (rows) => rows.filter((v) => runtimeName(v.name));
async function check(name, run) {
  const row = { name, result: "failed" };
  report.tests.push(row);
  const began = Date.now();
  try {
    Object.assign(row, await run(), { result: "passed" });
    console.log(`PASS: ${name}`);
  } catch (error) {
    failure ??= error;
    row.failure = { message: error.message, stack: error.stack };
    row.latest_scrapes = structuredClone(report.latest_scrapes);
    console.log(`FAIL: ${name}: ${error.message}`);
  }
  row.elapsed_ms = Date.now() - began;
}
async function until(run, predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await run();
    if (predicate(result)) return result;
    await delay(30);
  }
  throw Error(message);
}
async function roomControl(f, admin, room) {
  const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/api/v1/ws", {
    headers: { Origin: f.origin, Cookie: admin.cookie },
  });
  peers.add(ws);
  const frames = [];
  ws.on("message", (bytes) => frames.push(JSON.parse(bytes)));
  await new Promise((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  const next = async (type, predicate = () => true) =>
    until(
      async () => {
        const index = frames.findIndex((v) => v.type === type && predicate(v));
        return index < 0 ? null : frames.splice(index, 1)[0];
      },
      Boolean,
      `Missing room ${type}`,
    );
  ws.send(JSON.stringify({ type: "JOIN", room_id: room.id }));
  const snapshot = await next("SNAPSHOT");
  let state = snapshot.state;
  return async (media) => {
    const command = {
      protocol_version: 1,
      room_id: room.id,
      command_id: randomUUID(),
      control_epoch: snapshot.control_epoch.id,
      expected_revision: state.revision,
      media_generation: state.media_generation,
      type: "CHANGE_MEDIA",
      payload: { media_id: media.id },
    };
    ws.send(JSON.stringify(command));
    state = (await next("ACK", (v) => v.command_id === command.command_id))
      .state;
    assert.equal(state.media_id, media.id);
    return state.media_generation;
  };
}
async function errorResponse(response, status, code) {
  const body = await response.json();
  assert.equal(
    response.status,
    status,
    `Expected ${status}; actual ${body?.error?.code}`,
  );
  if (code) assert.equal(body.error.code, code);
  return body;
}

try {
  await isolatedMediaStack("runtime-metrics-production", async (f) => {
    fixture = f;
    report.fixture = { id: f.id, postgres: f.postgresDiagnostics() };
    const clip = await readFile(
      await f.makeClip("owned-metrics.mp4", { pictureSeconds: 4 }),
    );
    const prefixLength = 1536;
    assert.ok(
      clip.length > prefixLength * 2,
      "Owned clip supports paused prefix and remainder",
    );
    report.clip = {
      codec: "H264",
      generated_owned_media: true,
      length: clip.length,
      sha256: digest(clip),
      paused_prefix_bytes: prefixLength,
    };
    upstream = createServer((request, response) => {
      const path = new URL(request.url, "http://owned").pathname;
      const row = {
        path,
        method: request.method,
        range: request.headers.range ?? null,
        status: null,
        body_bytes: 0,
        chunks: [],
        closed: false,
      };
      report.origin_requests.push(row);
      const etag = path === "/plain.mp4" ? null : '"owned-metrics-v1"';
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Accept-Ranges", "bytes");
      if (etag) response.setHeader("ETag", etag);
      response.once("close", () => (row.closed = true));
      if (request.headers["if-match"] && request.headers["if-match"] !== etag) {
        row.status = 412;
        response.writeHead(412, { "Content-Length": 0 });
        response.end();
        return;
      }
      let start = 0,
        end = clip.length - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      if (range) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end) {
          row.status = 416;
          response.writeHead(416, {
            "Content-Length": 0,
            "Content-Range": `bytes */${clip.length}`,
          });
          response.end();
          return;
        }
        response.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${clip.length}`,
        );
      }
      row.status = range ? 206 : 200;
      response.writeHead(
        row.status,
        path === "/chunked.mp4" ? {} : { "Content-Length": end - start + 1 },
      );
      response.flushHeaders();
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const bytes = clip.subarray(start, end + 1);
      const send = (chunk, complete = false) => {
        if (response.destroyed) return;
        row.body_bytes += chunk.length;
        row.chunks.push(chunk.length);
        if (complete) response.end(chunk);
        else response.write(chunk);
      };
      if (
        [
          "/paused.mp4",
          "/broken.mp4",
          "/cancel.mp4",
          "/supersede.mp4",
        ].includes(path) &&
        bytes.length > prefixLength
      ) {
        send(bytes.subarray(0, prefixLength));
        offers.push({
          row,
          release: () =>
            path === "/broken.mp4"
              ? response.destroy()
              : send(bytes.subarray(prefixLength), true),
        });
      } else {
        // A chunk larger than the sniff limit exposes accidental prefix replay.
        send(bytes.subarray(0, Math.min(prefixLength, bytes.length)));
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(bytes.subarray(Math.min(prefixLength, bytes.length)), true);
        }, 30);
        timers.add(timer);
        response.once("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
      }
    });
    await new Promise((done, reject) =>
      upstream.once("error", reject).listen(0, "127.0.0.1", done),
    );
    upstreamPort = upstream.address().port;
    const origin = `http://127.0.0.1:${upstreamPort}`;
    const policy = {
      schema_version: 1,
      origins: [{ origin, cidrs: ["127.0.0.1/32"] }],
    };
    await f.startWorker();
    workerPids.push(f.workerPid);
    await f.startServer({ WORKER_URL: f.workerOrigin });
    const admin = f.client();
    await admin.login();
    const scrape = async (processLabel) => {
      const response = await fetch(
        processLabel === "worker"
          ? f.workerOrigin + "/metrics"
          : f.origin + "/api/v1/metrics",
        {
          headers: { Cookie: admin.cookie },
          signal: AbortSignal.timeout(6000),
        },
      );
      assert.equal(response.status, 200, `${processLabel} admin scrape`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(
        response.headers.get("content-type"),
        /text\/plain; version=0\.0\.4/,
      );
      const rows = parseMetrics(await response.text(), processLabel);
      (report.latest_scrapes ??= {})[processLabel] = rows;
      return rows;
    };
    const settled = () =>
      until(
        () => scrape("worker"),
        (rows) => active(rows) === 0,
        "All collector handles released",
      );
    const createSource = async (path) => {
      const source = await admin.request("/sources", "POST", {
        name: `owned metrics ${path}`,
        kind: "http",
        config: { url: origin + path, access_policy: policy },
      });
      assert.equal(
        (await admin.request(`/sources/${source.id}/test`, "POST")).count,
        1,
      );
      const media = (await admin.request("/media")).find(
        (v) =>
          f.sql(`SELECT source_id FROM media_items WHERE id=${quote(v.id)}`) ===
          source.id,
      );
      assert.ok(media, "Public source scan creates real media");
      return { source, media };
    };
    const sources = {};
    for (const name of [
      "full",
      "chunked",
      "paused",
      "broken",
      "probe",
      "plain",
      "cancel",
      "supersede",
    ])
      sources[name] = await createSource(`/${name}.mp4`);
    const room = await admin.request("/rooms", "POST", {
      name: "owned runtime metrics",
    });
    const select = await roomControl(f, admin, room);
    let generation = await select(sources.full.media);
    const input = (mode = "direct", extra = {}) => ({
      room_id: room.id,
      media_generation: generation,
      mode,
      position_ms: 0,
      idempotency_key: randomUUID(),
      ...extra,
    });
    const plan = (mode = "direct", extra = {}) =>
      admin.request("/playback-sessions", "POST", input(mode, extra));
    const delivery = (prepared, path) => {
      const url = new URL(prepared.playback_url, f.workerOrigin);
      if (path) url.pathname = `/media-delivery/${prepared.session_id}/${path}`;
      return url;
    };
    const nextOffer = (path, after = 0) =>
      until(
        async () => offers.slice(after).find((v) => v.row.path === path),
        Boolean,
        `Origin paused ${path}`,
      );

    await check(
      "existing admin session protects both process scrapes and empty families stay absent",
      async () => {
        for (const url of [
          f.workerOrigin + "/metrics",
          f.origin + "/api/v1/metrics",
        ])
          for (const headers of [
            {},
            { Authorization: "Bearer owned-invalid" },
            { Cookie: `${admin.cookie}; ${admin.cookie}` },
            { Cookie: "rainsync_session=invalid" },
          ]) {
            const response = await fetch(url, {
              headers,
              signal: AbortSignal.timeout(6000),
            });
            assert.equal(response.status, 401);
            assert.equal(response.headers.get("cache-control"), "no-store");
            await response.arrayBuffer();
          }
        assert.deepEqual(runtimeRows(await scrape("worker")), []);
        assert.deepEqual(runtimeRows(await scrape("server")), []);
        return { rejected_scrapes: 8, runtime_families_initially_absent: true };
      },
    );
    const direct = await plan();
    await check(
      "real network chunks and final output count exact bytes without sniff prefix duplication",
      async () => {
        const before = await settled(),
          requestStart = report.origin_requests.length;
        const response = await fetch(delivery(direct), {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), clip);
        const after = await settled();
        assert.equal(report.origin_requests.length - requestStart, 1);
        for (const layer of ["upstream_read", "worker_egress"]) {
          assert.equal(
            bodyBytes(after, layer) - bodyBytes(before, layer),
            clip.length,
          );
          assert.equal(
            endedBytes(after, layer, "complete") -
              endedBytes(before, layer, "complete"),
            clip.length,
          );
          assert.equal(
            endedCount(after, layer, "complete") -
              endedCount(before, layer, "complete"),
            1,
          );
        }
        assert.deepEqual(report.origin_requests.at(-1).chunks, [
          prefixLength,
          clip.length - prefixLength,
        ]);
        return {
          upstream_read_bytes: clip.length,
          worker_egress_bytes: clip.length,
          origin_chunks: report.origin_requests.at(-1).chunks,
        };
      },
    );
    await check(
      "pinned partial bytes count once while HEAD 416 and invalid grants allocate no transfers",
      async () => {
        const before = await settled();
        const response = await fetch(delivery(direct), {
          headers: { Range: "bytes=128-511" },
        });
        assert.equal(response.status, 206);
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          clip.subarray(128, 512),
        );
        const afterRange = await settled();
        for (const layer of ["upstream_read", "worker_egress"]) {
          assert.equal(
            bodyBytes(afterRange, layer) - bodyBytes(before, layer),
            384,
          );
          assert.equal(
            endedBytes(afterRange, layer, "complete") -
              endedBytes(before, layer, "complete"),
            384,
          );
          assert.equal(
            endedCount(afterRange, layer, "complete") -
              endedCount(before, layer, "complete"),
            1,
          );
        }
        const head = await fetch(delivery(direct), { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const invalidRange = await fetch(delivery(direct), {
          headers: { Range: `bytes=${clip.length + 100}-` },
        });
        assert.equal(
          invalidRange.headers.get("content-range"),
          `bytes */${clip.length}`,
        );
        await errorResponse(invalidRange, 416, "RANGE_NOT_SATISFIABLE");
        assert.equal(report.origin_requests.at(-1).body_bytes, 0);
        const invalid = delivery(direct);
        invalid.searchParams.set("token", "owned-invalid");
        await errorResponse(
          await fetch(invalid),
          401,
          "INVALID_PLAYBACK_SESSION",
        );
        assert.deepEqual(runtimeRows(await settled()), runtimeRows(afterRange));
        return {
          partial_body_bytes: 384,
          omitted_body_requests: ["HEAD", "416", "invalid grant"],
        };
      },
    );
    generation = await select(sources.chunked.media);
    const chunked = await plan();
    await check(
      "unknown length chunked body completes only on real EOF",
      async () => {
        const before = await settled();
        const response = await fetch(delivery(chunked), {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-length"), null);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), clip);
        const after = await settled();
        for (const layer of ["upstream_read", "worker_egress"]) {
          assert.equal(
            bodyBytes(after, layer) - bodyBytes(before, layer),
            clip.length,
          );
          assert.equal(
            endedBytes(after, layer, "complete") -
              endedBytes(before, layer, "complete"),
            clip.length,
          );
          assert.equal(
            endedCount(after, layer, "complete") -
              endedCount(before, layer, "complete"),
            1,
          );
        }
        return {
          complete_bytes_per_boundary: clip.length,
          declared_length: null,
          released_handles: true,
        };
      },
    );
    generation = await select(sources.paused.media);
    const paused = await plan();
    await check(
      "paused source exposes live bytes before terminal accounting then completes and releases",
      async () => {
        const before = await settled(),
          offerStart = offers.length;
        const response = await fetch(delivery(paused), {
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200);
        const reader = response.body.getReader(),
          first = await reader.read();
        assert.equal(first.done, false);
        assert.equal(first.value.length, prefixLength);
        const offer = await nextOffer("/paused.mp4", offerStart);
        const live = await until(
          () => scrape("worker"),
          (rows) => active(rows) === 2,
          "Both paused transfers active",
        );
        for (const layer of ["upstream_read", "worker_egress"]) {
          assert.equal(
            bodyBytes(live, layer) - bodyBytes(before, layer),
            prefixLength,
          );
          assert.equal(endedBytes(live, layer), endedBytes(before, layer));
        }
        await delay(100);
        assert.deepEqual(
          runtimeRows(await scrape("worker")),
          runtimeRows(live),
          "Scrapes never drain paused media",
        );
        offer.release();
        const chunks = [first.value];
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
        assert.deepEqual(Buffer.concat(chunks), clip);
        const after = await settled();
        for (const layer of ["upstream_read", "worker_egress"])
          assert.equal(
            endedBytes(after, layer, "complete") -
              endedBytes(before, layer, "complete"),
            clip.length,
          );
        return {
          active_handles: 2,
          observed_while_active: prefixLength,
          complete_bytes: clip.length,
          released_handles: true,
        };
      },
    );
    await check(
      "consumer cancellation records partial cancellation and releases the origin",
      async () => {
        const before = await settled(),
          offerStart = offers.length;
        const response = await fetch(delivery(paused));
        const reader = response.body.getReader();
        assert.equal((await reader.read()).value.length, prefixLength);
        const offer = await nextOffer("/paused.mp4", offerStart);
        await reader.cancel();
        const after = await settled();
        await until(
          async () => offer.row.closed,
          Boolean,
          "Cancelled origin response closes",
        );
        for (const layer of ["upstream_read", "worker_egress"]) {
          assert.equal(
            endedBytes(after, layer, "cancelled") -
              endedBytes(before, layer, "cancelled"),
            prefixLength,
          );
          assert.equal(
            endedCount(after, layer, "cancelled") -
              endedCount(before, layer, "cancelled"),
            1,
          );
        }
        return {
          partial_bytes_per_boundary: prefixLength,
          cancelled_transfers: 2,
          origin_closed: true,
        };
      },
    );
    await check(
      "source policy revocation fails the final output while cancelling unread upstream",
      async () => {
        const before = await settled(),
          offerStart = offers.length;
        const response = await fetch(delivery(paused), {
          signal: AbortSignal.timeout(15000),
        });
        const reader = response.body.getReader();
        assert.equal((await reader.read()).value.length, prefixLength);
        const offer = await nextOffer("/paused.mp4", offerStart);
        const revised = await admin.request(
          `/sources/${sources.paused.source.id}/access-policy`,
          "POST",
          { expected_revision: 1, policy },
        );
        assert.equal(revised.access_policy_revision, 2);
        await assert.rejects(
          reader.read(),
          "Revoked body emits failure instead of clean EOF",
        );
        const after = await settled();
        await until(
          async () => offer.row.closed,
          Boolean,
          "Revoked origin closes",
        );
        assert.equal(
          endedBytes(after, "worker_egress", "failed") -
            endedBytes(before, "worker_egress", "failed"),
          prefixLength,
        );
        assert.equal(
          endedCount(after, "worker_egress", "failed") -
            endedCount(before, "worker_egress", "failed"),
          1,
        );
        assert.equal(
          endedBytes(after, "upstream_read", "cancelled") -
            endedBytes(before, "upstream_read", "cancelled"),
          prefixLength,
        );
        return {
          worker_outcome: "failed",
          upstream_outcome: "cancelled",
          partial_bytes: prefixLength,
          released_handles: true,
        };
      },
    );
    generation = await select(sources.broken.media);
    const broken = await plan();
    await check(
      "real truncated transport records failed partial bytes at both boundaries",
      async () => {
        const before = await settled(),
          offerStart = offers.length;
        const response = await fetch(delivery(broken));
        const reader = response.body.getReader();
        assert.equal((await reader.read()).value.length, prefixLength);
        (await nextOffer("/broken.mp4", offerStart)).release();
        await assert.rejects(reader.read());
        const after = await settled();
        for (const layer of ["upstream_read", "worker_egress"]) {
          assert.equal(
            endedBytes(after, layer, "failed") -
              endedBytes(before, layer, "failed"),
            prefixLength,
          );
          assert.equal(
            endedCount(after, layer, "failed") -
              endedCount(before, layer, "failed"),
            1,
          );
        }
        return {
          failed_transfers: 2,
          actual_bytes_per_boundary: prefixLength,
          released_handles: true,
        };
      },
    );
    generation = await select(sources.probe.media);
    await check(
      "real probe counts internal execution source bodies and excludes its JSON response",
      async () => {
        const prepared = await plan(),
          before = await settled(),
          requestStart = report.origin_requests.length;
        const response = await fetch(delivery(prepared, "probe"), {
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200);
        const json = await response.json();
        assert.ok(json.streams.some((v) => v.codec_name === "h264"));
        const after = await settled(),
          requests = report.origin_requests.slice(requestStart);
        const networkBytes = requests.reduce((sum, v) => sum + v.body_bytes, 0);
        const classificationBytes = requests
          .filter((v) => v.range === "bytes=0-1023")
          .reduce((sum, v) => sum + v.body_bytes, 0);
        assert.ok(networkBytes > classificationBytes);
        assert.equal(
          bodyBytes(after, "upstream_read") -
            bodyBytes(before, "upstream_read"),
          networkBytes,
        );
        assert.equal(
          bodyBytes(after, "worker_egress") -
            bodyBytes(before, "worker_egress"),
          networkBytes - classificationBytes,
        );
        assert.equal(
          endedCount(after, "worker_egress") -
            endedCount(before, "worker_egress"),
          requests.filter(
            (v) => v.method === "GET" && v.range !== "bytes=0-1023",
          ).length,
        );
        return {
          actual_network_bytes: networkBytes,
          internal_source_output_bytes: networkBytes - classificationBytes,
          separate_classification_bytes: classificationBytes,
          probe_json_excluded: true,
        };
      },
    );
    generation = await select(sources.plain.media);
    await check(
      "newly committed preparation failure counts once and nonretryable replay is excluded",
      async () => {
        const before = await scrape("server"),
          failedInput = input("auto");
        await errorResponse(
          await admin.raw("/playback-sessions", {
            method: "POST",
            body: failedInput,
          }),
          409,
          "SOURCE_VERSION_REQUIRED",
        );
        const after = await scrape("server");
        assert.equal(failures(after) - failures(before), 1);
        assert.equal(
          value(after, "rainsync_playback_preparation_failures_total", {
            reason: "prepare",
          }) -
            value(before, "rainsync_playback_preparation_failures_total", {
              reason: "prepare",
            }),
          1,
        );
        const requestCount = report.origin_requests.length;
        await errorResponse(
          await admin.raw("/playback-sessions", {
            method: "POST",
            body: failedInput,
          }),
          409,
          "SOURCE_VERSION_REQUIRED",
        );
        assert.equal(failures(await scrape("server")), failures(after));
        assert.equal(
          report.origin_requests.length,
          requestCount,
          "Replay never opens origin",
        );
        assert.equal(
          f.sql(
            `SELECT status || ':' || error_code FROM playback_requests WHERE idempotency_key=${quote(failedInput.idempotency_key)}`,
          ),
          "failed:source_version_required",
        );
        return {
          committed_failure_delta: 1,
          replay_failure_delta: 0,
          replay_origin_requests: 0,
        };
      },
    );
    await check(
      "real pending cancellation and supersession never inflate preparation failures",
      async () => {
        const before = failures(await scrape("server"));
        const retired = [];
        for (const [name, action] of [
          ["cancel", "cancel"],
          ["supersede", "supersede"],
        ]) {
          generation = await select(sources[name].media);
          const viewer = randomUUID(),
            pendingInput = input("auto", {
              viewer_id: viewer,
              plan_generation: 1,
            });
          const offerStart = offers.length;
          const pending = admin.raw("/playback-sessions", {
            method: "POST",
            body: pendingInput,
            signal: AbortSignal.timeout(20000),
          });
          const offer = await nextOffer(`/${name}.mp4`, offerStart);
          const session = f.sql(
            `SELECT session_id FROM playback_requests WHERE idempotency_key=${quote(pendingInput.idempotency_key)}`,
          );
          assert.ok(session, "Real pending reservation exists");
          if (action === "cancel")
            await admin.request(
              `/playback-requests/${pendingInput.idempotency_key}`,
              "DELETE",
            );
          else {
            const successor = await plan("direct", {
              viewer_id: viewer,
              plan_generation: 2,
            });
            assert.equal(successor.plan_generation, 2);
          }
          offer.release();
          const response = await pending;
          assert.ok(
            [409, 410, 502].includes(response.status),
            `Retired preparation denied: ${response.status}`,
          );
          const denied = await response.json();
          retired.push({
            action,
            status: response.status,
            code: denied.error.code,
          });
          await f.waitForSql(
            `SELECT drained_at IS NOT NULL FROM playback_preparations WHERE session_id=${quote(session)}`,
            "t",
          );
          await settled();
          assert.equal(failures(await scrape("server")), before);
        }
        return {
          pending_preparations: 2,
          retired,
          committed_failure_delta: 0,
          preparation_drain_receipts: true,
        };
      },
    );
    await check(
      "process collectors remain independent with closed labels and bounded series",
      async () => {
        const worker = await settled(),
          server = await scrape("server");
        assert.ok(
          bodyBytes(worker, "upstream_read") > 0 &&
            bodyBytes(worker, "worker_egress") > 0,
        );
        assert.equal(failures(worker), 0);
        assert.equal(bodyBytes(server, "upstream_read"), 0);
        assert.equal(bodyBytes(server, "worker_egress"), 0);
        assert.equal(failures(server), 1);
        assert.equal(
          value(worker, "rainsync_metric_transfer_dropped_total"),
          0,
        );
        report.final_before_worker_restart = {
          worker: runtimeRows(worker),
          server: runtimeRows(server),
        };
        return {
          worker_runtime_series: runtimeRows(worker).length,
          server_runtime_series: runtimeRows(server).length,
          cross_process_imported_samples: 0,
        };
      },
    );
    await check(
      "real remux first wait is a cache miss and completed validated reopen is a hit",
      async () => {
        // Stopping the owned Worker and locking the real queued row makes the
        // first lookup deterministic without creating fake jobs or output files.
        await f.stopWorker();
        const source = await admin.request("/sources", "POST", {
          name: "owned metrics local remux",
          kind: "local",
          config: { root: f.root },
        });
        await admin.request(`/sources/${source.id}/test`, "POST");
        const media = (await admin.request("/media")).find(
          (v) =>
            f.sql(
              `SELECT source_id || ':' || resource FROM media_items WHERE id=${quote(v.id)}`,
            ) === `${source.id}:owned-metrics.mp4`,
        );
        assert.ok(media, "Local public scan creates owned media");
        generation = await select(media);
        const remux = await plan("remux");
        assert.equal(remux.delivery_mode, "remux");
        assert.equal(
          f.sql(
            `SELECT status FROM media_jobs WHERE id=${quote(remux.session_id)}`,
          ),
          "queued",
        );
        cacheLock = f.sqlProcess(undefined, { interactive: true });
        let lockOutput = "";
        cacheLock.stdout.on("data", (bytes) => (lockOutput += bytes));
        cacheLock.stdin.write(
          `BEGIN; SELECT id FROM media_jobs WHERE id=${quote(remux.session_id)} FOR UPDATE; SELECT 'metrics_cache_locked';\n`,
        );
        await until(
          async () => lockOutput,
          (v) => v.includes("metrics_cache_locked"),
          "Owned cache row locked",
        );
        await f.startWorker();
        workerPids.push(f.workerPid);
        const waiting = fetch(delivery(remux), {
          signal: AbortSignal.timeout(20000),
        });
        const miss = await until(
          () => scrape("worker"),
          (rows) =>
            value(rows, "rainsync_cache_lookups_total", { result: "miss" }) ===
            1,
          "First pending cache lookup counts Miss",
        );
        assert.equal(
          value(miss, "rainsync_cache_lookups_total", { result: "hit" }),
          0,
        );
        cacheLock.stdin.end("COMMIT;\n\\q\n");
        await cacheLock.done;
        cacheLock = undefined;
        const first = await waiting;
        assert.equal(first.status, 200);
        const firstBody = Buffer.from(await first.arrayBuffer());
        await f.waitForSql(
          `SELECT status FROM media_jobs WHERE id=${quote(remux.session_id)}`,
          "succeeded",
          15000,
        );
        const afterFirst = await settled();
        assert.equal(
          value(afterFirst, "rainsync_cache_lookups_total", { result: "miss" }),
          1,
        );
        assert.equal(
          value(afterFirst, "rainsync_cache_lookups_total", { result: "hit" }),
          0,
        );
        assert.equal(
          value(afterFirst, "rainsync_cache_served_bytes_total"),
          0,
          "Waited output never retroactively counts cached bytes",
        );
        const reopen = await fetch(delivery(remux));
        assert.equal(reopen.status, 200);
        const reopened = Buffer.from(await reopen.arrayBuffer());
        assert.match(reopened.toString(), /#EXT-X-ENDLIST/);
        const afterReopen = await settled();
        assert.equal(
          value(afterReopen, "rainsync_cache_lookups_total", { result: "hit" }),
          1,
        );
        assert.equal(
          value(afterReopen, "rainsync_cache_served_bytes_total"),
          reopened.length,
        );
        const initPath = /URI="([^"]+\/init\.mp4[^\"]*)"/.exec(
          reopened.toString(),
        )?.[1];
        assert.ok(initPath);
        const init = await fetch(new URL(initPath, f.workerOrigin));
        assert.equal(init.status, 200);
        const initBody = Buffer.from(await init.arrayBuffer());
        assert.ok(initBody.length > 0);
        const final = await settled();
        assert.equal(
          value(final, "rainsync_cache_lookups_total", { result: "hit" }),
          2,
        );
        assert.equal(
          value(final, "rainsync_cache_served_bytes_total"),
          reopened.length + initBody.length,
        );
        assert.equal(
          bodyBytes(final, "worker_egress"),
          firstBody.length + reopened.length + initBody.length,
        );
        assert.equal(
          endedBytes(final, "worker_egress", "complete"),
          firstBody.length + reopened.length + initBody.length,
        );
        assert.equal(endedCount(final, "worker_egress", "complete"), 3);
        assert.equal(
          bodyBytes(final, "upstream_read"),
          0,
          "Local encoder adds no network-body samples",
        );
        report.final_cache_worker = runtimeRows(final);
        return {
          initial_lookup: "miss",
          validated_reopened_lookups: 2,
          first_playlist_bytes: firstBody.length,
          cached_playlist_bytes: reopened.length,
          validated_init_bytes: initBody.length,
          cache_served_bytes: reopened.length + initBody.length,
        };
      },
    );
    for (const ws of peers) ws.terminate();
    peers.clear();
  });
  await verifyBinding();
  if (!failure) report.result = "passed";
  else report.failure = { message: failure.message, stack: failure.stack };
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  cacheLock?.kill();
  for (const ws of peers) ws.terminate();
  for (const timer of timers) clearTimeout(timer);
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  }
  if (fixture) {
    const stack = await fixture.verifyStopped();
    const workerPortClosed = await verifyClosedPort(
      Number(new URL(fixture.workerOrigin).port),
    );
    const originPortClosed = await verifyClosedPort(upstreamPort);
    const workerPidsAbsent = workerPids.every((pid) => verifyPidAbsent(pid));
    assert.equal(workerPortClosed, true);
    assert.equal(originPortClosed, true);
    assert.equal(workerPidsAbsent, true);
    report.cleanup = {
      ...stack,
      worker_pids: workerPids,
      worker_pids_absent: workerPidsAbsent,
      worker_port_closed: workerPortClosed,
      origin_port: upstreamPort,
      origin_port_closed: originPortClosed,
    };
    report.finished_at = new Date().toISOString();
    report.binding = {
      file: bindingFile,
      sha256: digest(bindingBytes),
      source_digest: binding.source_digest,
      binaries: binding.binaries,
      coordinator_inputs: coordinatorInputs,
    };
    report.limitations = [
      "Finite public HTTP/Server/Worker verification with generated owned H264 and native PostgreSQL; no browser/device/long-run acceptance",
      "Exact body boundary counts are process-local handoff evidence, not receiver acknowledgements or decoded media throughput",
      "This HTTP-only fixture does not exercise NAS send-side or browser telemetry",
    ];
    const reportPath = resolve(fixture.root, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`Evidence: ${reportPath}`);
  }
}
if (failure) throw failure;
