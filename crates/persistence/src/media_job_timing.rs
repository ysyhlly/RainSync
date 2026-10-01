//! Logical phase timing captured from locked old rows, owned by commit deltas.
use media_core::job_health::{
    PendingJobHealth, TIMING_BUCKET_SECONDS, TimingAggregate, TimingKind,
};
use sqlx::{Executor, Postgres, Row, postgres::PgRow};
use uuid::Uuid;

/// Closed cancellation predicates; callers retain their transaction and locks.
#[derive(Clone, Copy, Debug)]
pub enum CancellationScope {
    Session(Uuid),
    OwnedSession { session: Uuid, user: Uuid },
    Room(Uuid),
    StoppedRoom(Uuid),
    StoppedSessions,
    StoppedOrExpiredSessions,
}

/// The final aggregate stays one row with two fixed twelve-bucket arrays.
/// `changed` must contain the locked old tuple and the post-lock authority tick.
pub(crate) const AGGREGATE_SQL: &str = r#",
samples AS MATERIALIZED (
    SELECT old_status,
        CASE WHEN old_status='queued' AND timing_version=1
            AND timing_attempt=old_attempt AND queue_entered_at IS NOT NULL
            AND run_started_at IS NULL AND isfinite(queue_entered_at)
            AND isfinite(ended_at) AND queue_entered_at<=ended_at
            THEN extract(epoch FROM ended_at)-extract(epoch FROM queue_entered_at)
        END AS queue_seconds,
        CASE WHEN old_status='running' AND timing_version=1
            AND timing_attempt=old_attempt AND run_started_at IS NOT NULL
            AND queue_entered_at IS NULL AND isfinite(run_started_at)
            AND isfinite(ended_at) AND run_started_at<=ended_at
            THEN extract(epoch FROM ended_at)-extract(epoch FROM run_started_at)
        END AS run_seconds
    FROM changed
)
SELECT count(*) AS updated_count,
    count(*) FILTER (WHERE old_status='queued') AS queue_total,
    count(*) FILTER (WHERE old_status='running') AS run_total,
    count(queue_seconds) AS queue_known, count(run_seconds) AS run_known,
    coalesce(sum(queue_seconds),0)::float8 AS queue_sum_seconds,
    coalesce(sum(run_seconds),0)::float8 AS run_sum_seconds,
    ARRAY[
        count(*) FILTER (WHERE queue_seconds<=0.01),
        count(*) FILTER (WHERE queue_seconds<=0.05),
        count(*) FILTER (WHERE queue_seconds<=0.1),
        count(*) FILTER (WHERE queue_seconds<=0.5),
        count(*) FILTER (WHERE queue_seconds<=1),
        count(*) FILTER (WHERE queue_seconds<=5),
        count(*) FILTER (WHERE queue_seconds<=30),
        count(*) FILTER (WHERE queue_seconds<=120),
        count(*) FILTER (WHERE queue_seconds<=600),
        count(*) FILTER (WHERE queue_seconds<=3600),
        count(*) FILTER (WHERE queue_seconds<=21600),
        count(*) FILTER (WHERE queue_seconds<=86400)
    ] AS queue_buckets,
    ARRAY[
        count(*) FILTER (WHERE run_seconds<=0.01),
        count(*) FILTER (WHERE run_seconds<=0.05),
        count(*) FILTER (WHERE run_seconds<=0.1),
        count(*) FILTER (WHERE run_seconds<=0.5),
        count(*) FILTER (WHERE run_seconds<=1),
        count(*) FILTER (WHERE run_seconds<=5),
        count(*) FILTER (WHERE run_seconds<=30),
        count(*) FILTER (WHERE run_seconds<=120),
        count(*) FILTER (WHERE run_seconds<=600),
        count(*) FILTER (WHERE run_seconds<=3600),
        count(*) FILTER (WHERE run_seconds<=21600),
        count(*) FILTER (WHERE run_seconds<=86400)
    ] AS run_buckets
FROM samples
"#;

pub async fn cancel_jobs<'e, E>(
    executor: E,
    scope: CancellationScope,
) -> Result<PendingJobHealth, sqlx::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    let (predicate, first, second, worker) = match scope {
        CancellationScope::Session(session) => ("j.session_id=$1", Some(session), None, false),
        CancellationScope::OwnedSession { session, user } => {
            ("p.id=$1 AND p.user_id=$2", Some(session), Some(user), false)
        }
        CancellationScope::Room(room) => ("p.room_id=$1", Some(room), None, false),
        CancellationScope::StoppedRoom(room) => {
            ("p.room_id=$1 AND p.stopped", Some(room), None, false)
        }
        CancellationScope::StoppedSessions => ("p.stopped", None, None, false),
        CancellationScope::StoppedOrExpiredSessions => (
            "(p.stopped OR p.expires_at<=clock_timestamp())",
            None,
            None,
            true,
        ),
    };
    // Only invalid-session worker normalization changes the existing error,
    // owner and lease. Server cancellation retains those original columns.
    let extra = if worker {
        ",error=CASE WHEN p.stopped THEN 'playback_session_stopped' ELSE 'playback_session_expired' END,owner_id=NULL,lease_until=NULL"
    } else {
        ""
    };
    let query = format!(
        r#"/* media_job_cancel_jobs */
WITH locked AS MATERIALIZED (
    SELECT j.id,j.status AS old_status,j.attempt AS old_attempt,
        j.timing_version,j.timing_attempt,j.queue_entered_at,j.run_started_at
    FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id
    WHERE j.status IN ('queued','running') AND {predicate}
    ORDER BY j.id FOR UPDATE OF j
), tick AS MATERIALIZED (
    SELECT CASE WHEN count(*)>=0 THEN clock_timestamp() END AS ended_at FROM locked
), changed AS (
    UPDATE media_jobs j SET status='cancelled'{extra},
        timing_version=NULL,timing_attempt=NULL,queue_entered_at=NULL,run_started_at=NULL
    FROM locked l CROSS JOIN tick t,playback_sessions p
    WHERE j.id=l.id AND j.status IN ('queued','running')
        AND p.id=j.session_id AND {predicate}
    RETURNING l.old_status,l.old_attempt,l.timing_version,l.timing_attempt,
        l.queue_entered_at,l.run_started_at,t.ended_at
){AGGREGATE_SQL}"#
    );
    let mut query = sqlx::query(&query);
    if let Some(first) = first {
        query = query.bind(first);
    }
    if let Some(second) = second {
        query = query.bind(second);
    }
    let row = query.fetch_one(executor).await?;
    let mut delta = PendingJobHealth::default();
    if let Some(count) = count(&row, "updated_count") {
        delta.cancelled(count);
    } else {
        delta.mark_incomplete();
    }
    record_aggregate(&mut delta, &row, "queue", TimingKind::QueueCancelled);
    record_aggregate(&mut delta, &row, "run", TimingKind::RunCancelled);
    Ok(delta)
}

