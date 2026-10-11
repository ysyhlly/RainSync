// Pure source contracts and in-memory deletion/change controls. No DB, socket,
// server, subprocess, network, or Cargo. These do not prove PostgreSQL expiry,
// lock waits, successful HTTP admission, or retirement execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const core = source("catalog/room_shares.rs").split("#[cfg(test)]")[0];
const http = source("private_library.rs");
const authority = source("catalog/library_authority.rs");
const operations = ["share", "update_share", "revoke_share"];
const compact = (text) => text.replace(/\s+/g, " ").trim();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const until = end === undefined ? text.length : text.indexOf(end, from + start.length);
  assert.notEqual(until, -1, `missing ${end}`);
  return text.slice(from, until);
};
const fn = (text, name) => {
  const start = new RegExp(`^(?:pub(?:\\([^)]*\\))? )?async fn ${name}\\(`, "m").exec(text);
  assert.ok(start, `missing operation ${name}`);
  const end = text.indexOf("\n}", start.index);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return text.slice(start.index, end + 2);
};
const body = (text) => text.slice(text.indexOf("{\n") + 2, -2);
const inOrder = (text, parts) => {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered ${part}`);
    previous = found;
  }
};
const admissionPrefix = (name) => "    let db = request.db;\n"
  + (name === "revoke_share" ? "" : "    require_enabled()?;\n")
  + "    let u = request::authenticate(request, &h, true, false).await?;\n";

function admissionContract(text) {
  assert.doesNotMatch(text, /\b(?:App|Aes256Gcm|State|Response|SourceReadContext|SourceWriteContext|SourceChangeContext)\b|responses::|auth_viewer\(|request::(?:admin|member)\(/);
  assert.deepEqual([...text.matchAll(/^(?:pub\(crate\) )?async fn (\w+)\(/gm)].map((match) => match[1]),
    ["preserve_current_room_shares", ...operations]);
  count(text, /request::authenticate\(/g, 3);
  count(text, /require_enabled\(\)\?/g, 2);
  for (const name of operations) {
    const operation = fn(text, name);
    const parameters = `request: RequestContext<'_>, h: HeaderMap, id: Uuid, ${name === "share" ? "" : "grant: Uuid, "}body: ${name === "share" ? "Share" : name === "update_share" ? "UpdateShare" : "Expected"},`;
    assert.equal(compact(operation.slice(0, operation.indexOf("{\n"))),
      `pub(crate) async fn ${name}( ${parameters} ) -> Result<Value>`);
    assert.ok(body(operation).startsWith(admissionPrefix(name)), `${name}: exact entry checks precede original validation/storage`);
    count(operation, /request::authenticate\(/g, 1);
    count(operation, /require_enabled\(\)\?/g, name === "revoke_share" ? 0 : 1);
  }
}

// Frozen original bodies from ffee0ab83a84ee010a0043f863a4e37d43e48003.
// Removing only the reviewed ingress prefix and final receipt consumption must
// recover every original byte: queries, binds, errors, locks, and response JSON.
// This supplements the readable semantic guards below; it is not a runtime test.
const originalBodyHashes = {
  share: "defc8dab6f445dbe6a7e2314541407f06944f84b5c3bb995104a2c7a475aaabf",
  update_share: "cf12fa5b9cfc8851767d351d250e60ff884437f867b4f6665e77a60532c1c1e4",
  revoke_share: "eb7fbd95685b7a697e64674e1be2127013444889880591afbf036ba18b509d17",
};
function unchangedTransactions(text) {
  for (const name of operations) {
    let original = body(fn(text, name));
    assert.ok(original.startsWith(admissionPrefix(name)));
    original = original.slice(admissionPrefix(name).length);
    if (name !== "share") {
      assert.ok(original.endsWith("    Ok(committed.response(db).await)"));
      original = original.replace(/Ok\(committed\.response\(db\)\.await\)$/, "Ok(committed)");
    }
    assert.equal(hash(original), originalBodyHashes[name], `${name}: original transaction/validation/response bytes`);
  }
  assert.equal(hash(body(fn(text, "preserve_current_room_shares"))),
    "a0ea33ec9c7a8271ac09da231ffcd4b205c3838611a70535ad8a3b90d7ff6dcd", "current-row migration body");
}

