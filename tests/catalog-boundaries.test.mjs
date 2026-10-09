// Architectural boundary tests supplement the owned behavioral catalog gates.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
const root = resolve(import.meta.dirname, "..");
const source = (path) => readFileSync(resolve(root, "apps/server/src", path), "utf8");
const catalog = readdirSync(resolve(root, "apps/server/src/catalog")).filter((path) => path.endsWith(".rs"));

test("catalog operations do not receive the application or construct HTTP extractors", () => {
  for (const path of catalog) {
    const text = source(`catalog/${path}`);
    assert.doesNotMatch(text, /\bApp\b|State\(|Path\(|Json\(/, path);
    assert.doesNotMatch(text, /reqwest::Client|Aes256Gcm|\.key\b/, path);
  }
});
test("configuration callbacks expose only the original bounded capabilities", () => {
  const text = source("catalog/mod.rs");
  for (const name of ["SourceReadContext", "SourceWriteContext", "SourceChangeContext"]) assert.ok(text.includes(`struct ${name}<'a>`), name);
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
