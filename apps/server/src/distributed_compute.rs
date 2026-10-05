//! Policy-gated, fenced NAS-local jobs. The ordinary Agent token never grants compute by itself.
use super::*;
use axum::{body::Bytes, extract::DefaultBodyLimit};
use std::path::{Path as FsPath, PathBuf};

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/agents/compute", get(nodes))
        .route("/api/v1/agents/{id}/compute-policy", post(policy))
        .route("/api/v1/agent-compute/heartbeat", post(heartbeat))
        .route(
            "/api/v1/agent-compute/catalog",
            get(catalog).post(register_source),
        )
        .route("/api/v1/agent-compute/claim", post(claim))
        .route("/api/v1/agent-compute/jobs/{id}/renew", post(renew))
        .route("/api/v1/agent-compute/jobs/{id}/fail", post(fail))
        .route("/api/v1/agent-compute/jobs/{id}/reaped", post(reaped))
        .route("/api/v1/agent-compute/jobs/{id}/files/{name}", post(upload))
        .route("/api/v1/agent-compute/jobs/{id}/finish", post(finish))
        .route("/api/v1/rooms/{room}/compute", get(list_jobs).post(prepare))
        .route(
            "/api/v1/rooms/{room}/compute/{id}",
            get(status).delete(cancel),
        )
        .route(
            "/api/v1/rooms/{room}/compute/{id}/directory",
            get(directory),
        )
        .route("/api/v1/rooms/{room}/compute/{id}/files/{name}", get(read))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
}
pub(super) fn enabled() -> Result<PathBuf> {
    std::env::var_os("RAINSYNC_COMPUTE_OUTPUT_ROOT")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| err(StatusCode::SERVICE_UNAVAILABLE, "nas_compute_disabled"))
}
async fn agent(app: &App, h: &HeaderMap) -> Result<Uuid> {
    enabled()?;
    let bearer = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?;
    sqlx::query_scalar("SELECT id FROM agents WHERE token_hash=$1 AND NOT revoked")
        .bind(hash(bearer))
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "invalid_agent"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    enabled: bool,
    slots: i32,
    output_budget_bytes: i64,
}
pub async fn policy(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Policy>,
) -> Result<Json<Value>> {
    enabled()?;
    admin(&auth(&app, &h, true).await?)?;
    if !(1..=4).contains(&b.slots) || !(1048576..=1073741824).contains(&b.output_budget_bytes) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_compute_policy"));
    }
    let mut tx = app.db.begin().await?;
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agents WHERE id=$1 AND NOT revoked)")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !valid {
        return Err(err(StatusCode::NOT_FOUND, "invalid_agent"));
    }
    sqlx::query("INSERT INTO distributed_compute_policy(agent_id,enabled,slots,output_budget_bytes) VALUES($1,$2,$3,$4) ON CONFLICT(agent_id) DO UPDATE SET enabled=$2,slots=$3,output_budget_bytes=$4,revision=distributed_compute_policy.revision+1").bind(id).bind(b.enabled).bind(b.slots).bind(b.output_budget_bytes).execute(&mut *tx).await?;
    if !b.enabled {
        sqlx::query("UPDATE distributed_compute_jobs SET status='cancelled',error='compute_policy_revoked' WHERE owner_agent=$1 AND status IN('queued','running')").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn nodes(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&auth(&app, &h, false).await?)?;
    let rows=sqlx::query("SELECT a.id,a.name,p.enabled,p.slots,p.output_budget_bytes,n.capabilities,n.self_test,n.heartbeat_at::text,COALESCE(n.heartbeat_at>clock_timestamp()-interval '12 seconds',false) AND NOT a.revoked AS healthy,(SELECT count(*) FROM distributed_compute_jobs j WHERE j.owner_agent=a.id AND j.status='running' AND j.lease_until>clock_timestamp()) AS running FROM agents a LEFT JOIN distributed_compute_policy p ON p.agent_id=a.id LEFT JOIN distributed_compute_nodes n ON n.agent_id=a.id ORDER BY a.name,a.id").fetch_all(&app.db).await?;
    Ok(Json(
        json!({"enabled":enabled().is_ok(),"nodes":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"enabled":r.get::<Option<bool>,_>("enabled").unwrap_or(false),"slots":r.get::<Option<i32>,_>("slots"),"output_budget_bytes":r.get::<Option<i64>,_>("output_budget_bytes"),"capabilities":r.get::<Option<Vec<String>>,_>("capabilities"),"self_test":r.get::<Option<Value>,_>("self_test"),"heartbeat_at":r.get::<Option<String>,_>("heartbeat_at"),"healthy":r.get::<bool,_>("healthy"),"running":r.get::<i64,_>("running")})).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    connection_id: Uuid,
    capabilities: Vec<String>,
    self_test: Value,
}
pub async fn heartbeat(
    State(app): State<App>,
    h: HeaderMap,
    Json(b): Json<Heartbeat>,
) -> Result<Json<Value>> {
    let id = agent(&app, &h).await?;
    if b.capabilities.is_empty()
        || b.capabilities.len() > 2
        || b.capabilities
            .iter()
            .any(|c| !matches!(c.as_str(), "remux_hls_v1" | "h264_480p_hls_v1"))
        || !b.self_test.is_object()
        || b.self_test.to_string().len() > 2048
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_compute_capability"));
    }
    let mut tx = app.db.begin().await?;
    let policy: Option<i32> = sqlx::query_scalar(
        "SELECT slots FROM distributed_compute_policy WHERE agent_id=$1 AND enabled FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let slots = policy.ok_or_else(|| err(StatusCode::FORBIDDEN, "compute_not_authorized"))?;
    sqlx::query("INSERT INTO distributed_compute_nodes(agent_id,connection_id,capabilities,self_test) VALUES($1,$2,$3,$4) ON CONFLICT(agent_id) DO UPDATE SET connection_id=$2,capabilities=$3,self_test=$4,heartbeat_at=clock_timestamp()").bind(id).bind(b.connection_id).bind(&b.capabilities).bind(b.self_test).execute(&mut *tx).await?;
    // Changing process identity cannot renew an old owner, even on the same NAS.
    sqlx::query("UPDATE distributed_compute_jobs SET lease_until=clock_timestamp() WHERE owner_agent=$1 AND owner_connection<>$2 AND status='running'").bind(id).bind(b.connection_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"slots":slots,"heartbeat_seconds":4})))
}
pub async fn catalog(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let id = agent(&app, &h).await?;
    let rows=sqlx::query("SELECT m.id,m.resource,m.source_version FROM media_items m JOIN distributed_compute_policy p ON p.agent_id=m.source_id AND p.enabled LEFT JOIN distributed_compute_sources c ON c.media_id=m.id AND c.source_version=m.source_version WHERE m.source_id=$1 AND m.available AND m.source_version IS NOT NULL AND c.media_id IS NULL ORDER BY m.id LIMIT 32").bind(id).fetch_all(&app.db).await?;
    Ok(Json(
        json!({"items":rows.iter().map(|r|json!({"media_id":r.get::<Uuid,_>("id"),"resource":r.get::<String,_>("resource"),"source_version":r.get::<String,_>("source_version")})).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    media_id: Uuid,
    source_version: String,
    content_sha256: String,
    size_bytes: i64,
}
fn digest(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub async fn register_source(
    State(app): State<App>,
    h: HeaderMap,
    Json(b): Json<Source>,
) -> Result<Json<Value>> {
    let id = agent(&app, &h).await?;
    if !media_core::file_version::valid_file_version(&b.source_version)
        || !digest(&b.content_sha256)
        || b.size_bytes <= 0
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_compute_source"));
    }
    let n=sqlx::query("INSERT INTO distributed_compute_sources(media_id,agent_id,source_version,content_sha256,size_bytes) SELECT m.id,$1,$3,$4,$5 FROM media_items m JOIN distributed_compute_policy p ON p.agent_id=$1 AND p.enabled WHERE m.id=$2 AND m.source_id=$1 AND m.available AND m.source_version=$3 ON CONFLICT(media_id) DO UPDATE SET source_version=$3,content_sha256=$4,size_bytes=$5,verified_at=clock_timestamp()").bind(id).bind(b.media_id).bind(b.source_version).bind(b.content_sha256).bind(b.size_bytes).execute(&app.db).await?.rows_affected();
    if n != 1 {
        return Err(err(StatusCode::CONFLICT, "compute_source_changed"));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn list_jobs(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, false).await?;
    let rows=sqlx::query("SELECT j.id,j.status,j.recipe,j.attempt,j.output_generation,j.qualification_sha256,j.selected_audio_index FROM distributed_compute_jobs j JOIN room_members member ON member.room_id=j.room_id AND member.user_id=$2 WHERE j.room_id=$1 AND distributed_compute_authorized(j.id) AND library_media_allowed($2,j.media_id,'play',j.room_id) ORDER BY j.created_at DESC LIMIT 32").bind(room).bind(user.id).fetch_all(&app.db).await?;
    let source=sqlx::query("SELECT m.metadata,m.source_version FROM room_snapshots snap JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid JOIN room_members member ON member.room_id=snap.room_id AND member.user_id=$2 WHERE snap.room_id=$1 AND library_media_allowed($2,m.id,'play',snap.room_id) AND room_media_allowed(snap.room_id,m.id)")
        .bind(room).bind(user.id).fetch_optional(&app.db).await?;
    let metadata = source
        .as_ref()
        .map(|r| r.get::<Value, _>("metadata"))
        .unwrap_or_else(|| json!({}));
    let version = source
        .as_ref()
        .and_then(|r| r.get::<Option<String>, _>("source_version"));
    let probe_ready = version
        .as_deref()
        .is_some_and(|v| metadata["capability_source_version"].as_str() == Some(v));
    let tracks: Vec<Value> = if probe_ready {
        metadata["streams"].as_array().into_iter().flatten()
        .filter(|s|s["codec_type"]=="audio")
        .filter_map(|s|s["index"].as_u64().filter(|i|*i<=65535).map(|index|json!({"index":index,"label":s["tags"]["title"].as_str().filter(|v|v.len()<=100).map(str::to_owned).unwrap_or_else(||format!("原片音轨 {index}")),"language":s["tags"]["language"].as_str().filter(|v|v.len()<=32).unwrap_or("und")})))
        .collect()
    } else {
        vec![]
    };
    Ok(Json(
        json!({"enabled":enabled().is_ok(),"p2p_enabled":std::env::var("RAINSYNC_P2P_ENABLED").as_deref()==Ok("1"),"source_probe_ready":probe_ready,"source_audio_tracks":tracks,"jobs":rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"status":r.get::<String,_>("status"),"recipe":r.get::<String,_>("recipe"),"attempt":r.get::<i32,_>("attempt"),"output_generation":r.get::<Option<Uuid>,_>("output_generation"),"primary_qualified":r.get::<Option<String>,_>("qualification_sha256").is_some(),"selected_audio_index":r.get::<Option<i32>,_>("selected_audio_index")})).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    media_generation: i64,
    recipe: String,
    audio_index: Option<u32>,
}
pub async fn prepare(
    State(app): State<App>,
    h: HeaderMap,
    Path(room): Path<Uuid>,
    Json(b): Json<Prepare>,
) -> Result<Json<Value>> {
    enabled()?;
    let user = auth(&app, &h, true).await?;
    if !matches!(b.recipe.as_str(), "remux_hls_v1" | "h264_480p_hls_v1") {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_compute_recipe"));
    }
    let login = crate::media_authorization::login_hash(&h)?;
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
    persistence::room_lifecycle::lock_active(&mut tx, room)
        .await
        .map_err(crate::room_lifecycle::gate_error)?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM distributed_compute_jobs WHERE room_id=$1 AND status IN('queued','running') AND expires_at>clock_timestamp()").bind(room).fetch_one(&mut *tx).await?;
    if count >= 2 {
        return Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "compute_room_queue_full",
        ));
    }
    let metadata: Value = sqlx::query_scalar("SELECT m.metadata FROM room_snapshots snap JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid WHERE snap.room_id=$1 AND (snap.state->>'media_generation')::bigint=$2 FOR SHARE OF m")
        .bind(room).bind(b.media_generation).fetch_optional(&mut *tx).await?
        .ok_or_else(|| err(StatusCode::CONFLICT,"compute_source_not_ready"))?;
    let streams = metadata["streams"].as_array();
    let index = |stream: &Value| {
        stream["index"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .filter(|v| *v <= 65535)
    };
    // Indexing itself has no probe metadata. A bounded explicit audio index is
    // frozen here and must be proven by the NAS's version/hash-bound full probe.
    // An unknown default never grants an inferred audio mapping; the NAS rejects
    // any source audio when the frozen choice is None. Sparse inputs still keep
    // their real cleanup obligation before verification fails.
    let selected_video = streams
        .and_then(|v| {
            v.iter()
                .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1)
        })
        .and_then(index)
        .unwrap_or(0);
    let selected_audio = match b.audio_index {
        Some(requested) => {
            if requested > 65535
                || streams.is_some_and(|v| {
                    !v.iter()
                        .any(|s| s["codec_type"] == "audio" && index(s) == Some(requested))
                })
            {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    "compute_audio_track_unavailable",
                ));
            }
            Some(requested)
        }
        None => streams
            .and_then(|v| v.iter().find(|s| s["codec_type"] == "audio"))
            .and_then(index),
    };
    let n=sqlx::query("INSERT INTO distributed_compute_jobs(id,room_id,user_id,login_hash,membership_epoch,media_id,media_generation,lifecycle_epoch,source_version,source_revision,content_sha256,source_bytes,recipe,selected_video_index,selected_audio_index) SELECT $1,r.id,$3,$5,member.membership_epoch,m.id,$4,r.lifecycle_epoch,m.source_version,src.access_policy_revision,c.content_sha256,c.size_bytes,$6,$7,$8 FROM rooms r JOIN room_snapshots snap ON snap.room_id=r.id JOIN room_members member ON member.room_id=r.id AND member.user_id=$3 JOIN media_items m ON m.id=(snap.state->>'media_id')::uuid JOIN sources src ON src.id=m.source_id JOIN agents a ON a.id=m.source_id AND NOT a.revoked JOIN distributed_compute_sources c ON c.media_id=m.id AND c.source_version=m.source_version WHERE r.id=$2 AND r.lifecycle='active' AND (snap.state->>'media_generation')::bigint=$4 AND m.available AND playback_origin_allowed($3,r.id,$5,member.membership_epoch) AND library_media_allowed($3,m.id,'play',r.id)").bind(id).bind(room).bind(user.id).bind(b.media_generation).bind(login).bind(b.recipe).bind(selected_video as i32).bind(selected_audio.map(|v|v as i32)).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(err(StatusCode::CONFLICT, "compute_source_not_ready"));
    }
    tx.commit().await?;
    Ok(Json(json!({"id":id,"status":"queued"})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    connection_id: Uuid,
}
pub async fn claim(
    State(app): State<App>,
    h: HeaderMap,
    Json(b): Json<Connection>,
) -> Result<Json<Value>> {
    let agent = agent(&app, &h).await?;
    let mut tx = app.db.begin().await?;
    let row=sqlx::query("SELECT p.slots,p.output_budget_bytes,n.capabilities FROM distributed_compute_policy p JOIN distributed_compute_nodes n ON n.agent_id=p.agent_id JOIN agents a ON a.id=p.agent_id WHERE p.agent_id=$1 AND p.enabled AND NOT a.revoked AND n.connection_id=$2 AND n.heartbeat_at>clock_timestamp()-interval '12 seconds' FOR UPDATE OF p").bind(agent).bind(b.connection_id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::FORBIDDEN,"compute_node_unhealthy"))?;
    let running:i64=sqlx::query_scalar("SELECT count(*) FROM distributed_compute_jobs WHERE owner_agent=$1 AND status='running' AND lease_until>clock_timestamp()").bind(agent).fetch_one(&mut *tx).await?;
    if running >= i64::from(row.get::<i32, _>("slots")) {
        return Ok(Json(json!({"job":null,"reason":"node_full"})));
    }
    let caps: Vec<String> = row.get("capabilities");
    let budget: i64 = row.get("output_budget_bytes");
    // Prefer the original source owner; equivalent replicas are scoped by authenticated content identity.
    let job=sqlx::query("SELECT j.id,c.media_id,m.resource,c.source_version,j.recipe,j.selected_video_index,j.selected_audio_index,c.content_sha256,c.size_bytes,j.attempt FROM distributed_compute_jobs j JOIN distributed_compute_sources c ON c.agent_id=$1 AND c.content_sha256=j.content_sha256 AND c.size_bytes=j.source_bytes JOIN media_items m ON m.id=c.media_id AND m.available AND m.source_id=$1 AND m.source_version=c.source_version WHERE (j.status='queued' OR (j.status='running' AND j.lease_until<=clock_timestamp())) AND j.attempt<3 AND j.recipe=ANY($2) AND distributed_compute_authorized(j.id) ORDER BY (m.id=j.media_id) DESC,j.created_at LIMIT 1").bind(agent).bind(caps).fetch_optional(&mut *tx).await?;
    let Some(j) = job else {
        tx.commit().await?;
        return Ok(Json(json!({"job":null})));
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
    Ok(Json(
        json!({"job":{"id":id,"attempt":attempt,"output_generation":generation,"lease_ms":20000,"resource":j.get::<String,_>("resource"),"source_version":j.get::<String,_>("source_version"),"content_sha256":j.get::<String,_>("content_sha256"),"source_bytes":j.get::<i64,_>("size_bytes"),"recipe":j.get::<String,_>("recipe"),"selected_video_index":j.get::<i32,_>("selected_video_index"),"selected_audio_index":j.get::<Option<i32>,_>("selected_audio_index"),"output_budget_bytes":budget}}),
    ))
}
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
    let room: Option<Uuid> =
        sqlx::query_scalar("SELECT room_id FROM distributed_compute_jobs WHERE id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    let room = room.ok_or_else(|| err(StatusCode::CONFLICT, "compute_lease_lost"))?;
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
    let row=sqlx::query("SELECT j.output_budget_bytes FROM distributed_compute_jobs j JOIN distributed_compute_policy p ON p.agent_id=j.owner_agent JOIN distributed_compute_nodes n ON n.agent_id=j.owner_agent JOIN agents a ON a.id=j.owner_agent JOIN media_items input ON input.id=j.input_media_id WHERE j.id=$1 AND j.owner_agent=$2 AND j.owner_connection=$3 AND j.attempt=$4 AND j.output_generation=$5 AND j.status='running' AND j.lease_until>clock_timestamp() AND p.enabled AND NOT a.revoked AND n.connection_id=$3 AND n.heartbeat_at>clock_timestamp()-interval '12 seconds' AND input.available AND input.source_version=j.input_version AND distributed_compute_authorized(j.id) FOR UPDATE OF j").bind(id).bind(agent).bind(f.connection_id).bind(f.attempt).bind(f.output_generation).fetch_optional(&mut **tx).await?.ok_or_else(||err(StatusCode::CONFLICT,"compute_lease_lost"))?;
    Ok(row.get("output_budget_bytes"))
}
pub async fn renew(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Fence>,
) -> Result<Json<Value>> {
    let agent = agent(&app, &h).await?;
    let mut tx = app.db.begin().await?;
    lock_job(&mut tx, id, agent, &b).await?;
    sqlx::query("UPDATE distributed_compute_jobs SET lease_until=clock_timestamp()+interval '20 seconds' WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"lease_ms":20000})))
}
pub async fn fail(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Fence>,
) -> Result<Json<Value>> {
    let agent = agent(&app, &h).await?;
    let mut tx = app.db.begin().await?;
    lock_job(&mut tx, id, agent, &b).await?;
    sqlx::query("UPDATE distributed_compute_jobs SET status='failed',error='node_execution_failed' WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub(super) fn safe_name(name: &str) -> bool {
    name == "index.m3u8"
        || (name.len() == 15
            && name.starts_with("segment")
            && name.ends_with(".ts")
            && name[7..12].bytes().all(|b| b.is_ascii_digit()))
}
pub(super) fn file_path(root: &FsPath, id: Uuid, generation: Uuid, name: &str) -> PathBuf {
    root.join(id.to_string())
        .join(generation.to_string())
        .join(name)
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
pub async fn upload(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, name)): Path<(Uuid, String)>,
    body: Bytes,
) -> Result<Json<Value>> {
    let root = enabled()?;
    let agent = agent(&app, &h).await?;
    let fence = header_fence(&h)?;
    if !safe_name(&name) || body.is_empty() || body.len() > 8388608 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_compute_artifact"));
    }
    let sha = hex::encode(Sha256::digest(&body));
    if h.get("x-content-sha256").and_then(|v| v.to_str().ok()) != Some(sha.as_str()) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "compute_artifact_hash_mismatch",
        ));
    }
    let mut tx = app.db.begin().await?;
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
        return Ok(Json(json!({"ok":true,"sha256":sha})));
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
    let total_limit = std::env::var("RAINSYNC_COMPUTE_TOTAL_BYTES")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n >= 1048576)
        .unwrap_or(1073741824);
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
    Ok(Json(json!({"ok":true,"sha256":sha})))
}
fn playlist_segments(bytes: &[u8]) -> anyhow::Result<Vec<String>> {
    let text = std::str::from_utf8(bytes)?;
    anyhow::ensure!(
        text.starts_with("#EXTM3U\n") && text.lines().any(|s| s == "#EXT-X-ENDLIST"),
        "invalid_hls_manifest"
    );
    let mut files = Vec::new();
    let mut duration = false;
    for line in text.lines() {
        if line.starts_with("#EXTINF:") {
            let d = line
                .trim_start_matches("#EXTINF:")
                .trim_end_matches(',')
                .parse::<f64>()?;
            anyhow::ensure!(
                d.is_finite() && d > 0.0 && d <= 30.0,
                "invalid_segment_duration"
            );
            duration = true;
        } else if !line.is_empty() && !line.starts_with('#') {
            anyhow::ensure!(
                duration
                    && safe_name(line)
                    && line != "index.m3u8"
                    && !files.iter().any(|s| s == line),
                "invalid_hls_segment"
            );
            files.push(line.to_string());
            duration = false;
        } else if line.contains("URI=")
            || line.starts_with("#EXT-X-KEY")
            || line.starts_with("#EXT-X-STREAM-INF")
        {
            anyhow::bail!("unsupported_hls_manifest")
        }
    }
    anyhow::ensure!(!files.is_empty() && !duration, "empty_hls_manifest");
    Ok(files)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    connection_id: Uuid,
    attempt: i32,
    output_generation: Uuid,
    qualification: media_core::distributed_compute::Qualification,
}
async fn verify_files(
    root: &FsPath,
    id: Uuid,
    generation: Uuid,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> Result<()> {
    let manifest = tokio::fs::read(file_path(root, id, generation, "index.m3u8"))
        .await
        .map_err(anyhow::Error::from)?;
    let files = playlist_segments(&manifest)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_compute_manifest"))?;
    let rows=sqlx::query("SELECT name,sha256,size_bytes FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2").bind(id).bind(generation).fetch_all(&mut **tx).await?;
    if rows.len() != files.len() + 1 {
        return Err(err(StatusCode::CONFLICT, "incomplete_compute_artifact"));
    }
    for row in &rows {
        let name: String = row.get("name");
        if name != "index.m3u8" && !files.contains(&name) {
            return Err(err(StatusCode::CONFLICT, "unreferenced_compute_artifact"));
        }
        let bytes = tokio::fs::read(file_path(root, id, generation, &name))
            .await
            .map_err(anyhow::Error::from)?;
        if bytes.len() as i64 != row.get::<i64, _>("size_bytes")
            || hex::encode(Sha256::digest(&bytes)) != row.get::<String, _>("sha256")
        {
            return Err(err(StatusCode::CONFLICT, "compute_artifact_changed"));
        }
    }
    Ok(())
}
pub async fn finish(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Finish>,
) -> Result<Json<Value>> {
    let root = enabled()?;
    let agent = agent(&app, &h).await?;
    let owner = app.preparations.admit().ok_or_else(|| {
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
            .bind(id).bind(agent).bind(fence.connection_id).bind(fence.attempt).bind(fence.output_generation).fetch_one(&app.db).await?;
        if already_ready{return Ok(Json(json!({"ok":true,"output_generation":fence.output_generation,"primary_qualified":true})))}
        let mut tx=app.db.begin().await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        let binding=sqlx::query("SELECT input_version,content_sha256,recipe,selected_video_index,selected_audio_index FROM distributed_compute_jobs WHERE id=$1").bind(id).fetch_one(&mut *tx).await?;
        if binding.get::<Option<String>,_>("input_version").as_deref()!=Some(q.source_version.as_str())
            || binding.get::<String,_>("content_sha256")!=q.content_sha256 || binding.get::<String,_>("recipe")!=q.recipe
            || binding.get::<i32,_>("selected_video_index")!=q.selected_video_index as i32
            || binding.get::<Option<i32>,_>("selected_audio_index")!=q.selected_audio_index.map(|v|v as i32) {
            return Err(err(StatusCode::CONFLICT,"compute_qualification_binding_changed"));
        }
        verify_files(&root,id,fence.output_generation,&mut tx).await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        let verification=Uuid::new_v4();
        let started=sqlx::query("UPDATE distributed_compute_attempts SET server_verification_id=$6,server_verification_owner_epoch=$7,server_verification_started_at=clock_timestamp() WHERE job_id=$1 AND owner_agent=$2 AND owner_connection=$3 AND attempt=$4 AND output_generation=$5 AND server_verification_id IS NULL")
            .bind(id).bind(agent).bind(fence.connection_id).bind(fence.attempt).bind(fence.output_generation).bind(verification).bind(app.epoch).execute(&mut *tx).await?.rows_affected();
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
                    let mut gate=app.db.begin().await?;
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
                .bind(id).bind(fence.attempt).bind(fence.output_generation).bind(verification).bind(app.epoch).execute(&app.db).await {
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
        let mut tx=app.db.begin().await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        verify_files(&root,id,fence.output_generation,&mut tx).await?;
        lock_job(&mut tx,id,agent,&fence).await?;
        sqlx::query("UPDATE distributed_compute_jobs SET status='ready',lease_until=NULL,qualification=$2,qualification_sha256=$3 WHERE id=$1")
            .bind(id).bind(qualification).bind(sha).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Json(json!({"ok":true,"output_generation":fence.output_generation,"primary_qualified":true})))
    }).await.map_err(anyhow::Error::from)?
}
pub(super) async fn viewer(app: &App, h: &HeaderMap, room: Uuid, id: Uuid) -> Result<(User, Uuid)> {
    let user = auth(app, h, false).await?;
    let generation:Option<Uuid>=sqlx::query_scalar("SELECT j.output_generation FROM distributed_compute_jobs j JOIN room_members member ON member.room_id=j.room_id AND member.user_id=$3 WHERE j.id=$1 AND j.room_id=$2 AND distributed_compute_authorized(j.id) AND library_media_allowed($3,j.media_id,'play',j.room_id)").bind(id).bind(room).bind(user.id).fetch_optional(&app.db).await?.flatten();
    let generation =
        generation.ok_or_else(|| err(StatusCode::NOT_FOUND, "compute_output_not_found"))?;
    Ok((user, generation))
}
pub async fn status(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, false).await?;
    let row=sqlx::query("SELECT j.status,j.attempt,j.output_generation,j.owner_agent,j.error FROM distributed_compute_jobs j JOIN room_members member ON member.room_id=j.room_id AND member.user_id=$3 WHERE j.id=$1 AND j.room_id=$2 AND distributed_compute_authorized(j.id) AND library_media_allowed($3,j.media_id,'play',j.room_id)").bind(id).bind(room).bind(user.id).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"compute_job_not_found"))?;
    Ok(Json(
        json!({"id":id,"status":row.get::<String,_>("status"),"attempt":row.get::<i32,_>("attempt"),"output_generation":row.get::<Option<Uuid>,_>("output_generation"),"owner_agent":row.get::<Option<Uuid>,_>("owner_agent"),"error":row.get::<Option<String>,_>("error"),"manifest_url":format!("/api/v1/rooms/{room}/compute/{id}/files/index.m3u8")}),
    ))
}
pub async fn cancel(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, true).await?;
    let n=sqlx::query("UPDATE distributed_compute_jobs j SET status='cancelled',error='viewer_cancelled' WHERE j.id=$1 AND j.room_id=$2 AND j.user_id=$3 AND j.status IN('queued','running','ready')").bind(id).bind(room).bind(user.id).execute(&app.db).await?.rows_affected();
    if n != 1 {
        return Err(err(StatusCode::NOT_FOUND, "compute_job_not_found"));
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn directory(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    let (_, generation) = viewer(&app, &h, room, id).await?;
    let ready: bool =
        sqlx::query_scalar("SELECT status='ready' FROM distributed_compute_jobs WHERE id=$1")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    if !ready {
        return Err(err(StatusCode::CONFLICT, "compute_output_not_ready"));
    }
    let rows=sqlx::query("SELECT name,sha256,size_bytes FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2 ORDER BY name").bind(id).bind(generation).fetch_all(&app.db).await?;
    Ok(Json(
        json!({"job_id":id,"output_generation":generation,"files":rows.iter().map(|r|{let name:String=r.get("name");json!({"name":name,"sha256":r.get::<String,_>("sha256"),"size_bytes":r.get::<i64,_>("size_bytes"),"url":format!("/api/v1/rooms/{room}/compute/{id}/files/{name}")})}).collect::<Vec<_>>()}),
    ))
}
pub async fn read(
    State(app): State<App>,
    h: HeaderMap,
    Path((room, id, name)): Path<(Uuid, Uuid, String)>,
) -> Result<Response> {
    let root = enabled()?;
    if !safe_name(&name) {
        return Err(err(StatusCode::NOT_FOUND, "compute_output_not_found"));
    }
    let (_, generation) = viewer(&app, &h, room, id).await?;
    let record:Option<(String,i64)>=sqlx::query_as("SELECT f.sha256,f.size_bytes FROM distributed_compute_files f JOIN distributed_compute_jobs j ON j.id=f.job_id AND j.status='ready' WHERE f.job_id=$1 AND f.output_generation=$2 AND f.name=$3").bind(id).bind(generation).bind(&name).fetch_optional(&app.db).await?;
    let (sha, len) =
        record.ok_or_else(|| err(StatusCode::NOT_FOUND, "compute_output_not_found"))?;
    let bytes = tokio::fs::read(file_path(&root, id, generation, &name))
        .await
        .map_err(anyhow::Error::from)?;
    if bytes.len() as i64 != len || hex::encode(Sha256::digest(&bytes)) != sha {
        return Err(err(StatusCode::CONFLICT, "compute_artifact_changed"));
    }
    viewer(&app, &h, room, id).await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                if name == "index.m3u8" {
                    "application/vnd.apple.mpegurl"
                } else {
                    "video/mp2t"
                },
            ),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_manifest() {
        assert!(
            playlist_segments(b"#EXTM3U\n#EXTINF:4.0,\nsegment00000.ts\n#EXT-X-ENDLIST\n").is_ok()
        );
        for value in [b"#EXTM3U\n#EXTINF:4,\n../x.ts\n#EXT-X-ENDLIST\n".as_slice(),b"#EXTM3U\n#EXTINF:4,\nhttps://example.com/segment00000.ts\n#EXT-X-ENDLIST\n",b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"x\"\n#EXTINF:4,\nsegment00000.ts\n#EXT-X-ENDLIST\n"]{assert!(playlist_segments(value).is_err())}
    }
}

