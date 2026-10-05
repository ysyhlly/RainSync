use persistence::media_jobs::claim;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

async fn job(db: &PgPool, user: Option<Uuid>, order: i32) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    let mut tx = db.begin().await?;
    if let Some(user) = user {
        let login = hex::encode(Sha256::digest(user.as_bytes()));
        let epoch = persistence::room_lifecycle::lock_active(&mut tx, user).await?;
        let membership = persistence::media_authorization::capture(&mut tx, user, user, &login)
            .await?
            .ok_or_else(|| anyhow::anyhow!("isolated fairness login and membership required"))?;
        // Admit this explicitly created fixture login before minting its grant.
        sqlx::query("INSERT INTO playback_requests(user_id,idempotency_key,request_hash,session_id,owner_epoch,status,lease_until,expires_at,room_id,lifecycle_epoch,auth_login_hash,auth_membership_epoch) VALUES($1,$2,'owned-fairness-fixture',$2,$3,'pending',now()+interval '1 minute',now()+interval '1 hour',$1,$4,$5,$6)")
            .bind(user).bind(id).bind(Uuid::new_v4()).bind(epoch).bind(login).bind(membership).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,$2,0,$3,'{}',now()+interval '1 hour')")
        .bind(id).bind(user).bind(id.to_string()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,created_at) VALUES($1,$1,'queued','{}',now()+$2::integer*interval '1 second')")
        .bind(id).bind(order).execute(&mut *tx).await?;
    if user.is_some() {
        sqlx::query("UPDATE playback_requests SET status='completed',response_encrypted='owned-synthetic-fixture-not-api-replay' WHERE session_id=$1")
            .bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
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
        let login = hex::encode(Sha256::digest(user.as_bytes()));
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'owned-fairness-fixture',now()+interval '1 hour')")
            .bind(login).bind(user).execute(&db).await?;
        // Each synthetic user owns an isolated room with the same fixture ID.
        sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'owned fairness fixture',$1)")
            .bind(user)
            .execute(&db)
            .await?;
        sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$1)")
            .bind(user)
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
    sqlx::query("DELETE FROM media_executions WHERE job_id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM media_jobs WHERE id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM playback_sessions WHERE id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM playback_requests WHERE session_id=ANY($1)")
        .bind(&ids)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM rooms WHERE id=ANY($1)")
        .bind(vec![a, b])
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=ANY($1)")
        .bind(vec![a, b])
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
