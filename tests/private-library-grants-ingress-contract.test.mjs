// Source seams and in-memory mutation controls only. These do not establish
// live sessions, PostgreSQL waits/expiry, committed snapshots, or HTTP behavior.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const production = (text) => text.split("#[cfg(test)]")[0];
const libraries = production(source("catalog/libraries.rs"));
const media = production(source("catalog/media_reads.rs"));
const http = source("private_library.rs");
const authority = production(source("catalog/library_authority.rs"));
const compact = (text) => text.replace(/\s+/g, "");
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
const fn = (text, name) => {
  const pattern = new RegExp(`^(?:pub(?:\\([^)]*\\))? )?(?:async )?fn ${name}\\(`, "m");
  const from = text.search(pattern);
  assert.ok(from >= 0, `missing function ${name}`);
  const until = text.indexOf("\n}", from);
  assert.ok(until > from, `missing end of ${name}`);
  return text.slice(from, until + 2);
};
const body = (text) => {
  const match = text.match(/\) -> Result<(?:Value|Response)> \{([\s\S]*)\n\}$/);
  assert.ok(match, "operation or adapter result boundary");
  return match[1];
};
const inOrder = (text, parts) => {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered ${part}`);
    previous = found;
  }
};
const writes = ["create", "rename", "grant", "revoke", "remove", "transfer"];
const reads = ["list", "issued_shares", "detail"];
const gated = new Set(["create", "grant", "transfer"]);

function httpAdapters(text) {
  const args = {
    list: "h", issued_shares: "h,query", create: "h,body", detail: "h,id",
    rename: "h,id,body", grant: "h,id,body", revoke: "h,id,target,body",
    remove: "&app.catalog_encryptor(),h,id,body", transfer: "h,id,body", media: "h,id,q",
  };
  for (const [name, params] of Object.entries(args)) {
    const target = name === "media" ? "media_reads::list_private" : `libraries::${name}`;
    const actual = compact(body(fn(text, name)));
    // Permit rustfmt's trailing call comma, but no independent policy or receipt work.
    const normalized = actual.replace(/,\)/g, ")");
    const expected = `Ok(responses::ok_json(catalog::${target}(app.identity_context(),${params}).await?))`;
    assert.equal(normalized, expected, name);
  }
  assert.match(fn(text, "issued_shares"), /axum::extract::Query\(query\): axum::extract::Query<IssuedSharesQuery>/);
  assert.match(fn(text, "media"), /axum::extract::Query\(q\): axum::extract::Query<MediaQuery>/);
  for (const [name, dto] of [["create", "Create"], ["rename", "Rename"], ["grant", "Grant"], ["revoke", "Expected"], ["remove", "Expected"], ["transfer", "Transfer"]]) {
    assert.ok(fn(text, name).includes(`Json(body): Json<${dto}>`), name);
  }
}

function admission(text) {
  assert.doesNotMatch(text, /\b(?:App|Aes256Gcm|Response|State)\b|responses::|reqwest::Client|auth_viewer\(/);
  count(text, /identity_request::authenticate\(/g, 9);
  count(text, /require_enabled\(\)\?/g, 3);
  for (const name of [...reads, ...writes]) {
    const operation = fn(text, name), content = body(operation);
    assert.match(operation, /request: RequestContext<'_>/);
    assert.doesNotMatch(operation.slice(0, operation.indexOf(") -> Result<Value>")), /u: User|db: &PgPool|context: Source/);
    const prefix = `let db = request.db;${gated.has(name) ? "require_enabled()?;" : ""}let u = identity_request::authenticate(request, &h, ${writes.includes(name)}, false).await?;`;
    assert.ok(compact(content).startsWith(compact(prefix)), `${name} admission precedes its original body`);
    count(operation, /identity_request::authenticate\(/g, 1);
    count(operation, /require_enabled\(\)\?/g, Number(gated.has(name)));
    if (name !== "remove") assert.doesNotMatch(operation, /\bencrypt\b|\bdecrypt\b|Source\w+Context/);
  }
  const remove = fn(text, "remove");
  assert.match(remove, /encrypt: &\(dyn Fn\(&Value\) -> anyhow::Result<String> \+ Sync\)/);
  inOrder(remove, ["authenticate(request, &h, true, false).await?", "let context = SourceWriteContext { db, encrypt };", "context.db.begin().await?"]);
  assert.doesNotMatch(text, /(?:_authorized|_admitted)\s*\(/);
}

function mediaAdmission(text) {
  const operation = fn(text, "list_private"), content = body(operation);
  assert.match(operation, /request: RequestContext<'_>/);
  assert.ok(compact(content).startsWith(compact("let db = request.db; let viewer = identity_request::authenticate(request, &h, false, false).await?.id;")));
  count(operation, /identity_request::authenticate\(/g, 1);
  assert.doesNotMatch(operation, /require_enabled\(|\.begin\(|\.commit\(|\bencrypt\b|\bdecrypt\b|Source\w+Context/);
  inOrder(operation, [
    "authenticate(request, &h, false, false)",
    "SELECT library_allowed($1,$2,'browse')",
    'err(StatusCode::NOT_FOUND, "library_not_found")',
    "s.library_id=$2 AND library_media_allowed($1,m.id,'browse',NULL)",
    "($3::uuid IS NULL OR m.id>$3)",
    "ORDER BY m.id LIMIT $5",
    ".bind(q.limit.unwrap_or(100).clamp(1,200)).fetch_all(db).await?",
  ]);
}

function receipts(text) {
  for (const name of writes) {
    const operation = fn(text, name);
    count(operation, /\.begin\(/g, 1);
    count(operation, /commit_caller\(/g, 1);
    count(operation, /CommittedLibraryChange::new\(/g, 1);
    count(operation, /committed\.response\(/g, 1);
    inOrder(operation, [
      "commit_caller(tx, &u, &h, false).await?;",
      "let committed = CommittedLibraryChange::new(",
      "Ok(committed.response(db).await)",
    ]);
    assert.match(operation, /Ok\(committed\.response\(db\)\.await\)\n\}$/);
    assert.doesNotMatch(operation, /\.commit\(|tokio::spawn|retire\(|\.response\(db\)\.await\?/);
  }
  for (const name of ["create", "rename", "grant", "revoke"]) {
    const operation = fn(text, name);
    inOrder(operation, ["let value = detail_value(&mut tx, u.id, id).await?;", "commit_caller(tx, &u, &h, false).await?;"]);
    assert.ok(operation.includes(`CommittedLibraryChange::new(id, value, ${name === "grant" || name === "revoke"});`));
  }
  for (const name of ["remove", "transfer"]) assert.doesNotMatch(fn(text, name), /detail_value\(/);
  assert.ok(compact(fn(text, "remove")).includes(compact('CommittedLibraryChange::new(id, json!({"id":id,"deleted":true}), true)')));
  assert.ok(compact(fn(text, "transfer")).includes(compact('CommittedLibraryChange::new(id, json!({"id":id,"owner_id":target,"transferred":true}), true, )')));
}

function transactionOrder(text) {
  inOrder(fn(text, "create"), [
    "let name = name(&body.name)?;", "db.begin().await?", "SELECT id FROM users WHERE id=$1 FOR UPDATE",
    "lock_caller(&mut tx, &u, &h, false).await?", "if count >= 20", "INSERT INTO private_libraries",
    'audit(&mut tx, id, u.id, "created", None)', "detail_value(&mut tx, u.id, id)", "commit_caller(",
  ]);
  inOrder(fn(text, "rename"), [
    "let name = name(&body.name)?;", "db.begin().await?", "lock_caller(",
    "lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?)",
    "UPDATE private_libraries", "detail_value(", 'require_current_permission(&mut tx, u.id, id, "manage")', "commit_caller(",
  ]);
  inOrder(fn(text, "grant"), [
    "!(1..=720).contains(&body.expires_in_hours)", "!(body.browse || body.play || body.share_to_room || body.manage)",
    "(body.share_to_room && !body.play)", "db.begin().await?", "lock_caller(",
    "lock_manage(&mut tx, u.id, id, revision(&body.expected_revision)?)", 'lib.get::<String, _>("visibility") != "private"',
    '"library_owner_required"', "SELECT id FROM users WHERE username=$1", '"user_not_found"',
    'Some(target) == lib.get::<Option<Uuid>, _>("owner_id")', "INSERT INTO library_grants", "advance(&mut tx, id, true)", "commit_caller(",
  ]);
  inOrder(fn(text, "revoke"), ["db.begin().await?", "lock_caller(", "lock_manage(", '"library_owner_required"', "DELETE FROM library_grants", "advance(&mut tx, id, true)", "commit_caller("]);
  assert.doesNotMatch(fn(text, "revoke"), /user_not_found|SELECT id FROM users/);
  inOrder(fn(text, "remove"), [
    "lock_caller(", "lock_manage(", '"library_shared_protected"', '"library_owner_required"',
    "SELECT id FROM sources WHERE library_id=$1 ORDER BY id FOR UPDATE", "kind='agent'", '"library_managed_sources"',
    "require_idle_sources(&mut tx, id, None).await?", "let empty = (context.encrypt)(&json!({}))?;",
    "UPDATE sources SET config_encrypted=$2,deleted_at=clock_timestamp()", "UPDATE media_items SET available=false",
    "DELETE FROM library_grants", "UPDATE room_media_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp())",
    "UPDATE private_libraries SET deleted_at=clock_timestamp(),revision=revision+1,permission_epoch=permission_epoch+1",
    "commit_caller(",
  ]);
  count(fn(text, "remove"), /\(context\.encrypt\)/g, 1);
  assert.doesNotMatch(fn(text, "remove"), /DELETE FROM (?:sources|media_items|agents)/);
  inOrder(fn(text, "transfer"), [
    "lock_caller(", "lock_manage(", '"library_owner_required"', "SELECT id FROM users WHERE username=$1", '"user_not_found"',
    "if target == u.id", "UPDATE private_libraries SET owner_id=$2,revision=revision+1,permission_epoch=permission_epoch+1",
    "DELETE FROM library_grants WHERE library_id=$1 AND user_id IN($2,$3)", "commit_caller(",
  ]);
}

function readBoundaries(text) {
  for (const name of reads) assert.doesNotMatch(fn(text, name), /\.begin\(|\.commit\(|commit_caller\(|lock_manage\(/);
  assert.ok(fn(text, "list").includes('"enabled":enabled()'));
  inOrder(fn(text, "detail_value"), [
    "library_allowed($1,l.id,'browse') OR library_allowed($1,l.id,'manage')",
    'if row.get::<bool, _>("manage")', "SELECT id,name,kind,access_policy_revision,settings_revision FROM sources",
    "SELECT g.*,u.username", "SELECT id,actor_id,action,target_id", "g.grantor_id=$3 OR library_allowed($3,$1,'manage')",
  ]);
  const issued = fn(text, "issued_shares");
  assert.ok(issued.includes("WHERE g.grantor_id=$1 AND g.revoked_at IS NULL AND l.deleted_at IS NULL"));
  assert.ok(issued.includes("library_allowed($1,l.id,'browse') THEN m.title ELSE NULL"));
  assert.ok(issued.includes("ORDER BY g.id LIMIT 101"));
  assert.ok(issued.includes("rows.len() > 100"));
  assert.ok(issued.includes("rows.iter().take(100)"));
}

function revisionRules(text) {
  const revision = fn(text, "revision");
  inOrder(revision, ["v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit())", '"library_invalid"', 'v.parse::<i64>()', ".filter(|v| *v > 0 && *v < i64::MAX)"]);
  assert.doesNotMatch(revision, /to_string\(|starts_with\('0'\)|trim\(/);
  inOrder(fn(text, "name"), ["let v = v.trim();", "(1..=100).contains(&v.chars().count())", "v.chars().any(|c| c.is_control())", '"library_invalid"']);
}

function retirement(text) {
  const response = text.slice(text.indexOf("pub(crate) async fn response("), text.indexOf("// Follow upstream_policy"));
  inOrder(response, ["if self.retirement_required && retire(db).await.is_err()", "tracing::warn!", "self.value"]);
  assert.match(response, /response\(self, db: &PgPool\) -> Value/);
  assert.doesNotMatch(response, /\.await\?|detail_value|tokio::spawn/);
}

test("all ten HTTP adapters own only extraction, narrow composition, and ok_json", () => httpAdapters(http));
test("library operations own all nine original admission points and the exact three gates", () => admission(libraries));
test("private media read authenticates before both current-visibility queries", () => mediaAdmission(media));
test("six library writes consume their original receipt only after confirmed commit", () => receipts(libraries));
test("library locks, validation precedence, cipher timing, and tombstones keep their order", () => transactionOrder(libraries));
test("library reads retain current enabled value and field/issued-share visibility", () => readBoundaries(libraries));
test("library revisions still accept positive leading zero strings without source-rule normalization", () => revisionRules(libraries));
test("retirement failure preserves the committed snapshot and maintenance ownership", () => retirement(authority));
test("playback authorization adapter and both existing re-exports remain available", () => {
  assert.ok(http.includes("pub use catalog::library_authority::enabled;"));
  assert.ok(http.includes("pub(crate) use catalog::library_authority::retire_maintenance;"));
  assert.ok(fn(http, "authorize_media").includes("catalog::library_authority::authorize_media(&app.db, user, media, action, room).await"));
});

// Each negative edits actual current production text in memory; no source file
// is rewritten and no server, database, provider, or socket is started.
const negatives = [
  ["HTTP authenticates independently", http, httpAdapters, "pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Response> {\n", "pub async fn list(State(app): State<App>, h: HeaderMap) -> Result<Response> {\n    let _ = auth(&app, &h, false).await?;\n"],
  ["HTTP finalizes mutation receipt", http, httpAdapters, "catalog::libraries::rename(app.identity_context(), h, id, body).await?", "catalog::libraries::rename(app.identity_context(), h, id, body).await?.response(&app.db).await"],
  ["HTTP remove captures full application cipher", http, httpAdapters, "&app.catalog_encryptor()", "&|value| app.encrypt(value)"],
  ["operation accepts broad application", libraries, admission, "request: RequestContext<'_>", "request: App"],
  ["registered read admits guests", libraries, admission, "authenticate(request, &h, false, false)", "authenticate(request, &h, false, true)"],
  ["write bypasses Origin and CSRF admission", libraries, admission, "authenticate(request, &h, true, false)", "authenticate(request, &h, false, false)"],
  ["create flag moves after auth", libraries, admission, "require_enabled()?;\n    let u = identity_request::authenticate(request, &h, true, false).await?;", "let u = identity_request::authenticate(request, &h, true, false).await?;\n    require_enabled()?;"],
  ["rename gains a feature gate", libraries, admission, "pub(crate) async fn rename(", "pub(crate) async fn rename("],
  ["missing receipt consumption", libraries, receipts, "Ok(committed.response(db).await)", "Ok(committed)"],
  ["receipt minted before commit confirmation", libraries, receipts, "commit_caller(tx, &u, &h, false).await?;\n    let committed = CommittedLibraryChange::new(id, value, false);", "let committed = CommittedLibraryChange::new(id, value, false);\n    commit_caller(tx, &u, &h, false).await?;"],
  ["extra mutation transaction", libraries, receipts, "let name = name(&body.name)?;", "let extra = db.begin().await?;\n    let name = name(&body.name)?;"],
  ["create weakens users lock", libraries, transactionOrder, "SELECT id FROM users WHERE id=$1 FOR UPDATE", "SELECT id FROM users WHERE id=$1 FOR SHARE"],
  ["rename omits final manage check", libraries, transactionOrder, 'require_current_permission(&mut tx, u.id, id, "manage").await?;', ""],
  ["grant no longer requires play for share", libraries, transactionOrder, "(body.share_to_room && !body.play)", "false"],
  ["remove encrypts before idle check", libraries, transactionOrder, "require_idle_sources(&mut tx, id, None).await?;\n    let empty = (context.encrypt)(&json!({}))?;", "let empty = (context.encrypt)(&json!({}))?;\n    require_idle_sources(&mut tx, id, None).await?;"],
  ["remove drops ordered source locking", libraries, transactionOrder, "sources WHERE library_id=$1 ORDER BY id FOR UPDATE", "sources WHERE library_id=$1 FOR UPDATE"],
  ["transfer keeps old owner grant", libraries, transactionOrder, "user_id IN($2,$3)", "user_id=$2"],
  ["media allows guest admission", media, mediaAdmission, "authenticate(request, &h, false, false)", "authenticate(request, &h, false, true)"],
  ["media page drops current visibility", media, mediaAdmission, " AND library_media_allowed($1,m.id,'browse',NULL)", ""],
  ["media page ignores cap", media, mediaAdmission, "q.limit.unwrap_or(100).clamp(1,200)", "q.limit.unwrap_or(100)"],
  ["issued shares expose inaccessible title", libraries, readBoundaries, "library_allowed($1,l.id,'browse') THEN m.title ELSE NULL", "true THEN m.title ELSE NULL"],
  ["list snapshots enabled", libraries, readBoundaries, '"enabled":enabled()', '"enabled":true'],
  ["revision incorrectly rejects leading zeros", libraries, revisionRules, "v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit())", "v.is_empty() || v.starts_with('0') || !v.bytes().all(|c| c.is_ascii_digit())"],
  ["retirement failure escapes committed success", authority, retirement, "retire(db).await.is_err()", "retire(db).await?"],
];
for (const [name, text, check, from, to] of negatives) {
  test(`negative control rejects: ${name}`, () => {
    assert.ok(text.includes(from), "mutation must touch current production source");
    const mutated = name === "rename gains a feature gate"
      ? text.replace(fn(text, "rename"), fn(text, "rename").replace("let db = request.db;", "let db = request.db; require_enabled()?;"))
      : text.replace(from, to);
    assert.notEqual(mutated, text);
    assert.throws(() => check(mutated), { code: "ERR_ASSERTION" });
  });
}
