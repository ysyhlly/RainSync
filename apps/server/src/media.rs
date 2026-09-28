use super::*;
use providers::SourceConfig;

pub async fn sources(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&auth(&app, &h, false).await?)?;
    let rows = sqlx::query("SELECT id,name,kind FROM sources ORDER BY name")
        .fetch_all(&app.db)
        .await?;
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind")})).collect())))
}
#[derive(Deserialize)]
pub struct Source {
    name: String,
    kind: String,
    config: SourceConfig,
}
pub async fn add_source(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Source>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    if !["local", "http", "jellyfin", "emby", "agent"].contains(&body.kind.as_str())
        || body.name.is_empty()
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_source"));
    }
    if body.kind == "local" {
        let root = std::env::var("MEDIA_ROOT").unwrap_or("/media".into());
        let allowed = std::path::Path::new(&root)
            .canonicalize()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "media_root_unavailable"))?;
        let candidate = std::path::Path::new(&body.config.root)
            .canonicalize()
            .map_err(|_| err(StatusCode::BAD_REQUEST, "source_root_unavailable"))?;
        if !candidate.starts_with(allowed) {
            return Err(err(StatusCode::FORBIDDEN, "outside_media_root"));
        }
    }
    if ["http", "jellyfin", "emby"].contains(&body.kind.as_str()) {
        providers::validate_url(&body.config.url)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
    }
    let id = Uuid::new_v4();
    let encrypted = app.encrypt(&serde_json::to_value(&body.config).unwrap())?;
    sqlx::query("INSERT INTO sources VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(body.name)
        .bind(body.kind)
        .bind(encrypted)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"id":id})))
}
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    let row = sqlx::query("SELECT kind,config_encrypted FROM sources WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let generation = Uuid::new_v4();
    sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation")
        .bind(id).bind(generation).execute(&app.db).await?;
    let items = providers::list_items(&row.get::<String, _>("kind"), &config)
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_scan_failed"))?;
    let count = items.len();
    let resources: Vec<String> = items.iter().map(|i| i.resource.clone()).collect();
    let mut batch = Vec::with_capacity(32);
    for mut item in items {
        if row.get::<String, _>("kind") == "local"
            && let Ok(path) =
                media_core::safe_path(std::path::Path::new(&config.root), &item.resource)
            && let Ok(meta) = media_core::probe(&path.to_string_lossy()).await
        {
            item.duration_ms = meta["format"]["duration"]
                .as_str()
                .and_then(|v| v.parse::<f64>().ok())
                .map(|v| v * 1000.0);
            item.metadata = meta;
            let mut sidecars = serde_json::Map::new();
            for (i, ext) in ["srt", "vtt"].iter().enumerate() {
                let relative = std::path::Path::new(&item.resource)
                    .with_extension(ext)
                    .to_string_lossy()
                    .replace('\\', "/");
                if media_core::safe_path(std::path::Path::new(&config.root), &relative).is_ok() {
                    sidecars.insert((100000 + i).to_string(), json!(relative));
                }
            }
            item.metadata["sidecars"] = Value::Object(sidecars);
        }
        batch.push(item);
        if batch.len() == 32 {
            save_scan_batch(&app, id, generation, &mut batch).await?;
        }
    }
    save_scan_batch(&app, id, generation, &mut batch).await?;
    let mut tx = app.db.begin().await?;
    guard_scan(&mut tx, id, generation).await?;
    sqlx::query(
        "UPDATE media_items SET available=false WHERE source_id=$1 AND NOT(resource=ANY($2))",
    )
    .bind(id)
    .bind(&resources)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"count":count})))
}
async fn guard_scan(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    generation: Uuid,
) -> Result<()> {
    let current: Uuid =
        sqlx::query_scalar("SELECT generation FROM source_scans WHERE source_id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
    if current != generation {
        return Err(err(StatusCode::CONFLICT, "source_scan_failed"));
    }
    Ok(())
}
async fn save_scan_batch(
    app: &App,
    id: Uuid,
    generation: Uuid,
    batch: &mut Vec<providers::Item>,
) -> Result<()> {
    let mut tx = app.db.begin().await?;
    guard_scan(&mut tx, id, generation).await?;
    for item in batch.drain(..) {
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,duration_ms=EXCLUDED.duration_ms,metadata=EXCLUDED.metadata,available=true").bind(Uuid::new_v4()).bind(id).bind(item.title).bind(item.resource).bind(item.duration_ms).bind(item.metadata).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
#[derive(Deserialize)]
pub struct LibraryQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
    #[serde(default)]
    search: String,
}
pub async fn library(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<LibraryQuery>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    let rows=sqlx::query(&format!("{} WHERE {} AND ($2::uuid IS NULL OR m.id>$2) AND strpos(lower(COALESCE(u.title,m.shared_title,m.title)),lower($3))>0 ORDER BY m.id LIMIT $4", media_titles::SELECT, media_titles::VISIBLE))
        .bind(user.id).bind(query.after).bind(query.search).bind(query.limit.unwrap_or(100).clamp(1,200)).fetch_all(&app.db).await?;
    Ok(media_titles::private_json(Value::Array(
        rows.iter().map(media_titles::media).collect(),
    )))
}
pub async fn playback(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    member(&app, &u, body.room_id).await?;
    // Dropping an HTTP waiter must not drop the reservation's executor. Start
    // ownership before begin(), including its commit/acknowledgement window.
    // Explicit cancellation still fences probe grants and final publication.
    tokio::spawn(owned_playback(app, u, body))
        .await
        .map_err(anyhow::Error::from)?
}

async fn owned_playback(app: App, u: User, body: protocol::PlaybackRequest) -> Result<Json<Value>> {
    let reservation = match playback_requests::begin(&app, u.id, &body).await? {
        playback_requests::Start::Replay(plan) => return Ok(Json(plan)),
        playback_requests::Start::Reserved(reservation) => reservation,
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        prepare_playback(&app, &u, &body, &reservation),
    )
    .await;
    let error = match result {
        Ok(Ok(plan)) => return Ok(Json(plan)),
        Ok(Err(error)) => error,
        Err(_) => err(StatusCode::GATEWAY_TIMEOUT, "playback_request_interrupted"),
    };
    if let Some(plan) = playback_requests::fail(&app, &reservation, &error).await? {
        return Ok(Json(plan));
    }
    Err(error)
}

async fn prepare_playback(
    app: &App,
    u: &User,
    body: &protocol::PlaybackRequest,
    reservation: &playback_requests::Reservation,
) -> Result<Value> {
    let state = persistence::snapshot(&app.db, body.room_id).await?;
    if state.media_generation != body.media_generation {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    if !body.position_ms.is_finite() || body.position_ms < 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    let media = state
        .media_id
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no_media"))?;
    let row=sqlx::query("SELECT m.resource,m.duration_ms,m.metadata,m.source_version,s.kind,s.config_encrypted FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available").bind(media).fetch_optional(&app.db).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    let kind: String = row.get("kind");
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let item: String = row.get("resource");
    let source_version: Option<String> = row.get("source_version");
    let mut resource = json!({"kind":kind,"resource":item,"root":config.root,"headers":{}});
    let mut meta: Value = row.get("metadata");
    let mut duration: Option<f64> = row.get("duration_ms");
    let mut position_ms = protocol::bounded_position(body.position_ms, duration);
    let mut transport = "progressive";
    let requested_mode = body.mode.as_deref().unwrap_or("auto");
    let mut mode = requested_mode;
    if !["auto", "direct", "remux", "transcode"].contains(&mode) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_mode"));
    }
    if mode == "auto" {
        mode = if kind == "local" {
            media_core::compatible_mode(&meta, body.audio_index.is_some())
                .map_err(|_| err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr"))?
        } else {
            "direct"
        };
    }
    match kind.as_str() {
        "http" => {
            resource["url"] = json!(config.url);
            resource["headers"] = json!(config.headers);
            if config
                .url
                .split('?')
                .next()
                .unwrap_or("")
                .ends_with(".m3u8")
            {
                transport = "hls";
            }
        }
        "agent" => {
            resource["agent_id"] = json!(config.agent_id);
            let version = source_version
                .as_deref()
                .filter(|v| media_core::file_version::valid_file_version(v))
                .ok_or_else(|| err(StatusCode::CONFLICT, "source_version_required"))?;
            resource["source_version"] = json!(version);
        }
        "jellyfin" | "emby" => {
            let info = providers::upstream_plan(
                &kind,
                &config,
                &item,
                &providers::PlaybackOptions {
                    position_ms,
                    audio_index: body.audio_index,
                    progressive: body
                        .capabilities
                        .as_ref()
                        .is_none_or(|c| c.progressive_h264_aac),
                    hls: body.capabilities.as_ref().is_none_or(|c| c.supports_hls()),
                    force_transcode: body.mode.as_deref() == Some("transcode"),
                },
            )
            .await
            .map_err(|_| err(StatusCode::BAD_GATEWAY, "upstream_playback_failed"))?;
            let source = info["MediaSources"]
                .as_array()
                .and_then(|v| v.first())
                .ok_or_else(|| err(StatusCode::BAD_GATEWAY, "no_media_source"))?;
            if let Some(upstream_streams) = source["MediaStreams"].as_array() {
                let mut tracks = Vec::new();
                let mut subtitle_urls = serde_json::Map::new();
                for stream in upstream_streams {
                    let audio = stream["Type"] == "Audio";
                    let subtitle =
                        stream["Type"] == "Subtitle" && stream["IsTextSubtitleStream"] == true;
                    if !audio && !subtitle {
                        continue;
                    }
                    if subtitle {
                        let Some(index) = stream["Index"].as_u64() else {
                            continue;
                        };
                        let mut url = providers::validate_url(&format!(
                            "{}/",
                            config.url.trim_end_matches('/')
                        ))?;
                        url.path_segments_mut()
                            .map_err(|_| err(StatusCode::BAD_GATEWAY, "invalid_upstream_base"))?
                            .pop_if_empty()
                            .extend([
                                "Videos",
                                &item,
                                source["Id"].as_str().unwrap_or(&item),
                                "Subtitles",
                                &index.to_string(),
                                "Stream.vtt",
                            ]);
                        subtitle_urls.insert(index.to_string(), json!(url.as_str()));
                    }
                    tracks.push(json!({"codec_type":if audio {"audio"} else {"subtitle"},"index":stream["Index"],"codec_name":if audio {stream["Codec"].clone()}else{json!("webvtt")},"tags":{"title":stream["DisplayTitle"],"language":stream["Language"]}}));
                }
                meta["streams"] = json!(tracks);
                resource["subtitle_urls"] = Value::Object(subtitle_urls);
            }
            if let Some(ticks) = source["RunTimeTicks"].as_f64() {
                duration = Some(ticks / 10000.0);
            }
            let base = providers::validate_url(&format!("{}/", config.url.trim_end_matches('/')))?;
            let use_direct = source["SupportsDirectPlay"] == true
                && body
                    .mode
                    .as_deref()
                    .is_none_or(|m| matches!(m, "auto" | "direct"))
                && body.audio_index.is_none()
                && body
                    .capabilities
                    .as_ref()
                    .is_none_or(|c| c.progressive_h264_aac);
            let url = if !use_direct && let Some(path) = source["TranscodingUrl"].as_str() {
                transport = "hls";
                mode = "transcode";
                providers::upstream_url(&base, path)
                    .map_err(|_| err(StatusCode::BAD_GATEWAY, "invalid_upstream_base"))?
                    .to_string()
            } else {
                if !use_direct {
                    return Err(err(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "upstream_no_compatible_stream",
                    ));
                }
                mode = "direct";
                format!(
                    "{}Videos/{}/stream.mp4?Static=true&MediaSourceId={}",
                    base,
                    item,
                    source["Id"].as_str().unwrap_or(&item)
                )
            };
            resource["url"] = json!(url);
            resource["upstream_session"] = info["PlaySessionId"].clone();
            resource["upstream_item"] = json!(item);
            resource["upstream_base"] = json!(config.url);
            resource["headers"] = if kind == "jellyfin" {
                json!({"Authorization":format!("MediaBrowser Token=\"{}\"",config.token)})
            } else {
                json!({"X-Emby-Token":config.token})
            };
        }
        _ => {}
    }
    let id = reservation.session;
    let t = token();
    let mut timeline = 0.0;
    if matches!(kind.as_str(), "http" | "agent") && requested_mode != "direct" {
        // Auto HTTP/NAS must probe even when the provisional mode above is direct.
        // A short-lived session lets the worker probe through the same authorized relay as playback.
        let mut preparation = app.db.begin().await?;
        playback_requests::guard(app, &mut preparation, reservation).await?;
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 minute')")
            .bind(id).bind(u.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&t)).bind(json!({"encrypted":app.encrypt(&resource)?})).execute(&mut *preparation).await?;
        preparation.commit().await?;
        let probe = async {
            let base = std::env::var("WORKER_URL").unwrap_or("http://127.0.0.1:8081".into());
            let response = reqwest::Client::new()
                .get(format!("{base}/media-delivery/{id}/probe"))
                .query(&[("token", &t)])
                .timeout(std::time::Duration::from_secs(35))
                .send()
                .await?
                .error_for_status()?;
            response.json::<Value>().await
        }
        .await;
        // The preparation grant cannot linger after failure or while the final plan is validated.
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(id)
            .execute(&app.db)
            .await?;
        meta = probe.map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
        duration = meta["format"]["duration"]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| v * 1000.0);
        let detected = media_core::compatible_mode(&meta, body.audio_index.is_some())
            .map_err(|_| err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr"))?;
        if requested_mode == "auto" {
            mode = detected;
        }
        let updated = sqlx::query("UPDATE media_items SET metadata=$2,duration_ms=$3 WHERE id=$1 AND source_version IS NOT DISTINCT FROM $4")
            .bind(media)
            .bind(&meta)
            .bind(duration)
            .bind(&source_version)
            .execute(&app.db)
            .await?;
        if updated.rows_affected() != 1 {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
    }
    let streams = meta["streams"].as_array();
    let audio_tracks = streams
        .map(|rows| {
            rows.iter()
                .filter(|s| s["codec_type"] == "audio")
                .map(|s| protocol::MediaTrack {
                    index: s["index"].as_u64().unwrap_or(0) as u32,
                    label: s["tags"]["title"].as_str().unwrap_or("Audio").into(),
                    language: s["tags"]["language"].as_str().unwrap_or("und").into(),
                    url: None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(index) = body.audio_index
        && !audio_tracks.iter().any(|t| t.index == index)
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_audio_track"));
    }
    let mut subtitle_tracks = streams
        .map(|rows| {
            rows.iter()
                .filter(|s| {
                    s["codec_type"] == "subtitle"
                        && matches!(
                            s["codec_name"].as_str(),
                            Some("subrip" | "webvtt" | "mov_text")
                        )
                })
                .map(|s| {
                    let index = s["index"].as_u64().unwrap_or(0) as u32;
                    protocol::MediaTrack {
                        index,
                        label: s["tags"]["title"].as_str().unwrap_or("Subtitle").into(),
                        language: s["tags"]["language"].as_str().unwrap_or("und").into(),
                        url: Some(format!(
                            "/media-delivery/{id}/subtitle-{index}.vtt?token={t}"
                        )),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(files) = meta["sidecars"].as_object() {
        for (index, path) in files {
            if let Ok(index) = index.parse::<u32>() {
                subtitle_tracks.push(protocol::MediaTrack {
                    index,
                    label: path.as_str().unwrap_or("Subtitle").into(),
                    language: "und".into(),
                    url: Some(format!(
                        "/media-delivery/{id}/subtitle-{index}.vtt?token={t}"
                    )),
                })
            }
        }
    }
    resource["subtitle_files"] = meta["sidecars"].clone();
    resource["subtitle_indices"] =
        json!(subtitle_tracks.iter().map(|t| t.index).collect::<Vec<_>>());
    // A progressive file exposes the original/default track to the browser.
    // Honor an explicit track selection through the local HLS mapping path.
    if body.audio_index.is_some()
        && mode == "direct"
        && matches!(kind.as_str(), "local" | "http" | "agent")
    {
        mode = media_core::compatible_mode(&meta, true)
            .map_err(|_| err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr"))?;
    }
    if let Some(caps) = &body.capabilities {
        let (selected_mode, selected_transport) =
            caps.negotiate(mode, transport).ok_or_else(|| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "device_has_no_compatible_playback_transport",
                )
            })?;
        if selected_mode != mode && matches!(kind.as_str(), "jellyfin" | "emby") {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "upstream_device_profile_required",
            ));
        }
        mode = selected_mode;
        transport = selected_transport;
    }
    position_ms = protocol::bounded_position(position_ms, duration);
    let local_job = matches!(kind.as_str(), "local" | "http" | "agent") && mode != "direct";
    if local_job {
        if mode == "remux" && (position_ms > 0.0 || media_core::hls_needs_video_transform(&meta)) {
            mode = "transcode";
        }
        transport = "hls";
        timeline = position_ms;
        resource["job_id"] = json!(id);
    }
    resource["transport"] = json!(transport);
    resource["timeline_origin_ms"] = json!(timeline);
    let encrypted = app.encrypt(&resource)?;
    let plan = protocol::PlaybackPlan {
        session_id: id,
        media_id: media,
        media_generation: body.media_generation,
        delivery_mode: mode.into(),
        transport: transport.into(),
        playback_url: format!(
            "/media-delivery/{id}/{}?token={t}",
            if transport == "hls" {
                "index.m3u8"
            } else {
                "file"
            }
        ),
        timeline_origin_ms: timeline,
        duration_ms: duration,
        expires_in_seconds: 1800,
        rebuild_on_seek: local_job,
        audio_tracks,
        subtitle_tracks,
    };
    let plan = serde_json::to_value(plan).map_err(anyhow::Error::from)?;
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let current: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?;
    if current["media_generation"].as_u64() != Some(u64::from(body.media_generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    if kind == "agent"
        && sqlx::query(
            "SELECT id FROM media_items WHERE id=$1 AND available AND source_version=$2 FOR SHARE",
        )
        .bind(media)
        .bind(&source_version)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 minutes') ON CONFLICT(id) DO UPDATE SET resource=EXCLUDED.resource,expires_at=EXCLUDED.expires_at,stopped=false").bind(id).bind(u.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&t)).bind(json!({"encrypted":encrypted})).execute(&mut *tx).await?;
    if local_job {
        let input_ticket = if kind != "local" {
            Some(app.encrypt(&json!({"token":t}))?)
        } else {
            None
        };
        let estimated_output_bytes =
            media_core::estimated_output_bytes(&meta, duration, timeline, mode == "transcode");
        let spec = json!({"root":config.root,"resource":item,"input_ticket":input_ticket,"start_seconds":timeline/1000.0,"transcode":mode=="transcode","audio_index":body.audio_index,"estimated_output_bytes":estimated_output_bytes});
        if !persistence::media_queue::enqueue(&mut tx, id, &spec, app.queue_limit).await? {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_queue_full"));
        }
    }
    playback_requests::complete(app, &mut tx, reservation, &plan).await?;
    tx.commit().await?;
    if matches!(kind.as_str(), "jellyfin" | "emby") {
        let _ = upstream::report(app, id, "start").await;
    }

    Ok(plan)
}
#[derive(Deserialize)]
pub struct ReadinessQuery {
    relative_position_ms: Option<f64>,
}

// Only the committed manifest is authoritative; never inspect FFmpeg's private file.
fn published_duration_ms(manifest: &str, segments: i32) -> Option<f64> {
    let mut count = 0;
    let mut seconds = 0.0;
    for duration in manifest
        .lines()
        .filter_map(|line| line.strip_prefix("#EXTINF:"))
    {
        let value: f64 = duration.split_once(',')?.0.parse().ok()?;
        if !value.is_finite() || value <= 0.0 {
            return None;
        }
        seconds += value;
        count += 1;
    }
    let ms = seconds * 1000.0;
    (count == segments && count > 0 && ms.is_finite()).then_some(ms)
}

pub async fn readiness(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(query): axum::extract::Query<ReadinessQuery>,
) -> Result<Json<protocol::PlaybackReadiness>> {
    let u = auth(&app, &h, false).await?;
    if query
        .relative_position_ms
        .is_some_and(|p| !p.is_finite() || p < 0.0)
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    // One statement gives permission and the current attempt a consistent snapshot.
    let row = sqlx::query("SELECT j.status AS job_status, j.error AS job_error, o.validation_version, o.ready_segments, o.visible_manifest FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id LEFT JOIN media_jobs j ON j.session_id=p.id LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND p.expires_at>now() AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(id).bind(u.id).fetch_optional(&app.db).await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    use protocol::PreparationStatus::{Preparing, Queued, Ready};
    let job: Option<String> = row.get("job_status");
    let legacy = row
        .get::<Option<i32>, _>("validation_version")
        .is_some_and(|v| v < 2);
    let available_until_ms = if job.is_none() || legacy {
        None
    } else {
        Some(
            row.get::<Option<String>, _>("visible_manifest")
                .as_deref()
                .and_then(|m| {
                    published_duration_ms(
                        m,
                        row.get::<Option<i32>, _>("ready_segments").unwrap_or(0),
                    )
                })
                .unwrap_or(0.0),
        )
    };
    let (status, complete) = match job.as_deref() {
        None => (Ready, true),
        Some("queued") => (Queued, false),
        Some("failed") => {
            let reason: Option<String> = row.get("job_error");
            let (status, reason) = persistence::media_jobs::terminal_error(reason.as_deref());
            return Err(err(
                StatusCode::from_u16(status).expect("fixed terminal status"),
                reason,
            ));
        }
        Some("cancelled") => return Err(err(StatusCode::GONE, "media_job_cancelled")),
        Some("running" | "succeeded") => {
            // Legacy outputs use the Worker's on-demand verification path.
            let visible = available_until_ms.is_some_and(|end| {
                end > 0.0
                    && (job.as_deref() == Some("succeeded")
                        || query.relative_position_ms.unwrap_or(0.0) < end)
            });
            (
                if legacy || visible { Ready } else { Preparing },
                job.as_deref() == Some("succeeded"),
            )
        }
        _ => (Preparing, false),
    };
    Ok(Json(protocol::PlaybackReadiness {
        session_id: id,
        status,
        complete,
        available_until_ms,
    }))
}

pub async fn stop(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(u.id)
        .execute(&app.db)
        .await?;
    sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE session_id IN(SELECT id FROM playback_sessions WHERE id=$1 AND user_id=$2) AND status IN('queued','running')").bind(id).bind(u.id).execute(&app.db).await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn renew(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE playback_requests SET expires_at=GREATEST(expires_at,now()+interval '48 hours') WHERE session_id=$1 AND user_id=$2")
        .bind(id).bind(u.id).execute(&mut *tx).await?;
    let r=sqlx::query("UPDATE playback_sessions p SET expires_at=now()+interval '30 minutes' FROM room_snapshots s WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND p.expires_at>now() AND s.room_id=p.room_id AND (s.state->>'media_generation')::bigint=p.generation").bind(id).bind(u.id).execute(&mut *tx).await?;
    if r.rows_affected() == 0 {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    };
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod readiness_tests {
    use super::published_duration_ms;
    #[test]
    fn published_interval_requires_finite_positive_durations_and_exact_count() {
        assert_eq!(
            published_duration_ms("#EXTINF:4.125,\nindex0.m4s\n#EXTINF:2,\nindex1.m4s\n", 2),
            Some(6125.0)
        );
        for duration in ["NaN", "inf", "-1", "0", "1e308", "broken"] {
            assert_eq!(
                published_duration_ms(&format!("#EXTINF:{duration},\n"), 1),
                None
            );
        }
        assert_eq!(published_duration_ms("#EXTINF:4,\n", 2), None);
        assert_eq!(published_duration_ms("", 0), None);
    }
}
