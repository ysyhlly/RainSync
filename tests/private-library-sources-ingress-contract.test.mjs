// Source seam guards and in-memory deletion/modification controls only.
// They do not prove PostgreSQL locks/expiry, HTTP responses, provider I/O, or
// physical resource disposal. See the lane's validation-boundary document.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const production = (text) => text.split("#[cfg(test)]")[0];
const sources = production(source("catalog/private_sources.rs"));
const scans = production(source("catalog/scan_pages.rs"));
const http = source("private_library.rs");
const compact = (text) => text.replace(/\s+/g, " ").trim();
const fn = (text, name) => {
  const match = text.match(new RegExp(`^(?:pub(?:\\(crate\\))? )?async fn ${name}\\([\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing function ${name}`);
  return compact(match[0]);
};
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
    const found = text.indexOf(compact(part), previous + 1);
    assert.ok(found > previous, `missing or reordered ${part}`);
    previous = found;
  }
};
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
const entries = [
  ["add_source", true, true, ["encrypt"], "SourceWriteContext", 'if !matches!(body.kind.as_str()'],
  ["source_detail", false, false, ["decrypt"], "SourceReadContext", "let mut tx = context.db.begin()"],
  ["update_source", true, true, ["encrypt", "decrypt"], "SourceChangeContext", "let expected = source_settings::revision"],
  ["remove_source", true, false, ["encrypt"], "SourceWriteContext", "let mut tx = context.db.begin()"],
  ["attach_source", true, true, [], null, "admin(&u)?"],
  ["scan_status", false, false, [], null, "let allowed:bool=sqlx::query_scalar"],
  ["scan", true, true, ["decrypt"], "SourceReadContext", "let allowed:bool=sqlx::query_scalar"],
];

