//! Short owned-process / real-PostgreSQL regression, not a Worker/FFmpeg soak.
use anyhow::{Result, ensure};
use persistence::{
    cache, cache_budget, cache_outputs,
    media_job_timing::{CancellationScope, cancel_jobs},
    media_jobs::{self, Claim},
};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncBufReadExt, process::Child};
use uuid::Uuid;

async fn job(db: &sqlx::PgPool) -> Result<Claim> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',clock_timestamp()+interval '1 hour')")
        .bind(id).bind(id.to_string()).execute(db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec) VALUES($1,$1,'queued','{}')")
        .bind(id)
        .execute(db)
        .await?;
    let claim = media_jobs::claim(db, Uuid::new_v4()).await?.unwrap();
    ensure!(
        claim.id == id,
        "fixture database must have no competing queued work"
    );
    Ok(claim)
}

async fn stop_session(db: &sqlx::PgPool, id: Uuid) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let delta = cancel_jobs(&mut *tx, CancellationScope::Session(id)).await?;
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(())
}

async fn expire(db: &sqlx::PgPool, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE media_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

async fn acknowledge(db: &sqlx::PgPool, claim: &Claim) -> Result<()> {
    persistence::media_executions::acknowledge_job(db, claim.id, claim.attempt, claim.owner).await
}

async fn reserved(db: &sqlx::PgPool, claim: &Claim) -> Result<()> {
    ensure!(
        cache_budget::reserve(db, claim, cache_budget::snapshot(db).await?, 60, 100).await?
            == cache_budget::Admission::Reserved
    );
    Ok(())
}

async fn start_writer(path: &Path) -> Result<Child> {
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .arg("--owned-writer")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut ready = String::new();
    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready),
    )
    .await;
    if !matches!(outcome, Ok(Ok(_))) || ready.trim() != "writer-ready" {
        child.kill().await?;
        anyhow::bail!("owned writer readiness failed");
    }
    Ok(child)
}

async fn reap_writer(child: &mut Child) -> Result<()> {
    // EOF requests a final local write and normal exit. Only wait success is
    // acknowledged; cancellation/lease timeouts never fabricate this receipt.
    drop(child.stdin.take());
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(status) => ensure!(status?.success(), "owned writer failed"),
        Err(_) => {
            child.kill().await?;
            anyhow::bail!("owned writer did not exit normally");
        }
    }
    Ok(())
}

fn child_main(path: &Path) -> Result<()> {
    use std::io::{BufRead, Write};
    std::fs::create_dir_all(path)?;
    let mut output = std::fs::File::create(path.join("owned-writer.tmp"))?;
    output.write_all(b"open writer\n")?;
    output.flush()?;
    println!("writer-ready");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    output.write_all(b"writer drained\n")?;
    output.flush()?;
    Ok(())
}

