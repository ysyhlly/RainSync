import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  calibrateClock,
  applyCalibration,
  resourceTrends,
} from "../scripts/acceptance-measurements.mjs";
import { digestJson } from "../scripts/release-evidence.mjs";
import {
  redactEvidence,
  boundedCall,
} from "../scripts/acceptance-runtime.mjs";
import {
  networkSchedule,
  runNetwork,
  assessNetworkRun,
} from "../scripts/acceptance-network.mjs";
import { soakSchedule, runSoak } from "../scripts/acceptance-soak.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const binaries = Object.fromEntries(
  ["rainsync-server", "rainsync-media-worker", "rainsync-nas-agent"].map(
    (name) => [name, hash(name)],
  ),
);
const exchanges = (offset = 900) =>
  Array.from({ length: 5 }, (_, i) => ({
    client_id: "a",
    clock_id: "epoch",
    reference_send_ms: 1000 + i * 100,
    client_receive_ms: 1010 + i * 100 - offset,
    client_send_ms: 1011 + i * 100 - offset,
    reference_receive_ms: 1021 + i * 100,
  }));

test("independent calibration bounds asymmetric delay and rejects wrong epochs/stale samples", () => {
  const calibration = calibrateClock(exchanges(), {
    client_id: "a",
    clock_id: "epoch",
  });
  assert.equal(calibration.reference_offset_ms, 900);
  assert.equal(calibration.clock_uncertainty_ms, 10);
  const sample = applyCalibration(
    {
      client_id: "a",
      clock_id: "epoch",
      monotonic_ms: 600,
      reference_offset_ms: -999,
    },
    calibration,
  );
  assert.equal(sample.reference_offset_ms, 900);
  assert.ok(sample.clock_uncertainty_ms >= 10);
  assert.throws(
    () =>
      applyCalibration(
        { client_id: "b", clock_id: "epoch", monotonic_ms: 600 },
        calibration,
      ),
    /cross-client/,
  );
  assert.throws(
    () =>
      applyCalibration(
        { client_id: "a", clock_id: "reset", monotonic_ms: 600 },
        calibration,
      ),
    /epoch/,
  );
  assert.throws(
    () =>
      applyCalibration(
        { client_id: "a", clock_id: "epoch", monotonic_ms: 999999 },
        calibration,
      ),
    /stale/,
  );
  assert.throws(
    () =>
      calibrateClock(
        exchanges().map((row, i) => ({
          ...row,
          client_receive_ms: row.client_receive_ms + (i === 4 ? 300 : 0),
          client_send_ms: row.client_send_ms + (i === 4 ? 300 : 0),
        })),
        { client_id: "a", clock_id: "epoch" },
      ),
    /disagree/,
  );
});

test("redaction removes nested credentials, URL secrets and secret values in error stacks", () => {
  const result = redactEvidence(
    {
      cookie: "session",
      nested: {
        access_token: "abc",
        message: "Bearer abcdef https://u:p@example.test/path?token=x#secret",
      },
      error: Error("failure value-secret"),
    },
    ["value-secret"],
  );
  const text = JSON.stringify(result);
  for (const secret of ["session", "abcdef", "u:p", "token=x", "value-secret"])
    assert.ok(!text.includes(secret));
  assert.ok(text.includes("https://example.test/path"));
});

test("formal schedule validates duration, full matrix, independent flow scopes and bounded work", () => {
  assert.equal(networkSchedule().runs.length, 54);
  assert.throws(
    () => networkSchedule({ scope: "formal", duration_seconds: 2 }),
    /formal/,
  );
  assert.throws(
    () => networkSchedule({ scopes: ["shared", "shared"] }),
    /scopes/,
  );
  assert.throws(
    () =>
      soakSchedule({
        scope: "formal",
        duration_seconds: 600,
        warmup_seconds: 0,
      }),
    /72h/,
  );
  const schedule = soakSchedule({ scope: "formal" });
  for (const action of [
    "loop-playback",
    "slice",
    "seek",
    "join",
    "leave",
    "cache-evict",
    "fault",
    "verify-identity",
    "sample-resources",
  ])
    assert.ok(schedule.events.some((event) => event.kind === action));
  assert.equal(schedule.duration_ms, 259200000);
});

