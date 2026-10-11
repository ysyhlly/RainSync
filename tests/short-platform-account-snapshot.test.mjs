// Pure negative controls only: no fixture imports, database, server or socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  parseAccountSnapshot, assertImportRateIncrement, databaseTimestampMicros,
} from "./fixtures/short-platform-account-snapshot.mjs";

const user = "00000000-0000-0000-0000-000000000001";
const key = createHash("sha256")
  .update(`account-rate:platform-cookie-import:${user}`).digest("hex");
const max = 9223372036854775807n;
const databaseClocks = {
  before: "2026-10-10T00:00:00.123455Z",
  after: "2026-10-10T00:00:00.123458Z",
};
const rate = (attempts = 1n) => ({
  scope: "platform-cookie-import", key_hash: key, attempts,
  window_started: "2026-10-10T00:00:00.123456+00:00",
  expires_at: "2026-10-10T00:10:00.123457+00:00",
});
const snapshot = () => ({
  users: [{ id: user, admin: false }],
  sessions: [{ user_id: user, token_hash: "synthetic", expires_at: "same" }],
  user_profiles: [{ user_id: user, display_name: "Synthetic profile" }],
  platform_accounts: [{ id: "account", user_id: user, provider: "douyin", revision: max }],
  platform_login_requests: [{ id: "request", user_id: user, account_revision: max }],
  account_rate_limits: [rate(), { ...rate(2n), scope: "other", key_hash: "other" }],
});
// JSON.rawJSON emits the full integer token without converting through Number.
const wire = (value) => JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? JSON.rawJSON(item.toString()) : item);
const incremented = (before) => {
  const after = structuredClone(before);
  after.account_rate_limits.find((row) => row.key_hash === key).attempts++;
  return after;
};

test("preserves all selected bigint columns and distinguishes MAX from MAX-1", () => {
  const before = snapshot(), after = structuredClone(before);
  const decoded = parseAccountSnapshot(wire(before));
  for (const [table, field] of [["platform_accounts", "revision"],
    ["platform_login_requests", "account_revision"]]) {
    assert.equal(decoded[table][0][field], max);
    after[table][0][field] = max - 1n;
    assert.notEqual(parseAccountSnapshot(wire(after))[table][0][field], decoded[table][0][field]);
  }
  assert.notDeepEqual(parseAccountSnapshot(wire(after)), decoded);
  assert.equal(JSON.parse(wire(before)).platform_accounts[0].revision,
    JSON.parse(wire(after)).platform_accounts[0].revision,
    "Negative control must reproduce the original rounding blind spot");
});

test("accepts exactly one committed increment, irrespective of rate row order", () => {
  const before = snapshot(), after = incremented(before);
  after.account_rate_limits.reverse();
  assertImportRateIncrement(wire(before), wire(after), user);
});

for (const [name, mutate] of [
  ["user field", (s) => { s.users[0].admin = true; }],
  ["session field", (s) => { s.sessions[0].expires_at = "changed"; }],
  ["profile field", (s) => { s.user_profiles[0].display_name = "changed"; }],
  ["account bigint MAX-1", (s) => { s.platform_accounts[0].revision--; }],
  ["request bigint", (s) => { s.platform_login_requests[0].account_revision--; }],
  ["bigint replaced by string", (s) => { s.platform_accounts[0].revision = max.toString(); }],
  ["account extra field", (s) => { s.platform_accounts[0].unexpected = true; }],
  ["account row removed", (s) => { s.platform_accounts = []; }],
  ["account row added", (s) => { s.platform_accounts.push({ id: "extra" }); }],
  ["target rate window", (s) => { s.account_rate_limits[0].window_started = "changed"; }],
  ["target rate expiry", (s) => { s.account_rate_limits[0].expires_at = "changed"; }],
  ["target rate key", (s) => { s.account_rate_limits[0].key_hash = "changed"; }],
  ["target rate scope", (s) => { s.account_rate_limits[0].scope = "changed"; }],
  ["target rate extra field", (s) => { s.account_rate_limits[0].unexpected = true; }],
  ["attempt unchanged", (s) => { s.account_rate_limits[0].attempts = 1n; }],
  ["attempt advanced twice", (s) => { s.account_rate_limits[0].attempts = 3n; }],
  ["attempt changed to string", (s) => { s.account_rate_limits[0].attempts = "2"; }],
  ["other rate changed", (s) => { s.account_rate_limits[1].attempts++; }],
  ["other rate removed", (s) => { s.account_rate_limits.pop(); }],
  ["rate row added", (s) => { s.account_rate_limits.push({ ...rate(), key_hash: "extra" }); }],
  ["duplicate rate row", (s) => { s.account_rate_limits.push({ ...s.account_rate_limits[0] }); }],
  ["table omitted", (s) => { delete s.sessions; }],
  ["extra table", (s) => { s.unselected = []; }],
]) test(`rejects ${name} despite the allowed rate increment`, () => {
  const before = snapshot(), after = incremented(before);
  mutate(after);
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user));
});

test("accepts one newly committed bucket without changing any original row", () => {
  const before = snapshot(); before.account_rate_limits.shift();
  const after = structuredClone(before); after.account_rate_limits.push(rate());
  assertImportRateIncrement(wire(before), wire(after), user, databaseClocks);
  after.platform_accounts[0].revision--;
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user, databaseClocks));
});

