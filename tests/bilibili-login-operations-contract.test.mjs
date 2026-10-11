// Pure source contracts, exact inverse edits, and in-memory negative controls.
// No Cargo, subprocess, DB, socket, native owner, provider traffic, or user computer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { restoreBilibiliRenewalAccountParent } from "./fixtures/bilibili-renewal-account-source-inverse.mjs";
import { restoreBilibiliAccountParent } from "./fixtures/bilibili-account-source-inverse.mjs";
import {
  rustFunction as fn, replaceOnce, restoreBilibiliLoginParent, restoreBilibiliRenewal,
} from "./fixtures/bilibili-login-source-inverse.mjs";

const read = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const parent = read("platform_accounts.rs");
const all = read("platform_accounts/qr_login.rs");
const core = all.split("#[cfg(test)]")[0];
const renewal = read("platform_accounts/renewal.rs");
const security = read("account_security.rs");
const names = ["start_login", "poll_login", "cancel_login"];
const compact = (text) => text.replace(/\s+/g, " ").trim();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
function inOrder(text, parts) {
  let previous = -1;
  for (const part of parts) {
    const found = text.indexOf(part, previous + 1);
    assert.ok(found > previous, `missing or reordered: ${part}`);
    previous = found;
  }
}
const signatures = {
  start_login: "context: RequestContext<'_>, http: &PlatformHttp, decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync), encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync), headers: HeaderMap, body: StartLogin,",
  poll_login: "context: RequestContext<'_>, http: &PlatformHttp, decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync), encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync), id: Uuid, headers: HeaderMap,",
  cancel_login: "context: RequestContext<'_>, id: Uuid, headers: HeaderMap,",
};
const header = `//! Exact-login Bilibili QR operations with request-scoped capabilities.
use super::{
    AccountScope, LoginRequest, OPERATION_LEASE_SECONDS, POLL_INTERVAL_SECONDS, PROVIDER,
    QR_KEY_PURPOSE, QR_LIFETIME_SECONDS, QR_PAYLOAD_PURPOSE, StartLogin, account_scope,
    can_complete, cookie_value, credential_error, deadline, fail_pending, guard_login,
    lock_account, lock_request, login_hash, renewal, scope, terminalize, upstream_error,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::bilibili::{Client, QrKey, QrState};
use providers::platform::http::PlatformHttp;
use serde_json::{Value, json};
use uuid::Uuid;

/// The HTTP adapter owns the existing 200 replay / 201 admission distinction.
#[derive(Debug)]
pub(super) enum StartLoginOutcome {
    Replay(Value),
    Created(Value),
}

`;
function capabilities(text) {
  assert.equal(text, header + ["qr_payload", "qr_response", ...names].map((name) => fn(text, name)).join("\n\n") + "\n\n");
  assert.doesNotMatch(text, /\b(?:App|Aes256Gcm|State|Response|Transport|SourceWriteContext|SourceReadContext)\b|responses::|super::\*|reqwest|std::env|tokio::spawn|\.clone\(\)|&mut PlatformHttp/);
  assert.doesNotMatch(text, /playback::|preparations|native_delivery|upstream::|oauth::|maintenance::|source_(?:read|write)/);
  assert.deepEqual([...text.matchAll(/^pub\(super\) async fn (\w+)\(/gm)].map((m) => m[1]), names);
  for (const name of names) {
    const operation = fn(text, name);
    assert.equal(compact(operation.slice(0, operation.indexOf("{\n"))),
      `pub(super) async fn ${name}( ${signatures[name]} ) -> Result<${name === "start_login" ? "StartLoginOutcome" : "Value"}>`);
    inOrder(operation, ["let db = context.db;", "request::authenticate(context, &headers, true, false).await?", "login_hash(&headers)?"]);
    assert.doesNotMatch(operation, /\.unwrap\(|\.expect\(|guard_login_live\(|generate_qr\([^)]*,|poll_qr\([^)]*,[^)]*,/);
  }
  assert.doesNotMatch(fn(text, "cancel_login"), /\bhttp\b|\bdecrypt\b|\bencrypt\b|Client::|nonce|consent_to_renew/);
}
function admission(text) {
  const start = fn(text, "start_login");
  inOrder(start, [
    "authenticate(context, &headers, true, false)", "login_hash(&headers)?",
    "if body.idempotency_key.is_nil() || !body.consent_to_store", '"platform_storage_consent_required"',
    "db.begin().await?", "guard_login(&mut tx, user.id, &login).await?",
    "lock_account(&mut tx, user.id).await?", "account_scope(&account)",
    'sqlx::query("SELECT id FROM platform_login_requests WHERE id=$1 FOR UPDATE")',
    ".bind(body.idempotency_key)", "if previous.is_some()",
    "lock_request(&mut tx, body.idempotency_key, user.id, &login)",
    "if request.consent_to_renew != body.consent_to_renew", '"platform_login_request_conflict"',
    'if request.status == "pending"', "if !request.live", '"expired").await?',
    "else if request.scope.account != account", '"failed").await?',
    "else if request.qr_key_encrypted.is_none() && !request.operation_live", '"failed").await?',
    "qr_response(&request, qr_payload(decrypt, &request)?, None)", "tx.commit().await?",
    "return Ok(StartLoginOutcome::Replay(value))",
    "OR NOT playback_login_allowed(user_id,auth_login_hash)",
    "SELECT EXISTS(SELECT 1 FROM platform_login_requests", "if active", '"platform_login_in_progress"',
    "account_security::claim_rate_limit(", '"platform-login-start"', "10,\n        600,",
    "tx.commit().await?", "return Err(account_security::limited(seconds))",
    "let nonce = Uuid::new_v4()", "INSERT INTO platform_login_requests",
    ".bind(body.idempotency_key).bind(user.id).bind(&login).bind(QR_LIFETIME_SECONDS).bind(POLL_INTERVAL_SECONDS)",
    ".bind(nonce).bind(OPERATION_LEASE_SECONDS).bind(account.account_id).bind(account.revision).bind(body.consent_to_renew)",
    "lock_request(&mut tx, body.idempotency_key, user.id, &login)", "deadline(&request)?", "tx.commit().await?",
    "Client::new(*http, None)", ".generate_qr(upstream_deadline)",
  ]);
  count(start, /db\.begin\(/g, 2);
  count(start, /tx\.commit\(\)/g, 5);
  count(start, /guard_login\(/g, 2);
  count(start, /generate_qr\(/g, 1);
  assert.doesNotMatch(start, /account_security::rate_limit\(|loop \{|while |retry|id\.is_nil/);
}
function startCompletion(text) {
  const start = fn(text, "start_login");
  inOrder(start, [
    ".generate_qr(upstream_deadline)", "db.begin().await?", "guard_login(&mut tx, user.id, &login)",
    "lock_account(&mut tx, user.id)", "account_scope(&account)", "lock_request(&mut tx, request.scope.request_id, user.id, &login)",
    'if current.status != "pending"', "current.operation_nonce != Some(nonce)", "account != request.scope.account",
    '"platform_login_changed"', "if !current.live", 'terminalize(&mut tx, current.scope.request_id, "expired")',
    "if !can_complete(&current, nonce, account)", "match upstream", "Ok(challenge)",
    "let key = encrypt(&scope::qr_plaintext(", "&current.scope", "QR_KEY_PURPOSE", "challenge.key.expose_for_storage()",
    "let payload = encrypt(&scope::qr_plaintext(", "&current.scope", "QR_PAYLOAD_PURPOSE", "&challenge.login_url",
    "UPDATE platform_login_requests SET qr_key_encrypted=$2,qr_payload_encrypted=$3,operation_nonce=NULL,operation_expires_at=NULL",
    ".bind(current.scope.request_id).bind(key).bind(payload).bind(POLL_INTERVAL_SECONDS)",
    "Err(error)", 'terminalize(&mut tx, current.scope.request_id, "failed")', "tx.commit().await?",
    'return Err(upstream_error("qr_generate", error))',
    "lock_request(&mut tx, current.scope.request_id, user.id, &login)",
    'qr_response(&current, qr_payload(decrypt, &current)?, Some("waiting"))', "tx.commit().await?", "Ok(StartLoginOutcome::Created(value))",
  ]);
  count(start, /can_complete\(/g, 1);
  count(start, /let (?:key|payload) = encrypt\(/g, 2);
}
function pollClaim(text) {
  const poll = fn(text, "poll_login");
  inOrder(poll, [
    "authenticate(context, &headers, true, false)", "login_hash(&headers)?", "db.begin().await?",
    "guard_login(&mut tx, user.id, &login)", "lock_account(&mut tx, user.id)", "account_scope(&account)",
    "lock_request(&mut tx, id, user.id, &login)",
    'if request.status == "pending" && !request.live', 'terminalize(&mut tx, id, "expired")',
    'else if request.status == "pending" && request.scope.account != account', 'terminalize(&mut tx, id, "failed")',
    'if request.status != "pending" || request.operation_live || !request.ready_to_poll',
    "qr_response(&request, None, None)", "tx.commit().await?", "return Ok(value)",
    "let Some(cipher) = request.qr_key_encrypted.as_deref() else", 'terminalize(&mut tx, id, "failed")',
    "qr_response(&request, None, None)", "tx.commit().await?", "return Ok(value)",
    "let key_secret = decrypt(cipher)", ".ok()", "scope::qr_secret(&request.scope, QR_KEY_PURPOSE, value)",
    "QrKey::from_secret(&key_secret)", "let nonce = Uuid::new_v4()",
    "operation_expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 second')",
    "next_poll_at=clock_timestamp()+$4*interval '1 second'",
    ".bind(id).bind(nonce).bind(OPERATION_LEASE_SECONDS).bind(POLL_INTERVAL_SECONDS)",
    "deadline(&request)?", "tx.commit().await?", "Client::new(*http, None)", ".poll_qr(&key, upstream_deadline)",
  ]);
  count(poll, /db\.begin\(/g, 2);
  count(poll, /tx\.commit\(\)/g, 5);
  count(poll, /guard_login\(/g, 2);
  count(poll, /poll_qr\(/g, 1);
  assert.doesNotMatch(poll, /generate_qr|rate_limit|loop \{|while |id\.is_nil/);
}
function pollCompletion(text) {
  const poll = fn(text, "poll_login");
  inOrder(poll, [
    ".poll_qr(&key, upstream_deadline)", "db.begin().await?", "guard_login(&mut tx, user.id, &login)",
    "lock_account(&mut tx, user.id)", "account_scope(&account)", "lock_request(&mut tx, id, user.id, &login)",
    'if current.status != "pending"', "current.operation_nonce != Some(nonce)", "account != request.scope.account",
    '"platform_login_changed"', "if !current.live", 'terminalize(&mut tx, id, "expired")', "stage = None",
    "if !can_complete(&current, nonce, account)", "match upstream", "Ok(poll) => match poll.state",
    "QrState::Waiting | QrState::Scanned", '"scanned"', '"waiting"',
    "UPDATE platform_login_requests SET operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST",
    ".bind(id).bind(POLL_INTERVAL_SECONDS)", "QrState::Expired", 'terminalize(&mut tx, id, "expired")',
    "QrState::Confirmed", "poll.session.ok_or_else(credential_error)?", ".checked_add(1)",
    "let updated_scope = AccountScope", "let cipher = encrypt(&scope::credential_plaintext(",
    "updated_scope", "cookie_value(&cookie)",
    "UPDATE platform_accounts SET state='connected'", "playback_login_allowed($5,$6)",
    "auth_login_hash=$6", "account_revision=$4", "expires_at>clock_timestamp()", "operation_nonce=$8", "operation_expires_at>clock_timestamp()",
    ".bind(account.account_id).bind(cipher).bind(revision).bind(account.revision).bind(user.id).bind(&login).bind(id).bind(nonce)",
    "if stored.rows_affected() != 1", '"platform_login_changed"',
    "renewal::store_grant(", "encrypt,", "&mut tx", "updated_scope", "&login", "poll.refresh_token", "request.consent_to_renew",
    'terminalize(&mut tx, id, "confirmed")', 'current.status = "confirmed".into()', "fail_pending(&mut tx, user.id)",
    "Err(error)", "UPDATE platform_login_requests SET operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST",
    ".bind(id).bind(POLL_INTERVAL_SECONDS)", "tx.commit().await?", 'return Err(upstream_error("qr_poll", error))',
    "lock_request(&mut tx, id, user.id, &login)", "qr_response(&current, None, stage)", "tx.commit().await?", "Ok(value)",
  ]);
  count(poll, /renewal::store_grant\(/g, 1);
  count(poll, /can_complete\(/g, 1);
  count(poll, /expires_at=LEAST/g, 1);
  count(poll, /operation_nonce=NULL,operation_expires_at=NULL,next_poll_at=GREATEST/g, 2);
}
function cancelOrder(text) {
  const cancel = fn(text, "cancel_login");
  inOrder(cancel, [
    "authenticate(context, &headers, true, false)", "login_hash(&headers)?",
    'account_security::rate_limit(db, "platform-login-cancel", &user.id.to_string(), 30, 600)',
    "db.begin().await?", "guard_login(&mut tx, user.id, &login)", "if id.is_nil()", '"platform_login_request_invalid"',
    "account_scope(&lock_account(&mut tx, user.id).await?)", "INSERT INTO platform_login_requests",
    "'bilibili','failed'", "ON CONFLICT(id) DO NOTHING",
    ".bind(id).bind(user.id).bind(&login).bind(QR_LIFETIME_SECONDS).bind(account.account_id).bind(account.revision)",
    "lock_request(&mut tx, id, user.id, &login)", 'if request.status == "pending"', 'terminalize(&mut tx, id, "failed")',
    "qr_response(&request, None, None)", "tx.commit().await?", "Ok(value)",
  ]);
  count(cancel, /db\.begin\(/g, 1);
  count(cancel, /tx\.commit\(\)/g, 1);
  assert.doesNotMatch(cancel, /claim_rate_limit|Client::|can_complete|guard_login_live/);
}
function projection(text) {
  const payload = fn(text, "qr_payload");
  inOrder(payload, [
    'if request.status == "pending" && request.live', ".qr_payload_encrypted", ".as_deref()",
    "decrypt(cipher)", ".ok()", "scope::qr_secret(&request.scope, QR_PAYLOAD_PURPOSE, value)", ".ok_or_else(credential_error)", ".transpose()", "Ok(None)",
  ]);
  const qr = fn(text, "qr_response");
  assert.equal(compact(qr.slice(0, qr.indexOf("{\n"))), "fn qr_response(request: &LoginRequest, payload: Option<String>, stage: Option<&str>) -> Value");
  inOrder(qr, [
    '\"id\": request.scope.request_id', '\"provider\": PROVIDER', '\"status\": request.status',
    '\"stage\": if request.status == "pending" { stage } else { None }', '\"qr_payload\": payload',
    '\"expires_at\": request.expires_at_ms', '\"next_poll_at\": request.next_poll_at_ms', '\"server_time\": request.server_time_ms',
  ]);
  assert.doesNotMatch(qr, /qr_key|operation_nonce|cookie|login_hash|consent|decrypt|encrypt|\.unwrap/);
}
function httpContract(text) {
  const shape = (s) => compact(s).replace(/,\s*\)/g, ")").replace(/\s*([(),])\s*/g, "$1");
  for (const name of names) {
    const operation = fn(text, name);
    const start = name === "start_login";
    const cancel = name === "cancel_login";
    assert.equal(shape(operation), shape(`pub async fn ${name}(
      State(app): State<App>, ${start ? "" : "Path(id): Path<Uuid>,"} headers: HeaderMap,
      ${start ? "Json(body): Json<StartLogin>," : ""}
    ) -> Result<Response> {
      ${cancel ? "" : `let key = app.key.as_ref();
      let decrypt = |value: &str| crate::decrypt_value(key, value);
      let encrypt = |value: &Value| crate::encrypt_value(key, value);`}
      let ${start ? "outcome" : "value"} = qr_login::${name}(
        app.identity_context(), ${cancel ? "" : "&app.platform_http, &decrypt, &encrypt,"} ${start ? "" : "id,"} headers, ${start ? "body," : ""}
      ).await?;
      ${start ? `let (status, value) = match outcome {
        qr_login::StartLoginOutcome::Replay(value) => (StatusCode::OK, value),
        qr_login::StartLoginOutcome::Created(value) => (StatusCode::CREATED, value),
      };` : ""}
      Ok(responses::private_json(${start ? "status" : "StatusCode::OK"}, value))
    }`));
  }
}
function grantContract(text) {
  const grant = fn(text, "store_grant");
  assert.match(grant, /encrypt: &\(dyn Fn\(&Value\) -> anyhow::Result<String> \+ Sync\)/);
  assert.doesNotMatch(grant, /\bApp\b|\bapp\b|decrypt|token_from/);
  inOrder(grant, ["if !consent", "return Ok(())", "let Some(token) = token else", "return Ok(())",
    "encrypt(&envelope(scope, login, &token))", ".map_err(|_| credential_error())?",
    "super::maintenance::phase(sqlx::query(", "INSERT INTO platform_account_renewals", "'scheduled'", "clock_timestamp()+interval '1 day'",
    ".bind(scope.account_id).bind(scope.revision).bind(login).bind(cipher).execute(&mut **tx)", "Ok(())"]);
}
function originalParent(text, http = parent) {
  assert.equal(hash(restoreBilibiliLoginParent(restoreBilibiliAccountParent(http, read("platform_accounts/account_operations.rs").split("#[cfg(test)]")[0]), text)),
    "209a350414d22549f5272c704fa05b18439593e619c184d49d3fd8f8a7071e4a",
    "finite inverse edits recover every platform_accounts.rs byte at b50b2e9");
}
function originalRenewal(text) {
  assert.equal(hash(restoreBilibiliRenewal(restoreBilibiliRenewalAccountParent(text, read("platform_accounts/renewal/account_operations.rs").split("#[cfg(test)]")[0]))),
    "8d4a2d0c29096cd1e083c592c4493eeb03586fccd229c99422d74c26c6d92bed",
    "store_grant-only inverse recovers every renewal.rs byte at b50b2e9");
}

test("three whole QR operations accept only explicit request, transport and cipher capabilities", () => capabilities(core));
test("start replay, consent conflict, exclusivity, durable admission and generation order stay exact", () => admission(core));
test("start generation reacquires authority, persists only bound secrets and distinguishes created", () => startCompletion(core));
test("poll terminal, lease, cadence, missing-key and durable claim branches stay before network", () => pollClaim(core));
test("poll completion and unknown-outcome recovery retain exact claim/account/live predicates and commit order", () => pollCompletion(core));
test("cancel spends its independent rate limit before transaction, nil ID and request conflicts", () => cancelOrder(core));
test("existing rate-limit helper commits its own bucket before returning denial or success", () => {
  inOrder(fn(security, "rate_limit"), ["hash(&format!", "rate_limit_key(db, scope, &key, limit, seconds).await"]);
  inOrder(fn(security, "rate_limit_key"), ["db.begin().await?", "claim_rate_limit_key(&mut tx, scope, key, limit, seconds).await?", "tx.commit().await?", "match retry_after", "Err(limited(seconds))", "None => Ok(())"]);
});
test("QR projection retains its exact private DTO, payload gate, envelope checks and redaction", () => projection(core));
test("HTTP wrappers borrow the key alone and explicitly map named replay to 200 and created to 201", () => httpContract(parent));
test("renewal grant storage receives only encryption and retains original consent/token/SQL order", () => grantContract(renewal));
test("inverse edits recover the entire original parent, including shared guards, logs and unmoved owners", () => originalParent(core));
test("inverse edits recover the entire original renewal module, including background renewal and shutdown behavior", () => originalRenewal(renewal));
test("Rust tests close lazy pools before operations and never open external resources", () => {
  const tests = all.split("#[cfg(test)]")[1].replace(/^    /gm, "");
  inOrder(fn(tests, "closed_pool"), [".min_connections(0)", ".connect_lazy_with(", "db.close().await", "assert!(db.is_closed())"]);
  count(tests, /let db = closed_pool\(\)\.await;/g, 2);
  assert.doesNotMatch(tests, /std::env|TcpListener|TcpStream|\.connect\(|\.connect_with\(|reqwest|Command::/);
});

const negatives = [
  ["whole App", "start_login", capabilities, "context: RequestContext<'_>", "context: App"],
  ["mutable transport", "poll_login", capabilities, "http: &PlatformHttp", "http: &mut PlatformHttp"],
  ["callback loses Sync", "start_login", capabilities, "-> anyhow::Result<String> + Sync", "-> anyhow::Result<String>"],
  ["guest admission", "start_login", capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, true, true)"],
  ["read authentication", "poll_login", capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, false, false)"],
  ["late consent validation", "start_login", admission, "    let login = login_hash(&headers)?;", ""],
  ["replay renewal consent mismatch", "start_login", admission, "request.consent_to_renew != body.consent_to_renew", "false"],
  ["unknown generation retry", "start_login", admission, "request.qr_key_encrypted.is_none() && !request.operation_live", "request.qr_key_encrypted.is_none()"],
  ["start replay changes status", "start_login", admission, "StartLoginOutcome::Replay(value)", "StartLoginOutcome::Created(value)"],
  ["start admission rate bucket", "start_login", admission, '"platform-login-start"', '"platform-login-cancel"'],
  ["start rate denial skips commit", "start_login", admission, "        tx.commit().await?;\n        return Err(account_security::limited(seconds));", "        return Err(account_security::limited(seconds));"],
  ["remote generation before durable admission", "start_login", admission, "    tx.commit().await?;\n    let upstream = Client", "    let upstream = Client"],
  ["generation HTTP not borrowed Copy", "start_login", admission, "Client::new(*http, None)", "Client::new(http, None)"],
  ["start missing second authority lock", "start_login", startCompletion, "    // No database lock/transaction is retained across the provider call.\n    let mut tx = db.begin().await?;\n    guard_login(&mut tx, user.id, &login).await?;", "    let mut tx = db.begin().await?;"],
  ["start response nonce fence", "start_login", startCompletion, "current.operation_nonce != Some(nonce)", "current.operation_nonce.is_none()"],
  ["start response account fence", "start_login", startCompletion, "account != request.scope.account", "false"],
  ["start response lease fence", "start_login", startCompletion, "!can_complete(&current, nonce, account)", "false"],
  ["payload bound as key", "start_login", startCompletion, "QR_PAYLOAD_PURPOSE,", "QR_KEY_PURPOSE,"],
  ["generation error not terminal", "start_login", startCompletion, 'terminalize(&mut tx, current.scope.request_id, "failed").await?;', "Ok::<(), crate::Error>(())?;"],
  ["created becomes replay", "start_login", startCompletion, "StartLoginOutcome::Created(value)", "StartLoginOutcome::Replay(value)"],
  ["poll cadence bypass", "poll_login", pollClaim, " || !request.ready_to_poll", ""],
  ["poll active lease bypass", "poll_login", pollClaim, " || request.operation_live", ""],
  ["poll key wrong purpose", "poll_login", pollClaim, "scope::qr_secret(&request.scope, QR_KEY_PURPOSE, value)", "scope::qr_secret(&request.scope, QR_PAYLOAD_PURPOSE, value)"],
  ["poll claim outlives request", "poll_login", pollClaim, "operation_expires_at=LEAST(expires_at,clock_timestamp()+$3*interval '1 second')", "operation_expires_at=clock_timestamp()+$3*interval '1 second'"],
  ["poll claim not durable", "poll_login", pollClaim, "    tx.commit().await?;\n    let upstream = Client", "    let upstream = Client"],
  ["poll deadline renewed", "poll_login", pollClaim, "deadline(&request)?", "deadline(&current)?"],
  ["poll nonce completion fence", "poll_login", pollCompletion, "current.operation_nonce != Some(nonce)", "false"],
  ["poll account revision fence", "poll_login", pollCompletion, "account != request.scope.account", "false"],
  ["poll checked revision increment", "poll_login", pollCompletion, ".checked_add(1)", ".checked_add(2)"],
  ["poll live SQL predicate", "poll_login", pollCompletion, "playback_login_allowed($5,$6)", "true"],
  ["poll exact-login SQL fence", "poll_login", pollCompletion, "auth_login_hash=$6", "true"],
  ["poll SQL operation nonce", "poll_login", pollCompletion, "operation_nonce=$8", "true"],
  ["poll SQL operation lease", "poll_login", pollCompletion, "operation_expires_at>clock_timestamp()", "true"],
  ["poll CAS acceptance", "poll_login", pollCompletion, "stored.rows_affected() != 1", "stored.rows_affected() > 1"],
  ["renewal uses current mutable consent", "poll_login", pollCompletion, "request.consent_to_renew,", "current.consent_to_renew,"],
  ["poll skips other pending requests", "poll_login", pollCompletion, "                    fail_pending(&mut tx, user.id).await?;", ""],
  ["unknown poll returns before claim release commit", "poll_login", pollCompletion, "                tx.commit().await?;\n                return Err(upstream_error(\"qr_poll\", error));", "                return Err(upstream_error(\"qr_poll\", error));"],
  ["cancel rate bucket changed", "cancel_login", cancelOrder, '"platform-login-cancel"', '"platform-login-start"'],
  ["cancel budget changed", "cancel_login", cancelOrder, "30, 600", "10, 600"],
  ["cancel changes conflict tombstone", "cancel_login", cancelOrder, "ON CONFLICT(id) DO NOTHING", "ON CONFLICT(id) DO UPDATE SET status='failed'"],
  ["cancel changes pending-only terminalization", "cancel_login", cancelOrder, 'if request.status == "pending"', 'if request.status != "confirmed"'],
  ["cancel reveals QR payload", "cancel_login", cancelOrder, "qr_response(&request, None, None)", "qr_response(&request, Some(\"leak\".into()), None)"],
  ["projection reveals expired payload", "qr_payload", projection, 'request.status == "pending" && request.live', 'request.status == "pending"'],
  ["projection wrong envelope purpose", "qr_payload", projection, "QR_PAYLOAD_PURPOSE, value", "QR_KEY_PURPOSE, value"],
];
for (const [label, name, check, from, to] of negatives) {
  test(`in-memory mutation rejected: ${label}`, () => {
    const operation = fn(core, name);
    const mutated = replaceOnce(core, operation, replaceOnce(operation, from, to));
    assert.throws(() => check(mutated));
    assert.throws(() => { capabilities(mutated); originalParent(mutated); });
  });
}
for (const [label, from, to] of [
  ["HTTP created collapses to OK", "StartLoginOutcome::Created(value) => (StatusCode::CREATED, value)", "StartLoginOutcome::Created(value) => (StatusCode::OK, value)"],
  ["HTTP callback captures App", "let decrypt = |value: &str| crate::decrypt_value(key, value);", "let decrypt = |value: &str| app.decrypt(value);"],
]) {
  test(`in-memory mutation rejected: ${label}`, () => {
    const wrapper = fn(parent, "start_login");
    const mutated = replaceOnce(parent, wrapper, replaceOnce(wrapper, from, to));
    assert.throws(() => httpContract(mutated));
  });
}
for (const [label, from, to] of [
  ["renewal consent opt-in removed", "if !consent", "if false"],
  ["renewal token missing branch changed", "let Some(token) = token else", "let Some(token) = token.clone() else"],
  ["renewal schedule changed", "clock_timestamp()+interval '1 day'", "clock_timestamp()+interval '1 hour'"],
]) {
  test(`in-memory mutation rejected: ${label}`, () => {
    const grant = fn(renewal, "store_grant");
    const mutated = replaceOnce(renewal, grant, replaceOnce(grant, from, to));
    assert.throws(() => grantContract(mutated));
    assert.throws(() => originalRenewal(mutated));
  });
}
test("in-memory mutation rejected: any unmoved parent guard or logging change", () => {
  assert.throws(() => originalParent(core, replaceOnce(parent, 'failure_class = upstream_failure_class(&error),\n            qr_url_scheme', 'failure_class = "changed",\n            qr_url_scheme')));
});
test("in-memory mutation rejected: any unrelated renewal owner change", () => {
  assert.throws(() => originalRenewal(replaceOnce(renewal, "const PURPOSE: &str = \"bilibili_refresh_token_v1\";", "const PURPOSE: &str = \"changed\";")));
});

// Inspect the legacy native runner without importing or executing it. Its
// playback fixtures remain outside this task's runtime verification scope.
const nativeRunner = readFileSync(new URL('./native-platform-postgres.mjs', import.meta.url), 'utf8');
function nativeSourceLocation(text) {
  const inventory = text.slice(text.indexOf('  const inputPaths ='), text.indexOf('  for (const path of inputPaths)'));
  assert.equal((inventory.match(/"apps\/server\/src\/platform_accounts\/qr_login.rs"/g) ?? []).length, 1);
  assert.ok(text.includes('const accountSource = (await readFile(resolve(repo, "apps/server/src/platform_accounts/qr_login.rs"), "utf8")).split("#[cfg(test)]")[0];'));
  assert.ok(text.includes('assert.equal(predicates.length, 1,'));
}
test('legacy native SQL locator hashes and reads the new production-only QR owner without execution', () => {
  nativeSourceLocation(nativeRunner);
  const statements = [...core.matchAll(/sqlx::query\("(UPDATE platform_accounts SET state='connected'[^"\n]+)"\)/g)];
  assert.equal(statements.length, 1);
  assert.ok(statements[0][1].includes('operation_expires_at>clock_timestamp()'));
});
test('legacy native locator rejects stale parent reads and omitted source identity', () => {
  const path = '"apps/server/src/platform_accounts/qr_login.rs"';
  assert.throws(() => nativeSourceLocation(nativeRunner.replaceAll(path, '"apps/server/src/platform_accounts.rs"')));
  assert.throws(() => nativeSourceLocation(nativeRunner.replace(path, '"omitted-source"')));
  assert.throws(() => nativeSourceLocation(nativeRunner.replace('.split("#[cfg(test)]")[0];', ';')));
});
