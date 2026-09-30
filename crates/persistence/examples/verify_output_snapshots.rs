use persistence::{
    media_jobs::{self, Claim},
    media_outputs::{FileProof, Snapshot, publish},
};
use sqlx::Row;
use uuid::Uuid;

fn snapshot(count: i32, complete: bool, indices: &[i32]) -> Snapshot {
    let mut manifest = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n".to_owned();
    for index in 0..count {
        manifest.push_str(&format!("#EXTINF:4,\nindex{index}.m4s\n"));
    }
    if complete {
        manifest.push_str("#EXT-X-ENDLIST\n");
    }
    Snapshot {
        manifest,
        segment_count: count,
        files: indices
            .iter()
            .map(|&index| FileProof {
                index,
                size_bytes: 18,
                sha256: "0".repeat(64),
            })
            .collect(),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',now()+interval '1 hour')").bind(id).bind(id.to_string()).execute(&db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec) VALUES($1,$1,'queued','{}')")
        .bind(id)
        .execute(&db)
        .await?;
    let claim = media_jobs::claim(&db, Uuid::new_v4()).await?.unwrap();
    assert!(
        publish(&db, &claim, &snapshot(1, false, &[-1]), false)
            .await
            .is_err()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM media_output_files WHERE job_id=$1")
            .bind(id)
            .fetch_one(&db)
            .await?,
        0
    );
    assert!(publish(&db, &claim, &snapshot(1, false, &[-1, 0]), false).await?);
    assert!(
        publish(&db, &claim, &snapshot(1, false, &[-1, 0]), false).await?,
        "same proof retries are idempotent"
    );
    let proof = media_jobs::Publication {
        manifest_sha256: "0".repeat(64),
        segment_count: 1,
    };
    assert!(
        !media_jobs::finish(&db, &claim, None, Some(&proof)).await?,
        "old completion cannot bypass version-2 publication"
    );
    let wrong = Claim {
        id,
        owner: Uuid::new_v4(),
        attempt: claim.attempt,
        spec: claim.spec.clone(),
    };
    assert!(!publish(&db, &wrong, &snapshot(1, false, &[]), false).await?);
    let mut changed = snapshot(2, false, &[0, 1]);
    changed.files[0].sha256 = "1".repeat(64);
    assert!(publish(&db, &claim, &changed, false).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM media_output_files WHERE job_id=$1")
            .bind(id)
            .fetch_one(&db)
            .await?,
        2
    );
    // Lease is checked again after a blocking row lock, not just before waiting.
    let mut locked = db.begin().await?;
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *locked)
        .await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *locked)
        .await?;
    let waiting_db = db.clone();
    let waiting_claim = Claim {
        id,
        owner: claim.owner,
        attempt: claim.attempt,
        spec: claim.spec.clone(),
    };
    let waiting = tokio::spawn(async move {
        publish(
            &waiting_db,
            &waiting_claim,
            &snapshot(2, false, &[1]),
            false,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))")
                .bind(blocker).fetch_one(&db).await?;
            if blocked { return Ok::<_, anyhow::Error>(()); }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await??;
    sqlx::query(
        "UPDATE media_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&mut *locked)
    .await?;
    locked.commit().await?;
    assert!(!waiting.await??);
    sqlx::query(
        "UPDATE media_jobs SET lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1",
    )
    .bind(id)
    .execute(&db)
    .await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(!publish(&db, &claim, &snapshot(2, false, &[1]), false).await?);
    sqlx::query("UPDATE playback_sessions SET stopped=false WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(publish(&db, &claim, &snapshot(2, false, &[1]), false).await?);
    assert!(
        publish(&db, &claim, &snapshot(1, false, &[]), false)
            .await
            .is_err()
    );
    sqlx::query("CREATE FUNCTION test_output_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='published' THEN RAISE EXCEPTION 'injected output commit failure'; END IF; RETURN NEW; END $$").execute(&db).await?;
    sqlx::query("CREATE TRIGGER test_output_commit_failure BEFORE UPDATE ON media_outputs FOR EACH ROW EXECUTE FUNCTION test_output_commit_failure()").execute(&db).await?;
    assert!(
        publish(&db, &claim, &snapshot(2, true, &[]), true)
            .await
            .is_err()
    );
    let row = sqlx::query("SELECT j.status,o.visible_manifest,o.ready_segments FROM media_jobs j JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt WHERE j.id=$1").bind(id).fetch_one(&db).await?;
    assert_eq!(row.get::<String, _>("status"), "running");
    assert_eq!(row.get::<i32, _>("ready_segments"), 2);
    assert!(!row.get::<String, _>("visible_manifest").contains("ENDLIST"));
    sqlx::query("DROP TRIGGER test_output_commit_failure ON media_outputs")
        .execute(&db)
        .await?;
    sqlx::query("DROP FUNCTION test_output_commit_failure()")
        .execute(&db)
        .await?;
    assert!(publish(&db, &claim, &snapshot(2, true, &[]), true).await?);
    let row = sqlx::query("SELECT j.status,o.visible_manifest,o.segment_count FROM media_jobs j JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt WHERE j.id=$1").bind(id).fetch_one(&db).await?;
    assert_eq!(row.get::<String, _>("status"), "succeeded");
    assert_eq!(row.get::<i32, _>("segment_count"), 2);
    assert!(
        row.get::<String, _>("visible_manifest")
            .ends_with("#EXT-X-ENDLIST\n")
    );
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM media_jobs WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM media_output_files WHERE job_id=$1")
            .bind(id)
            .fetch_one(&db)
            .await?,
        0
    );
    sqlx::query("DELETE FROM playback_sessions WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    println!(
        "PASS: immutable segment proofs, atomic snapshot/final publication, lease fencing after locks and rollback"
    );
    Ok(())
}