pub(crate) fn count(row: &PgRow, column: &str) -> Option<u64> {
    u64::try_from(row.try_get::<i64, _>(column).ok()?).ok()
}

/// Invalid observation decoding cannot fail an acknowledged business mutation.
pub(crate) fn record_aggregate(
    delta: &mut PendingJobHealth,
    row: &PgRow,
    phase: &str,
    kind: TimingKind,
) {
    let decoded = (|| {
        let total = count(row, &format!("{phase}_total"))?;
        let known = count(row, &format!("{phase}_known"))?;
        let sum = row
            .try_get::<f64, _>(format!("{phase}_sum_seconds").as_str())
            .ok()?;
        let raw = row
            .try_get::<Vec<i64>, _>(format!("{phase}_buckets").as_str())
            .ok()?;
        let raw: [i64; 12] = raw.try_into().ok()?;
        let mut buckets = [0; 12];
        for (bucket, raw) in buckets.iter_mut().zip(raw) {
            *bucket = u64::try_from(raw).ok()?;
        }
        TimingAggregate::new(total, known, sum, buckets)
    })();
    if let Some(aggregate) = decoded {
        delta.timing(kind, aggregate);
    } else {
        delta.mark_incomplete();
    }
}

/// Decode one SQL-validated phase exit without changing business error handling.
pub(crate) fn record_single(
    delta: &mut PendingJobHealth,
    row: &PgRow,
    column: &str,
    kind: TimingKind,
) {
    let decoded = (|| {
        let elapsed: Option<f64> = row.try_get(column).ok()?;
        let (known, sum, buckets) = match elapsed {
            Some(elapsed) if elapsed.is_finite() && elapsed >= 0.0 => (
                1,
                elapsed,
                TIMING_BUCKET_SECONDS.map(|bound| u64::from(elapsed <= bound)),
            ),
            Some(_) => return None,
            None => (0, 0.0, [0; 12]),
        };
        TimingAggregate::new(1, known, sum, buckets)
    })();
    if let Some(aggregate) = decoded {
        delta.timing(kind, aggregate);
    } else {
        delta.mark_incomplete();
    }
}

/// Raw old fields stay in PostgreSQL until exact timestamp validation/subtraction.
pub(crate) const OLD_PHASE_SQL: &str = "j.id,j.status AS old_status,j.attempt AS old_attempt,j.timing_version,j.timing_attempt,j.queue_entered_at,j.run_started_at";

/// Callers already hold the job/output/proof locks. This repeated capture keeps
/// the original tuple in SQL, and the aggregate dependency drains it before tick.
pub(crate) const OWNED_TICK_SQL: &str = r#"WITH locked AS MATERIALIZED (
    SELECT j.id,j.status AS old_status,j.attempt AS old_attempt,
        j.timing_version,j.timing_attempt,j.queue_entered_at,j.run_started_at
    FROM media_jobs j WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3
        AND j.status='running' FOR UPDATE OF j
), tick AS MATERIALIZED (
    SELECT CASE WHEN count(*)>=0 THEN clock_timestamp() END AS ended_at FROM locked
)
"#;

pub(crate) const SINGLE_PHASE_SQL: &str = r#"
    CASE WHEN l.old_status='queued' AND l.timing_version=1 AND l.timing_attempt=l.old_attempt
        AND l.queue_entered_at IS NOT NULL AND l.run_started_at IS NULL
        AND isfinite(l.queue_entered_at) AND isfinite(t.ended_at)
        AND l.queue_entered_at<=t.ended_at
        THEN (extract(epoch FROM t.ended_at)-extract(epoch FROM l.queue_entered_at))::float8
    END AS queue_seconds,
    CASE WHEN l.old_status='running' AND l.timing_version=1 AND l.timing_attempt=l.old_attempt
        AND l.run_started_at IS NOT NULL AND l.queue_entered_at IS NULL
        AND isfinite(l.run_started_at) AND isfinite(t.ended_at)
        AND l.run_started_at<=t.ended_at
        THEN (extract(epoch FROM t.ended_at)-extract(epoch FROM l.run_started_at))::float8
    END AS run_seconds
"#;
