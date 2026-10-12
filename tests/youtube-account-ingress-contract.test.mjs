// Pure production-source contracts and in-memory negative controls. No DB,
// socket, server, network, subprocess, or Cargo. These do not establish runtime
// authority, authenticated success, PostgreSQL expiry/lock waits, or rollback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { restoreBilibiliAccountParent } from "./fixtures/bilibili-account-source-inverse.mjs";
import { restoreBilibiliLoginParent } from "./fixtures/bilibili-login-source-inverse.mjs";

const source = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const core = source("platform_accounts/youtube.rs").split("#[cfg(test)]")[0];
const http = source("platform_accounts.rs");
const compact = (text) => text.replace(/\s+/g, " ").trim();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const count = (text, pattern, expected) => assert.equal((text.match(pattern) ?? []).length, expected);
const fn = (text, name) => {
  const start = new RegExp(`^(?:pub(?:\\([^)]*\\))? )?(?:async )?fn ${name}\\(`, "m").exec(text);
  assert.ok(start, `missing function ${name}`);
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
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length - 1, 1, `unique replacement: ${from}`);
  return text.replace(from, to);
};
const operations = ["status", "import", "unlink"];
const originalNames = {
  status: "youtube_status", import: "import_youtube_credential", unlink: "unlink_youtube",
};
const signatures = {
  status: "context: RequestContext<'_>, import_available: bool, headers: HeaderMap,",
  import: "context: RequestContext<'_>, import_available: bool, encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync), headers: HeaderMap, body: ImportYoutubeCredential,",
  unlink: "context: RequestContext<'_>, import_available: bool, headers: HeaderMap, body: UnlinkCredential,",
};
function admission(text) {
  assert.doesNotMatch(text, /\b(?:App|Aes256Gcm|State|Response|SourceWriteContext|SourceReadContext|SourceChangeContext)\b|responses::|super::\*|reqwest|decrypt|encrypt_value|catalog::|auth\(/);
  assert.deepEqual([...text.matchAll(/^pub\(crate\) async fn (\w+)\(/gm)].map((m) => m[1]), operations);
  count(text, /request::authenticate\(/g, 3);
  count(text, /if !import_available/g, 1);
  count(text, /encrypt: &\(dyn Fn\(&Value\) -> anyhow::Result<String> \+ Sync\)/g, 1);
  for (const name of operations) {
    const operation = fn(text, name);
    assert.equal(compact(operation.slice(0, operation.indexOf("{\n"))),
      `pub(crate) async fn ${name}( ${signatures[name]} ) -> Result<Value>`);
    assert.ok(body(operation).startsWith(`    let db = context.db;\n    let user = request::authenticate(context, &headers, ${name !== "status"}, false).await?;\n    let login = login_hash(&headers)?;\n`));
    count(operation, /db\.begin\(/g, 1);
    count(operation, /tx\.commit\(\)\.await\?/g, 1);
    count(operation, /guard_login\(/g, 1);
    assert.doesNotMatch(operation, /tokio::spawn|\.unwrap\(|\.expect\(|std::env/);
  }
}

const narrowImports = `use super::{
    AccountScope, PROVIDER_ACCOUNT_SELECT, UnlinkCredential, account_scope, credential_error,
    expected_revision, guard_login, guard_login_live, lock_provider_account, login_hash,
    revision_matches, scope,
};
use crate::identity::{RequestContext, request};
use crate::{Result, account_security, err};
use axum::http::{HeaderMap, StatusCode};
use providers::platform::youtube::Credential;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgRow};
use uuid::Uuid;`;
const originalSignatures = {
  status: "pub async fn youtube_status(State(app): State<App>, headers: HeaderMap) -> Result<Response>",
  import: `pub async fn import_youtube_credential(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<ImportYoutubeCredential>,
) -> Result<Response>`,
  unlink: `pub async fn unlink_youtube(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<UnlinkCredential>,
) -> Result<Response>`,
};
// Invert only the reviewed dependency/HTTP boundary edits. The resulting full
// production prefix must recover every baseline byte, including SQL, binds,
// errors, helper/DTO definitions, transactions, clock, and cipher placement.
function originalCore(text) {
  let restored = replaceOnce(text, narrowImports,
    "use super::*;\nuse providers::platform::youtube::Credential;");
  for (const name of operations) {
    const operation = fn(restored, name);
    let original = body(operation);
    original = replaceOnce(original, "    let db = context.db;\n", "");
    original = replaceOnce(original,
      `request::authenticate(context, &headers, ${name !== "status"}, false)`,
      `auth(&app, &headers, ${name !== "status"})`);
    original = replaceOnce(original, "db.begin()", "app.db.begin()");
    original = original.replaceAll("import_available", "app.youtube.viewer_credentials_enabled()");
    if (name === "import") {
      original = replaceOnce(original,
        `    account_security::rate_limit(db, "youtube-cookie-import", &user.id.to_string(), 10, 600)
        .await?;`,
        `    account_security::rate_limit(
        &app.db,
        "youtube-cookie-import",
        &user.id.to_string(),
        10,
        600,
    )
    .await?;`);
      original = replaceOnce(original,
        `    let cipher = encrypt(&scope::credential_plaintext_for_provider(
        AccountScope {
            revision,
            ..account
        },
        "youtube",
        json!(credential.expose_for_storage()),
    ))
    .map_err(|_| credential_error())?;`,
        `    let cipher = app
        .encrypt(&scope::credential_plaintext_for_provider(
            AccountScope {
                revision,
                ..account
            },
            "youtube",
            json!(credential.expose_for_storage()),
        ))
        .map_err(|_| credential_error())?;`);
    }
    original = replaceOnce(original, "    Ok(value)", "    Ok(responses::private_json(StatusCode::OK, value))");
    restored = replaceOnce(restored, operation, `${originalSignatures[name]} {\n${original}\n}`);
  }
  return restored;
}
function originalTransactions(text) {
  // SHA-256 of youtube.rs before #[cfg(test)] at af1bb109fabf89b942d05772b26dbe9fc8dac01e.
  assert.equal(hash(originalCore(text)), "2f541b3254344ac2f71c8ebaaccb60ef5504b3518a4b98dba2c919b8142dd3b2");
}

function statusFlow(text) {
  const status = fn(text, "status");
  inOrder(status, [
    "authenticate(context, &headers, false, false).await?", "login_hash(&headers)?",
    "db.begin().await?", "guard_login(&mut tx, user.id, &login).await?",
    "SELECT id FROM platform_accounts WHERE user_id=$1 AND provider='youtube' FOR UPDATE",
    "let mut row = sqlx::query(PROVIDER_ACCOUNT_SELECT)",
    'row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")',
    'lock_provider_account(&mut tx, user.id, "youtube").await?',
    "guard_login_live(&mut tx, user.id, &login).await?",
    "status_value(import_available, row.as_ref())", "tx.commit().await?", "Ok(value)",
  ]);
  count(status, /guard_login_live\(/g, 1);
  count(status, /lock_provider_account\(/g, 1);
  assert.doesNotMatch(status, /if !import_available|rate_limit|checked_add|encrypt|SystemTime/);
}
function importFlow(text) {
  const operation = fn(text, "import");
  inOrder(operation, [
    "authenticate(context, &headers, true, false).await?", "login_hash(&headers)?",
    "if !import_available", '"youtube_account_import_unavailable"',
    "if !body.consent_to_store", '"platform_storage_consent_required"',
    "expected_revision(&body.expected_revision)?", "std::time::SystemTime::now()",
    ".duration_since(std::time::UNIX_EPOCH)", ".map_err(|_| credential_error())?", ".as_secs()",
    "Credential::parse(&body.cookie_file, now)", 'err(StatusCode::BAD_REQUEST, "platform_credential_invalid")',
    'account_security::rate_limit(db, "youtube-cookie-import", &user.id.to_string(), 10, 600)',
    "db.begin().await?", "guard_login(&mut tx, user.id, &login).await?",
    'lock_provider_account(&mut tx, user.id, "youtube").await?', "account_scope(&row)",
    "revision_matches(expected, account.revision, inserted)", '"platform_account_changed"',
    ".checked_add(1)", ".ok_or_else(credential_error)?",
    "encrypt(&scope::credential_plaintext_for_provider(", "json!(credential.expose_for_storage())",
    ".map_err(|_| credential_error())?", "guard_login_live(&mut tx, user.id, &login).await?",
    "UPDATE platform_accounts SET state='connected',credential_encrypted=$2,credential_expires_at=to_timestamp($8::double precision/1000),revision=$3,updated_at=clock_timestamp() WHERE id=$1 AND revision=$4 AND user_id=$5 AND provider=$6 AND playback_login_allowed($5,$7)",
    '.bind("youtube").bind(&login).bind(credential.expires_at_ms())',
    "if updated.rows_affected() != 1", '"platform_account_changed"',
    "guard_login_live(&mut tx, user.id, &login).await?", "sqlx::query(PROVIDER_ACCOUNT_SELECT)",
    "status_value(import_available, Some(&row))", "tx.commit().await?", "Ok(value)",
  ]);
  count(operation, /SystemTime::now\(\)/g, 1);
  count(operation, /Credential::parse\(/g, 1);
  count(operation, /account_security::rate_limit\(/g, 1);
  count(operation, /guard_login_live\(/g, 2);
  count(operation, /\bencrypt\(/g, 1);
  assert.doesNotMatch(operation.slice(0, operation.indexOf("let cipher =")), /guard_login_live\(/);
}
function unlinkFlow(text) {
  const unlink = fn(text, "unlink");
  inOrder(unlink, [
    "authenticate(context, &headers, true, false).await?", "login_hash(&headers)?",
    "expected_revision(&body.expected_revision)?", "db.begin().await?",
    "guard_login(&mut tx, user.id, &login).await?",
    'lock_provider_account(&mut tx, user.id, "youtube").await?', "account_scope(&row)",
    "revision_matches(expected, account.revision, inserted)", '"platform_account_changed"',
    ".checked_add(1)", ".ok_or_else(credential_error)?",
    "UPDATE platform_accounts SET state='revoked',credential_encrypted=NULL,credential_expires_at=NULL,revision=$2,updated_at=clock_timestamp() WHERE id=$1 AND revision=$3 AND user_id=$4 AND provider='youtube' AND playback_login_allowed($4,$5)",
    ".bind(account.account_id).bind(revision).bind(account.revision).bind(user.id).bind(&login)",
    "if updated.rows_affected() != 1", '"platform_account_changed"',
    "guard_login_live(&mut tx, user.id, &login).await?", "sqlx::query(PROVIDER_ACCOUNT_SELECT)",
    "status_value(import_available, Some(&row))", "tx.commit().await?", "Ok(value)",
  ]);
  count(unlink, /guard_login_live\(/g, 1);
  assert.doesNotMatch(unlink.slice(0, unlink.indexOf("let updated =")), /guard_login_live\(/);
  assert.doesNotMatch(unlink, /if !import_available|rate_limit|\bencrypt|SystemTime/);
}
function httpContract(text) {
  for (const name of operations) {
    const dto = name === "import" ? "ImportYoutubeCredential" : "UnlinkCredential";
    const signature = name === "status"
      ? "pub async fn youtube_status(State(app): State<App>, headers: HeaderMap) -> Result<Response>"
      : `pub async fn ${originalNames[name]}( State(app): State<App>, headers: HeaderMap, Json(body): Json<${dto}>, ) -> Result<Response>`;
    assert.equal(compact(fn(text, originalNames[name])), compact(`${signature} {
      ${name === "import" ? "let key = app.key.as_ref(); let encrypt = |value: &Value| crate::encrypt_value(key, value);" : ""}
      let value = youtube::${name}(
        app.identity_context(), app.youtube.viewer_credentials_enabled(),
        ${name === "import" ? "&encrypt," : ""} headers, ${name === "status" ? "" : "body,"}
      ) .await?;
      Ok(responses::private_json(StatusCode::OK, value))
    }`));
  }
  assert.ok(text.includes("pub use youtube::ImportYoutubeCredential;"));
}
function originalHttp(text) {
  const beforeAccountExtraction = restoreBilibiliAccountParent(text, source("platform_accounts/account_operations.rs").split("#[cfg(test)]")[0]);
  const beforeQrExtraction = restoreBilibiliLoginParent(beforeAccountExtraction, source("platform_accounts/qr_login.rs").split("#[cfg(test)]")[0]);
  let restored = replaceOnce(beforeQrExtraction, "pub use youtube::ImportYoutubeCredential;",
    "pub use youtube::{import_youtube_credential, unlink_youtube, youtube_status};");
  for (const name of operations) restored = replaceOnce(restored, `${fn(restored, originalNames[name])}\n\n`, "");
  assert.equal(hash(restored), "c061bcbbd58625ba40f336eaa9dc53bf2f591dabc58340905a89801a901fd738",
    "all pre-existing HTTP/shared guard/revision/other-platform bytes remain unchanged");
}

test("operations accept only request context, startup opt-in, and import-only encrypt capability", () => admission(core));
test("reversing reviewed boundary edits recovers the complete original production module byte-for-byte", () => originalTransactions(core));
test("status preserves exact login, lock, conditional expiry normalization, and commit order", () => statusFlow(core));
test("import preserves auth, opt-in, consent, revision, one clock, parsing, rate limit, CAS, cipher, and live guard order", () => importFlow(core));
test("unlink remains available without opt-in and retains original SQL predicate and live-check position", () => unlinkFlow(core));
test("HTTP adapters only compose, delegate once, and return private JSON; the callback borrows only the key", () => httpContract(http));
test("removing new wrappers and restoring the re-export recovers all original parent-module bytes", () => originalHttp(http));
test("synthetic Rust operation tests close their lazy pool before use", () => {
  const tests = source("platform_accounts/youtube.rs").split("#[cfg(test)]")[1];
  inOrder(fn(tests.replace(/^    /gm, ""), "closed_pool"), [".min_connections(0)", ".connect_lazy_with(", "db.close().await", "assert!(db.is_closed())", "\n    db"]);
  count(tests, /let db = closed_pool\(\)\.await;/g, 4);
  assert.doesNotMatch(tests, /std::env|TcpListener|TcpStream|\.connect\(|\.connect_with\(|reqwest|Command::/);
});

const negatives = [
  ["application capability", core, admission, "context: RequestContext<'_>", "context: App"],
  ["guest admission", core, admission, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, true, true)"],
  ["read-only import admission", core, admission, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, false, false)"],
  ["callback loses Sync", core, admission, "-> anyhow::Result<String> + Sync", "-> anyhow::Result<String>"],
  ["raw cipher capability", core, admission, "encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync)", "key: &Aes256Gcm"],
  ["missing status account lock", core, statusFlow, "provider='youtube' FOR UPDATE", "provider='youtube'"],
  ["unconditional status normalization", core, statusFlow, 'row.get::<String, _>("state") == "connected" && !row.get::<bool, _>("credential_live")', "true"],
  ["missing status final login check", core, statusFlow, "    guard_login_live(&mut tx, user.id, &login).await?;\n", ""],
  ["status unexpectedly gated", core, statusFlow, "    let value = status_value(import_available, row.as_ref());", "    if !import_available { return Err(credential_error()); }\n    let value = status_value(import_available, row.as_ref());"],
  ["missing import opt-in", core, importFlow, "    if !import_available {", "    if false {"],
  ["consent before auth", core, admission, "    let db = context.db;\n    let user = request::authenticate(context, &headers, true, false).await?;", "    if !body.consent_to_store { return Err(credential_error()); }\n    let db = context.db;\n    let user = request::authenticate(context, &headers, true, false).await?;"],
  ["clock reread after lock", core, importFlow, 'let (row, inserted) = lock_provider_account(&mut tx, user.id, "youtube").await?;', 'let (row, inserted) = lock_provider_account(&mut tx, user.id, "youtube").await?;\n    let _ = std::time::SystemTime::now();'],
  ["rate limit removed", core, importFlow, '    account_security::rate_limit(db, "youtube-cookie-import", &user.id.to_string(), 10, 600)\n        .await?;\n', ""],
  ["rate budget changed", core, importFlow, '"youtube-cookie-import", &user.id.to_string(), 10, 600', '"youtube-cookie-import", &user.id.to_string(), 11, 600'],
  ["CAS removed", core, importFlow, "revision_matches(expected, account.revision, inserted)", "true"],
  ["overflow bypass", core, importFlow, ".checked_add(1)", ".wrapping_add(1)"],
  ["short-style extra live guard before cipher", core, importFlow, "    let cipher = encrypt(", "    guard_login_live(&mut tx, user.id, &login).await?;\n    let cipher = encrypt("],
  ["cipher error exposed", core, originalTransactions, ".map_err(|_| credential_error())?;\n    guard_login_live", ".map_err(crate::Error::from)?;\n    guard_login_live"],
  ["import expiry bind changed", core, importFlow, ".bind(credential.expires_at_ms())", ".bind(None::<i64>)"],
  ["import exact login predicate removed", core, importFlow, " AND playback_login_allowed($5,$7)", ""],
  ["import final login check deleted", core, importFlow, "    guard_login_live(&mut tx, user.id, &login).await?;\n    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)", "    let row = sqlx::query(PROVIDER_ACCOUNT_SELECT)"],
  ["unlink unexpectedly gated", core, unlinkFlow, "body: UnlinkCredential,\n) -> Result<Value> {", "body: UnlinkCredential,\n) -> Result<Value> {\n    if !import_available { return Err(credential_error()); }"],
  ["unlink adds pre-update live guard", core, unlinkFlow, "    let updated = sqlx::query(\"UPDATE platform_accounts SET state='revoked'", "    guard_login_live(&mut tx, user.id, &login).await?;\n    let updated = sqlx::query(\"UPDATE platform_accounts SET state='revoked'"],
  ["unlink retains stale expiry", core, unlinkFlow, "credential_encrypted=NULL,credential_expires_at=NULL", "credential_encrypted=NULL"],
  ["unlink exact login predicate removed", core, unlinkFlow, " AND playback_login_allowed($4,$5)", ""],
  ["status commit failure ignored", core, originalTransactions, "    tx.commit().await?;", "    let _ = tx.commit().await;"],
  ["extra secret status field", core, originalTransactions, 'value["login_method"] =', 'value["cookies"] = json!("secret");\n    value["login_method"] ='],
  ["HTTP captures whole App", http, httpContract, "|value: &Value| crate::encrypt_value(key, value)", "|value: &Value| app.encrypt(value)"],
  ["HTTP performs eager encryption", http, httpContract, "let key = app.key.as_ref();", "let _ = app.encrypt(&Value::Null); let key = app.key.as_ref();"],
  ["HTTP uses catalog-specific factory", http, httpContract, "let encrypt = |value: &Value| crate::encrypt_value(key, value);", "let encrypt = app.catalog_encryptor();"],
  ["HTTP rejects before operation", http, httpContract, "let value = youtube::status(", "auth(&app, &headers, false).await?; let value = youtube::status("],
  ["HTTP loses private response", http, httpContract, "Ok(responses::private_json(StatusCode::OK, value))\n}\n\npub async fn import_youtube_credential", "Ok(responses::ok_json(value))\n}\n\npub async fn import_youtube_credential"],
];
for (const [name, text, check, from, to] of negatives) {
  test(`negative control rejects: ${name}`, () => {
    check(text); // A failing pristine guard must never count as a useful negative.
    assert.ok(text.includes(from), "mutation must touch current production source");
    // QR now has its own key-only callback too: mutate the owned YouTube
    // wrapper, never an earlier unrelated function with the same text.
    const scoped = name === "HTTP captures whole App"
      || name === "HTTP performs eager encryption"
      || name === "HTTP uses catalog-specific factory";
    const target = scoped ? fn(text, "import_youtube_credential") : text;
    assert.ok(target.includes(from), "mutation must touch the owned function");
    if (scoped) assert.equal(target.split(from).length - 1, 1);
    const mutated = scoped
      ? replaceOnce(text, target, target.replace(from, to))
      : text.replace(from, to);
    assert.notEqual(mutated, text);
    assert.throws(() => check(mutated), { code: "ERR_ASSERTION" });
  });
}

const clock = `    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| credential_error())?
        .as_secs();\n`;
const cipher = `    let cipher = encrypt(&scope::credential_plaintext_for_provider(
        AccountScope {
            revision,
            ..account
        },
        "youtube",
        json!(credential.expose_for_storage()),
    ))
    .map_err(|_| credential_error())?;\n`;
const liveGuard = "    guard_login_live(&mut tx, user.id, &login).await?;\n";
const rate = '    account_security::rate_limit(db, "youtube-cookie-import", &user.id.to_string(), 10, 600)\n        .await?;\n';
for (const [name, from, to] of [
  ["single clock moved before revision validation",
    `    let expected = expected_revision(&body.expected_revision)?;\n${clock}`,
    `${clock}    let expected = expected_revision(&body.expected_revision)?;\n`],
  ["single clock moved after rate limit",
    `${clock}    let credential = Credential::parse(&body.cookie_file, now)\n        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_credential_invalid"))?;\n${rate}`,
    `    let credential = Credential::parse(&body.cookie_file, 0)\n        .map_err(|_| err(StatusCode::BAD_REQUEST, "platform_credential_invalid"))?;\n${rate}${clock}`],
  ["original live guard moved before encryption", `${cipher}${liveGuard}`, `${liveGuard}${cipher}`],
  ["rate limit moved inside transaction", `${rate}    let mut tx = db.begin().await?;\n`, `    let mut tx = db.begin().await?;\n${rate}`],
]) {
  test(`reordering negative control rejects: ${name}`, () => {
    importFlow(core);
    const mutated = replaceOnce(core, from, to);
    assert.notEqual(mutated, core);
    assert.throws(() => importFlow(mutated), { code: "ERR_ASSERTION" });
  });
}
