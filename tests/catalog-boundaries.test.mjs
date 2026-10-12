// Architectural boundary tests supplement the owned behavioral catalog gates.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
const root = resolve(import.meta.dirname, "..");
const source = (path) => readFileSync(resolve(root, "apps/server/src", path), "utf8");
const catalog = readdirSync(resolve(root, "apps/server/src/catalog")).filter((path) => path.endsWith(".rs"));
// This is an architectural heuristic, not a complete Rust key-access proof.
// Cursor.key is ordinary pagination data; application cipher fields are not.
const forbiddenCapability = /reqwest\s*::\s*Client|Aes256Gcm|\b(?:app|context|ctx)\s*\.\s*key\b/;

test("catalog operations do not receive the application or construct HTTP extractors", () => {
  for (const path of catalog) {
    const text = source(`catalog/${path}`);
    assert.doesNotMatch(text, /\bApp\b|State\(|Path\(|Json\(/, path);
    assert.doesNotMatch(text, forbiddenCapability, path);
  }
});
test("capability heuristic distinguishes pagination keys from application cipher access", () => {
  for (const text of ["value.key", "cursor . key", "value\n.\nkey"]) assert.doesNotMatch(text, forbiddenCapability);
  for (const text of ["app.key", "app . key", "context\n.\nkey", "ctx . key", "reqwest::Client", "reqwest :: Client", "Aes256Gcm"]) assert.match(text, forbiddenCapability);
});
test("configuration callbacks expose only the original bounded capabilities", () => {
  const text = source("catalog/mod.rs");
  for (const [name, expected] of [
    ["SourceReadContext", ["db", "decrypt"]],
    ["SourceWriteContext", ["db", "encrypt"]],
    ["SourceChangeContext", ["db", "encrypt", "decrypt"]],
  ]) {
    const body = text.match(new RegExp(`struct ${name}<'a>\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(body, name);
    const fields = [...body.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:/gm)].map((match) => match[1]);
    assert.deepEqual(fields, expected, name);
    assert.match(body, /pub db:\s*&'a PgPool/);
    if (expected.includes("encrypt")) assert.match(body, /pub encrypt:\s*&'a \(dyn Fn\(&Value\) -> anyhow::Result<String> \+ Sync\)/);
    if (expected.includes("decrypt")) assert.match(body, /pub decrypt:\s*&'a \(dyn Fn\(&str\) -> anyhow::Result<Value> \+ Sync\)/);
  }
  assert.match(text, /Fn\(&str\) -> anyhow::Result<Value> \+ Sync/);
  assert.match(text, /Fn\(&Value\) -> anyhow::Result<String> \+ Sync/);
  assert.doesNotMatch(text, /preparations|native_delivery|room_members|sessions|OnceLock|LazyLock/);
});
test("HTTP source adapters keep their protocol and delegate once", () => {
  assert.match(source("media.rs"), /catalog::sources::add\(context, body\)\.await\?/);
  assert.match(source("source_settings.rs"), /catalog::source_settings::change\(context, &user, &h, id, body\)\.await\?/);
  assert.match(source("source_access.rs"), /catalog::access_policy::change\(context, &user, &headers, id, body\)\.await\?/);
  assert.doesNotMatch(source("catalog/source_settings.rs"), /identity::admin/);
});
