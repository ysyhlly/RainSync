//! Obsolete attempts are never current again. Keep their records and revisit
//! them: a paused, fenced writer can recreate private files after a cleanup.
use anyhow::Result;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub struct Cleanup {
    pub job_id: Uuid,
    pub attempt: i64,
    pub owner: Uuid,
}

pub async fn candidates(pool: &PgPool) -> Result<Vec<(Uuid, i64)>> {
    let rows = sqlx::query("SELECT o.job_id,o.attempt FROM media_outputs o JOIN media_jobs j ON j.id=o.job_id LEFT JOIN cache_entries e ON e.id=o.job_id WHERE (e.id IS NULL OR e.state='ready') AND o.attempt>0 AND o.attempt<j.attempt AND o.status IN ('abandoned','failed') AND o.cleanup_after<=clock_timestamp() AND (o.cleanup_until IS NULL OR o.cleanup_until<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM cache_read_leases r WHERE r.cache_id=o.job_id AND (r.attempt IS NULL OR r.attempt=o.attempt) AND r.expires_at>clock_timestamp()) ORDER BY o.cleanup_after,o.job_id,o.attempt LIMIT 32")
        .fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get("job_id"), r.get("attempt")))
        .collect())
}

pub async fn claim(pool: &PgPool, job_id: Uuid, attempt: i64) -> Result<Option<Cleanup>> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO cache_entries(id,cache_key,path) VALUES($1,$1::text,$1::text) ON CONFLICT DO NOTHING")
        .bind(job_id).execute(&mut *tx).await?;
    let state: String =
        sqlx::query_scalar("SELECT state FROM cache_entries WHERE id=$1 FOR UPDATE")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await?;
    if state != "ready" {
        return Ok(None);
    }
    let cleanup = Cleanup {
        job_id,
        attempt,
        owner: Uuid::new_v4(),
    };
    // This entry lock also serializes read admission. Current-attempt readers
    // do not pin obsolete directories; unscoped legacy readers pin all of them.
    let changed = sqlx::query("UPDATE media_outputs o SET cleanup_owner=$3,cleanup_until=clock_timestamp()+interval '30 seconds',cleanup_after=clock_timestamp()+interval '60 seconds' FROM media_jobs j WHERE o.job_id=$1 AND j.id=o.job_id AND o.attempt=$2 AND o.attempt>0 AND o.attempt<j.attempt AND o.status IN ('abandoned','failed') AND o.cleanup_after<=clock_timestamp() AND (o.cleanup_until IS NULL OR o.cleanup_until<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM cache_read_leases r WHERE r.cache_id=o.job_id AND (r.attempt IS NULL OR r.attempt=o.attempt) AND r.expires_at>clock_timestamp())")
        .bind(job_id).bind(attempt).bind(cleanup.owner).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    Ok((changed == 1).then_some(cleanup))
}

pub async fn finish(pool: &PgPool, cleanup: Cleanup) -> Result<bool> {
    Ok(sqlx::query("UPDATE media_outputs SET cleanup_owner=NULL,cleanup_until=NULL,cleanup_after=clock_timestamp()+interval '60 seconds' WHERE job_id=$1 AND attempt=$2 AND cleanup_owner=$3 AND cleanup_until>clock_timestamp()")
        .bind(cleanup.job_id).bind(cleanup.attempt).bind(cleanup.owner).execute(pool).await?.rows_affected() == 1)
}
