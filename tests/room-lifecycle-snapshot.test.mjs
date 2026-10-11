import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleSnapshotSql } from "./fixtures/room-lifecycle-snapshot.mjs";

test("whole lifecycle snapshots keep more than 50 complete pairs in one SQL statement", () => {
  // The current schema supplies 56 tables. Each expression models the exact
  // existing ordered full-row query, including its unchanged room predicate.
  const pairs = Array.from({ length: 56 }, (_, index) => {
    const table = `table_${String(index).padStart(2, "0")}`;
    return `'${table}',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM "${table}" x WHERE room_id='00000000-0000-0000-0000-000000000001'),'[]'::jsonb)`;
  });
  const query = lifecycleSnapshotSql(pairs);
  const objects = query.slice("SELECT (".length, -")::text".length).split(" || ");
  assert.equal(objects.length, 56);
  assert.equal((query.match(/jsonb_build_object\(/g) ?? []).length, 56);
  assert.equal((query.match(/jsonb_agg\(/g) ?? []).length, 56);
  assert.equal((query.match(/WHERE room_id=/g) ?? []).length, 56);
  assert.ok(query.startsWith("SELECT ("));
  assert.ok(query.endsWith(")::text"));
  assert.ok(!query.includes(";"));
  for (const [index, pair] of pairs.entries()) {
    assert.equal(objects[index], `jsonb_build_object(${pair})`);
  }
  assert.equal(lifecycleSnapshotSql(["'only','[]'::jsonb"]),
    "SELECT (jsonb_build_object('only','[]'::jsonb))::text");
  assert.throws(() => lifecycleSnapshotSql([]), /lifecycle_snapshot_pairs_required/);
});