/// Removes only expired jobs and fenced old generations under the configured private root.
/// Call from the existing single-owner maintenance loop; filesystem errors remain visible.
pub async fn cleanup(app: &App) -> anyhow::Result<()> {
    let Ok(root) = enabled() else { return Ok(()) };
    sqlx::query("UPDATE distributed_compute_jobs SET status='cancelled',error='compute_authority_lost' WHERE status IN('queued','running','ready') AND NOT distributed_compute_authorized(id)").execute(&app.db).await?;
    let mut directories = match tokio::fs::read_dir(&root).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    while let Some(job) = directories.next_entry().await? {
        let Some(id) = job
            .file_name()
            .to_str()
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        if !job.file_type().await?.is_dir() {
            continue;
        }
        let keep:Option<Uuid>=sqlx::query_scalar("SELECT output_generation FROM distributed_compute_jobs WHERE id=$1 AND expires_at>clock_timestamp() AND status IN('running','ready')").bind(id).fetch_optional(&app.db).await?.flatten();
        let mut generations = tokio::fs::read_dir(job.path()).await?;
        while let Some(generation) = generations.next_entry().await? {
            let Some(g) = generation
                .file_name()
                .to_str()
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            if Some(g) != keep && generation.file_type().await?.is_dir() {
                tokio::fs::remove_dir_all(generation.path()).await?;
                sqlx::query("DELETE FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2").bind(id).bind(g).execute(&app.db).await?;
            }
        }
        if keep.is_none() {
            let _ = tokio::fs::remove_dir(job.path()).await;
        }
    }
    sqlx::query("DELETE FROM distributed_compute_attempts a USING distributed_compute_jobs j WHERE a.job_id=j.id AND j.expires_at<clock_timestamp()-interval '48 hours' AND a.process_reaped_at IS NOT NULL AND a.files_removed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM room_cleanup_tasks c WHERE c.room_id=a.room_id AND c.completed_at IS NULL)").execute(&app.db).await?;
    sqlx::query(
        "DELETE FROM distributed_compute_jobs j WHERE expires_at<clock_timestamp()-interval '1 hour' AND NOT EXISTS(SELECT 1 FROM distributed_compute_attempts a WHERE a.job_id=j.id)",
    )
    .execute(&app.db)
    .await?;
    sqlx::query("DELETE FROM room_p2p_signals WHERE expires_at<=clock_timestamp()")
        .execute(&app.db)
        .await?;
    sqlx::query("DELETE FROM room_p2p_peers WHERE expires_at<=clock_timestamp() OR NOT room_p2p_peer_authorized(id)").execute(&app.db).await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reaped {
    connection_id: Uuid,
    attempt: i32,
    output_generation: Uuid,
    process_disposition: String,
}
/// Original scoped credentials retain only the right to settle their own already-exposed attempt.
/// Revocation disables all compute/read authority; it does not manufacture a physical drain receipt.
pub async fn reaped(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<Reaped>,
) -> Result<Json<Value>> {
    if !matches!(b.process_disposition.as_str(), "reaped" | "never_started") {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_compute_drain_receipt",
        ));
    }
    let token_hash = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(hash)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "agent_token_required"))?;
    let n=sqlx::query("UPDATE distributed_compute_attempts SET process_disposition=COALESCE(process_disposition,$6),process_reaped_at=COALESCE(process_reaped_at,clock_timestamp()),files_removed_at=COALESCE(files_removed_at,clock_timestamp()) WHERE job_id=$1 AND attempt=$2 AND output_generation=$3 AND owner_connection=$4 AND owner_token_hash=$5 AND (process_disposition IS NULL OR process_disposition=$6)").bind(id).bind(b.attempt).bind(b.output_generation).bind(b.connection_id).bind(token_hash).bind(b.process_disposition).execute(&app.db).await?.rows_affected();
    if n != 1 {
        return Err(err(
            StatusCode::FORBIDDEN,
            "compute_drain_receipt_not_owned",
        ));
    }
    Ok(Json(json!({"ok":true})))
}
/// The caller must hold its existing room cleanup transaction while checking this gate.
pub async fn room_drained(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room: Uuid,
) -> anyhow::Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT distributed_compute_room_drained($1)")
            .bind(room)
            .fetch_one(&mut **tx)
            .await?,
    )
}
