//! Qualified immutable NAS output in the ordinary authoritative room player.
//! Choosing an output never grants source, room, login or library authority.
use super::*;
use axum::extract::DefaultBodyLimit;
use media_core::distributed_compute::Qualification;
use sqlx::postgres::PgRow;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/playback-sessions/distributed-compute", post(start))
        .route(
            "/api/v1/playback-sessions/{id}/distributed/directory",
            get(directory),
        )
        .route(
            "/api/v1/playback-sessions/{id}/distributed/files/{name}",
            get(read),
        )
        .route(
            "/api/v1/playback-sessions/{id}/distributed/p2p",
            post(join_peer),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}
fn validate(body: &protocol::PlaybackRequest) -> Result<()> {
    let intent = body.distributed_compute.as_ref().ok_or_else(|| {
        err(
            StatusCode::BAD_REQUEST,
            "distributed_playback_intent_required",
        )
    })?;
    if intent.schema_version != 1
        || body.viewer_id.is_none()
        || body.plan_generation.is_none()
        || body.finite_hls_version.is_some()
        || body.native_platform.is_some()
        || body.advanced_playback.is_some()
        || body.local_hls_ladder.is_some()
        || body.candidate_report.is_some()
        || body.upstream_profile_report.is_some()
        || body.http_file_fallback.is_some()
        || body.http_file_fallback_version.is_some()
        || body.static_hls_fallback_version.is_some()
        || body.mode.as_deref() != Some("auto")
        || !body.position_ms.is_finite()
        || body.position_ms < 0.0
        || body.observation_version.is_some_and(|v| v != 1)
        || !body.capabilities.as_ref().is_some_and(|c| c.supports_hls())
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "invalid_distributed_playback_intent",
        ));
    }
    Ok(())
}
async fn start(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    crate::distributed_compute::enabled()?;
    validate(&body)?;
    let user = auth(&app, &h, true).await?;
    let login = crate::media_authorization::login_hash(&h)?;
    member(&app, &user, body.room_id).await?;
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    tokio::spawn(async move {
        let reservation=match playback_requests::begin_authenticated(&app,user.id,&body,Some(&login)).await? {
            playback_requests::Start::Replay(plan)=>return Ok(Json(plan)),
            playback_requests::Start::Reserved(reservation)=>reservation,
            playback_requests::Start::StaticHlsPublished{..}=>return Err(err(StatusCode::CONFLICT,"invalid_distributed_playback_intent")),
        };
        let result=tokio::select!{
            biased;
            _=owner.cancelled()=>Err(err(StatusCode::SERVICE_UNAVAILABLE,"playback_request_interrupted")),
            result=tokio::time::timeout_at(reservation.prepare_until,publish(&app,&user,&body,&reservation))=>result.unwrap_or_else(|_|Err(err(StatusCode::GATEWAY_TIMEOUT,"playback_request_interrupted"))),
        };
        let outcome=match result{
            Ok(plan)=>Ok(Json(plan)),
            Err(error)=>match playback_requests::fail(&app,&reservation,&error).await?{Some(plan)=>Ok(Json(plan)),None=>Err(error)},
        };
        // No source process is spawned here. NAS attempts retain their separate
        // positive process/file drain responsibility after publication.
        tokio::spawn(async move{owner.acknowledge(&app,&reservation).await;});
        outcome
    }).await.map_err(anyhow::Error::from)?
}
async fn lock_output(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    room: Uuid,
    user: Uuid,
    id: Uuid,
    generation: Uuid,
) -> Result<PgRow> {
    // Same ordering as compute publication and library epoch changes. No output
    // receives a new authority merely because its files still exist.
    let row=sqlx::query("SELECT j.*,m.source_id,m.metadata,f.sha256 AS manifest_sha256,FLOOR(EXTRACT(EPOCH FROM(j.expires_at-clock_timestamp())))::bigint AS remaining FROM distributed_compute_jobs j JOIN media_items m ON m.id=j.media_id JOIN sources source ON source.id=m.source_id JOIN agents agent ON agent.id=m.source_id JOIN private_libraries library ON library.id=j.library_id JOIN distributed_compute_files f ON f.job_id=j.id AND f.output_generation=j.output_generation AND f.name='index.m3u8' WHERE j.id=$1 AND j.room_id=$2 AND j.output_generation=$3 AND j.status='ready' AND j.qualification IS NOT NULL AND j.qualification_sha256 IS NOT NULL AND distributed_compute_authorized(j.id) AND library_media_allowed($4,j.media_id,'play',j.room_id) AND room_media_allowed(j.room_id,j.media_id) FOR SHARE OF j,m,source,agent,library,f")
        .bind(id).bind(room).bind(generation).bind(user).fetch_optional(&mut **tx).await?
        .ok_or_else(||err(StatusCode::GONE,"distributed_output_not_qualified"))?;
    if row.get::<i64, _>("remaining") <= 0 {
        return Err(err(StatusCode::GONE, "distributed_output_not_qualified"));
    }
    Ok(row)
}
async fn publish(
    app: &App,
    user: &User,
    body: &protocol::PlaybackRequest,
    reservation: &playback_requests::Reservation,
) -> Result<Value> {
    let intent = body.distributed_compute.as_ref().expect("validated intent");
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let row = lock_output(
        &mut tx,
        body.room_id,
        user.id,
        intent.job_id,
        intent.output_generation,
    )
    .await?;
    if row.get::<i64, _>("media_generation") != i64::from(body.media_generation) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let q: Qualification = serde_json::from_value(row.get("qualification"))
        .map_err(|_| err(StatusCode::CONFLICT, "distributed_output_not_qualified"))?;
    media_core::distributed_compute::validate_qualification(&q)
        .map_err(|_| err(StatusCode::CONFLICT, "distributed_output_not_qualified"))?;
    let selected_audio = row
        .get::<Option<i32>, _>("selected_audio_index")
        .map(|v| v as u32);
    if body.audio_index.is_some() && body.audio_index != selected_audio {
        return Err(err(
            StatusCode::CONFLICT,
            "distributed_audio_selection_changed",
        ));
    }
    let origin = q.timeline_origin_seconds * 1000.0;
    let duration = q.source.video.timeline.end_seconds * 1000.0;
    if origin < 0.0 || origin > 1.0 {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_timeline",
        ));
    }
    if body.position_ms > duration + 250.0 {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_timeline",
        ));
    }
    let id = reservation.session;
    let media: Uuid = row.get("media_id");
    let output_generation: Uuid = row.get("output_generation");
    let attempt: i32 = row.get("attempt");
    let sha: String = row.get("qualification_sha256");
    let manifest_sha: String = row.get("manifest_sha256");
    let mode = if q.recipe == "remux_hls_v1" {
        "remux"
    } else {
        "transcode"
    };
    let resource = json!({"kind":"agent","source_id":row.get::<Uuid,_>("source_id"),"resource":"distributed_generated_output","delivery_mode":mode,"transport":"hls","timeline_origin_ms":origin,"source_version":row.get::<String,_>("source_version"),"distributed_job_id":intent.job_id,"distributed_output_generation":output_generation,"distributed_attempt":attempt});
    let outer = json!({"encrypted":app.encrypt(&resource)?,"source_policy_revision":row.get::<i64,_>("source_revision"),"account_policy_generation":null,"distributed_compute_version":1,"distributed_session_id":id,"distributed_job_id":intent.job_id,"distributed_output_generation":output_generation,"distributed_attempt":attempt,"distributed_qualification_sha256":sha});
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) SELECT $1,$2,$3,$4,$5,$6,$7,j.expires_at,$8,$9,$10 FROM distributed_compute_jobs j WHERE j.id=$11 AND distributed_compute_authorized(j.id)")
        .bind(id).bind(user.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&token())).bind(outer).bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).bind(intent.job_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO distributed_playback_bindings(session_id,job_id,attempt,output_generation,manifest_sha256,qualification_sha256,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(id).bind(intent.job_id).bind(attempt).bind(output_generation).bind(&manifest_sha).bind(&sha).bind(duration).execute(&mut *tx).await?;
    let tracks = selected_audio
        .map(|index| protocol::MediaTrack {
            index,
            label: format!("原片音轨 {}", index),
            language: "und".into(),
            url: None,
        })
        .into_iter()
        .collect();
    let facts = protocol::DistributedComputePlaybackFacts {
        schema_version: 1,
        job_id: intent.job_id,
        output_generation,
        attempt: attempt as u32,
        qualification_sha256: sha,
        manifest_sha256: manifest_sha,
        directory_url: format!("/api/v1/playback-sessions/{id}/distributed/directory"),
        p2p_enabled: std::env::var("RAINSYNC_P2P_ENABLED").as_deref() == Ok("1"),
        source_video_index: q.selected_video_index,
        source_audio_index: q.selected_audio_index,
        video_codec: q.output.video.codec.clone(),
        width: q.output.video.width,
        height: q.output.video.height,
        audio_codec: q.output.audio.as_ref().map(|a| a.codec.clone()),
        audio_channels: q.output.audio.as_ref().map(|a| a.channels),
        audio_sample_rate: q.output.audio.as_ref().map(|a| a.sample_rate),
        source_duration_ms: duration,
        timestamp_shift_ms: q.output_timestamp_offset_seconds * 1000.0,
    };
    let plan = protocol::PlaybackPlan {
        distributed_compute: Some(facts),
        local_hls_ladder: None,
        advanced_playback: None,
        native_platform: None,
        upstream_profile: None,
        session_id: id,
        plan_generation: reservation.plan_generation,
        media_id: media,
        media_generation: body.media_generation,
        delivery_mode: mode.into(),
        transport: "hls".into(),
        playback_url: format!("/api/v1/playback-sessions/{id}/distributed/files/index.m3u8"),
        timeline_origin_ms: origin,
        duration_ms: Some(duration),
        expires_in_seconds: row.get::<i64, _>("remaining") as u32,
        rebuild_on_seek: false,
        audio_tracks: tracks,
        subtitle_tracks: vec![],
        decision_reason: Some("qualified_nas_distributed_output".into()),
        selected_audio_track: selected_audio,
        selected_candidate_id: None,
        selected_output: None,
        subtitle_mode: Some(protocol::SubtitleDeliveryMode::None),
        seekable_media_ranges_ms: Some(vec![
            protocol::PlaybackMediaRange::new(origin, duration)
                .ok_or_else(|| err(StatusCode::CONFLICT, "unsupported_timeline"))?,
        ]),
        pending_job_id: None,
        decoder_fallback_modes: Some(vec![]),
        http_file_fallback_version: None,
        static_hls_fallback_version: None,
        observation_version: body.observation_version,
        observation_seq: body.observation_version.map(|_| 0),
        playback_metrics_version: None,
        playback_metrics: None,
    };
    if body.observation_version == Some(1) {
        persistence::playback_observations::create(&mut tx, user.id, body.room_id, &plan).await?
    }
    let mut value = serde_json::to_value(&plan).map_err(anyhow::Error::from)?;
    if let Some((version, grant)) =
        playback_metrics::publish(&mut tx, user.id, body, id, &resource).await?
    {
        value["playback_metrics_version"] = json!(version);
        value["playback_metrics"] = grant;
    }
    playback_requests::guard(app, &mut tx, reservation).await?;
    let valid: bool = sqlx::query_scalar("SELECT distributed_playback_session_authorized($1)")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !valid {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    playback_requests::complete(app, &mut tx, reservation, &value).await?;
    tx.commit().await?;
    // The protocol plan is frozen per-viewer; room clock remains original source time.
    Ok(value)
}
pub(super) async fn viewer(app: &App, h: &HeaderMap, id: Uuid) -> Result<(User, PgRow)> {
    let user = auth(app, h, false).await?;
    let login = crate::media_authorization::login_hash(h)?;
    let row=sqlx::query("SELECT p.room_id,b.job_id,b.attempt,b.output_generation,b.manifest_sha256,b.qualification_sha256 FROM playback_sessions p JOIN distributed_playback_bindings b ON b.session_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND p.auth_login_hash=$3 AND distributed_playback_session_authorized(p.id)")
        .bind(id).bind(user.id).bind(login).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::GONE,"invalid_playback_session"))?;
    Ok((user, row))
}
async fn directory(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let (_, scope) = viewer(&app, &h, id).await?;
    let job: Uuid = scope.get("job_id");
    let generation: Uuid = scope.get("output_generation");
    let rows=sqlx::query("SELECT name,sha256,size_bytes FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2 ORDER BY name").bind(job).bind(generation).fetch_all(&app.db).await?;
    viewer(&app, &h, id).await?;
    Ok(Json(
        json!({"session_id":id,"job_id":job,"output_generation":generation,"files":rows.iter().map(|r|{let name:String=r.get("name");json!({"name":name,"sha256":r.get::<String,_>("sha256"),"size_bytes":r.get::<i64,_>("size_bytes"),"url":format!("/api/v1/playback-sessions/{id}/distributed/files/{name}")})}).collect::<Vec<_>>()}),
    ))
}
async fn read(
    State(app): State<App>,
    h: HeaderMap,
    Path((id, name)): Path<(Uuid, String)>,
) -> Result<Response> {
    let root = crate::distributed_compute::enabled()?;
    if !crate::distributed_compute::safe_name(&name) {
        return Err(err(StatusCode::NOT_FOUND, "compute_output_not_found"));
    }
    let (_, scope) = viewer(&app, &h, id).await?;
    let job: Uuid = scope.get("job_id");
    let generation: Uuid = scope.get("output_generation");
    let (sha,len):(String,i64)=sqlx::query_as("SELECT sha256,size_bytes FROM distributed_compute_files WHERE job_id=$1 AND output_generation=$2 AND name=$3").bind(job).bind(generation).bind(&name).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"compute_output_not_found"))?;
    let bytes = tokio::fs::read(crate::distributed_compute::file_path(
        &root, job, generation, &name,
    ))
    .await
    .map_err(anyhow::Error::from)?;
    if bytes.len() as i64 != len || hex::encode(Sha256::digest(&bytes)) != sha {
        return Err(err(StatusCode::CONFLICT, "compute_artifact_changed"));
    }
    viewer(&app, &h, id).await?;
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
async fn join_peer(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(consent): Json<crate::room_p2p::Consent>,
) -> Result<Json<Value>> {
    crate::room_p2p::join_primary(app, h, id, consent).await
}
