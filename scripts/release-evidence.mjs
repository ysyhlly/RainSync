// Preparation and evidence validation only. This tool does not start workloads,
// mutate network policy, deploy, migrate a database, or mark missing gates passed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  availableParallelism,
  arch,
  cpus,
  freemem,
  platform,
  release,
  totalmem,
} from "node:os";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
export const digestJson = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function inventory() {
  const probe = async (program, args, options = {}) => {
    try {
      const { stdout } = await execute(program, args, {
        timeout: 10000,
        maxBuffer: 16384,
        encoding: "utf8",
        ...options,
      });
      return {
        observed: true,
        exit_code: 0,
        version: stdout.trim().split("\n")[0],
      };
    } catch (error) {
      return {
        observed: false,
        exit_code: typeof error.code === "number" ? error.code : null,
      };
    }
  };
  const dockerEnv = { ...process.env };
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete dockerEnv[name];
  const postgres = process.env.RAINSYNC_NATIVE_POSTGRES_BIN
    ? resolve(process.env.RAINSYNC_NATIVE_POSTGRES_BIN, "postgres")
    : "postgres";
  const [node, ffmpeg, ffprobe, pg, browser, docker] = await Promise.all([
    probe(process.execPath, ["--version"]),
    probe("ffmpeg", ["-version"]),
    probe("ffprobe", ["-version"]),
    probe(postgres, ["--version"]),
    probe(process.env.RAINSYNC_BROWSER_EXECUTABLE ?? "chromium", ["--version"]),
    probe(
      "docker",
      [
        "--host=unix:///var/run/docker.sock",
        "info",
        "--format",
        "{{.ServerVersion}} {{.Driver}}",
      ],
      { env: dockerEnv },
    ),
  ]);
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    hardware: {
      os: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model,
      available_cpus: availableParallelism(),
      memory_bytes: totalmem(),
      free_memory_bytes: freemem(),
    },
    tools: {
      node,
      ffmpeg,
      ffprobe,
      postgres: pg,
      browser_binary: browser,
      docker_local_daemon: docker,
    },
    capabilities: {
      browser_launch: "not-checked",
      docker_image_pull: "not-checked",
      real_old_database: "not-provided",
      android_device: "not-provided",
      ios_device: "not-provided",
      arm64_execution:
        arch() === "arm64" ? "requires-real-artifact-check" : "not-available",
      two_hour_resource_lease: "unconfirmed",
      seventy_two_hour_resource_lease: "unconfirmed",
    },
    scope:
      "binary/daemon availability only; no product, mobile, duration or release acceptance",
  };
}

function safeRelative(path) {
  assert.ok(
    typeof path === "string" &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.includes(":"),
    "unsafe candidate path",
  );
  assert.ok(
    path.split("/").every((part) => part && part !== "." && part !== ".."),
    "candidate path escapes source",
  );
  return path;
}

