import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = readFileSync(new URL("./room-kick-authority-native.mjs", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("../apps/server/src/http_file_fallback.rs", import.meta.url), "utf8");

test("row-only local kick seed retains the established no-upstream publication marker", () => {
  const production = wrapper.slice(wrapper.indexOf("pub fn wrap_resource("), wrapper.indexOf("pub async fn seed("));
  assert.ok(production.includes('Some("local" | "agent" | "http")'));
  assert.ok(production.includes('resource.get("upstream_base").is_none()'));
  assert.ok(production.includes('outer["upstream_closed"] = json!(true);'));
  assert.ok(fixture.includes("sourceMedia(f,{kind:'local'"));
  const seedMatch = fixture.match(/,'(\{"upstream_closed":true\})',clock_timestamp\(\)/);
  assert.ok(seedMatch, "The SQL insert must carry the marker before any snapshot or wait");
  const checkSeed = (kind, seed) => {
    assert.equal(kind, "local");
    assert.deepEqual(seed, { upstream_closed: true });
  };
  checkSeed("local", JSON.parse(seedMatch[1]));
  for (const seed of [{}, { upstream_closed: false }, { upstream_closed: null },
    { upstream_closed: true, upstream_base: null }])
    assert.throws(() => checkSeed("local", seed), assert.AssertionError);
  assert.throws(() => checkSeed("jellyfin", { upstream_closed: true }), assert.AssertionError);
});

test("actual rollback assertion still rejects every selected resource or membership mutation", () => {
  assert.match(fixture, /'playback_sessions',[\s\S]*?jsonb_agg\(to_jsonb\(p\)/);
  const expression = fixture.match(/assert\.equal\(after\.raw,before\.raw,'All complete selected[^']+'\);/);
  assert.ok(expression);
  const verify = new Function("assert", "before", "after", expression[0]);
  const before = { playback_sessions: [{ id: "p", stopped: false, resource: { upstream_closed: true } }],
    members: [{ user_id: "target" }] };
  const raw = JSON.stringify(before);
  verify(assert, { raw }, { raw });
  for (const mutate of [
    (v) => { v.playback_sessions[0].resource.upstream_io_uncertain = true; },
    (v) => { v.playback_sessions[0].resource.upstream_last_report_at = "2040-01-01T00:00:00Z"; },
    (v) => { delete v.playback_sessions[0].resource.upstream_closed; },
    (v) => { v.playback_sessions[0].stopped = true; },
    (v) => { v.members = []; },
  ]) {
    const after = structuredClone(before); mutate(after);
    assert.throws(() => verify(assert, { raw }, { raw: JSON.stringify(after) }), assert.AssertionError);
  }
});

test("actual successful kick comparison permits only its original complete row effects", () => {
  const start = fixture.indexOf("  function successfulRows(");
  const end = fixture.indexOf("  // Two groups retain", start);
  assert.ok(start >= 0 && end > start);
  const { successfulRows, assertKickEffects } = new Function("assert",
    fixture.slice(start, end) + "\nreturn { successfulRows, assertKickEffects };")(assert);
  const subject = { target: { id: "target" }, actor: { id: "owner" }, epoch: "e", playback: "p" };
  const before = { users: [{ id: "owner", admin: true }], epochs: [{ id: "e", user_id: "target" }],
    members: [{ user_id: "target" }], grants: [{ user_id: "target" }],
    playback_sessions: [{ id: "p", user_id: "target", stopped: false, resource: { upstream_closed: true } }] };
  const after = successfulRows(before, subject);
  assertKickEffects(before, after, subject);
  after.playback_sessions[0].resource.arbitrary_new_field = true;
  assert.throws(() => assertKickEffects(before, after, subject), assert.AssertionError);
});
