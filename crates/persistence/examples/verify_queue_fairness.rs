use persistence::media_jobs::claim;
use sqlx::PgPool;
use uuid::Uuid;

async fn job(db: &PgPool, user: Option<Uuid>, order: i32) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,user_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,0,$3,'{}',now()+interval '1 hour')")
        .bind(id).bind(user).bind(id.to_string()).execute(db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,created_at) VALUES($1,$1,'queued','{}',now()+$2::integer*interval '1 second')")
        .bind(id).bind(order).execute(db).await?;
    Ok(id)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let url = std::env::var("DATABASE_URL")?;
    let db = persistence::connect(&url).await?;
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for user in [a, b] {
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'isolated-test')")
            .bind(user)
            .bind(user.to_string())
            .execute(&db)
            .await?;
    }
    let a1 = job(&db, Some(a), -30).await?;
    let a2 = job(&db, Some(a), -29).await?;
    let a3 = job(&db, Some(a), -28).await?;
    let b1 = job(&db, Some(b), -20).await?;
    let b2 = job(&db, Some(b), -19).await?;
    let mut ids = vec![a1, a2, a3, b1, b2];
    assert_eq!(claim(&db, Uuid::new_v4()).await?.unwrap().id, a1);
    // A fresh pool/owner must observe the persisted turn, not restart FIFO.
    let other = persistence::connect(&url).await?;
    for expected in [b1, a2, b2, a3] {
        assert_eq!(claim(&other, Uuid::new_v4()).await?.unwrap().id, expected);
    }
    assert!(claim(&db, Uuid::new_v4()).await?.is_none());
    let a4 = job(&db, Some(a), -10).await?;
    let b3 = job(&db, Some(b), -9).await?;
    ids.extend([a4, b3]);
    let before: Vec<(Option<Uuid>, i64)> = sqlx::query_as(
        "SELECT user_id,last_turn FROM media_queue_turns WHERE user_id=ANY($1) ORDER BY user_id",
    )
    .bind(vec![a, b])
    .fetch_all(&db)
    .await?;
    sqlx::query(
        "ALTER TABLE media_outputs ADD CONSTRAINT reject_fairness_output CHECK (false) NOT VALID",
    )
    .execute(&db)
    .await?;
    assert!(claim(&db, Uuid::new_v4()).await.is_err());
    sqlx::query("ALTER TABLE media_outputs DROP CONSTRAINT reject_fairness_output")
        .execute(&db)
        .await?;
    let after: Vec<(Option<Uuid>, i64)> = sqlx::query_as(
        "SELECT user_id,last_turn FROM media_queue_turns WHERE user_id=ANY($1) ORDER BY user_id",
    )
    .bind(vec![a, b])
    .fetch_all(&db)
    .await?;
    assert_eq!(
        before, after,
        "failed publication allocation cannot consume a user's turn"
    );
    let (x, y) = tokio::join!(claim(&db, Uuid::new_v4()), claim(&other, Uuid::new_v4()));
    let mut got = vec![x?.unwrap().id, y?.unwrap().id];
    got.sort();
    let mut expected = vec![a4, b3];
    expected.sort();
    assert_eq!(
        got, expected,
        "concurrent workers serve distinct users without duplicate grants"
    );
    let a5 = job(&db, Some(a), -8).await?;
    let b4 = job(&db, Some(b), -7).await?;
    ids.extend([a5, b4]);
    sqlx::query("UPDATE media_queue_turns SET last_turn=CASE WHEN user_id=$1 THEN 0 ELSE 1 END WHERE user_id=ANY($2)").bind(a).bind(vec![a,b]).execute(&db).await?;
    let mut held = db.begin().await?;
    sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
        .bind(a5)
        .execute(&mut *held)
        .await?;
    let selected = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        claim(&other, Uuid::new_v4()),
    )
    .await??
    .unwrap();
    assert_eq!(
        selected.id, b4,
        "locked older job cannot stall another user"
    );
    held.rollback().await?;
    sqlx::query("UPDATE media_jobs SET available_at=now()+interval '1 hour' WHERE id=$1")
        .bind(a5)
        .execute(&db)
        .await?;
    let legacy = job(&db, None, -6).await?;
    ids.push(legacy);
    assert_eq!(
        claim(&db, Uuid::new_v4()).await?.unwrap().id,
        legacy,
        "backoff excludes ineligible user's turn"
    );
    sqlx::query("UPDATE media_jobs SET available_at=now()-interval '1 second' WHERE id=$1")
        .bind(a5)
        .execute(&db)
        .await?;
    assert_eq!(claim(&db, Uuid::new_v4()).await?.unwrap().id, a5);
    sqlx::query("DELETE FROM media_jobs WHERE id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM playback_sessions WHERE id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM users WHERE id=ANY($1)")
        .bind(vec![a, b])
        .execute(&db)
        .await?;
    println!(
        "PASS: persisted per-user turns, FIFO within user, concurrent claims, rollback, locked jobs and backoff"
    );
    Ok(())
}