export async function verifyCandidate(candidatePath) {
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  assert.equal(candidate.schema_version, 1, "unsupported frozen candidate");
  assert.ok(
    ["source-frozen", "built"].includes(candidate.status),
    "candidate is not frozen",
  );
  assert.equal(
    candidate.source_directory,
    "source",
    "unsupported source directory",
  );
  assert.ok(
    Array.isArray(candidate.source_manifest) &&
      candidate.source_manifest.length > 0,
    "source manifest required",
  );
  assert.equal(
    digestJson(candidate.source_manifest),
    candidate.source_manifest_sha256,
    "source manifest digest mismatch",
  );
  const source = resolve(dirname(candidatePath), "source");
  assert.equal(
    await realpath(source),
    source,
    "source directory must not be linked",
  );
  const paths = new Set();
  for (const entry of candidate.source_manifest) {
    const path = safeRelative(entry.path);
    assert.ok(!paths.has(path), "duplicate candidate path");
    paths.add(path);
    const absolute = resolve(source, path);
    if (entry.deleted) {
      await assert.rejects(
        lstat(absolute),
        { code: "ENOENT" },
        "deleted candidate input reappeared",
      );
      continue;
    }
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, "invalid source hash");
    const status = await lstat(absolute);
    assert.ok(
      status.isFile() && !status.isSymbolicLink(),
      "candidate input must be a regular file",
    );
    assert.equal(
      await realpath(absolute),
      absolute,
      "candidate input parent must not be linked",
    );
    assert.equal(status.size, entry.bytes, "candidate input size changed");
    assert.equal(
      await hashFile(absolute),
      entry.sha256,
      "candidate input hash changed",
    );
  }
  // Runtime/build outputs are not source inputs. Any other added source file
  // invalidates the freeze, even when all originally listed hashes still match.
  const scan = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".runtime", "node_modules", "target", "dist"].includes(entry.name))
        continue;
      const path = prefix + entry.name;
      if (entry.isDirectory())
        await scan(resolve(directory, entry.name), path + "/");
      else
        assert.ok(
          paths.has(path) && !entry.isSymbolicLink(),
          "unlisted or linked candidate source input: " + path,
        );
    }
  };
  await scan(source);
  assert.ok(
    ["Cargo.lock", "package-lock.json"].every((path) =>
      candidate.source_manifest.some(
        (entry) => entry.path === path && !entry.deleted,
      ),
    ),
    "lockfiles must be bound",
  );
  if (candidate.status === "built") {
    assert.ok(
      Array.isArray(candidate.production_manifest) &&
        candidate.production_manifest.length > 0,
      "production manifest required",
    );
    assert.equal(
      digestJson(candidate.production_manifest),
      candidate.production_manifest_sha256,
      "production manifest digest mismatch",
    );
    for (const entry of candidate.production_manifest)
      assert.ok(
        candidate.source_manifest.some(
          (source) => digestJson(source) === digestJson(entry),
        ),
        "production input differs from frozen source",
      );
    assert.match(
      candidate.image?.id ?? "",
      /^sha256:[0-9a-f]{64}$/,
      "pinned image ID required",
    );
    for (const name of [
      "rainsync-server",
      "rainsync-media-worker",
      "rainsync-nas-agent",
    ])
      assert.match(
        candidate.image.binary_sha256?.[name] ?? "",
        /^[0-9a-f]{64}$/,
        "candidate must bind all backend binaries",
      );
  }
  return { candidate, source };
}

export async function verifySamples(manifestPath) {
  const samples = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(
    samples.schema_version,
    1,
    "unsupported acceptance sample inventory",
  );
  assert.ok(
    Array.isArray(samples.files) && samples.files.length > 0,
    "authorized sample files required",
  );
  const paths = new Set();
  for (const entry of samples.files) {
    const path = safeRelative(entry.path);
    assert.ok(!paths.has(path), "duplicate sample path");
    paths.add(path);
    assert.ok(
      ["self-owned", "licensed"].includes(entry.authorization),
      "sample authorization must be recorded",
    );
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, "invalid sample hash");
    const absolute = resolve(dirname(manifestPath), path);
    assert.equal(
      await realpath(absolute),
      absolute,
      "sample path must not be linked",
    );
    const status = await lstat(absolute);
    assert.ok(
      status.isFile() && !status.isSymbolicLink(),
      "sample must be a regular file",
    );
    assert.equal(status.size, entry.bytes, "sample size differs from evidence");
    assert.equal(
      await hashFile(absolute),
      entry.sha256,
      "sample bytes differ from evidence",
    );
  }
  return samples;
}

