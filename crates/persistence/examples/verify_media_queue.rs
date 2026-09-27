use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Barrier;
use uuid::Uuid;

async fn admit(db: PgPool, id: Uuid, barrier: Arc<Barrier>) -> anyhow::Result<bool> {
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',now()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(&mut *tx).await?;
    barrier.wait().await;
    let admitted = persistence::media_queue::enqueue(&mut tx, id, &json!({}), 1).await?;
    if admitted {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(admitted)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let barrier = Arc::new(Barrier::new(2));
    let (x, y) = tokio::join!(
        admit(db.clone(), a, barrier.clone()),
        admit(db.clone(), b, barrier)
    );
    let (x, y) = (x?, y?);
    assert_ne!(x, y, "concurrent admission must occupy exactly one slot");
    let (winner, loser) = if x { (a, b) } else { (b, a) };
    let missing: bool =
        sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1)")
            .bind(loser)
            .fetch_one(&db)
            .await?;
    assert!(missing, "queue rejection rolls back the associated session");
    sqlx::query("UPDATE media_jobs SET status='running' WHERE id=$1")
        .bind(winner)
        .execute(&db)
        .await?;
    assert!(
        !admit(db.clone(), loser, Arc::new(Barrier::new(1))).await?,
        "running jobs still occupy capacity"
    );
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(winner)
        .execute(&db)
        .await?;
    assert!(
        admit(db.clone(), loser, Arc::new(Barrier::new(1))).await?,
        "revoked grants do not occupy queue capacity"
    );
    sqlx::query("DELETE FROM media_jobs WHERE id=ANY($1)")
        .bind(vec![a, b])
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM playback_sessions WHERE id=ANY($1)")
        .bind(vec![a, b])
        .execute(&db)
        .await?;
    println!(
        "PASS: concurrent global queue admission, running capacity, rollback and revoked-grant reclamation"
    );
    Ok(())
}
