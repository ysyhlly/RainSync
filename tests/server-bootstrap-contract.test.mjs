// Focused seam guards. These complement, and do not replace, the real HTTP/DB
// admission and owned-process shutdown fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path) => readFileSync(new URL(`../apps/server/src/${path}.rs`, import.meta.url), "utf8");
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const until = text.indexOf(end, from + start.length);
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

test("offline probes remain before application configuration or runtime startup", () => {
  const bootstrap = source("bootstrap/mod");
  inOrder(bootstrap, [
    'Some("init-admin")',
    'Some("--source-access-contract")',
    "providers::source_access_contract::SERVER",
    'Some("--media-authorization-contract")',
    "media-login-binding-v1",
    "tracing_subscriber::fmt()",
    'thread_name("media-owner")',
    "set_owner_runtime(owners.handle().clone())",
    "application.block_on",
    "DatabaseSettings::from_env()",
  ]);
  assert.equal((bootstrap.match(/std::env::args\(\)\.len\(\) == 2/g) ?? []).length, 2);
  assert.match(source("main"), /fn main\(\) -> anyhow::Result<\(\)> \{\s*bootstrap::main\(\)\s*\}/);
});

test("owner runtime outlives application teardown after instance-lock loss", () => {
  const bootstrap = source("bootstrap/mod");
  inOrder(bootstrap, [
    "let owners =",
    "let application =",
    "biased;",
    'anyhow::bail!("server instance lock connection lost")',
    "result = run(lost) => result",
    "drop(application)",
    "owners.block_on(media_core::child_process::shutdown())?",
  ]);
  const monitor = section(bootstrap, "if media_authority {\n        let mut lock", "let probe_db");
  inOrder(monitor, ["pg_try_advisory_lock(72614931)", "lock_readiness.accepting(false)", "lost.send(())", "std::future::pending::<()>().await"]);
});

test("shutdown closes admission and joins each original owner before returning", () => {
  const lifecycle = source("bootstrap/lifecycle");
  const signal = section(lifecycle, "signal = media_core::process_signal::wait()", "let (\n");
  for (const owner of ["upstream", "live_playback", "other_live_playback", "native_transcode_delivery", "native_delivery_owners"]) {
    assert.equal((signal.match(new RegExp(`\\b${owner}\\.close_admission\\(\\)`, "g")) ?? []).length, 2);
    inOrder(lifecycle, [`${owner}.close_admission()`, `${owner}.drain()`]);
  }
  inOrder(lifecycle, ["preparations.close()", "stop.send(())", "preparations.drain()", "media_core::child_process::shutdown().await?", "upstream_result?", "server_result?"]);
  for (const drain of ["static_hls_operation_client::drain()", "renewal.drain().await", "platform_oauth_exchanges.drain()"])
    assert.ok(lifecycle.includes(drain), drain);
  assert.doesNotMatch(lifecycle, /\.abort\(/);
});

test("router preserves shared middleware and per-route body limits", () => {
  const routes = source("bootstrap/routes");
  inOrder(routes, [
    '"/api/v1/platform-accounts/youtube/credential"',
    "DefaultBodyLimit::max(64 * 1024)",
    '"/api/v1/agents/drain-ws"',
    "DefaultBodyLimit::max(65536)",
    '"/ready"',
    "control_cluster::middleware",
    "http_api::errors",
    ".with_state(app)",
  ]);
});

test("request context remains narrow and never represents transaction admission", () => {
  const identity = source("identity/mod");
  const context = section(identity, "pub(crate) struct RequestContext", "#[derive(Clone, Copy, Debug)]");
  assert.match(context, /pub db: &'a sqlx::PgPool/);
  assert.match(context, /pub origin: &'a str/);
  assert.doesNotMatch(context, /\bApp\b|\bTransaction\b|\bArc\b/);
  const request = source("identity/request");
  assert.doesNotMatch(request, /\bApp\b/);
  inOrder(request, ["cookie(h).ok_or_else", "expires_at>clock_timestamp()", "playback_login_allowed(u.id,s.token_hash)", "Failure::GuestRestricted", "origin(context.origin, h)?", 'h.get("x-csrf-token")']);
});

test("admin admission owns its transaction and rechecks natural expiry at commit", () => {
  const admin = source("identity/admin");
  const scope = section(admin, "pub(crate) struct AdminTransaction", "// Compatibility operations");
  assert.match(scope, /tx: Transaction<'static, Postgres>/);
  assert.match(scope, /pub\(crate\) async fn commit\(self\)/);
  assert.doesNotMatch(scope, /impl Clone|derive\(Clone|Arc<|OnceLock|LazyLock/);
  const locks = section(admin, "pub(crate) async fn lock_admin(", "pub(crate) async fn finish(");
  inOrder(locks, ["SELECT admin FROM users WHERE id=$1 AND account_active(id) FOR SHARE", "media_authorization::login_hash(headers)?", "SELECT csrf FROM sessions", "expires_at>clock_timestamp() FOR SHARE", 'headers.get("x-csrf-token")']);
  const finish = admin.slice(admin.indexOf("pub(crate) async fn finish("));
  inOrder(finish, ["s.token_hash=$1 AND s.user_id=$2", "s.expires_at>clock_timestamp()", "u.admin AND account_active(u.id)", "Failure::SessionExpired", "tx.commit().await?"]);
  assert.doesNotMatch(source("media_authorization"), /identity::admin/);
  assert.doesNotMatch(source("source_settings"), /identity::admin/);
});

test("mutable administrator settings retain live reads, CAS and final transaction fence", () => {
  const settings = source("admin_settings");
  const change = section(settings, "pub async fn change(", "/// Public access-policy discovery");
  inOrder(change, ["AdminTransaction::begin", "FOR UPDATE", 'row.try_get::<i64, _>("revision")? != expected', "WHERE singleton AND revision=$9", "changed != 1", "admission.commit().await?"]);
  assert.match(settings, /identity::admin::lock_admin\(tx, user.id, headers, write\)/);
  assert.match(settings, /identity::admin::finish\(tx, user.id, login\)/);
  assert.doesNotMatch(source("bootstrap/config"), /SELECT|expected_revision|registration_mode/);
});
