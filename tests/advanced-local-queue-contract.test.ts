import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
it("keeps baseline generic/static claim predicates isolated from the advanced logical queue", () => {
  const claim = read("crates/persistence/src/media_jobs.rs");
  expect(claim).toContain(
    'const LEGACY_QUEUE: &str = "j.logical_queue IS NULL',
  );
  expect(claim).toContain(
    'const LEGACY_CLAIMED_QUEUE: &str = "claimed.logical_queue IS NULL',
  );
  expect(claim).toContain("j.logical_queue='static_hls_v1'");
  expect(claim).toContain("claimed.logical_queue='static_hls_v1'");
  expect(claim).toContain(
    "j.logical_queue='advanced_local_v1' AND advanced_local_job_spec_valid(j.spec)",
  );
  expect(claim).toContain(
    "claimed.logical_queue='advanced_local_v1' AND advanced_local_job_spec_valid(claimed.spec)",
  );
  expect(claim).toContain(
    "set_config('rainsync.advanced_local_recipe','1',true)",
  );
  expect(
    claim.indexOf("set_config('rainsync.advanced_local_recipe'"),
  ).toBeLessThan(
    claim.indexOf("UPDATE media_jobs claimed SET status='running'"),
  );
});
it("seals advanced jobs into a separate queue while preserving the ordinary enqueue path", () => {
  const server = read("apps/server/src/media.rs"),
    queue = read("crates/persistence/src/media_queue.rs");
  expect(server).toContain('spec["kind"] = json!(if kind == "local"');
  expect(server).toContain('"advanced_owned_local_transcode_v1"');
  expect(server).toContain('"advanced_owned_remote_transcode_v1"');
  expect(server).toContain('spec["advanced_assets"] = meta["advanced_assets"].clone()');
  expect(server).toContain('spec["held_input_bytes"]');
  expect(server).toContain('spec["remote_duration_seconds"]');
  const owned = read("migrations/0065_advanced_sources_assets.sql");
  expect(owned).toContain("CREATE FUNCTION advanced_owned_job_spec_valid");
  expect(owned).not.toContain("CREATE FUNCTION advanced_local_job_spec_valid");
  expect(owned).toContain("advanced_local_job_spec_valid((spec-'advanced_assets')");
  expect(owned).toContain("'advanced_owned_v1'");
  expect(owned).toContain("'advanced_owned_hls_ladder_v1'");
  expect(server).toContain('spec["recipe_version"] = json!(1)');
  expect(server).toContain("media_queue::enqueue_advanced_local");
  expect(server).toContain("media_queue::enqueue(&mut tx");
  expect(queue).toContain('"advanced_local_v1"');
  expect(queue).toContain('"advanced_owned_v1"');
  expect(queue).toContain('starts_with("advanced_owned")');
  expect(queue).toContain("INSERT INTO advanced_media_bindings");
  expect(queue).toContain("enqueue_queue(tx, session, spec, limit, None)");
});
it("gives advanced queue immutable closed version1 guards without replacing static/child guard bodies", () => {
  const sql = read("migrations/0056_advanced_local_queue.sql");
  expect(sql).toContain(
    "CHECK(logical_queue IS NULL OR logical_queue IN ('static_hls_v1','advanced_local_v1'))",
  );
  expect(sql).toContain("advanced_local_job_spec_valid");
  expect(sql).toContain("jsonb_object_keys(intent)");
  expect(sql).toContain("advanced_local_queue_no_reclassification");
  expect(sql).toContain("NEW.spec IS DISTINCT FROM OLD.spec");
  expect(sql).toContain("static_hls_is_child_session(NEW.session_id)");
  expect(sql).toContain("static_hls_child_identity_reserved(NEW.id)");
  expect(sql).toContain(
    "current_setting('rainsync.advanced_local_recipe',true) IS DISTINCT FROM '1'",
  );
  expect(sql).not.toContain("CREATE OR REPLACE FUNCTION protect_static_hls");
  expect(sql).not.toContain("DROP TRIGGER static_hls_child");
  expect(sql).toContain(
    "EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false",
  );
});

it("dispatches only validated advanced claims before ordinary cache or input effects", () => {
  const worker = read("apps/media-worker/src/main.rs");
  expect(worker).toContain("media_jobs::claim_platform_capable(&app.db, worker)");
  const claims = read("crates/persistence/src/media_jobs.rs");
  const ordinary = claims.match(/Queue::Ordinary =>[^\n]+/)?.[0];
  expect(ordinary).toContain("advanced_local_job_spec_valid(j.spec)");
  expect(ordinary).not.toContain("native_platform_transcode_v1");
  const platform = claims.match(/Queue::PlatformCapable =>[^\n]+/)?.[0];
  expect(platform).toContain("advanced_local_job_spec_valid(j.spec)");
  expect(platform).toContain("native_platform_transcode_job_spec_valid(j.spec)");
  const gate = worker.indexOf("advanced_media::admit_claim(&claim.spec)");
  expect(gate).toBeGreaterThan(0);
  expect(gate).toBeLessThan(
    worker.indexOf("cache::ensure_capacity(&app).await?", gate),
  );
  expect(gate).toBeLessThan(
    worker.indexOf("cache::reserve_output(&app, &claim).await?", gate),
  );
  expect(gate).toBeLessThan(
    worker.indexOf("source_version::verify(spec).await?", gate),
  );
  expect(worker).toContain(
    "static_hls_child_gate::reject_unsupported_claim(&claim)?",
  );
  const advanced = read("apps/media-worker/src/advanced_media.rs");
  expect(advanced).toContain('spec["kind"] == "advanced_local_transcode_v1"');
  expect(advanced).toContain('spec["recipe_version"].as_u64() == Some(1)');
  expect(advanced).toContain(
    "FIELDS.iter().all(|key| object.contains_key(*key))",
  );
});

it("assigns every closed owned ladder validation5 and keeps its read lookup generation-aware",()=>{
  const jobs=read("crates/persistence/src/media_jobs.rs"),reader=read("apps/media-worker/src/local_hls_ladder_read.rs");
  expect(jobs).toContain("crate::local_hls_ladder::OWNED_ADVANCED_KIND");
  expect(jobs).toContain('output_validation_version(&claim.spec["kind"])');
  expect(reader).toContain("'advanced_owned_hls_ladder_v1'");
});
