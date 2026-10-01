//! Finite PostgreSQL evidence for actual production logical timing producers.
//! SQL is used only to create fixtures, hold locks and inject valid-shape faults.
//! This process's collector is separate from the actual Server/Worker API matrix.
use anyhow::{Context, Result, ensure};
use media_core::{job_health, runtime_metrics::Process};
use persistence::{
    media_job_timing::{self, CancellationScope},
    media_jobs::{self, Claim, JobFailure},
    media_outputs::{self, FileProof, Snapshot},
    media_queue,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

const SLOTS: [(&str, &str); 7] = [
    ("queue", "started"),
    ("queue", "failed"),
    ("queue", "cancelled"),
    ("run", "succeeded"),
    ("run", "failed"),
    ("run", "cancelled"),
    ("run", "retry"),
];
const BOUNDS: [f64; 12] = [
    0.01, 0.05, 0.1, 0.5, 1., 5., 30., 120., 600., 3600., 21600., 86400.,
];

#[derive(Clone, Copy, Debug, PartialEq)]
struct Sample {
    known: u64,
    unknown: u64,
    sum: f64,
    buckets: [u64; 12],
}

fn observations() -> ([Sample; 7], bool) {
    let text = job_health::render(Process::Worker);
    let sample = |prefix: String| -> f64 {
        let matches: Vec<_> = text
            .lines()
            .filter_map(|line| line.strip_prefix(&prefix))
            .collect();
        assert_eq!(matches.len(), 1, "one fixed series {prefix}");
        matches[0].parse::<f64>().unwrap()
    };
    assert_eq!(
        sample("rainsync_media_job_observation_available{process=\"worker\"} ".into()),
        1.
    );
    let values = SLOTS.map(|(phase, outcome)| {
        let family = format!("rainsync_media_job_{phase}_duration_seconds");
        let labels = format!("process=\"worker\",outcome=\"{outcome}\"");
        let count = sample(format!("{family}_count{{{labels}}} "));
        assert!(count >= 0. && count.fract() == 0.);
        let buckets = BOUNDS.map(|bound| sample(format!("{family}_bucket{{{labels},le=\"{bound}\"}} ")) as u64);
        assert_eq!(sample(format!("{family}_bucket{{{labels},le=\"+Inf\"}} ")), count);
        let sum = sample(format!("{family}_sum{{{labels}}} "));
        assert!(sum.is_finite() && sum >= 0.);
        assert!(buckets.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(buckets[11] <= count as u64);
        let unknown = sample(format!("rainsync_media_job_timing_unknown_total{{process=\"worker\",phase=\"{phase}\",outcome=\"{outcome}\"}} "));
        assert!(unknown >= 0. && unknown.fract() == 0.);
        Sample { known: count as u64, unknown: unknown as u64, sum, buckets }
    });
    assert_eq!(
        text.lines()
            .filter(|line| line.starts_with("rainsync_media_job_")
                && (line.contains("_duration_seconds_")
                    || line.starts_with("rainsync_media_job_timing_unknown_total{")))
            .count(),
        112
    );
    (
        values,
        sample("rainsync_media_job_observation_incomplete{process=\"worker\"} ".into()) == 1.,
    )
}

fn record(
    checks: &mut Vec<Value>,
    name: &str,
    before: [Sample; 7],
    expected: [(u64, u64); 7],
) -> [Sample; 7] {
    let (after, incomplete) = observations();
    assert!(
        !incomplete,
        "ordinary legacy or invalid timing is missing evidence, not an observation gap: {name}"
    );
    let deltas = std::array::from_fn::<_, 7, _>(|index| {
        let b = before[index];
        let a = after[index];
        assert_eq!(
            (a.known - b.known, a.unknown - b.unknown),
            expected[index],
            "{name}: {:?}",
            SLOTS[index]
        );
        let sum = a.sum - b.sum;
        let buckets = std::array::from_fn::<_, 12, _>(|i| a.buckets[i] - b.buckets[i]);
        if expected[index].0 == 0 {
            assert!(sum.abs() < 0.000001);
            assert_eq!(buckets, [0; 12]);
        }
        json!({"phase":SLOTS[index].0,"outcome":SLOTS[index].1,"known":expected[index].0,
            "unknown":expected[index].1,"sum_seconds":sum,"cumulative_buckets":buckets})
    });
    checks.push(json!({"name":name,"result":"passed","deltas":deltas}));
    eprintln!("PASS: {name}");
    after
}

fn delta(slot: usize, known: u64, unknown: u64) -> [(u64, u64); 7] {
    let mut expected = [(0, 0); 7];
    expected[slot] = (known, unknown);
    expected
}

async fn session(db: &PgPool, owned: &mut Vec<Uuid>) -> Result<Uuid> {
    let id = Uuid::new_v4();
    owned.push(id);
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',clock_timestamp()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(db).await?;
    Ok(id)
}

async fn legacy(
    db: &PgPool,
    owned: &mut Vec<Uuid>,
    status: &str,
    attempt: i64,
    maximum: i32,
) -> Result<Uuid> {
    let id = session(db, owned).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,attempt,max_attempts,owner_id,lease_until) VALUES($1,$1,$2,'{}',$3,$4,$5,CASE WHEN $2='running' THEN clock_timestamp()-interval '1 second' ELSE NULL END)")
        .bind(id).bind(status).bind(attempt).bind(maximum).bind(Uuid::new_v4()).execute(db).await?;
    Ok(id)
}

async fn enqueue(db: &PgPool, owned: &mut Vec<Uuid>) -> Result<Uuid> {
    let id = session(db, owned).await?;
    let mut tx = db.begin().await?;
    ensure!(media_queue::enqueue(&mut tx, id, &json!({}), 10000).await?);
    tx.commit().await?;
    Ok(id)
}

async fn enqueue_scoped(
    db: &PgPool,
    owned: &mut Vec<Uuid>,
    user: Uuid,
    room: Option<Uuid>,
) -> Result<Uuid> {
    let id = Uuid::new_v4();
    owned.push(id);
    // Room identity is immutable: fixture scope must be present at insertion.
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,$3,0,$4,'{}',clock_timestamp()+interval '1 hour')")
        .bind(id).bind(user).bind(room).bind(id.to_string()).execute(db).await?;
    let mut tx = db.begin().await?;
    ensure!(media_queue::enqueue(&mut tx, id, &json!({}), 10000).await?);
    tx.commit().await?;
    Ok(id)
}

