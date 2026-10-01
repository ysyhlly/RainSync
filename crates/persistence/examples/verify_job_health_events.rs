//! Finite transaction evidence against a new, owned integration database.
//! SQL only creates fixtures or injects faults; observed transitions use the
//! production persistence entry points. No subprocess-drain claim is made.
use anyhow::{Context, Result};
use media_core::{job_health, runtime_metrics::Process};
use persistence::media_jobs::{self, Claim, JobFailure};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

fn observations() -> ([u64; 6], bool) {
    let text = job_health::render(Process::Worker);
    let value = |name: &str, suffix: &str| -> u64 {
        let prefix = format!("{name}{{process=\"worker\"{suffix}}} ");
        let matches: Vec<_> = text
            .lines()
            .filter_map(|line| line.strip_prefix(&prefix))
            .collect();
        assert_eq!(matches.len(), 1, "one fixed sample: {prefix}");
        matches[0].parse().unwrap()
    };
    assert_eq!(value("rainsync_media_job_observation_available", ""), 1);
    let counts = [
        value(
            "rainsync_media_job_retry_schedules_total",
            ",reason=\"upstream_transport\"",
        ),
        value(
            "rainsync_media_job_retry_schedules_total",
            ",reason=\"worker_shutdown\"",
        ),
        value(
            "rainsync_media_job_retry_schedules_total",
            ",reason=\"lease_expired\"",
        ),
        value("rainsync_media_job_cancellations_total", ""),
        value(
            "rainsync_media_job_lease_expiry_normalizations_total",
            ",result=\"requeued\"",
        ),
        value(
            "rainsync_media_job_lease_expiry_normalizations_total",
            ",result=\"exhausted\"",
        ),
    ];
    (
        counts,
        value("rainsync_media_job_observation_incomplete", "") == 1,
    )
}

fn record(checks: &mut Vec<Value>, name: &str, expected: [u64; 6], incomplete: bool) {
    assert_eq!(observations(), (expected, incomplete), "{name}");
    checks.push(json!({"name":name,"result":"passed","counts":expected,"incomplete":incomplete}));
}

async fn seed(
    db: &PgPool,
    owned: &mut Vec<Uuid>,
    status: &str,
    attempt: i64,
    maximum: i32,
) -> Result<Uuid> {
    let id = Uuid::new_v4();
    owned.push(id);
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',clock_timestamp()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,attempt,max_attempts,owner_id,lease_until) VALUES($1,$1,$2,'{}',$3,$4,$5,CASE WHEN $2='running' THEN clock_timestamp()-interval '1 second' ELSE NULL END)")
        .bind(id).bind(status).bind(attempt).bind(maximum).bind(Uuid::new_v4()).execute(db).await?;
    Ok(id)
}

async fn claimed(db: &PgPool, id: Uuid) -> Result<Claim> {
    let claim = media_jobs::claim(db, Uuid::new_v4())
        .await?
        .context("fixture must claim")?;
    assert_eq!(claim.id, id);
    Ok(claim)
}

