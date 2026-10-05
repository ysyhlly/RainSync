import assert from "node:assert/strict";
import test from "node:test";
import { validateCachePressureReceipt } from "../scripts/acceptance-cache-pressure.mjs";
// Contract-only synthetic receipts; these tests are never native execution proof.
const runId = "00000000-0000-4000-8000-000000000001";
const sample = () => ({
  schema_version: 1,
  run_id: runId,
  kind: "cache-evict",
  result: "passed",
  accepted: false,
  release_ready: false,
  no_f3_claim: true,
  process_scope_cleanup: true,
  evidence: {
    quota_bytes: 100,
    observed_pressure_bytes: 150,
    deleted_inactive_outputs: ["owned-inactive"],
    sweeps: [
      {
        quota_bytes: 100,
        before_bytes: 150,
        after_bytes: 60,
        disk_headroom_fraction: 0.2,
        error: null,
      },
      {
        quota_bytes: 100,
        before_bytes: 70,
        after_bytes: 70,
        disk_headroom_fraction: 0.2,
        error: null,
      },
    ],
    reader: {
      survived: true,
      lease_observed_live: true,
      file_bytes: 20,
      sha256: "a".repeat(64),
      scope: "production lease/open handle; not HTTP backpressure",
    },
    writer: {
      live_after_sweeps: true,
      before_bytes: 20,
      after_bytes: 30,
      reserved_bytes: 10,
      unreaped_budget_release_refused: true,
      scope_drain_confirmed: true,
      receipt_after_drain: true,
    },
    released_reader_writer_sweep: { after_bytes: 0 },
    unknown_obligations: {
      effective_reserved_bytes: 10,
      missing_receipt_blocks: true,
      missing_job_blocks: true,
      new_reservation_rejected: true,
      receipt_fabricated: false,
      recovery_attempted: false,
      capacity_error: {
        error: "cache_capacity_exceeded",
        before_bytes: 10,
        after_bytes: 10,
      },
    },
    outputs: Array.from({ length: 4 }, () => ({
      published: true,
      encoder_wait_success: true,
      first_fragment_decode: true,
      scope_drain_confirmed: true,
      bytes: 20,
      files: [
        { bytes: 5, sha256: "a".repeat(64) },
        { bytes: 10, sha256: "b".repeat(64) },
      ],
    })),
  },
});
test("cache receipt validates bounded evidence only", () => {
  const value = sample();
  assert.equal(validateCachePressureReceipt(value, runId), value);
});
for (const [name, mutate] of [
  ["wrong run", (r) => (r.run_id = "other")],
  [
    "omitted effective reservation",
    (r) => delete r.evidence.unknown_obligations.effective_reserved_bytes,
  ],
  [
    "zero effective reservation",
    (r) => (r.evidence.unknown_obligations.effective_reserved_bytes = 0),
  ],
  ["negative byte measurement", (r) => (r.evidence.sweeps[0].after_bytes = -1)],
  [
    "fractional byte measurement",
    (r) => (r.evidence.writer.before_bytes = 1.5),
  ],
  [
    "unknown directory removed",
    (r) => (r.evidence.unknown_obligations.capacity_error.after_bytes = 0),
  ],
  [
    "malformed output proof",
    (r) => (r.evidence.outputs[0].files[0].bytes = undefined),
  ],
  ["acceptance inflation", (r) => (r.accepted = true)],
  ["no observed pressure", (r) => (r.evidence.observed_pressure_bytes = 99)],
  [
    "no actual eligible deletion",
    (r) => (r.evidence.deleted_inactive_outputs = []),
  ],
  ["quota remains exceeded", (r) => (r.evidence.sweeps[1].after_bytes = 100)],
  [
    "disk margin lowered",
    (r) => (r.evidence.sweeps[0].disk_headroom_fraction = 0.09),
  ],
  [
    "reader lease unknown",
    (r) => (r.evidence.reader.lease_observed_live = false),
  ],
  ["writer stopped growing", (r) => (r.evidence.writer.after_bytes = 20)],
  [
    "early budget release",
    (r) => (r.evidence.writer.unreaped_budget_release_refused = false),
  ],
  ["unconfirmed process drain", (r) => (r.process_scope_cleanup = false)],
  [
    "missing receipt cleared",
    (r) => (r.evidence.unknown_obligations.missing_receipt_blocks = false),
  ],
  [
    "fabricated receipt",
    (r) => (r.evidence.unknown_obligations.receipt_fabricated = true),
  ],
  [
    "undecoded output",
    (r) => (r.evidence.outputs[0].first_fragment_decode = false),
  ],
])
  test(`cache receipt rejects ${name}`, () => {
    const value = sample();
    mutate(value);
    assert.throws(() => validateCachePressureReceipt(value, runId));
  });
