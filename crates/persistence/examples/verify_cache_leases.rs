use persistence::cache::*;
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',now()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(&db).await?;
    let a = acquire(&db, id).await?.unwrap();
    let b = acquire(&db, id).await?.unwrap();
    assert!(renew(&db, a).await?);
    assert!(claim_eviction(&db, id).await?.is_none());
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(!renew(&db, a).await?, "revocation prevents renewal");
    assert!(
        claim_eviction(&db, id).await?.is_none(),
        "existing readers block eviction even after stop"
    );
    release(&db, a).await?;
    assert!(
        claim_eviction(&db, id).await?.is_none(),
        "second reader still protects files"
    );
    sqlx::query("UPDATE playback_sessions SET stopped=false WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("UPDATE cache_read_leases SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(b.id)
        .execute(&db)
        .await?;
    assert!(!renew(&db, b).await?, "expired reader cannot resurrect");
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    let (first, second) = tokio::join!(claim_eviction(&db, id), claim_eviction(&db, id));
    let (first, second) = (first?, second?);
    assert_ne!(first.is_some(), second.is_some(), "one eviction owner");
    let old_owner = first.or(second).unwrap();
    // Even a later authorization change cannot reopen an evicting entry.
    sqlx::query("UPDATE playback_sessions SET stopped=false WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(acquire(&db, id).await?.is_none());
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    sqlx::query("UPDATE cache_entries SET eviction_until=now()-interval '1 second' WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    assert!(
        !finish_eviction(&db, id, old_owner).await?,
        "expired cleaner cannot publish completion"
    );
    let owner = claim_eviction(&db, id).await?.unwrap();
    assert!(
        !finish_eviction(&db, id, old_owner).await?,
        "old cleaner cannot finish replacement claim"
    );
    assert!(finish_eviction(&db, id, owner).await?);
    assert!(acquire(&db, id).await?.is_none());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM cache_read_leases WHERE cache_id=$1")
            .bind(id)
            .fetch_one(&db)
            .await?,
        0
    );
    sqlx::query("UPDATE cache_entries SET evicted_at=now()-interval '49 hours' WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    cleanup(&db).await?;
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM cache_entries WHERE id=$1)")
            .bind(id)
            .fetch_one(&db)
            .await?,
        "session still pins eviction tombstone"
    );
    sqlx::query("DELETE FROM playback_sessions WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await?;
    cleanup(&db).await?;
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM cache_entries WHERE id=$1)")
            .bind(id)
            .fetch_one(&db)
            .await?
    );
    println!(
        "PASS: cache readers protect stopped sessions; expired leases, eviction fencing and crash reclaim"
    );
    Ok(())
}
