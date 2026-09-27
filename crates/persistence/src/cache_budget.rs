use crate::media_jobs::Claim;
use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Reserved,
    Changed,
    Full,
    Stale,
}

/// Take this ticket BEFORE measuring disk usage outside the transaction. Every
/// reservation mutation invalidates older measurements, including released jobs.
pub async fn snapshot(pool: &PgPool) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let removed = sqlx::query("DELETE FROM cache_write_reservations r WHERE NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=r.job_id AND j.owner_id=r.owner_id AND j.attempt=r.attempt AND j.lease_until>clock_timestamp())")
        .execute(&mut *tx).await?.rows_affected();
    let revision = if removed > 0 {
        sqlx::query_scalar(
            "UPDATE cache_budget SET revision=revision+1 WHERE singleton RETURNING revision",
        )
        .fetch_one(&mut *tx)
        .await?
    } else {
        revision
    };
    tx.commit().await?;
    Ok(revision)
}

pub async fn reserve(
    pool: &PgPool,
    claim: &Claim,
    revision: i64,
    bytes: u64,
    headroom: u64,
) -> Result<Admission> {
    let mut tx = pool.begin().await?;
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    if revision != current {
        return Ok(Admission::Changed);
    }
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND NOT p.stopped AND p.expires_at>clock_timestamp())")
        .bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_one(&mut *tx).await?;
    if !valid {
        return Ok(Admission::Stale);
    }
    let held: String = sqlx::query_scalar(
        "SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations WHERE job_id<>$1",
    )
    .bind(claim.id)
    .fetch_one(&mut *tx)
    .await?;
    let held: u128 = held.parse()?;
    if bytes == 0 || bytes > i64::MAX as u64 || held + u128::from(bytes) > u128::from(headroom) {
        return Ok(Admission::Full);
    }
    sqlx::query("INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes) VALUES($1,$2,$3,$4) ON CONFLICT(job_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,attempt=EXCLUDED.attempt,bytes=EXCLUDED.bytes")
        .bind(claim.id).bind(claim.owner).bind(claim.attempt).bind(bytes as i64).execute(&mut *tx).await?;
    sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Admission::Reserved)
}

pub async fn release(pool: &PgPool, job: Uuid, owner: Uuid, attempt: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query(
        "DELETE FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$2 AND attempt=$3",
    )
    .bind(job)
    .bind(owner)
    .bind(attempt)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n > 0 {
        sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn reserved_bytes(pool: &PgPool) -> Result<u64> {
    let sum: String =
        sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
            .fetch_one(pool)
            .await?;
    Ok(sum.parse::<u128>()?.min(u128::from(u64::MAX)) as u64)
}
