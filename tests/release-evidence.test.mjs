import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  preparePlan,
  assessEvidence,
  digestJson,
  verifyCandidate,
  verifySamples,
} from "../scripts/release-evidence.mjs";

const candidate = {
  status: "built",
  source_manifest_sha256: "c".repeat(64),
  production_manifest_sha256: "b".repeat(64),
  image: {
    id: "sha256:" + "a".repeat(64),
    binary_sha256: {
      "rainsync-server": "d".repeat(64),
      "rainsync-media-worker": "e".repeat(64),
      "rainsync-nas-agent": "f".repeat(64),
    },
  },
};
const prepared = () =>
  preparePlan(candidate, { schema_version: 1 }, { self_owned: true });
const approved = () => {
  const plan = prepared();
  plan.prerequisites.final_candidate_approved = true;
  plan.prerequisites.actual_image_verified = true;
  plan.prerequisites.resource_lease_confirmed = true;
  return plan;
};
const controlEvidence = (plan) => ({
  schema_version: 1,
  gate: "control-10x10",
  result: "passed",
  scope: "formal",
  binding: plan.binding,
  source_unchanged: true,
  artifact_unchanged: true,
  cleanup_confirmed: true,
  segments: [{ monotonic_start_ms: 1000, monotonic_end_ms: 3601000 }],
  measurements: {
    distinct_authenticated_users: 100,
    topology: "10x10",
    legal_commands_lost: 0,
    ack_p95_ms: 250,
    full_state_and_persistence_verified: true,
  },
});

test("preparation never approves candidates or marks gates/release ready", () => {
  const plan = prepared();
  assert.equal(plan.release_ready, false);
  assert.equal(plan.prerequisites.final_candidate_approved, false);
  assert.ok(
    plan.gates.every((gate) => gate.status === "not-run" && !gate.accepted),
  );
  assert.ok(
    plan.gates.find((gate) => gate.id === "soak-72-hours").entry === null,
  );
  assert.ok(!assessEvidence(plan, controlEvidence(plan)).accepted);
});

test("smoke, old source and concatenated hours cannot satisfy sustained control", () => {
  const plan = approved(),
    evidence = controlEvidence(plan);
  assert.equal(assessEvidence(plan, evidence).accepted, true);
  for (const change of [
    { scope: "smoke" },
    { segments: [{ monotonic_start_ms: 0, monotonic_end_ms: 25000 }] },
    {
      segments: [
        { monotonic_start_ms: 0, monotonic_end_ms: 1800000 },
        { monotonic_start_ms: 0, monotonic_end_ms: 1800000 },
      ],
    },
    { binding: { ...evidence.binding, source_sha256: "old" } },
    { cleanup_confirmed: false },
    { result: "interrupted" },
    { artifact_unchanged: false },
  ])
    assert.equal(
      assessEvidence(plan, { ...evidence, ...change }).accepted,
      false,
    );
});

test("same image ID cannot hide changed or missing production/binary artifact hashes", () => {
  const plan = approved(),
    evidence = controlEvidence(plan);
  assert.equal(assessEvidence(plan, evidence).accepted, true);
  for (const binding of [
    { ...evidence.binding, production_sha256: "0".repeat(64) },
    { ...evidence.binding, production_sha256: undefined },
    { ...evidence.binding, binary_sha256: undefined },
    { ...evidence.binding, binary_sha256: null },
    ...Object.keys(evidence.binding.binary_sha256).flatMap((name) => [
      {
        ...evidence.binding,
        binary_sha256: {
          ...evidence.binding.binary_sha256,
          [name]: "0".repeat(64),
        },
      },
      {
        ...evidence.binding,
        binary_sha256: { ...evidence.binding.binary_sha256, [name]: undefined },
      },
    ]),
  ])
    assert.equal(
      assessEvidence(plan, { ...evidence, binding }).accepted,
      false,
    );
  for (const name of [
    "source_sha256",
    "production_sha256",
    "image_id",
    "environment_sha256",
    "samples_sha256",
  ]) {
    const missing = { ...plan.binding, [name]: undefined };
    assert.equal(
      assessEvidence(
        { ...plan, binding: missing },
        { ...evidence, binding: missing },
      ).accepted,
      false,
    );
  }
});

