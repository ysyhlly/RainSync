// Production-source contracts and in-memory negative controls only. No Cargo,
// subprocess, database, sockets, provider traffic, or runtime authorization proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { undoOAuthDisableFinalLoginGuard } from "./fixtures/oauth-disable-login-guard-inverse.mjs";

const read = (path) => readFileSync(new URL(`../apps/server/src/${path}`, import.meta.url), "utf8");
const http = read("platform_accounts/oauth.rs");
const all = read("platform_accounts/oauth/account_operations.rs");
const core = all.split("#[cfg(test)]")[0];
const maintenance = read("platform_accounts/maintenance.rs");
const operations = ["status", "set_renewal", "unlink"];
const compact = (text) => text.replace(/\s+/g, " ").trim();
const hash = (text) => createHash("sha256").update(text).digest("hex");
function fn(text, name) {
  const start = new RegExp(`^(?:pub(?:\\([^)]*\\))? )?(?:async )?fn ${name}\\(`, "m").exec(text);
  assert.ok(start, `missing function ${name}`);
  const end = text.indexOf("\n}", start.index);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return text.slice(start.index, end + 2);
}
const body = (text) => text.slice(text.indexOf("{\n") + 2, -2);
const count = (text, regex, expected) => assert.equal((text.match(regex) ?? []).length, expected);
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length - 1, 1, `unique replacement: ${from}`);
  return text.replace(from, to);
}
function inOrder(text, parts) {
  let previous = -1;
  for (const part of parts) {
    const position = text.indexOf(part, previous + 1);
    assert.ok(position > previous, `missing or reordered: ${part}`);
    previous = position;
  }
}
const signatures = {
  status: "context: RequestContext<'_>, registry: &Registry, raw: String, headers: HeaderMap,",
  set_renewal: "context: RequestContext<'_>, registry: &Registry, decrypt: &(dyn Fn(&str) -> anyhow::Result<Value> + Sync), encrypt: &(dyn Fn(&Value) -> anyhow::Result<String> + Sync), raw: String, headers: HeaderMap, body: Preference,",
  unlink: "context: RequestContext<'_>, registry: &Registry, raw: String, headers: HeaderMap, body: UnlinkCredential,",
};
function capabilities(text) {
  assert.doesNotMatch(text, /&mut Registry/);
  assert.doesNotMatch(text, /\b(?:App|Aes256Gcm|State|Response|Transport)\b|responses::|super::\*|reqwest|platform_http|youtube|upstream|std::env|tokio::spawn/);
  assert.deepEqual([...text.matchAll(/^pub\(super\) async fn (\w+)\(/gm)].map((m) => m[1]), operations);
  for (const name of operations) {
    const operation = fn(text, name);
    assert.equal(compact(operation.slice(0, operation.indexOf("{\n"))),
      `pub(super) async fn ${name}( ${signatures[name]} ) -> Result<Value>`);
    inOrder(operation, ["let db = context.db;", "parse_provider(&raw)?",
      `request::authenticate(context, &headers, ${name !== "status"}, false).await?`,
      "login_hash(&headers)?", "maintenance::begin_db(db).await?",
      "maintenance::phase(guard_login(&mut tx, user.id, &login)).await?",
      "maintenance::commit(tx).await?", "Ok(value)"]);
    count(operation, /maintenance::begin_db\(/g, 1);
    count(operation, /maintenance::commit\(/g, 1);
    count(operation, /guard_login\(/g, 1);
    assert.doesNotMatch(operation, /configured\(|\.send\(|\.begin\(|\.unwrap\(|\.expect\(/);
  }
  assert.doesNotMatch(fn(text, "status"), /\bdecrypt\b|\bencrypt\b/);
  assert.doesNotMatch(fn(text, "unlink"), /\bdecrypt\b|\bencrypt\b/);
}
function statusFlow(text) {
  const operation = fn(text, "status");
  inOrder(operation, ["guard_login(&mut tx, user.id, &login)",
    "config_binding IS DISTINCT FROM $3", ".bind(registry.config(p).map(Config::binding))",
    "refresh_expires_at<=clock_timestamp()", "sqlx::query(ACCOUNT)", ".fetch_optional(&mut *tx)",
    "guard_login_live(&mut tx, user.id, &login)",
    "status_value(registry, p, row.as_ref(), &login)", "maintenance::commit(tx).await?", "Ok(value)"]);
  count(operation, /guard_login_live\(/g, 1);
  assert.doesNotMatch(operation, /lock_account|expected_revision|rate_limit|if !registry/);
}
function renewalFlow(text) {
  const operation = fn(text, "set_renewal");
  inOrder(operation, ["authenticate(context, &headers, true, false)", "login_hash(&headers)?",
    "expected_revision(&body.expected_revision)?", "maintenance::begin_db(db).await?",
    "guard_login(&mut tx, user.id, &login)", "lock_account(&mut tx, user.id, p).await?", "scope(&account)",
    "revision_matches(expected, s.revision, inserted)", '"platform_account_changed"', "if body.enabled",
    '"platform_renewal_new_consented_oauth_required"', "s.revision.checked_add(1).ok_or_else(credential_error)?",
    'if let Some(old) = account.get::<Option<String>, _>("token_encrypted")',
    '.get::<Option<String>, _>("config_binding")', ".ok_or_else(credential_error)?", "let t = token_from(",
    "decrypt(&old).map_err(|_| credential_error())?", "encrypt(&token_envelope(next, p, &binding, &t))",
    ".map_err(|_| credential_error())?", "} else {\n        None\n    };",
    "UPDATE platform_oauth_accounts SET auto_renew=false", ".bind(s.account_id).bind(cipher).bind(next.revision)",
    "sqlx::query(ACCOUNT)", ".fetch_one(&mut *tx)",
    "maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?",
    "status_value(registry, p, Some(&row), &login)",
    "maintenance::commit(tx).await?", "Ok(value)"]);
  count(operation, /\bdecrypt\(&old\)/g, 1);
  count(operation, /\bencrypt\(&token_envelope/g, 1);
  // The separately scoped bugfix adds a final fence; all preceding error order remains.
  count(operation, /guard_login_live\(/g, 1);
  assert.doesNotMatch(operation, /playback_login_allowed|UPDATE platform_oauth_requests|configured\(/);
}
function unlinkFlow(text) {
  const operation = fn(text, "unlink");
  inOrder(operation, ["authenticate(context, &headers, true, false)", "login_hash(&headers)?",
    "expected_revision(&body.expected_revision)?", "maintenance::begin_db(db).await?",
    "guard_login(&mut tx, user.id, &login)", "lock_account(&mut tx, user.id, p).await?", "scope(&account)",
    "revision_matches(expected, s.revision, inserted)", '"platform_account_changed"',
    "UPDATE platform_oauth_accounts SET state='revoked'", ".bind(s.account_id).execute(&mut *tx)",
    "UPDATE platform_oauth_requests SET status='failed'", "WHERE account_id=$1 AND status='pending'",
    "guard_login_live(&mut tx, user.id, &login)", "sqlx::query(ACCOUNT)", ".fetch_one(&mut *tx)",
    "status_value(registry, p, Some(&row), &login)", "maintenance::commit(tx).await?", "Ok(value)"]);
  count(operation, /guard_login_live\(/g, 1);
  assert.doesNotMatch(operation, /configured\(|\bencrypt\b|\bdecrypt\b|playback_login_allowed/);
}
function httpContract(text) {
  const shape = (value) => compact(value).replace(/,\s*\)/g, ")").replace(/\s*([(),])\s*/g, "$1");
  for (const name of operations) {
    const dto = name === "set_renewal" ? "Preference" : "UnlinkCredential";
    const sig = `pub async fn ${name}( State(app): State<App>, Path(raw): Path<String>, headers: HeaderMap, ${name === "status" ? "" : `Json(body): Json<${dto}>, `}) -> Result<Response>`;
    const cipher = name === "set_renewal";
    assert.equal(shape(fn(text, name)), shape(`${sig} {
      ${cipher ? "let key = app.key.as_ref(); let decrypt = |value: &str| crate::decrypt_value(key, value); let encrypt = |value: &Value| crate::encrypt_value(key, value);" : ""}
      let value = account_operations::${name}(app.identity_context(), &app.platform_oauth,
        ${cipher ? "&decrypt, &encrypt," : ""} raw, headers, ${name === "status" ? "" : "body,"}) .await?;
      Ok(responses::private_json(StatusCode::OK, value))
    }`));
  }
}
function restoredOperation(text, name, parent) {
  let restored = body(fn(text, name));
  restored = replaceOnce(restored, "    let db = context.db;\n", "");
  restored = replaceOnce(restored, `request::authenticate(context, &headers, ${name !== "status"}, false)`,
    `auth(&app, &headers, ${name !== "status"})`);
  restored = restored.replaceAll("maintenance::", "super::maintenance::");
  restored = replaceOnce(restored, "super::maintenance::begin_db(db)", "super::maintenance::begin(&app)");
  restored = restored.replaceAll("registry.config(p)", "app.platform_oauth.config(p)");
  restored = replaceOnce(restored, "status_value(registry,", "status_value(&app,");
  if (name === "set_renewal") {
    restored = replaceOnce(restored, "decrypt(&old)", "app.decrypt(&old)");
    restored = replaceOnce(restored,
      "        Some(encrypt(&token_envelope(next, p, &binding, &t)).map_err(|_| credential_error())?)",
      `        Some(
            app.encrypt(&token_envelope(next, p, &binding, &t))
                .map_err(|_| credential_error())?,
        )`);
  }
  restored = replaceOnce(restored, "    Ok(value)", "    Ok(responses::private_json(StatusCode::OK, value))");
  const wrapper = fn(parent, name);
  return `${wrapper.slice(0, wrapper.indexOf("{\n"))}{\n${restored}\n}`;
}
function originalModule(text, parent = http) {
  // First undo the explicitly NON-equivalent login-expiry bugfix. The unchanged
  // historical hash below still proves only the earlier extraction boundary.
  text = undoOAuthDisableFinalLoginGuard(text);
  let restored = replaceOnce(parent, "mod account_operations;\n", "");
  for (const name of operations) restored = replaceOnce(restored, fn(restored, name), restoredOperation(text, name, parent));
  const projection = fn(text, "status_value")
    .replace("registry: &Registry", "app: &App").replaceAll("registry.", "app.platform_oauth.");
  restored = replaceOnce(restored, "fn login_value(", `${projection}\nfn login_value(`);
  assert.equal(hash(restored), "0ec042950f5bca66aa6fd3d12cd29a464c92deb3c40158516d78b922c16c6316",
    "reviewed inverse edits must recover every oauth.rs byte at d5528e4");
}
function originalMaintenance(text) {
  assert.equal(fn(text, "begin"), `pub(super) async fn begin(app: &App) -> Result<Transaction<'_, Postgres>> {\n    begin_db(&app.db).await\n}`);
  let restored = replaceOnce(text, `${fn(text, "begin")}\n`, "");
  restored = replaceOnce(restored, "pub(super) async fn begin_db(db: &sqlx::PgPool)", "pub(super) async fn begin(app: &App)");
  restored = replaceOnce(restored, "Duration::from_secs(5), db.begin()", "Duration::from_secs(5), app.db.begin()");
  assert.equal(hash(restored), "2d34c7239036b8db446658d6c62e603fed9fea4661f235f950ad93cea32fac50",
    "all maintenance budgets, errors, runner, shutdown and drain bytes remain unchanged");
}

test("three operations accept only request context, immutable Registry and renewal-only cipher callbacks", () => capabilities(core));
test("status retains both normalization updates before read, final live fence and bounded commit", () => statusFlow(core));
test("renewal disable retains conflict/enabled/overflow/cipher order before its new final live fence", () => renewalFlow(core));
test("unlink revokes only OAuth account and pending requests before its final live fence and read", () => unlinkFlow(core));
test("HTTP preserves extractors, delegates exactly once, borrows only key, and returns the original private response", () => httpContract(http));
test("explicit behavior-fix inverse then historical boundary inverse recover the original OAuth module", () => originalModule(core));
test("begin_db extraction recovers complete original maintenance module including 5-second budgets", () => originalMaintenance(maintenance));
test("synthetic Rust tests close their lazy pool before operations; no live resources can be opened", () => {
  const tests = all.split("#[cfg(test)]")[1].replace(/^    /gm, "");
  inOrder(fn(tests, "closed_pool"), [".min_connections(0)", ".connect_lazy_with(", "db.close().await", "assert!(db.is_closed())"]);
  count(tests, /let db = closed_pool\(\)\.await;/g, 3);
  assert.doesNotMatch(tests, /std::env|TcpListener|TcpStream|\.connect\(|\.connect_with\(|reqwest|Command::/);
});

const negatives = [
  ["whole App capability", core, capabilities, "context: RequestContext<'_>", "context: App"],
  ["mutable Registry", core, capabilities, "registry: &Registry", "registry: &mut Registry"],
  ["guest admission", core, capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, true, true)"],
  ["write becomes read auth", core, capabilities, "authenticate(context, &headers, true, false)", "authenticate(context, &headers, false, false)"],
  ["provider validation delayed", core, capabilities, "    let p = parse_provider(&raw)?;\n    let user = request::authenticate(context, &headers, false, false).await?;", "    let user = request::authenticate(context, &headers, false, false).await?;\n    let p = parse_provider(&raw)?;"],
  ["cipher callback loses Sync", core, capabilities, "-> anyhow::Result<String> + Sync", "-> anyhow::Result<String>"],
  ["status drops config normalization", core, statusFlow, "config_binding IS DISTINCT FROM $3", "config_binding = $3"],
  ["status wrong config bind", core, statusFlow, ".bind(registry.config(p).map(Config::binding))", ".bind(None::<String>)"],
  ["status drops refresh expiry", core, statusFlow, "refresh_expires_at<=clock_timestamp()", "false"],
  ["status drops final login fence", core, statusFlow, "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;\n", ""],
  ["renewal enables silently", core, renewalFlow, "if body.enabled", "if false"],
  ["renewal bypasses CAS", core, renewalFlow, "revision_matches(expected, s.revision, inserted)", "true"],
  ["renewal ignores revision overflow", core, renewalFlow, "s.revision.checked_add(1)", "s.revision.wrapping_add(1)"],
  ["renewal decrypt error leaks", core, renewalFlow, "decrypt(&old).map_err(|_| credential_error())?", "decrypt(&old)?"],
  ["renewal encrypt error leaks", core, renewalFlow, "encrypt(&token_envelope(next, p, &binding, &t)).map_err(|_| credential_error())?", "encrypt(&token_envelope(next, p, &binding, &t))?"],
  ["renewal binding check removed", core, originalModule, '.get::<Option<String>, _>("config_binding")\n            .ok_or_else(credential_error)?', '.get::<Option<String>, _>("config_binding")\n            .unwrap_or_default()'],
  ["renewal adds an extra early live fence", core, renewalFlow, "    let next = AccountScope {", "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;\n    let next = AccountScope {"],
  ["renewal adds SQL live predicate", core, renewalFlow, 'token_encrypted=$2,revision=$3 WHERE id=$1"', 'token_encrypted=$2,revision=$3 WHERE id=$1 AND playback_login_allowed(user_id,$4)"'],
  ["renewal eagerly encrypts missing token", core, originalModule, "    } else {\n        None\n    };", "    } else {\n        Some(encrypt(&Value::Null).map_err(|_| credential_error())?)\n    };"],
  ["unlink misses pending-request retirement", core, unlinkFlow, "WHERE account_id=$1 AND status='pending'", "WHERE account_id=$1 AND status='complete'"],
  ["unlink drops final live fence", core, unlinkFlow, "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;\n    let row", "    let row"],
  ["private status gains secret", core, originalModule, '"playback_session":false', '"playback_session":false,"token":"synthetic-secret"'],
  ["transaction commit failure ignored", core, originalModule, "    maintenance::commit(tx).await?;", "    let _ = maintenance::commit(tx).await;"],
  ["HTTP eagerly encrypts", http, httpContract, "    let key = app.key.as_ref();", "    let _ = app.encrypt(&Value::Null);\n    let key = app.key.as_ref();"],
  ["HTTP captures App", http, httpContract, "crate::encrypt_value(key, value)", "app.encrypt(value)"],
  ["HTTP performs business validation", http, httpContract, "    let value =\n        account_operations::status(", "    let _ = parse_provider(&raw)?;\n    let value =\n        account_operations::status("],
  ["HTTP changes private response", http, httpContract, "Ok(responses::private_json(StatusCode::OK, value))", "Ok(responses::ok_json(value))"],
  ["maintenance changes timeout", maintenance, originalMaintenance, "Duration::from_secs(5), db.begin()", "Duration::from_secs(6), db.begin()"],
  ["maintenance changes phase error", maintenance, originalMaintenance, '"platform_renewal_database_phase_unknown"', '"database_error"'],
  ["maintenance drops lock timeout", maintenance, originalMaintenance, '    phase(sqlx::query("SET LOCAL lock_timeout=\'5s\'").execute(&mut *tx)).await?;\n', ""],
];
for (const [name, text, check, from, to] of negatives) {
  test(`negative control rejects: ${name}`, () => {
    check(text);
    assert.ok(text.includes(from), "mutation must touch current production source");
    const changed = text.replace(from, to);
    assert.notEqual(changed, text);
    assert.throws(() => check(changed), { code: "ERR_ASSERTION" });
  });
}
