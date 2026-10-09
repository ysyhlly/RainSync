//! Existing advanced-attempt guards, separate from recipe preparation.
//!
//! Borrow the original pool, claim and prepared custody. This module neither
//! constructs an attempt owner nor changes its existing confirmed deadlines.
use crate::{
    advanced_media::{self, Prepared},
    process, source_version,
};
use anyhow::{Result, ensure};
use persistence::media_jobs::Claim;
use sqlx::PgPool;
use std::{path::Path, time::Duration};

/// Preparation has the same confirmed lease deadline as encoding. Held remote
/// bytes and metadata children cannot keep working after cancellation/expiry.
pub(crate) async fn prepare_scoped(
    db: &PgPool,
    claim: &Claim,
    input: &str,
    output: &Path,
    audio: Option<u32>,
) -> Result<Option<Prepared>> {
    let mut until = process::finalization_deadline(
        Duration::from_secs(3),
        process::confirmed_deadline(persistence::media_jobs::renew_remaining(db, claim)),
    )
    .await?
    .ok_or_else(|| anyhow::Error::new(process::LeaseInterrupted))?;
    verify_scope(db, claim).await?;
    let work = advanced_media::prepare(&claim.spec, input, output, audio);
    tokio::pin!(work);
    let mut next = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        tokio::select! {biased;_=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),result=&mut work=>return result,
            _=tokio::time::sleep_until(next)=>{
                verify_scope(db,claim).await?;
                let renewal=tokio::select!{biased;_=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),r=tokio::time::timeout(Duration::from_secs(3),process::confirmed_deadline(persistence::media_jobs::renew_remaining(db,claim)))=>r};
                if tokio::time::Instant::now()>=until{return Err(process::LeaseInterrupted.into());}
                match renewal{Ok(Ok(Some(deadline)))if deadline>tokio::time::Instant::now()=>{until=deadline;next=tokio::time::Instant::now()+Duration::from_secs(4)},Ok(Ok(_))=>return Err(process::LeaseInterrupted.into()),_=>next=tokio::time::Instant::now()+Duration::from_secs(1)}
            }
        }
    }
}

pub(crate) async fn verify_scope(db: &PgPool, claim: &Claim) -> Result<()> {
    if !matches!(
        claim.spec["kind"].as_str(),
        Some(
            "advanced_local_transcode_v1"
                | "advanced_owned_local_transcode_v1"
                | "advanced_owned_remote_transcode_v1"
                | "remote_asset_transcode_v1"
        )
    ) {
        return Ok(());
    }
    let allowed:bool=tokio::time::timeout(Duration::from_secs(3),sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND advanced_media_job_allowed(j.id))").bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_one(db)).await??;
    ensure!(allowed, process::LeaseInterrupted);
    Ok(())
}
pub(crate) async fn monitor_scope(
    db: &PgPool,
    claim: &Claim,
    prepared: Option<&Prepared>,
) -> anyhow::Error {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Err(error) = source_version::verify(&claim.spec).await {
            return error;
        }
        if let Err(error) = verify_scope(db, claim).await {
            return error;
        }
        if let Some(prepared) = prepared
            && let Err(error) = prepared.verify()
        {
            return error;
        }
        if let Some(prepared) = prepared
            && let Err(error) = prepared.verify_remote().await
        {
            return error;
        }
    }
}