test("100 sockets do not replace distinct authenticated users or correct state", () => {
  const plan = approved(),
    evidence = controlEvidence(plan);
  for (const measurements of [
    { ...evidence.measurements, distinct_authenticated_users: 1 },
    { ...evidence.measurements, ack_p95_ms: NaN },
    { ...evidence.measurements, legal_commands_lost: 1 },
    { ...evidence.measurements, full_state_and_persistence_verified: false },
  ])
    assert.equal(
      assessEvidence(plan, { ...evidence, measurements }).accepted,
      false,
    );
});

test("two-hour NAS needs rendering, complete window and resource trends", () => {
  const plan = approved();
  const evidence = {
    ...controlEvidence(plan),
    gate: "nas-two-hours",
    segments: [{ monotonic_start_ms: 0, monotonic_end_ms: 7200000 }],
    measurements: {
      real_browser_rendering: true,
      real_nas_transfer: true,
      rendered_media_ratio: 0.97,
      resource_trends_verified: true,
    },
  };
  assert.equal(assessEvidence(plan, evidence).accepted, true);
  assert.equal(
    assessEvidence(plan, {
      ...evidence,
      segments: [{ monotonic_start_ms: 0, monotonic_end_ms: 103.2 * 60000 }],
    }).accepted,
    false,
  );
  assert.equal(
    assessEvidence(plan, {
      ...evidence,
      measurements: { ...evidence.measurements, rendered_media_ratio: 0.94 },
    }).accepted,
    false,
  );
});

test("a 72h timer alone and simulated devices never close formal acceptance", () => {
  const plan = approved();
  const evidence = {
    ...controlEvidence(plan),
    gate: "soak-72-hours",
    segments: [{ monotonic_start_ms: 0, monotonic_end_ms: 259200000 }],
  };
  assert.equal(assessEvidence(plan, evidence).accepted, false);
  assert.equal(
    assessEvidence(plan, {
      ...evidence,
      gate: "device-matrix",
      scope: "simulated",
    }).accepted,
    false,
  );
});

test("frozen source verification refuses modified, linked and missing lock inputs", async () => {
  const root = resolve(tmpdir(), "rainsync-f-candidate-" + randomUUID());
  await mkdir(resolve(root, "source"), { recursive: true });
  try {
    const bytes = Buffer.from("synthetic lock\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    for (const name of ["Cargo.lock", "package-lock.json"])
      await writeFile(resolve(root, "source", name), bytes);
    const frozen = {
      schema_version: 1,
      status: "source-frozen",
      source_directory: "source",
      source_manifest: ["Cargo.lock", "package-lock.json"].map((path) => ({
        path,
        bytes: bytes.length,
        sha256: hash,
      })),
    };
    frozen.source_manifest_sha256 = digestJson(frozen.source_manifest);
    const path = resolve(root, "candidate.json");
    await writeFile(path, JSON.stringify(frozen));
    await verifyCandidate(path);
    await writeFile(resolve(root, "source", "Cargo.lock"), "modified");
    await assert.rejects(verifyCandidate(path), /changed/);
    await rm(resolve(root, "source", "Cargo.lock"));
    await symlink(
      resolve(root, "source", "package-lock.json"),
      resolve(root, "source", "Cargo.lock"),
    );
    await assert.rejects(verifyCandidate(path), /regular/);
    await rm(resolve(root, "source", "Cargo.lock"));
    frozen.source_manifest[0].deleted = true;
    frozen.source_manifest_sha256 = digestJson(frozen.source_manifest);
    await writeFile(path, JSON.stringify(frozen));
    await assert.rejects(verifyCandidate(path), /lockfiles/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sample inventory verifies actual authorized bytes, never trusts a hash label alone", async () => {
  const root = resolve(tmpdir(), "rainsync-f-samples-" + randomUUID());
  await mkdir(root);
  try {
    const bytes = Buffer.from("self-owned synthetic media marker");
    await writeFile(resolve(root, "sample"), bytes);
    const inventory = {
      schema_version: 1,
      files: [
        {
          path: "sample",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          authorization: "self-owned",
        },
      ],
    };
    const path = resolve(root, "samples.json");
    await writeFile(path, JSON.stringify(inventory));
    await verifySamples(path);
    await writeFile(resolve(root, "sample"), "different bytes");
    await assert.rejects(verifySamples(path), /differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
