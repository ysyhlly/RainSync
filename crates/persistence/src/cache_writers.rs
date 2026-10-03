//! A lease fences publication; only a matching positive receipt proves that a
//! writer released its resources. All cache deletion/accounting uses this fact.

/// Expressions are source-owned SQL aliases, never external data. Legacy rows
/// without an owner can use the unique job/attempt receipt; a known owner must
/// match exactly. A missing receipt deliberately fails closed.
pub(crate) fn reaped(job: &'static str, attempt: &'static str, owner: &'static str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM media_executions writer WHERE writer.kind='job' AND writer.job_id={job} AND writer.attempt={attempt} AND ({owner} IS NULL OR writer.owner_id={owner}) AND writer.reaped_at IS NOT NULL)"
    )
}