test("adapter call timeout and cancellation are bounded", async () => {
  const adapter = { stuck: () => new Promise(() => {}) };
  await assert.rejects(
    boundedCall(adapter, "stuck", {}, { timeout_ms: 5 }),
    /timed out/,
  );
  const controller = new AbortController();
  controller.abort(Error("stopped"));
  await assert.rejects(
    boundedCall(adapter, "stuck", {}, { signal: controller.signal }),
    /stopped/,
  );
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-acceptance-"));
  await mkdir(resolve(root, "source"));
  const manifest = [];
  for (const path of ["Cargo.lock", "package-lock.json"]) {
    await writeFile(resolve(root, "source", path), path);
    manifest.push({ path, bytes: Buffer.byteLength(path), sha256: hash(path) });
  }
  const candidate = {
    schema_version: 1,
    status: "built",
    source_directory: "source",
    source_manifest: manifest,
    source_manifest_sha256: digestJson(manifest),
    production_manifest: manifest,
    production_manifest_sha256: digestJson(manifest),
    image: { id: "sha256:" + hash("image"), binary_sha256: binaries },
    git: { head: "f".repeat(40), diff_sha256: hash("") },
  };
  await writeFile(resolve(root, "candidate.json"), JSON.stringify(candidate));
  await writeFile(resolve(root, "video"), "licensed-fixture");
  await writeFile(
    resolve(root, "samples.json"),
    JSON.stringify({
      schema_version: 1,
      files: [
        {
          path: "video",
          bytes: 16,
          sha256: hash("licensed-fixture"),
          authorization: "self-owned",
        },
      ],
    }),
  );
  // No real time, sockets, rendering, network changes, or product processes.
  let now = 100000;
  const clock = {
    now: () => now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      now += Math.max(0, ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const config = {
    scope: "synthetic",
    candidate_path: resolve(root, "candidate.json"),
    samples_path: resolve(root, "samples.json"),
    environment: {
      schema_version: 1,
      hardware: { os: "synthetic" },
      tools: { browser: "synthetic" },
    },
    command: ["node", "synthetic-fixture"],
    duration_seconds: 12,
    warmup_seconds: 0,
  };
  const clients = [
    { client_id: "a", clock_id: "epoch-a", room: "r1" },
    { client_id: "b", clock_id: "epoch-b", room: "r1" },
  ];
  const offsets = { a: 900, b: 4000 };
  const calls = [];
  let lastSample = now;
  const adapter = {
    schema_version: 1,
    mode: "synthetic",
    id: "unit-fixture",
    async prepare(input) {
      calls.push("prepare");
      return {
        owned_resource_ids: ["worker"],
        host_mutations: false,
        isolated_fault_targets: true,
      };
    },
    async artifactIdentity() {
      return {
        observation_id: "fixture-identity",
        image_id: candidate.image.id,
        binary_sha256: candidate.image.binary_sha256,
        source_sha256: candidate.source_manifest_sha256,
      };
    },
    async inspectIsolation({ run_id }) {
      return {
        run_id,
        namespace_id: "fixture-namespace",
        host_network: false,
        interfaces: ["fixture-interface"],
      };
    },
    async applyNetwork({ isolation }) {
      calls.push("applyNetwork");
      return {
        mode: "synthetic",
        namespace_id: isolation.namespace_id,
        observation_id: "fixture-apply",
        settings: { synthetic: true },
      };
    },
    async restoreNetwork() {
      calls.push("restoreNetwork");
      return { restored: true };
    },
    async clients() {
      return clients;
    },
    async clockExchange({ client_id, clock_id }) {
      return {
        client_id,
        clock_id,
        client_receive_ms: now - offsets[client_id],
        client_send_ms: now - offsets[client_id],
      };
    },
    async timecodeChecks() {
      return clients.map(({ client_id }) => ({
        client_id,
        method: "visible-frame-timecode",
        observation_id: "fixture-timecode",
        frame_sha256: hash("synthetic-only-frame"),
        visible_original_position_ms: 1000,
        sample_original_position_ms: 1000,
        tolerance_ms: 40,
      }));
    },
    async probeNetwork() {
      return {
        mode: "synthetic",
        observation_id: "fixture-probe",
        method: "synthetic",
        sent_packets: 1000,
        lost_packets: 0,
        rtt_ms: 20,
        jitter_ms: 1,
        uplink_bps: 10000000,
        downlink_bps: 10000000,
        uplink_delay_ms: 10,
        downlink_delay_ms: 10,
        video_demand_bps: 1000000,
        start_ms: now,
        end_ms: now + 1,
      };
    },
    async sample() {
      const result = {
        clients: clients.map((client) => ({
          ...client,
          monotonic_ms: now - offsets[client.client_id],
          original_position_ms: now,
          playback_rate: 1,
          playing: true,
          foreground: true,
          buffering: false,
          seeking: false,
          playback_intervals: [
            {
              start_ms: lastSample,
              end_ms: now,
              state: "playing",
              foreground: true,
              expected_playing: true,
            },
          ],
        })),
        authority: {
          r1: {
            reference_ms: now,
            original_position_ms: now,
            playback_rate: 1,
            playing: true,
          },
        },
      };
      lastSample = now;
      return result;
    },
    async perform(event) {
      calls.push(event.kind);
      let evidence = {};
      if (event.kind === "phase")
        evidence = {
          mode: event.phase.mode,
          requested_concurrency: event.phase.concurrency,
          active_concurrency: event.phase.concurrency,
          controlled_rejections: 0,
        };
      if (event.kind === "loop-playback")
        evidence = { presented_frames: 25, original_advanced_ms: 1000 };
      if (event.kind === "slice")
        evidence = { completed_segments: 1, failed_segments: 0 };
      if (event.kind === "seek")
        evidence = {
          requested_original_ms: 1000,
          presented_original_ms: 1001,
          presented_frames: 1,
        };
      if (["join", "leave"].includes(event.kind))
        evidence = {
          members_before: 3,
          members_after: event.kind === "join" ? 4 : 2,
          authority_snapshot_verified: true,
        };
      if (event.kind === "cache-evict")
        evidence = {
          evicted_bytes: 100,
          cache_bytes: 1000,
          cache_quota_bytes: 2000,
          active_files_removed: 0,
        };
      if (event.kind === "fault")
        evidence = {
          fault: event.fault,
          injected_at_ms: now,
          recovered_at_ms: now,
          signal: "SIGKILL",
          old_attempt_writes: 0,
          generation_drain_verified: true,
          external_supervisor_verified: true,
          false_acks: 0,
          writes_after_lock_loss: 0,
          isolated_volume: true,
          explained_failures: 1,
          corrupt_successes: 0,
          orphan_processes: 0,
          new_requests_denied: 1,
          long_stream_close_ms: 500,
        };
      return {
        mode: "synthetic",
        action: event.kind,
        observation_id: "fixture-work",
        completed: true,
        evidence,
      };
    },
    async sampleResources({ phase }) {
      return [
        {
          entity: "worker",
          instance_id: "instance1",
          phase: phase.id,
          observation_id: "fixture-resource",
          rss_bytes: 100000,
          fd_count: 10,
          socket_count: 2,
          process_count: 3,
          cache_bytes: 1000,
          cache_quota_bytes: 2000,
        },
      ];
    },
    async collectArtifacts() {
      calls.push("collectArtifacts");
      return {
        scope: "synthetic",
        logs: [{ password: "do-not-publish", message: "fixture" }],
      };
    },
    async cleanup() {
      calls.push("cleanup");
      return { confirmed: true };
    },
  };
  return {
    root,
    config,
    adapter,
    clock,
    calls,
    candidate,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function soakConfig(config) {
  return {
    ...config,
    sample_seconds: 1,
    phase_seconds: 12,
    identity_seconds: 2,
    phases: [{ id: "direct-1", mode: "direct", concurrency: 1 }],
    cadence_seconds: Object.fromEntries(
      [
        "loop-playback",
        "slice",
        "seek",
        "join",
        "leave",
        "cache-evict",
        "fault",
      ].map((name) => [name, 2]),
    ),
    resource_limits: Object.fromEntries(
      [
        "rss_bytes",
        "fd_count",
        "socket_count",
        "process_count",
        "cache_bytes",
      ].map((name) => [
        name,
        { maximum_slope_per_hour: 0, maximum_late_growth: 0 },
      ]),
    ),
  };
}

test("network coordinator executes independent calibrations, evidence chain and restore with synthetic scope", async () => {
  const f = await fixture();
  try {
    const report = await runNetwork({
      ...f,
      output: resolve(f.root, "network"),
      config: {
        ...f.config,
        scenarios: ["N1"],
        scopes: ["shared"],
        repeats: 1,
      },
    });
    assert.equal(report.result, "passed", report.failure?.message);
    assert.equal(report.scope, "synthetic");
    assert.equal(report.accepted, false);
    assert.equal(report.runs[0].summary.rooms[0].peer_error_ms.p95, 0);
    assert.equal(f.calls.filter((call) => call === "restoreNetwork").length, 1);
    const journal = (
      await readFile(resolve(f.root, "network", "observations.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    let previous = "0".repeat(64);
    for (const { sha256, ...record } of journal) {
      assert.equal(record.previous_sha256, previous);
      assert.equal(digestJson(record), sha256);
      previous = sha256;
    }
    assert.ok(journal.some((record) => record.kind === "calibration"));
    assert.ok(
      !(
        await readFile(
          resolve(f.root, "network", "adapter-artifacts.json"),
          "utf8",
        )
      ).includes("do-not-publish"),
    );
  } finally {
    await f.cleanup();
  }
});

test("soak executes all workload types and phase-matched resource trends without claiming actual 72h", async () => {
  const f = await fixture();
  try {
    const report = await runSoak({
      ...f,
      output: resolve(f.root, "soak"),
      config: soakConfig(f.config),
    });
    assert.equal(report.result, "passed", report.failure?.message);
    assert.equal(report.scope, "synthetic");
    assert.equal(report.accepted, false);
    assert.equal(report.resource_trends[0].count, 12);
    for (const action of [
      "loop-playback",
      "slice",
      "seek",
      "join",
      "leave",
      "cache-evict",
      "fault",
    ])
      assert.ok(report.completed_counts[action] > 0);
    assert.equal(report.segments.length, 1);
    assert.equal(
      report.segments[0].monotonic_end_ms -
        report.segments[0].monotonic_start_ms,
      12000,
    );
  } finally {
    await f.cleanup();
  }
});

test("candidate mutation aborts ongoing soak, captures failure and cleans owned resources", async () => {
  const f = await fixture();
  try {
    const original = f.adapter.perform;
    f.adapter.perform = async (event) => {
      const receipt = await original(event);
      if (event.kind === "loop-playback")
        await writeFile(resolve(f.root, "source", "Cargo.lock"), "tampered");
      return receipt;
    };
    const report = await runSoak({
      ...f,
      output: resolve(f.root, "changed"),
      config: soakConfig(f.config),
    });
    assert.equal(report.result, "failed");
    assert.match(report.failure.message, /changed/);
    assert.ok(
      f.calls.includes("cleanup") && f.calls.includes("collectArtifacts"),
    );
    assert.equal(report.source_unchanged, undefined);
    assert.ok(
      (
        await readFile(resolve(f.root, "changed", "failed-report.json"), "utf8")
      ).includes("tampered") === false,
    );
  } finally {
    await f.cleanup();
  }
});

test("partial network setup failure still restores isolation and records failure artifacts", async () => {
  const f = await fixture();
  try {
    f.adapter.applyNetwork = async () => {
      throw Error("fixture apply failed");
    };
    const report = await runNetwork({
      ...f,
      output: resolve(f.root, "failed"),
      config: {
        ...f.config,
        scenarios: ["N1"],
        scopes: ["shared"],
        repeats: 1,
      },
    });
    assert.equal(report.result, "failed");
    assert.ok(f.calls.includes("restoreNetwork"));
    assert.ok(f.calls.includes("cleanup"));
  } finally {
    await f.cleanup();
  }
});

test("owned host network refusal happens before any profile application", async () => {
  const f = await fixture();
  try {
    f.adapter.inspectIsolation = async ({ run_id }) => ({
      run_id,
      host_network: true,
      namespace_id: "host",
      interfaces: ["eth0"],
    });
    const report = await runNetwork({
      ...f,
      output: resolve(f.root, "host"),
      config: {
        ...f.config,
        scenarios: ["N1"],
        scopes: ["shared"],
        repeats: 1,
      },
    });
    assert.equal(report.result, "failed");
    assert.match(report.failure.message, /host network/);
    assert.ok(!f.calls.includes("applyNetwork"));
  } finally {
    await f.cleanup();
  }
});

test("dry runs never load adapters or claim observations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rainsync-dry-"));
  try {
    for (const [name, runner] of [
      ["network", runNetwork],
      ["soak", runSoak],
    ]) {
      const report = await runner({
        config: {},
        output: resolve(root, name),
        dry_run: true,
      });
      assert.equal(report.result, "dry-run");
      assert.equal(report.accepted, false);
      assert.equal(report.cleanup_confirmed, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("network bandwidth and recovery gate cannot pass by elapsed time alone", () => {
  const summary = {
    pooled: { valid_ratio: 1 },
    rooms: [
      {
        valid: 10,
        peer_error_ms: { p95: 100 },
        authority_error_ms: { count: 20 },
      },
    ],
  };
  const probes = [{ rtt_ms: 20, downlink_bps: 700, video_demand_bps: 1000 }];
  assert.equal(
    assessNetworkRun({ id: "N3" }, summary, {
      probes,
      recoveries: [],
      invariants: [],
    }).passed,
    false,
  );
  assert.equal(
    assessNetworkRun({ id: "N4" }, summary, {
      probes,
      recoveries: [],
      invariants: [],
    }).passed,
    false,
  );
});

test("resource trends separate phases and process generations, reject quota overflow", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    entity: "worker",
    phase: i % 2 ? "low" : "high",
    instance_id: "p1",
    elapsed_ms: i * 1000,
    rss_bytes: i % 2 ? 100 : 1000,
    fd_count: 10,
    socket_count: 3,
    process_count: 2,
    cache_bytes: 100,
    cache_quota_bytes: 100,
  }));
  const trends = resourceTrends(rows);
  assert.equal(trends.length, 2);
  assert.ok(
    trends.every((trend) => trend.metrics.rss_bytes.slope_per_hour === 0),
  );
  assert.throws(
    () => resourceTrends([{ ...rows[0], cache_bytes: 101 }]),
    /quota/,
  );
});

test("synthetic observations cannot be relabelled as formal and cleanup failure never passes", async () => {
  const f = await fixture();
  try {
    const formal = await runSoak({
      ...f,
      output: resolve(f.root, "formal"),
      config: { ...f.config, scope: "formal", duration_seconds: 259200 },
    });
    assert.equal(formal.result, "failed");
    assert.match(formal.failure.message, /synthetic/);
    assert.ok(!f.calls.includes("prepare"));
    f.adapter.cleanup = async () => ({ confirmed: false });
    const cleanup = await runSoak({
      ...f,
      output: resolve(f.root, "cleanup"),
      config: soakConfig(f.config),
    });
    assert.equal(cleanup.result, "failed");
    assert.equal(cleanup.cleanup_confirmed, false);
  } finally {
    await f.cleanup();
  }
});

test("new unlisted source input invalidates frozen candidate and preserves failure evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(
      resolve(f.root, "source", "unlisted.mjs"),
      "export const changed = true;",
    );
    const report = await runSoak({
      ...f,
      output: resolve(f.root, "unlisted"),
      config: soakConfig(f.config),
    });
    assert.equal(report.result, "failed");
    assert.match(report.failure.message, /unlisted/);
    assert.ok(!f.calls.includes("prepare"));
  } finally {
    await f.cleanup();
  }
});

test("aborted network run captures interruption and cleans without applying profiles", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort(Error("fixture stop"));
  try {
    const report = await runNetwork({
      ...f,
      signal: controller.signal,
      output: resolve(f.root, "interrupted"),
      config: {
        ...f.config,
        scenarios: ["N1"],
        scopes: ["shared"],
        repeats: 1,
      },
    });
    assert.equal(report.result, "interrupted");
    assert.ok(!f.calls.includes("applyNetwork"));
    assert.ok(f.calls.includes("cleanup"));
  } finally {
    await f.cleanup();
  }
});

function multiResourceAdapter(f, transform = (rows) => rows) {
  const prepare = f.adapter.prepare,
    sampleResources = f.adapter.sampleResources;
  f.adapter.prepare = async (input) => ({
    ...(await prepare(input)),
    owned_resource_ids: ["server", "worker", "agent"],
  });
  f.adapter.sampleResources = async (input) => {
    const [row] = await sampleResources(input);
    return transform(
      ["server", "worker", "agent"].map((entity) => ({
        ...row,
        entity,
        instance_id: entity + "-instance",
      })),
    );
  };
}

for (const [name, transform, expected] of [
  [
    "missing",
    (rows) => rows.filter((row) => row.entity === "server"),
    { missing: ["worker", "agent"], duplicates: [], unavailable: [] },
  ],
  [
    "duplicate",
    (rows) => [rows[0], rows[0], rows[2]],
    { missing: ["worker"], duplicates: ["server"], unavailable: [] },
  ],
  [
    "unavailable",
    (rows) =>
      rows.map((row) =>
        row.entity === "agent"
          ? {
              entity: row.entity,
              unavailable: true,
              reason: "container stopped",
            }
          : row,
      ),
    { missing: [], duplicates: [], unavailable: ["agent"] },
  ],
]) {
  test(`soak rejects ${name} expected resources and preserves coverage failure evidence`, async () => {
    const f = await fixture();
    try {
      multiResourceAdapter(f, transform);
      const output = resolve(f.root, "coverage-" + name);
      const report = await runSoak({
        ...f,
        output,
        config: soakConfig(f.config),
      });
      assert.equal(report.result, "failed");
      assert.match(
        report.failure.message,
        /each expected resource exactly once and available/,
      );
      assert.equal(report.completed_counts["sample-resources"], undefined);
      assert.equal(report.resource_trends, undefined);
      assert.equal(report.cleanup_confirmed, true);
      assert.equal(report.failure_samples.length, 1);
      for (const [key, value] of Object.entries(expected))
        assert.deepEqual(report.failure_samples[0].coverage[key], value);
      const records = (
        await readFile(resolve(output, "observations.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        records.find((record) => record.kind === "resource-coverage").value
          .complete,
        false,
      );
      assert.ok(
        records.some((record) => record.kind === "failed-resource-sample"),
      );
      assert.deepEqual(
        records
          .filter((record) => record.kind === "resource-unavailable")
          .map((record) => record.value.entity),
        expected.missing,
      );
      assert.ok(!records.some((record) => record.kind === "resource-sample"));
    } finally {
      await f.cleanup();
    }
  });
}

test("soak requires and records complete duplicate-free resource coverage at every sample", async () => {
  const f = await fixture();
  try {
    multiResourceAdapter(f);
    const output = resolve(f.root, "full-coverage");
    const report = await runSoak({
      ...f,
      output,
      config: soakConfig(f.config),
    });
    assert.equal(report.result, "passed", report.failure?.message);
    assert.equal(report.completed_counts["sample-resources"], 12);
    assert.equal(report.resource_trends.length, 3);
    assert.ok(report.resource_trends.every((trend) => trend.count === 12));
    const records = (
      await readFile(resolve(output, "observations.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    const coverage = records.filter(
      (record) => record.kind === "resource-coverage",
    );
    assert.equal(coverage.length, 12);
    assert.ok(
      coverage.every(
        ({ value }) =>
          value.complete &&
          value.expected_resource_ids.length === 3 &&
          value.observed_resource_ids.length === 3,
      ),
    );
    assert.equal(
      records.filter((record) => record.kind === "resource-sample").length,
      36,
    );
  } finally {
    await f.cleanup();
  }
});

test("soak rejects duplicate declared resource identities before sampling", async () => {
  const f = await fixture();
  try {
    const prepare = f.adapter.prepare;
    f.adapter.prepare = async (input) => ({
      ...(await prepare(input)),
      owned_resource_ids: ["worker", "worker"],
    });
    const report = await runSoak({
      ...f,
      output: resolve(f.root, "duplicate-prepared"),
      config: soakConfig(f.config),
    });
    assert.equal(report.result, "failed");
    assert.match(
      report.failure.message,
      /distinct nonempty owned resource identities/,
    );
    assert.equal(report.counts["sample-resources"], undefined);
    assert.equal(report.cleanup_confirmed, true);
  } finally {
    await f.cleanup();
  }
});

test("later missing resources cannot shrink the immutable expected population", async () => {
  const f = await fixture();
  try {
    multiResourceAdapter(f);
    const prepare = f.adapter.prepare,
      sampleResources = f.adapter.sampleResources;
    let prepared,
      count = 0;
    f.adapter.prepare = async (input) => (prepared = await prepare(input));
    f.adapter.sampleResources = async (input) => {
      const rows = await sampleResources(input);
      if (++count === 1) return rows;
      prepared.owned_resource_ids.splice(1);
      return rows.slice(0, 1);
    };
    const report = await runSoak({
      ...f,
      output: resolve(f.root, "late-missing"),
      config: soakConfig(f.config),
    });
    assert.equal(report.result, "failed");
    assert.equal(report.completed_counts["sample-resources"], 1);
    assert.deepEqual(report.failure_samples[0].coverage.expected_resource_ids, [
      "server",
      "worker",
      "agent",
    ]);
    assert.deepEqual(report.failure_samples[0].coverage.missing, [
      "worker",
      "agent",
    ]);
    assert.equal(report.cleanup_confirmed, true);
  } finally {
    await f.cleanup();
  }
});

test("redaction covers nested source/encryption keys and DSNs across field-name styles", () => {
  const safe = "a".repeat(64);
  const input = {
    nested: [
      {
        SOURCE_ENCRYPTION_KEY: "synthetic-source-encryption-value",
        source_key: "synthetic-source-value",
        EncryptionKey: "synthetic-encryption-value",
      },
      {
        "Source-Key": "synthetic-source-kebab",
        DatabaseUrl:
          "postgres://synthetic-user:synthetic-password@db.test/rainsync?sslkey=synthetic-key",
        DATABASE_DSN: "host=db.test password=synthetic-dsn-password",
        "pg.DSN": "synthetic-dsn-value",
      },
      {
        connectionString: "host=db.test password=synthetic-connection-password",
        POSTGRESQL_URI:
          "postgresql://synthetic-user:synthetic-uri-password@db.test/rainsync",
        db_dsn: "synthetic-db-dsn",
      },
    ],
    source_sha256: safe,
    production_manifest_sha256: safe,
    binary_sha256: { "rainsync-server": safe },
    source_key_sha256: safe,
    SOURCE_ENCRYPTION_KEY_SHA256: safe.toUpperCase(),
    source_key_sha256_invalid: "synthetic-not-a-digest",
    source_key_sha256_disguised: { raw: "synthetic-not-a-digest-object" },
    source_id: "public-source-id",
  };
  const result = redactEvidence(input),
    text = JSON.stringify(result);
  assert.ok(!text.includes("synthetic-"));
  for (const object of result.nested)
    assert.ok(Object.values(object).every((value) => value === "[REDACTED]"));
  assert.equal(result.source_sha256, safe);
  assert.equal(result.production_manifest_sha256, safe);
  assert.equal(result.binary_sha256["rainsync-server"], safe);
  assert.equal(result.source_key_sha256, safe);
  assert.equal(result.SOURCE_ENCRYPTION_KEY_SHA256, safe.toUpperCase());
  assert.equal(result.source_key_sha256_invalid, "[REDACTED]");
  assert.equal(result.source_key_sha256_disguised, "[REDACTED]");
  assert.equal(result.source_id, "public-source-id");
});

test("redaction strips PostgreSQL and WebSocket URL credentials, query and fragments", () => {
  for (const scheme of [
    "postgres",
    "postgresql",
    "ws",
    "wss",
    "POSTGRESQL",
    "WSS",
  ]) {
    const input = `${scheme}://synthetic-user:synthetic-password@example.test:1234/path?token=synthetic-query#synthetic-fragment`;
    const result = redactEvidence({ message: input, error: Error(input) });
    const text = JSON.stringify(result);
    assert.ok(!text.includes("synthetic-"), scheme);
    assert.match(result.message, /example\.test:1234\/path$/);
    assert.ok(
      !result.message.includes("@") &&
        !result.message.includes("?") &&
        !result.message.includes("#"),
    );
  }
});

test("redaction removes source-key and database assignments from free-text failures", () => {
  const assignments = [
    "SOURCE_ENCRYPTION_KEY=synthetic-key-value",
    'sourceKey="synthetic source value with spaces"',
    "Encryption-Key: 'synthetic encryption value'",
    '"source_key":"synthetic-json-value"',
    "DATABASE_URL=postgres://synthetic-user:synthetic-password@db.test/rainsync?sslkey=synthetic-query",
    "databaseDsn='host=db.test user=synthetic-user password=synthetic-dsn-password'",
    "DSN=synthetic-dsn-value",
    'ConnectionString="Host=db.test;Password=synthetic-password;"',
  ];
  for (const assignment of assignments) {
    const result = redactEvidence(Error(`failed with ${assignment}`));
    assert.ok(
      !JSON.stringify(result).includes("synthetic"),
      assignment.split(/[=:]/)[0],
    );
    assert.ok(result.message.includes("[REDACTED-SECRET]"));
  }
  const safe = "b".repeat(64);
  assert.equal(
    redactEvidence(`source_sha256=${safe} source_key_sha256=${safe}`),
    `source_sha256=${safe} source_key_sha256=${safe}`,
  );
});

test("upstream reconciliation locks current resource before exact authorization and defers busy grants", async () => {
  const source = await readFile(new URL("../crates/persistence/src/upstream_reservations.rs", import.meta.url), "utf8");
  const reconcile = source.slice(source.indexOf("pub async fn reconcile("), source.indexOf("pub async fn recover("));
  const cte = reconcile.match(/WITH locked_sessions AS MATERIALIZED \(([\s\S]*?)\)\s*UPDATE upstream_reservations u/);
  assert.ok(cte, "resource-check input is an explicit materialized locking CTE");
  const locked = cte[1].replace(/\s+/g, " ");
  assert.match(locked, /SELECT p\.id,p\.media_id,p\.resource,p\.room_id,p\.user_id,p\.stopped,p\.expires_at,p\.generation/);
  assert.match(locked, /candidate\.id=p\.id AND candidate\.state='active'/);
  assert.match(locked, /ORDER BY p\.id FOR SHARE OF p SKIP LOCKED/);
  assert.doesNotMatch(locked, /playback_source_allowed|\bLIMIT\b/);
  const decision = reconcile.slice(reconcile.indexOf("UPDATE upstream_reservations u")).replace(/\s+/g, " ");
  assert.match(decision, /NOT EXISTS\(SELECT 1 FROM playback_sessions present WHERE present\.id=u\.id\) OR EXISTS\(SELECT 1 FROM locked_sessions p WHERE p\.id=u\.id AND NOT EXISTS\(/);
  assert.match(decision, /JOIN room_members m ON m\.room_id=p\.room_id AND m\.user_id=p\.user_id/);
  assert.match(decision, /WHERE s\.room_id=p\.room_id AND NOT p\.stopped AND playback_source_allowed\(p\.media_id,p\.resource,p\.id\) AND p\.expires_at>clock_timestamp\(\) AND \(s\.state->>'media_generation'\)::bigint=p\.generation/);
  assert.match(decision, /r\.owner_epoch=\$1 AND r\.lease_until>clock_timestamp\(\)/);
  assert.match(decision, /cleanup_attempts>=5 OR cleanup_deadline<=clock_timestamp\(\)/);
  const migration = await readFile(new URL("../migrations/0070_private_libraries.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE FUNCTION playback_source_allowed\(media uuid,resource jsonb,session uuid\) RETURNS boolean LANGUAGE sql VOLATILE/);
  assert.match(migration, /p\.id=\$3 AND p\.media_id=\$1 AND p\.resource=\$2/);
});

test("upstream policy retirement checks locked identity and resource inside existing bounded transaction", async () => {
  const source = await readFile(new URL("../apps/server/src/upstream_policy.rs", import.meta.url), "utf8");
  const retire = source.slice(source.indexOf("async fn retire("), source.indexOf("async fn ready("));
  const cte = retire.match(/WITH locked_sessions AS MATERIALIZED \(([\s\S]*?)\)\s*UPDATE playback_sessions target/);
  assert.ok(cte);
  const locked = cte[1].replace(/\s+/g, " ");
  assert.match(locked, /p\.resource,p\.user_id,p\.room_id,p\.auth_login_hash,p\.auth_membership_epoch,s\.kind/);
  assert.match(locked, /WHERE NOT p\.stopped ORDER BY p\.id FOR UPDATE OF p SKIP LOCKED/);
  assert.doesNotMatch(locked, /playback_origin_allowed|playback_source_allowed|\bLIMIT\b/);
  const decision = retire.slice(retire.indexOf("UPDATE playback_sessions target")).replace(/\s+/g, " ");
  assert.match(decision, /FROM locked_sessions p WHERE target\.id=p\.id AND NOT target\.stopped/);
  assert.match(decision, /NOT playback_origin_allowed\(p\.user_id,p\.room_id,p\.auth_login_hash,p\.auth_membership_epoch\)/);
  assert.match(decision, /p\.kind IN\('jellyfin','emby'\) AND NOT playback_source_allowed\(p\.media_id,p\.resource,p\.id\)/);
  assert.ok(retire.indexOf("UPDATE playback_sessions target") < retire.indexOf("cancel_jobs("));
  assert.ok(retire.indexOf("cancel_jobs(") < retire.indexOf("UPDATE upstream_reservations u"));
  assert.match(retire, /bounded\(async/);
  assert.match(source, /DATABASE_BUDGET: Duration = Duration::from_millis\(500\)/);
  assert.match(source, /set_config\('statement_timeout','350ms',true\),set_config\('lock_timeout','250ms',true\)/);
});
