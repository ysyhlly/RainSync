//! Invoked only by the owned database fixture; never discovers DATABASE_URL.
use persistence::media_previews::*;
use sqlx::Row;
use uuid::Uuid;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"),
        "fixture only"
    );
    let db = persistence::connect(&std::env::var("RAINSYNC_FIXTURE_DATABASE")?).await?;
    let row=sqlx::query("SELECT p.image,p.image_sha256,m.source_id FROM media_previews p JOIN media_items m ON m.id=p.media_id WHERE p.status='ready' LIMIT 1").fetch_one(&db).await?;
    let image: Vec<u8> = row.get("image");
    let sha: String = row.get("image_sha256");
    let source: Uuid = row.get("source_id");
    sqlx::query("DELETE FROM media_previews")
        .execute(&db)
        .await?;
    let mut ids = vec![];
    for i in 0..3 {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,'queue fixture',$3)",
        )
        .bind(id)
        .bind(source)
        .bind(format!("queue-{i}"))
        .execute(&db)
        .await?;
        ids.push(id);
    }
    assert!(enqueue(&db, &ids[..2], 2).await?);
    assert!(!enqueue(&db, &ids[2..], 2).await?);
    let owner = Uuid::new_v4();
    let (a, b) = tokio::try_join!(claim(&db, owner), claim(&db, owner))?;
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a.media_id, b.media_id);
    assert!(claim(&db, owner).await?.is_none());
    let mut wrong = a.clone();
    wrong.attempt_id = Uuid::new_v4();
    assert!(!finish(&db, &wrong, Some((&image, &sha)), false, 1048576).await?);
    assert!(renew(&db, &a).await?);
    sqlx::query("UPDATE media_previews SET lease_until=clock_timestamp()-interval '1 second' WHERE media_id=$1").bind(a.media_id).execute(&db).await?;
    assert!(!finish(&db, &a, Some((&image, &sha)), false, 1048576).await?);
    let newer = claim(&db, owner).await?.unwrap();
    assert_ne!(a.attempt_id, newer.attempt_id);
    assert!(!finish(&db, &a, Some((&image, &sha)), false, 1048576).await?);
    sqlx::query("UPDATE media_items SET preview_generation=preview_generation+1 WHERE id=$1")
        .bind(newer.media_id)
        .execute(&db)
        .await?;
    assert!(!finish(&db, &newer, Some((&image, &sha)), false, 1048576).await?);
    assert!(!renew(&db, &newer).await?);
    assert!(finish(&db, &b, Some((&image, &sha)), false, image.len() as i64).await?);
    // Replace stale work without counting its own occupied slot against it.
    assert!(enqueue(&db, &[newer.media_id], 1).await?);
    let c = claim(&db, owner).await?.unwrap();
    assert!(finish(&db, &c, Some((&image, &sha)), false, image.len() as i64).await?);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM media_previews WHERE status='ready'")
        .fetch_one(&db)
        .await?;
    assert_eq!(
        count, 1,
        "LRU eviction stays inside the shared cache budget"
    );
    // Invisible/stale work must not exhaust capacity for currently visible media.
    assert!(enqueue(&db, &[ids[2]], 1).await?);
    sqlx::query("UPDATE media_items SET available=false WHERE id=$1")
        .bind(ids[2])
        .execute(&db)
        .await?;
    let replacement = Uuid::new_v4();
    sqlx::query("INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,'replacement','replacement')").bind(replacement).bind(source).execute(&db).await?;
    assert!(enqueue(&db, &[replacement], 1).await?);
    let too_large = claim(&db, owner).await?.unwrap();
    assert_eq!(too_large.media_id, replacement);
    assert!(finish(&db, &too_large, Some((&image, &sha)), false, 1).await?);
    let status: String = sqlx::query_scalar("SELECT status FROM media_previews WHERE media_id=$1")
        .bind(replacement)
        .fetch_one(&db)
        .await?;
    assert_eq!(status, "unavailable");
    println!(
        "PASS: distinct concurrent claims, attempt/lease/source fences, requeue capacity and transactional LRU budget"
    );
    Ok(())
}
