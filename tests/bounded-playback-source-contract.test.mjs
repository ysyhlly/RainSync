// Source invariants only. These do not execute PostgreSQL or prove media output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("owned HTTP retains its exact provisional grant between probe and publication", () => {
  const media = read("apps/server/src/media.rs");
  assert.match(
    media,
    /if kind != "agent" && !owned_http::keep_provisional\(&resource\)/,
  );
  assert.match(media, /owned_http::deadline\(&mut tx,\s*id,\s*&resource\)/);
  assert.match(media, /enqueue_owned_http/);
  const sql = read("migrations/0067_bounded_playback_representations.sql");
  assert.match(sql, /request\.owner_epoch=h\.request_owner_epoch/);
  assert.match(
    sql,
    /request\.status='completed' OR \(request\.status='pending' AND request\.lease_until>clock_timestamp\(\)\)/,
  );
  assert.match(sql, /NEW\.expires_at=LEAST\(NEW\.expires_at,h\.expires_at\)/);
});
test("old readers and queues cannot reinterpret a complete-owned representation", () => {
  const sql = read("migrations/0067_bounded_playback_representations.sql");
  assert.match(
    sql,
    /current_setting\('rainsync\.owned_http_reader',true\)='1'/,
  );
  assert.match(sql, /j\.logical_queue='owned_http_v1'/);
  assert.match(sql, /j\.spec=h\.frozen_spec/);
  assert.match(sql, /advanced_owned_v1/);
  assert.match(sql, /advanced_owned_hls_ladder_v1/);
  assert.match(
    sql,
    /purpose IN \('media_job','static_hls_capture','static_hls_child_output','owned_http_representation'\)/,
  );
});
test("same-SID output freezes original resource and origin through guarded publication", () => {
  const source = read("apps/media-worker/src/upstream_output.rs");
  assert.match(source, /p\.resource=\$3 AND \{SCOPE\}=\$4/);
  assert.match(
    source,
    /ROW\(p\.user_id,p\.room_id,p\.media_id,p\.generation,p\.lifecycle_epoch,p\.auth_login_hash,p\.auth_membership_epoch\) IS NOT DISTINCT FROM ROW\(u\.user_id/,
  );
  assert.match(source, /binding_sha256=\$4 AND state='running'/);
  assert.match(source, /FOR SHARE/);
  assert.match(source, /room_lifecycle::lock_epoch/);
  assert.match(source, /media_authorization::capture/);
  assert.doesNotMatch(source, /\.run\(tokio::time::timeout/);
  assert.doesNotMatch(source, /PlaybackInfo|negotiate\(/);
});
