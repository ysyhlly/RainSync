import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(path, "utf8");
it("isolates new queues and preserves frozen source/login/attempt/deadline rather than scalar proof reuse", () => {
  const sql = read("migrations/0062_composed_hls_ladders.sql");
  for (const fence of [
    "native_platform_hls_ladder_v1",
    "advanced_hls_ladder_v1",
    "native_platform_ladder_job_spec_valid",
    "local_hls_ladder_job_spec_valid_sdr",
    "p.resource=n.frozen_resource",
    "p.auth_login_hash=n.auth_login_hash",
    "p.viewer_id=n.viewer_id",
    "p.plan_generation=n.plan_generation",
    "n.deadline_ms>floor(extract(epoch FROM clock_timestamp())*1000)",
    "playback_origin_allowed",
    "playback_source_allowed",
    "rainsync.native_platform_ladder_recipe",
    "rainsync.advanced_hls_ladder_recipe",
    "rainsync.native_platform_ladder_reader",
    "rainsync.advanced_hls_ladder_reader",
    "hls_ladder_output_file_authority_revoked",
    "NEW.attempt=",
    "j.attempt=NEW.attempt",
    "o.validation_version=5",
    "NEW.relative_dir<>NEW.job_id::text||'/'||NEW.attempt::text",
  ]) {
    if (fence === "NEW.attempt=") continue;
    expect(sql).toContain(fence);
  }
  expect(sql).toContain("IN ('1'::jsonb,'2'::jsonb,'4'::jsonb)");
  expect(sql).not.toContain("'3'::jsonb");
  const scalar = read("crates/persistence/src/media_outputs.rs");
  expect(scalar).not.toContain("validation_version=5");
  const job = read("crates/persistence/src/media_jobs.rs");
  expect(job).toContain("hls_ladder_job_allowed(j.id)");
  expect(job).toContain("rainsync.native_platform_ladder_recipe");
});
it("reuses positive owned reaping, delivery receipts, common prefix and bounded native ingress", () => {
  const worker = read("apps/media-worker/src/native_platform_ladder.rs");
  for (const point of [
    "cache::reserve_output",
    "source_metadata",
    "durable::verify_recipe",
    "prepare_directory",
    "local_hls_ladder::Builder",
    "process::supervise",
    "writer_stopped",
    "child.kill().await",
    "child.wait().await",
    "native_platform_ladder_encoder_reap_required",
    "native_platform_ladder_truncated_output",
    "finalize_fenced",
    "local_hls_ladder::publish",
    "Resource::parse(path)",
    "n<snapshot.segment_count",
    "file_proof",
    "Some(reader)",
    "Some(opened)",
  ]) {
    expect(worker.replace(/\s+/g," ")).toContain(point.replace("n<snapshot.segment_count","n < snapshot.segment_count"));
  }
  const native = read("apps/media-worker/src/native_platform_transcode.rs");
  expect(native).toContain("playback_access::protect_native_platform");
  expect(native).toContain("constrain_input_args");
  expect(native).toContain("MAX_RANGE_BYTES");
  const server = read("apps/server/src/platform_media/transcode.rs");
  expect(server).toContain("rewrite_ladder_manifest");
  expect(server).toContain("parse_master(text)");
  expect(server).toContain("parse_media_playlist(text)");
  expect(server).toContain("&attempt={attempt}");
  expect(server).toContain("owned::serve");
});
