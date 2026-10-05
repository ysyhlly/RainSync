//! Real PostgreSQL scheduling/fencing only. No media operation is started and
//! the image bytes are synthetic; this never supplies physical drain evidence.
use persistence::media_previews::{Attempt, claim_with_limit, enqueue, finish, renew};
use sqlx::PgPool;
use uuid::Uuid;

async fn media(db: &PgPool, source: Uuid) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,'owned recovery fixture',$3)")
        .bind(id).bind(source).bind(id.to_string()).execute(db).await?;
    Ok(id)
}
async fn advance(db: &PgPool, id: Uuid) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar("UPDATE media_items SET preview_generation=preview_generation+1 WHERE id=$1 RETURNING preview_generation")
        .bind(id).fetch_one(db).await?)
}
async fn row(db: &PgPool, id: Uuid) -> anyhow::Result<(String, i64, i32, Option<Uuid>)> {
    Ok(sqlx::query_as(
        "SELECT status,source_generation,attempt,attempt_id FROM media_previews WHERE media_id=$1",
    )
    .bind(id)
    .fetch_one(db)
    .await?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("RAINSYNC_FIXTURE_DATABASE")?).await?;
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&db)
        .await?;
    anyhow::ensure!(
        database.starts_with("rainsync_"),
        "owned fixture database required"
    );
    let receipts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM media_executions),(SELECT count(*) FROM agent_transfer_runs)",
    )
    .fetch_one(&db)
    .await?;
    let source = Uuid::new_v4();
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted) VALUES($1,'owned queue recovery','local','no-media-operation')").bind(source).execute(&db).await?;
    let owner = Uuid::new_v4();
    let id = media(&db, source).await?;
    let mut ids = vec![id];
    assert!(enqueue(&db, &[id], 1).await?);
    let old = claim_with_limit(&db, owner, 1).await?.unwrap();
    let generation = advance(&db, id).await?;
    // New input does not permit reclaiming a still-leased old owner.
    assert!(claim_with_limit(&db, Uuid::new_v4(), 1).await?.is_none());
    assert_eq!(row(&db, id).await?.3, Some(old.attempt_id));
    assert!(!renew(&db, &old).await?);
    assert!(
        !finish(
            &db,
            &old,
            Some((b"old synthetic image", &"0".repeat(64))),
            false,
            1024
        )
        .await?
    );
    // Expire only this synthetic row; no subprocess/file/socket ever existed.
    sqlx::query("UPDATE media_previews SET attempt=3,lease_until=clock_timestamp()-interval '1 second' WHERE media_id=$1").bind(id).execute(&db).await?;
    let current = claim_with_limit(&db, Uuid::new_v4(), 1).await?.unwrap();
    assert_eq!(current.generation, generation);
    assert_ne!(old.attempt_id, current.attempt_id);
    assert_eq!(row(&db, id).await?.2, 1);
    assert!(!renew(&db, &old).await?);
    assert!(
        !finish(
            &db,
            &old,
            Some((b"late synthetic image", &"0".repeat(64))),
            false,
            1024
        )
        .await?
    );
    let mut foreign = current.clone();
    foreign.owner_id = Uuid::new_v4();
    assert!(!renew(&db, &foreign).await?);
    assert!(!finish(&db, &foreign, None, true, 1024).await?);
    println!(
        "PASS: live stale owner is not reclaimed; changed-input expired owner gets a new UUID/budget; old/foreign owners cannot renew or publish"
    );

    let mut attempt: Attempt = current;
    for number in 1..=3 {
        assert!(finish(&db, &attempt, None, true, 1024).await?);
        let state = row(&db, id).await?;
        assert_eq!(state.2, number);
        assert_eq!(state.0, if number < 3 { "queued" } else { "unavailable" });
        assert!(
            claim_with_limit(&db, owner, 1).await?.is_none(),
            "polling respects backoff/terminal state"
        );
        assert!(!finish(&db, &attempt, None, true, 1024).await?);
        if number < 3 {
            sqlx::query("UPDATE media_previews SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE media_id=$1").bind(id).execute(&db).await?;
            attempt = claim_with_limit(&db, owner, 1).await?.unwrap();
        }
    }
    assert!(claim_with_limit(&db, owner, 1).await?.is_none());
    println!(
        "PASS: unchanged new input still exhausts exactly three attempts; polling and duplicate failure do not reset its budget"
    );

    // A visible live owner consumes the only slot. Stale queued work stays
    // pending until the slot is free rather than amplifying admission capacity.
    let visible = media(&db, source).await?;
    ids.push(visible);
    assert!(enqueue(&db, &[visible], 1).await?);
    let occupied = claim_with_limit(&db, owner, 1).await?.unwrap();
    let a = media(&db, source).await?;
    ids.push(a);
    let b = media(&db, source).await?;
    ids.push(b);
    for next in [a, b] {
        sqlx::query("INSERT INTO media_previews(media_id,source_generation,recipe_version,status) SELECT id,preview_generation,2,'queued' FROM media_items WHERE id=$1").bind(next).execute(&db).await?;
        advance(&db, next).await?;
    }
    assert!(claim_with_limit(&db, owner, 1).await?.is_none());
    for next in [a, b] {
        assert_eq!(row(&db, next).await?.1, 1);
    }
    assert!(finish(&db, &occupied, None, false, 1024).await?);
    let (x, y) = tokio::try_join!(
        claim_with_limit(&db, owner, 1),
        claim_with_limit(&db, Uuid::new_v4(), 1)
    )?;
    assert_ne!(
        x.is_some(),
        y.is_some(),
        "only one stale request may occupy the free slot"
    );
    let selected = x.or(y).unwrap();
    assert_eq!(selected.generation, 2);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM media_previews p JOIN media_items m ON m.id=p.media_id WHERE m.source_id=$1 AND p.source_generation=m.preview_generation AND p.status IN ('queued','running')").bind(source).fetch_one(&db).await?;
    assert_eq!(count, 1);
    let other = if selected.media_id == a { b } else { a };
    assert_eq!(row(&db, other).await?.1, 1);
    let rejected = media(&db, source).await?;
    ids.push(rejected);
    assert!(!enqueue(&db, &[rejected], 1).await?);
    assert!(finish(&db, &selected, None, false, 1024).await?);
    let second = claim_with_limit(&db, owner, 1).await?.unwrap();
    assert_eq!(second.media_id, other);
    assert!(finish(&db, &second, None, false, 1024).await?);
    println!(
        "PASS: configured slot bound, concurrent claims and enqueue use one capacity lock; deferred stale request eventually resumes"
    );

    let unavailable = media(&db, source).await?;
    ids.push(unavailable);
    assert!(enqueue(&db, &[unavailable], 1).await?);
    advance(&db, unavailable).await?;
    sqlx::query("UPDATE media_items SET available=false WHERE id=$1")
        .bind(unavailable)
        .execute(&db)
        .await?;
    assert!(claim_with_limit(&db, owner, 1).await?.is_none());
    assert_eq!(row(&db, unavailable).await?.1, 1);
    assert!(claim_with_limit(&db, owner, 0).await.is_err());
    assert!(claim_with_limit(&db, owner, 4097).await.is_err());
    println!("PASS: invisible source and invalid limits cannot enter recovery");
    let final_receipts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM media_executions),(SELECT count(*) FROM agent_transfer_runs)",
    )
    .fetch_one(&db)
    .await?;
    assert_eq!(
        receipts, final_receipts,
        "queue recovery supplies no physical release proof"
    );
    sqlx::query("DELETE FROM media_previews WHERE media_id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM media_items WHERE id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM sources WHERE id=$1")
        .bind(source)
        .execute(&db)
        .await?;
    println!(
        "PASS: recovery never adds execution/Agent drain evidence; all synthetic fixture records removed"
    );
    Ok(())
}