export function preparePlan(candidate, environment, samples = null) {
  assert.equal(environment.schema_version, 1);
  const built = candidate.status === "built";
  const gate = (id, seconds, entry, prerequisites = []) => ({
    id,
    minimum_continuous_seconds: seconds,
    status: "not-run",
    entry,
    prerequisites,
    accepted: false,
  });
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    mode: "prepare-only",
    release_ready: false,
    binding: {
      source_sha256: candidate.source_manifest_sha256,
      production_sha256: candidate.production_manifest_sha256 ?? null,
      image_id: candidate.image?.id ?? null,
      binary_sha256: candidate.image?.binary_sha256 ?? null,
      environment_sha256: digestJson(environment),
      samples_sha256: samples ? digestJson(samples) : null,
    },
    prerequisites: {
      final_candidate_approved: false,
      candidate_built: built,
      actual_image_verified: false,
      authorized_sample_inventory: samples !== null,
      resource_lease_confirmed: false,
    },
    gates: [
      gate(
        "control-10x10",
        3600,
        [
          "node",
          "tests/control-load.mjs",
          "--duration-seconds=3600",
          "--topology=10x10",
        ],
        ["100 distinct users", "built final candidate; run from frozen source"],
      ),
      gate(
        "control-50x2",
        3600,
        [
          "node",
          "tests/control-load.mjs",
          "--duration-seconds=3600",
          "--topology=50x2",
        ],
        ["100 distinct users", "built final candidate; run from frozen source"],
      ),
      gate(
        "nas-two-hours",
        7200,
        ["node", "tests/nas-soak.mjs", "--duration-seconds=7200"],
        [
          "continuous real browser rendering/NAS transfer",
          "D approved fault/resource matrix",
          "self-owned or licensed samples",
        ],
      ),
      gate(
        "weak-network",
        1800,
        [
          "node",
          "tests/sync-network.mjs",
          "--config=<network-config.json>",
          "--adapter=<approved-adapter.mjs>",
          "--output=<new-directory>",
        ],
        [
          "dedicated isolated network namespace; no host-wide tc",
          "independent clock calibration",
          "N1-N6, >=3 repeats/scenario",
          "approved namespace/probe adapter and actual RTT/loss/bandwidth observations required",
        ],
      ),
      gate(
        "soak-72-hours",
        259200,
        [
          "node",
          "tests/soak.mjs",
          "--config=<soak-config.json>",
          "--adapter=<approved-adapter.mjs>",
          "--output=<new-directory>",
        ],
        [
          "final source/image unchanged for full window",
          "deployment-specific loop/seek/join/leave/cache eviction/F1–F4 adapter required",
          "phase-matched RSS/FD/socket/process/cache trends",
          "D SIGKILL requires external supervisor/cgroup plus startup-generation drain proof; TERM is insufficient",
          "restart from zero after lifecycle-affecting fixes",
        ],
      ),
      gate("device-matrix", null, null, [
        "real Android Chrome, iOS Safari, desktop Safari and arm64 execution",
        "exact OS/browser/hardware/artifact/sample identities",
      ]),
      gate(
        "old-db-recovery",
        null,
        ["node", "deploy/postgres-recovery.mjs", "preflight"],
        [
          "authorized real old database backup",
          "separate source keys/config/Agent custody",
          "total-control migration and supported legacy NAS reconciliation baseline",
          "no delete-history/forged receipts/force-close",
        ],
      ),
    ],
    execution:
      "No workload has been launched. Commands are proposals for the controller after final candidate freeze; network/soak execution requires an explicit approved deployment adapter. Runner presence does not close acceptance gates.",
  };
}

