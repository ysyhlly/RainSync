use super::*;
use persistence::media_job_timing::{CancellationScope, cancel_jobs};
use providers::SourceConfig;

fn upstream_track_title(stream: &Value) -> Value {
    // These negotiated text subtitles are requested as Stream.vtt below. Keep
    // the conversion warning in the existing label, before the codec is replaced.
    let styled_text = stream["Type"] == "Subtitle"
        && stream["IsTextSubtitleStream"] == true
        && stream["Codec"].as_str().is_some_and(|codec| {
            let codec = codec.trim();
            codec.eq_ignore_ascii_case("ass") || codec.eq_ignore_ascii_case("ssa")
        });
    if styled_text {
        json!(format!(
            "{}（ASS/SSA 转为 WebVTT 普通文本：样式、字体、定位和动画无法完整保留）",
            stream["DisplayTitle"].as_str().unwrap_or("Subtitle")
        ))
    } else {
        stream["DisplayTitle"].clone()
    }
}

pub async fn sources(State(app): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    admin(&auth(&app, &h, false).await?)?;
    Ok(Json(catalog::sources::list(&app.db).await?))
}
pub use catalog::sources::Source;
pub async fn add_source(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<Source>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    let context = catalog::SourceWriteContext {
        db: &app.db,
        encrypt: &|value| app.encrypt(value),
    };
    Ok(Json(catalog::sources::add(context, body).await?))
}
pub async fn remove_source(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let user = auth(&app, &h, true).await?;
    admin(&user)?;
    Ok(Json(
        catalog::sources::remove(&app.db, &user, &h, id).await?,
    ))
}
pub async fn scan(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    admin(&auth(&app, &h, true).await?)?;
    let mut tx = app.db.begin().await?;
    let row = sqlx::query(
        "SELECT kind,config_encrypted FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
    if row.get::<String, _>("kind") == "s3" {
        tx.commit().await?;
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM s3_index_scans WHERE source_id=$1")
                .bind(id)
                .fetch_optional(&app.db)
                .await?;
        let restart = status.as_deref().is_none_or(|v| v == "completed");
        let mut value = private_library::scan_source_page(&app, id, restart).await?;
        value["count"] = value["item_count"].clone();
        return Ok(Json(value));
    }
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let generation = Uuid::new_v4();
    sqlx::query("INSERT INTO source_scans(source_id,generation) VALUES($1,$2) ON CONFLICT(source_id) DO UPDATE SET generation=EXCLUDED.generation")
        .bind(id).bind(generation).execute(&mut *tx).await?;
    tx.commit().await?;
    let kind: String = row.get("kind");
    let encrypted: String = row.get("config_encrypted");
    let items = providers::list_items_guarded(&kind, &config, || async {
        let mut tx = app.db.begin().await?;
        guard_scan_config(&mut tx, id, &kind, &encrypted)
            .await
            .map_err(|_| anyhow::anyhow!("source_scan_superseded"))?;
        let current: Option<Uuid> =
            sqlx::query_scalar("SELECT generation FROM source_scans WHERE source_id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        anyhow::ensure!(current == Some(generation), "source_scan_superseded");
        Ok(tx)
    })
    .await
    .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_scan_failed"))?;
    let count = items.len();
    let resources: Vec<String> = items.iter().map(|i| i.resource.clone()).collect();
    let mut batch = Vec::with_capacity(32);
    for mut item in items {
        if row.get::<String, _>("kind") == "local"
            && let Ok((meta, version)) =
                playback_capabilities::probe_local(&config.root, &item.resource).await
        {
            item.duration_ms = meta["format"]["duration"]
                .as_str()
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v * 1000.0);
            item.metadata = meta;
            item.metadata["preview_file_version"] = json!(version);
            let mut sidecars = serde_json::Map::new();
            for (i, ext) in ["srt", "vtt"].iter().enumerate() {
                let relative = std::path::Path::new(&item.resource)
                    .with_extension(ext)
                    .to_string_lossy()
                    .replace('\\', "/");
                if media_core::safe_local_path(std::path::Path::new(&config.root), &relative)
                    .is_ok()
                {
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
            save_scan_batch(&app, id, generation, &kind, &encrypted, &mut batch).await?;
        }
    }
    save_scan_batch(&app, id, generation, &kind, &encrypted, &mut batch).await?;
    let mut tx = app.db.begin().await?;
    guard_scan_config(&mut tx, id, &kind, &encrypted).await?;
    guard_scan(&mut tx, id, generation).await?;
    sqlx::query(
        "UPDATE media_items SET available=false WHERE source_id=$1 AND NOT(resource=ANY($2))",
    )
    .bind(id)
    .bind(&resources)
    .execute(&mut *tx)
    .await?;
    if row.get::<String, _>("kind") == "http" {
        sqlx::query("UPDATE media_items SET library_source_generation=library_source_generation+1 WHERE source_id=$1 AND available").bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"count":count})))
}
fn metadata_is_hls(metadata: &Value) -> bool {
    if let Some(transport) = metadata["rainsync_http_transport"].as_str() {
        return transport == "hls";
    }
    metadata["format"]["format_name"]
        .as_str()
        .is_some_and(|names| {
            names
                .split(',')
                .any(|name| name.trim().eq_ignore_ascii_case("hls"))
        })
}
fn declared_http_transport(headers: &HeaderMap) -> Option<&'static str> {
    let mut values = headers.get_all(header::CONTENT_TYPE).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    if matches!(
        mime.as_str(),
        "application/vnd.apple.mpegurl"
            | "application/x-mpegurl"
            | "audio/mpegurl"
            | "audio/x-mpegurl"
    ) {
        return Some("hls");
    }
    let (kind, subtype) = mime.split_once('/')?;
    let token = !subtype.is_empty()
        && subtype
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte));
    (token && (matches!(kind, "video" | "audio") || mime == "application/mp4"))
        .then_some("progressive")
}
async fn guard_scan_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    kind: &str,
    encrypted: &str,
) -> Result<()> {
    let row = sqlx::query(
        "SELECT kind,config_encrypted FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    if !row.is_some_and(|row| {
        row.get::<String, _>("kind") == kind
            && row.get::<String, _>("config_encrypted") == encrypted
    }) {
        return Err(err(StatusCode::CONFLICT, "source_scan_failed"));
    }
    Ok(())
}
async fn guard_scan(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    generation: Uuid,
) -> Result<()> {
    // Lock source authority before the scan row, matching source removal's
    // lock order. A delayed provider response cannot recreate removed media.
    sqlx::query("SELECT id FROM sources WHERE id=$1 AND deleted_at IS NULL FOR SHARE")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "source_not_found"))?;
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
    kind: &str,
    encrypted: &str,
    batch: &mut Vec<providers::Item>,
) -> Result<()> {
    let mut tx = app.db.begin().await?;
    guard_scan_config(&mut tx, id, kind, encrypted).await?;
    guard_scan(&mut tx, id, generation).await?;
    for item in batch.drain(..) {
        sqlx::query("INSERT INTO media_items(id,source_id,title,resource,duration_ms,metadata) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id,resource) DO UPDATE SET title=EXCLUDED.title,duration_ms=EXCLUDED.duration_ms,metadata=EXCLUDED.metadata,available=true").bind(Uuid::new_v4()).bind(id).bind(item.title).bind(item.resource).bind(item.duration_ms).bind(item.metadata).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
pub use catalog::media_reads::LibraryQuery;
pub async fn library(
    State(app): State<App>,
    h: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<LibraryQuery>,
) -> Result<Response> {
    let user = auth(&app, &h, false).await?;
    Ok(responses::ok_json(
        catalog::media_reads::list(&app.db, user.id, query).await?,
    ))
}
pub async fn playback(
    State(app): State<App>,
    h: HeaderMap,
    bytes: axum::body::Bytes,
) -> Result<Json<Value>> {
    if let Some(request) = static_hls_child_public::parse_if_child(&bytes)? {
        advanced_playback::validate(request.body(), false)?;
        if request.body().native_platform.is_some() {
            return Err(err(
                StatusCode::BAD_REQUEST,
                "dedicated_platform_endpoint_required",
            ));
        }
        let user = auth_viewer(&app, &h, true).await?;
        let login_hash = cookie(&h)
            .map(|value| hash(&value))
            .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?;
        playback_metrics::validate(request.body())?;
        member(&app, &user, request.body().room_id).await?;
        let owner = app.preparations.admit().ok_or_else(|| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "playback_request_interrupted",
            )
        })?;
        // The owned orchestration resolves the authenticated installed-runtime
        // contract after exact-key replay checks, before destructive admission.
        return static_hls_child_public::start_authenticated(app, user, request, login_hash, owner)
            .await;
    }
    let body = static_hls_public::parse(&bytes)?;
    if body.native_platform.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "dedicated_platform_endpoint_required",
        ));
    }
    start_playback(app, h, body, false, false, false, false).await
}