async fn cancelled_writer(db: &sqlx::PgPool, root: &Path) -> Result<()> {
    let claim = job(db).await?;
    let path = root.join(claim.id.to_string()).join("1");
    let mut child = start_writer(&path).await?;
    let result = async {
        reserved(db, &claim).await?;
        ensure!(cache::claim_eviction(db, claim.id).await?.is_none(), "active session");
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(claim.id).execute(db).await?;
        ensure!(cache::claim_eviction(db, claim.id).await?.is_none(), "running writer protects a stopped session");
        stop_session(db, claim.id).await?;
        // Reproduce the former admission decision on the real cancelled row.
        let formerly_protected: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND NOT stopped AND expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM media_jobs WHERE id=$1 AND status='running' AND lease_until>clock_timestamp()) OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=$1 AND expires_at>clock_timestamp())")
            .bind(claim.id).fetch_one(db).await?;
        ensure!(!formerly_protected, "fixture must expose the former eviction hole");
        ensure!(child.try_wait()?.is_none(), "writer is still alive at cancellation");
        ensure!(cache::claim_eviction(db, claim.id).await?.is_none(), "cancelled writer retains directory");
        let before = cache_budget::snapshot(db).await?;
        expire(db, claim.id).await?;
        ensure!(cache_budget::snapshot(db).await? == before, "lease expiry retains writer budget");
        ensure!(cache::claim_eviction(db, claim.id).await?.is_none(), "expired lease is not exit");
        cache_budget::release(db, claim.id, claim.owner, claim.attempt).await?;
        ensure!(cache_budget::reserved_bytes(db).await? == 60, "unreaped owner cannot release budget");
        persistence::media_executions::acknowledge_job(db, claim.id, claim.attempt, Uuid::new_v4()).await?;
        persistence::media_executions::acknowledge_job(db, claim.id, claim.attempt + 1, claim.owner).await?;
        ensure!(cache::claim_eviction(db, claim.id).await?.is_none(), "foreign/stale acknowledgement is inert");
        ensure!(path.join("owned-writer.tmp").exists());
        Result::<()>::Ok(())
    }.await;
    // Always wait for our actual child, including a failed assertion path.
    let stopped = reap_writer(&mut child).await;
    stopped?;
    acknowledge(db, &claim).await?;
    result?;
    let before = cache_budget::snapshot(db).await?;
    ensure!(cache_budget::reserved_bytes(db).await? == 0);
    ensure!(cache_budget::snapshot(db).await? == before);
    sqlx::query("UPDATE media_executions SET reaped_at=clock_timestamp()-interval '49 hours' WHERE job_id=$1")
        .bind(claim.id).execute(db).await?;
    persistence::room_cleanup::prune_receipts(db).await?;
    let retained: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_executions WHERE job_id=$1)")
            .bind(claim.id)
            .fetch_one(db)
            .await?;
    ensure!(retained, "positive receipt stays while cache depends on it");
    let owner = cache::claim_eviction(db, claim.id)
        .await?
        .expect("reaped writer is evictable");
    std::fs::remove_dir_all(root.join(claim.id.to_string()))?;
    ensure!(cache::finish_eviction(db, claim.id, owner).await?);
    persistence::room_cleanup::prune_receipts(db).await?;
    let pruned: bool =
        sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM media_executions WHERE job_id=$1)")
            .bind(claim.id)
            .fetch_one(db)
            .await?;
    ensure!(
        pruned,
        "receipt ages out only after positive eviction and budget release"
    );
    println!(
        "PASS: live/cancelled/expired owned writer, fenced receipt, budget, positive eviction and receipt retention"
    );
    Ok(())
}