// Evidence envelopes are intentionally stricter than old smoke reports. The
// controller/owners can adapt existing raw reports without changing protocols.
export function assessEvidence(plan, evidence) {
  assert.equal(plan.schema_version, 1);
  assert.equal(evidence.schema_version, 1);
  const gate = plan.gates.find((item) => item.id === evidence.gate);
  assert.ok(gate, "unknown acceptance gate");
  const reasons = [];
  const demand = (condition, reason) => {
    if (!condition) reasons.push(reason);
  };
  demand(evidence.result === "passed", "run failed, incomplete or interrupted");
  demand(
    evidence.scope === "formal",
    "short/historical/simulated evidence cannot close formal gates",
  );
  demand(
    plan.prerequisites.final_candidate_approved === true &&
      plan.prerequisites.candidate_built === true &&
      plan.prerequisites.actual_image_verified === true,
    "controller candidate/image approval pending",
  );
  demand(
    plan.prerequisites.resource_lease_confirmed === true,
    "sustained environment resource lease unconfirmed",
  );
  demand(
    plan.binding.image_id !== null && plan.binding.samples_sha256 !== null,
    "artifact/sample binding missing",
  );
  for (const key of [
    "source_sha256",
    "production_sha256",
    "image_id",
    "environment_sha256",
    "samples_sha256",
  ])
    demand(
      evidence.binding?.[key] === plan.binding[key] &&
        typeof plan.binding[key] === "string" &&
        (key === "image_id" ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/).test(
          plan.binding[key],
        ),
      `evidence ${key} differs from candidate`,
    );
  demand(
    /^[0-9a-f]{64}$/.test(plan.binding.production_sha256 ?? ""),
    "production manifest binding missing or invalid",
  );
  const binaries = [
    "rainsync-server",
    "rainsync-media-worker",
    "rainsync-nas-agent",
  ];
  const plannedBinaries = plan.binding.binary_sha256;
  const observedBinaries = evidence.binding?.binary_sha256;
  demand(
    plannedBinaries !== null &&
      typeof plannedBinaries === "object" &&
      observedBinaries !== null &&
      typeof observedBinaries === "object" &&
      Object.keys(plannedBinaries).length === binaries.length &&
      Object.keys(observedBinaries).length === binaries.length &&
      binaries.every(
        (name) =>
          /^[0-9a-f]{64}$/.test(plannedBinaries[name] ?? "") &&
          observedBinaries[name] === plannedBinaries[name],
      ),
    "three backend binary hashes missing, invalid or different from candidate",
  );
  demand(
    evidence.source_unchanged === true && evidence.artifact_unchanged === true,
    "source or artifact changed during run",
  );
  demand(
    evidence.cleanup_confirmed === true,
    "owned resource cleanup not confirmed",
  );
  demand(
    Array.isArray(evidence.segments) && evidence.segments.length === 1,
    "continuous gates cannot concatenate runs",
  );
  const segment = evidence.segments?.[0];
  const elapsed = segment?.monotonic_end_ms - segment?.monotonic_start_ms;
  demand(
    Number.isFinite(elapsed) &&
      Number.isFinite(segment?.monotonic_start_ms) &&
      Number.isFinite(segment?.monotonic_end_ms) &&
      segment?.monotonic_start_ms >= 0 &&
      elapsed >= 0,
    "monotonic run window missing",
  );
  if (gate.minimum_continuous_seconds !== null)
    demand(
      elapsed >= gate.minimum_continuous_seconds * 1000,
      "continuous duration below formal gate",
    );
  if (gate.id.startsWith("control-")) {
    demand(
      evidence.measurements?.distinct_authenticated_users === 100,
      "100-user population not proven",
    );
    demand(
      evidence.measurements?.topology === gate.id.slice("control-".length),
      "control topology differs",
    );
    demand(
      evidence.measurements?.legal_commands_lost === 0,
      "legal command loss or count missing",
    );
    demand(
      Number.isFinite(evidence.measurements?.ack_p95_ms) &&
        evidence.measurements.ack_p95_ms >= 0 &&
        evidence.measurements.ack_p95_ms <= 300,
      "ACK p95 missing or exceeds 300ms",
    );
    demand(
      evidence.measurements?.full_state_and_persistence_verified === true,
      "full room state/persistence recovery not proven",
    );
  } else if (gate.id === "nas-two-hours") {
    demand(
      evidence.measurements?.real_browser_rendering === true &&
        evidence.measurements?.real_nas_transfer === true,
      "real rendering/NAS chain missing",
    );
    const coverage = evidence.measurements?.rendered_media_ratio;
    demand(
      Number.isFinite(coverage) && coverage >= 0.95 && coverage <= 1,
      "continuous rendered coverage below 95% or missing",
    );
    demand(
      evidence.measurements?.resource_trends_verified === true,
      "resource trends not verified",
    );
  } else {
    // Never turn duration alone into weak-network, device, upgrade or 72h acceptance.
    demand(
      false,
      "scenario-specific owner/controller review required; automatic acceptance is not implemented for this gate",
    );
  }
  return {
    gate: gate.id,
    accepted: reasons.length === 0,
    reasons,
    release_ready: false,
  };
}

async function cli() {
  const [action, ...args] = process.argv.slice(2);
  const options = new Map();
  for (const arg of args) {
    const match =
      /^--(candidate|environment|samples|output|plan|evidence)=(.+)$/.exec(arg);
    assert.ok(
      match && !options.has(match[1]),
      "unsupported or duplicate argument",
    );
    options.set(match[1], resolve(match[2]));
  }
  const output = options.get("output");
  assert.ok(output, "--output=<new-directory> is required");
  let report;
  if (action === "inventory") {
    assert.equal(options.size, 1);
    report = await inventory();
  } else if (action === "plan") {
    assert.ok(
      options.has("candidate") &&
        options.has("environment") &&
        options.size === (options.has("samples") ? 4 : 3),
    );
    const { candidate } = await verifyCandidate(options.get("candidate"));
    const environment = JSON.parse(
      await readFile(options.get("environment"), "utf8"),
    );
    const samples = options.has("samples")
      ? await verifySamples(options.get("samples"))
      : null;
    report = preparePlan(candidate, environment, samples);
  } else if (action === "assess") {
    assert.ok(
      options.has("plan") && options.has("evidence") && options.size === 3,
    );
    report = assessEvidence(
      JSON.parse(await readFile(options.get("plan"), "utf8")),
      JSON.parse(await readFile(options.get("evidence"), "utf8")),
    );
  } else
    throw Error(
      "use inventory, plan or assess; no workloads are started by this tool",
    );
  await mkdir(output, { mode: 0o700 });
  await writeFile(
    resolve(output, `${action}.json`),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `Prepared ${action} evidence: ${resolve(output, `${action}.json`)}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