function admission(text, family) {
  assert.doesNotMatch(text, /\bApp\b|Aes256Gcm|\b(?:app|context|request)\s*\.\s*key\b|reqwest::Client/);
  for (const [name, write, gate, callbacks, context, firstWork] of entries.filter(([name]) => family === "scans" ? name.startsWith("scan") : !name.startsWith("scan"))) {
    const op = fn(text, name);
    const signature = op.slice(0, op.indexOf(" {") + 2);
    assert.match(signature, /request: RequestContext<'_>/, name);
    assert.match(signature, /h: HeaderMap/, name);
    assert.match(signature, /-> Result<Value>/, name);
    assert.doesNotMatch(signature, /\bUser\b|db: &PgPool|context: .*Context/);
    for (const callback of ["encrypt", "decrypt"]) {
      const expected = callback === "encrypt"
        ? "encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync)"
        : "decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync)";
      assert.equal(signature.includes(expected), callbacks.includes(callback), `${name}: ${callback}`);
    }
    count(op, /request::authenticate\(/g, 1);
    count(op, /require_enabled\(\)\?/g, Number(gate));
    inOrder(op, ["let db = request.db;", ...(gate ? ["require_enabled()?"] : []), `request::authenticate(request, &h, ${write}, false)`, ...(context ? [`let context = ${context} { db,`] : []), firstWork]);
    assert.doesNotMatch(op, /auth_viewer\(|authenticated_user|_authorized\(/);
  }
}

function adapters(text) {
  for (const [name, , , callbacks] of entries) {
    const adapter = fn(text, name);
    const body = adapter.slice(adapter.indexOf("-> Result<Response> {") + "-> Result<Response> {".length);
    assert.doesNotMatch(body, /\bauth\(|authenticate\(|admin\(|require_enabled\(|Source(?:Read|Write|Change)Context|app\.(?:db|encrypt|decrypt)\b|committed|\.response\(|sqlx::/);
    count(body, /responses::ok_json\(/g, 1);
    count(body, /app\.identity_context\(\)/g, 1);
    count(body, /catalog::(?:private_sources|scan_pages)::\w+\(/g, 1);
    for (const callback of ["encrypt", "decrypt"]) {
      count(body, new RegExp(`app\\.catalog_${callback}or\\(\\)`, "g"), Number(callbacks.includes(callback)));
    }
    assert.match(body, new RegExp(`catalog::${name.startsWith("scan") ? "scan_pages" : "private_sources"}::${name}\\(`));
    assert.match(body, /\.await\?/);
  }
  // Deliberately allow this playback adapter and the maintenance re-exports.
  assert.match(fn(text, "authorize_media"), /catalog::library_authority::authorize_media\(&app.db, user, media, action, room\).await/);
  assert.match(text, /pub use catalog::library_authority::enabled;/);
  assert.match(text, /pub\(crate\) use catalog::library_authority::retire_maintenance;/);
}

function sourceTransactions(text) {
  const add = fn(text, "add_source");
  inOrder(add, [
    'if !matches!(body.kind.as_str(), "http" | "s3")', "let name = name(&body.name)?",
    'if !u.admin && body.kind == "http"', "SourceAccessPolicy::public_origin(&body.config.url)",
    'if body.kind == "s3"', "admin(&u)?", "providers::s3::validate_config(&body.config)",
    "providers::access_policy::SourceAccess::new(", "providers::validate_source_headers(&body.config.headers)",
    "context.db.begin()", "lock_caller(&mut tx, &u, &h, u.admin)", "library_allowed($2,id,'manage') FOR UPDATE",
    "if count >= 100", "(context.encrypt)", "INSERT INTO sources", "advance(&mut tx, id, false)",
    'audit(&mut tx, id, u.id, "source_created", Some(source))',
    'require_current_permission(&mut tx, u.id, id, "manage")', "commit_caller(tx, &u, &h, u.admin)",
  ]);
  count(add, /\(context\.encrypt\)/g, 1);
  const detail = fn(text, "source_detail");
  inOrder(detail, ["context.db.begin()", "lock_caller(&mut tx, &u, &h, false)", "lock_source_library(&mut tx, u.id, library)", "deleted_at IS NULL FOR SHARE", "manageable_scoped_source(&row)?", "(context.decrypt)", "source_settings::safe_detail(&row, &config)", 'require_current_permission(&mut tx, u.id, library, "manage")', "commit_caller(tx, &u, &h, false)", "Ok(value)"]);
  const update = fn(text, "update_source");
  inOrder(update, [
    "let expected = source_settings::revision(&body.expected_revision)?", "let operator = u.admin && body.config.is_some()",
    "context.db.begin()", "lock_caller(&mut tx, &u, &h, operator)", "lock_source_library(&mut tx, u.id, library)",
    "deleted_at IS NULL FOR UPDATE", "manageable_scoped_source(&row)?", 'if row.get::<i64, _>("settings_revision") != expected',
    "(context.decrypt)", "if let Some(patch) = &body.config", '!u.admin && (kind == "s3"',
    "source_settings::merge_config(&kind, &old_raw, patch)", 'if !u.admin && patch.contains_key("url")',
    "source_settings::parse_config(&raw)", '"source_credentials_origin_changed"', "let changed = serde_json::to_value(&old)",
    ".map(source_settings::name)", "if changed { source_settings::validate_config", "UPDATE media_items SET resource=$3",
    "UPDATE media_items SET available=false", "let encrypted = if changed { (context.encrypt)(&raw)? } else { row.get(\"config_encrypted\") }",
    "UPDATE sources SET name=$2,config_encrypted=$3", 'let did_change = updated.get::<i64, _>("settings_revision") != expected',
    "if did_change { advance(&mut tx, library, false)", "source_settings::safe_detail(&updated, &next)",
    'value["config_changed"] = json!(changed)', 'value["rescan_required"] = json!(changed)',
    'require_current_permission(&mut tx, u.id, library, "manage")', "commit_caller(tx, &u, &h, operator)",
    "CommittedLibraryChange::new(library, value, changed)", "Ok(committed.response(db).await)",
  ]);
  count(update, /\(context\.encrypt\)/g, 1);
  const remove = fn(text, "remove_source");
  inOrder(remove, [
    "context.db.begin()", "lock_caller(&mut tx, &u, &h, false)", "lock_manage(", "revision(&body.expected_library_revision)?",
    "deleted_at IS NULL FOR UPDATE", "manageable_scoped_source(&row)?", "source_settings::revision(&body.expected_revision)?",
    "require_idle_sources(&mut tx, library, Some(source))", "(context.encrypt)(&json!({}))?", "deleted_at=clock_timestamp()",
    "UPDATE media_items SET available=false", "UPDATE room_media_grants SET revoked_at", "advance(&mut tx, library, false)",
    'require_current_permission(&mut tx, u.id, library, "manage")', "commit_caller(tx, &u, &h, false)", "CommittedLibraryChange::new(", "Ok(committed.response(db).await)",
  ]);
  assert.doesNotMatch(remove, /source_settings::revision\(&body.expected_library_revision\)/);
  const attach = fn(text, "attach_source");
  inOrder(attach, [
    "admin(&u)?", "db.begin()", "lock_caller(&mut tx, &u, &h, true)", "SELECT library_id FROM sources",
    "ORDER BY id FOR UPDATE", "SELECT * FROM private_libraries", "revision(&body.expected_revision)?",
    "SELECT library_id FROM sources WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", "if current != previous", "if previous == id",
    "UPDATE sources SET library_id=$2", "advance(&mut tx, id, true)", "advance(&mut tx, previous, true)",
    '"operator_source_attached"', '"operator_source_detached"', "commit_caller(tx, &u, &h, true)", "CommittedLibraryChange::new(", "Ok(committed.response(db).await)",
  ]);
  assert.doesNotMatch(attach, /encrypt|decrypt/);
  for (const name of ["add_source", "source_detail", "update_source", "remove_source", "attach_source"]) {
    const op = fn(text, name);
    count(op, /\.begin\(/g, 1);
    count(op, /commit_caller\(/g, 1);
    assert.doesNotMatch(op, /\.commit\(|spawn\(|detail_value\(/);
  }
  for (const name of ["update_source", "remove_source", "attach_source"]) {
    const op = fn(text, name);
    count(op, /CommittedLibraryChange::new\(/g, 1);
    count(op, /committed\.response\(db\)\.await/g, 1);
    assert.doesNotMatch(op, /committed\.response\(db\)\.await\?/);
  }
}

function scanTransactions(text) {
  const status = fn(text, "scan_status");
  inOrder(status, ["request::authenticate(request, &h, false, false)", "library_allowed($3,$2,'manage')", "if !allowed", '"source_not_found"', "SELECT * FROM s3_index_scans"]);
  assert.doesNotMatch(status, /try_acquire|\.begin\(|context\.decrypt/);
  const scan = fn(text, "scan");
  inOrder(scan, ["request::authenticate(request, &h, true, false)", "library_allowed($3,$2,'manage')", "if !allowed", '"source_not_found"', "scan_source_page_as(&context, source, body.restart, Some((user, h, lib))).await"]);
  assert.doesNotMatch(scan, /\.begin\(|try_acquire|scan_source_page\(/);
  assert.match(fn(text, "scan_source_page"), /scan_source_page_as\(context, source, restart, None\).await/);
  const lock = fn(text, "lock_scan_caller");
  inOrder(lock, ["if let Some((user, headers, library)) = caller", "lock_caller(tx, user, headers, false)", "library_allowed($2,id,'manage') FOR SHARE", "library_id=$2 AND deleted_at IS NULL", "if allowed.is_none() || !scope"]);
  inOrder(fn(text, "commit_scan"), ["if let Some((user, headers, library)) = caller", "lock_caller(&mut tx, user, headers, false)", 'require_current_permission(&mut tx, user.id, *library, "manage")', "tx.commit().await?"]);
  inOrder(fn(text, "lock_scan_page"), [
    "lock_scan_caller(tx, source, caller)", "SELECT access_policy_revision", "deleted_at IS NULL FOR SHARE", "s3_index_scans WHERE source_id=$1 FOR UPDATE", "source_scans WHERE source_id=$1 FOR UPDATE",
    "if source_current != source_revision", 'row.get::<Uuid, _>("scan_id") != scan_id', "generation != scan_id", 'row.get::<Option<String>, _>("continuation_token") != *cursor', 'row.get::<String, _>("status") == "completed"', '"source_changed"',
  ]);
  const page = fn(text, "scan_source_page_as");
  count(page, /\.begin\(/g, 3);
  count(page, /commit_scan\(tx, &caller\)/g, 5);
  count(page, /\(context\.decrypt\)/g, 2);
  assert.doesNotMatch(page, /context\.encrypt|spawn\(|CommittedLibraryChange/);
  inOrder(page, ["Semaphore::new(2)", ".try_acquire()", "context.db.begin()", "lock_scan_caller(&mut tx, source, &caller)", "deleted_at IS NULL FOR SHARE", 'if kind == "http"', "(context.decrypt)", 'providers::list_items("http", &config)', "UPDATE media_items SET available=false", "INSERT INTO source_scans", "commit_scan(tx, &caller)", 'if kind != "s3"', "(context.decrypt)", 'let source_revision = source_row.get::<i64, _>("access_policy_revision")', "s3_index_scans WHERE source_id=$1 FOR UPDATE", "let reset = restart", 'r.get::<i64, _>("source_revision") != source_revision']);
  inOrder(page, ['row.get::<String, _>("status") == "completed"', "let result = scan_value(row)", "commit_scan(tx, &caller)", "return Ok(result)", "let (scan_id, cursor)", "INSERT INTO s3_index_scans", "DELETE FROM s3_index_scan_seen", "DELETE FROM s3_index_scan_cursors", "INSERT INTO source_scans", "commit_scan(tx, &caller)", "let fetch = async", "providers::s3::list_page(&config, cursor.as_deref(), 100)", "providers::s3::head_object(", ".buffer_unordered(4)", "Duration::from_secs(60), fetch"]);
  inOrder(page, ["let (objects, next) = match result", "let mut tx = context.db.begin()", "lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor)", "UPDATE s3_index_scans SET status='failed'", "commit_scan(tx, &caller)", 'return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"))', "let mut tx = context.db.begin()", "let row = lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor)", 'if row.get::<i64, _>("page_count") >= 10_000', "s3_index_scan_cursors", "for object in &objects", "INSERT INTO media_items", "if next.is_none()", "UPDATE media_items m SET available=false", "UPDATE s3_index_scans SET continuation_token=$3", "SELECT * FROM s3_index_scans WHERE source_id=$1", "commit_scan(tx, &caller)", "Ok(scan_value(&row))"]);
}

test("five private source operations own narrow request admission", () => admission(sources, "sources"));
test("two private scan operations own narrow request admission", () => admission(scans, "scans"));
test("seven HTTP adapters only extract, supply capabilities, and encode success", () => adapters(http));
test("source transactions keep validation, snapshot/current authority, cipher and receipt ordering", () => sourceTransactions(sources));
test("private and shared scan paths keep the original multi-stage checkpoint owner", () => scanTransactions(scans));
test("confirmed source receipts keep success when post-commit retirement fails", () => {
  const authority = compact(source("catalog/library_authority.rs"));
  const response = section(authority, "pub(crate) async fn response(self, db: &PgPool) -> Value", "// Follow upstream_policy");
  inOrder(response, ["self.retirement_required && retire(db).await.is_err()", "tracing::warn!", "self.value"]);
  assert.doesNotMatch(response, /\.await\?|detail_value|Err\(/);
  const shared = source("catalog/scans.rs");
  assert.match(shared, /scan_pages::scan_source_page\(context, id, restart\)/);
});

// Each control mutates actual production text in memory. A missing mutation
// anchor is a failure, and the relevant production guard must reject the result.
const negatives = [
  ["raw application boundary", sources, (s) => admission(s, "sources"), "request: RequestContext<'_>", "request: App"],
  ["add admission removed", sources, (s) => admission(s, "sources"), "    let u = request::authenticate(request, &h, true, false).await?;", ""],
  ["feature gate removed", sources, (s) => admission(s, "sources"), "    require_enabled()?;", ""],
  ["feature gate after authentication", sources, (s) => admission(s, "sources"), "require_enabled()?;\n    let u = request::authenticate(request, &h, true, false).await?;", "let u = request::authenticate(request, &h, true, false).await?;\n    require_enabled()?;"],
  ["source read admits guests", sources, (s) => admission(s, "sources"), "authenticate(request, &h, false, false)", "authenticate(request, &h, false, true)"],
  ["status requires write CSRF", scans, (s) => admission(s, "scans"), "authenticate(request, &h, false, false)", "authenticate(request, &h, true, false)"],
  ["scan admits guests", scans, (s) => admission(s, "scans"), "authenticate(request, &h, true, false)", "authenticate(request, &h, true, true)"],
  ["handler resumes authentication", http, adapters, "catalog::private_sources::attach_source(app.identity_context(), h, id, body)", "{ auth(&app, &h, true).await?; catalog::private_sources::attach_source(app.identity_context(), h, id, body) }"],
  ["handler resumes broad cipher", http, adapters, "&app.catalog_decryptor()", "&|value| app.decrypt(value)"],
  ["source config accepts non-admin bindings", sources, sourceTransactions, "if !u.admin && body.kind == \"http\"", "if false && body.kind == \"http\""],
  ["source create drops current operator check", sources, sourceTransactions, "lock_caller(&mut tx, &u, &h, u.admin)", "lock_caller(&mut tx, &u, &h, false)"],
  ["source create encrypts before capacity check", sources, sourceTransactions, "if count >= 100", "let early = (context.encrypt)(&json!({}))?; if count >= 100"],
  ["detail drops final authority", sources, sourceTransactions, "require_current_permission(&mut tx, u.id, library, \"manage\").await?;", ""],
  ["update uses library revision parser", sources, sourceTransactions, "let expected = source_settings::revision(&body.expected_revision)?", "let expected = revision(&body.expected_revision)?"],
  ["update drops admin snapshot config restriction", sources, sourceTransactions, "let operator = u.admin && body.config.is_some()", "let operator = false"],
  ["update drops source CAS", sources, sourceTransactions, 'if row.get::<i64, _>("settings_revision") != expected', "if false"],
  ["rename unconditionally reencrypts", sources, sourceTransactions, "let encrypted = if changed", "let encrypted = if true"],
  ["delete uses source parser for library revision", sources, sourceTransactions, "revision(&body.expected_library_revision)?", "source_settings::revision(&body.expected_library_revision)?"],
  ["delete drops idle fence", sources, sourceTransactions, "require_idle_sources(&mut tx, library, Some(source)).await?;", ""],
  ["attach drops request admin before transaction", sources, sourceTransactions, "admin(&u)?;\n    let mut tx = db.begin().await?;", "let mut tx = db.begin().await?;"],
  ["receipt constructed before confirmed commit", sources, sourceTransactions, "commit_caller(tx, &u, &h, operator).await?;\n    let committed = CommittedLibraryChange::new(library, value, changed);", "let committed = CommittedLibraryChange::new(library, value, changed);\n    commit_caller(tx, &u, &h, operator).await?;"],
  ["attach drops sorted library locks", sources, sourceTransactions, "ORDER BY id FOR UPDATE", "FOR UPDATE"],
  ["attach drops current source scope fence", sources, sourceTransactions, "if current != previous", "if false"],
  ["retirement failure propagates after commit", sources, sourceTransactions, "Ok(committed.response(db).await)", "Ok(committed.response(db).await?)"],
  ["scan drops private caller", scans, scanTransactions, "Some((user, h, lib))", "None"],
  ["status skips initial scope permission", scans, scanTransactions, "if !allowed", "if false"],
  ["scan skips initial permission before slots", scans, scanTransactions, 'if !allowed {\n        return Err(err(StatusCode::NOT_FOUND, "source_not_found"));\n    }\n    scan_source_page_as', 'if false {\n        return Err(err(StatusCode::NOT_FOUND, "source_not_found"));\n    }\n    scan_source_page_as'],
  ["scan final authorization removed", scans, scanTransactions, "require_current_permission(&mut tx, user.id, *library, \"manage\").await?;", ""],
  ["checkpoint source revision fence removed", scans, scanTransactions, "source_current != source_revision", "false"],
  ["checkpoint generation fence removed", scans, scanTransactions, "generation != scan_id", "false"],
  ["checkpoint cursor fence removed", scans, scanTransactions, 'row.get::<Option<String>, _>("continuation_token") != *cursor', "false"],
  ["scan completed path skips commit reauthorization", scans, scanTransactions, "let result = scan_value(row);\n        commit_scan(tx, &caller).await?;", "let result = scan_value(row);"],
  ["provider budget reset", scans, scanTransactions, "Duration::from_secs(60)", "Duration::from_secs(120)"],
  ["failed checkpoint skips reauthorization", scans, scanTransactions, "lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor).await?;", ""],
  ["failed checkpoint returns 502 before commit", scans, scanTransactions, 'commit_scan(tx, &caller).await?;\n            return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));', 'return Err(err(StatusCode::BAD_GATEWAY, "s3_scan_failed"));'],
  ["success checkpoint skips reauthorization", scans, scanTransactions, "let row = lock_scan_page(&mut tx, source, &caller, source_revision, scan_id, &cursor).await?;", "let row = stale_row;"],
  ["non-final page retires unseen media", scans, scanTransactions, "if next.is_none()", "if true"],
];
for (const [name, text, check, from, to] of negatives) {
  test(`negative control rejects: ${name}`, () => {
    assert.ok(text.includes(from), `mutation must touch current production source: ${name}`);
    const mutated = text.replace(from, to);
    assert.notEqual(mutated, text);
    assert.throws(() => check(mutated), { code: "ERR_ASSERTION" });
  });
}