async fn claimed(db: &PgPool, id: Uuid) -> Result<Claim> {
    let claim = media_jobs::claim(db, Uuid::new_v4())
        .await?
        .context("one fixture job must claim")?;
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
    ensure!(media_jobs::finish(db, claim, Some(JobFailure::ExecutionFailed), None).await?);
    Ok(())
}

async fn cancel(db: &PgPool, scope: CancellationScope) -> Result<()> {
    let mut tx = db.begin().await?;
    let delta = media_job_timing::cancel_jobs(&mut *tx, scope).await?;
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(())
}

async fn known(db: &PgPool, id: Uuid, phase: &str, age_seconds: f64) -> Result<()> {
    let query = match phase {
        "queue" => {
            "UPDATE media_jobs SET timing_version=1,timing_attempt=attempt,queue_entered_at=clock_timestamp()-$2*interval '1 second',run_started_at=NULL WHERE id=$1"
        }
        "run" => {
            "UPDATE media_jobs SET timing_version=1,timing_attempt=attempt,queue_entered_at=NULL,run_started_at=clock_timestamp()-$2*interval '1 second' WHERE id=$1"
        }
        _ => unreachable!(),
    };
    sqlx::query(query)
        .bind(id)
        .bind(age_seconds)
        .execute(db)
        .await?;
    Ok(())
}

async fn wait_for_lock(db: &PgPool) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%media_jobs%' OR query LIKE '%media_outputs%' OR query LIKE '%pg_advisory_xact_lock%')")
                .fetch_one(db).await.unwrap();
            if count > 0 { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.context("positive actual producer database row-lock wait")?;
    Ok(())
}