function shareFlow(text) {
  const share = fn(text, "share");
  inOrder(share, [
    "require_enabled()?", "request::authenticate(request, &h, true, false).await?",
    'if !matches!(body.mode.as_str(), "room_members" | "library_members")',
    "!(1..=1440).contains(&body.expires_in_minutes)",
    "let mut tx = db.begin().await?",
    "SELECT id FROM rooms WHERE id=$1 AND lifecycle='active' FOR SHARE",
    'err(StatusCode::NOT_FOUND, "room_not_found")',
    "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    'err(StatusCode::FORBIDDEN, "not_a_member")',
    "lock_caller(&mut tx, &u, &h, false).await?",
    "SELECT * FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'share_to_room') FOR UPDATE",
    "revision(&body.expected_revision)?",
    "library_media_allowed($3,m.id,'share_to_room',NULL) FOR SHARE OF m,s",
    "INSERT INTO room_media_grants", "advance(&mut tx, id, false).await?",
    'audit(&mut tx, id, u.id, "room_media_shared", Some(grant)).await?',
    'require_current_permission(&mut tx, u.id, id, "share_to_room").await?',
    "commit_caller(tx, &u, &h, false).await?", "Ok(json!",
  ]);
  count(share, /lock_caller\(/g, 1);
  count(share, /db\.begin\(/g, 1);
  count(share, /commit_caller\(/g, 1);
  assert.doesNotMatch(share, /CommittedLibraryChange|\.response\(|preserve_current_room_shares\(/);
}

function updateFlow(text) {
  const update = fn(text, "update_share");
  count(update, /lock_caller\(/g, 1);
  inOrder(update, [
    "require_enabled()?", "request::authenticate(request, &h, true, false).await?",
    "body.expires_at <= 0", "let mut tx = db.begin().await?",
    "SELECT g.room_id FROM room_media_grants g WHERE g.id=$1 AND g.library_id=$2 AND library_allowed($3,$2,'share_to_room') AND (g.grantor_id=$3 OR library_allowed($3,$2,'manage'))",
    'err(StatusCode::NOT_FOUND,"library_not_found")',
    "SELECT id FROM rooms WHERE id=$1 AND lifecycle='active' FOR SHARE",
    "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    "lock_caller(&mut tx, &u, &h, false).await?",
    "SELECT * FROM private_libraries WHERE id=$1 AND library_allowed($2,id,'share_to_room') FOR UPDATE",
    "revision(&body.expected_revision)?", "previous_expiry",
    "to_timestamp($5::double precision/1000)<=g.created_at+interval '24 hours'",
    "g.permission_epoch=$3 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.source_generation=m.library_source_generation AND m.available AND library_allowed(g.grantor_id,$2,'share_to_room')",
    'err(StatusCode::CONFLICT,"library_share_inactive")', 'if !current.get::<bool, _>("expiry_valid")',
    'err(StatusCode::BAD_REQUEST, "library_share_expiry_invalid")',
    "UPDATE room_media_grants SET mode=$3,expires_at=to_timestamp($4::double precision/1000)",
    "advance(&mut tx, id, true).await?", "preserve_current_room_shares(&mut tx, id, epoch).await?",
    'audit(&mut tx, id, u.id, "room_media_updated", Some(grant)).await?',
    'require_current_permission(&mut tx, u.id, id, "share_to_room").await?',
    "revoked_at IS NULL AND expires_at>clock_timestamp() AND to_timestamp($3::double precision/1000)>clock_timestamp() AND library_allowed(grantor_id,library_id,'share_to_room') AND (grantor_id=$4 OR library_allowed($4,library_id,'manage'))",
    '.bind(current.get::<i64,_>("previous_expiry"))',
    "if !still_live", 'err(StatusCode::CONFLICT, "library_share_inactive")',
    "commit_caller(tx, &u, &h, false).await?", "CommittedLibraryChange::new(",
    "Ok(committed.response(db).await)",
  ]);
}

function revokeFlow(text) {
  const revoke = fn(text, "revoke_share");
  count(revoke, /lock_caller\(/g, 1);
  assert.doesNotMatch(revoke, /require_enabled|require_current_permission|share_to_room|room_members|FROM rooms/);
  inOrder(revoke, [
    "request::authenticate(request, &h, true, false).await?",
    "let mut tx = db.begin().await?", "lock_caller(&mut tx, &u, &h, false).await?",
    "deleted_at IS NULL AND (library_allowed($2,id,'manage') OR EXISTS(SELECT 1 FROM room_media_grants g WHERE g.id=$3 AND g.library_id=$1 AND g.grantor_id=$2)) FOR UPDATE",
    "revision(&body.expected_revision)?", "SET revoked_at=COALESCE(revoked_at,clock_timestamp())",
    "if result.rows_affected() == 0", "advance(&mut tx, id, true).await?",
    'preserve_current_room_shares(&mut tx, id, lib.get::<i64, _>("permission_epoch")).await?',
    'audit(&mut tx, id, u.id, "room_media_revoked", Some(grant)).await?',
    "SELECT library_allowed($1,$2,'manage') OR EXISTS(SELECT 1 FROM room_media_grants WHERE id=$3 AND library_id=$2 AND grantor_id=$1)",
    "if !allowed", 'err(StatusCode::NOT_FOUND, "library_not_found")',
    "commit_caller(tx, &u, &h, false).await?", "CommittedLibraryChange::new(id, json!({\"ok\":true}), true)",
    "Ok(committed.response(db).await)",
  ]);
}

function migrationAndReceipts(text) {
  const migration = fn(text, "preserve_current_room_shares");
  assert.ok(migration.includes("s.library_id=$1 AND s.deleted_at IS NULL AND g.permission_epoch=$2 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.source_generation=m.library_source_generation AND m.available AND library_allowed(g.grantor_id,$1,'share_to_room')"));
  assert.ok(migration.includes(".bind(library).bind(previous_epoch).bind(previous_epoch+1)"));
  assert.doesNotMatch(migration, /\.begin\(|\.commit\(/);
  for (const name of operations.slice(1)) {
    const operation = fn(text, name);
    count(operation, /db\.begin\(/g, 1);
    count(operation, /commit_caller\(/g, 1);
    count(operation, /CommittedLibraryChange::new\(/g, 1);
    count(operation, /\.response\(db\)\.await/g, 1);
    inOrder(operation, ["commit_caller(tx, &u, &h, false).await?", "CommittedLibraryChange::new(", "Ok(committed.response(db).await)"]);
    assert.doesNotMatch(operation, /\.commit\(|\.response\(db\)\.await\?|tokio::spawn|detail_value\(/);
  }
}

function httpContract(text) {
  for (const name of operations) {
    const dto = name === "share" ? "Share" : name === "update_share" ? "UpdateShare" : "Expected";
    const route = name === "share" ? "Path(id): Path<Uuid>" : "Path((id, grant)): Path<(Uuid, Uuid)>";
    const args = name === "share" ? "id, body" : "id, grant, body";
    assert.equal(compact(fn(text, name)), compact(`pub async fn ${name}(
      State(app): State<App>, h: HeaderMap, ${route}, Json(body): Json<${dto}>,
    ) -> Result<Response> {
      Ok(responses::ok_json( catalog::room_shares::${name}(app.identity_context(), h, ${args}).await?, ))
    }`));
  }
}

test("room-share operations own exact non-guest write admission and only share/update gates", () => admissionContract(core));
test("all original transaction/validation/response bodies remain byte-exact after the two reviewed boundary edits", () => unchangedTransactions(core));
test("share retains room-first locks, business error order, revision-only advance, and final authority", () => shareFlow(core));
test("update retains room-first locks, source/epoch fence, 24h bound, and final old/new expiry", () => updateFlow(core));
test("revoke remains caller-first and permits an otherwise-disempowered grantor to withdraw", () => revokeFlow(core));
test("only currently valid shares migrate and receipt consumption follows confirmed commit", () => migrationAndReceipts(core));
test("three HTTP adapters retain exact extractors and only compose/delegate/respond", () => httpContract(http));
test("DTOs, routes, playback adapter, and public maintenance exports remain compatible", () => {
  assert.equal(hash(section(core, "#[derive(Deserialize)]", "async fn preserve_current_room_shares(")),
    "49e226ca9a4f8fa837452ad4312fc722ac589137542d58ae2d50a4f96a618199");
  assert.equal(hash(fn(http, "authorize_media")), "fd1405786018e0e49ef2592338baa7d4219882548a0c3d5a52b42e88a3670538");
  assert.ok(http.includes("pub use catalog::library_authority::enabled;"));
  assert.ok(http.includes("pub(crate) use catalog::library_authority::retire_maintenance;"));
  const routes = source("bootstrap/routes.rs");
  assert.match(routes, /"\/api\/v1\/libraries\/\{id\}\/room-shares",\s*post\(private_library::share\)/);
  assert.match(routes, /"\/api\/v1\/libraries\/\{id\}\/room-shares\/\{grant\}",\s*axum::routing::delete\(private_library::revoke_share\)\s*\.patch\(private_library::update_share\)/);
});
test("shared final exact-login recheck and committed-retirement failure policy are retained", () => {
  const commit = fn(authority, "commit_caller");
  inOrder(commit, ["lock_caller(&mut tx, user, h, operator).await?", "tx.commit().await?", "Ok(())"]);
  const caller = fn(authority, "lock_caller");
  inOrder(caller, ["media_authorization::login_hash(h)?", "SELECT admin FROM users WHERE id=$1 FOR SHARE",
    "WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE", ".bind(login).bind(user.id)", 'err(StatusCode::UNAUTHORIZED, "session_expired")']);
  const response = section(authority, "pub(crate) async fn response(self, db: &PgPool) -> Value", "\n}\n");
  inOrder(response, ["self.retirement_required && retire(db).await.is_err()", "tracing::warn!", "self.value"]);
  assert.doesNotMatch(response, /await\?|Result<|\.begin\(/);
});

// Every mutation targets actual production source in memory; an unchanged
// mutation is an error, and each designated production guard must reject it.
const negatives = [
  ["missing share gate", core, admissionContract, "    require_enabled()?;\n", ""],
  ["guest admission enabled", core, admissionContract, "authenticate(request, &h, true, false)", "authenticate(request, &h, true, true)"],
  ["write admission disabled", core, admissionContract, "authenticate(request, &h, true, false)", "authenticate(request, &h, false, false)"],
  ["full application capability added", core, admissionContract, "request: RequestContext<'_>", "request: App"],
  ["caller lock precedes room lock", core, shareFlow, "let mut tx = db.begin().await?;", "let mut tx = db.begin().await?; lock_caller(&mut tx, &u, &h, false).await?;"],
  ["share final permission deleted", core, shareFlow, '    require_current_permission(&mut tx, u.id, id, "share_to_room").await?;\n', ""],
  ["share source binding changed", core, unchangedTransactions, ".bind(body.media_id).bind(id).bind(u.id)", ".bind(body.media_id).bind(id).bind(Uuid::nil())"],
  ["final old expiry fence deleted", core, updateFlow, " AND to_timestamp($3::double precision/1000)>clock_timestamp()", ""],
  ["24h expiry cap removed", core, updateFlow, " AND to_timestamp($5::double precision/1000)<=g.created_at+interval '24 hours'", ""],
  ["grantor authority removed from final update", core, updateFlow, " AND library_allowed(grantor_id,library_id,'share_to_room')", ""],
  ["revoke feature gated", core, revokeFlow, "body: Expected,\n) -> Result<Value> {", "body: Expected,\n) -> Result<Value> {\n    require_enabled()?;"],
  ["own-share exception removed from final revoke", core, revokeFlow, " OR EXISTS(SELECT 1 FROM room_media_grants WHERE id=$3 AND library_id=$2 AND grantor_id=$1)", ""],
  ["revoked rows can migrate", core, migrationAndReceipts, " AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()", " AND g.expires_at>clock_timestamp()"],
  ["stale epoch can migrate", core, migrationAndReceipts, " AND g.permission_epoch=$2", ""],
  ["source generation can migrate stale rows", core, migrationAndReceipts, " AND g.source_generation=m.library_source_generation", ""],
  ["commit failure ignored", core, migrationAndReceipts, "    commit_caller(tx, &u, &h, false).await?;\n    let committed", "    let _ = commit_caller(tx, &u, &h, false).await;\n    let committed"],
  ["retirement response propagates error", core, migrationAndReceipts, "Ok(committed.response(db).await)", "Ok(committed.response(db).await?)"],
  ["HTTP reintroduces admission", http, httpContract, "catalog::room_shares::share(app.identity_context()", "auth(&app, &h, true).await?; catalog::room_shares::share(app.identity_context()"],
  ["HTTP finalizes a receipt", http, httpContract, "catalog::room_shares::update_share(app.identity_context(), h, id, grant, body).await?", "catalog::room_shares::update_share(app.identity_context(), h, id, grant, body).await?.response(&app.db).await"],
];
for (const [name, text, check, from, to] of negatives) {
  test(`negative control rejects: ${name}`, () => {
    assert.ok(text.includes(from), "mutation must touch current production source");
    const mutated = text.replace(from, to);
    assert.notEqual(mutated, text);
    assert.throws(() => check(mutated), { code: "ERR_ASSERTION" });
  });
}