/// Separate admission fails closed against Servers predating these recipes.
pub async fn advanced_local_playback(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    start_playback(app, h, body, false, false, true, false).await
}

/// Dedicated admission fails closed against Servers predating this profile.
pub async fn upstream_profile_playback(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    start_playback(app, h, body, false, true, false, false).await
}

/// Central registers this at /api/v1/playback-sessions/http-file-continuation.
/// A distinct path fails closed against Servers predating continuation support.
pub async fn http_file_continuation(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    start_playback(app, h, body, true, false, false, false).await
}

pub async fn playback_local_hls_ladder(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    start_playback(app, h, body, false, false, false, true).await
}

async fn start_playback(
    app: App,
    h: HeaderMap,
    body: protocol::PlaybackRequest,
    continuation: bool,
    profile_endpoint: bool,
    advanced_endpoint: bool,
    ladder_endpoint: bool,
) -> Result<Json<Value>> {
    if body.distributed_compute.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "dedicated_distributed_endpoint_required",
        ));
    }
    local_hls_ladder::validate(&body, ladder_endpoint)?;
    advanced_playback::validate(&body, advanced_endpoint || ladder_endpoint)?;
    if body.native_platform.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "dedicated_platform_endpoint_required",
        ));
    }
    let u = auth_viewer(&app, &h, true).await?;
    static_hls_public::validate(&body)?;
    upstream_profiles::validate_request(&body, profile_endpoint)?;
    if body.http_file_fallback.is_some() {
        if !continuation {
            return Err(err(StatusCode::CONFLICT, "source_version_required"));
        }
    } else if continuation {
        return Err(err(StatusCode::CONFLICT, "source_version_required"));
    }
    playback_requests::http_file_fallback::validate(&body)?;
    // This is exactly the cookie used by auth above, retained only as a hash.
    let login_hash = cookie(&h).map(|value| hash(&value));
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
    tokio::spawn(owned_playback(app, u, body, login_hash, owner))
        .await
        .map_err(anyhow::Error::from)?
}