for (const [name, mutate] of [
  ["wrong initial attempt", (r) => { r.attempts = 2n; }],
  ["invalid start", (r) => { r.window_started = "invalid"; }],
  ["invalid expiry", (r) => { r.expires_at = "invalid"; }],
  ["expired window", (r) => { r.expires_at = r.window_started; }],
  ["extra bucket field", (r) => { r.unexpected = true; }],
]) test(`rejects newly inserted bucket with ${name}`, () => {
  const before = snapshot(); before.account_rate_limits.shift();
  const after = structuredClone(before), added = rate(); mutate(added);
  after.account_rate_limits.push(added);
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user, databaseClocks));
});

test("fails closed for unexpected fractional numeric columns", () => {
  const value = snapshot(); value.users[0].fraction = 1.25;
  assert.throws(() => parseAccountSnapshot(wire(value)));
});


test("new bucket requires database-clock witnesses, never a JavaScript clock substitute", () => {
  const before = snapshot(); before.account_rate_limits.shift();
  const after = structuredClone(before); after.account_rate_limits.push(rate());
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user));
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user,
    { before: Date.now(), after: Date.now() }));
});

for (const [name, mutate] of [
  ["one millisecond window", (r) => { r.expires_at = "2026-10-10T00:00:00.124456Z"; }],
  ["twenty minute window", (r) => { r.expires_at = "2026-10-10T00:20:00.123456Z"; }],
  ["start one microsecond below bound", (r) => { r.window_started = "2026-10-10T00:00:00.123454Z"; }],
  ["start one microsecond above bound", (r) => { r.window_started = "2026-10-10T00:00:00.123459Z"; }],
  ["expiry sample one microsecond below bound", (r) => { r.expires_at = "2026-10-10T00:10:00.123454Z"; }],
  ["expiry sample one microsecond above bound", (r) => { r.expires_at = "2026-10-10T00:10:00.123459Z"; }],
  ["both samples arbitrarily in future", (r) => {
    r.window_started = "2027-10-10T00:00:00.123456Z";
    r.expires_at = "2027-10-10T00:10:00.123457Z";
  }],
]) test(`rejects new bucket with ${name}`, () => {
  const before = snapshot(); before.account_rate_limits.shift();
  const after = structuredClone(before), added = rate(); mutate(added);
  after.account_rate_limits.push(added);
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user, databaseClocks));
});

for (const [start, end] of [["123455", "123455"], ["123455", "123458"], ["123458", "123458"]])
  test(`accepts separate DB sample endpoints ${start}/${end} without millisecond rounding`, () => {
    const before = snapshot(); before.account_rate_limits.shift();
    const after = structuredClone(before), added = rate();
    added.window_started = `2026-10-10T00:00:00.${start}Z`;
    added.expires_at = `2026-10-10T00:10:00.${end}Z`;
    after.account_rate_limits.push(added);
    assertImportRateIncrement(wire(before), wire(after), user, databaseClocks);
  });

test("timestamp parser preserves microseconds and equivalent numeric timezone offsets", () => {
  const first = databaseTimestampMicros("2026-10-10T00:00:00.123455Z");
  assert.equal(databaseTimestampMicros("2026-10-10T00:00:00.123456Z") - first, 1n);
  assert.equal(databaseTimestampMicros("2026-10-10T08:00:00.123455+08:00"), first);
  assert.equal(databaseTimestampMicros("2026-10-09T19:00:00.123455-05:00"), first);
  assert.equal(databaseTimestampMicros("2026-10-10T00:00:00.1Z"),
    databaseTimestampMicros("2026-10-10T00:00:00.100000Z"));
  for (const bad of ["2026-02-30T00:00:00Z", "2026-10-10T24:00:00Z",
    "2026-10-10T00:00:00.1234567Z", "infinity", "2026-10-10T00:00:00+16:00"])
    assert.throws(() => databaseTimestampMicros(bad));
});

test("reversed database-clock witnesses fail closed", () => {
  const before = snapshot(); before.account_rate_limits.shift();
  const after = structuredClone(before); after.account_rate_limits.push(rate());
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user,
    { before: databaseClocks.after, after: databaseClocks.before }));
});


test("even broad clock witnesses cannot relax the original increasing-window check", () => {
  const before = snapshot(); before.account_rate_limits.shift();
  const after = structuredClone(before), added = rate();
  added.window_started = "2026-10-10T00:30:00.000000Z";
  added.expires_at = "2026-10-10T00:10:00.000000Z";
  after.account_rate_limits.push(added);
  assert.throws(() => assertImportRateIncrement(wire(before), wire(after), user,
    { before: "2026-10-10T00:00:00.000000Z", after: "2026-10-10T01:00:00.000000Z" }));
});

test("native snapshots bind full row text to database clock witnesses", async () => {
  const source = await readFile(new URL("./short-platform-account-authority-native.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("jsonb_build_object('rows',jsonb_build_object(${pairs.join(',')})::text,'clock',to_char(clock_timestamp() AT TIME ZONE 'UTC'"));
  assert.ok(source.includes("return {raw,value:parseAccountSnapshot(raw),databaseClock:capture.clock}"));
  assert.ok(source.includes("assertImportRateIncrement(before.raw,after.raw,s.id,{before:before.databaseClock,after:after.databaseClock})"));
  assert.ok(source.includes("privateFile(label,'rows.private.json',captured+'\\n')"));
});
