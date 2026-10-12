//! Complete original placement claim and post-commit advisory diagnostics.
use super::{Connection, budget_fits, enabled, estimated_output_bytes};
use crate::{Result, err, hash};
use axum::{
    Json,
    http::{HeaderMap, StatusCode, header},
};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub(super) async fn authenticate(db: &PgPool, h: &HeaderMap) -> Result<Uuid> {
    enabled()?;
    let bearer = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?;
    sqlx::query_scalar("SELECT id FROM agents WHERE token_hash=$1 AND NOT revoked")
        .bind(hash(bearer))
        .fetch_optional(db)
        .await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_agent"))
}
pub(super) async fn claim(db: &PgPool, h: HeaderMap, b: Connection) -> Result<Json<Value>> {
    let agent = authenticate(db, &h).await?;
    let mut tx = db.begin().await?;
    let row=sqlx::query("SELECT p.slots,p.output_budget_bytes,n.capabilities FROM distributed_compute_policy p JOIN distributed_compute_nodes n ON n.agent_id=p.agent_id JOIN agents a ON a.id=p.agent_id WHERE p.agent_id=$1 AND p.enabled AND NOT a.revoked AND n.connection_id=$2 AND n.heartbeat_at>clock_timestamp()-interval '12 seconds' FOR UPDATE OF p").bind(agent).bind(b.connection_id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::FORBIDDEN,"compute_node_unhealthy"))?;
    let running:i64=sqlx::query_scalar("SELECT count(*) FROM distributed_compute_jobs WHERE owner_agent=$1 AND status='running' AND lease_until>clock_timestamp()").bind(agent).fetch_one(&mut *tx).await?;
    if running >= i64::from(row.get::<i32, _>("slots")) {
        return Ok(Json(json!({"job":null,"reason":"node_full"})));
    }
    let caps: Vec<String> = row.get("capabilities");
    let budget: i64 = row.get("output_budget_bytes");
    // Prefer the original source owner; equivalent replicas are scoped by authenticated content identity.
    let mut candidates=sqlx::query("SELECT j.id,c.media_id,m.resource,c.source_version,j.recipe,j.selected_video_index,j.selected_audio_index,c.content_sha256,c.size_bytes,j.attempt,origin.metadata,origin.source_version AS origin_source_version FROM distributed_compute_jobs j JOIN media_items origin ON origin.id=j.media_id JOIN distributed_compute_sources c ON c.agent_id=$1 AND c.content_sha256=j.content_sha256 AND c.size_bytes=j.source_bytes JOIN media_items m ON m.id=c.media_id AND m.available AND m.source_id=$1 AND m.source_version=c.source_version WHERE (j.status='queued' OR (j.status='running' AND j.lease_until<=clock_timestamp())) AND j.attempt<3 AND j.recipe=ANY($2) AND distributed_compute_authorized(j.id) ORDER BY (m.id=j.media_id) DESC,j.created_at").bind(agent).bind(caps).fetch(&mut *tx);
    let mut rejected = Vec::new();
    let mut selected = None;
    while let Some(candidate) = candidates.try_next().await? {
        let estimate = estimated_output_bytes(
            &candidate.get::<String, _>("recipe"),
            &candidate.get::<Value, _>("metadata"),
            &candidate.get::<String, _>("origin_source_version"),
            candidate.get("size_bytes"),
            candidate
                .get::<Option<i32>, _>("selected_audio_index")
                .is_some(),
        );
        let reason = match estimate {
            Ok(estimate) if budget_fits(estimate, budget) => {
                selected = Some(candidate);
                break;
            }
            Ok(_) => "compute_output_budget_insufficient".to_owned(),
            Err(error) => error.1,
        };
        rejected.push((candidate.get::<Uuid, _>("id"), reason));
    }
    drop(candidates);
    let Some(j) = selected else {
        tx.commit().await?;
        record_rejections(db, &rejected).await;
        return Ok(Json(match rejected.first() {
            Some((_, reason)) => json!({"job":null,"reason":reason}),
            None => json!({"job":null}),
        }));
    };
    let id: Uuid = j.get("id");
    let room: Uuid = sqlx::query_scalar("SELECT room_id FROM distributed_compute_jobs WHERE id=$1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    persistence::room_lifecycle::lock_active(&mut tx, room)
        .await
        .map_err(crate::room_lifecycle::gate_error)?;
    let previous:Option<i32>=sqlx::query_scalar("SELECT attempt FROM distributed_compute_jobs WHERE id=$1 AND (status='queued' OR (status='running' AND lease_until<=clock_timestamp())) AND attempt<3 AND distributed_compute_authorized(id) FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    let Some(previous) = previous else {
        tx.commit().await?;
        return Ok(Json(json!({"job":null,"reason":"candidate_changed"})));
    };
    let generation = Uuid::new_v4();
    let attempt: i32 = previous + 1;
    sqlx::query("UPDATE distributed_compute_jobs SET status='running',attempt=$2,output_generation=$3,owner_agent=$4,owner_connection=$5,input_media_id=$6,input_version=$7,lease_until=clock_timestamp()+interval '20 seconds',output_budget_bytes=$8,error=NULL WHERE id=$1").bind(id).bind(attempt).bind(generation).bind(agent).bind(b.connection_id).bind(j.get::<Uuid,_>("media_id")).bind(j.get::<String,_>("source_version")).bind(budget).execute(&mut *tx).await?;
    let owner_token_hash = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(hash)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?;
    sqlx::query("INSERT INTO distributed_compute_attempts(job_id,room_id,attempt,output_generation,owner_agent,owner_connection,owner_token_hash) SELECT id,room_id,$2,$3,$4,$5,$6 FROM distributed_compute_jobs WHERE id=$1").bind(id).bind(attempt).bind(generation).bind(agent).bind(b.connection_id).bind(owner_token_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    record_rejections(db, &rejected).await;
    Ok(Json(
        json!({"job":{"id":id,"attempt":attempt,"output_generation":generation,"lease_ms":20000,"resource":j.get::<String,_>("resource"),"source_version":j.get::<String,_>("source_version"),"content_sha256":j.get::<String,_>("content_sha256"),"source_bytes":j.get::<i64,_>("size_bytes"),"recipe":j.get::<String,_>("recipe"),"selected_video_index":j.get::<i32,_>("selected_video_index"),"selected_audio_index":j.get::<Option<i32>,_>("selected_audio_index"),"output_budget_bytes":budget}}),
    ))
}
// Advisory diagnostics are persisted only after releasing the claim's policy,
// room and job locks. They cannot introduce a job-before-room lock inversion or
// turn an already committed lease into a failed claim response.
async fn record_rejections(db: &PgPool, rejected: &[(Uuid, String)]) {
    if rejected.is_empty() {
        return;
    }
    let ids: Vec<Uuid> = rejected.iter().map(|(id, _)| *id).collect();
    let reasons: Vec<&str> = rejected.iter().map(|(_, reason)| reason.as_str()).collect();
    let update = sqlx::query("WITH diagnostic AS (SELECT j.id,d.reason FROM distributed_compute_jobs j JOIN unnest($1::uuid[],$2::text[]) AS d(id,reason) ON j.id=d.id WHERE j.error IS DISTINCT FROM d.reason AND (j.status='queued' OR (j.status='running' AND j.lease_until<=clock_timestamp())) FOR UPDATE OF j SKIP LOCKED) UPDATE distributed_compute_jobs j SET error=d.reason FROM diagnostic d WHERE j.id=d.id")
        .bind(ids).bind(reasons).execute(db);
    // A locked rejected job or saturated pool must not hide an already-committed
    // lease from the node (whose control HTTP timeout is three seconds).
    if !matches!(
        tokio::time::timeout(std::time::Duration::from_millis(100), update).await,
        Ok(Ok(_))
    ) {
        tracing::warn!("compute admission diagnostic was not recorded");
    }
}
