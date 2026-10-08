use persistence::{cache_budget::*, media_jobs::Claim};
use uuid::Uuid;

async fn job(db: &sqlx::PgPool) -> anyhow::Result<Claim> {
    let claim = Claim {
        id: Uuid::new_v4(),
        owner: Uuid::new_v4(),
        attempt: 1,
        spec: serde_json::json!({}),
    };
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',now()+interval '1 hour')").bind(claim.id).bind(claim.id.to_string()).execute(db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec,owner_id,attempt,lease_until) VALUES($1,$1,'running','{}',$2,1,now()+interval '1 hour')")
        .bind(claim.id).bind(claim.owner).execute(db).await?;
    // This database-only fixture never starts a process; its owned execution
    // can be acknowledged when the test deliberately finishes the attempt.
    sqlx::query("INSERT INTO media_executions(id,session_id,kind,job_id,attempt,owner_id) VALUES($1,$2,'job',$2,1,$3)")
        .bind(Uuid::new_v4()).bind(claim.id).bind(claim.owner).execute(db).await?;
    Ok(claim)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    let a = job(&db).await?;
    let b = job(&db).await?;
    let ticket = snapshot(&db).await?;
    let (x, y) = tokio::join!(
        reserve(&db, &a, ticket, 60, 100),
        reserve(&db, &b, ticket, 60, 100)
    );
    let (x, y) = (x?, y?);
    assert!(
        (x == Admission::Reserved && y == Admission::Changed)
            || (y == Admission::Reserved && x == Admission::Changed)
    );
    let (winner, loser) = if x == Admission::Reserved {
        (&a, &b)
    } else {
        (&b, &a)
    };
    assert_eq!(
        reserve(&db, loser, snapshot(&db).await?, 60, 100).await?,
        Admission::Full
    );
    let measured_before_release = snapshot(&db).await?;
    release(&db, winner.id, Uuid::new_v4(), winner.attempt).await?;
    assert_eq!(
        snapshot(&db).await?,
        measured_before_release,
        "foreign owner cannot release budget"
    );
    persistence::media_executions::acknowledge_job(&db, winner.id, winner.attempt, winner.owner)
        .await?;
    release(&db, winner.id, winner.owner, winner.attempt).await?;
    assert_eq!(
        reserve(&db, loser, measured_before_release, 60, 100).await?,
        Admission::Changed,
        "released output invalidates earlier disk measurement"
    );
    assert_eq!(
        reserve(&db, loser, snapshot(&db).await?, 60, 100).await?,
        Admission::Reserved
    );
    assert_eq!(
        reserve(&db, winner, snapshot(&db).await?, 60, 100).await?,
        Admission::Stale,
        "a positively reaped attempt cannot resume reserving output"
    );
    let next = job(&db).await?;
    sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE id=$1")
        .bind(loser.id)
        .execute(&db)
        .await?;
    let before = snapshot(&db).await?;
    assert_eq!(
        reserve(&db, &next, before, 60, 100).await?,
        Admission::Full,
        "cancelled writer retains reservation until positively reaped"
    );
    sqlx::query("UPDATE media_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(loser.id)
        .execute(&db)
        .await?;
    assert_eq!(snapshot(&db).await?, before, "expiry is not process exit");
    persistence::media_executions::acknowledge_job(&db, loser.id, loser.attempt, loser.owner)
        .await?;
    let after = snapshot(&db).await?;
    assert!(after > before);
    assert_eq!(reserve(&db, loser, after, 60, 100).await?, Admission::Stale);
    assert_eq!(
        reserve(&db, &next, after, 60, 100).await?,
        Admission::Reserved
    );
    let old_measurement = snapshot(&db).await?;
    persistence::media_executions::acknowledge_job(&db, next.id, next.attempt, next.owner).await?;
    // A proven release invalidates measurements even when snapshot does it.
    assert!(snapshot(&db).await? > old_measurement);
    let no_reservation = snapshot(&db).await?;
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(winner.id)
        .execute(&db)
        .await?;
    sqlx::query("DELETE FROM media_jobs WHERE id=$1")
        .bind(winner.id)
        .execute(&db)
        .await?;
    assert_eq!(snapshot(&db).await?, no_reservation);
    for claim in [&a, &b, &next] {
        sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
            .bind(claim.id)
            .execute(&db)
            .await?;
        sqlx::query("DELETE FROM media_jobs WHERE id=$1")
            .bind(claim.id)
            .execute(&db)
            .await?;
        sqlx::query("DELETE FROM playback_sessions WHERE id=$1")
            .bind(claim.id)
            .execute(&db)
            .await?;
    }
    println!(
        "PASS: concurrent cache reservations, stale measurements, fenced release and receipt-only writer reclaim"
    );
    Ok(())
}
