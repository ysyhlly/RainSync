// Each existing pair has one table key and its complete ordered row expression.
// Keep one SQL statement without exceeding PostgreSQL's function argument limit.
export function lifecycleSnapshotSql(pairs) {
  if (!pairs.length) throw Error("lifecycle_snapshot_pairs_required");
  return `SELECT (${pairs.map(pair => `jsonb_build_object(${pair})`).join(" || ")})::text`;
}
