// Pure source, exact finite inverse and in-memory mutation contracts only.
// No Cargo, subprocess, database/socket, provider, native runner or browser use.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rustFunction as fn, replaceOnce, restoreBilibiliRenewalAccountParent } from "./fixtures/bilibili-renewal-account-source-inverse.mjs";
import { restoreBilibiliRenewal } from "./fixtures/bilibili-login-source-inverse.mjs";

const read = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const parent = read("platform_accounts/renewal.rs");
const all = read("platform_accounts/renewal/account_operations.rs");
const core = all.split("#[cfg(test)]")[0];
const accounts = read("platform_accounts.rs");
const maintenance = read("platform_accounts/maintenance.rs");
const routes = read("bootstrap/routes.rs");
const compact = (text) => text.replace(/\s+/g, " ").trim();
const shape = (text) => compact(text).replace(/,\s*\)/g, ")").replace(/\s*([(),])\s*/g, "$1");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
const names = ["status", "set_preference"];
function inOrder(text, parts) {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered: ${part}`);
    previous = found;
  }
}
const header = `//! Complete viewer-owned Bilibili renewal status and opt-out transactions.
use super::super::{
    ACCOUNT_SELECT, expected_revision, guard_login, guard_login_live, lock_account, login_hash,
    maintenance, status_value,
};
use super::Preference;
use crate::identity::{RequestContext, request};
use crate::{Result, err};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;

`;
function capabilities(text) {
  assert.equal(text, header + ["public_status", ...names].map((name) => fn(text, name)).join("\n\n") + "\n\n");
  assert.doesNotMatch(text, /\b(?:App|State|Response|Registry|Aes256Gcm|PlatformHttp|Transport|AccountScope)\b|super::\*|responses::|providers::|reqwest|decrypt|encrypt|SourceWriteContext|SourceReadContext|\.clone\(\)|std::env|tokio::spawn/);
  assert.doesNotMatch(text, /playback::|oauth::|refresh_due|refresh_one|store_grant|native_delivery|upstream::|preparations|credential_encrypted|credential_live|credential_expires_at/);
  assert.deepEqual([...text.matchAll(/^pub\(super\) async fn (\w+)\(/gm)].map((m) => m[1]), names);
  for (const name of names) {
    const operation = fn(text, name);
    const signature = name === "status" ? "context: RequestContext<'_>, headers: HeaderMap" : "context: RequestContext<'_>, headers: HeaderMap, body: Preference,";
    assert.equal(shape(operation.slice(0, operation.indexOf("{\n"))), shape(`pub(super) async fn ${name}(${signature}) -> Result<Value>`));
    inOrder(operation, ["let db = context.db;", `request::authenticate(context, &headers, ${name === "status" ? "false" : "true"}, false).await?`, "login_hash(&headers)?"]);
    count(operation, /maintenance::begin_db\(db\)/g, 1);
    count(operation, /maintenance::phase\(/g, 4);
    count(operation, /maintenance::commit\(tx\)/g, 1);
    assert.doesNotMatch(operation, /\.begin\(|\.commit\(|timeout\(|\.unwrap\(|\.expect\(|loop \{|while |retry|rate_limit|claim_rate/);
  }
}
const renewalSql = "SELECT r.state,floor(extract(epoch FROM r.next_refresh_at)*1000)::bigint AS next_refresh_at_ms FROM platform_account_renewals r JOIN platform_accounts a ON a.id=r.account_id AND a.revision=r.credential_revision WHERE a.user_id=$1 AND a.provider='bilibili' AND a.state='connected' AND r.consent_login_hash=$2 AND playback_login_allowed($1,$2)";
function statusOrder(text) {
  const operation = fn(text, "status");
  inOrder(operation, [
    "authenticate(context, &headers, false, false)", "login_hash(&headers)?", "maintenance::begin_db(db).await?",
    "maintenance::phase(guard_login(&mut tx, user.id, &login)).await?",
    "let account = maintenance::phase(", "sqlx::query(ACCOUNT_SELECT)", ".bind(user.id)", ".fetch_optional(&mut *tx)",
    `maintenance::phase(sqlx::query("${renewalSql}")`, ".bind(user.id).bind(&login).fetch_optional(&mut *tx)",
    "maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?",
    "let value = public_status(status_value(account.as_ref()), row.as_ref())", "maintenance::commit(tx).await?", "Ok(value)",
  ]);
  count(operation, /sqlx::query\(/g, 2);
  count(operation, /\.fetch_optional\(/g, 2);
  assert.doesNotMatch(operation, /lock_account|FOR UPDATE|INSERT|UPDATE|DELETE|credential_live|credential_expires_at|account_operations::status|fetch_one|expected_revision|body|state='scheduled'/);
}
function preferenceOrder(text) {
  const operation = fn(text, "set_preference");
  inOrder(operation, [
    "authenticate(context, &headers, true, false)", "login_hash(&headers)?", "expected_revision(&body.expected_revision)?",
    "if body.enabled {", "return Err(err(", "StatusCode::CONFLICT", '"platform_renewal_new_consented_qr_required"',
    "maintenance::begin_db(db).await?", "maintenance::phase(guard_login(&mut tx, user.id, &login)).await?",
    "let row = maintenance::phase(lock_account(&mut tx, user.id)).await?",
    'if expected != Some(row.get("revision"))', 'return Err(err(StatusCode::CONFLICT, "platform_account_changed"))',
    "maintenance::phase(", 'sqlx::query("DELETE FROM platform_account_renewals WHERE account_id=$1")',
    '.bind(row.get::<Uuid, _>("id"))', ".execute(&mut *tx)",
    "maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?",
    "let value = public_status(status_value(Some(&row)), None)", "maintenance::commit(tx).await?", "Ok(value)",
  ]);
  count(operation, /sqlx::query\(/g, 1);
  count(operation, /\.bind\(/g, 1);
  count(operation, /lock_account\(/g, 1);
  assert.doesNotMatch(operation, /UPDATE|INSERT|\.checked_add|revision\s*\+|revision_matches|is_none\(|is_some_and\(|rows_affected|credential_revision|consent_login_hash|ACCOUNT_SELECT|fetch_one|fetch_optional|fail_pending/);
}
function projection(text) {
  assert.equal(compact(fn(text, "public_status")), compact(`fn public_status(account: Value, row: Option<&PgRow>) -> Value {
    json!({"account":account,"method":"web_cookie_refresh","supported":true,"enabled":row.is_some_and(|r|matches!(r.get::<String,_>("state").as_str(),"scheduled"|"running")),
        "state":row.map(|r|r.get::<String,_>("state")).unwrap_or_else(||"disabled".to_owned()),
        "next_refresh_at":row.and_then(|r|r.get::<Option<i64>,_>("next_refresh_at_ms")),
        "enable_requires":"new_consented_qr_login"})
}`));
}
function httpContract(text) {
  for (const name of names) {
    const signature = name === "status" ? "State(app): State<App>, headers: HeaderMap" : "State(app): State<App>, headers: HeaderMap, Json(body): Json<Preference>,";
    const args = name === "status" ? "app.identity_context(), headers" : "app.identity_context(), headers, body";
    assert.equal(shape(fn(text, name)), shape(`pub async fn ${name}(${signature}) -> Result<Response> {
      let value = account_operations::${name}(${args}).await?;
      Ok(responses::private_json(StatusCode::OK, value))
    }`));
  }
  assert.match(text, /#\[derive\(Deserialize\)\]\n#\[serde\(deny_unknown_fields\)\]\npub struct Preference \{\n    expected_revision: Value,\n    enabled: bool,\n\}/);
}
function originalRenewal(text, adapter = parent) {
  assert.equal(hash(restoreBilibiliRenewalAccountParent(adapter, text)), "024b1189003887c466802cc08afc8245a11033952144b35729beb0535bda71c6", "finite inverse restores every renewal.rs byte at 22277c4");
}
function safeRustTests(source) {
  const tests = source.split("#[cfg(test)]")[1].replace(/^    /gm, "");
  inOrder(fn(tests, "closed_pool"), [".min_connections(0)", ".connect_lazy_with(", "db.close().await", "assert!(db.is_closed())"]);
  count(tests, /let db = closed_pool\(\)\.await;/g, 2);
  count(tests, /#\[(?:tokio::)?test\]/g, 5);
  for (const name of ["missing_login_precedes_revision_opt_in_and_transaction_work", "closed_authentication_storage_precedes_origin_revision_opt_in_and_transaction_work"]) {
    const operation = fn(tests, name);
    inOrder(operation, ["let db = closed_pool().await;", "status(context(&db)", "for enabled in [false, true]", 'for expected_revision in [json!(null), json!("invalid"), json!("3")]', "set_preference("]);
  }
  assert.doesNotMatch(tests, /std::env|TcpListener|TcpStream|\.connect\(|\.connect_with\(|reqwest|Command::|tokio::spawn/);
}

test("complete operations accept only request context, headers and the original preference body", () => capabilities(core));
test("status does not lock or expire credentials and reads only exact originating-login renewal", () => statusOrder(core));
test("opt-in fails before DB/CAS and opt-out retains helper expiry, mandatory revision, account-wide delete and final guard", () => preferenceOrder(core));
test("public renewal projection retains exactly seven fields and original row-state mapping", () => projection(core));
test("HTTP wrappers retain request extractors, unknown-field denial and private HTTP 200 mapping", () => httpContract(parent));
test("finite inverse reconstructs the complete 22277c4 renewal.rs byte for byte", () => originalRenewal(core));
test("renewal-operation inverse composes before store-grant inverse without changing historical QR hash", () => {
  assert.equal(hash(restoreBilibiliRenewal(restoreBilibiliRenewalAccountParent(parent, core))), "8d4a2d0c29096cd1e083c592c4493eeb03586fccd229c99422d74c26c6d92bed");
});
test("shared account helpers retain their original owner and nested four-field DTO", () => {
  assert.equal(compact(fn(accounts, "status_value")), compact(`fn status_value(row: Option<&PgRow>) -> Value {
    match row {
        Some(row) => json!({"id": row.get::<Uuid, _>("id"), "provider": PROVIDER,
            "revision": row.get::<i64, _>("revision").to_string(), "state": row.get::<String, _>("state")}),
        None => json!({"id": null, "provider": PROVIDER, "revision": null, "state": "revoked"}),
    }
}`));
  assert.match(fn(accounts, "lock_account"), /lock_provider_account\(tx, user, PROVIDER\)\.await\?\.0/);
  inOrder(fn(accounts, "lock_provider_account"), ["INSERT INTO platform_accounts", "'revoked'", "ON CONFLICT(user_id,provider) DO NOTHING", "FOR UPDATE", "sqlx::query(PROVIDER_ACCOUNT_SELECT)", 'row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")', "state='expired',credential_encrypted=NULL,revision=revision+1", "if provider == PROVIDER", "fail_pending(tx, user)", "Ok((row, inserted.is_some()))"]);
  inOrder(fn(accounts, "expected_revision"), ["value.is_null()", "return Ok(None)", ".as_str()", "raw.parse::<i64>().ok()", "*revision > 0", "value.as_str() == Some(revision.to_string().as_str())", '"invalid_request"', "Ok(Some(parsed))"]);
});
test("maintenance adapter retains existing pool begin, phase and commit budgets without a new owner", () => {
  assert.match(fn(maintenance, "begin"), /begin_db\(&app\.db\)\.await/);
  inOrder(fn(maintenance, "begin_db"), ["timeout(Duration::from_secs(5), db.begin())", '"platform_renewal_database_unavailable"', "SET LOCAL statement_timeout='5s'", "SET LOCAL lock_timeout='5s'", "Ok(tx)"]);
  const phase = maintenance.match(/^pub\(super\) async fn phase<T, E: Into<Error>>\([\s\S]*?\n}/m)?.[0];
  assert.ok(phase, "bounded generic phase function");
  assert.match(phase, /budget\(Duration::from_secs\(5\), future\)\.await/);
  assert.match(fn(maintenance, "commit"), /timeout\(Duration::from_secs\(5\), tx.commit\(\)\)/);
  assert.match(fn(maintenance, "commit"), /platform_renewal_commit_unknown/);
  assert.match(fn(read("main.rs"), "auth"), /identity::request::authenticate\(app.identity_context\(\), h, write, false\)\.await/);
});
test("original renewal route stays GET/PUT without an added body limit", () => {
  assert.match(routes, /"\/api\/v1\/platform-accounts\/bilibili\/renewal",\s*get\(platform_accounts::renewal::status\)\.put\(platform_accounts::renewal::set_preference\),/);
});
test("old refresh-envelope Rust test keeps its path and operation tests use closed lazy storage only", () => {
  assert.match(parent, /fn refresh_envelope_requires_owner_revision_login_and_purpose\(/);
  safeRustTests(all);
});

const negatives = [
  ["status gains whole App", "status", capabilities, "context: RequestContext<'_>", "context: App"],
  ["disable gains crypto", "set_preference", capabilities, "headers: HeaderMap,", "headers: HeaderMap, decrypt: &dyn Fn(&str),"],
  ["status permits guests", "status", capabilities, "authenticate(context, &headers, false, false)", "authenticate(context, &headers, false, true)"],
  ["disable loses write authentication", "set_preference", capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, false, false)"],
  ["status obtains unbounded begin", "status", capabilities, "maintenance::begin_db(db)", "db.begin()"],
  ["disable obtains unbounded commit", "set_preference", capabilities, "maintenance::commit(tx)", "tx.commit()"],
  ["status loses first login fence", "status", statusOrder, "    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;", ""],
  ["status changes account owner bind", "status", statusOrder, ".bind(user.id)\n            .fetch_optional", ".bind(Uuid::nil())\n            .fetch_optional"],
  ["status locks account", "status", statusOrder, "    let account = maintenance::phase(", "    let _ = lock_account(&mut tx, user.id).await?;\n    let account = maintenance::phase("],
  ["status delegates to credential-expiring account status", "status", statusOrder, "    let account = maintenance::phase(", "    account_operations::status(context, headers).await?;\n    let account = maintenance::phase("],
  ["status adds credential expiry check", "status", statusOrder, " AND a.state='connected'", " AND a.state='connected' AND a.credential_expires_at>clock_timestamp()"],
  ["renewal drops account join", "status", statusOrder, "a.id=r.account_id AND ", ""],
  ["renewal drops exact revision", "status", statusOrder, " AND a.revision=r.credential_revision", ""],
  ["renewal drops owner", "status", statusOrder, "a.user_id=$1 AND ", ""],
  ["renewal drops provider", "status", statusOrder, "a.provider='bilibili' AND ", ""],
  ["renewal drops connected state", "status", statusOrder, " AND a.state='connected'", ""],
  ["renewal drops originating login", "status", statusOrder, " AND r.consent_login_hash=$2", ""],
  ["renewal drops live-login predicate", "status", statusOrder, " AND playback_login_allowed($1,$2)", ""],
  ["renewal only shows scheduled state", "status", statusOrder, " AND r.consent_login_hash=$2", " AND r.state='scheduled' AND r.consent_login_hash=$2"],
  ["renewal timestamp changes unit", "status", statusOrder, "r.next_refresh_at)*1000", "r.next_refresh_at)"],
  ["renewal changes login bind", "status", statusOrder, ".bind(user.id).bind(&login)", ".bind(user.id).bind(\"other\")"],
  ["status loses final live fence", "status", statusOrder, "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;", ""],
  ["status discards renewal row", "status", statusOrder, "public_status(status_value(account.as_ref()), row.as_ref())", "public_status(status_value(account.as_ref()), None)"],
  ["status skips commit", "status", statusOrder, "    maintenance::commit(tx).await?;", ""],
  ["disable ignores expected revision parsing", "set_preference", preferenceOrder, "expected_revision(&body.expected_revision)?", "None"],
  ["opt-in acquires DB before rejection", "set_preference", preferenceOrder, "    if body.enabled {", "    let mut tx = maintenance::begin_db(db).await?;\n    if body.enabled {"],
  ["opt-in bypasses new consent requirement", "set_preference", preferenceOrder, "if body.enabled", "if false"],
  ["opt-in changes error code", "set_preference", preferenceOrder, '"platform_renewal_new_consented_qr_required"', '"platform_account_changed"'],
  ["opt-in changes HTTP status", "set_preference", preferenceOrder, "StatusCode::CONFLICT,\n", "StatusCode::BAD_REQUEST,\n"],
  ["disable omits admission guard", "set_preference", preferenceOrder, "    maintenance::phase(guard_login(&mut tx, user.id, &login)).await?;", ""],
  ["disable bypasses account lock and expiry", "set_preference", preferenceOrder, "lock_account(&mut tx, user.id)", "read_account(&mut tx, user.id)"],
  ["disable treats null as wildcard", "set_preference", preferenceOrder, 'if expected != Some(row.get("revision"))', 'if expected.is_some() && expected != Some(row.get("revision"))'],
  ["disable accepts stale revision", "set_preference", preferenceOrder, 'if expected != Some(row.get("revision"))', "if false"],
  ["disable scopes deletion to login", "set_preference", preferenceOrder, 'WHERE account_id=$1")', 'WHERE account_id=$1 AND consent_login_hash=$2")'],
  ["disable scopes deletion to revision", "set_preference", preferenceOrder, 'WHERE account_id=$1")', 'WHERE account_id=$1 AND credential_revision=$2")'],
  ["disable deletes another account", "set_preference", preferenceOrder, '.bind(row.get::<Uuid, _>("id"))', ".bind(user.id)"],
  ["disable increments account revision", "set_preference", preferenceOrder, "    maintenance::phase(\n        sqlx::query", "    sqlx::query(\"UPDATE platform_accounts SET revision=revision+1\").execute(&mut *tx).await?;\n    maintenance::phase(\n        sqlx::query"],
  ["disable loses final live fence", "set_preference", preferenceOrder, "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;", ""],
  ["disable projects absent account", "set_preference", preferenceOrder, "status_value(Some(&row))", "status_value(None)"],
  ["disable skips commit", "set_preference", preferenceOrder, "    maintenance::commit(tx).await?;", ""],
  ["projection enables uncertain rows", "public_status", projection, '"scheduled"|"running"', '"scheduled"|"running"|"uncertain"'],
  ["projection loses running enabled state", "public_status", projection, '"scheduled"|"running"', '"scheduled"'],
  ["projection changes absent state", "public_status", projection, '"disabled".to_owned()', '"uncertain".to_owned()'],
  ["projection adds secret", "public_status", projection, '"supported":true', '"supported":true,"refresh_token":"secret"'],
  ["projection drops nested account", "public_status", projection, '"account":account,', ""],
  ["projection drops nullable timestamp", "public_status", projection, '"next_refresh_at":row.and_then(|r|r.get::<Option<i64>,_>("next_refresh_at_ms")),', ""],
];
for (const [label, name, contract, from, to] of negatives) {
  test(`in-memory mutation rejected: ${label}`, () => {
    const operation = fn(core, name);
    const mutated = replaceOnce(core, operation, replaceOnce(operation, from, to));
    assert.throws(() => { contract(mutated); capabilities(mutated); });
    assert.throws(() => { capabilities(mutated); originalRenewal(mutated); });
  });
}
for (const name of names) {
  test(`HTTP mutation rejected: ${name} changes private 200 mapping`, () => {
    const wrapper = fn(parent, name);
    const changed = replaceOnce(parent, wrapper, replaceOnce(wrapper, "StatusCode::OK", "StatusCode::CREATED"));
    assert.throws(() => httpContract(changed));
  });
}
test("preference mutation rejected: unknown fields become accepted", () => {
  assert.throws(() => httpContract(replaceOnce(parent, "#[serde(deny_unknown_fields)]\n", "")));
});
test("fixture text cannot satisfy missing production final guard", () => {
  const text = replaceOnce(core, fn(core, "status"), replaceOnce(fn(core, "status"), "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;", ""));
  assert.throws(() => statusOrder(text + '\n#[cfg(test)]\nmod tests { const GUARD: &str = "maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?"; }'));
});
test("closed-storage mutation rejected: lazy pool is not closed before operation entry", () => {
  assert.throws(() => safeRustTests(replaceOnce(all, "        db.close().await;\n", "")));
});
for (const name of ["store_grant", "refresh_due_inner", "refresh_one", "retire_bili", "publish_bili", "complete_bili"]) {
  test(`finite inverse also rejects drift in unmoved renewal owner ${name}`, () => {
    const operation = fn(parent, name);
    const signature = operation.slice(0, operation.indexOf("{\n") + 2);
    const changed = replaceOnce(parent, operation, replaceOnce(operation, signature, signature + "    /* unexpected owner edit */\n"));
    assert.throws(() => originalRenewal(core, changed));
  });
}
