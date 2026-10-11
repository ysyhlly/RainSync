// Source proof and in-memory mutations only. This is not the ignored PostgreSQL
// regression and does not establish real lock waits, rollback or COMMIT outcomes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rustFunction as fn, replaceOnce } from "./fixtures/bilibili-login-source-inverse.mjs";
import { oauthDisableFinalLoginGuard as added, undoOAuthDisableFinalLoginGuard as undo } from "./fixtures/oauth-disable-login-guard-inverse.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const all = read("apps/server/src/platform_accounts/oauth/account_operations.rs");
const core = all.split("#[cfg(test)]")[0];
const authority = read("apps/server/src/platform_accounts.rs").split("#[cfg(test)]")[0];
const digest = text => createHash("sha256").update(text).digest("hex");
const guard = "    maintenance::phase(guard_login_live(&mut tx, user.id, &login)).await?;\n";
const beforeOperation = "fe29da4207e8a2e78b7e2d470009b9346ebc5a28e2f9f9488cae298605a3837d";
const afterOperation = "ab7dc938e1a459ce5796b2746fd05484cdda31b2a845396b926e6c75614036fb";

function contract(source) {
  const production = source.split("#[cfg(test)]")[0];
  const operation = fn(production, "set_renewal");
  // This is the separately reviewed post-fix witness. It is NOT a refresh of
  // any historical extraction hash. Every operation byte/order is covered.
  assert.equal(digest(operation), afterOperation, "complete reviewed disable operation after the intentional fix");
  const restored = undo(production);
  assert.equal(digest(fn(restored, "set_renewal")), beforeOperation,
    "removing just the declared new fence restores the immediate pre-fix operation");
  assert.equal(digest(restored), "b1adc158be3998a9a6cac3e0451862a29cc1b64aaecac5c801937309341185da",
    "all other production operations, imports, SQL, binds, envelope, projection and errors remain byte-identical to 29a3f69");
}
function changedOperation(from, to) {
  const operation = fn(core, "set_renewal");
  return replaceOnce(core, operation, replaceOnce(operation, from, to));
}
function moveGuardBefore(marker) {
  const operation = fn(core, "set_renewal");
  const without = replaceOnce(operation, added, "");
  return replaceOnce(core, operation, replaceOnce(without, marker, `${added}${marker}`));
}

test("intentional expiry fix is exactly one bounded final exact-login check; previous operation remains a separate witness", () => contract(core));
test("pre-fix code is rejected by the forward contract, rather than reported equivalent", () => {
  assert.throws(() => contract(undo(core)), assert.AssertionError);
});
test("authority helper rechecks exact user/hash through the existing clock-based login predicate without more locks", () => {
  assert.equal(fn(authority, "guard_login_live"), `async fn guard_login_live(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    login: &str,
) -> Result<()> {
    let live: bool = sqlx::query_scalar("SELECT playback_login_allowed($1,$2)")
        .bind(user)
        .bind(login)
        .fetch_one(&mut **tx)
        .await?;
    if !live {
        return Err(err(StatusCode::UNAUTHORIZED, "session_expired"));
    }
    Ok(())
}`);
  const sql = read("migrations/0041_media_login_binding.sql");
  assert.match(sql, /CREATE FUNCTION playback_login_allowed\(principal uuid, login text\)\nRETURNS boolean LANGUAGE sql VOLATILE AS \$\$\n    SELECT \$2 ~ '\^\[0-9a-f\]\{64\}\$' AND EXISTS\(SELECT 1 FROM sessions\n        WHERE token_hash=\$2 AND user_id=\$1 AND expires_at>clock_timestamp\(\)\)/);
  const guests = read("migrations/0088_scoped_guests.sql");
  assert.match(guests, /SELECT playback_login_allowed_before_guests\(\$1,\$2\) AND/);
});

