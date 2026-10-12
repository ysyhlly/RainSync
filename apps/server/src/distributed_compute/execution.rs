//! Live attempt operations and independently owned Server output verification.
//! The caller passes the existing database, epoch and admission owner registry.
use super::{enabled, file_path, file_validation, placement, safe_name, total_output_budget_bytes};
use crate::{Result, err, hash, preparation_owner};
use axum::{
    body::Bytes,
    http::{HeaderMap, StatusCode},
};
use media_core::distributed_compute::MAX_SEGMENT_BYTES;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Fence {
    connection_id: Uuid,
    attempt: i32,
    output_generation: Uuid,
}
async fn lock_job(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    agent: Uuid,
    f: &Fence,
) -> Result<i64> {
    let origin: Option<(Uuid, Uuid)> =
        sqlx::query_as("SELECT j.room_id,a.id FROM distributed_compute_jobs j JOIN media_items m ON m.id=j.media_id JOIN agents a ON a.id=m.source_id WHERE j.id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let (room, source_agent) =
        origin.ok_or_else(|| err(StatusCode::CONFLICT, "compute_lease_lost"))?;
    // Settings/revocation lock the device before its policy. Pin both devices
    // in UUID order before the policy, including when a replica owns the work.
    // Keeping the later authority recheck does not justify inverting that order.
    let mut agents = vec![agent, source_agent];
    agents.sort_unstable();
    agents.dedup();
    let locked =
        sqlx::query("SELECT id FROM agents WHERE id=ANY($1) AND NOT revoked ORDER BY id FOR SHARE")
            .bind(&agents)
            .fetch_all(&mut **tx)
            .await?;
    if locked.len() != agents.len() {
        return Err(err(StatusCode::CONFLICT, "compute_lease_lost"));
    }
    sqlx::query("SELECT agent_id FROM distributed_compute_policy WHERE agent_id=$1 FOR UPDATE")
        .bind(agent)
        .fetch_optional(&mut **tx)
        .await?;
    persistence::room_lifecycle::lock_active(tx, room)
        .await
        .map_err(crate::room_lifecycle::gate_error)?;
    // Serialize positive publication with room selection, source replacement, source-owner revoke,
    // library ACL epoch mutation, creator removal and creator logout.
    let origin:Option<Uuid>=sqlx::query_scalar("SELECT j.id FROM distributed_compute_jobs j JOIN media_items m ON m.id=j.media_id JOIN sources s ON s.id=m.source_id JOIN agents a ON a.id=m.source_id JOIN private_libraries l ON l.id=s.library_id JOIN room_snapshots snap ON snap.room_id=j.room_id JOIN room_members member ON member.room_id=j.room_id AND member.user_id=j.user_id AND member.membership_epoch=j.membership_epoch JOIN sessions login ON login.token_hash=j.login_hash AND login.user_id=j.user_id JOIN media_items input ON input.id=j.input_media_id WHERE j.id=$1 AND distributed_compute_authorized(j.id) FOR SHARE OF m,s,a,l,snap,member,login,input").bind(id).fetch_optional(&mut **tx).await?;
    if origin.is_none() {
        return Err(err(StatusCode::CONFLICT, "compute_lease_lost"));
    }
    let row=sqlx::query("SELECT j.output_budget_bytes FROM distributed_compute_jobs j JOIN distributed_compute_policy p ON p.agent_id=j.owner_agent JOIN distributed_compute_nodes n ON n.agent_id=j.owner_agent JOIN agents a ON a.id=j.owner_agent JOIN media_items input ON input.id=j.input_media_id WHERE j.id=$1 AND j.owner_agent=$2 AND j.owner_connection=$3 AND j.attempt=$4 AND j.output_generation=$5 AND j.status='running' AND j.lease_until>clock_timestamp() AND p.enabled AND NOT a.revoked AND j.recipe=ANY(n.capabilities) AND n.connection_id=$3 AND n.heartbeat_at>clock_timestamp()-interval '12 seconds' AND input.available AND input.source_version=j.input_version AND distributed_compute_authorized(j.id) FOR UPDATE OF j").bind(id).bind(agent).bind(f.connection_id).bind(f.attempt).bind(f.output_generation).fetch_optional(&mut **tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"compute_lease_lost"))?;
    Ok(row.get("output_budget_bytes"))
}
pub(super) async fn renew(db: &PgPool, h: HeaderMap, id: Uuid, b: Fence) -> Result<Value> {
    let agent = placement::authenticate(db, &h).await?;
    let mut tx = db.begin().await?;
    lock_job(&mut tx, id, agent, &b).await?;
    sqlx::query("UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"lease_ms":20000}))
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    #[serde(rename = "compute_output_budget_exceeded")]
    OutputBudgetExceeded,
    #[serde(rename = "compute_output_budget_insufficient")]
    OutputBudgetInsufficient,
    #[serde(rename = "compute_global_budget_exceeded")]
    GlobalBudgetExceeded,
    #[serde(rename = "compute_source_too_large")]
    SourceTooLarge,
    #[serde(rename = "compute_source_duration_unsupported")]
    SourceDurationUnsupported,
}
impl FailureReason {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::OutputBudgetExceeded => "compute_output_budget_exceeded",
            Self::OutputBudgetInsufficient => "compute_output_budget_insufficient",
            Self::GlobalBudgetExceeded => "compute_global_budget_exceeded",
            Self::SourceTooLarge => "compute_source_too_large",
            Self::SourceDurationUnsupported => "compute_source_duration_unsupported",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    connection_id: Uuid,
    attempt: i32,
    output_generation: Uuid,
    pub(super) failure_reason: Option<FailureReason>,
}
pub(super) async fn fail(db: &PgPool, h: HeaderMap, id: Uuid, b: Failure) -> Result<Value> {
    let agent = placement::authenticate(db, &h).await?;
    let mut tx = db.begin().await?;
    let fence = Fence {
        connection_id: b.connection_id,
        attempt: b.attempt,
        output_generation: b.output_generation,
    };
    lock_job(&mut tx, id, agent, &fence).await?;
    // Only bounded diagnostic codes cross the node boundary; failure never
    // releases an attempt's independent process/files drain obligation.
    let reason = b
        .failure_reason
        .as_ref()
        .map_or("node_execution_failed", FailureReason::code);
    sqlx::query("UPDATE distributed_compute_jobs SET status='failed',error=$2 WHERE id=$1")
        .bind(id)
        .bind(reason)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
fn header_fence(h: &HeaderMap) -> Result<Fence> {
    let get = |k| {
        h.get(k)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "compute_fence_required"))
    };
    Ok(Fence {
        connection_id: Uuid::parse_str(get("x-compute-connection")?)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "compute_fence_required"))?,
        attempt: get("x-compute-attempt")?
            .parse()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "compute_fence_required"))?,
        output_generation: Uuid::parse_str(get("x-compute-generation")?)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "compute_fence_required"))?,
    })
}
pub(super) async fn upload(
    db: &PgPool,
    h: HeaderMap,
    id: Uuid,
    name: String,
    body: Bytes,
) -> Result<Value> {
    let root = enabled()?;
    let agent = placement::authenticate(db, &h).await?;
    let fence = header_fence(&h)?;
    if !safe_name(&name) || body.is_empty() || body.len() as u64 > MAX_SEGMENT_BYTES {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_compute_artifact"));
    }
    let sha = hex::encode(Sha256::digest(&body));
    if h.get("x-content-sha256").and_then(|v| v.to_str().ok()) != Some(sha.as_str()) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "compute_artifact_hash_mismatch",
        ));
    }
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(72614973)")
        .execute(&mut *tx)
        .await?;
    let budget = lock_job(&mut tx, id, agent, &fence).await?;
    let old:Option<(String,i64)>=sqlx::query_as("SELECT sha256,size_bytes FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2 AND name=$3").bind(id).bind(fence.output_generation).bind(&name).fetch_optional(&mut *tx).await?;
    if let Some((previous, len)) = old {
        if previous != sha || len != body.len() as i64 {
            return Err(err(StatusCode::CONFLICT, "compute_artifact_immutable"));
        }
        tx.commit().await?;
        return Ok(json!({"ok":true,"sha256":sha}));
    }
    let (bytes,count):(i64,i64)=sqlx::query_as("SELECT COALESCE(sum(size_bytes),0)::bigint,count(*) FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2").bind(id).bind(fence.output_generation).fetch_one(&mut *tx).await?;
    if bytes + body.len() as i64 > budget || count >= 2048 {
        return Err(err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "compute_output_budget_exceeded",
        ));
    }
    let total: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(size_bytes),0)::bigint FROM distributed_compute_files",
    )
    .fetch_one(&mut *tx)
    .await?;
    let total_limit = total_output_budget_bytes();
    if total + body.len() as i64 > total_limit {
        return Err(err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "compute_global_budget_exceeded",
        ));
    }
    let path = file_path(&root, id, fence.output_generation, &name);
    let parent = path.parent().unwrap();
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(anyhow::Error::from)?;
    // A fresh O_EXCL temp file, followed by atomic publication in a generation-specific directory.
    let temp = parent.join(format!(".{}.part", Uuid::new_v4()));
    use tokio::io::AsyncWriteExt;
    let mut out = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(anyhow::Error::from)?;
    out.write_all(&body).await.map_err(anyhow::Error::from)?;
    out.sync_all().await.map_err(anyhow::Error::from)?;
    drop(out);
    tokio::fs::rename(&temp, &path)
        .await
        .map_err(anyhow::Error::from)?;
    sqlx::query("INSERT INTO distributed_compute_files(job_id,output_generation,name,sha256,size_bytes) VALUES($1,$2,$3,$4,$5)").bind(id).bind(fence.output_generation).bind(name).bind(&sha).bind(body.len() as i64).execute(&mut *tx).await?;
    // The lock is not proof of current time; expiry/revocation during disk I/O still fences commit.
    lock_job(&mut tx, id, agent, &fence).await?;
    tx.commit().await?;
    Ok(json!({"ok":true,"sha256":sha}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    connection_id: Uuid,
    attempt: i32,
    output_generation: Uuid,
    qualification: media_core::distributed_compute::Qualification,
}
pub(super) async fn finish(
    db: PgPool,
    epoch: Uuid,
    preparations: Arc<preparation_owner::Registry>,
    h: HeaderMap,
    id: Uuid,
    b: Finish,
) -> Result<Value> {
    let root = enabled()?;
    let agent = placement::authenticate(&db, &h).await?;
    let owner = preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "compute_verification_interrupted",
        )
    })?;
    // HTTP disconnect does not drop the independent process/file owner.
    tokio::spawn(async move {
        let fence=Fence{connection_id:b.connection_id,attempt:b.attempt,output_generation:b.output_generation};
        let mut q=b.qualification;
        media_core::distributed_compute::validate_qualification(&q).map_err(|_|err(StatusCode::UNPROCESSABLE_ENTITY,"compute_qualification_rejected"))?;
        let already_ready:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM distributed_compute_jobs j JOIN distributed_compute_attempts attempt ON attempt.job_id=j.id AND attempt.attempt=j.attempt WHERE j.id=$1 AND j.owner_agent=$2 AND j.owner_connection=$3 AND j.attempt=$4 AND j.output_generation=$5 AND j.status='ready' AND j.qualification_sha256 IS NOT NULL AND attempt.server_verification_reaped_at IS NOT NULL AND distributed_compute_authorized(j.id))")
            .bind(id).bind(agent).bind(fence.connection_id).bind(fence.attempt).bind(fence.output_generation).fetch_one(&db).await?;
        if already_ready{return Ok(json!({"ok":true,"output_generation":fence.output_generation,"primary_qualified":true}))}
        let mut tx=db.begin().await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        let binding=sqlx::query("SELECT input_version,content_sha256,recipe,selected_video_index,selected_audio_index FROM distributed_compute_jobs WHERE id=$1").bind(id).fetch_one(&mut *tx).await?;
        if binding.get::<Option<String>,_>("input_version").as_deref()!=Some(q.source_version.as_str())
            || binding.get::<String,_>("content_sha256")!=q.content_sha256 || binding.get::<String,_>("recipe")!=q.recipe
            || binding.get::<i32,_>("selected_video_index")!=q.selected_video_index as i32
            || binding.get::<Option<i32>,_>("selected_audio_index")!=q.selected_audio_index.map(|v|v as i32) {
            return Err(err(StatusCode::CONFLICT,"compute_qualification_binding_changed"));
        }
        file_validation::verify_files(&root,id,fence.output_generation,&mut tx).await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        let verification=Uuid::new_v4();
        let started=sqlx::query("UPDATE distributed_compute_attempts SET server_verification_id=$6,server_verification_owner_epoch=$7,server_verification_started_at=clock_timestamp() WHERE job_id=$1 AND owner_agent=$2 AND owner_connection=$3 AND attempt=$4 AND output_generation=$5 AND server_verification_id IS NULL")
            .bind(id).bind(agent).bind(fence.connection_id).bind(fence.attempt).bind(fence.output_generation).bind(verification).bind(epoch).execute(&mut *tx).await?.rows_affected();
        if started!=1{return Err(err(StatusCode::CONFLICT,"compute_verification_already_owned"))}
        tx.commit().await?;
        let manifest=file_path(&root,id,fence.output_generation,"index.m3u8");
        let scope=media_core::child_process::Scope::new();
        let checked=scope.run(async {
            let inspect=media_core::distributed_compute::check_output("ffmpeg","ffprobe",&manifest,&q.source,&q.recipe);
            tokio::pin!(inspect);
            let mut tick=tokio::time::interval(std::time::Duration::from_secs(1));
            loop {tokio::select!{
                biased;
                _=owner.cancelled()=>break Err(err(StatusCode::SERVICE_UNAVAILABLE,"compute_verification_interrupted")),
                _=tick.tick()=>{
                    let mut gate=db.begin().await?;
                    lock_job(&mut gate,id,agent,&fence).await?;
                    gate.commit().await?;
                },
                result=&mut inspect=>break result.map_err(|_|err(StatusCode::UNPROCESSABLE_ENTITY,"compute_server_output_rejected")),
            }}
        }).await;
        // Reaping is established before publication or returning an error.
        scope.shutdown().await.map_err(anyhow::Error::from)?;
        // Retain this owner through acknowledgement outages, including revoke.
        // The exact Server epoch/id can confirm only the child tree it just reaped.
        loop {
            match sqlx::query("UPDATE distributed_compute_attempts SET server_verification_reaped_at=COALESCE(server_verification_reaped_at,clock_timestamp()) WHERE job_id=$1 AND attempt=$2 AND output_generation=$3 AND server_verification_id=$4 AND server_verification_owner_epoch=$5")
                .bind(id).bind(fence.attempt).bind(fence.output_generation).bind(verification).bind(epoch).execute(&db).await {
                Ok(result) if result.rows_affected()==1=>break,
                _=>tokio::time::sleep(std::time::Duration::from_secs(1)).await,
            }
        }
        let measured=checked?;
        media_core::distributed_compute::verify_output_report(&q.output,&measured).map_err(|_|err(StatusCode::CONFLICT,"compute_output_report_mismatch"))?;
        q.output=measured;
        q.output_timestamp_offset_seconds=q.output.video.timeline.start_seconds-q.source.video.timeline.start_seconds;
        media_core::distributed_compute::validate_qualification(&q).map_err(|_|err(StatusCode::UNPROCESSABLE_ENTITY,"compute_qualification_rejected"))?;
        let qualification=serde_json::to_value(&q).map_err(anyhow::Error::from)?;
        let sha=hash(&serde_json::to_string(&qualification).map_err(anyhow::Error::from)?);
        let mut tx=db.begin().await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        file_validation::verify_files(&root,id,fence.output_generation,&mut tx).await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        sqlx::query("UPDATE distributed_compute_jobs SET status='ready',lease_until=NULL,qualification=$2,qualification_sha256=$3 WHERE id=$1")
            .bind(id).bind(qualification).bind(sha).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(json!({"ok":true,"output_generation":fence.output_generation,"primary_qualified":true}))
    }).await.map_err(anyhow::Error::from)?
}
