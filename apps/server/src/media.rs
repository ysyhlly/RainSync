use super::*;
use providers::SourceConfig;

pub async fn sources(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&auth(&app, &h, false).await?)?;
    let rows = sqlx::query("SELECT s.id,s.name,s.kind,s.access_policy_revision,CASE WHEN s.kind NOT IN ('jellyfin','emby') THEN NULL ELSE jsonb_build_object('state',CASE WHEN a.state='allowed' AND a.valid_until<=clock_timestamp() THEN 'unknown' ELSE COALESCE(a.state,'unknown') END,'reason',CASE WHEN a.state='allowed' AND a.valid_until<=clock_timestamp() THEN 'upstream_policy_expired' ELSE COALESCE(a.reason,'upstream_policy_unknown') END) END AS account_policy FROM sources s LEFT JOIN source_account_policies a ON a.source_id=s.id AND a.source_revision=s.access_policy_revision ORDER BY s.name")
        .fetch_all(&app.db)
        .await?;
    Ok(Json(Value::Array(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"access_policy_revision":r.get::<i64,_>("access_policy_revision"),"account_policy":r.get::<Option<Value>,_>("account_policy")})).collect())))
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
    if !matches!(body.kind.as_str(), "http" | "jellyfin" | "emby")
        && body.config.access_policy.is_some()
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
        providers::access_policy::SourceAccess::new(
            &body.config.url,
            body.config.access_policy.as_ref(),
        )
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source_url"))?;
    }
    providers::validate_source_headers(&body.config.headers)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let id = Uuid::new_v4();
    let policy_revision = i64::from(body.config.access_policy.is_some());
    let encrypted = app.encrypt(&serde_json::to_value(&body.config).unwrap())?;
    sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted,access_policy_revision) VALUES($1,$2,$3,$4,$5)")
        .bind(id)
        .bind(body.name)
        .bind(body.kind)
        .bind(encrypted)
        .bind(policy_revision)
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
            if let Ok(file) = std::fs::File::open(&path)
                && let Ok(snapshot) = media_core::file_version::snapshot_file(&file)
            {
                item.metadata["preview_file_version"] = json!(snapshot.version);
            }
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
        if row.get::<String, _>("kind") != "local" {
            item.metadata["preview_scan"] = json!(generation);
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
    if body.observation_version.is_some_and(|version| version != 1) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unsupported_observation_version",
        ));
    }
    member(&app, &u, body.room_id).await?;
    // Dropping an HTTP waiter must not drop the reservation's executor. Start
    // ownership before begin(), including its commit/acknowledgement window.
    // Explicit cancellation still fences probe grants and final publication.
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    tokio::spawn(owned_playback(app, u, body, owner))
        .await
        .map_err(anyhow::Error::from)?
}

