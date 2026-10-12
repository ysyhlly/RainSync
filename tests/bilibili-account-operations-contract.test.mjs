// Pure source, finite inverse, and in-memory negative controls only.
// No Cargo, subprocess, DB, socket, native runner, provider call or user computer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rustFunction as fn, replaceOnce, restoreBilibiliAccountParent } from "./fixtures/bilibili-account-source-inverse.mjs";
import { restoreBilibiliLoginParent } from "./fixtures/bilibili-login-source-inverse.mjs";

const read = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const parent = read("platform_accounts.rs");
const all = read("platform_accounts/account_operations.rs");
const core = all.split("#[cfg(test)]")[0];
const qr = read("platform_accounts/qr_login.rs").split("#[cfg(test)]")[0];
const security = read("account_security.rs");
const routes = read("bootstrap/routes.rs");
const compact = (text) => text.replace(/\s+/g, " ").trim();
const shape = (text) => compact(text).replace(/,\s*\)/g, ")").replace(/\s*([(),])\s*/g, "$1");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
const names = ["status", "check_login", "unlink"];
const helpers = ["check_value", "check_revision_matches", "check_snapshot_matches"];
function inOrder(text, parts) {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered: ${part}`);
    previous = found;
  }
}
const header = `//! Viewer-owned Bilibili account operations retain their complete transactions.
use super::{
    ACCOUNT_SELECT, AccountScope, CheckLogin, HTTP_SECONDS, account_scope, cookie_from_value,
    credential_error, expected_revision, fail_pending, guard_login, guard_login_live, lock_account,
    login_hash, scope, status_value,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::bilibili::Client;
use providers::platform::bilibili::auth::LoginValidity;
use providers::platform::http::PlatformHttp;
use serde_json::{Value, json};
use sqlx::Row;
use tokio::time::{Duration, Instant as Deadline};
use uuid::Uuid;

`;
function capabilities(text) {
  assert.equal(text, header + [...helpers, ...names].map((name) => fn(text, name)).join("\n\n") + "\n\n");
  assert.doesNotMatch(text, /\b(?:App|Aes256Gcm|State|Response|Transport|SourceWriteContext|SourceReadContext)\b|responses::|super::\*|reqwest|std::env|tokio::spawn|\.clone\(\)/);
  assert.doesNotMatch(text, /playback::|preparations|native_delivery|upstream::|oauth::|renewal::|maintenance::|timeout\(|source_(?:read|write)/);
  assert.deepEqual([...text.matchAll(/^pub\(super\) async fn (\w+)\(/gm)].map((m) => m[1]), names);
  for (const name of names) {
    const operation = fn(text, name);
    const signature = name === "check_login"
      ? "context: RequestContext<'_>, http: PlatformHttp, decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync), headers: HeaderMap, body: CheckLogin,"
      : "context: RequestContext<'_>, headers: HeaderMap";
    assert.equal(shape(operation.slice(0, operation.indexOf("{\n"))), shape(`pub(super) async fn ${name}(${signature}) -> Result<Value>`));
    inOrder(operation, ["let db = context.db;", `request::authenticate(context, &headers, ${name === "status" ? "false" : "true"}, false).await?`, "login_hash(&headers)?"]);
    assert.doesNotMatch(operation, /\.unwrap\(|\.expect\(|loop \{|while |retry|encrypt\(|generate_qr|poll_qr/);
    if (name !== "check_login") assert.doesNotMatch(operation, /\bhttp\b|\bdecrypt\b|Client::|expected_revision|rate_limit|\bbody\b/);
  }
}
function statusOrder(text) {
  const operation = fn(text, "status");
  inOrder(operation, [
    "authenticate(context, &headers, false, false)", "login_hash(&headers)?", "db.begin().await?",
    "guard_login(&mut tx, user.id, &login).await?", "provider='bilibili' FOR UPDATE", ".bind(user.id)", ".fetch_optional(&mut *tx)",
    "let mut row = sqlx::query(ACCOUNT_SELECT)", ".bind(user.id)", ".fetch_optional(&mut *tx)",
    "if row.as_ref().is_some_and(|row|", 'row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")',
    "row = Some(lock_account(&mut tx, user.id).await?)", "guard_login_live(&mut tx, user.id, &login)",
    "let value = status_value(row.as_ref())", "tx.commit().await?", "Ok(value)",
  ]);
  count(operation, /db\.begin\(/g, 1);
  count(operation, /tx\.commit\(/g, 1);
  count(operation, /lock_account\(/g, 1);
  count(operation, /\.fetch_optional\(/g, 2);
  assert.doesNotMatch(operation, /INSERT|UPDATE platform|fetch_one|fail_pending/);
}
function checkAdmission(text) {
  const operation = fn(text, "check_login");
  inOrder(operation, [
    "authenticate(context, &headers, true, false)", "login_hash(&headers)?", "expected_revision(&body.expected_revision)?",
    'account_security::rate_limit(db, "platform-login-check", &user.id.to_string(), 20, 600).await?',
    "db.begin().await?", "guard_login(&mut tx, user.id, &login)", "provider='bilibili' FOR UPDATE",
    ".bind(user.id)", ".fetch_optional(&mut *tx)", "let mut row = sqlx::query(ACCOUNT_SELECT)",
    ".bind(user.id)", ".fetch_optional(&mut *tx)", "let observed = row.as_ref().map(account_scope)",
    "if !check_revision_matches(expected, observed)", '"platform_account_changed"',
    'row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")',
    "row = Some(lock_account(&mut tx, user.id).await?)", "guard_login_live(&mut tx, user.id, &login)",
    'filter(|row| row.get::<bool, _>("credential_live"))', "else {",
    'check_value(status_value(row.as_ref()), "none", None)', "tx.commit().await?", "return Ok(value)",
    "let scope = account_scope(account)", 'let expires_at: Option<i64> = account.get("credential_expires_at_ms")',
    'let ciphertext: Option<String> = account.get("credential_encrypted")',
    "let plaintext = decrypt(ciphertext.as_deref().ok_or_else(credential_error)?)", ".map_err(|_| credential_error())?",
    "let cookie = cookie_from_value(", "scope::credential_cookies(scope, plaintext).ok_or_else(credential_error)?",
    "tx.commit().await?", "Client::new(http, Some(cookie))",
    ".check_login(Deadline::now() + Duration::from_secs(HTTP_SECONDS))", ".await;",
  ]);
  count(operation, /account_security::rate_limit\(/g, 1);
  count(operation, /db\.begin\(/g, 2);
  count(operation, /tx\.commit\(/g, 3);
  count(operation, /guard_login\(/g, 2);
  count(operation, /guard_login_live\(/g, 2);
  count(operation, /decrypt\(/g, 1);
  count(operation, /Client::new\(/g, 1);
  count(operation, /\.check_login\(/g, 1);
  assert.doesNotMatch(operation, /claim_rate_limit|INSERT INTO platform_accounts/);
}
function checkCompletion(text) {
  const operation = fn(text, "check_login");
  inOrder(operation, [
    ".check_login(Deadline::now() + Duration::from_secs(HTTP_SECONDS))", "db.begin().await?",
    "guard_login(&mut tx, user.id, &login)", "provider='bilibili' FOR UPDATE", ".bind(user.id)", ".fetch_optional(&mut *tx)",
    "let mut current = sqlx::query(ACCOUNT_SELECT)", ".bind(user.id)", ".fetch_optional(&mut *tx)",
    "if !current.as_ref().is_some_and(|row|", "check_snapshot_matches(", "scope,", "expires_at,", "Some(account_scope(row)),",
    'row.get::<bool, _>("credential_live")', 'row.get::<Option<i64>, _>("credential_expires_at_ms")',
    'return Err(err(StatusCode::CONFLICT, "platform_account_changed"))', "let verification = match upstream",
    'Ok(LoginValidity::Verified) => "verified"', "Ok(LoginValidity::Invalid)", "scope.revision.checked_add(1).ok_or_else(credential_error)?",
    "UPDATE platform_accounts SET state='expired',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider='bilibili' AND playback_login_allowed($4,$5)",
    ".bind(scope.account_id).bind(revision).bind(scope.revision).bind(user.id).bind(&login).execute(&mut *tx)",
    "if updated.rows_affected() != 1", '"platform_account_changed"', "fail_pending(&mut tx, user.id)",
    "current = sqlx::query(ACCOUNT_SELECT)", ".bind(user.id)", ".fetch_optional(&mut *tx)", '"invalid"',
    'Err(_) => "unknown"', "guard_login_live(&mut tx, user.id, &login)",
    'sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint")', ".fetch_one(&mut *tx)",
    "let value = check_value(", "status_value(current.as_ref())", "verification,", "Some(checked_at)", "tx.commit().await?", "Ok(value)",
  ]);
  count(operation, /UPDATE platform_accounts/g, 1);
  count(operation, /fail_pending\(/g, 1);
  assert.doesNotMatch(operation, /upstream_error|log::|tracing::|format!|credential_expires_at>\$/);
}
function unlinkOrder(text) {
  const operation = fn(text, "unlink");
  inOrder(operation, [
    "authenticate(context, &headers, true, false)", "login_hash(&headers)?", "db.begin().await?",
    "guard_login(&mut tx, user.id, &login)", "let account = lock_account(&mut tx, user.id).await?",
    '.get::<i64, _>("revision")', ".checked_add(1)", ".ok_or_else(credential_error)?",
    "UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1",
    '.bind(account.get::<Uuid, _>("id")).bind(revision).execute(&mut *tx)', "fail_pending(&mut tx, user.id)",
    "guard_login_live(&mut tx, user.id, &login)", "sqlx::query(ACCOUNT_SELECT)", ".bind(user.id)", ".fetch_one(&mut *tx)",
    "status_value(Some(&row))", "tx.commit().await?", "immutable provenance", "Ok(value)",
  ]);
  count(operation, /db\.begin\(/g, 1);
  count(operation, /tx\.commit\(/g, 1);
  count(operation, /lock_account\(/g, 1);
  assert.doesNotMatch(operation, /expected_revision|revision_matches|rows_affected|rate_limit|WHERE id=\$1 AND|DELETE FROM/);
}
function helpersContract(text) {
  assert.equal(compact(fn(text, "check_revision_matches")), "pub(super) fn check_revision_matches(expected: Option<i64>, scope: Option<AccountScope>) -> bool { expected == scope.map(|scope| scope.revision) }");
  assert.equal(compact(fn(text, "check_snapshot_matches")), "pub(super) fn check_snapshot_matches( observed: AccountScope, expiry: Option<i64>, current: Option<AccountScope>, live: bool, current_expiry: Option<i64>, ) -> bool { current == Some(observed) && live && current_expiry == expiry }");
  assert.equal(compact(fn(text, "check_value")), 'pub(super) fn check_value(account: Value, verification: &str, checked_at: Option<i64>) -> Value { json!({"account": account, "verification": verification, "checked_at": checked_at, "renew_method": "qr_login"}) }');
}
function httpContract(text) {
  for (const name of names) {
    const signature = name === "check_login" ? "State(app): State<App>, headers: HeaderMap, Json(body): Json<CheckLogin>," : "State(app): State<App>, headers: HeaderMap";
    const composition = name === "check_login" ? `
      let key = app.key.as_ref();
      let decrypt = |value: &str| crate::decrypt_value(key, value);
      let value = account_operations::check_login(app.identity_context(), app.platform_http, &decrypt, headers, body,).await?;
    ` : `let value = account_operations::${name}(app.identity_context(), headers).await?;`;
    assert.equal(shape(fn(text, name)), shape(`pub async fn ${name}(${signature}) -> Result<Response> { ${composition} Ok(responses::private_json(StatusCode::OK, value)) }`));
  }
}
function originalParent(text, adapter = parent) {
  assert.equal(hash(restoreBilibiliAccountParent(adapter, text)), "cb5353b5fd892f880f63a484d041229291d3e57a1d70c88fe07309c6ca8fb350",
    "finite inverse restores every parent byte at 719a387");
}

test("three complete operations accept only bounded request and check-only transport/decryption", () => capabilities(core));
test("status never inserts an absent account and expires only an existing connected stale row", () => statusOrder(core));
test("check authenticates before validation, claims its independent rate and commits before one provider call", () => checkAdmission(core));
test("check reacquires exact scope, liveness and expiry before interpreting any provider result", () => checkCompletion(core));
test("unlink retains tombstone/expiry helper, revision increment, unrestricted update and original commit order", () => unlinkOrder(core));
test("pure check predicates and four-field projection remain exact", () => helpersContract(core));
test("HTTP adapters pass narrow capabilities once and retain private 200 responses", () => httpContract(parent));
test("finite inverse reconstructs the complete 719a387 parent byte for byte", () => originalParent(core));
test("account inverse composes before QR inverse without changing its historical parent hash", () => {
  assert.equal(hash(restoreBilibiliLoginParent(restoreBilibiliAccountParent(parent, core), qr)), "209a350414d22549f5272c704fa05b18439593e619c184d49d3fd8f8a7071e4a");
});
test("authentication adapter, independent rate transaction and shared helper semantics are unchanged", () => {
  inOrder(fn(read("main.rs"), "auth"), ["identity::request::authenticate(app.identity_context(), h, write, false).await"]);
  inOrder(fn(security, "rate_limit"), ["hash(&format!", "rate_limit_key(db, scope, &key, limit, seconds).await"]);
  inOrder(fn(security, "rate_limit_key"), ["db.begin().await?", "claim_rate_limit_key(&mut tx, scope, key, limit, seconds).await?", "tx.commit().await?", "match retry_after", "Err(limited(seconds))", "None => Ok(())"]);
  inOrder(fn(parent, "lock_provider_account"), ["INSERT INTO platform_accounts", "'revoked'", "ON CONFLICT(user_id,provider) DO NOTHING", "FOR UPDATE", "sqlx::query(PROVIDER_ACCOUNT_SELECT)", 'row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")', "state='expired',credential_encrypted=NULL,revision=revision+1", "if provider == PROVIDER", "fail_pending(tx, user)", "Ok((row, inserted.is_some()))"]);
  assert.match(parent, /const HTTP_SECONDS: u64 = 20;/);
  assert.match(parent, /pub struct CheckLogin \{\s*\/\/ A required null means no account was observed, not an unconditional check\.\s*expected_revision: Value,/);
});
test("GET/check/DELETE routes and check-only body limit retain their current public paths", () => {
  assert.match(routes, /"\/api\/v1\/platform-accounts\/bilibili",\s*get\(platform_accounts::status\)\.delete\(platform_accounts::unlink\)/);
  assert.match(routes, /"\/api\/v1\/platform-accounts\/bilibili\/check",\s*post\(platform_accounts::check_login\)\.layer\(axum::extract::DefaultBodyLimit::max\(1024\)\)/);
});
test("old Rust tests keep their paths while new operation probes use closed lazy pools", () => {
  for (const name of ["validity_checks_require_observed_revision_and_reacquire_live_exact_scope", "check_ingress_and_response_never_accept_or_expose_secrets"]) assert.match(parent, new RegExp(`fn ${name}\\(`));
  assert.match(parent, /use super::account_operations::\{check_revision_matches, check_snapshot_matches, check_value\};/);
  const tests = all.split("#[cfg(test)]")[1].replace(/^    /gm, "");
  inOrder(fn(tests, "closed_pool"), [".min_connections(0)", ".connect_lazy_with(", "db.close().await", "assert!(db.is_closed())"]);
  count(tests, /let db = closed_pool\(\)\.await;/g, 2);
  count(tests, /#\[(?:tokio::)?test\]/g, 5);
  assert.doesNotMatch(tests, /std::env|TcpListener|TcpStream|\.connect\(|\.connect_with\(|reqwest|Command::/);
});

const negatives = [
  ["whole App request capability", "status", capabilities, "context: RequestContext<'_>", "context: App"],
  ["borrowed transport instead of bounded value", "check_login", capabilities, "http: PlatformHttp", "http: &PlatformHttp"],
  ["callback loses Sync", "check_login", capabilities, "-> anyhow::Result<Value> + Sync", "-> anyhow::Result<Value>"],
  ["status gains decryption", "status", capabilities, "headers: HeaderMap", "headers: HeaderMap, decrypt: &dyn Fn(&str)"],
  ["unlink gains transport", "unlink", capabilities, "headers: HeaderMap", "headers: HeaderMap, http: PlatformHttp"],
  ["status permits guests", "status", capabilities, "authenticate(context, &headers, false, false)", "authenticate(context, &headers, false, true)"],
  ["check skips write authentication", "check_login", capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, false, false)"],
  ["unlink skips write authentication", "unlink", capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, false, false)"],
  ["status gains maintenance timeout", "status", capabilities, "db.begin().await?", "maintenance::begin_db(db).await?"],
  ["status loses exact login lock", "status", statusOrder, "    guard_login(&mut tx, user.id, &login).await?;", ""],
  ["status expires disconnected rows", "status", statusOrder, 'row.get::<String, _>("state") == "connected" && ', ""],
  ["status expires live rows", "status", statusOrder, '!row.get::<bool, _>("credential_live")', 'row.get::<bool, _>("credential_live")'],
  ["status creates absent tombstone", "status", statusOrder, "    let mut row = sqlx::query(ACCOUNT_SELECT)", "    lock_account(&mut tx, user.id).await?;\n    let mut row = sqlx::query(ACCOUNT_SELECT)"],
  ["status loses final live check", "status", statusOrder, "    guard_login_live(&mut tx, user.id, &login).await?;", ""],
  ["status omits commit", "status", statusOrder, "    tx.commit().await?;", ""],
  ["check changes rate bucket", "check_login", checkAdmission, '"platform-login-check"', '"platform-login-start"'],
  ["check changes rate budget", "check_login", checkAdmission, "20, 600", "10, 600"],
  ["check loses expected revision", "check_login", checkAdmission, "expected_revision(&body.expected_revision)?", "None"],
  ["check ignores stale revision", "check_login", checkAdmission, "if !check_revision_matches(expected, observed)", "if false"],
  ["check clears without connected state", "check_login", checkAdmission, 'row.get::<String, _>("state") == "connected" && ', ""],
  ["check no-credential path attempts provider", "check_login", checkAdmission, "        return Ok(value);", "        let _ = value;"],
  ["check none branch skips commit", "check_login", checkAdmission, '        tx.commit().await?;\n        return Ok(value);', '        return Ok(value);'],
  ["check changes none receipt", "check_login", checkAdmission, '"none", None', '"unknown", None'],
  ["check leaks decryption error", "check_login", checkAdmission, ".map_err(|_| credential_error())?", ".map_err(|error| error)?"],
  ["check skips credential scope validation", "check_login", checkAdmission, "scope::credential_cookies(scope, plaintext).ok_or_else(credential_error)?", "plaintext"],
  ["check skips cookie validation", "check_login", checkAdmission, "let cookie = cookie_from_value(", "let cookie = Ok::<_, crate::Error>("],
  ["check provider lacks selected cookie", "check_login", checkAdmission, "Client::new(http, Some(cookie))", "Client::new(http, None)"],
  ["check call keeps first transaction", "check_login", checkAdmission, "    tx.commit().await?;\n\n    let upstream", "    let upstream"],
  ["check changes provider deadline", "check_login", checkAdmission, "Duration::from_secs(HTTP_SECONDS)", "Duration::from_secs(40)"],
  ["check second authority lock omitted", "check_login", checkCompletion, "    let mut current = sqlx::query(ACCOUNT_SELECT)", "    let mut current = sqlx::query(PROVIDER_ACCOUNT_SELECT)"],
  ["check exact observed scope bypassed", "check_login", checkCompletion, "Some(account_scope(row)),", "Some(scope),"],
  ["check liveness bypassed", "check_login", checkCompletion, 'row.get::<bool, _>("credential_live"),', "true,"],
  ["check expiry bypassed", "check_login", checkCompletion, 'row.get::<Option<i64>, _>("credential_expires_at_ms"),', "expires_at,"],
  ["check verified reported invalid", "check_login", checkCompletion, 'Ok(LoginValidity::Verified) => "verified"', 'Ok(LoginValidity::Verified) => "invalid"'],
  ["check unchecked revision increment", "check_login", checkCompletion, "scope.revision.checked_add(1).ok_or_else(credential_error)?", "scope.revision + 1"],
  ["check omits expiry clearing", "check_login", checkCompletion, "credential_encrypted=NULL,credential_expires_at=NULL,revision=$2", "credential_encrypted=NULL,revision=$2"],
  ["check invalid update loses revision CAS", "check_login", checkCompletion, " AND revision=$3", ""],
  ["check invalid update loses owner", "check_login", checkCompletion, " AND user_id=$4", ""],
  ["check invalid update loses provider", "check_login", checkCompletion, " AND provider='bilibili' AND playback_login_allowed", " AND playback_login_allowed"],
  ["check invalid update loses live login", "check_login", checkCompletion, "playback_login_allowed($4,$5)", "true"],
  ["check CAS accepts zero updates", "check_login", checkCompletion, "updated.rows_affected() != 1", "updated.rows_affected() > 1"],
  ["check omits pending QR retirement", "check_login", checkCompletion, "            fail_pending(&mut tx, user.id).await?;", ""],
  ["check provider error becomes invalid", "check_login", checkCompletion, 'Err(_) => "unknown"', 'Err(_) => "invalid"'],
  ["check reports application clock", "check_login", checkCompletion, "floor(extract(epoch FROM clock_timestamp())*1000)::bigint", "0::bigint"],
  ["unlink adds stale revision CAS", "unlink", unlinkOrder, ' WHERE id=$1")', ' WHERE id=$1 AND revision=$3")'],
  ["unlink skips original account/expiry lock", "unlink", unlinkOrder, "lock_account(&mut tx, user.id).await?", "lock_account(&mut tx, Uuid::nil()).await?"],
  ["unlink changes increment", "unlink", unlinkOrder, ".checked_add(1)", ".checked_add(2)"],
  ["unlink leaves encrypted credential", "unlink", unlinkOrder, "credential_encrypted=NULL,", ""],
  ["unlink skips pending QR retirement", "unlink", unlinkOrder, "    fail_pending(&mut tx, user.id).await?;", ""],
  ["unlink skips final login live check", "unlink", unlinkOrder, "    guard_login_live(&mut tx, user.id, &login).await?;", ""],
  ["unlink skips commit", "unlink", unlinkOrder, "    tx.commit().await?;", ""],
  ["null expected revision becomes wildcard", "check_revision_matches", helpersContract, "expected == scope.map(|scope| scope.revision)", "expected.is_none() || expected == scope.map(|scope| scope.revision)"],
  ["snapshot stops matching scope", "check_snapshot_matches", helpersContract, "current == Some(observed) && ", ""],
  ["snapshot stops checking liveness", "check_snapshot_matches", helpersContract, " && live", ""],
  ["snapshot stops checking expiry", "check_snapshot_matches", helpersContract, " && current_expiry == expiry", ""],
  ["receipt adds secret field", "check_value", helpersContract, '"renew_method": "qr_login"', '"renew_method": "qr_login", "cookie": "secret"'],
];
for (const [label, name, contract, from, to] of negatives) {
  test(`in-memory mutation rejected: ${label}`, () => {
    const operation = fn(core, name);
    const mutated = replaceOnce(core, operation, replaceOnce(operation, from, to));
    assert.throws(() => contract(mutated));
    assert.throws(() => { capabilities(mutated); originalParent(mutated); });
  });
}
for (const name of names) {
  test(`HTTP mutation rejected: ${name} loses private 200 composition`, () => {
    const wrapper = fn(parent, name);
    const mutated = replaceOnce(parent, wrapper, replaceOnce(wrapper, "StatusCode::OK", "StatusCode::CREATED"));
    assert.throws(() => httpContract(mutated));
  });
}
test("HTTP mutation rejected: check decrypt closure captures whole App", () => {
  const mutated = replaceOnce(parent, "    let decrypt = |value: &str| crate::decrypt_value(key, value);\n    let value = account_operations::check_login(", "    let decrypt = |value: &str| app.decrypt(value);\n    let value = account_operations::check_login(");
  assert.throws(() => httpContract(mutated));
});
