// Source contracts for composition-root capability factories. These checks do
// not replace Rust compilation or the pure cipher roundtrip/error tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../apps/server/src/main.rs", import.meta.url), "utf8");
// Preserve string contents while disregarding formatting/comments in these
// selected functions. This is a source heuristic, not a general Rust parser.
const tokens = (text) => [...text.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|\s+|./g)]
  .map(([value]) => value).filter((value) => !/^\s+$|^\/\/|^\/\*/.test(value));
function declaration(text, name) {
  const all = tokens(text), starts = [];
  for (let i = 0; i < all.length - 2; i++)
    if (all[i] === "fn" && all[i + 1] === name && all[i + 2] === "(") starts.push(i);
  assert.equal(starts.length, 1, `${name} has one definition`);
  const start = starts[0], body = all.indexOf("{", start);
  assert.ok(body > start);
  let end = body + 1, depth = 1;
  while (depth && end < all.length) {
    if (all[end] === "{") depth++;
    if (all[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  return all.slice(start, end);
}
function factories(text) {
  for (const [name, input, output, primitive] of [
    ["catalog_encryptor", "&Value", "String", "encrypt_value"],
    ["catalog_decryptor", "&str", "Value", "decrypt_value"],
  ]) assert.deepEqual(declaration(text, name), tokens(`
    fn ${name}(&self) -> impl Fn(${input}) -> anyhow::Result<${output}> + Sync + '_ {
      let key = self.key.as_ref();
      move |value| ${primitive}(key, value)
    }
  `), `${name}: borrow only key; no eager crypto or App capture`);
}
function decryption(text) {
  assert.deepEqual(declaration(text, "decrypt"), tokens(`
    fn decrypt(&self, value: &str) -> anyhow::Result<Value> { decrypt_value(&self.key, value) }
  `));
  assert.deepEqual(declaration(text, "decrypt_value"), tokens(`
    fn decrypt_value(key: &Aes256Gcm, value: &str) -> anyhow::Result<Value> {
      let bytes = STANDARD.decode(value)?;
      if bytes.len() < 12 { anyhow::bail!("invalid_ciphertext") }
      let data = key.decrypt(bytes[..12].into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("decryption_failed"))?;
      Ok(serde_json::from_slice(&data)?)
    }
  `));
}
test("catalog cipher factories retain only borrowed callable cipher capabilities", () => factories(source));
test("shared decryption preserves the original framing and ordered failure stages", () => decryption(source));
for (const [name, old, replacement, check] of [
  ["App capture", "move |value| decrypt_value(key, value)", "move |value| self.decrypt(value)", factories],
  ["eager encryption", "move |value| encrypt_value(key, value)", "let _ = encrypt_value(key, &Value::Null); move |value| encrypt_value(key, value)", factories],
  ["removed Sync", "impl Fn(&Value) -> anyhow::Result<String> + Sync + '_", "impl Fn(&Value) -> anyhow::Result<String> + '_", factories],
  ["static lifetime", "impl Fn(&str) -> anyhow::Result<Value> + Sync + '_", "impl Fn(&str) -> anyhow::Result<Value> + Sync + 'static", factories],
  ["base64 variant", "let bytes = STANDARD.decode(value)?;", "let bytes = URL_SAFE.decode(value)?;", decryption],
  ["length boundary", "if bytes.len() < 12 {", "if bytes.len() < 13 {", decryption],
  ["nonce split", ".decrypt(bytes[..12].into(), &bytes[12..])", ".decrypt(bytes[..16].into(), &bytes[16..])", decryption],
  ["error remapping", 'anyhow::anyhow!("decryption_failed")', 'anyhow::anyhow!("invalid_ciphertext")', decryption],
  ["AAD introduction", ".decrypt(bytes[..12].into(), &bytes[12..])", '.decrypt(bytes[..12].into(), Payload { msg: &bytes[12..], aad: b"catalog" })', decryption],
  ["JSON conversion", "Ok(serde_json::from_slice(&data)?)", "Ok(serde_json::from_str(&data)?)", decryption],
]) test(`cipher source contract rejects ${name} mutation`, () => {
  assert.equal(source.split(old).length - 1, 1, "unique mutation target");
  assert.throws(() => check(source.replace(old, replacement)), assert.AssertionError);
});
