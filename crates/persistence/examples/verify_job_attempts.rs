// Synthetic proof here isolates transaction fencing from the real output validator.
async fn finish(
    db: &sqlx::PgPool,
    claim: &persistence::media_jobs::Claim,
    failure: Option<persistence::media_jobs::JobFailure>,
) -> anyhow::Result<bool> {
    if failure.is_some() {
        persistence::media_jobs::finish(db, claim, failure, None).await
    } else {
        persistence::media_outputs::publish(
            db,
            claim,
            &persistence::media_outputs::Snapshot {
                manifest:
                    "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nindex0.m4s\n#EXT-X-ENDLIST\n"
                        .into(),
                segment_count: 1,
                files: [-1, 0]
                    .into_iter()
                    .map(|index| persistence::media_outputs::FileProof {
                        index,
                        size_bytes: 9,
                        sha256: "0".repeat(64),
                    })
                    .collect(),
            },
            true,
        )
        .await
    }
}
use persistence::media_jobs::{claim, output_dir, release, renew};
use uuid::Uuid;

// Runs only against the disposable integration database, before workers start.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',now()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(&db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,max_attempts) VALUES($1,$1,'queued','{}',5)")
        .bind(id)
        .execute(&db)
        .await?;
    let (a, b) = tokio::join!(claim(&db, owner), claim(&db, owner));
    let (a, b) = (a?, b?);
    assert_ne!(a.is_some(), b.is_some(), "one queued row has one claimant");
    let first = a.or(b).unwrap();
    assert_eq!(first.attempt, 1);
    assert!(renew(&db, &first).await?);
    sqlx::query("UPDATE media_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(
        !renew(&db, &first).await?,
        "an expired lease cannot be revived"
    );
    assert!(
        !finish(&db, &first, None).await?,
        "expired execution cannot publish"
    );
    assert!(
        claim(&db, owner).await?.is_none(),
        "expired lease must back off"
    );
    sqlx::query("UPDATE media_jobs SET available_at=now()-interval '1 second' WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    let second = claim(&db, owner).await?.unwrap();
    assert_eq!(
        second.attempt, 2,
        "even the same owner needs a fresh attempt"
    );
    assert!(!renew(&db, &first).await?);
    assert!(
        !finish(
            &db,
            &first,
            Some(persistence::media_jobs::JobFailure::ExecutionFailed)
        )
        .await?
    );
    assert!(!finish(&db, &first, None).await?);
    assert!(
        !release(&db, &first).await?,
        "old shutdown cannot release new execution"
    );
    let root = std::env::temp_dir().join(format!("rainsync-attempt-{id}"));
    let old = output_dir(&root, id, first.attempt);
    let new = output_dir(&root, id, second.attempt);
    std::fs::create_dir_all(&old)?;
    std::fs::create_dir_all(&new)?;
    std::fs::write(new.join("index.m3u8"), "current")?;
    std::fs::write(old.join("index.m3u8"), "late old writer")?;
    assert_eq!(std::fs::read_to_string(new.join("index.m3u8"))?, "current");
    assert!(
        persistence::media_jobs::finish(&db, &second, None, None)
            .await
            .is_err()
    );
    sqlx::query("UPDATE media_outputs SET status='abandoned' WHERE job_id=$1 AND attempt=$2")
        .bind(id)
        .bind(second.attempt)
        .execute(&db)
        .await?;
    assert!(
        !finish(&db, &second, None).await?,
        "missing writable output must roll back job success"
    );
    let still_running: String = sqlx::query_scalar("SELECT status FROM media_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(&db)
        .await?;
    assert_eq!(still_running, "running");
    sqlx::query("UPDATE media_outputs SET status='writing' WHERE job_id=$1 AND attempt=$2")
        .bind(id)
        .bind(second.attempt)
        .execute(&db)
        .await?;
    assert!(finish(&db, &second, None).await?);
    let published: String = sqlx::query_scalar(
        "SELECT status||':'||segment_count FROM media_outputs WHERE job_id=$1 AND attempt=$2",
    )
    .bind(id)
    .bind(second.attempt)
    .fetch_one(&db)
    .await?;
    assert_eq!(published, "published:1");
    assert!(!finish(&db, &first, None).await?);
    sqlx::query("UPDATE media_jobs SET status='queued' WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    let third = claim(&db, owner).await?.unwrap();
    assert!(release(&db, &third).await?);
    let third = claim(&db, owner).await?.unwrap();
    assert_eq!(
        third.attempt, 4,
        "shutdown release is immediately reclaimable with a new attempt"
    );
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(!renew(&db, &third).await?);
    assert!(!finish(&db, &third, None).await?);
    assert!(!release(&db, &third).await?);
    assert!(claim(&db, owner).await?.is_none());
    let state: String = sqlx::query_scalar("SELECT status||':'||error FROM media_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(&db)
        .await?;
    assert_eq!(state, "cancelled:playback_session_stopped");
    // Exercise the production default ceiling separately from the fencing test.
    sqlx::query("DELETE FROM media_outputs WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("UPDATE playback_sessions SET stopped=false WHERE id=$1;")
        .bind(id)
        .execute(&db)
        .await?;
    // This isolated fixture deliberately reuses a synthetic job at attempt zero.
    // No real resource was started; discard only this fixture's old identities.
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("UPDATE media_jobs SET status='queued',attempt=0,max_attempts=3,available_at=now() WHERE id=$1").bind(id).execute(&db).await?;
    for attempt in 1..=3 {
        let execution = claim(&db, owner).await?.unwrap();
        assert_eq!(execution.attempt, attempt);
        sqlx::query("UPDATE media_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
            .bind(id)
            .execute(&db)
            .await?;
        assert!(claim(&db, owner).await?.is_none());
        if attempt < 3 {
            let remaining: f64 = sqlx::query_scalar("SELECT extract(epoch FROM available_at-clock_timestamp())::float8 FROM media_jobs WHERE id=$1").bind(id).fetch_one(&db).await?;
            let minimum = if attempt == 1 { 2.0 } else { 5.0 };
            assert!(remaining > minimum - 1.0 && remaining <= minimum + 1.0);
            let due: String =
                sqlx::query_scalar("SELECT available_at::text FROM media_jobs WHERE id=$1")
                    .bind(id)
                    .fetch_one(&db)
                    .await?;
            assert!(claim(&db, owner).await?.is_none());
            let unchanged: String =
                sqlx::query_scalar("SELECT available_at::text FROM media_jobs WHERE id=$1")
                    .bind(id)
                    .fetch_one(&db)
                    .await?;
            assert_eq!(due, unchanged, "polling cannot reset backoff");
            sqlx::query("UPDATE media_jobs SET available_at=now()-interval '1 second' WHERE id=$1")
                .bind(id)
                .execute(&db)
                .await?;
        }
    }
    let terminal: String =
        sqlx::query_scalar("SELECT status||':'||error||':'||attempt FROM media_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(&db)
            .await?;
    assert_eq!(terminal, "failed:media_job_retry_exhausted:3");
    assert!(claim(&db, owner).await?.is_none());
    // Explicit transport failures retry atomically, with bounded jitter and
    // abandoned output isolation; repeating a finish cannot postpone backoff.
    sqlx::query("DELETE FROM media_outputs WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    // This isolated fixture deliberately reuses a synthetic job at attempt zero.
    // No real resource was started; discard only this fixture's old identities.
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("UPDATE media_jobs SET status='queued',attempt=0,max_attempts=3,available_at=now() WHERE id=$1").bind(id).execute(&db).await?;
    for attempt in 1..=3 {
        let execution = claim(&db, owner).await?.unwrap();
        assert_eq!(execution.attempt, attempt);
        assert!(
            finish(
                &db,
                &execution,
                Some(persistence::media_jobs::JobFailure::UpstreamTransient)
            )
            .await?
        );
        let state: String =
            sqlx::query_scalar("SELECT status||':'||error FROM media_jobs WHERE id=$1")
                .bind(id)
                .fetch_one(&db)
                .await?;
        assert_eq!(
            state,
            if attempt < 3 {
                "queued:upstream_transport_failed"
            } else {
                "failed:upstream_transport_retry_exhausted"
            }
        );
        let output: String =
            sqlx::query_scalar("SELECT status FROM media_outputs WHERE job_id=$1 AND attempt=$2")
                .bind(id)
                .bind(attempt)
                .fetch_one(&db)
                .await?;
        assert_eq!(output, "abandoned");
        let due: String =
            sqlx::query_scalar("SELECT available_at::text FROM media_jobs WHERE id=$1")
                .bind(id)
                .fetch_one(&db)
                .await?;
        assert!(
            !finish(
                &db,
                &execution,
                Some(persistence::media_jobs::JobFailure::UpstreamTransient)
            )
            .await?
        );
        assert!(!renew(&db, &execution).await?);
        assert_eq!(
            due,
            sqlx::query_scalar::<_, String>(
                "SELECT available_at::text FROM media_jobs WHERE id=$1"
            )
            .bind(id)
            .fetch_one(&db)
            .await?
        );
        assert!(claim(&db, owner).await?.is_none());
        if attempt < 3 {
            let remaining: f64 = sqlx::query_scalar("SELECT extract(epoch FROM available_at-clock_timestamp())::float8 FROM media_jobs WHERE id=$1").bind(id).fetch_one(&db).await?;
            let minimum = if attempt == 1 { 2.0 } else { 5.0 };
            assert!(remaining > minimum - 1.0 && remaining <= minimum + 1.0);
            sqlx::query("UPDATE media_jobs SET available_at=now()-interval '1 second' WHERE id=$1")
                .bind(id)
                .execute(&db)
                .await?;
        }
    }
    assert_eq!(
        persistence::media_jobs::terminal_error(Some("upstream_transport_retry_exhausted")),
        (502, "media_job_retry_exhausted")
    );
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM media_jobs WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM playback_sessions WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    // Remove only the unique directory created by this test.
    let resolved = root.canonicalize()?;
    assert_eq!(
        resolved.parent(),
        Some(std::env::temp_dir().canonicalize()?.as_path())
    );
    assert_eq!(resolved.file_name(), root.file_name());
    std::fs::remove_dir_all(resolved)?;
    println!(
        "PASS: concurrent claim, lease expiry, same-owner fencing, late files, stopped session"
    );
    Ok(())
}
