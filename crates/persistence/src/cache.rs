//! Read admission and eviction serialize on the same entry row. Filesystem
//! deletion happens only after committing an eviction claim, never under a DB lock.
use anyhow::Result;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub struct ReadLease {
    pub id: Uuid,
    pub cache_id: Uuid,
}

pub async fn acquire(pool: &PgPool, cache_id: Uuid) -> Result<Option<ReadLease>> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO cache_entries(id,cache_key,path) VALUES($1,$1::text,$1::text) ON CONFLICT DO NOTHING")
        .bind(cache_id)
        .execute(&mut *tx)
        .await?;
    let state: String =
        sqlx::query_scalar("SELECT state FROM cache_entries WHERE id=$1 FOR UPDATE")
            .bind(cache_id)
            .fetch_one(&mut *tx)
            .await?;
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND NOT stopped AND expires_at>clock_timestamp())")
        .bind(cache_id).fetch_one(&mut *tx).await?;
    if state != "ready" || !valid {
        return Ok(None);
    }
    let lease = ReadLease {
        id: Uuid::new_v4(),
        cache_id,
    };
    sqlx::query(
        "DELETE FROM cache_read_leases WHERE cache_id=$1 AND expires_at<=clock_timestamp()",
    )
    .bind(cache_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO cache_read_leases(id,cache_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '30 seconds')")
        .bind(lease.id).bind(cache_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE cache_entries SET last_used=clock_timestamp() WHERE id=$1")
        .bind(cache_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(lease))
}

pub async fn renew(pool: &PgPool, lease: ReadLease) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM cache_entries WHERE id=$1 FOR UPDATE")
            .bind(lease.cache_id)
            .fetch_optional(&mut *tx)
            .await?;
    if state.as_deref() != Some("ready") {
        return Ok(false);
    }
    let n = sqlx::query("UPDATE cache_read_leases SET expires_at=clock_timestamp()+interval '30 seconds' WHERE id=$1 AND cache_id=$2 AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM playback_sessions WHERE id=$2 AND NOT stopped AND expires_at>clock_timestamp())")
        .bind(lease.id).bind(lease.cache_id).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    Ok(n == 1)
}

pub async fn release(pool: &PgPool, lease: ReadLease) -> Result<()> {
    sqlx::query("DELETE FROM cache_read_leases WHERE id=$1 AND cache_id=$2")
        .bind(lease.id)
        .bind(lease.cache_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn claim_eviction(pool: &PgPool, cache_id: Uuid) -> Result<Option<Uuid>> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO cache_entries(id,cache_key,path) VALUES($1,$1::text,$1::text) ON CONFLICT DO NOTHING")
        .bind(cache_id)
        .execute(&mut *tx)
        .await?;
    let entry = sqlx::query("SELECT state,(eviction_until>clock_timestamp()) AS claimed FROM cache_entries WHERE id=$1 FOR UPDATE")
        .bind(cache_id).fetch_one(&mut *tx).await?;
    if entry.get::<String, _>("state") == "evicting"
        && entry.get::<Option<bool>, _>("claimed") == Some(true)
    {
        return Ok(None);
    }
    let protected: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND NOT stopped AND expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM media_jobs WHERE id=$1 AND status='running' AND lease_until>clock_timestamp()) OR EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=$1 AND expires_at>clock_timestamp())")
        .bind(cache_id).fetch_one(&mut *tx).await?;
    if protected {
        return Ok(None);
    }
    let owner = Uuid::new_v4();
    sqlx::query("UPDATE cache_entries SET state='evicting',eviction_owner=$2,eviction_until=clock_timestamp()+interval '30 seconds' WHERE id=$1")
        .bind(cache_id).bind(owner).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(owner))
}

pub async fn finish_eviction(pool: &PgPool, cache_id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(sqlx::query_scalar("WITH finished AS (UPDATE cache_entries SET state='evicted',eviction_until=NULL,evicted_at=clock_timestamp() WHERE id=$1 AND state='evicting' AND eviction_owner=$2 AND eviction_until>clock_timestamp() RETURNING id), cleared AS (DELETE FROM cache_read_leases WHERE cache_id IN (SELECT id FROM finished)) SELECT EXISTS(SELECT 1 FROM finished)")
        .bind(cache_id).bind(owner).fetch_one(pool).await?)
}

/// Bounded maintenance; keep eviction tombstones while the original session or
/// job exists, and for at least 48 hours after physical deletion.
pub async fn cleanup(pool: &PgPool) -> Result<()> {
    sqlx::query("DELETE FROM cache_read_leases WHERE id IN (SELECT id FROM cache_read_leases WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)")
        .execute(pool).await?;
    sqlx::query("DELETE FROM cache_entries WHERE id IN (SELECT e.id FROM cache_entries e WHERE e.state='evicted' AND e.evicted_at<clock_timestamp()-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM playback_sessions p WHERE p.id=e.id) AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=e.id) LIMIT 1000 FOR UPDATE SKIP LOCKED)")
        .execute(pool).await?;
    Ok(())
}