async fn state(db: &PgPool, id: Uuid) -> Result<String> {
    Ok(
        sqlx::query_scalar("SELECT status FROM media_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(db)
            .await?,
    )
}

async fn terminal(db: &PgPool, claim: &Claim) -> Result<()> {
    assert!(media_jobs::finish(db, claim, Some(JobFailure::ExecutionFailed), None).await?);
    Ok(())
}

async fn run(
    db: &PgPool,
    owned: &mut Vec<Uuid>,
    constraints: &[String; 2],
    checks: &mut Vec<Value>,
) -> Result<()> {
    let mut expected = [0; 6];
    record(
        checks,
        "fresh process has six known zero counters",
        expected,
        false,
    );

    let id = seed(db, owned, "queued", 0, 3).await?;
    let first = claimed(db, id).await?;
    let (a, b) = tokio::join!(
        media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None),
        media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None)
    );
    assert_ne!(
        a?, b?,
        "duplicate concurrent finish has exactly one committed winner"
    );
    expected[0] += 1;
    record(
        checks,
        "duplicate transport finish credits one acknowledged retry",
        expected,
        false,
    );
    let due: String = sqlx::query_scalar("SELECT available_at::text FROM media_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(db)
        .await?;
    assert!(!media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None).await?);
    assert!(!media_jobs::release(db, &first).await?);
    assert!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    assert_eq!(
        due,
        sqlx::query_scalar::<_, String>("SELECT available_at::text FROM media_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(db)
            .await?
    );
    record(
        checks,
        "replay and release after finished ownership have zero credit",
        expected,
        false,
    );
    sqlx::query(
        "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(db)
    .await?;
    let second = claimed(db, id).await?;
    assert!(!media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None).await?);
    assert!(!media_jobs::release(db, &first).await?);
    record(
        checks,
        "stale owner cannot credit a reclaimed attempt",
        expected,
        false,
    );
    let (a, b) = tokio::join!(
        media_jobs::release(db, &second),
        media_jobs::release(db, &second)
    );
    assert_ne!(a?, b?, "duplicate release has exactly one committed winner");
    expected[1] += 1;
    record(
        checks,
        "duplicate shutdown release credits one acknowledged retry",
        expected,
        false,
    );
    let third = claimed(db, id).await?;
    assert!(media_jobs::finish(db, &third, Some(JobFailure::UpstreamTransient), None).await?);
    assert_eq!(state(db, id).await?, "failed");
    record(
        checks,
        "terminal transport exhaustion schedules no retry",
        expected,
        false,
    );

    let id = seed(db, owned, "queued", 0, 1).await?;
    let c = claimed(db, id).await?;
    assert!(media_jobs::release(db, &c).await?);
    assert_eq!(state(db, id).await?, "failed");
    record(
        checks,
        "terminal shutdown exhaustion schedules no retry",
        expected,
        false,
    );

    let id = seed(db, owned, "queued", 0, 3).await?;
    let c = claimed(db, id).await?;
    sqlx::query("UPDATE media_outputs SET status='abandoned' WHERE job_id=$1 AND attempt=$2")
        .bind(id)
        .bind(c.attempt)
        .execute(db)
        .await?;
    assert!(!media_jobs::finish(db, &c, Some(JobFailure::UpstreamTransient), None).await?);
    assert_eq!(
        state(db, id).await?,
        "running",
        "failed output fence rolls back the queued job update"
    );
    record(
        checks,
        "finish rollback after job update publishes no partial retry",
        expected,
        false,
    );
    sqlx::query("UPDATE media_outputs SET status='writing' WHERE job_id=$1 AND attempt=$2")
        .bind(id)
        .bind(c.attempt)
        .execute(db)
        .await?;
    terminal(db, &c).await?;

    let expired = seed(db, owned, "running", 1, 3).await?;
    let (a, b) = tokio::join!(
        media_jobs::claim(db, Uuid::new_v4()),
        media_jobs::claim(db, Uuid::new_v4())
    );
    assert!(a?.is_none() && b?.is_none());
    assert_eq!(state(db, expired).await?, "queued");
    expected[2] += 1;
    expected[4] += 1;
    record(
        checks,
        "concurrent expired lease normalization credits one requeue and retry",
        expected,
        false,
    );
    let due: String = sqlx::query_scalar("SELECT available_at::text FROM media_jobs WHERE id=$1")
        .bind(expired)
        .fetch_one(db)
        .await?;
    assert!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    assert_eq!(
        due,
        sqlx::query_scalar::<_, String>("SELECT available_at::text FROM media_jobs WHERE id=$1")
            .bind(expired)
            .fetch_one(db)
            .await?
    );
    record(
        checks,
        "repeated expiry polling does not replay normalization or postpone backoff",
        expected,
        false,
    );
    sqlx::query(
        "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(expired)
    .execute(db)
    .await?;
    terminal(db, &claimed(db, expired).await?).await?;

    let expired = seed(db, owned, "running", 3, 3).await?;
    let queued = seed(db, owned, "queued", 3, 3).await?;
    let (a, b) = tokio::join!(
        media_jobs::claim(db, Uuid::new_v4()),
        media_jobs::claim(db, Uuid::new_v4())
    );
    assert!(a?.is_none() && b?.is_none());
    assert_eq!(state(db, expired).await?, "failed");
    assert_eq!(state(db, queued).await?, "failed");
    expected[5] += 1;
    record(
        checks,
        "exhausted expired running counts once while exhausted queued is not lease expiry",
        expected,
        false,
    );

    let stopped = seed(db, owned, "running", 3, 3).await?;
    let expired_session = seed(db, owned, "queued", 3, 3).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(stopped)
        .execute(db)
        .await?;
    sqlx::query(
        "UPDATE playback_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(expired_session)
    .execute(db)
    .await?;
    let (a, b) = tokio::join!(
        media_jobs::claim(db, Uuid::new_v4()),
        media_jobs::claim(db, Uuid::new_v4())
    );
    assert!(a?.is_none() && b?.is_none());
    assert_eq!(state(db, stopped).await?, "cancelled");
    assert_eq!(state(db, expired_session).await?, "cancelled");
    expected[3] += 2;
    record(
        checks,
        "session stop and expiry cancellation take precedence over exhaustion",
        expected,
        false,
    );
    assert!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    record(
        checks,
        "repeated cancellation normalization is a zero-row no-op",
        expected,
        false,
    );

    let expired = seed(db, owned, "running", 1, 3).await?;
    let due_job = seed(db, owned, "queued", 0, 3).await?;
    sqlx::query(&format!(
        "ALTER TABLE media_outputs ADD CONSTRAINT {} CHECK(job_id<>'{}'::uuid) NOT VALID",
        constraints[0], due_job
    ))
    .execute(db)
    .await?;
    assert!(
        media_jobs::claim(db, Uuid::new_v4()).await.is_err(),
        "later claim allocation fault is real"
    );
    assert_eq!(
        state(db, expired).await?,
        "queued",
        "normalization committed before claim transaction"
    );
    assert_eq!(
        state(db, due_job).await?,
        "queued",
        "failed claim rolled back"
    );
    expected[2] += 1;
    expected[4] += 1;
    record(
        checks,
        "committed normalization prefix survives later claim transaction failure",
        expected,
        false,
    );
    sqlx::query(&format!(
        "ALTER TABLE media_outputs DROP CONSTRAINT {}",
        constraints[0]
    ))
    .execute(db)
    .await?;
    terminal(db, &claimed(db, due_job).await?).await?;
    sqlx::query(
        "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(expired)
    .execute(db)
    .await?;
    terminal(db, &claimed(db, expired).await?).await?;

    let id = seed(db, owned, "queued", 0, 3).await?;
    let c = claimed(db, id).await?;
    sqlx::query(&format!("ALTER TABLE media_outputs ADD CONSTRAINT {} CHECK(job_id<>'{}'::uuid OR status='writing') NOT VALID", constraints[1], id)).execute(db).await?;
    assert!(media_jobs::release(db, &c).await.is_err());
    assert_eq!(
        state(db, id).await?,
        "running",
        "output mutation error rolls back release"
    );
    record(
        checks,
        "shutdown release transaction error publishes no retry",
        expected,
        false,
    );
    sqlx::query(&format!(
        "ALTER TABLE media_outputs DROP CONSTRAINT {}",
        constraints[1]
    ))
    .execute(db)
    .await?;
    terminal(db, &c).await?;

    // A real in-flight normalization is abandoned after a witnessed PostgreSQL
    // row-lock wait. Its acknowledgement is unknown to this producer. The guard
    // records only a gap; the database mutation's outcome remains unknown.
    let id = seed(db, owned, "queued", 0, 3).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(db)
        .await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let other = db.clone();
    let awaiting = tokio::spawn(async move { media_jobs::claim(&other, Uuid::new_v4()).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE media_jobs j SET status=''cancelled''%'").fetch_one(db).await.unwrap();
            if count > 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.context("witness actual normalization database lock wait")?;
    awaiting.abort();
    assert!(matches!(awaiting.await, Err(error) if error.is_cancelled()));
    record(
        checks,
        "cancelled unknown normalization acknowledgement only marks incomplete",
        expected,
        true,
    );
    // Closing the held lock may allow PostgreSQL to complete the detached query.
    // Counts must remain unchanged regardless; the next producer observes rows.
    held.rollback().await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    record(
        checks,
        "unknown acknowledgement never fabricates committed cancellation credit",
        expected,
        true,
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let mut owned = Vec::new();
    let mut checks = Vec::new();
    let suffix = Uuid::new_v4().simple().to_string();
    let constraints = [
        format!("job_health_claim_{suffix}"),
        format!("job_health_release_{suffix}"),
    ];
    let outcome = run(&db, &mut owned, &constraints, &mut checks).await;
    for constraint in &constraints {
        sqlx::query(&format!(
            "ALTER TABLE media_outputs DROP CONSTRAINT IF EXISTS {constraint}"
        ))
        .execute(&db)
        .await?;
    }
    sqlx::query("DELETE FROM media_executions WHERE job_id=ANY($1)")
        .bind(&owned)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM media_jobs WHERE id=ANY($1)")
        .bind(&owned)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM playback_sessions WHERE id=ANY($1)")
        .bind(&owned)
        .execute(&db)
        .await?;
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs WHERE id=ANY($1)")
        .bind(&owned)
        .fetch_one(&db)
        .await?;
    assert_eq!(remaining, 0, "owned database rows removed");
    let report = json!({"schema_version":1,"result":if outcome.is_ok(){"passed"}else{"failed"},"scope":"Real persistence producers against owned generated SQL fixtures; process-labelled rendering here is the helper process, not the Worker API. Logical transitions do not prove operating-system drain.","checks":checks,"cleanup":{"owned_job_ids":owned,"owned_rows_remaining":remaining,"fault_constraints_removed":true},"failure":outcome.as_ref().err().map(|e|format!("{e:#}"))});
    println!("{}", serde_json::to_string(&report)?);
    db.close().await;
    outcome
}