async fn obsolete_writer(db: &sqlx::PgPool, root: &Path) -> Result<()> {
    let first = job(db).await?;
    let path = root.join(first.id.to_string()).join("1");
    let mut child = start_writer(&path).await?;
    let result = async {
        reserved(db, &first).await?;
        expire(db, first.id).await?;
        ensure!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
        sqlx::query(
            "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        )
        .bind(first.id)
        .execute(db)
        .await?;
        let second = media_jobs::claim(db, Uuid::new_v4()).await?.unwrap();
        ensure!(second.id == first.id && second.attempt == 2);
        ensure!(
            cache_budget::reserve(db, &second, cache_budget::snapshot(db).await?, 60, 100).await?
                == cache_budget::Admission::Full,
            "new attempt cannot overwrite an old writer's budget"
        );
        ensure!(
            !cache_outputs::candidates(db)
                .await?
                .contains(&(first.id, 1))
        );
        ensure!(
            cache_outputs::claim(db, first.id, 1).await?.is_none(),
            "old unreaped writer protects its attempt"
        );
        let reader = cache::acquire_attempt(db, first.id, 2).await?.unwrap();
        stop_session(db, first.id).await?;
        // No child or source was ever started for this second claim.
        acknowledge(db, &second).await?;
        cache_budget::snapshot(db).await?;
        ensure!(
            cache_budget::reserved_bytes(db).await? == 60,
            "new attempt receipt cannot free old budget"
        );
        ensure!(child.try_wait()?.is_none());
        ensure!(cache_outputs::claim(db, first.id, 1).await?.is_none());
        Result::<_>::Ok((second, reader))
    }
    .await;
    reap_writer(&mut child).await?;
    acknowledge(db, &first).await?;
    let (_second, reader) = result?;
    cache_budget::snapshot(db).await?;
    ensure!(cache_budget::reserved_bytes(db).await? == 0);
    ensure!(
        cache_outputs::candidates(db)
            .await?
            .contains(&(first.id, 1))
    );
    let claim = cache_outputs::claim(db, first.id, 1)
        .await?
        .expect("reaped obsolete attempt can be cleaned");
    std::fs::remove_dir_all(path)?;
    ensure!(cache_outputs::finish(db, claim).await?);
    ensure!(
        cache::claim_eviction(db, first.id).await?.is_none(),
        "current reader still pins whole directory"
    );
    cache::release(db, reader).await?;
    let owner = cache::claim_eviction(db, first.id).await?.unwrap();
    std::fs::remove_dir_all(root.join(first.id.to_string()))?;
    ensure!(cache::finish_eviction(db, first.id, owner).await?);
    println!(
        "PASS: expired old-attempt writer blocks cleanup/reservation replacement; reaped cleanup preserves current readers"
    );
    Ok(())
}

async fn missing_evidence(db: &sqlx::PgPool) -> Result<()> {
    let claim = job(db).await?;
    reserved(db, &claim).await?;
    // Deliberately model an incomplete legacy ledger. No child was started,
    // and the fixture never invents a replacement acknowledgement to clear it.
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(claim.id)
        .execute(db)
        .await?;
    expire(db, claim.id).await?;
    ensure!(media_jobs::claim(db, Uuid::new_v4()).await?.is_none());
    sqlx::query(
        "UPDATE media_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(claim.id)
    .execute(db)
    .await?;
    let second = media_jobs::claim(db, Uuid::new_v4()).await?.unwrap();
    ensure!(second.id == claim.id && second.attempt == 2);
    stop_session(db, claim.id).await?;
    acknowledge(db, &second).await?; // No process was started for this claim.
    let revision = cache_budget::snapshot(db).await?;
    ensure!(cache_budget::reserved_bytes(db).await? == 60);
    cache_budget::release(db, claim.id, claim.owner, claim.attempt).await?;
    ensure!(
        cache_budget::snapshot(db).await? == revision,
        "explicit release also requires proof"
    );
    ensure!(
        cache::claim_eviction(db, claim.id).await?.is_none(),
        "missing receipt fails closed"
    );
    ensure!(
        !cache_outputs::candidates(db)
            .await?
            .contains(&(claim.id, 1))
    );
    ensure!(
        cache_outputs::claim(db, claim.id, 1).await?.is_none(),
        "missing old receipt blocks attempt cleanup"
    );
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(claim.id)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM media_jobs WHERE id=$1")
        .bind(claim.id)
        .execute(db)
        .await?;
    ensure!(
        cache_budget::snapshot(db).await? == revision,
        "missing job does not prove release"
    );
    ensure!(
        cache::claim_eviction(db, claim.id).await?.is_none(),
        "orphan reservation remains an obligation"
    );
    println!("PASS: missing receipt/job retains unknown cache and budget obligations");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--owned-writer") {
        return child_main(Path::new(&std::env::args().nth(2).expect("owned path")));
    }
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let db = persistence::connect(&std::env::var("DATABASE_URL")?).await?;
    persistence::migrate(&db).await?;
    if std::env::args().nth(1).as_deref() == Some("--migrate-only") {
        return Ok(());
    }
    let root = std::env::temp_dir().join(format!("rainsync-cache-writer-{}", Uuid::new_v4()));
    std::fs::create_dir(&root)?;
    let result = async {
        cancelled_writer(&db, &root).await?;
        obsolete_writer(&db, &root).await?;
        missing_evidence(&db).await?;
        Result::<()>::Ok(())
    }
    .await;
    // Only this UUID-named fixture directory is removed. All DB rows remain
    // in the disposable cluster, including the deliberately unknown ledger.
    std::fs::remove_dir_all(root)?;
    result
}
