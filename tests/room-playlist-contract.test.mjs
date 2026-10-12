// Pure source-seam contracts. Runtime SQL waits and delivery are exercised only
// by the separately invoked, source-bound room-playlist-authority-native gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../apps/server/src/${name}.rs`, import.meta.url), "utf8");
const between = (text, start, end) => {
  const first = text.indexOf(start);
  assert.ok(first >= 0, `missing ${start}`);
  const last = text.indexOf(end, first + start.length);
  assert.ok(last > first, `missing ${end}`);
  return text.slice(first, last);
};
const ordered = (text, fragments) => {
  let offset = -1;
  for (const fragment of fragments) {
    offset = text.indexOf(fragment, offset + 1);
    assert.ok(offset >= 0, `missing or reordered ${fragment}`);
  }
};
const queries = (text) => [...text.matchAll(/sqlx::query(?:_scalar)?(?:::<[^>]+>)?\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
const operations = source("room_playlist_operations");
const rooms = source("rooms");
const list = between(operations, "pub(crate) async fn list(", "pub(crate) async fn add(");
const add = between(operations, "pub(crate) async fn add(", "pub(crate) async fn remove(");
const remove = between(operations, "pub(crate) async fn remove(", "#[cfg(test)]");
const adapters = between(rooms, "pub async fn playlist(", "#[derive(Deserialize)]\npub struct MessageCursor");

test("all three playlist routes retain their extractors and delegate the complete operation", () => {
  assert.match(rooms, /#\[path = "room_playlist_operations\.rs"\]\s*pub\(crate\) mod playlist_operations;/);
  assert.match(rooms, /pub use playlist_operations::Add;/);
  assert.match(source("bootstrap/routes"), /"\/api\/v1\/rooms\/\{id\}\/playlist",\s*get\(rooms::playlist\)\.post\(rooms::add_playlist\)/);
  assert.match(source("bootstrap/routes"), /"\/api\/v1\/rooms\/\{id\}\/playlist\/\{item\}",\s*delete\(rooms::remove_playlist\)/);
  assert.match(adapters, /Json\(body\): Json<Add>/);
  assert.match(adapters, /Path\(\(id, item\)\): Path<\(Uuid, Uuid\)>/);
  assert.doesNotMatch(adapters, /sqlx::|auth(?:_viewer)?\(|member\(|controller\(|\.commit\(/);
  assert.doesNotMatch(operations, /\b(?:App|State|Response|Json)\b|responses::|broadcast_timeline|\.rooms\.lock/);
  assert.equal((operations.match(/context: RequestContext<'_>/g) ?? []).length, 3);
  assert.match(operations, /pub struct Add \{\s*media_id: Uuid,\s*\}/);
  assert.doesNotMatch(between(operations, "#[derive(Deserialize)]", "#[derive(Serialize)]"), /deny_unknown_fields/);
});

test("viewer list keeps both privacy-filtered queries, merged ordering and final viewer/member check", () => {
  ordered(list, [
    "request::authenticate(context, h, false, true).await?",
    "request::member(db, &viewer, room).await?",
    "media_titles::SELECT.replace",
    ".bind(viewer.id).bind(room).fetch_all(db).await?",
    "media_titles::media(row)",
    "JOIN room_platform_media e ON e.media_id=q.media_id AND e.room_id=q.room_id",
    ".bind(room).bind(viewer.id).fetch_all(db).await?",
    "Playlist::ordered(items)",
    "request::authenticate(RequestContext { db, origin }, h, false, true).await?",
    "request::member(db, &current, room).await?",
    "Ok(playlist)",
  ]);
  assert.ok(list.includes("q.room_id=$2 AND library_media_allowed($1,m.id,'play',$2) ORDER BY q.sort_order,q.id"));
  assert.ok(list.includes("WHERE q.room_id=$1 AND m.available AND m.source_id IS NULL AND library_media_allowed($2,m.id,'play',$1)"));
  assert.ok(list.includes("media_titles::VISIBLE"));
  assert.ok(operations.includes("items.sort_by_key(|(order, item)| (*order, item.id))"));
  assert.doesNotMatch(list, /\.begin\(|\.commit\(/);
  assert.equal((list.match(/request::authenticate\(/g) ?? []).length, 2);
  assert.equal((list.match(/request::member\(/g) ?? []).length, 2);
});

test("add retains separate entry/controller checks, exact SQL and commit in both result branches", () => {
  assert.deepEqual(queries(add), [
    "SELECT id FROM media_items WHERE id=$1 FOR SHARE",
    "SELECT media_id FROM room_platform_media WHERE media_id=$1 FOR SHARE",
    "SELECT room_media_allowed($1,$2) AND library_media_allowed($3,$2,'play',$1)",
    "SELECT id FROM playlist_items WHERE room_id=$1 AND media_id=$2 ORDER BY sort_order,id LIMIT 1",
    "INSERT INTO playlist_items SELECT $1,$2,$3,COALESCE(max(sort_order),0)+1 FROM playlist_items WHERE room_id=$2",
  ]);
  ordered(add, [
    "request::authenticate(context, h, true, false).await?",
    "request::authenticate(RequestContext { db, origin }, h, true, false).await?",
    "request::member(db, &controller, room).await?",
    "controller_admission(db, controller, h, room, RoomPermission::Queue, true).await?",
    "SELECT id FROM media_items",
    "SELECT media_id FROM room_platform_media",
    "SELECT room_media_allowed",
    ".bind(user.id)",
    'err(StatusCode::NOT_FOUND, "media_not_found")',
    "SELECT id FROM playlist_items",
    "commit_controller(tx, h).await?",
    "return Ok(Addition::Existing(item))",
    "INSERT INTO playlist_items",
    "commit_controller(tx, h).await?",
    "Ok(Addition::Inserted(item))",
  ]);
  assert.equal((add.match(/controller_admission\(/g) ?? []).length, 1);
  assert.equal((add.match(/commit_controller\(/g) ?? []).length, 2);
  assert.doesNotMatch(add, /\.begin\(|tx\.commit\(/);
});

test("remove retains room-and-item scope and even no-op removal commits through shared admission", () => {
  assert.deepEqual(queries(remove), ["DELETE FROM playlist_items WHERE room_id=$1 AND id=$2"]);
  ordered(remove, [
    "request::authenticate(context, h, true, false).await?",
    "request::member(db, &controller, room).await?",
    "controller_admission(db, controller, h, room, RoomPermission::Queue, true).await?",
    "DELETE FROM playlist_items WHERE room_id=$1 AND id=$2",
    ".bind(room)", ".bind(item)", ".rows_affected()",
    "commit_controller(tx, h).await?",
    "Ok(Removal::from_rows(removed))",
  ]);
  assert.doesNotMatch(remove, /\.begin\(|tx\.commit\(/);
});

test("runtime alone serializes wire results and emits only post-commit invalidations", () => {
  ordered(adapters, [
    "playlist_operations::list(app.identity_context(), &h, id).await?",
    "responses::ok_json(playlist.into_value())",
    "playlist_operations::add(app.identity_context(), &h, id, body).await?",
    "if added.changed()",
    'broadcast_timeline(&app, id, json!({"type":"PLAYLIST_CHANGED"})).await',
    'Ok(Json(json!({"id":added.item()})))',
    "playlist_operations::remove(app.identity_context(), &h, id, item).await?",
    "if removed.changed()",
    'broadcast_timeline(&app, id, json!({"type":"PLAYLIST_CHANGED"})).await',
    'Ok(Json(json!({"ok":true})))',
  ]);
  assert.equal((adapters.match(/broadcast_timeline\(/g) ?? []).length, 2);
  assert.doesNotMatch(adapters, /PLAYLIST_CHANGED.*(?:media|title|cover)/);
});

test("reused controller keeps its original lock order and final exact-login/delegation fences", () => {
  const admission = between(rooms, "pub(crate) async fn controller_admission", "pub(crate) async fn commit_controller");
  ordered(admission, [
    "db.begin().await?", "persistence::room_lifecycle::lock_active",
    "SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE",
    "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    "SELECT admin FROM users WHERE id=$1 FOR SHARE",
    "SELECT csrf FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
    "SELECT playback_login_allowed($2,$1)", 'h.get("x-csrf-token")',
    "SELECT owner_id FROM rooms WHERE id=$1", "persistence::room_permissions::require",
    "rainsync.delegated_room", "Ok(tx)",
  ]);
  const commit = between(rooms, "pub(crate) async fn commit_controller", '#[path = "room_invite_operations.rs"]');
  ordered(commit, [
    "token_hash=$1 AND expires_at>clock_timestamp()", '"session_expired"',
    "room_permission_allowed(current_setting('rainsync.delegated_room')::uuid",
    '"controller_required"', "tx.commit().await?",
  ]);
});

test("native gate rejects missing, duplicate, unknown, failed or reordered boundary evidence", () => {
  const native = readFileSync(new URL("./room-playlist-authority-native.mjs", import.meta.url), "utf8");
  const declaration = native.match(/const requiredChecks = (\[[\s\S]*?\]);/);
  assert.ok(declaration);
  const requiredChecks = JSON.parse(declaration[1]);
  assert.deepEqual(requiredChecks, [
    "mixed_media_private_projection_and_committed_invalidations",
    "list_exact_login_expiry_after_select_wait",
    "list_membership_revoked_after_select_wait",
    "add_new_exact_login_expiry_after_media_wait",
    "add_replay_exact_login_expiry_after_media_wait",
    "remove_exact_login_expiry_after_delete_wait",
    "add_queue_delegation_expiry_after_media_wait",
    "remove_queue_delegation_expiry_after_delete_wait",
  ]);
  const assertion = native.match(/assert\.deepEqual\(report\.checks, requiredChecks\.map\(\(name\) => \(\{ name, result: "passed" \}\)\),\s*"Every frozen native check must complete exactly once"\);/);
  assert.ok(assertion);
  const validate = new Function("assert", "report", "requiredChecks", assertion[0]);
  const checks = requiredChecks.map((name) => ({ name, result: "passed" }));
  validate(assert, { checks }, requiredChecks);
  for (const invalid of [[], checks.slice(1), [...checks, checks[0]], [...checks].reverse(),
    [{ name: "unknown", result: "passed" }, ...checks.slice(1)],
    [{ ...checks[0], result: "failed" }, ...checks.slice(1)]]) {
    assert.throws(() => validate(assert, { checks: invalid }, requiredChecks), assert.AssertionError);
  }
});

test("native mixed projection seed satisfies the platform placeholder identity contract", () => {
  const native = readFileSync(new URL("./room-playlist-authority-native.mjs", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/0051_native_platform.sql", import.meta.url), "utf8");
  const guard = between(migration, "CREATE FUNCTION protect_room_platform_media()", "CREATE FUNCTION protect_platform_placeholder()");
  for (const fragment of [
    "m.source_id IS NULL", "m.title='平台影片'", "m.resource='platform:'||m.id::text",
    "m.metadata='{}'::jsonb", "m.duration_ms IS NULL", "RAISE EXCEPTION 'platform_placeholder_required'",
    "BEFORE INSERT OR UPDATE ON room_platform_media",
    "FOR EACH ROW EXECUTE FUNCTION protect_room_platform_media()",
  ]) assert.ok(guard.includes(fragment), fragment);
  // The three-column seed relies on these original nullable/default columns.
  const mediaSchema = between(schema, "CREATE TABLE media_items (", "CREATE TABLE media_tracks (");
  assert.match(mediaSchema, /source_id uuid REFERENCES sources\(id\),/);
  assert.match(mediaSchema, /duration_ms double precision,/);
  assert.match(mediaSchema, /metadata jsonb NOT NULL DEFAULT '\{\}',/);

  const seed = native.match(/INSERT INTO media_items\(id,title,resource\) VALUES\([^;]+\);/);
  assert.ok(seed, "The actual mixed projection must seed its platform placeholder");
  const id = "11111111-1111-4111-8111-111111111111";
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const statements = [];
  // Evaluate only this SQL template into a fake receiver; never import or run
  // the native gate, PostgreSQL, HTTP, or sockets in the pure contract suite.
  new Function("f", "native", "quote", `f.sql(\`${seed[0]}\`);`)(
    { sql: (sql) => statements.push(sql) }, id, quote,
  );
  assert.equal(statements.length, 1);
  const expected = `INSERT INTO media_items(id,title,resource) VALUES('${id}','平台影片','platform:${id}');`;
  const verify = (sql) => assert.equal(sql, expected);
  verify(statements[0]);
  for (const invalid of [
    statements[0].replace("'平台影片'", "'opaque platform row'"),
    statements[0].replace(`'platform:${id}'`, "''"),
    statements[0].replace(`'platform:${id}'`, "'platform:22222222-2222-4222-8222-222222222222'"),
  ]) assert.throws(() => verify(invalid), assert.AssertionError);
});

test("native fixture witnesses actual wait edges and binds helper/cleanup evidence", () => {
  const native = readFileSync(new URL("./room-playlist-authority-native.mjs", import.meta.url), "utf8");
  assert.match(native, /await nativeOwnerGate\("room-playlist-authority-native"/);
  assert.match(native, /report\.coordinator\.push\(\{\s*path: "tests\/fixtures\/source-grant\.mjs"/);
  for (const fragment of [
    "LOCK TABLE playlist_items IN ACCESS EXCLUSIVE MODE", "FOR UPDATE",
    "pg_blocking_pids(a.pid)", "assert.deepEqual(block.witness(), [blockedPid]",
    "SELECT expires_at<=clock_timestamp()", '"natural deadline is unchanged"',
    "testLoginHash(f, s.actor.client)", "verifyPidAbsent(child.pid)",
    'assert.equal(socket.readyState, WebSocket.CLOSED)',
    "await bounded(response.arrayBuffer())", "await block.release()",
  ]) assert.ok(native.includes(fragment), fragment);
  assert.doesNotMatch(native, /DATABASE_URL\s*=|\.env\.[A-Z_]*DATABASE_URL\s*=/);
});