const mutations = [
  ["missing final check", () => changedOperation(added, "")],
  ["wrong principal", () => changedOperation(guard, guard.replace("user.id", "Uuid::nil()"))],
  ["substituted login", () => changedOperation(guard, guard.replace("&login", '"other-login"'))],
  ["account consent login substituted", () => changedOperation(guard, guard.replace("&login", '&account.get::<String, _>("consent_login_hash")'))],
  ["fresh lock instead of lock-free recheck", () => changedOperation(guard, guard.replace("guard_login_live", "guard_login"))],
  ["phase budget removed", () => changedOperation(guard, "    guard_login_live(&mut tx, user.id, &login).await?;\n")],
  ["new budget introduced", () => changedOperation(guard, "    tokio::time::timeout(Duration::from_secs(50), guard_login_live(&mut tx, user.id, &login)).await??;\n")],
  ["expiry error ignored", () => changedOperation(guard, guard.replace("maintenance::phase", "let _ = maintenance::phase").replace(".await?;", ".await;"))],
  ["fence future not awaited", () => changedOperation(guard, guard.replace(".await?;", ";"))],
  ["fence conditional on enabled", () => changedOperation(guard, `    if body.enabled {\n${guard}    }\n`)],
  ["duplicate live check", () => changedOperation(guard, `${guard}${guard}`)],
  ["fence only before account wait", () => moveGuardBefore("    let (account, inserted) = lock_account")],
  ["fence before original conflict precedence", () => moveGuardBefore("    if !revision_matches")],
  ["fence before original enabled precedence", () => moveGuardBefore("    if body.enabled")],
  ["fence before overflow and token work", () => moveGuardBefore("    let next = AccountScope {")],
  ["fence only before update", () => moveGuardBefore('    maintenance::phase(sqlx::query("UPDATE platform_oauth_accounts SET auto_renew=false')],
  ["fence only before final read", () => moveGuardBefore("    let row = maintenance::phase(")],
  ["fence after commit", () => {
    const operation = replaceOnce(fn(core, "set_renewal"), added, "");
    return replaceOnce(core, fn(core, "set_renewal"), replaceOnce(operation,
      "    maintenance::commit(tx).await?;\n", `    maintenance::commit(tx).await?;\n${added}`));
  }],
  ["test-only fence text", () => `${changedOperation(added, "")}\n#[cfg(test)]\nmod tests {\n${added}}`],
  ["unrelated-function fence text", () => `${changedOperation(added, "")}\nasync fn unrelated() {\n${added}}`],
  ["commented-out fence", () => changedOperation(guard, `    // ${guard.trim()}\n`)],
  ["existing SQL bind modified", () => changedOperation(".bind(s.account_id).bind(cipher).bind(next.revision)", ".bind(s.account_id).bind(cipher).bind(s.revision)")],
  ["revision check bypassed", () => changedOperation("revision_matches(expected, s.revision, inserted)", "true")],
  ["token envelope stays on old revision", () => changedOperation("token_envelope(next, p, &binding, &t)", "token_envelope(s, p, &binding, &t)")],
  ["provider request added", () => changedOperation("    let next = AccountScope {", "    registry.send().await?;\n    let next = AccountScope {")],
  ["bounded commit failure swallowed", () => changedOperation("maintenance::commit(tx).await?;", "let _ = maintenance::commit(tx).await;")],
];
for (const [name, mutate] of mutations) {
  test(`negative control rejects ${name}`, () => {
    contract(core);
    const changed = mutate();
    assert.notEqual(changed, core);
    assert.throws(() => contract(changed), assert.AssertionError);
  });
}

const dbFixture = read("apps/server/src/platform_accounts/oauth/account_operations/disable_login_db_tests.rs");
function isolatedDbFixture(source) {
  const database = fn(source, "database");
  const marker = database.indexOf('std::env::var("RAINSYNC_OAUTH_GUARD_DB_TEST")');
  const connect = database.indexOf(".connect_with(");
  assert.ok(marker >= 0 && marker < connect, "authorization marker precedes all sockets");
  assert.match(database, /std::env::var\("RAINSYNC_OAUTH_GUARD_DATABASE_URL"\)/);
  assert.doesNotMatch(database, /std::env::var\("DATABASE_URL"\)/);
  assert.match(database, /\.strip_prefix\("rainsync_oauth_guard_test_"\)/);
  assert.match(database, /owned\.is_some\(\)/);
  assert.match(database, /\("search_path", "public"\)/);
  assert.match(database, /\("statement_timeout", "5000"\)/);
  assert.equal((source.match(/#\[tokio::test\]/g) ?? []).length, 1);
  assert.equal((source.match(/#\[ignore = /g) ?? []).length, 1);
  assert.doesNotMatch(source, /\.ignore\(|migrate!|\.run\(|Command::|reqwest|Transport|App::|Maintenance::|refresh_due|load_for_playback/);
  assert.match(source, /set_renewal\(/);
  assert.match(source, /Registry::disabled\(\)/);
  assert.match(source, /pg_blocking_pids\(pid\)/);
  assert.match(source, /s.expires_at>clock_timestamp\(\)/);
  assert.match(source, /still_waiting\(&row\),/);
  assert.match(source, /row.get::<String, _>\("deadline"\) == deadline/);
  assert.match(source, /WaitAt::Account, WaitAt::Update/);
  assert.match(source, /Provider::Douyin, Provider::TikTok/);
  assert.match(source, /after == before/);
  assert.match(source, /sibling_live/);
}
test("separate real-DB fixture is ignored, explicit-opt-in, isolated and never routed through broad native/provider owners", () => isolatedDbFixture(dbFixture));
for (const [name, from, to] of [
  ["ordinary test execution", '#[ignore = "requires separate authorization and a disposable PostgreSQL database; never part of pure/native owner gates"]', ""],
  ["ambient database URL", 'std::env::var("RAINSYNC_OAUTH_GUARD_DATABASE_URL")', 'std::env::var("DATABASE_URL")'],
  ["lost database identity check", "owned.is_some()", "true"],
  ["rollback assertion removed", "after == before", "true"],
  ["wait observation removed", "pg_blocking_pids(pid)", "ARRAY[]::int[]"],
]) {
  test(`DB fixture source negative rejects ${name}`, () => {
    isolatedDbFixture(dbFixture);
    const changed = dbFixture.replace(from, to);
    assert.notEqual(changed, dbFixture);
    assert.throws(() => isolatedDbFixture(changed), assert.AssertionError);
  });
}
