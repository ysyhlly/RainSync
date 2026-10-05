//! Fenced, atomic visibility for incrementally completed local HLS output.
use crate::{
    media_job_timing::{OLD_PHASE_SQL, OWNED_TICK_SQL, SINGLE_PHASE_SQL, record_single},
    media_jobs::Claim,
};
use anyhow::{Result, ensure};
use media_core::job_health::{PendingJobHealth, TimingKind};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

#[derive(Clone, Debug)]
pub struct FileProof {
    pub index: i32,
    pub size_bytes: i64,
    pub sha256: String,
}

pub struct Snapshot {
    pub manifest: String,
    pub segment_count: i32,
    /// Only newly validated files are needed; retries must repeat the same proof.
    pub files: Vec<FileProof>,
}

pub async fn publish(
    pool: &PgPool,
    claim: &Claim,
    snapshot: &Snapshot,
    complete: bool,
) -> Result<bool> {
    ensure!(
        snapshot.segment_count > 0
            && snapshot.manifest.len() <= 2 * 1024 * 1024
            && snapshot.manifest.starts_with("#EXTM3U\n")
            && snapshot.manifest.ends_with('\n')
            && (if complete {
                snapshot.manifest.ends_with("#EXT-X-ENDLIST\n")
            } else {
                !snapshot.manifest.contains("#EXT-X-ENDLIST")
            }),
        "invalid_output_snapshot"
    );
    let mut count = 0;
    for name in snapshot
        .manifest
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        ensure!(
            name == format!("index{count}.m4s"),
            "invalid_snapshot_reference"
        );
        count += 1;
    }
    ensure!(
        count == snapshot.segment_count
            && snapshot
                .manifest
                .lines()
                .filter(|line| *line == "#EXT-X-MAP:URI=\"init.mp4\"")
                .count()
                == 1,
        "invalid_snapshot_reference"
    );
    for file in &snapshot.files {
        ensure!(
            file.index >= -1
                && file.index < snapshot.segment_count
                && file.size_bytes > 0
                && file.sha256.len() == 64
                && file
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid_file_proof"
        );
    }
    let mut tx = pool.begin().await?;
    let query = format!(
        "SELECT {OLD_PHASE_SQL} FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND ((j.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND j.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND j.logical_queue IS DISTINCT FROM 'remote_assets_v1') OR advanced_media_job_allowed(j.id)) AND (j.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' OR native_platform_transcode_session_allowed(j.session_id)) AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch) FOR UPDATE OF j"
    );
    let owned = sqlx::query(&query)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(_owned) = owned else {
        tx.rollback().await?;
        return Ok(false);
    };
    let output = sqlx::query("SELECT ready_segments FROM media_outputs WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND status='writing' AND validation_version=3 FOR UPDATE")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).fetch_optional(&mut *tx).await?;
    let Some(output) = output else {
        tx.rollback().await?;
        return Ok(false);
    };
    ensure!(
        snapshot.segment_count >= output.get::<i32, _>("ready_segments"),
        "output_snapshot_regressed"
    );
    let indices: Vec<i32> = snapshot.files.iter().map(|f| f.index).collect();
    let sizes: Vec<i64> = snapshot.files.iter().map(|f| f.size_bytes).collect();
    let hashes: Vec<&str> = snapshot.files.iter().map(|f| f.sha256.as_str()).collect();
    let inserted = sqlx::query("INSERT INTO media_output_files(job_id,attempt,segment_index,size_bytes,sha256) SELECT $1,$2,* FROM unnest($3::integer[],$4::bigint[],$5::text[]) ON CONFLICT(job_id,attempt,segment_index) DO UPDATE SET sha256=media_output_files.sha256 WHERE media_output_files.size_bytes=excluded.size_bytes AND media_output_files.sha256=excluded.sha256")
        .bind(claim.id).bind(claim.attempt).bind(&indices).bind(&sizes).bind(&hashes).execute(&mut *tx).await?.rows_affected();
    ensure!(
        inserted == snapshot.files.len() as u64,
        "published_output_changed"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM media_output_files WHERE job_id=$1 AND attempt=$2 AND segment_index>=-1 AND segment_index<$3")
        .bind(claim.id).bind(claim.attempt).bind(snapshot.segment_count).fetch_one(&mut *tx).await?;
    ensure!(
        count == i64::from(snapshot.segment_count) + 1,
        "missing_file_proof"
    );
    // Recheck the lease after acquiring locks and writing proofs. Disk work is
    // done before this transaction; an expired writer can never move visibility.
    let query = format!(
        r#"{OWNED_TICK_SQL}
UPDATE media_jobs j SET status=CASE WHEN $4 THEN 'succeeded' ELSE j.status END,
    lease_until=CASE WHEN $4 THEN NULL ELSE j.lease_until END,error=NULL,
    timing_version=CASE WHEN $4 THEN NULL ELSE j.timing_version END,
    timing_attempt=CASE WHEN $4 THEN NULL ELSE j.timing_attempt END,
    queue_entered_at=CASE WHEN $4 THEN NULL ELSE j.queue_entered_at END,
    run_started_at=CASE WHEN $4 THEN NULL ELSE j.run_started_at END
FROM locked l CROSS JOIN tick t,playback_sessions p
WHERE j.id=l.id AND j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running'
    AND j.lease_until>clock_timestamp() AND ((j.logical_queue IS DISTINCT FROM 'advanced_local_v1' AND j.logical_queue IS DISTINCT FROM 'advanced_owned_v1' AND j.logical_queue IS DISTINCT FROM 'remote_assets_v1') OR advanced_media_job_allowed(j.id)) AND (j.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1' OR native_platform_transcode_session_allowed(j.session_id)) AND p.id=j.session_id
    AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch)
RETURNING {SINGLE_PHASE_SQL}"#
    );
    let ended = sqlx::query(&query)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .bind(complete)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(ended) = ended else {
        tx.rollback().await?;
        return Ok(false);
    };
    sqlx::query("UPDATE media_outputs SET visible_manifest=$4,ready_segments=$5,status=CASE WHEN $6 THEN 'published' ELSE 'writing' END,manifest_sha256=$7,segment_count=CASE WHEN $6 THEN $5 ELSE segment_count END,published_at=CASE WHEN $6 THEN clock_timestamp() ELSE published_at END WHERE job_id=$1 AND attempt=$2 AND owner_id=$3")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).bind(&snapshot.manifest).bind(snapshot.segment_count).bind(complete)
        .bind(hex::encode(Sha256::digest(snapshot.manifest.as_bytes()))).execute(&mut *tx).await?;
    let mut delta = PendingJobHealth::default();
    if complete {
        record_single(&mut delta, &ended, "run_seconds", TimingKind::RunSucceeded);
    }
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(true)
}
