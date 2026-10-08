//! Separate, bounded preview queue. No playback session or room is created.
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub const VALID: &str = "m.available AND (s.kind<>'agent' OR EXISTS(SELECT 1 FROM agents a WHERE a.id=s.id AND NOT a.revoked))";
pub const FRESH: &str = "p.source_generation=m.preview_generation AND p.recipe_version=2 AND (s.kind IN ('local','agent') OR p.generated_at IS NULL OR p.generated_at>clock_timestamp()-interval '24 hours')";
const LOCK: i64 = 724198234;

#[derive(Clone)]
pub struct Settings {
    pub concurrency: usize,
    pub timeout_seconds: u64,
    pub cache_bytes: i64,
    pub queue_limit: i64,
    pub input_bytes: u64,
}
impl Settings {
    pub fn configured() -> anyhow::Result<Self> {
        fn number(name: &str, default: u64, max: u64) -> anyhow::Result<u64> {
            let value = std::env::var(name).unwrap_or(default.to_string()).parse()?;
            anyhow::ensure!((1..=max).contains(&value), "invalid {name}");
            Ok(value)
        }
        Ok(Self {
            concurrency: number("MEDIA_PREVIEW_CONCURRENCY", 1, 8)? as usize,
            timeout_seconds: number("MEDIA_PREVIEW_TIMEOUT_SECONDS", 30, 120)?,
            cache_bytes: number(
                "MEDIA_PREVIEW_CACHE_BYTES",
                128 * 1024 * 1024,
                1024 * 1024 * 1024,
            )? as i64,
            queue_limit: number("MEDIA_PREVIEW_QUEUE_LIMIT", 128, 4096)? as i64,
            input_bytes: number(
                "MEDIA_PREVIEW_INPUT_BYTES",
                256 * 1024 * 1024,
                1024 * 1024 * 1024,
            )?,
        })
    }
}
pub async fn enqueue(db: &PgPool, ids: &[Uuid], limit: i64) -> anyhow::Result<bool> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(LOCK)
        .execute(&mut *tx)
        .await?;
    for id in ids {
        let eligible=sqlx::query(&format!("SELECT m.preview_generation FROM media_items m JOIN sources s ON s.id=m.source_id LEFT JOIN media_previews p ON p.media_id=m.id WHERE m.id=$1 AND {VALID} AND (p.media_id IS NULL OR NOT ({FRESH}) OR (p.status='unavailable' AND p.next_attempt_at<=clock_timestamp())) FOR UPDATE OF m"))
            .bind(id).fetch_optional(&mut *tx).await?;
        let Some(row) = eligible else { continue };
        let count: i64 = sqlx::query_scalar(
            &format!("SELECT count(*) FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE p.status IN ('queued','running') AND p.media_id<>$1 AND {VALID} AND {FRESH}"),
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if count >= limit {
            return Ok(false);
        }
        sqlx::query("INSERT INTO media_previews(media_id,source_generation,recipe_version,status) VALUES($1,$2,2,'queued') ON CONFLICT(media_id) DO UPDATE SET source_generation=EXCLUDED.source_generation,recipe_version=2,result_revision=gen_random_uuid(),status='queued',attempt=0,attempt_id=NULL,owner_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),requested_at=clock_timestamp(),generated_at=NULL,image=NULL,image_sha256=NULL,error_code=NULL")
            .bind(id).bind(row.get::<i64,_>("preview_generation")).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}
#[derive(Clone, Debug)]
pub struct Attempt {
    pub media_id: Uuid,
    pub attempt_id: Uuid,
    pub owner_id: Uuid,
    pub generation: i64,
}
pub async fn claim(db: &PgPool, owner: Uuid) -> anyhow::Result<Option<Attempt>> {
    claim_with_limit(db, owner, 128).await
}

pub async fn claim_with_limit(
    db: &PgPool,
    owner: Uuid,
    limit: i64,
) -> anyhow::Result<Option<Attempt>> {
    anyhow::ensure!((1..=4096).contains(&limit), "invalid_preview_queue_limit");
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(LOCK)
        .execute(&mut *tx)
        .await?;
    // Expired work for a changed input retains its requested intent until there
    // is capacity to rebuild it. A live old owner is never reclaimed here.
    sqlx::query(&format!("UPDATE media_previews p SET status=CASE WHEN attempt>=3 THEN 'unavailable' ELSE 'queued' END,owner_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN attempt>=3 THEN interval '60 seconds' ELSE interval '0 seconds' END,error_code='MEDIA_PREVIEW_UNAVAILABLE' WHERE status='running' AND lease_until<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=p.media_id AND p.source_generation<>m.preview_generation AND {VALID})")).execute(&mut *tx).await?;
    let visible: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE p.status IN ('queued','running') AND {VALID} AND {FRESH}"))
        .fetch_one(&mut *tx).await?;
    if visible < limit {
        // A source rescan can commit after enqueue. Keep that queued request
        // useful without another POST, but do not resurrect all stale rows and
        // bypass the bounded admission queue. Only the new input gets a fresh
        // retry budget; request order is preserved and old UUIDs stay fenced.
        sqlx::query(&format!("UPDATE media_previews p SET source_generation=m.preview_generation,recipe_version=2,result_revision=gen_random_uuid(),status='queued',attempt=0,attempt_id=NULL,owner_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),generated_at=NULL,image=NULL,image_sha256=NULL,error_code=NULL FROM media_items m WHERE m.id=p.media_id AND p.media_id=(SELECT old.media_id FROM media_previews old JOIN media_items m ON m.id=old.media_id JOIN sources s ON s.id=m.source_id WHERE old.source_generation<>m.preview_generation AND (old.status='queued' OR (old.status='running' AND old.lease_until<=clock_timestamp())) AND {VALID} ORDER BY old.requested_at,old.media_id FOR UPDATE OF old SKIP LOCKED LIMIT 1)"))
            .execute(&mut *tx).await?;
    }
    let row=sqlx::query(&format!("SELECT p.media_id,p.source_generation FROM media_previews p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE p.status='queued' AND p.next_attempt_at<=clock_timestamp() AND {VALID} AND {FRESH} ORDER BY p.requested_at FOR UPDATE OF p SKIP LOCKED LIMIT 1")).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let attempt = Attempt {
        media_id: row.get("media_id"),
        generation: row.get("source_generation"),
        attempt_id: Uuid::new_v4(),
        owner_id: owner,
    };
    sqlx::query("UPDATE media_previews SET status='running',attempt=attempt+1,attempt_id=$2,owner_id=$3,lease_until=clock_timestamp()+interval '15 seconds' WHERE media_id=$1")
        .bind(attempt.media_id).bind(attempt.attempt_id).bind(owner).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(attempt))
}
pub async fn renew(db: &PgPool, a: &Attempt) -> anyhow::Result<bool> {
    let mut tx = db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='1500ms'")
        .execute(&mut *tx)
        .await?;
    // Lock first, then evaluate wall-clock expiry in a new statement. The
    // initial UPDATE predicate can be evaluated before waiting for a row lock.
    sqlx::query("SELECT media_id FROM media_previews WHERE media_id=$1 FOR UPDATE")
        .bind(a.media_id)
        .execute(&mut *tx)
        .await?;
    let changed=sqlx::query(&format!("UPDATE media_previews p SET lease_until=clock_timestamp()+interval '15 seconds' FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=p.media_id AND p.media_id=$1 AND p.attempt_id=$2 AND p.owner_id=$3 AND p.status='running' AND p.lease_until>clock_timestamp() AND {VALID} AND {FRESH}"))
        .bind(a.media_id).bind(a.attempt_id).bind(a.owner_id).execute(&mut *tx).await?;
    let renewed = changed.rows_affected() == 1;
    tx.commit().await?;
    Ok(renewed)
}
pub async fn finish(
    db: &PgPool,
    a: &Attempt,
    image: Option<(&[u8], &str)>,
    retry: bool,
    budget: i64,
) -> anyhow::Result<bool> {
    let mut tx = db.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='1500ms'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(LOCK)
        .execute(&mut *tx)
        .await?;
    // Lock media and agent through publication, so revoke/rescan cannot race commit.
    let media = sqlx::query("SELECT source_id FROM media_items WHERE id=$1 FOR SHARE")
        .bind(a.media_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(row) = media {
        sqlx::query("SELECT id FROM agents WHERE id=$1 FOR SHARE")
            .bind(row.get::<Uuid, _>("source_id"))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("SELECT media_id FROM media_previews WHERE media_id=$1 FOR UPDATE")
        .bind(a.media_id)
        .execute(&mut *tx)
        .await?;
    let oversized = image.is_some_and(|(bytes, _)| bytes.len() as i64 > budget);
    let image = image.filter(|_| !oversized);
    let retry = retry && !oversized;
    if let Some((bytes, _)) = image {
        loop {
            let used:i64=sqlx::query_scalar("SELECT COALESCE(sum(octet_length(image)),0)::bigint FROM media_previews WHERE media_id<>$1").bind(a.media_id).fetch_one(&mut *tx).await?;
            if used + bytes.len() as i64 <= budget {
                break;
            }
            sqlx::query("DELETE FROM media_previews WHERE media_id=(SELECT media_id FROM media_previews WHERE status='ready' AND media_id<>$1 ORDER BY accessed_at LIMIT 1)").bind(a.media_id).execute(&mut *tx).await?;
        }
    }
    let changed=sqlx::query(&format!("UPDATE media_previews p SET status=CASE WHEN $4::bytea IS NOT NULL THEN 'ready' WHEN $6 AND attempt<3 THEN 'queued' ELSE 'unavailable' END,image=$4,image_sha256=$5,generated_at=CASE WHEN $4::bytea IS NOT NULL THEN clock_timestamp() ELSE NULL END,owner_id=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $6 AND attempt<3 THEN (CASE WHEN attempt=1 THEN 2 ELSE 5 END)*interval '1 second' ELSE interval '60 seconds' END,error_code=CASE WHEN $4::bytea IS NOT NULL THEN NULL ELSE 'MEDIA_PREVIEW_UNAVAILABLE' END FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=p.media_id AND p.media_id=$1 AND p.attempt_id=$2 AND p.owner_id=$3 AND p.status='running' AND p.lease_until>clock_timestamp() AND {VALID} AND {FRESH}"))
        .bind(a.media_id).bind(a.attempt_id).bind(a.owner_id).bind(image.map(|v|v.0)).bind(image.map(|v|v.1)).bind(retry).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}