async fn owned_playback(
    app: App,
    u: User,
    body: protocol::PlaybackRequest,
    login_hash: Option<String>,
    owner: preparation_owner::Owner,
) -> Result<Json<Value>> {
    let prepared = static_hls_public::begin(&app, u.id, &body, login_hash.as_deref()).await?;
    let reservation = if let Some(prepared) = prepared.as_deref() {
        static_hls_public::reservation(&body, prepared)?
    } else {
        match playback_requests::begin_authenticated(&app, u.id, &body, login_hash.as_deref())
            .await?
        {
            playback_requests::Start::Replay(plan) => {
                upstream_profiles::guard_replay(&app, u.id, &body, login_hash.as_deref(), &plan)
                    .await?;
                return Ok(Json(plan));
            }
            playback_requests::Start::Reserved(reservation) => reservation,
            playback_requests::Start::StaticHlsPublished { operation, session } => {
                if body
                    .capabilities
                    .as_ref()
                    .is_some_and(|capabilities| !capabilities.supports_hls())
                {
                    return Err(err(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "device_has_no_compatible_playback_transport",
                    ));
                }
                return tokio::select! {
                    _ = owner.cancelled() => Err(err(StatusCode::SERVICE_UNAVAILABLE,"playback_request_interrupted")),
                    result = playback_requests::static_hls_pending::replay_published(&app,operation,session) => result.map(Json),
                };
            }
        }
    };
    let scope = media_core::child_process::Scope::new();
    let result = scope.run(async {
        tokio::select! {
            biased;
            _ = owner.cancelled() => Err(err(StatusCode::SERVICE_UNAVAILABLE, "playback_request_interrupted")),
            result = tokio::time::timeout_at(
                reservation.prepare_until,
                async {
                    if let Some(prepared) = prepared.as_deref() {
                        static_hls_public::prepare(&app, &u, &body, &reservation, prepared, &owner, login_hash.as_deref()).await
                    } else {
                        prepare_playback(&app, &u, &body, &reservation, login_hash.as_deref()).await
                    }
                },
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

pub(crate) async fn prepare_playback(
    app: &App,
    u: &User,
    body: &protocol::PlaybackRequest,
    reservation: &playback_requests::Reservation,
    login_hash: Option<&str>,
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
    private_library::authorize_media(app, u.id, media, "play", Some(body.room_id)).await?;
    let row=sqlx::query("SELECT m.source_id,m.resource,m.duration_ms,m.metadata,m.s3_object_identity,m.source_version,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available").bind(media).fetch_optional(&app.db).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    let storage_kind: String = row.get("kind");
    let source_route = playback::selection::source_route(
        playback::facts::SourceFacts {
            storage_kind: &storage_kind,
            linux: cfg!(target_os = "linux"),
        },
        playback::selection::SourceIntent {
            finite_hls: body.finite_hls_version.is_some(),
            ladder: body.local_hls_ladder.is_some(),
            advanced: body.advanced_playback.is_some(),
            candidate_report: body.candidate_report.is_some(),
        },
    )?;
    let kind = source_route.kind().to_owned();
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let item: String = row.get("resource");
    let s3 = if storage_kind == "s3" {
        let mut indexed: Value = row.get("metadata");
        if let Some(identity) = row.get::<Option<Value>, _>("s3_object_identity") {
            indexed["s3"] = identity;
        }
        Some(s3_playback::prepare(&config, &item, &indexed).await?)
    } else {
        None
    };
    let source_version: Option<String> = row.get("source_version");
    let source_policy_revision: i64 = row.get("access_policy_revision");
    let source_id: Uuid = row.get("source_id");
    let account_policy_generation = if matches!(kind.as_str(), "jellyfin" | "emby") {
        Some(upstream_policy::ensure(app, source_id, source_policy_revision).await?)
    } else {
        None
    };
    let upstream_profile = upstream_profiles::select(
        app,
        body,
        reservation,
        upstream_profiles::Scope {
            media,
            source: source_id,
            source_revision: source_policy_revision,
            account_generation: account_policy_generation,
            kind: &kind,
            item: &item,
            login_hash,
        },
    )
    .await?;
    let mut resource = json!({"kind":kind,"resource":item,"root":config.root,"headers":{},"source_url":config.url,"access_policy":config.access_policy,"source_policy_revision":source_policy_revision,"source_id":source_id});
    if let Some(prepared) = &s3 {
        prepared.apply(&config, &mut resource)?;
    }
    if body.advanced_playback.is_some() {
        resource["advanced_probe"] = json!("metadata_only");
    }
    if kind == "http"
        && let Some(association) = &config.advanced_assets
    {
        resource["advanced_asset_association"] =
            serde_json::to_value(association).map_err(anyhow::Error::from)?;
    }
    if let Some(report) = &body.upstream_profile_report {
        resource["upstream_profile_binding_hash"] = json!(hash(&report.binding));
    }
    let http_file = reservation.http_file.as_deref();
    let continuation = http_file.is_some_and(|authority| authority.claim.is_some());
    if http_file.is_some() && kind != "http" {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    if let Some(authority) = http_file {
        if authority.media_id != media
            || authority.source_id != source_id
            || authority.source_policy_revision != source_policy_revision
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
        resource["http_file_context"] =
            serde_json::to_value(&authority.context).map_err(anyhow::Error::from)?;
    }
    let mut meta: Value = row.get("metadata");
    // Never choose a new local plan from scan-time facts. One guarded probe
    // supplies its mode, tracks, duration and the version carried by delivery
    // and jobs, including clients without a concrete candidate report.
    let local_fact_version = if kind == "local" {
        let (mut current, version) = if body.advanced_playback.is_some() {
            playback_capabilities::probe_local_advanced(&config.root, &item).await?
        } else {
            playback_capabilities::probe_local(&config.root, &item).await?
        };
        if meta.get("sidecars").is_some() {
            current["sidecars"] = meta["sidecars"].clone();
        }
        if body.advanced_playback.is_some() {
            advanced_playback::attach_assets(&config.root, &item, &version, &mut current).await?;
        }
        current["preview_file_version"] = json!(version);
        meta = current;
        resource["source_version"] = json!(version);
        Some(version)
    } else {
        None
    };
    let mut current_metadata = match kind.as_str() {
        "local" => true,
        "agent" => source_version
            .as_deref()
            .is_some_and(|version| meta["capability_source_version"].as_str() == Some(version)),
        _ => false,
    };
    if kind == "local" {
        if body.local_hls_ladder.is_some() {
            local_hls_ladder::require_local(&kind, local_fact_version.as_deref())?;
            if let Some(request) = &body.advanced_playback {
                local_hls_ladder::recipe_with_advanced(
                    &meta,
                    body.audio_index,
                    body.position_ms,
                    request,
                )?;
            } else {
                local_hls_ladder::recipe(&meta, body.audio_index, body.position_ms)?;
            }
        } else if let Some(request) = &body.advanced_playback {
            advanced_playback::require_local(
                &kind,
                local_fact_version.as_deref().or(source_version.as_deref()),
            )?;
            advanced_playback::analyze(&meta, body.audio_index, body.position_ms, request)?;
        } else if body.candidate_report.is_none() {
            // Concrete reports are revalidated against this fresh probe below.
            // The legacy entry point remains restricted to ordinary SDR.
            media_core::capabilities::validate_source(&meta)
                .map_err(playback_capabilities::probe_error)?;
        }
    }
    let mut probed = kind == "local";
    let mut negotiated_info = None;
    // A concrete HTTP intent learns timing only from this attempt's pinned
    // probe. Cached media-item duration must not clamp a new representation.
    let mut duration: Option<f64> = if let Some(selection) = &upstream_profile {
        Some(selection.metadata.runtime_ticks as f64 / 10_000.0)
    } else if kind == "local" {
        meta["format"]["duration"]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|v| v * 1000.0)
    } else if kind == "http" && http_file.is_some_and(|authority| authority.candidate.is_some()) {
        None
    } else {
        row.get("duration_ms")
    };
    let position_ms = protocol::bounded_position(body.position_ms, duration);
    let mut transport = "progressive";
    let requested_mode = body.mode.as_deref().unwrap_or("auto");
    let mut mode = requested_mode;
    if !["auto", "direct", "remux", "transcode"].contains(&mode) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_mode"));
    }
    let selected = if body.candidate_report.is_some() && kind == "http" {
        playback_capabilities::select_http(
            app,
            body,
            http_file.ok_or_else(|| err(StatusCode::CONFLICT, "stale_capability_report"))?,
            reservation.lifecycle_epoch,
        )?
    } else if body.candidate_report.is_some() {
        let version = if kind == "local" {
            local_fact_version.clone().expect("local probe version")
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
            &meta,
        )?
    } else {
        None
    };
    if mode == "auto" {
        mode = if let Some(selection) = &selected {
            selection.candidate.delivery_mode.as_str()
        } else if kind == "local" {
            media_core::compatible_mode(&meta, body.audio_index.is_some())
                .map_err(playback_capabilities::probe_error)?
        } else {
            "direct"
        };
    }
    match kind.as_str() {
        "http" => {
            let target = reservation
                .static_hls
                .as_ref()
                .map(|input| static_hls_public::original_target(input))
                .transpose()?
                .unwrap_or_else(|| {
                    s3.as_ref()
                        .map_or_else(|| config.url.clone(), |prepared| prepared.url.clone())
                });
            resource["url"] = json!(target);
            resource["headers"] = json!(config.headers);
            if s3.is_none() {
                owned_http::select(body, &mut resource, continuation, reservation.session)?;
            }
            if providers::validate_url(&target)?
                .path()
                .to_ascii_lowercase()
                .ends_with(".m3u8")
            {
                transport = "hls";
            }
            if http_file.is_some_and(|authority| authority.candidate.is_some()) {
                playback_requests::http_file_fallback::verify_target(&resource, http_file)?;
                playback_requests::http_file_fallback::restrict_binary(&mut resource)?;
            }
            if continuation {
                resource =
                    playback_requests::http_file_fallback::parent_resource(app, http_file.unwrap())
                        .await?;
                transport = "progressive";
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
                    profile: upstream_profile.clone(),
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
                    tracks.push(json!({"codec_type":if audio {"audio"} else {"subtitle"},"index":stream["Index"],"codec_name":if audio {stream["Codec"].clone()}else{json!("webvtt")},"tags":{"title":upstream_track_title(stream),"language":stream["Language"]}}));
                }
                meta["streams"] = json!(tracks);
                resource["subtitle_urls"] = Value::Object(subtitle_urls);
            }
            if upstream_profile.is_none()
                && let Some(ticks) = source["RunTimeTicks"].as_f64()
            {
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
            let url = if let Some(selection) = &upstream_profile {
                transport = "hls";
                mode = "transcode";
                let route = providers::upstream_profiles::complete_route(
                    &kind,
                    &config,
                    &selection.metadata,
                    &info,
                    &format!("rainsync-{}", reservation.session),
                )
                .map_err(|_| err(StatusCode::BAD_GATEWAY, "upstream_playback_failed"))?;
                resource["upstream_profile_route_provenance"] = json!(route.provenance);
                route.url.to_string()
            } else if !use_direct && let Some(path) = source["TranscodingUrl"].as_str() {
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
            negotiated_info = Some(info);
        }
        _ => {}
    }
    let id = reservation.session;
    let t = token();
    let direct_transport_only = kind == "http"
        && requested_mode == "direct"
        && http_file.is_none()
        && selected.is_none()
        && body.advanced_playback.is_none()
        && s3.is_none()
        && resource["http_owned_large_response_version"] != 1
        && resource["http_finite_hls_version"] != 1
        && body
            .capabilities
            .as_ref()
            .is_none_or(|caps| caps.supports_progressive());
    if direct_transport_only
        || playback_plan::needs_preparation_probe(
            &kind,
            requested_mode,
            selected.is_some(),
            body.audio_index,
            body.capabilities
                .as_ref()
                .is_none_or(|caps| caps.supports_progressive()),
        )
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
        if kind == "agent" {
            playback_capabilities::guard_agent_source(
                &mut preparation,
                media,
                &resource,
                &row.get::<String, _>("config_encrypted"),
            )
            .await?;
            playback_requests::guard(app, &mut preparation, reservation).await?;
        }
        sqlx::query("SELECT lock_playback_http_representation($1)")
            .bind(id)
            .execute(&mut *preparation)
            .await?;
        let preparation_lifetime = if resource["http_owned_large_response_version"] == 1
            || resource["http_finite_hls_version"] == 1
        {
            reservation
                .prepare_until
                .saturating_duration_since(tokio::time::Instant::now())
                .as_secs_f64()
        } else {
            60.0
        };
        if preparation_lifetime <= 0.0 {
            return Err(err(
                StatusCode::GATEWAY_TIMEOUT,
                "playback_request_interrupted",
            ));
        }
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,$6,$7,LEAST(clock_timestamp()+$12::double precision*interval '1 second',to_timestamp($11::double precision/1000.0)),$8,$9,$10)")
            .bind(id).bind(u.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&t)).bind(playback_requests::http_file_fallback::wrap_resource(app, &resource, http_file, source_policy_revision, account_policy_generation)?).bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).bind(playback_requests::http_file_fallback::preparation_deadline_ms(http_file)).bind(preparation_lifetime).execute(&mut *preparation).await?;
        playback_requests::http_file_fallback::seed(&mut preparation, id, http_file).await?;
        if let Some(prepared) = &s3 {
            prepared.seed(&mut preparation, id).await?;
        }
        preparation.commit().await?;
        let probe: Result<Value> = async {
            let base = std::env::var("WORKER_URL").unwrap_or("http://127.0.0.1:8081".into());
            let endpoint = if direct_transport_only {
                "source"
            } else {
                "probe"
            };
            let client = reqwest::Client::new();
            let url = format!("{base}/media-delivery/{id}/{endpoint}");
            let timeout = if resource["http_owned_large_response_version"] == 1
                || resource["http_finite_hls_version"] == 1
            {
                reservation
                    .prepare_until
                    .saturating_duration_since(tokio::time::Instant::now())
            } else {
                std::time::Duration::from_secs(35)
            };
            // Header classification and a necessary prefix read share the
            // original budget; a HEAD never buys an extra preparation window.
            let deadline = (tokio::time::Instant::now() + timeout)
                .min(reservation.prepare_until);
            let request = client
                .request(
                    if direct_transport_only {
                        reqwest::Method::HEAD
                    } else {
                        reqwest::Method::GET
                    },
                    &url,
                )
                .query(&[("token", &t)])
                .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
            let mut response = request
                .send()
                .await
                .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
            if direct_transport_only {
                let transport = declared_http_transport(response.headers());
                // This fresh direct preparation grant has no seeded identity. A
                // successful Worker HEAD creates a pin only for reliable typed
                // metadata, and never consumes a body. Keep body sniffing for
                // every pinned source, even if its MIME claims ordinary video.
                let pinned: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM playback_http_representations h WHERE h.session_id=p.id) FROM playback_sessions p WHERE p.id=$1 AND p.user_id=$2 AND p.media_id=$3 AND p.room_id=$4 AND p.generation=$5 AND p.lifecycle_epoch=$6 AND p.viewer_id IS NOT DISTINCT FROM $7 AND p.plan_generation IS NOT DISTINCT FROM $8 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_source_allowed(p.media_id,p.resource,p.id)",
                )
                .bind(id)
                .bind(u.id)
                .bind(media)
                .bind(body.room_id)
                .bind(i64::from(body.media_generation))
                .bind(reservation.lifecycle_epoch)
                .bind(reservation.viewer_id)
                .bind(reservation.plan_generation.map(i64::from))
                .fetch_optional(&app.db)
                .await?
                .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
                let header_only = response.status().is_success()
                    && !pinned
                    && transport.is_some();
                if !header_only
                    && (response.status().is_success()
                        || matches!(
                            response.status(),
                            StatusCode::METHOD_NOT_ALLOWED | StatusCode::NOT_IMPLEMENTED
                        ))
                {
                    drop(response);
                    response = client
                        .get(&url)
                        .query(&[("token", &t)])
                        .header(header::RANGE, "bytes=0-511")
                        .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
                        .send()
                        .await
                        .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
                }
            }
            if matches!(
                response.status(),
                StatusCode::CONFLICT | StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_GATEWAY
            ) {
                let status = response.status();
                let reason = match response.json::<protocol::ErrorResponse>().await {
                    Ok(response)
                        if status == StatusCode::CONFLICT
                            && response.error.code == protocol::ErrorCode::SourceChanged =>
                    {
                        "source_changed"
                    }
                    Ok(response)
                        if status == StatusCode::CONFLICT
                            && response.error.code
                                == protocol::ErrorCode::SourceVersionRequired =>
                    {
                        "source_version_required"
                    }
                    Ok(response)
                        if status == StatusCode::UNPROCESSABLE_ENTITY
                            && response.error.code
                                == protocol::ErrorCode::SourceSeekUnsupported =>
                    {
                        "source_seek_unsupported"
                    }
                    Ok(response)
                        if status == StatusCode::BAD_GATEWAY
                            && response.error.code == protocol::ErrorCode::MediaInputDenied =>
                    {
                        "media_input_denied"
                    }
                    _ => return Err(err(StatusCode::BAD_GATEWAY, "source_probe_failed")),
                };
                return Err(err(status, reason));
            }
            if !response.status().is_success() {
                return Err(err(StatusCode::BAD_GATEWAY, "source_probe_failed"));
            }
            if direct_transport_only {
                let mut metadata = meta.clone();
                // Opaque responses reach this point only after the authorized
                // Worker prefix path succeeds under its stable identity guard.
                metadata["rainsync_http_transport"] =
                    json!(declared_http_transport(response.headers()).unwrap_or("progressive"));
                return Ok(metadata);
            }
            response
                .json::<Value>()
                .await
                .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))
        }
        .await;
        if kind != "agent" && !owned_http::keep_provisional(&resource) {
            // Other HTTP probes still retire; owned bytes keep this exact grant
            // through its guarded probe-to-publication transition.
            sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
                .bind(id)
                .execute(&app.db)
                .await?;
        }
        let validation: Result<()> = async {
            // Agent source/configuration locks may wait behind a scan. Recheck
            // the original request after them and retain the fence through fact
            // publication. The inner result releases every fence before the
            // unconditional logical retirement below, including on guard failure.
            let mut agent_probe_fence = if kind == "agent" && probe.is_ok() {
                let mut fence = app.db.begin().await?;
                playback_requests::guard(app, &mut fence, reservation).await?;
                playback_capabilities::guard_agent_source(
                    &mut fence,
                    media,
                    &resource,
                    &row.get::<String, _>("config_encrypted"),
                )
                .await?;
                playback_requests::guard(app, &mut fence, reservation).await?;
                playback_capabilities::require_live_probe(&mut fence, id).await?;
                Some(fence)
            } else {
                None
            };
            meta = probe?;
            if kind == "http" && metadata_is_hls(&meta) { transport = "hls"; }
            if let Some(prepared) = &s3 { prepared.attach_metadata(&mut meta)?; }
            advanced_playback::attach_remote_assets(&mut resource, &meta)?;
            if kind == "http" && body.candidate_report.is_some() {
                playback_capabilities::verify_http_assets(app, body, &meta)?;
            }
            playback_requests::http_file_fallback::verify_audio(&meta, http_file)?;
            if matches!(kind.as_str(), "http" | "agent")
                && let Some(selection) = &selected
            {
                if kind == "agent" && body.advanced_playback.is_none() {
                    playback_plan::require_legacy_job_mapping(
                        &kind,
                        selection.candidate.delivery_mode != "direct",
                        &meta,
                        body.audio_index,
                        true,
                    )?;
                }
                let actual = if let Some(request)=&body.advanced_playback {advanced_playback::analyze(&meta,body.audio_index,body.position_ms,request)?.candidates} else {
                    media_core::capabilities::candidates(&meta, body.audio_index, body.position_ms).map_err(|_| err(StatusCode::CONFLICT,"source_changed"))?
                };
                let expected =
                    serde_json::to_value(&selection.candidate).map_err(anyhow::Error::from)?;
                if !actual
                    .iter()
                    .any(|candidate| serde_json::to_value(candidate).ok().as_ref() == Some(&expected))
                {
                    return Err(err(StatusCode::CONFLICT, "source_changed"));
                }
            }
            current_metadata = !direct_transport_only;
            probed = !direct_transport_only;
            if kind == "agent" {
                meta["capability_source_version"] = json!(source_version);
            }
            duration = meta["format"]["duration"]
                .as_str()
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v * 1000.0);
            let detected = if direct_transport_only { "direct" } else if let Some(request)=&body.advanced_playback {advanced_playback::analyze(&meta,body.audio_index,body.position_ms,request)?;"transcode"} else if let Some(selection)=&selected {selection.candidate.delivery_mode.as_str()} else {media_core::compatible_mode(&meta, body.audio_index.is_some()).map_err(playback_capabilities::probe_error)?};
            if requested_mode == "auto" {
                mode = detected;
            }
            let update = sqlx::query("UPDATE media_items SET metadata=$2,duration_ms=$3 WHERE id=$1 AND source_version IS NOT DISTINCT FROM $4")
                .bind(media)
                .bind(&meta)
                .bind(duration)
                .bind(&source_version);
            let updated = if let Some(fence) = agent_probe_fence.as_mut() {
                update.execute(&mut **fence).await?
            } else {
                update.execute(&app.db).await?
            };
            if updated.rows_affected() != 1 {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
            if let Some(mut fence) = agent_probe_fence {
                playback_requests::guard(app, &mut fence, reservation).await?;
                fence.commit().await?;
            }
            Ok(())
        }
        .await;
        if kind == "agent" {
            // This is outside the validation transaction: rollback cannot
            // revive the probe, and this query cannot wait on our own locks.
            // The owned outer cleanup still handles timeout/cancellation.
            sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
                .bind(id)
                .execute(&app.db)
                .await?;
        }
        validation?;
    }
    let playback::projection::TrackInventory {
        audio_tracks,
        mut subtitle_tracks,
    } = playback::projection::tracks(&meta, body.audio_index)?;
    for track in &mut subtitle_tracks {
        track.url = Some(format!(
            "/media-delivery/{id}/subtitle-{}.vtt?token={t}",
            track.index
        ));
    }
    resource["subtitle_files"] = meta["sidecars"].clone();
    resource["subtitle_indices"] =
        json!(subtitle_tracks.iter().map(|t| t.index).collect::<Vec<_>>());
    let intent = playback::route::Intent {
        requested_mode,
        requested_position_ms: body.position_ms,
        audio_index: body.audio_index,
        capabilities: body.capabilities.as_ref(),
        advanced_playback: body.advanced_playback.as_ref(),
        local_hls_ladder: body.local_hls_ladder.as_ref(),
        static_hls: reservation.static_hls.is_some(),
    };
    let route = playback::route::select(
        playback::route::RouteFacts {
            source: source_route,
            metadata: &meta,
            current_metadata,
            probed,
            local_fact_version: local_fact_version.as_deref(),
            source_version: source_version.as_deref(),
            selected: selected.as_ref(),
            upstream_profile: upstream_profile.is_some(),
            mode,
            transport,
            position_ms,
            duration_ms: duration,
        },
        intent,
    )?;
    mode = &route.delivery().mode;
    transport = &route.delivery().transport;
    let timeline = route.delivery().timeline_origin_ms;
    let local_job = route.generated();
    let ladder_recipe = route.ladder_recipe();
    if let Some(version) = selected.as_ref().and_then(|s| s.source_version.as_ref()) {
        resource["source_version"] = json!(version);
    }
    if ladder_recipe.is_some() {
        resource["local_hls_ladder_version"] = json!(1);
        if body.advanced_playback.is_some() {
            resource["advanced_hls_ladder_version"] = json!(1);
        }
    }
    if local_job {
        resource["job_id"] = json!(id);
        if body.advanced_playback.is_some() && body.local_hls_ladder.is_none() {
            resource["advanced_owned_session_id"] = json!(id);
        }
    }
    resource["transport"] = json!(transport);
    resource["delivery_mode"] = json!(mode);
    resource["timeline_origin_ms"] = json!(timeline);
    resource["plan_facts_version"] = json!(1);
    let hls_supported = body.capabilities.as_ref().is_none_or(|c| c.supports_hls());
    let playback::projection::PlanFacts {
        decoder_fallback_modes,
        selected_audio_track,
        subtitle_mode,
        selected_output,
        selected_candidate_id,
        decision_reason,
    } = playback::projection::plan_facts(
        playback::projection::ProjectionFacts {
            source: source_route,
            metadata: &meta,
            current_metadata,
            probed,
            selected: selected.as_ref(),
            upstream_profile: upstream_profile.is_some(),
            negotiated_info: negotiated_info.as_ref(),
            upstream_base: &config.url,
            has_external_subtitle: subtitle_tracks.iter().any(|track| track.url.is_some()),
            server_requested_audio_sample_rate_48000: resource["upstream_profile_route_provenance"]
                ["server_requested_audio_sample_rate"]
                == 48_000,
        },
        intent,
        &route,
    )?;
    if subtitle_mode == protocol::SubtitleDeliveryMode::BurnedIn {
        subtitle_tracks.clear();
        resource["subtitle_indices"] = json!([]);
    }
    if let Some(facts) = &selected_output {
        resource["selected_output"] = serde_json::to_value(facts).map_err(anyhow::Error::from)?;
    }
    let plan = protocol::PlaybackPlan {
        distributed_compute: None,
        local_hls_ladder: ladder_recipe
            .as_ref()
            .zip(body.local_hls_ladder.as_ref())
            .map(|(recipe, request)| local_hls_ladder::facts(recipe, request)),
        advanced_playback: body
            .advanced_playback
            .as_ref()
            .map(|request| advanced_playback::facts(&meta, request))
            .transpose()?,
        native_platform: None,
        static_hls_fallback_version: None,
        http_file_fallback_version: None,
        upstream_profile: upstream_profile
            .as_ref()
            .map(|selection| upstream_profiles::envelope(&kind, &selection.metadata))
            .transpose()?,
        session_id: id,
        media_id: media,
        media_generation: body.media_generation,
        plan_generation: reservation.plan_generation,
        delivery_mode: mode.into(),
        transport: transport.into(),
        playback_url: format!(
            "/media-delivery/{id}/{}?token={t}",
            if ladder_recipe.is_some() {
                "ladder/master.m3u8"
            } else if transport == "hls" {
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
        playback_metrics_version: None,
        playback_metrics: None,
        observation_seq: body.observation_version.map(|_| 0),
        decision_reason: Some(decision_reason),
        selected_candidate_id,
        selected_output,
        subtitle_mode: Some(subtitle_mode),
        seekable_media_ranges_ms: None,
        pending_job_id: None,
        decoder_fallback_modes: Some(decoder_fallback_modes),
        selected_audio_track,
    };
    let mut protocol_plan = plan;
    let mut plan = serde_json::to_value(&protocol_plan).map_err(anyhow::Error::from)?;
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    if let Some(selection) = &upstream_profile {
        upstream_profiles::guard(app, &mut tx, reservation, selection).await?;
    }
    source_access::guard(&mut tx, source_id, source_policy_revision).await?;
    upstream_policy::guard(
        &mut tx,
        source_id,
        source_policy_revision,
        account_policy_generation,
    )
    .await?;
    if kind == "http" {
        http_representation::guard(&mut tx, id).await?;
        playback_requests::http_file_fallback::verify_pin(&mut tx, id, http_file).await?;
        if local_job && resource["http_owned_response_version"] != 1 {
            // Owned inputs use the exact capture/custody deadline guard below.
            // Reuse this attempt's existing probe pin under the publication
            // fence. HLS, multiple targets and unreliable identities cannot
            // establish the single Binary input used by the legacy recipe.
            let (digest, _) =
                playback_requests::http_file_fallback::single_identity(&mut tx, id).await?;
            if digest != playback_requests::http_file_fallback::target(&resource)? {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
        }
        let root_marked = http_file.is_some()
            && !continuation
            && !http_file.is_some_and(|authority| authority.candidate.is_some())
            && reservation.viewer_id.is_some()
            && playback_requests::http_file_fallback::mark_root(
                &mut tx,
                id,
                &mut resource,
                &meta,
                current_metadata,
                mode,
                hls_supported,
            )
            .await?;
        if root_marked {
            plan["http_file_fallback_version"] = json!(protocol::HTTP_FILE_FALLBACK_VERSION);
        } else if mode == "direct" {
            // Original direct playback needs no generated mapping proof. Its
            // continuation hints require the separate reliable Binary root.
            plan["decoder_fallback_modes"] = json!([]);
        }
    }
    let current: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?;
    if current["media_generation"].as_u64() != Some(u64::from(body.media_generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    if (matches!(kind.as_str(), "jellyfin" | "emby")
        || body.observation_version == Some(1)
        || body.playback_metrics_version == Some(1))
        && sqlx::query("SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR SHARE")
            .bind(body.room_id)
            .bind(u.id)
            .fetch_optional(&mut *tx)
            .await?
            .is_none()
    {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    if kind == "agent" {
        playback_capabilities::guard_agent_source(
            &mut tx,
            media,
            &resource,
            &row.get::<String, _>("config_encrypted"),
        )
        .await?;
        playback_requests::guard(app, &mut tx, reservation).await?;
    }
    if kind == "local"
        && let Some(version) = &local_fact_version
        && playback_capabilities::current_local_version(&config.root, &item)
            .ok()
            .as_ref()
            != Some(version)
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    if kind == "local" {
        if body.advanced_playback.is_some() || ladder_recipe.is_some() {
            playback_capabilities::guard_local_source(
                &mut tx,
                media,
                source_id,
                &item,
                &row.get::<String, _>("config_encrypted"),
                source_policy_revision,
            )
            .await?;
            playback_requests::guard(app, &mut tx, reservation).await?;
            if playback_capabilities::current_local_version(&config.root, &item)
                .ok()
                .as_ref()
                != local_fact_version.as_ref()
            {
                return Err(err(StatusCode::CONFLICT, "source_changed"));
            }
        }
        let updated = sqlx::query(
            "UPDATE media_items SET metadata=$2,duration_ms=$3 WHERE id=$1 AND available",
        )
        .bind(media)
        .bind(&meta)
        .bind(duration)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
    }
    let mut root_expires_ms = reservation
        .static_hls
        .as_ref()
        .map(|input| i64::try_from(input.root_deadline_ms()))
        .transpose()
        .map_err(anyhow::Error::from)?;
    root_expires_ms = root_expires_ms.or(owned_http::deadline(&mut tx, id, &resource).await?);
    let inserted = sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $11::bigint IS NULL THEN now()+interval '30 minutes' ELSE to_timestamp($11::double precision/1000.0) END,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET resource=EXCLUDED.resource,expires_at=EXCLUDED.expires_at,stopped=false,lifecycle_epoch=EXCLUDED.lifecycle_epoch,viewer_id=EXCLUDED.viewer_id,plan_generation=EXCLUDED.plan_generation").bind(id).bind(u.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&t)).bind(playback_requests::http_file_fallback::wrap_resource(app, &resource, http_file, source_policy_revision, account_policy_generation)?).bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).bind(root_expires_ms).execute(&mut *tx).await?;
    if let Some(prepared) = &s3 {
        prepared.seed(&mut tx, id).await?;
    }
    if inserted.rows_affected() != 1 {
        return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
    }
    if root_expires_ms.is_some() {
        let remaining: i64 = sqlx::query_scalar("SELECT FLOOR(EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))::bigint FROM playback_sessions WHERE id=$1")
            .bind(id).fetch_one(&mut *tx).await?;
        if remaining <= 0 {
            return Err(err(StatusCode::GONE, "playback_request_expired"));
        }
        protocol_plan.expires_in_seconds = u32::try_from(remaining).map_err(anyhow::Error::from)?;
        plan["expires_in_seconds"] = json!(remaining);
        if reservation.static_hls.is_some() {
            protocol_plan.decision_reason = Some("static_hls_qualification_refused".into());
            plan["decision_reason"] = json!("static_hls_qualification_refused");
        } else {
            let reason = if resource["http_finite_hls_version"] == 1 {
                "owned_http_finite_hls_normalized"
            } else {
                "owned_http_complete_representation"
            };
            protocol_plan.decision_reason = Some(reason.into());
            plan["decision_reason"] = json!(reason);
        }
    }
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
        let mut spec = json!({"root":config.root,"resource":item,"source_kind":kind,"input_ticket":input_ticket,"start_seconds":timeline/1000.0,"transcode":mode=="transcode","audio_index":body.audio_index,"estimated_output_bytes":estimated_output_bytes,"negotiated_mode":selected.as_ref().map(|s|&s.candidate.delivery_mode),"source_version":local_fact_version.as_ref().or_else(|| selected.as_ref().and_then(|s|s.source_version.as_ref()))});
        if resource["http_owned_response_version"] == 1 {
            spec["kind"] = json!(persistence::owned_http::KIND);
            spec["owned_http_response_version"] = json!(1);
        }
        if let Some(request) = &body.advanced_playback {
            spec["kind"] = json!(if kind == "local" {
                "advanced_owned_local_transcode_v1"
            } else {
                "advanced_owned_remote_transcode_v1"
            });
            if kind != "local" {
                spec["held_input_bytes"] = json!(advanced_playback::held_input_bytes(&meta)?);
                spec["remote_duration_seconds"] = json!(advanced_playback::remote_duration(&meta)?);
            }
            if kind == "local" {
                spec["advanced_assets"] = meta["advanced_assets"].clone();
            }
            if meta.get("advanced_remote_assets").is_some() {
                spec["kind"] = json!("remote_asset_transcode_v1");
                spec["advanced_assets"] = meta["advanced_assets"].clone();
                spec["advanced_remote_assets"] = meta["advanced_remote_assets"].clone();
                if kind == "http" {
                    spec["resource"] = resource["url"].clone();
                }
                if kind == "agent" && spec["source_version"].is_null() {
                    spec["source_version"] = json!(source_version);
                }
            }
            spec["recipe_version"] = json!(1);
            spec["advanced_media"] = serde_json::to_value(advanced_playback::request(request)?)
                .map_err(anyhow::Error::from)?;
        }
        if let Some(recipe) = &ladder_recipe {
            spec = persistence::local_hls_ladder::job_spec(
                &config.root,
                &item,
                local_fact_version
                    .as_deref()
                    .ok_or_else(|| err(StatusCode::CONFLICT, "source_version_required"))?,
                input_ticket
                    .as_deref()
                    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?,
                timeline / 1000.0,
                selected_audio_track,
                duration.ok_or_else(|| {
                    err(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "local_hls_ladder_duration_required",
                    )
                })?,
                body.media_generation,
                reservation
                    .plan_generation
                    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?,
                recipe,
            )
            .map_err(|_| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "local_hls_ladder_duration_required",
                )
            })?;
            if let Some(request) = &body.advanced_playback {
                spec["kind"] = json!(persistence::local_hls_ladder::OWNED_ADVANCED_KIND);
                spec["advanced_media"] = serde_json::to_value(advanced_playback::request(request)?)
                    .map_err(anyhow::Error::from)?;
                spec["advanced_assets"] = meta["advanced_assets"].clone();
                persistence::local_hls_ladder::validate_spec(&spec)?;
            }
        }
        let enqueued = if ladder_recipe.is_some() {
            persistence::media_queue::enqueue_local_hls_ladder(&mut tx, id, &spec, app.queue_limit)
                .await?
        } else if body.advanced_playback.is_some() {
            persistence::media_queue::enqueue_advanced_local(&mut tx, id, &spec, app.queue_limit)
                .await?
        } else if resource["http_owned_response_version"] == 1 {
            persistence::media_queue::enqueue_owned_http(&mut tx, id, &spec, app.queue_limit)
                .await?
        } else {
            persistence::media_queue::enqueue(&mut tx, id, &spec, app.queue_limit).await?
        };
        if !enqueued {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_queue_full"));
        }
    }
    if let Some((version, grant)) =
        playback_metrics::publish(&mut tx, u.id, body, id, &resource).await?
    {
        plan["playback_metrics_version"] = json!(version);
        plan["playback_metrics"] = serde_json::to_value(grant).map_err(anyhow::Error::from)?;
    }
    playback_plan::refresh(app, &mut tx, u.id, id, &mut plan).await?;
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
    if let Some(authority) = http_file {
        playback_requests::http_file_fallback::guard_deadline(&mut tx, authority).await?;
        if !persistence::http_file_authorization::lock(&mut tx, &authority.context).await? {
            return Err(err(StatusCode::GONE, "invalid_playback_session"));
        }
    }
    if let Some(selection) = &upstream_profile {
        upstream_profiles::guard(app, &mut tx, reservation, selection).await?;
    }
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

pub async fn readiness(
    State(app): State<App>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    axum::extract::Query(query): axum::extract::Query<ReadinessQuery>,
) -> Result<Json<protocol::PlaybackReadiness>> {
    let u = auth_viewer(&app, &h, false).await?;
    if query
        .relative_position_ms
        .is_some_and(|p| !p.is_finite() || p < 0.0)
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    let login_hash = media_authorization::login_hash(&h)?;
    if let Some(readiness) = platform_media::transcode::read_authenticated(
        &app,
        u.id,
        &login_hash,
        id,
        query.plan_generation,
        query.relative_position_ms,
    )
    .await?
    {
        return Ok(Json(readiness));
    }
    if let Some(readiness) = local_hls_ladder_readiness::read_authenticated(
        &app,
        u.id,
        &login_hash,
        id,
        query.plan_generation,
        query.relative_position_ms,
    )
    .await?
    {
        return Ok(Json(readiness));
    }
    if let Some(readiness) = static_hls_child_readiness::read_authenticated(
        &app,
        u.id,
        &login_hash,
        id,
        query.plan_generation,
        query.relative_position_ms,
    )
    .await?
    {
        return Ok(Json(readiness));
    }
    // One statement gives permission and the current attempt a consistent snapshot.
    let query_sql = format!(
        "{} AND playback_caller_allowed(p.resource,$2,$3) AND NOT static_hls_is_child_session(p.id)",
        playback_plan::AUTHORIZED_SNAPSHOT_SQL
    );
    let row = sqlx::query(&query_sql)
        .bind(id)
        .bind(u.id)
        .bind(login_hash)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let facts = playback_plan::job_facts(&app, &row)?;
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
    let available_until_ms = if job.is_none() {
        None
    } else if facts.recorded {
        facts.seekable_media_ranges_ms.as_ref().map(|ranges| {
            ranges
                .first()
                .map_or(0.0, |range| range.end_ms - range.start_ms)
        })
    } else if legacy {
        None
    } else {
        Some(
            row.get::<Option<String>, _>("visible_manifest")
                .as_deref()
                .and_then(|m| {
                    playback_plan::published_duration_ms(
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
                if (legacy && !facts.recorded) || visible {
                    Ready
                } else {
                    Preparing
                },
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
        seekable_media_ranges_ms: facts.seekable_media_ranges_ms,
        pending_job_id: facts.pending_job_id,
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
    let u = auth_viewer(&app, &h, true).await?;
    let final_sample = if body.is_empty() {
        Ok(None)
    } else {
        serde_json::from_slice::<protocol::PlaybackObservation>(&body)
            .map(Some)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_observation"))
    };
    let mut tx = app.db.begin().await?;
    let grant =
        playback_observations::lock_grant(&mut tx, id, u.id, &media_authorization::login_hash(&h)?)
            .await?;
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
    let job_health = cancel_jobs(
        &mut *tx,
        CancellationScope::OwnedSession {
            session: id,
            user: u.id,
        },
    )
    .await?;
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
    let observation = job_health.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
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
    let u = auth_viewer(&app, &h, true).await?;
    let session = sqlx::query(
        "SELECT room_id,lifecycle_epoch,resource ? 'native_platform_context' AS native_platform FROM playback_sessions WHERE id=$1 AND user_id=$2",
    )
    .bind(id)
    .bind(u.id)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    if session.get::<bool, _>("native_platform") {
        return Err(err(StatusCode::CONFLICT, "platform_plan_refresh_required"));
    }
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
    media_authorization::lock_caller(&mut tx, id, u.id, &media_authorization::login_hash(&h)?)
        .await?;
    let (bound, frozen_root): (bool, bool) =
        sqlx::query_as("SELECT p.auth_login_hash IS NOT NULL, (EXISTS(SELECT 1 FROM playback_requests r WHERE r.session_id=p.id AND r.static_hls_input_version=1) OR EXISTS(SELECT 1 FROM owned_http_representations h WHERE h.session_id=p.id) OR EXISTS(SELECT 1 FROM distributed_playback_bindings b WHERE b.session_id=p.id)) FROM playback_sessions p WHERE p.id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !persistence::source_account_policy::lock_session(&mut tx, id).await? {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    if !bound || frozen_root {
        // A frozen parent grant and a legacy grant keep their original expiry.
        // Acknowledge only the already-live grant without renewing its root.
        let remaining: Option<i64> = sqlx::query_scalar("SELECT CEIL(EXTRACT(EPOCH FROM(p.expires_at-clock_timestamp())))::bigint FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource,p.id) AND p.expires_at>clock_timestamp() AND p.lifecycle_epoch=$3 AND (s.state->>'media_generation')::bigint=p.generation AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation))")
            .bind(id).bind(u.id).bind(epoch).fetch_optional(&mut *tx).await?;
        let remaining =
            remaining.ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
        tx.commit().await?;
        return Ok(Json(
            json!({"ok":true,"expires_in_seconds":remaining,"legacy_expiry_unchanged":!bound,"original_expiry_unchanged":frozen_root}),
        ));
    }
    sqlx::query("UPDATE playback_requests SET expires_at=GREATEST(expires_at,now()+interval '48 hours') WHERE session_id=$1 AND user_id=$2")
        .bind(id).bind(u.id).execute(&mut *tx).await?;
    let r=sqlx::query("UPDATE playback_sessions p SET expires_at=clock_timestamp()+interval '30 minutes' FROM room_snapshots s WHERE p.id=$1 AND p.user_id=$2 AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource,p.id) AND p.expires_at>clock_timestamp() AND p.lifecycle_epoch=$3 AND s.room_id=p.room_id AND (s.state->>'media_generation')::bigint=p.generation AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation))").bind(id).bind(u.id).bind(epoch).execute(&mut *tx).await?;
    if r.rows_affected() == 0 {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    };
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod upstream_subtitle_label_tests {
    use super::{declared_http_transport, metadata_is_hls, upstream_track_title};
    use axum::http::{HeaderMap, HeaderValue, header};
    use serde_json::{Value, json};

    #[test]
    fn detected_http_transport_uses_probe_content_even_without_a_suffix() {
        assert!(metadata_is_hls(
            &json!({"format":{"filename":"https://media.example/play?id=1", "format_name":"hls"}})
        ));
        assert!(metadata_is_hls(
            &json!({"format":{"format_name":" HLS,other"}})
        ));
        assert!(!metadata_is_hls(
            &json!({"format":{"format_name":"mov,mp4"}})
        ));
    }

    #[test]
    fn declared_media_mime_separates_hls_from_audio_and_opaque_bodies() {
        for (mime, transport) in [
            ("application/vnd.apple.mpegurl", Some("hls")),
            ("APPLICATION/X-MPEGURL; charset=utf-8", Some("hls")),
            ("audio/mpegurl", Some("hls")),
            ("audio/x-mpegurl; charset=utf-8", Some("hls")),
            ("video/mp4", Some("progressive")),
            ("video/webm; codecs=vp9", Some("progressive")),
            ("audio/mp4", Some("progressive")),
            ("application/mp4", Some("progressive")),
            ("application/octet-stream", None),
            ("text/plain", None),
            ("application/json", None),
            ("video/", None),
            ("video/mp4 invalid", None),
            ("", None),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            assert_eq!(declared_http_transport(&headers), transport, "{mime}");
        }
        assert_eq!(declared_http_transport(&HeaderMap::new()), None);
        let mut ambiguous = HeaderMap::new();
        ambiguous.append(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
        ambiguous.append(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert_eq!(declared_http_transport(&ambiguous), None);
    }

    #[test]
    fn known_styled_text_subtitles_explain_the_webvtt_downgrade() {
        for codec in ["ass", "ASS", "ssa", " sSa "] {
            let stream = json!({
                "Type": "Subtitle",
                "IsTextSubtitleStream": true,
                "Codec": codec,
                "Index": 17,
                "DisplayTitle": "中文",
                "Language": "zho"
            });
            assert_eq!(
                upstream_track_title(&stream),
                json!("中文（ASS/SSA 转为 WebVTT 普通文本：样式、字体、定位和动画无法完整保留）")
            );
            // Label generation neither changes the provider's identity nor its metadata.
            assert_eq!(stream["Index"], 17);
            assert_eq!(stream["Language"], "zho");
            assert_eq!(stream["Codec"], codec);
        }
    }

    #[test]
    fn other_and_unknown_codecs_preserve_the_original_title() {
        for codec in [
            json!("subrip"),
            json!("webvtt"),
            json!("mov_text"),
            json!("unknown"),
            json!("ass_variant"),
            Value::Null,
            json!(7),
        ] {
            for title in [json!("Original"), Value::Null, json!(7)] {
                let stream = json!({
                    "Type": "Subtitle",
                    "IsTextSubtitleStream": true,
                    "Codec": codec,
                    "DisplayTitle": title
                });
                assert_eq!(upstream_track_title(&stream), title);
            }
        }
    }

    #[test]
    fn only_confirmed_upstream_text_subtitles_receive_the_warning() {
        for (kind, text) in [
            (json!("Audio"), json!(true)),
            (json!("Subtitle"), json!(false)),
            (json!("Subtitle"), Value::Null),
            (json!("Subtitle"), json!("true")),
        ] {
            let stream = json!({
                "Type": kind,
                "IsTextSubtitleStream": text,
                "Codec": "ass",
                "DisplayTitle": "Original"
            });
            assert_eq!(upstream_track_title(&stream), "Original");
        }
    }

    #[test]
    fn missing_titles_use_the_existing_fallback_and_titles_remain_plain_text() {
        let mut stream = json!({
            "Type": "Subtitle", "IsTextSubtitleStream": true, "Codec": "ssa"
        });
        let suffix = "（ASS/SSA 转为 WebVTT 普通文本：样式、字体、定位和动画无法完整保留）";
        assert_eq!(upstream_track_title(&stream), format!("Subtitle{suffix}"));
        let title = "<img src=x onerror=alert(1)> & 中文";
        stream["DisplayTitle"] = json!(title);
        assert_eq!(upstream_track_title(&stream), format!("{title}{suffix}"));
    }
}

#[cfg(test)]
mod readiness_tests {
    use super::playback_plan::published_duration_ms;
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
