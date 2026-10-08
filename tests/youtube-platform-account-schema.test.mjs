// Source/schema contract checks only: no DB, live credential or account request.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
test("0054 changes only account/source provider allowlists, preserving every authority fence", async () => {
  const previous = await read("migrations/0053_short_platform_accounts.sql"),
    next = await read("migrations/0054_youtube_platform_accounts.sql");
  const expected = previous
    .slice(
      previous.indexOf(
        "CREATE OR REPLACE FUNCTION native_platform_source_allowed",
      ),
    )
    .replace(
      "IN ('bilibili','douyin','tiktok')",
      "IN ('bilibili','douyin','tiktok','youtube')",
    );
  assert.equal(
    next.slice(
      next.indexOf("CREATE OR REPLACE FUNCTION native_platform_source_allowed"),
    ),
    expected,
  );
  assert.match(
    next,
    /CHECK\(provider IN \('bilibili','douyin','tiktok','youtube'\)\)/,
  );
  assert.doesNotMatch(
    next,
    /(?:DELETE FROM|UPDATE) platform_accounts|ALTER TABLE platform_login_requests/,
  );
});
test("YouTube has bounded dedicated routes independent of short providers", async () => {
  const source = await read("apps/server/src/bootstrap/routes.rs");
  assert.match(
    source,
    /"\/api\/v1\/platform-accounts\/youtube"[\s\S]*?youtube_status[\s\S]*?unlink_youtube[\s\S]*?max\(1024\)/,
  );
  assert.match(
    source,
    /"\/api\/v1\/platform-accounts\/youtube\/credential"[\s\S]*?import_youtube_credential[\s\S]*?max\(64 \* 1024\)/,
  );
  assert.match(
    source,
    /"\/api\/v1\/platform-accounts\/bilibili\/check"[\s\S]*?check_login[\s\S]*?max\(1024\)/,
  );
});
