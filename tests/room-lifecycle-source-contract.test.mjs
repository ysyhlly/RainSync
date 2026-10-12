// Static boundary checks only; the native authority fixture supplies real DB waits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const core = source("apps/server/src/room_lifecycle_operations.rs");
const adapter = source("apps/server/src/room_lifecycle.rs");
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const until = end === undefined ? text.length : text.indexOf(end, from + start.length);
  assert.notEqual(until, -1, `missing ${end}`);
  return text.slice(from, until);
};
const inOrder = (text, parts) => {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered ${part}`);
    previous = found;
  }
};

test("lifecycle operations have one canonical narrow boundary and the original wire DTO", () => {
  assert.match(source("apps/server/src/rooms.rs"), /#\[path = "room_lifecycle_operations\.rs"\]\s*pub\(crate\) mod lifecycle_operations;/);
  assert.equal((source("apps/server/src/rooms.rs").match(/mod lifecycle_operations;/g) ?? []).length, 1);
  assert.match(core, /#\[derive\(Deserialize\)\]\s*#\[serde\(deny_unknown_fields\)\]\s*pub struct Change \{\s*expected_revision: u32,\s*\}/);
  assert.ok(adapter.includes("pub use rooms::lifecycle_operations::Change;"));
  assert.ok(adapter.includes('#[path = "room_management_authority.rs"]'));
  assert.ok(adapter.includes('"room_not_active" => err(StatusCode::CONFLICT, "room_not_active")'));
  for (const forbidden of ["&App", "State<", "Json<", "Result<Response>", "responses::", "use super::*", "app."]) {
    assert.ok(!core.includes(forbidden), forbidden);
  }
  assert.ok(!adapter.includes("sqlx::"));
  assert.equal((core.match(/db\.begin\(\)/g) ?? []).length, 3);
  assert.equal((core.match(/authority\.commit\(tx\)/g) ?? []).length, 2);
  assert.ok(!core.includes("tx.commit()"));
});

test("status keeps entry-only viewer admission and the whole read-only snapshot", () => {
  const status = section(core, "pub(crate) async fn status(", "pub(crate) async fn close(");
  inOrder(status, [
    "request::authenticate(context, h, false, true).await?",
    "if !user.admin",
    "request::member(db, &user, id).await?",
    "db.begin().await?",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    "SELECT r.lifecycle,r.lifecycle_epoch,r.owner_id,s.state",
    'if lifecycle == "closing"',
    "distributed_compute::room_drained(&mut tx, id).await?",
    "persistence::room_cleanup::blockers(",
    "lease_until>clock_timestamp() AS lease_active",
    "tx.rollback().await?",
    "Ok(json!({",
  ]);
  assert.equal((status.match(/request::authenticate\(/g) ?? []).length, 1);
  assert.ok(!status.includes("Authority"));
  assert.ok(!status.includes(".commit("));
});

test("retry keeps its independent transaction, error priority and live owner lease", () => {
  const retry = section(core, "pub(crate) async fn retry_cleanup(", "pub(crate) async fn reopen(");
  inOrder(retry, [
    "request::authenticate(context, h, true, false).await?",
    "db.begin().await?",
    "SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE",
    "SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE",
    "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    "management_authority::Authority::admit_action(",
    "Some((id, protocol::RoomPermission::Close))",
    '"revision_conflict"',
    '"room_lifecycle_conflict"',
    "INSERT INTO room_cleanup_tasks(room_id,lifecycle_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING",
    "UPDATE room_cleanup_tasks SET next_attempt_at=clock_timestamp() WHERE room_id=$1 AND lifecycle_epoch=$2 AND completed_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp())",
    "authority.commit(tx).await?",
    'Ok(json!({"lifecycle":"closing"',
  ]);
  assert.ok(!retry.includes("lifecycle_changed"));
  assert.ok(!retry.includes("cancel_jobs("));
  assert.ok(!retry.includes("lease_owner="));
});

test("change samples its original monotonic clock after all waits and validation", () => {
  const change = section(core, "async fn change(");
  inOrder(change, [
    "request::authenticate(context, h, true, false).await?",
    "db.begin().await?",
    "SELECT owner_id,lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE",
    "SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE",
    "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    "management_authority::Authority::admit_action(",
    'if target == "closing"',
    "Some((id, protocol::RoomPermission::Close))",
    "let mut state: RoomState",
    '"revision_conflict"',
    '"room_lifecycle_conflict"',
    'if target == "archived"',
    ".checked_add(1)",
    "state.revision = state",
    ".checked_add(1)",
    "let server_time_ms = clock.0.elapsed().as_secs_f64() * 1000.0;",
    "state.anchor_position_ms = room_core::position(&state, server_time_ms)",
    "state.playback_status = PlaybackStatus::Paused",
    "state.anchor_server_time_ms = server_time_ms",
    "state.clock_epoch = clock.1",
  ]);
  assert.equal((core.match(/\.elapsed\(\)/g) ?? []).length, 1);
  assert.ok(!adapter.includes(".elapsed()"));
  assert.ok(!adapter.includes("app.now()"));
});

test("change retains one transaction through revocation, pending HLS and observed commit", () => {
  const change = section(core, "async fn change(");
  inOrder(change, [
    "UPDATE rooms SET lifecycle=$2,lifecycle_epoch=$3 WHERE id=$1",
    "UPDATE room_snapshots SET state=$2 WHERE room_id=$1",
    "persistence::room_diagnostics::envelope(",
    "diagnostic.actor_permission = authority.actor_permission()",
    "persistence::room_diagnostics::append(&mut tx, &state, diagnostic).await?",
    "INSERT INTO room_lifecycle_events",
    "DELETE FROM control_epochs WHERE room_id=$1",
    "UPDATE invites SET revoked=true WHERE room_id=$1 AND NOT revoked",
    "SELECT session_id FROM playback_requests WHERE room_id=$1 AND static_hls_input_version=1 ORDER BY session_id FOR UPDATE",
    "for session in pending_hls",
    "persistence::static_hls_pending::terminalize_locked(",
    "UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=409,error_code='room_not_active' WHERE room_id=$1 AND static_hls_input_version IS NULL AND status IN('pending','completed')",
    "UPDATE playback_sessions SET stopped=true WHERE room_id=$1 AND NOT stopped",
    "cancel_jobs(&mut *tx, CancellationScope::Room(id)).await?",
    'if target == "closing"',
    "persistence::room_cleanup::enqueue(&mut tx, id, epoch).await?",
    "let observation = job_health.into_commit_observation()",
    "authority.commit(tx).await?",
    "observation.confirmed()",
    "Ok(CommittedChange {",
  ]);
  assert.ok(!change.includes("lifecycle_changed"));
  assert.ok(!change.includes("room_cleanup::finish"));
  assert.ok(!change.includes("disposed"));
});

test("HTTP transition adapters await the committed receipt and broadcast before response", () => {
  for (const [name, expected, target, end] of [
    ["close", "active", "closing", "/// Reschedule"],
    ["reopen", "closed", "active", "pub async fn archive("],
    ["archive", "closed", "archived", undefined],
  ]) {
    const operation = section(core, `pub(crate) async fn ${name}(`, name === "archive" ? "async fn change(" : `pub(crate) async fn ${name === "close" ? "retry_cleanup" : "archive"}(`);
    assert.match(operation, new RegExp(`"${expected}",\\s*"${target}"`));
    const handler = section(adapter, `pub async fn ${name}(`, end);
    inOrder(handler, [
      `rooms::lifecycle_operations::${name}(`,
      "app.identity_context()",
      "app.start",
      "app.epoch",
      ".await?;",
      "rooms::lifecycle_changed(",
      "&committed.state",
      `"${target}"`,
      "committed.lifecycle_epoch",
      "committed.event_id",
      ".await;",
      "Ok(responses::ok_json(",
      `json!({"lifecycle":"${target}"`,
    ]);
  }
});

test("shared authority still rechecks the exact login and delegated grant immediately before commit", () => {
  const authority = source("apps/server/src/room_management_authority.rs");
  const commit = section(authority, "pub(crate) async fn commit(", "fn require_live_login(");
  inOrder(commit, [
    "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())",
    ".bind(&self.login_hash)",
    ".bind(self.user_id)",
    "require_live_login(valid)?",
    "if let Some((room, permission)) = self.delegated",
    "persistence::room_permissions::require(&mut tx, room, self.user_id, permission)",
    'err(StatusCode::FORBIDDEN, "forbidden")',
    "tx.commit().await?",
  ]);
});

test("the bounded authority fixture keeps exact SQL qualification and safe failure reports", () => {
  const fixture = source("tests/room-lifecycle-authority-native.mjs");
  for (const part of [
    "['close','reopen','archive']",
    "interval '3 seconds'",
    "UPDATE room_cleanup_tasks SET next_attempt_at=clock_timestamp()%",
    "backend_start",
    "active.same_blocking_edge_before_release=true",
    "active.expiry_unchanged=true",
    "assert.equal(after.raw,before.raw",
    "assert.equal(record.exit_code,0)",
    "assert.equal(record.pid_absent,true)",
    "assert.equal(record.backend_pid_absent,true)",
    "mode:0o600",
    "report.coordinator.push({path:'tests/fixtures/room-lifecycle-snapshot.mjs'",
    "const raw=f.sql(lifecycleSnapshotSql(pairs))",
    "active.failure={code:'lifecycle_boundary_failed',phase:active.phase}",
  ]) assert.ok(fixture.includes(part), part);
  assert.ok(!fixture.includes("active.failure={message:"));
  assert.ok(source("tests/job-health-events.mjs").includes('"apps/server/src/room_lifecycle_operations.rs"'));
});