fn output(complete: bool) -> Snapshot {
    Snapshot {
        manifest: format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1.0,\nindex0.m4s\n{}",
            if complete { "#EXT-X-ENDLIST\n" } else { "" }
        ),
        segment_count: 1,
        files: [-1, 0]
            .map(|index| FileProof {
                index,
                size_bytes: 64,
                sha256: "a".repeat(64),
            })
            .to_vec(),
    }
}

async fn run(
    db: &PgPool,
    owned: &mut Vec<Uuid>,
    users: &mut Vec<Uuid>,
    rooms: &mut Vec<Uuid>,
    constraints: &[String; 2],
    checks: &mut Vec<Value>,
) -> Result<()> {
    assert_eq!(job_health::TIMING_BUCKET_SECONDS, BOUNDS);
    let (zero, incomplete) = observations();
    assert!(!incomplete);
    assert!(zero.iter().all(|sample| sample.known == 0
        && sample.unknown == 0
        && sample.sum == 0.
        && sample.buckets == [0; 12]));
    checks.push(json!({"name":"fresh fixed histograms have 112 known-zero timing series","result":"passed"}));

    let id = session(db, owned).await?;
    let before = observations().0;
    let mut tx = db.begin().await?;
    assert!(media_queue::enqueue(&mut tx, id, &json!({}), 10000).await?);
    tx.rollback().await?;
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(db)
        .await?;
    assert_eq!(rows, 0);
    record(
        checks,
        "actual enqueue rollback leaves no tuple or phase sample",
        before,
        [(0, 0); 7],
    );

    let id = session(db, owned).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(72614932)")
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task = tokio::spawn(async move {
        let mut tx = other.begin().await?;
        ensure!(media_queue::enqueue(&mut tx, id, &json!({}), 10000).await?);
        tx.commit().await?;
        Ok::<_, anyhow::Error>(())
    });
    wait_for_lock(db).await?;
    let before_unlock: f64 =
        sqlx::query_scalar("SELECT extract(epoch FROM clock_timestamp())::float8")
            .fetch_one(db)
            .await?;
    held.rollback().await?;
    task.await??;
    let entered: f64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM queue_entered_at)::float8 FROM media_jobs WHERE id=$1",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    assert!(
        entered >= before_unlock,
        "queue entry clock follows required capacity lock"
    );
    record(
        checks,
        "actual enqueue samples queue entry after witnessed capacity advisory wait",
        before,
        [(0, 0); 7],
    );
    cancel(db, CancellationScope::Session(id)).await?;

    let id = enqueue(db, owned).await?;
    known(db, id, "queue", 2.).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(72614933)")
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task = tokio::spawn(async move { claimed(&other, id).await });
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    held.rollback().await?;
    let claim = task.await??;
    let after = record(
        checks,
        "actual claim queue duration includes scheduler advisory lock wait",
        before,
        delta(0, 1, 0),
    );
    assert!(after[0].sum - before[0].sum >= 2.65);
    terminal(db, &claim).await?;

    let id = legacy(db, owned, "queued", 0, 3).await?;
    let before = observations().0;
    let claim = claimed(db, id).await?;
    record(
        checks,
        "legacy queued row is unknown; claim establishes known next run",
        before,
        delta(0, 0, 1),
    );
    let tuple: bool = sqlx::query_scalar("SELECT timing_version=1 AND timing_attempt=attempt AND queue_entered_at IS NULL AND run_started_at IS NOT NULL FROM media_jobs WHERE id=$1")
        .bind(id).fetch_one(db).await?;
    assert!(tuple);
    let before = observations().0;
    terminal(db, &claim).await?;
    record(
        checks,
        "known run ends after unknown legacy queue without fabricated zero",
        before,
        delta(4, 1, 0),
    );

    let id = enqueue(db, owned).await?;
    let first = claimed(db, id).await?;
    sqlx::query("UPDATE media_jobs SET status='queued',owner_id=NULL,lease_until=NULL WHERE id=$1")
        .bind(id)
        .execute(db)
        .await?;
    let before = observations().0;
    let second = claimed(db, id).await?;
    record(
        checks,
        "equal-attempt old-writer requeue has stale run tuple: queue unknown and no credited run",
        before,
        delta(0, 0, 1),
    );
    let before = observations().0;
    assert!(!media_jobs::release(db, &first).await?);
    assert!(!media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None).await?);
    record(
        checks,
        "old owner after mixed-writer reclaim publishes no timing",
        before,
        [(0, 0); 7],
    );
    sqlx::query("UPDATE media_jobs SET timing_attempt=attempt+1 WHERE id=$1")
        .bind(id)
        .execute(db)
        .await?;
    let before = observations().0;
    terminal(db, &second).await?;
    record(
        checks,
        "mismatched attempt is typed missing run evidence",
        before,
        delta(4, 0, 1),
    );

    let id = enqueue(db, owned).await?;
    let before = observations().0;
    let first = claimed(db, id).await?;
    record(
        checks,
        "actual enqueue establishes known queue timing",
        before,
        delta(0, 1, 0),
    );
    let before = observations().0;
    let (a, b) = tokio::join!(
        media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None),
        media_jobs::finish(db, &first, Some(JobFailure::UpstreamTransient), None)
    );
    assert_ne!(a?, b?);
    record(
        checks,
        "duplicate concurrent transport finish credits one run retry",
        before,
        delta(6, 1, 0),
    );
    let before = observations().0;
    assert!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    assert!(!media_jobs::release(db, &first).await?);
    record(
        checks,
        "backoff and stale release have no additional phase end",
        before,
        [(0, 0); 7],
    );
    sqlx::query("UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second',queue_entered_at=clock_timestamp()-interval '2 seconds' WHERE id=$1")
        .bind(id).execute(db).await?;
    let before = observations().0;
    let second = claimed(db, id).await?;
    let after = record(
        checks,
        "retry queue includes scheduling backoff",
        before,
        delta(0, 1, 0),
    );
    assert!(after[0].sum - before[0].sum >= 2.);
    let before = observations().0;
    let (a, b) = tokio::join!(
        media_jobs::release(db, &second),
        media_jobs::release(db, &second)
    );
    assert_ne!(a?, b?);
    record(
        checks,
        "duplicate concurrent shutdown release credits one run retry",
        before,
        delta(6, 1, 0),
    );
    let third = claimed(db, id).await?;
    let before = observations().0;
    assert!(media_jobs::finish(db, &third, Some(JobFailure::UpstreamTransient), None).await?);
    assert_eq!(state(db, id).await?, "failed");
    record(
        checks,
        "transport exhaustion is run failed rather than retry",
        before,
        delta(4, 1, 0),
    );

    let id = enqueue(db, owned).await?;
    sqlx::query("UPDATE media_jobs SET max_attempts=1 WHERE id=$1")
        .bind(id)
        .execute(db)
        .await?;
    let claim = claimed(db, id).await?;
    let before = observations().0;
    assert!(media_jobs::release(db, &claim).await?);
    assert_eq!(state(db, id).await?, "failed");
    record(
        checks,
        "shutdown exhaustion ends run failed",
        before,
        delta(4, 1, 0),
    );

    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    let before = observations().0;
    assert!(media_outputs::publish(db, &claim, &output(false), false).await?);
    assert_eq!(state(db, id).await?, "running");
    record(
        checks,
        "actual partial HLS publication has no terminal run sample",
        before,
        [(0, 0); 7],
    );
    let before = observations().0;
    assert!(media_outputs::publish(db, &claim, &output(true), true).await?);
    assert_eq!(state(db, id).await?, "succeeded");
    record(
        checks,
        "actual complete HLS publication credits succeeded run once",
        before,
        delta(3, 1, 0),
    );
    let before = observations().0;
    assert!(!media_outputs::publish(db, &claim, &output(true), true).await?);
    assert!(!media_jobs::release(db, &claim).await?);
    record(
        checks,
        "complete publication replay and stale release have no sample",
        before,
        [(0, 0); 7],
    );

    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    sqlx::query(&format!("ALTER TABLE media_outputs ADD CONSTRAINT {} CHECK(job_id<>'{}'::uuid OR status='writing') NOT VALID", constraints[0], id)).execute(db).await?;
    let before = observations().0;
    assert!(
        media_outputs::publish(db, &claim, &output(true), true)
            .await
            .is_err()
    );
    assert_eq!(state(db, id).await?, "running");
    let files: i64 = sqlx::query_scalar("SELECT count(*) FROM media_output_files WHERE job_id=$1")
        .bind(id)
        .fetch_one(db)
        .await?;
    assert_eq!(files, 0);
    record(
        checks,
        "complete output rollback after job mutation publishes no histogram",
        before,
        [(0, 0); 7],
    );
    sqlx::query(&format!(
        "ALTER TABLE media_outputs DROP CONSTRAINT {}",
        constraints[0]
    ))
    .execute(db)
    .await?;
    sqlx::query("UPDATE media_outputs SET status='abandoned' WHERE job_id=$1")
        .bind(id)
        .execute(db)
        .await?;
    let before = observations().0;
    assert!(!media_jobs::finish(db, &claim, Some(JobFailure::UpstreamTransient), None).await?);
    assert_eq!(state(db, id).await?, "running");
    record(
        checks,
        "finish output fence rollback discards staged run retry",
        before,
        [(0, 0); 7],
    );
    sqlx::query("UPDATE media_outputs SET status='writing' WHERE job_id=$1")
        .bind(id)
        .execute(db)
        .await?;
    terminal(db, &claim).await?;

    let retry = legacy(db, owned, "running", 1, 3).await?;
    known(db, retry, "run", 2.).await?;
    let failed = legacy(db, owned, "running", 3, 3).await?;
    known(db, failed, "run", 2.).await?;
    let queued = legacy(db, owned, "queued", 3, 3).await?;
    known(db, queued, "queue", 2.).await?;
    let before = observations().0;
    let (a, b) = tokio::join!(
        media_jobs::claim(db, Uuid::new_v4()),
        media_jobs::claim(db, Uuid::new_v4())
    );
    assert!(a?.is_none() && b?.is_none());
    let mut expected = delta(6, 1, 0);
    expected[4] = (1, 0);
    expected[1] = (1, 0);
    record(
        checks,
        "concurrent lease normalization has exact queue failed run failed and run retry phases",
        before,
        expected,
    );
    let before = observations().0;
    assert!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    record(
        checks,
        "repeated lease normalization has zero phase replay",
        before,
        [(0, 0); 7],
    );
    sqlx::query(
        "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(retry)
    .execute(db)
    .await?;
    terminal(db, &claimed(db, retry).await?).await?;

    let prefix = legacy(db, owned, "running", 1, 3).await?;
    known(db, prefix, "run", 2.).await?;
    let failing_claim = enqueue(db, owned).await?;
    sqlx::query(&format!(
        "ALTER TABLE media_outputs ADD CONSTRAINT {} CHECK(job_id<>'{}'::uuid) NOT VALID",
        constraints[1], failing_claim
    ))
    .execute(db)
    .await?;
    let before = observations().0;
    assert!(media_jobs::claim(db, Uuid::new_v4()).await.is_err());
    assert_eq!(state(db, prefix).await?, "queued");
    assert_eq!(state(db, failing_claim).await?, "queued");
    record(
        checks,
        "acknowledged normalization prefix survives failed later claim; no queue started sample",
        before,
        delta(6, 1, 0),
    );
    sqlx::query(&format!(
        "ALTER TABLE media_outputs DROP CONSTRAINT {}",
        constraints[1]
    ))
    .execute(db)
    .await?;
    terminal(db, &claimed(db, failing_claim).await?).await?;
    sqlx::query(
        "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(prefix)
    .execute(db)
    .await?;
    terminal(db, &claimed(db, prefix).await?).await?;

    // A valid timestamp in the near future turns known only after a real lock
    // wait. Sampling the pre-lock clock would incorrectly produce unknown.
    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    known(db, id, "run", -0.25).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task = tokio::spawn(async move {
        media_jobs::finish(&other, &claim, Some(JobFailure::ExecutionFailed), None).await
    });
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    held.rollback().await?;
    assert!(task.await??);
    let after = record(
        checks,
        "finish samples database authority clock after witnessed job lock wait",
        before,
        delta(4, 1, 0),
    );
    assert!(after[4].sum - before[4].sum >= 0.4);

    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    known(db, id, "run", -0.25).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT job_id FROM media_outputs WHERE job_id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task = tokio::spawn(async move { media_jobs::release(&other, &claim).await });
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    held.rollback().await?;
    assert!(task.await??);
    let after = record(
        checks,
        "release samples only after witnessed output lock wait",
        before,
        delta(6, 1, 0),
    );
    assert!(after[6].sum - before[6].sum >= 0.4);
    terminal(db, &claimed(db, id).await?).await?;

    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    known(db, id, "run", -0.25).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT job_id FROM media_outputs WHERE job_id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task =
        tokio::spawn(
            async move { media_outputs::publish(&other, &claim, &output(true), true).await },
        );
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    held.rollback().await?;
    assert!(task.await??);
    let after = record(
        checks,
        "complete publication samples only after witnessed output lock wait",
        before,
        delta(3, 1, 0),
    );
    assert!(after[3].sum - before[3].sum >= 0.4);

    let id = legacy(db, owned, "running", 1, 3).await?;
    known(db, id, "run", -3600.).await?;
    let before = observations().0;
    cancel(db, CancellationScope::Session(id)).await?;
    record(
        checks,
        "future finite phase entry is typed unknown and contributes no zero duration",
        before,
        delta(5, 0, 1),
    );

    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    sqlx::query("UPDATE media_jobs SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1").bind(id).execute(db).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task = tokio::spawn(async move {
        media_jobs::finish(&other, &claim, Some(JobFailure::ExecutionFailed), None).await
    });
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(650)).await;
    held.rollback().await?;
    assert!(!task.await??);
    assert_eq!(state(db, id).await?, "running");
    record(
        checks,
        "final live-lease fence after lock wait wins and publishes no phase sample",
        before,
        [(0, 0); 7],
    );
    cancel(db, CancellationScope::Session(id)).await?;

    let id = enqueue(db, owned).await?;
    let claim = claimed(db, id).await?;
    sqlx::query("UPDATE media_jobs SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1").bind(id).execute(db).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task =
        tokio::spawn(
            async move { media_outputs::publish(&other, &claim, &output(true), true).await },
        );
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(650)).await;
    held.rollback().await?;
    assert!(!task.await??);
    assert_eq!(state(db, id).await?, "running");
    record(
        checks,
        "complete publish rechecks expired lease after lock wait and publishes no sample",
        before,
        [(0, 0); 7],
    );
    cancel(db, CancellationScope::Session(id)).await?;

    // The later sorted row is held. A MATERIALIZED CTE alone may expose the
    // first row early; the bulk tick must depend on draining every locked row.
    let a = enqueue(db, owned).await?;
    let b = enqueue(db, owned).await?;
    let mut ordered = [a, b];
    ordered.sort();
    known(db, ordered[0], "queue", 2.).await?;
    known(db, ordered[1], "queue", -0.25).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=ANY($1)")
        .bind(&ordered[..])
        .execute(db)
        .await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(ordered[1])
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task =
        tokio::spawn(async move { cancel(&other, CancellationScope::StoppedSessions).await });
    wait_for_lock(db).await?;
    tokio::time::sleep(Duration::from_millis(700)).await;
    held.rollback().await?;
    task.await??;
    let after = record(
        checks,
        "bulk tick drains all locks including blocked second row before sampling",
        before,
        delta(2, 2, 0),
    );
    assert!(after[2].sum - before[2].sum >= 3.);

    let user = Uuid::new_v4();
    users.push(user);
    sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'fixture-only')")
        .bind(user)
        .bind(format!("phase-{user}"))
        .execute(db)
        .await?;
    let id = enqueue_scoped(db, owned, user, None).await?;
    let unrelated = enqueue(db, owned).await?;
    let before = observations().0;
    cancel(
        db,
        CancellationScope::OwnedSession {
            session: id,
            user: Uuid::new_v4(),
        },
    )
    .await?;
    assert_eq!(state(db, id).await?, "queued");
    record(
        checks,
        "current OwnedSession rejects wrong user inside mutation predicate",
        before,
        [(0, 0); 7],
    );
    let before = observations().0;
    cancel(db, CancellationScope::OwnedSession { session: id, user }).await?;
    assert_eq!(state(db, id).await?, "cancelled");
    assert_eq!(state(db, unrelated).await?, "queued");
    record(
        checks,
        "OwnedSession cancels only exact current owned session",
        before,
        delta(2, 1, 0),
    );
    let before = observations().0;
    cancel(db, CancellationScope::OwnedSession { session: id, user }).await?;
    record(
        checks,
        "duplicate scoped cancellation publishes no sample",
        before,
        [(0, 0); 7],
    );
    cancel(db, CancellationScope::Session(unrelated)).await?;

    let room = Uuid::new_v4();
    rooms.push(room);
    sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'timing scopes',$2)")
        .bind(room)
        .bind(user)
        .execute(db)
        .await?;
    let stopped = enqueue_scoped(db, owned, user, Some(room)).await?;
    let live = enqueue_scoped(db, owned, user, Some(room)).await?;
    let outside = enqueue(db, owned).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(stopped)
        .execute(db)
        .await?;
    let before = observations().0;
    cancel(db, CancellationScope::StoppedRoom(room)).await?;
    assert_eq!(state(db, stopped).await?, "cancelled");
    assert_eq!(state(db, live).await?, "queued");
    assert_eq!(state(db, outside).await?, "queued");
    record(
        checks,
        "StoppedRoom keeps live and unrelated sessions outside scope",
        before,
        delta(2, 1, 0),
    );
    let before = observations().0;
    cancel(db, CancellationScope::Room(room)).await?;
    assert_eq!(state(db, live).await?, "cancelled");
    assert_eq!(state(db, outside).await?, "queued");
    record(
        checks,
        "Room includes its live sessions and excludes unrelated room",
        before,
        delta(2, 1, 0),
    );
    cancel(db, CancellationScope::Session(outside)).await?;

    let id = enqueue(db, owned).await?;
    let before = observations().0;
    let mut tx = db.begin().await?;
    let _pending = media_job_timing::cancel_jobs(&mut *tx, CancellationScope::Session(id)).await?;
    tx.rollback().await?;
    assert_eq!(state(db, id).await?, "queued");
    record(
        checks,
        "ordinary cancellation rollback discards all pending duration and unknown evidence",
        before,
        [(0, 0); 7],
    );
    cancel(db, CancellationScope::Session(id)).await?;

    // Exact fixed-size aggregate with phase-specific known/unknown counts.
    // All stale tuples satisfy schema constraints, simulating old writers.
    let mut bulk = Vec::new();
    for (phase, count) in [("queue", 48), ("run", 48)] {
        for index in 0..count {
            let id = legacy(
                db,
                owned,
                if phase == "queue" {
                    "queued"
                } else {
                    "running"
                },
                if phase == "queue" { 0 } else { 1 },
                3,
            )
            .await?;
            bulk.push(id);
            if index < 36 {
                known(db, id, phase, [2., 15., 100000.][index % 3]).await?;
            } else if index < 40 {
                known(db, id, if phase == "queue" { "run" } else { "queue" }, 2.).await?;
            } else if index < 44 {
                known(db, id, phase, 2.).await?;
                sqlx::query("UPDATE media_jobs SET timing_attempt=attempt+1 WHERE id=$1")
                    .bind(id)
                    .execute(db)
                    .await?;
            } // 44..48 remain legacy all-null
        }
    }
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=ANY($1)")
        .bind(&bulk)
        .execute(db)
        .await?;
    let before = observations().0;
    let mut tx = db.begin().await?;
    let pending =
        media_job_timing::cancel_jobs(&mut *tx, CancellationScope::StoppedSessions).await?;
    assert!(
        std::mem::size_of_val(&pending) <= 1024,
        "returned Rust summary bounded independently of row count"
    );
    let observation = pending.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    let mut expected = delta(2, 36, 12);
    expected[5] = (36, 12);
    let after = record(
        checks,
        "96-row production cancellation returns bounded exact phase aggregates and typed unknowns",
        before,
        expected,
    );
    let expected_buckets = [0, 0, 0, 0, 0, 12, 24, 24, 24, 24, 24, 24];
    for slot in [2, 5] {
        assert_eq!(
            std::array::from_fn::<_, 12, _>(|i| after[slot].buckets[i] - before[slot].buckets[i]),
            expected_buckets
        );
        assert!(after[slot].sum - before[slot].sum >= 12. * (2. + 15. + 100000.));
    }

    let stopped = legacy(db, owned, "running", 3, 3).await?;
    known(db, stopped, "run", 2.).await?;
    let expired = legacy(db, owned, "queued", 3, 3).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(stopped)
        .execute(db)
        .await?;
    sqlx::query(
        "UPDATE playback_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(expired)
    .execute(db)
    .await?;
    let before = observations().0;
    assert!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    let mut expected = delta(5, 1, 0);
    expected[2] = (0, 1);
    record(
        checks,
        "actual claim invalid-session cancellation takes precedence over exhaustion and uses old phase",
        before,
        expected,
    );

    // An aborted actual producer awaits the locked normalization. We know the
    // acknowledgement was lost, not whether PostgreSQL eventually committed.
    let id = enqueue(db, owned).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(db)
        .await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut *held)
        .await?;
    let before = observations().0;
    let other = db.clone();
    let task = tokio::spawn(async move { media_jobs::claim(&other, Uuid::new_v4()).await });
    wait_for_lock(db).await?;
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    let (after, incomplete) = observations();
    assert_eq!(after, before);
    assert!(incomplete);
    held.rollback().await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (after, incomplete) = observations();
    assert_eq!(after, before);
    assert!(incomplete);
    checks.push(json!({"name":"lost real normalization acknowledgement records only quality gap and never fabricates timings","result":"passed","incomplete":true,"commit_outcome":"unknown"}));
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let mut owned = Vec::new();
    let mut users = Vec::new();
    let mut rooms = Vec::new();
    let mut checks = Vec::new();
    let suffix = Uuid::new_v4().simple().to_string();
    let constraints = [
        format!("job_phase_output_{suffix}"),
        format!("job_phase_claim_{suffix}"),
    ];
    let outcome = run(
        &db,
        &mut owned,
        &mut users,
        &mut rooms,
        &constraints,
        &mut checks,
    )
    .await;
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
    sqlx::query("DELETE FROM rooms WHERE id=ANY($1)")
        .bind(&rooms)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM users WHERE id=ANY($1)")
        .bind(&users)
        .execute(&db)
        .await?;
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM media_jobs WHERE id=ANY($1)")
        .bind(&owned)
        .fetch_one(&db)
        .await?;
    assert_eq!(remaining, 0);
    println!(
        "{}",
        serde_json::to_string(
            &json!({"schema_version":1,"result":if outcome.is_ok(){"passed"}else{"failed"},
        "scope":"Actual production enqueue, claim, finish, release, cancel helper and complete/partial publish against owned SQL fixtures. Rendered worker label belongs to this helper process; actual service evidence is separate. Logical phase timing does not prove physical drain.",
        "checks":checks,"cleanup":{"owned_job_ids":owned,"owned_rows_remaining":remaining,"fault_constraints_removed":true},
        "failure":outcome.as_ref().err().map(|error|format!("{error:#}"))})
        )?
    );
    db.close().await;
    outcome
}
