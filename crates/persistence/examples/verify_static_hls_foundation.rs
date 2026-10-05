//! Only the owned Stage A native fixture supplies these IDs and database.
//! This is a queue/physical-connection test driver, never a decoder dispatcher.
use anyhow::{Result, ensure};
use media_core::static_hls::CapturePermit as _;
use sqlx::{Row, postgres::PgPoolOptions};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use uuid::Uuid;

struct EpochGate {
    epoch: Arc<AtomicU64>,
    first: Arc<tokio::sync::Notify>,
}
impl persistence::static_hls::ActivationCheck for EpochGate {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async {
            self.first.notify_one();
            ensure!(
                self.epoch.load(Ordering::SeqCst) == 1,
                "owned_fixture_epoch_changed"
            );
            Ok(())
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let url = std::env::var("DATABASE_URL")?;
    ensure!(
        url.contains("@127.0.0.1:"),
        "owned loopback PostgreSQL required"
    );
    let session: Uuid = std::env::var("RAINSYNC_STATIC_HLS_SESSION")?.parse()?;
    let pool = persistence::connect(&url).await?;
    let mut connections = Vec::new();
    for _ in 0..12 {
        let mut connection = pool.acquire().await?;
        let supported: bool = sqlx::query_scalar("SELECT static_hls_reader_supported()")
            .fetch_one(&mut *connection)
            .await?;
        ensure!(supported, "physical connection missing contract");
        connections.push(connection);
    }
    let connection = connections.pop().unwrap();
    connection.close().await?;
    let mut replacement = pool.acquire().await?;
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT static_hls_reader_supported()")
            .fetch_one(&mut *replacement)
            .await?,
        "replacement connection missing contract"
    );
    drop(replacement);
    drop(connections);
    let raw = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;
    ensure!(
        !sqlx::query_scalar::<_, bool>("SELECT static_hls_reader_supported()")
            .fetch_one(&raw)
            .await?,
        "raw reader silently acquired contract"
    );
    // Real admission API takes the documented room/snapshot/login/source/budget
    // locks and mints this process's non-reconstructible permit.
    let revision = persistence::cache_budget::snapshot(&pool).await?;
    let permit = match persistence::static_hls::admit(
        &pool,
        session,
        Uuid::new_v4(),
        revision,
        512 * 1024 * 1024,
    )
    .await?
    {
        persistence::static_hls::Admission::Acquired(permit) => permit,
        other => anyhow::bail!("capture admission: {other:?}"),
    };
    ensure!(
        persistence::static_hls::authority_remaining(&pool, &permit)
            .await?
            .is_some(),
        "fresh authority missing"
    );
    let second = persistence::static_hls::admit(
        &pool,
        session,
        Uuid::new_v4(),
        persistence::cache_budget::snapshot(&pool).await?,
        512 * 1024 * 1024,
    )
    .await?;
    ensure!(
        second == persistence::static_hls::Admission::Full,
        "same-user admission did not retain slot"
    );
    ensure!(
        persistence::cache_budget::reserved_bytes(&pool).await?
            == persistence::static_hls::CAPTURE_BYTES,
        "capture absent from shared budget"
    );
    let epoch = Arc::new(AtomicU64::new(1));
    let first = Arc::new(tokio::sync::Notify::new());
    let adapter = Arc::new(persistence::static_hls::PersistedCapturePermit::new(
        pool.clone(),
        permit.clone(),
        Arc::new(EpochGate {
            epoch: epoch.clone(),
            first: first.clone(),
        }),
    ));
    let mut blocked = raw.begin().await?;
    sqlx::query("LOCK TABLE static_hls_captures IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocked)
        .await?;
    let checked = adapter.clone();
    let late = tokio::spawn(async move { checked.check().await });
    first.notified().await;
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    epoch.store(2, Ordering::SeqCst);
    blocked.rollback().await?;
    ensure!(
        tokio::time::timeout(std::time::Duration::from_secs(2), late)
            .await??
            .is_err(),
        "late SQL revived old activation epoch"
    );
    ensure!(
        persistence::cache_budget::reserved_bytes(&pool).await?
            == persistence::static_hls::CAPTURE_BYTES,
        "epoch failure released unknown capture responsibility"
    );
    epoch.store(1, Ordering::SeqCst);
    let mut unknown = raw.begin().await?;
    sqlx::query("LOCK TABLE static_hls_captures IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *unknown)
        .await?;
    let denied = tokio::time::timeout(std::time::Duration::from_secs(2), adapter.check()).await?;
    ensure!(denied.is_err(), "hung DB authority was treated as allowed");
    ensure!(
        persistence::cache_budget::reserved_bytes(&pool).await?
            == persistence::static_hls::CAPTURE_BYTES,
        "unknown SQL result released custody"
    );
    unknown.rollback().await?;
    ensure!(
        persistence::static_hls::prove_verified(&pool, &permit, "owned synthetic guard inventory")
            .await?
    );
    sqlx::query("UPDATE playback_sessions SET static_hls_capture_id=$2,resource=resource||jsonb_build_object('static_hls_capture_id',$2::uuid) WHERE id=$1")
        .bind(session).bind(permit.id()).execute(&pool).await?;
    let mut queued = pool.begin().await?;
    ensure!(
        persistence::media_queue::enqueue_static_hls(
            &mut queued,
            session,
            &serde_json::json!({}),
            20
        )
        .await?,
        "static queue enqueue refused"
    );
    queued.commit().await?;
    let before: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(j) FROM media_jobs j WHERE id=$1")
            .bind(session)
            .fetch_one(&pool)
            .await?;
    ensure!(
        persistence::media_jobs::claim(&pool, Uuid::new_v4())
            .await?
            .is_none(),
        "NULL queue claimed static work"
    );
    let after: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(j) FROM media_jobs j WHERE id=$1")
            .bind(session)
            .fetch_one(&pool)
            .await?;
    ensure!(before == after, "NULL claim normalized static job");
    let ordinary = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$1::text,'{}',clock_timestamp()+interval '1 hour')")
        .bind(ordinary).execute(&pool).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec) VALUES($1,$1,'queued','{}')")
        .bind(ordinary)
        .execute(&pool)
        .await?;
    let legacy = persistence::media_jobs::claim(&pool, Uuid::new_v4())
        .await?
        .ok_or_else(|| anyhow::anyhow!("ordinary NULL claim missing"))?;
    ensure!(
        legacy.id == ordinary && legacy.attempt == 1,
        "ordinary NULL queue changed"
    );
    let owner = Uuid::new_v4();
    let claim = persistence::media_jobs::claim_static_hls(&pool, owner)
        .await?
        .ok_or_else(|| anyhow::anyhow!("explicit static claim missing"))?;
    ensure!(
        claim.id == session && claim.attempt == 1 && claim.owner == owner,
        "static claim identity mismatch"
    );
    ensure!(
        persistence::media_jobs::renew(&pool, &claim).await?,
        "new reader cannot renew own static claim"
    );
    let row = sqlx::query("SELECT logical_queue,owner_id,attempt FROM media_jobs WHERE id=$1")
        .bind(session)
        .fetch_one(&pool)
        .await?;
    ensure!(row.get::<Option<String>, _>("logical_queue").as_deref() == Some("static_hls_v1"));
    ensure!(row.get::<Uuid, _>("owner_id") == owner && row.get::<i64, _>("attempt") == 1);
    println!(
        "{{\"result\":\"passed\",\"physical_connections\":12,\"replacement\":true,\"raw_denied\":true,\"null_queue_unchanged\":true,\"null_queue_claimed\":true,\"static_claim\":true,\"late_epoch_denied\":true,\"unknown_query_denied\":true,\"responsibility_retained\":true}}"
    );
    raw.close().await;
    pool.close().await;
    Ok(())
}
