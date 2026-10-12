// Selected PostgreSQL rows contain integer numeric columns. Revive their exact
// JSON tokens as bigint; never compare a rounded Number to prove rollback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const tables = [
  "users", "sessions", "user_profiles", "platform_accounts",
  "platform_login_requests", "account_rate_limits",
].sort();
const rateFields = ["attempts", "expires_at", "key_hash", "scope", "window_started"];
const scope = "platform-cookie-import";

export function parseAccountSnapshot(raw) {
  const value = JSON.parse(raw, (_key, item, context) => {
    if (typeof item !== "number") return item;
    assert.match(context?.source ?? "", /^-?(?:0|[1-9]\d*)$/,
      "Account snapshot requires an exact integer JSON token (Node 24)");
    return BigInt(context.source);
  });
  assert.deepEqual(Object.keys(value).sort(), tables,
    "Snapshot must include every selected table and no unselected table");
  for (const table of tables) {
    assert.ok(Array.isArray(value[table]), "Snapshot table must be a complete row array");
    for (const row of value[table])
      assert.ok(row && typeof row === "object" && !Array.isArray(row));
  }
  return value;
}

function orderRates(rows) {
  const keys = rows.map((row) => {
    assert.equal(typeof row.scope, "string");
    assert.equal(typeof row.key_hash, "string");
    return JSON.stringify([row.scope, row.key_hash]);
  });
  assert.equal(new Set(keys).size, keys.length, "Duplicate rate-limit primary key");
  return rows.map((row, index) => ({ row, key: keys[index] }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(({ row }) => row);
}

// Account operations roll back independently of the earlier committed import
// limiter. Exactly one selected bucket may gain one attempt; all other fields,
// rows and tables are compared losslessly, including bigint revision extremes.
export function assertImportRateIncrement(beforeRaw, afterRaw, userId, databaseClocks) {
  const before = parseAccountSnapshot(beforeRaw);
  const after = parseAccountSnapshot(afterRaw);
  const key = createHash("sha256")
    .update(`account-rate:${scope}:${userId}`).digest("hex");
  const matches = (row) => row.scope === scope && row.key_hash === key;
  before.account_rate_limits = orderRates(before.account_rate_limits);
  after.account_rate_limits = orderRates(after.account_rate_limits);
  const old = before.account_rate_limits.find(matches);
  const now = after.account_rate_limits.find(matches);
  assert.ok(now, "Committed import rate-limit row is required");
  assert.deepEqual(Object.keys(now).sort(), rateFields);
  assert.equal(typeof now.attempts, "bigint");
  if (old) {
    assert.equal(typeof old.attempts, "bigint");
    // Every property except this one remains copied from the original snapshot.
    old.attempts += 1n;
  } else {
    assert.equal(now.attempts, 1n);
    assertNewImportRateWindow(now, databaseClocks);
    before.account_rate_limits.push(now);
    before.account_rate_limits = orderRates(before.account_rate_limits);
  }
  assert.deepEqual(after, before);
}

// Calendar conversion uses no system clock. Keep fractional seconds in BigInt
// microseconds instead of truncating them through Date.parse/Number milliseconds.
export function databaseTimestampMicros(value) {
  assert.equal(typeof value, "string");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  assert.ok(match, "Expected a finite PostgreSQL timestamp with microsecond precision");
  const [, y, mon, d, h, min, s, fraction = "", zone] = match;
  const [year, month, day, hour, minute, second] = [y, mon, d, h, min, s].map(Number);
  assert.ok(year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= 31
    && hour <= 23 && minute <= 59 && second <= 59);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  assert.deepEqual([calendar.getUTCFullYear(), calendar.getUTCMonth() + 1,
    calendar.getUTCDate(), calendar.getUTCHours(), calendar.getUTCMinutes(),
    calendar.getUTCSeconds()], [year, month, day, hour, minute, second]);
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    assert.ok(hours <= 15 && minutes <= 59);
    offsetMinutes = (hours * 60 + minutes) * (zone[0] === "-" ? -1 : 1);
  }
  return BigInt(calendar.getTime()) * 1000n
    + BigInt(fraction.padEnd(6, "0")) - BigInt(offsetMinutes) * 60_000_000n;
}

export function assertNewImportRateWindow(row, clocks) {
  assert.ok(clocks && typeof clocks === "object", "Request-bracketing database clocks are required");
  const before = databaseTimestampMicros(clocks.before);
  const after = databaseTimestampMicros(clocks.after);
  assert.ok(before <= after, "Database clock witnesses must be ordered");
  const started = databaseTimestampMicros(row.window_started);
  const expires = databaseTimestampMicros(row.expires_at);
  assert.ok(expires > started, "New rate expiry must remain after its start");
  const expirySample = expires - 600_000_000n;
  // Production evaluates clock_timestamp() separately for each VALUES field.
  // Both sampled instants must fall within the actual request's DB witnesses;
  // their difference is deliberately not rounded or asserted to be zero.
  assert.ok(before <= started && started <= after, "New rate window start escaped database request bounds");
  assert.ok(before <= expirySample && expirySample <= after,
    "New rate expiry minus 600 seconds escaped database request bounds");
}
