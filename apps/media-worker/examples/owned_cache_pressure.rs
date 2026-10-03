//! Bounded owned cache operation. Includes production implementation unchanged.
//! No HTTP/backpressure, Agent, full-volume ENOSPC, or formal soak acceptance.
#![allow(dead_code)]
use anyhow::{Result, ensure};
use media_core::child_process::{self, Scope};
use persistence::{
    cache as leases, cache_budget,
    media_jobs::{self, Claim},
    media_outputs,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::{
    io::Seek,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;
#[path = "../src/cache.rs"]
mod cache;
#[path = "../src/output_decode.rs"]
mod output_decode;
#[path = "../src/output_publish.rs"]
mod output_publish;
#[path = "../src/outputs.rs"]
mod outputs;
#[path = "../src/process.rs"]
mod process;
// The included production process module's unit tests exercise readiness too.
// Keep this test-only so the standalone cache helper's runtime stays unchanged.
#[cfg(test)]
#[path = "../src/readiness.rs"]
mod readiness;
#[derive(Clone)]
struct App {
    db: PgPool,
    cache: PathBuf,
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn size(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0;
    for item in std::fs::read_dir(path)? {
        let item = item?;
        let meta = std::fs::symlink_metadata(item.path())?;
        ensure!(
            !meta.file_type().is_symlink(),
            "owned fixture symlink forbidden"
        );
        total += if meta.is_dir() {
            size(&item.path())?
        } else {
            meta.len()
        };
    }
    Ok(total)
}
fn directory(app: &App, claim: &Claim) -> PathBuf {
    app.cache
        .join(claim.id.to_string())
        .join(claim.attempt.to_string())
}
async fn job(app: &App) -> Result<Claim> {
    let id = Uuid::new_v4();
    // Fresh, null-room non-v2 fixture claims use the established production
    // compatibility path. They are not viewer grants or HTTP playback receipts.
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',clock_timestamp()+interval '1 hour')").bind(id).bind(id.to_string()).execute(&app.db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec) VALUES($1,$1,'queued',$2)")
        .bind(id)
        .bind(json!({"estimated_output_bytes":65536}))
        .execute(&app.db)
        .await?;
    let claim = media_jobs::claim(&app.db, Uuid::new_v4())
        .await?
        .ok_or_else(|| anyhow::anyhow!("owned job not claimed"))?;
    ensure!(claim.id == id, "no competing queued fixture work");
    cache::reserve_output(app, &claim).await?;
    std::fs::create_dir_all(directory(app, &claim))?;
    Ok(claim)
}
fn ffmpeg(directory: &Path, realtime: bool, seconds: u32) -> Command {
    let mut command = Command::new("ffmpeg");
    command
        .current_dir(directory)
        .args(["-v", "error", "-nostdin", "-y"]);
    if realtime {
        command.arg("-re");
    }
    command
        .args([
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=25",
            "-t",
            &seconds.to_string(),
            "-c:v",
            "libx264",
            "-threads",
            "1",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "25",
            "-keyint_min",
            "25",
            "-sc_threshold",
            "0",
            "-b:v",
            "128k",
            "-f",
            "hls",
            "-hls_time",
            "1",
            "-hls_playlist_type",
            "event",
            "-hls_segment_type",
            "fmp4",
            "-hls_flags",
            "temp_file",
            "-hls_segment_filename",
            "index%d.m4s",
            "index.m3u8",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    command
}
async fn stop_session(app: &App, claim: &Claim) -> Result<()> {
    use persistence::media_job_timing::{CancellationScope, cancel_jobs};
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(claim.id)
        .execute(&mut *tx)
        .await?;
    let observation = cancel_jobs(&mut *tx, CancellationScope::Session(claim.id))
        .await?
        .into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(())
}
async fn acknowledge(app: &App, claim: &Claim, scope: &Scope) -> Result<()> {
    scope.shutdown().await?;
    persistence::media_executions::acknowledge_job(&app.db, claim.id, claim.attempt, claim.owner)
        .await?;
    cache_budget::snapshot(&app.db).await?;
    Ok(())
}
async fn completed(app: &App) -> Result<(Claim, Value)> {
    let claim = job(app).await?;
    let path = directory(app, &claim);
    let scope = Scope::new();
    let result = scope
        .run(async {
            let mut child = child_process::spawn(ffmpeg(&path, false, 2))?;
            ensure!(
                tokio::time::timeout(Duration::from_secs(10), child.wait())
                    .await??
                    .success(),
                "owned FFmpeg failed"
            );
            let decoder = output_decode::Gate::default();
            let builder = Arc::new(Mutex::new(output_publish::Builder::default()));
            let snapshot = output_publish::prepare(builder, path.clone(), true, &decoder).await?;
            let files = snapshot
                .files
                .iter()
                .map(|p| json!({"index":p.index,"bytes":p.size_bytes,"sha256":p.sha256}))
                .collect::<Vec<_>>();
            ensure!(
                media_outputs::publish(&app.db, &claim, &snapshot, true).await?,
                "owned output publication fenced"
            );
            decoder.stop().await?;
            Ok::<_, anyhow::Error>(files)
        })
        .await;
    // Scope drains even after errors; a failed workload never fabricates success.
    scope.shutdown().await?;
    let files = result?;
    acknowledge(app, &claim, &scope).await?;
    let evidence = json!({"job_id":claim.id,"attempt":claim.attempt,"owner":claim.owner,"bytes":size(&path)?,"files":files,"published":true,"encoder_wait_success":true,"first_fragment_decode":true,"scope_drain_confirmed":true});
    Ok((claim, evidence))
}
async fn state(app: &App, id: Uuid) -> Result<String> {
    Ok(
        sqlx::query_scalar("SELECT state FROM cache_entries WHERE id=$1")
            .bind(id)
            .fetch_one(&app.db)
            .await?,
    )
}
async fn sweep(app: &App, owner: Uuid, quota: u64) -> Result<Value> {
    let sweep_id = Uuid::new_v4();
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--sweep",
            app.cache.to_str().unwrap(),
            &owner.to_string(),
            &sweep_id.to_string(),
        ])
        .env("CACHE_MAX_BYTES", quota.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let mut child = child_process::spawn(command)?;
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await??;
    let path = app
        .cache
        .parent()
        .unwrap()
        .join(format!("sweep-{sweep_id}.json"));
    let result: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(status.success(), "owned cache sweep failed: {}", result);
    ensure!(result["before_bytes"].as_u64().is_some() && result["after_bytes"].as_u64().is_some());
    Ok(result)
}
async fn cycle(app: &App, owner: Uuid) -> Result<Value> {
    let mut outputs_evidence = Vec::new();
    let (reader, evidence) = completed(app).await?;
    outputs_evidence.push(evidence);
    let lease = leases::acquire_attempt(&app.db, reader.id, reader.attempt)
        .await?
        .ok_or_else(|| anyhow::anyhow!("owned reader unavailable"))?;
    let reader_path = directory(app, &reader).join("index0.m4s");
    let mut handle = outputs::open_media(&reader_path)?;
    let expected = outputs::hash_file(&mut handle)?;
    // The persisted lease alone must pin the stopped session, independently of
    // the active-session gate. We hold an actual verified file handle throughout.
    stop_session(app, &reader).await?;
    let mut idle = Vec::new();
    for _ in 0..3 {
        let (claim, evidence) = completed(app).await?;
        stop_session(app, &claim).await?;
        outputs_evidence.push(evidence);
        idle.push(claim);
    }
    let writer = job(app).await?;
    let path = directory(app, &writer);
    let scope = Scope::new();
    let mut child = scope
        .run(async { child_process::spawn(ffmpeg(&path, true, 12)) })
        .await?;
    let result = async {
        for _ in 0..70 {
            if path.join("index0.m4s").exists() { break; }
            ensure!(child.try_wait()?.is_none(), "owned live writer unexpectedly exited");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        ensure!(path.join("index0.m4s").exists(), "live HLS writer must create real output");
        // Cancellation/expiry are scheduling facts only, while the actual
        // fixture encoder continues to write under this separate process owner.
        stop_session(app, &writer).await?;
        sqlx::query("UPDATE media_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1").bind(writer.id).execute(&app.db).await?;
        let held = cache_budget::reserved_bytes(&app.db).await?;
        ensure!(held == 65536, "actual writer keeps full reservation");
        let budget_revision = cache_budget::snapshot(&app.db).await?;
        cache_budget::release(&app.db, writer.id, writer.owner, writer.attempt).await?;
        ensure!(cache_budget::snapshot(&app.db).await? == budget_revision, "unreaped release must not change budget");
        ensure!(leases::claim_eviction(&app.db, writer.id).await?.is_none(), "cancelled expired live writer is protected");
        let writer_before = size(&path)?;
        ensure!(child.try_wait()?.is_none(), "writer phase requires a live encoder");
        let witness = json!({"run_id":owner,"job_id":writer.id,"attempt":writer.attempt,"owner_id":writer.owner,"phase":"writer-live","bytes":writer_before});
        let witness_root=app.cache.parent().unwrap();
        std::fs::write(witness_root.join("writer-live.tmp"),serde_json::to_vec_pretty(&witness)?)?;
        std::fs::rename(witness_root.join("writer-live.tmp"),witness_root.join("writer-live.json"))?;
        let quota = size(&app.cache.join(reader.id.to_string()))? + writer_before + 65536;
        let before = size(&app.cache)?;
        ensure!(before >= quota, "fixture must exert measured application quota pressure");
        let first = sweep(app, owner, quota).await?;
        ensure!(first["after_bytes"].as_u64().unwrap() < quota);
        let deleted: Vec<_> = idle.iter().filter(|c| !app.cache.join(c.id.to_string()).exists()).map(|c|c.id).collect();
        ensure!(!deleted.is_empty(), "quota sweep must actually delete eligible outputs");
        for id in &deleted { ensure!(state(app, *id).await? == "evicted"); }
        ensure!(state(app, reader.id).await? == "ready" && state(app, writer.id).await? == "ready");
        ensure!(reader_path.exists() && path.exists());
        handle.rewind()?;
        let observed = outputs::hash_file(&mut handle)?;
        ensure!(observed == expected, "active reader handle content changed");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let writer_after = size(&path)?;
        ensure!(writer_after > writer_before && child.try_wait()?.is_none(), "actual writer must keep creating bytes after pressure");
        let second = sweep(app, owner, quota).await?;
        ensure!(child.try_wait()?.is_none(), "actual writer must remain live after the second pressure sweep");
        ensure!(second["after_bytes"].as_u64().unwrap() < quota, "quota stabilizes on repeated sweep");
        ensure!(reader_path.exists() && path.exists());
        ensure!(cache_budget::reserved_bytes(&app.db).await? == held);
        let lease_live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cache_read_leases WHERE id=$1 AND expires_at>clock_timestamp())").bind(lease.id).fetch_one(&app.db).await?;
        ensure!(lease_live, "reader protection must be a live observed lease");
        Ok::<_,anyhow::Error>(json!({"quota_bytes":quota,"observed_pressure_bytes":before,"sweeps":[first,second],"deleted_inactive_outputs":deleted,"reader":{"job_id":reader.id,"lease_id":lease.id,"scope":"production acquire_attempt lease plus verified open file; not HTTP backpressure","file_bytes":expected.0,"sha256":expected.1,"survived":true,"lease_observed_live":true},"writer":{"job_id":writer.id,"attempt":writer.attempt,"scope":"actual owned realtime FFmpeg HLS writer with cancelled session and expired scheduling lease","before_bytes":writer_before,"after_bytes":writer_after,"live_after_sweeps":true,"reserved_bytes":held,"unreaped_budget_release_refused":true}}))
    }.await;
    // Independent cleanup runs even after a failed observation; only positive
    // local tree drain creates this owned writer's receipt.
    child.kill().await?;
    child.wait().await?;
    scope.shutdown().await?;
    acknowledge(app, &writer, &scope).await?;
    drop(handle);
    leases::release(&app.db, lease).await?;
    let mut evidence = result?;
    let final_sweep = sweep(app, owner, 1).await?;
    ensure!(
        size(&app.cache)? == 0,
        "released known outputs become evictable"
    );
    evidence["released_reader_writer_sweep"] = final_sweep;
    evidence["writer"]["scope_drain_confirmed"] = json!(true);
    evidence["writer"]["receipt_after_drain"] = json!(true);
    evidence["outputs"] = json!(outputs_evidence);
    evidence["unknown_obligations"] = unknown(app, owner).await?;
    Ok(evidence)
}
async fn unknown(app: &App, owner: Uuid) -> Result<Value> {
    // Fresh fixture claims with no process witness stay unknown. We deliberately
    // remove the ledger entry; we never add a receipt or attempt legacy recovery.
    let claim = job(app).await?;
    std::fs::write(
        directory(app, &claim).join("unconfirmed.tmp"),
        vec![0u8; 4096],
    )?;
    stop_session(app, &claim).await?;
    sqlx::query("DELETE FROM media_executions WHERE job_id=$1")
        .bind(claim.id)
        .execute(&app.db)
        .await?;
    let revision = cache_budget::snapshot(&app.db).await?;
    cache_budget::release(&app.db, claim.id, claim.owner, claim.attempt).await?;
    ensure!(cache_budget::snapshot(&app.db).await? == revision);
    ensure!(cache_budget::reserved_bytes(&app.db).await? == 65536);
    ensure!(leases::claim_eviction(&app.db, claim.id).await?.is_none());
    sqlx::query("DELETE FROM media_jobs WHERE id=$1")
        .bind(claim.id)
        .execute(&app.db)
        .await?;
    ensure!(
        cache_budget::snapshot(&app.db).await? == revision,
        "missing job is not exit proof"
    );
    ensure!(
        leases::claim_eviction(&app.db, claim.id).await?.is_none(),
        "orphaned reservation must protect cache"
    );
    // Actual effective reservations block a fresh eligible claim despite a
    // physically nearly-empty cache. This claim starts no encoder and is never
    // falsely acknowledged; all unknown rows remain in the discarded cluster.
    let next = job_without_reservation(app).await?;
    ensure!(
        cache_budget::reserve(&app.db, &next, revision, 65536, 70000).await?
            == cache_budget::Admission::Full
    );
    stop_session(app, &next).await?;
    let attempt = sweep_expected_failure(app, owner, 1).await?;
    ensure!(directory(app, &claim).exists());
    Ok(
        json!({"missing_receipt_blocks":true,"missing_job_blocks":true,"effective_reserved_bytes":65536,"new_reservation_rejected":true,"capacity_error":attempt,"recovery_attempted":false,"receipt_fabricated":false}),
    )
}
async fn job_without_reservation(app: &App) -> Result<Claim> {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playback_sessions(id,generation,delivery_token_hash,resource,expires_at) VALUES($1,0,$2,'{}',clock_timestamp()+interval '1 hour')").bind(id).bind(id.to_string()).execute(&app.db).await?;
    sqlx::query("INSERT INTO media_jobs(id,session_id,status,spec) VALUES($1,$1,'queued','{}')")
        .bind(id)
        .execute(&app.db)
        .await?;
    let claim = media_jobs::claim(&app.db, Uuid::new_v4()).await?.unwrap();
    ensure!(claim.id == id);
    Ok(claim)
}
async fn sweep_expected_failure(app: &App, owner: Uuid, quota: u64) -> Result<Value> {
    let sweep_id = Uuid::new_v4();
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args([
            "--sweep",
            app.cache.to_str().unwrap(),
            &owner.to_string(),
            &sweep_id.to_string(),
        ])
        .env("CACHE_MAX_BYTES", quota.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = child_process::spawn(command)?;
    ensure!(
        !tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await??
            .success()
    );
    let result: Value = serde_json::from_slice(&std::fs::read(
        app.cache
            .parent()
            .unwrap()
            .join(format!("sweep-{sweep_id}.json")),
    )?)?;
    ensure!(result["error"] == "cache_capacity_exceeded");
    Ok(result)
}
async fn termination_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        signal.recv().await;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::future::pending::<Result<()>>().await
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    ensure!(std::env::var("RAINSYNC_ISOLATED_TEST").as_deref() == Ok("1"));
    let args: Vec<_> = std::env::args().collect();
    let root = PathBuf::from(
        args.get(2)
            .ok_or_else(|| anyhow::anyhow!("owned root required"))?,
    );
    let owner = Uuid::parse_str(
        args.get(3)
            .ok_or_else(|| anyhow::anyhow!("owned ID required"))?,
    )?;
    ensure!(root.is_absolute() && root.file_name().and_then(|p| p.to_str()) == Some("cache"));
    let parent = root
        .parent()
        .ok_or_else(|| anyhow::anyhow!("owned parent required"))?;
    for path in [root.as_path(), parent] {
        let metadata = std::fs::symlink_metadata(path)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "owned cache directory must not be a symlink"
        );
    }
    let marker = parent.join("cache-owner");
    let metadata = std::fs::symlink_metadata(&marker)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "owned marker must be a regular file"
    );
    ensure!(
        root.canonicalize()?.parent() == Some(parent.canonicalize()?.as_path()),
        "owned cache parent boundary"
    );
    ensure!(
        std::fs::read_to_string(&marker)?.trim() == owner.to_string(),
        "owned boundary marker mismatch"
    );
    let app = App {
        db: persistence::connect(&std::env::var("DATABASE_URL")?).await?,
        cache: root,
    };
    ensure!(
        fs2::available_space(&app.cache)? > fs2::total_space(&app.cache)? / 10,
        "production disk headroom must hold before fixture"
    );
    if args.get(1).map(String::as_str) == Some("--sweep") {
        let before = size(&app.cache)?;
        let result = cache::ensure_capacity(&app).await;
        let quota: u64 = std::env::var("CACHE_MAX_BYTES")?.parse()?;
        let sweep_id = Uuid::parse_str(
            args.get(4)
                .ok_or_else(|| anyhow::anyhow!("owned sweep ID required"))?,
        )?;
        let evidence = json!({"sweep_id":sweep_id,"before_bytes":before,"after_bytes":size(&app.cache)?,"quota_bytes":quota,"error":result.as_ref().err().map(ToString::to_string),"disk_headroom_fraction":fs2::available_space(&app.cache)? as f64/fs2::total_space(&app.cache)? as f64});
        std::fs::write(
            app.cache
                .parent()
                .unwrap()
                .join(format!("sweep-{sweep_id}.json")),
            serde_json::to_vec_pretty(&evidence)?,
        )?;
        result?;
        return Ok(());
    }
    ensure!(args.get(1).map(String::as_str) == Some("--cycle"));
    persistence::migrate(&app.db).await?;
    let result = tokio::select! {
        result = cycle(&app, owner) => result,
        _ = tokio::signal::ctrl_c() => Err(anyhow::anyhow!("owned cache fixture interrupted")),
        signal = termination_signal() => match signal {Ok(())=>Err(anyhow::anyhow!("owned cache fixture terminated")),Err(error)=>Err(error)},
    };
    let cleanup = child_process::shutdown().await;
    let evidence = json!({"schema_version":1,"run_id":owner,"kind":"cache-evict","scope":"bounded production cache/output APIs and actual owned FFmpeg; API lease/open handle reader","accepted":false,"release_ready":false,"result":if result.is_ok()&&cleanup.is_ok(){"passed"}else{"failed"},"evidence":result.as_ref().ok(),"error":result.as_ref().err().map(ToString::to_string),"process_scope_cleanup":cleanup.is_ok(),"no_f3_claim":true});
    std::fs::write(
        app.cache.parent().unwrap().join("cache-pressure.json"),
        serde_json::to_vec_pretty(&evidence)?,
    )?;
    result?;
    cleanup?;
    Ok(())
}
