use persistence::{cache, cache_outputs, media_jobs};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',now()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(&db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec) VALUES($1,$1,'queued','{}')")
        .bind(id)
        .execute(&db)
        .await?;
    let first = media_jobs::claim(&db, Uuid::new_v4()).await?.unwrap();
    assert_eq!(first.id, id);
    let old_reader = cache::acquire_attempt(&db, id, 1).await?.unwrap();
    assert!(cache_outputs::claim(&db, id, 1).await?.is_none());
    assert!(media_jobs::release(&db, &first).await?);
    let second = media_jobs::claim(&db, Uuid::new_v4()).await?.unwrap();
    assert_eq!(second.attempt, 2);
    let current_reader = cache::acquire_attempt(&db, id, 2).await?.unwrap();
    assert!(
        cache::acquire_attempt(&db, id, 1).await?.is_none(),
        "stale snapshot cannot open an old output"
    );
    assert!(cache_outputs::claim(&db, id, 0).await?.is_none());
    assert!(cache_outputs::claim(&db, id, 2).await?.is_none());
    assert!(
        cache_outputs::claim(&db, id, 1).await?.is_none(),
        "old reader protects its output"
    );
    assert!(
        cache::renew(&db, old_reader).await?,
        "in-flight old response may drain"
    );
    cache::release(&db, old_reader).await?;
    let legacy = cache::acquire(&db, id).await?.unwrap();
    assert!(
        cache_outputs::claim(&db, id, 1).await?.is_none(),
        "unscoped reader protects all attempts"
    );
    cache::release(&db, legacy).await?;
    assert!(cache_outputs::candidates(&db).await?.contains(&(id, 1)));
    let (a, b) = tokio::join!(
        cache_outputs::claim(&db, id, 1),
        cache_outputs::claim(&db, id, 1)
    );
    let (a, b) = (a?, b?);
    assert_ne!(
        a.is_some(),
        b.is_some(),
        "only one cleaner despite current reader"
    );
    let old_cleaner = a.or(b).unwrap();
    assert!(cache::renew(&db, current_reader).await?);
    sqlx::query("UPDATE media_outputs SET cleanup_until=clock_timestamp()-interval '1 second',cleanup_after=clock_timestamp()-interval '1 second' WHERE job_id=$1 AND attempt=1")
        .bind(id).execute(&db).await?;
    assert!(!cache_outputs::finish(&db, old_cleaner).await?);
    let new_cleaner = cache_outputs::claim(&db, id, 1).await?.unwrap();
    assert!(!cache_outputs::finish(&db, old_cleaner).await?);
    assert!(cache_outputs::finish(&db, new_cleaner).await?);
    assert!(!cache_outputs::candidates(&db).await?.contains(&(id, 1)));
    sqlx::query("UPDATE media_outputs SET cleanup_after=clock_timestamp()-interval '1 second' WHERE job_id=$1 AND attempt=1")
        .bind(id).execute(&db).await?;
    assert!(
        cache_outputs::claim(&db, id, 1).await?.is_some(),
        "revisit late writes after cleanup"
    );
    assert!(media_jobs::renew(&db, &second).await?);
    cache::release(&db, current_reader).await?;
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
    sqlx::query("DELETE FROM cache_entries WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    println!(
        "PASS: obsolete output fencing, scoped and legacy readers, concurrent cleanup and crash recovery"
    );
    Ok(())
}
