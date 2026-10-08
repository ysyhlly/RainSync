// Focused source/schema regression only. No database, migration execution,
// listener, real credential, login, QR, platform request or acceptance claim.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

test("0053 expands account providers while retaining Bilibili-only QR schema", async () => {
  const migration = await read("migrations/0053_short_platform_accounts.sql");
  assert.match(migration, /platform_accounts_provider_check[\s\S]+CHECK\(provider IN \('bilibili','douyin','tiktok'\)\)/);
  assert.doesNotMatch(migration, /ALTER TABLE platform_login_requests/);
  assert.doesNotMatch(migration, /(?:DELETE FROM|UPDATE) platform_accounts/);
  const original = await read("migrations/0051_native_platform.sql");
  assert.match(original, /provider text NOT NULL CHECK\(provider='bilibili'\)/);
});

test("0053 source authority matches exact user/provider/account/revision and liveness", async () => {
  const migration = await read("migrations/0053_short_platform_accounts.sql");
  assert.match(migration, /WHEN 'own_account' THEN [^\n]+ IN \('bilibili','douyin','tiktok'\)/);
  for (const bound of ["a.id::text=$2->'native_platform_context'->>'account_id'",
    "a.user_id::text=$2->'native_platform_context'->>'user_id'",
    "a.provider=$2->'native_platform_context'->>'provider'",
    "a.revision::text=$2->'native_platform_context'->>'account_revision'",
    "a.state='connected' AND a.credential_encrypted IS NOT NULL",
    "a.credential_expires_at>clock_timestamp()", "playback_http_file_context_allowed", "=9"]) {
    assert.ok(migration.includes(bound), `retains ${bound}`);
  }
  // The only change to the mature native source predicate is its own-account
  // provider allowlist, preserving room, viewer/login and closed-envelope gates.
  const previous = await read("migrations/0052_native_platform_vod.sql");
  const functionBody = previous.slice(previous.indexOf("CREATE OR REPLACE FUNCTION native_platform_source_allowed"))
    .replace("WHEN 'own_account' THEN $2->'native_platform_context'->>'provider'='bilibili' AND EXISTS",
      "WHEN 'own_account' THEN $2->'native_platform_context'->>'provider' IN ('bilibili','douyin','tiktok') AND EXISTS");
  assert.equal(migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION native_platform_source_allowed")), functionBody);
});

test("short account routes use bounded JSON and retain existing Bilibili routes", async () => {
  const main = await read("apps/server/src/bootstrap/routes.rs");
  assert.match(main, /"\/api\/v1\/platform-accounts\/\{provider\}"[\s\S]*?short_status[\s\S]*?unlink_short[\s\S]*?max\(1024\)/);
  assert.match(main, /"\/api\/v1\/platform-accounts\/\{provider\}\/credential"[\s\S]*?import_short_credential[\s\S]*?max\(16 \* 1024\)/);
  assert.match(main, /"\/api\/v1\/platform-accounts\/bilibili"[\s\S]*?platform_accounts::status[\s\S]*?platform_accounts::unlink/);
});