async fn owned_playback(
    app: App,
    u: User,
    body: protocol::PlaybackRequest,
    owner: preparation_owner::Owner,
) -> Result<Json<Value>> {
    let reservation = match playback_requests::begin(&app, u.id, &body).await? {
        playback_requests::Start::Replay(plan) => return Ok(Json(plan)),
        playback_requests::Start::Reserved(reservation) => reservation,
    };
    let scope = media_core::child_process::Scope::new();
    let result = scope.run(async {
        tokio::select! {
            biased;
            _ = owner.cancelled() => Err(err(StatusCode::SERVICE_UNAVAILABLE, "playback_request_interrupted")),
            result = tokio::time::timeout(
                std::time::Duration::from_secs(45),
                prepare_playback(&app, &u, &body, &reservation),
            ) => result.unwrap_or_else(|_| Err(err(StatusCode::GATEWAY_TIMEOUT, "playback_request_interrupted"))),
        }
    }).await;
    let outcome = match result {
        Ok(plan) => Ok(Json(plan)),
        Err(error) => match playback_requests::fail(&app, &reservation, &error).await {
            Ok(Some(plan)) => Ok(Json(plan)),
            Ok(None) => Err(error),
            Err(error) => Err(error),
        },
    };
    // Timeout/cancel only drops the public waiter; positively drain every local
    // process owner before acknowledging this durable preparation as stopped.
    scope.shutdown().await.map_err(anyhow::Error::from)?;
    // Return the HTTP result promptly, but keep the registry lease in the ACK
    // task so graceful shutdown cannot abort a delayed acknowledgement.
    tokio::spawn(async move {
        owner.acknowledge(&app, &reservation).await;
    });
    outcome
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
    let row=sqlx::query("SELECT m.source_id,m.resource,m.duration_ms,m.metadata,m.source_version,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available").bind(media).fetch_optional(&app.db).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    let kind: String = row.get("kind");
    if body.candidate_report.is_some() && !matches!(kind.as_str(), "local" | "agent") {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let item: String = row.get("resource");
    let source_version: Option<String> = row.get("source_version");
    let source_policy_revision: i64 = row.get("access_policy_revision");
    let source_id: Uuid = row.get("source_id");
    let account_policy_generation = if matches!(kind.as_str(), "jellyfin" | "emby") {
        Some(upstream_policy::ensure(app, source_id, source_policy_revision).await?)
    } else {
        None
    };
    let mut resource = json!({"kind":kind,"resource":item,"root":config.root,"headers":{},"source_url":config.url,"access_policy":config.access_policy,"source_policy_revision":source_policy_revision,"source_id":source_id});
    let mut meta: Value = row.get("metadata");
    let mut duration: Option<f64> = row.get("duration_ms");
    let mut position_ms = protocol::bounded_position(body.position_ms, duration);
    let mut transport = "progressive";
    let requested_mode = body.mode.as_deref().unwrap_or("auto");
    let mut mode = requested_mode;
    if !["auto", "direct", "remux", "transcode"].contains(&mode) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_mode"));
    }
    let selected = if body.candidate_report.is_some() {
        let version = if kind == "local" {
            playback_capabilities::current_local_version(&config.root, &item)?
        } else if kind == "agent" {
            source_version
                .clone()
                .ok_or_else(|| err(StatusCode::CONFLICT, "source_version_required"))?
        } else {
            return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
        };
        playback_capabilities::select(
            app,
            u.id,
            body,
            media,
            reservation.lifecycle_epoch,
            &version,
        )?
    } else {
        None
    };
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
            let info = upstream::negotiate(
                app,
                upstream::Prepare {
                    reservation,
                    room: body.room_id,
                    media,
                    source: row.get("source_id"),
                    source_policy_revision,
                    account_policy_generation,
                    generation: body.media_generation,
                    kind: &kind,
                    config: &config,
                    item: &item,
                    options: providers::PlaybackOptions {
                        position_ms,
                        audio_index: body.audio_index,
                        media_source_id: None,
                        progressive: body
                            .capabilities
                            .as_ref()
                            .is_none_or(|c| c.supports_progressive()),
                        hls: body.capabilities.as_ref().is_none_or(|c| c.supports_hls()),
                        force_transcode: body.mode.as_deref() == Some("transcode"),
                    },
                    observation_version: body.observation_version,
                },
            )
            .await?;
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
                    .is_none_or(|c| c.supports_progressive());
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
                let mut url = base.clone();
                url.path_segments_mut()
                    .map_err(|_| err(StatusCode::BAD_GATEWAY, "invalid_upstream_base"))?
                    .pop_if_empty()
                    .extend(["Videos", &item, "stream.mp4"]);
                url.query_pairs_mut()
                    .append_pair("Static", "true")
                    .append_pair("MediaSourceId", source["Id"].as_str().unwrap_or(&item));
                url.to_string()
            };
            let device_id = format!("rainsync-{}", reservation.session);
            let url = providers::bind_playback_identity(
                providers::validate_url(&url)?,
                info["PlaySessionId"]
                    .as_str()
                    .ok_or_else(|| err(StatusCode::BAD_GATEWAY, "upstream_playback_failed"))?,
                &device_id,
            )
            .map_err(|_| err(StatusCode::BAD_GATEWAY, "invalid_upstream_base"))?;
            resource["url"] = json!(url.as_str());
            resource["upstream_session"] = info["PlaySessionId"].clone();
            resource["upstream_item"] = json!(item);
            resource["upstream_base"] = json!(config.url);
            resource["upstream_device"] = json!(device_id);
            resource["upstream_media_source"] = source["Id"].clone();
            resource["upstream_live_stream"] = source["LiveStreamId"].clone();
            resource["headers"] = json!(providers::upstream_headers(&kind, &config, &device_id)?);
        }
        _ => {}
    }
    let id = reservation.session;
    let t = token();
    let mut timeline = 0.0;
    if matches!(kind.as_str(), "http" | "agent")
        && requested_mode != "direct"
        && !(kind == "agent" && selected.is_some())
    {
        // Auto HTTP/NAS must probe even when the provisional mode above is direct.
        // A short-lived session lets the worker probe through the same authorized relay as playback.
        let mut preparation = app.db.begin().await?;
        playback_requests::guard(app, &mut preparation, reservation).await?;
        source_access::guard(&mut preparation, source_id, source_policy_revision).await?;
        upstream_policy::guard(
            &mut preparation,
            source_id,
            source_policy_revision,
            account_policy_generation,
        )
        .await?;
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 minute',$8,$9,$10)")
            .bind(id).bind(u.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&t)).bind(json!({"encrypted":app.encrypt(&resource)?,"source_policy_revision":source_policy_revision,"account_policy_generation":account_policy_generation})).bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).execute(&mut *preparation).await?;
        preparation.commit().await?;
        let probe: Result<Value> = async {
            let base = std::env::var("WORKER_URL").unwrap_or("http://127.0.0.1:8081".into());
            let response = reqwest::Client::new()
                .get(format!("{base}/media-delivery/{id}/probe"))
                .query(&[("token", &t)])
                .timeout(std::time::Duration::from_secs(35))
                .send()
                .await
                .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
            if response.status() == StatusCode::CONFLICT {
                let reason = match response.json::<protocol::ErrorResponse>().await {
                    Ok(response) if response.error.code == protocol::ErrorCode::SourceChanged => {
                        "source_changed"
                    }
                    Ok(response)
                        if response.error.code == protocol::ErrorCode::SourceVersionRequired =>
                    {
                        "source_version_required"
                    }
                    _ => return Err(err(StatusCode::BAD_GATEWAY, "source_probe_failed")),
                };
                return Err(err(StatusCode::CONFLICT, reason));
            }
            if !response.status().is_success() {
                return Err(err(StatusCode::BAD_GATEWAY, "source_probe_failed"));
            }
            response
                .json::<Value>()
                .await
                .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))
        }
        .await;
        // The preparation grant cannot linger after failure or while the final plan is validated.
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(id)
            .execute(&app.db)
            .await?;
        meta = probe?;
        if kind == "agent" {
            meta["capability_source_version"] = json!(source_version);
        }
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
    if let Some(selection) = &selected {
        mode = &selection.candidate.delivery_mode;
        transport = &selection.candidate.transport;
        resource["source_version"] = json!(selection.source_version);
    } else if let Some(caps) = &body.capabilities {
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
        if selected.is_none()
            && mode == "remux"
            && (position_ms > 0.0 || media_core::hls_needs_video_transform(&meta))
        {
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
        plan_generation: reservation.plan_generation,
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
        observation_version: body.observation_version,
        observation_seq: body.observation_version.map(|_| 0),
        decision_reason: Some(selected.as_ref().map_or_else(
            || "legacy_conservative_transport_negotiation".to_string(),
            |s| format!("actual_media_{}", s.candidate.id),
        )),
        selected_candidate_id: selected.as_ref().map(|s| s.candidate.id.clone()),
        selected_audio_track: body.audio_index.or_else(|| {
            meta["streams"]
                .as_array()?
                .iter()
                .find(|s| s["codec_type"] == "audio")?["index"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
        }),
    };
    let protocol_plan = plan;
    let plan = serde_json::to_value(&protocol_plan).map_err(anyhow::Error::from)?;
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    source_access::guard(&mut tx, source_id, source_policy_revision).await?;
    upstream_policy::guard(
        &mut tx,
        source_id,
        source_policy_revision,
        account_policy_generation,
    )
    .await?;
    let current: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?;
    if current["media_generation"].as_u64() != Some(u64::from(body.media_generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    if (matches!(kind.as_str(), "jellyfin" | "emby") || body.observation_version == Some(1))
        && sqlx::query("SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE")
            .bind(body.room_id)
            .bind(u.id)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
    {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
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
    if kind == "local"
        && let Some(selection) = &selected
        && playback_capabilities::current_local_version(&config.root, &item)?
            != selection.source_version
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 minutes',$8,$9,$10) ON CONFLICT(id) DO UPDATE SET resource=EXCLUDED.resource,expires_at=EXCLUDED.expires_at,stopped=false,lifecycle_epoch=EXCLUDED.lifecycle_epoch,viewer_id=EXCLUDED.viewer_id,plan_generation=EXCLUDED.plan_generation").bind(id).bind(u.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&t)).bind(json!({"encrypted":encrypted,"source_policy_revision":source_policy_revision,"account_policy_generation":account_policy_generation})).bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).execute(&mut *tx).await?;
    if body.observation_version == Some(1) {
        persistence::playback_observations::create(&mut tx, u.id, body.room_id, &protocol_plan)
            .await?;
    }
    if local_job {
        let input_ticket = if kind != "local" || selected.is_some() {
            Some(app.encrypt(&json!({"token":t}))?)
        } else {
            None
        };
        let estimated_output_bytes =
            media_core::estimated_output_bytes(&meta, duration, timeline, mode == "transcode");
        let spec = json!({"root":config.root,"resource":item,"source_kind":kind,"input_ticket":input_ticket,"start_seconds":timeline/1000.0,"transcode":mode=="transcode","audio_index":body.audio_index,"estimated_output_bytes":estimated_output_bytes,"negotiated_mode":selected.as_ref().map(|s|&s.candidate.delivery_mode),"source_version":selected.as_ref().map(|s|&s.source_version)});
        if !persistence::media_queue::enqueue(&mut tx, id, &spec, app.queue_limit).await? {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_queue_full"));
        }
    }
    playback_requests::complete(app, &mut tx, reservation, &plan).await?;
    if matches!(kind.as_str(), "jellyfin" | "emby")
        && !persistence::upstream_reservations::activate(
            &mut tx,
            id,
            if transport == "hls" {
                "Transcode"
            } else {
                "DirectPlay"
            },
        )
        .await?
    {
        return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
    }
    upstream_policy::guard(
        &mut tx,
        source_id,
        source_policy_revision,
        account_policy_generation,
    )
    .await?;
    tx.commit().await?;
    if matches!(kind.as_str(), "jellyfin" | "emby") {
        let _ = upstream::report(app, id, "start").await;
    }

    Ok(plan)
}
#[derive(Deserialize)]
pub struct ReadinessQuery {
    plan_generation: Option<u32>,
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
    let row = sqlx::query("SELECT p.plan_generation, j.status AS job_status, j.error AS job_error, o.validation_version, o.ready_segments, o.visible_manifest, v.seq AS observation_seq FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id LEFT JOIN media_jobs j ON j.session_id=p.id LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt LEFT JOIN playback_observations v ON v.session_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND p.expires_at>now() AND (s.state->>'media_generation')::bigint=p.generation AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation)) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(id).bind(u.id).fetch_optional(&app.db).await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let plan_generation = row
        .get::<Option<i64>, _>("plan_generation")
        .map(|v| v as u32);
    if query.plan_generation.is_some() && query.plan_generation != plan_generation {
        return Err(err(StatusCode::CONFLICT, "stale_playback_plan"));
    }
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
        plan_generation,
        status,
        complete,
        available_until_ms,
        observation_version: row.get::<Option<i64>, _>("observation_seq").map(|_| 1),
        observation_seq: row
            .get::<Option<i64>, _>("observation_seq")
            .map(|seq| seq as u64),
    }))
}

pub async fn stop(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    let final_sample = if body.is_empty() {
        Ok(None)
    } else {
        serde_json::from_slice::<protocol::PlaybackObservation>(&body)
            .map(Some)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_observation"))
    };
    let mut tx = app.db.begin().await?;
    let grant = playback_observations::lock_grant(&mut tx, id, u.id).await?;
    let final_error = match final_sample {
        Ok(None) => None,
        candidate => {
            let grant = grant
                .as_ref()
                .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
            match candidate {
                Ok(Some(sample)) => {
                    match playback_observations::accept(&mut tx, grant, &sample, true).await {
                        Ok(_) => None,
                        Err(error) if error.0.is_client_error() => Some(error),
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => Some(error),
                Ok(None) => unreachable!(),
            }
        }
    };
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1 AND user_id=$2")
        .bind(id)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE media_jobs SET status='cancelled' WHERE session_id IN(SELECT id FROM playback_sessions WHERE id=$1 AND user_id=$2) AND status IN('queued','running')").bind(id).bind(u.id).execute(&mut *tx).await?;
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND user_id=$2)",
    )
    .bind(id)
    .bind(u.id)
    .fetch_one(&mut *tx)
    .await?
    {
        persistence::upstream_reservations::close(&mut tx, id, "playback_stopped").await?;
    }
    tx.commit().await?;
    if let Some(error) = final_error {
        // Ownership authorizes stopping independently of accepting a sample.
        // Reject invalid final data without retaining the caller's resources.
        return Err(error);
    }
    Ok(Json(json!({"ok":true})))
}
pub async fn renew(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let u = auth(&app, &h, true).await?;
    let session = sqlx::query(
        "SELECT room_id,lifecycle_epoch FROM playback_sessions WHERE id=$1 AND user_id=$2",
    )
    .bind(id)
    .bind(u.id)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let room: Uuid = session.get("room_id");
    let epoch: i64 = session.get("lifecycle_epoch");
    let mut tx = app.db.begin().await?;
    persistence::room_lifecycle::lock_epoch(&mut tx, room, epoch)
        .await
        .map_err(|_| err(StatusCode::GONE, "invalid_playback_session"))?;
    let member = sqlx::query(
        "SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(u.id)
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    if !persistence::source_account_policy::lock_session(&mut tx, id).await? {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    sqlx::query("UPDATE playback_requests SET expires_at=GREATEST(expires_at,now()+interval '48 hours') WHERE session_id=$1 AND user_id=$2")
        .bind(id).bind(u.id).execute(&mut *tx).await?;
    let r=sqlx::query("UPDATE playback_sessions p SET expires_at=now()+interval '30 minutes' FROM room_snapshots s WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource) AND p.expires_at>now() AND p.lifecycle_epoch=$3 AND s.room_id=p.room_id AND (s.state->>'media_generation')::bigint=p.generation AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation))").bind(id).bind(u.id).bind(epoch).execute(&mut *tx).await?;
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
