use super::*;
use playback_requests::http_file_fallback::{self as http_file, Authority, CandidateExpectation};
use protocol::{PlaybackCandidate, PlaybackCandidateRequest, PlaybackCandidateSet};
use providers::SourceConfig;
use serde::Serialize;

const HTTP_PURPOSE: &str = "actual_http_file_capabilities_v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpBinding {
    purpose: String,
    lifecycle_epoch: i64,
    authority: Authority,
    candidates: Vec<PlaybackCandidate>,
}

#[derive(Serialize, Deserialize)]
struct Binding {
    purpose: String,
    user: Uuid,
    room: Uuid,
    generation: u32,
    lifecycle_epoch: i64,
    media: Uuid,
    source_version: String,
    audio_index: Option<u32>,
    expires: u64,
    candidates: Vec<PlaybackCandidate>,
}

fn seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn fallback(reason: &str) -> Json<PlaybackCandidateSet> {
    Json(PlaybackCandidateSet {
        schema_version: 1,
        http_file_capabilities_version: None,
        binding: None,
        candidates: Vec::new(),
        decision_reason: reason.into(),
    })
}

pub async fn candidates(
    State(app): State<App>,
    h: HeaderMap,
    Json(body): Json<PlaybackCandidateRequest>,
) -> Result<Json<PlaybackCandidateSet>> {
    let user = auth(&app, &h, true).await?;
    member(&app, &user, body.room_id).await?;
    if !body.position_ms.is_finite() || body.position_ms < 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    if body
        .http_file_capabilities_version
        .is_some_and(|version| version != 1)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unsupported_http_file_capabilities_version",
        ));
    }
    let login_hash = cookie(&h).map(|value| hash(&value));
    // Admission precedes the detached owner and its non-cancellable DB commit.
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    // The server owns the probe to completion even if its HTTP waiter disconnects.
    tokio::spawn(async move {
        let request = protocol::PlaybackRequest {
            http_file_fallback_version: body.http_file_capabilities_version.map(u32::from),
            http_file_fallback: None,
            observation_version: None,
            playback_metrics_version: None,
            playback_metrics: None,
            viewer_id: None,
            plan_generation: None,
            idempotency_key: Some(Uuid::new_v4()),
            room_id: body.room_id,
            media_generation: body.media_generation,
            mode: Some("capability_probe".into()),
            position_ms: body.position_ms,
            audio_index: body.audio_index,
            capabilities: None,
            candidate_report: None,
        };
        let start = if body.http_file_capabilities_version == Some(1) {
            playback_requests::begin_authenticated(&app, user.id, &request, login_hash.as_deref()).await?
        } else {
            playback_requests::begin(&app, user.id, &request).await?
        };
        let reservation = match start {
            playback_requests::Start::Reserved(value) => value,
            playback_requests::Start::Replay(_) => {
                return Err(err(StatusCode::CONFLICT, "playback_request_conflict"));
            }
        };
        let scope = media_core::child_process::Scope::new();
        let result = scope.run(async {
            tokio::select! {
                biased;
                _ = owner.cancelled() => Err(err(StatusCode::SERVICE_UNAVAILABLE, "playback_request_interrupted")),
                result = preflight(&app, &user, body, &reservation) => result,
            }
        }).await;
        // Stop every provisional grant even on successful discovery. This
        // reservation is only a probe and never publishes a playback plan.
        let cleanup = playback_requests::fail(
            &app,
            &reservation,
            &err(StatusCode::GONE, "playback_request_cancelled"),
        )
        .await;
        scope.shutdown().await.map_err(anyhow::Error::from)?;
        let receipt_app = app.clone();
        tokio::spawn(async move { owner.acknowledge(&receipt_app, &reservation).await; });
        cleanup?;
        result
    })
    .await
    .map_err(anyhow::Error::from)?
}

async fn preflight(
    app: &App,
    user: &User,
    body: PlaybackCandidateRequest,
    reservation: &playback_requests::Reservation,
) -> Result<Json<PlaybackCandidateSet>> {
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let epoch = reservation.lifecycle_epoch;
    tx.commit().await?;
    let state = persistence::snapshot(&app.db, body.room_id).await?;
    if state.media_generation != body.media_generation {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let media = state
        .media_id
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no_media"))?;
    let row=sqlx::query("SELECT m.resource,m.metadata,m.source_version,s.kind,s.config_encrypted FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available")
        .bind(media).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"media_not_found"))?;
    let kind: String = row.get("kind");
    if reservation.http_file.is_some() && kind != "http" {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    if kind == "http" && body.http_file_capabilities_version == Some(1) {
        return http_preflight(app, user, &body, reservation, media, &config).await;
    }
    let old: Value = row.get("metadata");
    let (mut meta, version) = if kind == "local" {
        let path = media_core::safe_path(
            std::path::Path::new(&config.root),
            &row.get::<String, _>("resource"),
        )?;
        let file = std::fs::File::open(&path).map_err(anyhow::Error::from)?;
        let before = media_core::file_version::snapshot_file(&file).map_err(anyhow::Error::from)?;
        let meta = media_core::probe(&path.to_string_lossy())
            .await
            .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
        let current = std::fs::File::open(&path).map_err(anyhow::Error::from)?;
        if media_core::file_version::snapshot_file(&file).map_err(anyhow::Error::from)? != before
            || media_core::file_version::snapshot_file(&current).map_err(anyhow::Error::from)?
                != before
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
        (meta, before.version)
    } else if kind == "agent" {
        let version: Option<String> = row.get("source_version");
        let Some(version) = version.filter(|v| media_core::file_version::valid_file_version(v))
        else {
            return Ok(fallback("source_version_required"));
        };
        if old["capability_source_version"].as_str() != Some(&version) {
            let ticket = token();
            let resource = json!({"kind":"agent","agent_id":config.agent_id,"resource":row.get::<String,_>("resource"),"root":config.root,"headers":{},"source_version":version});
            let mut tx = app.db.begin().await?;
            playback_requests::guard(app, &mut tx, reservation).await?;
            sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 minute',$8)")
                .bind(reservation.session).bind(user.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&ticket)).bind(json!({"encrypted":app.encrypt(&resource)?})).bind(epoch).execute(&mut *tx).await?;
            tx.commit().await?;
            let base =
                std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
            let response = reqwest::Client::new()
                .get(format!(
                    "{base}/media-delivery/{}/probe",
                    reservation.session
                ))
                .query(&[("token", ticket)])
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
            (
                response
                    .json::<Value>()
                    .await
                    .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?,
                version,
            )
        } else {
            (old.clone(), version)
        }
    } else {
        return Ok(fallback("provider_requires_legacy_negotiation"));
    };
    if old.get("sidecars").is_some() {
        meta["sidecars"] = old["sidecars"].clone();
    }
    let candidates =
        media_core::capabilities::candidates(&meta, body.audio_index, body.position_ms).map_err(
            |error| {
                if error.to_string() == "invalid_audio_track" {
                    err(StatusCode::BAD_REQUEST, "invalid_audio_track")
                } else {
                    err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr")
                }
            },
        )?;
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let current: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR SHARE")
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?;
    if current["media_generation"].as_u64() != Some(u64::from(body.media_generation))
        || current["media_id"].as_str() != Some(&media.to_string())
    {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let membership: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)",
    )
    .bind(body.room_id)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;
    if !membership {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    meta["capability_source_version"] = json!(version);
    let duration = meta["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v * 1000.0);
    if kind == "local" {
        let updated=sqlx::query("UPDATE media_items SET metadata=$2,duration_ms=COALESCE($3,duration_ms) WHERE id=$1 AND available")
            .bind(media)
            .bind(&meta)
            .bind(duration)
            .execute(&mut *tx)
            .await?;
        if updated.rows_affected() != 1 {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
    } else if kind == "agent" {
        let updated = sqlx::query(
            "UPDATE media_items SET metadata=$2,duration_ms=COALESCE($4,duration_ms) WHERE id=$1 AND available AND source_version=$3",
        )
        .bind(media)
        .bind(&meta)
        .bind(&version)
        .bind(duration)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
    }
    tx.commit().await?;
    let binding = Binding {
        purpose: "actual_media_capabilities_v1".into(),
        user: user.id,
        room: body.room_id,
        generation: body.media_generation,
        lifecycle_epoch: epoch,
        media,
        source_version: version,
        audio_index: body.audio_index,
        expires: seconds() + 300,
        candidates: candidates.clone(),
    };
    Ok(Json(PlaybackCandidateSet {
        schema_version: 1,
        http_file_capabilities_version: None,
        binding: Some(app.encrypt(&serde_json::to_value(binding).map_err(anyhow::Error::from)?)?),
        candidates,
        decision_reason: "actual_source_and_constrained_output_candidates".into(),
    }))
}

pub struct Selection {
    pub candidate: PlaybackCandidate,
    pub source_version: Option<String>,
}

fn playable(
    candidate: &PlaybackCandidate,
    result: &protocol::PlaybackCandidateResult,
    caps: &protocol::PlaybackCapabilities,
) -> bool {
    let progressive = matches!(
        result.progressive,
        protocol::MediaTypeSupport::Maybe | protocol::MediaTypeSupport::Probably
    );
    let file = result.file_decoding.as_ref().map(|v| v.supported);
    let mse = result.mse_decoding.as_ref().map(|v| v.supported);
    // Actual passthrough configurations require the concrete decoding API. If
    // unavailable, only the fixed conservative output recipe may use MIME hints.
    let fallback = candidate.id == "transcode_720p";
    let file_ok = progressive && (file == Some(true) || (fallback && file.is_none()));
    let mse_ok =
        result.mse_supported == Some(true) && (mse == Some(true) || (fallback && mse.is_none()));
    if candidate.transport == "progressive" {
        file_ok
    } else {
        // The exact lower-level codec probe can succeed even when the legacy
        // High/Level-4 AVC sample failed. Never gate it on that unrelated sample.
        (caps.native_hls && file_ok) || mse_ok
    }
}

pub fn select(
    app: &App,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    media: Uuid,
    epoch: i64,
    current_version: &str,
) -> Result<Option<Selection>> {
    let Some(report) = &body.candidate_report else {
        return Ok(None);
    };
    if report.binding.len() > 32768
        || report.results.len() > 4
        || report.excluded_candidates.len() > 3
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let binding: Binding = serde_json::from_value(
        app.decrypt(&report.binding)
            .map_err(|_| err(StatusCode::CONFLICT, "stale_capability_report"))?,
    )
    .map_err(|_| err(StatusCode::CONFLICT, "stale_capability_report"))?;
    if binding.purpose != "actual_media_capabilities_v1"
        || binding.user != user
        || binding.room != body.room_id
        || binding.generation != body.media_generation
        || binding.lifecycle_epoch != epoch
        || binding.media != media
        || binding.audio_index != body.audio_index
        || binding.expires < seconds()
    {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    if binding.source_version != current_version {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    select_candidates(body, binding.candidates, Some(binding.source_version))
}

fn select_candidates(
    body: &protocol::PlaybackRequest,
    candidates: Vec<PlaybackCandidate>,
    source_version: Option<String>,
) -> Result<Option<Selection>> {
    let report = body
        .candidate_report
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let caps = body
        .capabilities
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    let mut seen = std::collections::HashSet::new();
    for result in &report.results {
        if !seen.insert(&result.candidate_id)
            || !candidates.iter().any(|c| c.id == result.candidate_id)
        {
            return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
        }
    }
    for candidate in candidates {
        if report.excluded_candidates.contains(&candidate.id) {
            continue;
        }
        let requested = body.mode.as_deref().unwrap_or("auto");
        if requested != "auto"
            && candidate.delivery_mode != requested
            && !(requested == "remux" && candidate.delivery_mode == "audio_transcode")
        {
            continue;
        }
        if candidate.delivery_mode != "direct"
            && candidate.delivery_mode != "transcode"
            && body.position_ms > 0.0
        {
            continue;
        }
        if report
            .results
            .iter()
            .find(|r| r.candidate_id == candidate.id)
            .is_some_and(|r| playable(&candidate, r, caps))
        {
            return Ok(Some(Selection {
                candidate,
                source_version,
            }));
        }
    }
    Err(err(
        StatusCode::UNPROCESSABLE_ENTITY,
        "device_has_no_compatible_playback_transport",
    ))
}

pub fn current_local_version(root: &str, item: &str) -> Result<String> {
    let path = media_core::safe_path(std::path::Path::new(root), item)?;
    let file = std::fs::File::open(path).map_err(anyhow::Error::from)?;
    Ok(media_core::file_version::snapshot_file(&file)
        .map_err(anyhow::Error::from)?
        .version)
}

fn http_binding(app: &App, body: &protocol::PlaybackRequest) -> Result<HttpBinding> {
    let report = body
        .candidate_report
        .as_ref()
        .ok_or_else(|| err(StatusCode::CONFLICT, "stale_capability_report"))?;
    if report.binding.len() > 8192
        || report.results.len() > 4
        || report.excluded_candidates.len() > 3
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let binding: HttpBinding = serde_json::from_value(
        app.decrypt(&report.binding)
            .map_err(|_| err(StatusCode::CONFLICT, "stale_capability_report"))?,
    )
    .map_err(|_| err(StatusCode::CONFLICT, "stale_capability_report"))?;
    let authority = &binding.authority;
    if binding.purpose != HTTP_PURPOSE
        || binding.candidates.is_empty()
        || binding.candidates.len() > 4
        || authority.claim.is_some()
        || authority.candidate.is_none()
    {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    Ok(binding)
}

/// Freeze only the server-issued expectation in the existing request ledger.
/// The caller has already captured current member/login authority under locks.
pub async fn capture_http(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    body: &protocol::PlaybackRequest,
    state: &Value,
    context: persistence::http_file_authorization::Context,
    epoch: i64,
) -> Result<Authority> {
    if body.mode.as_deref() == Some("direct") {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    let binding = http_binding(app, body)?;
    let authority = binding.authority;
    if binding.lifecycle_epoch != epoch
        || authority.context != context
        || authority.media_generation != body.media_generation
        || authority.audio_intent != body.audio_index
    {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    http_file::guard_scope(tx, &authority, state).await?;
    http_file::guard_deadline(tx, &authority).await?;
    http_file::encrypt(app, &authority)?;
    Ok(authority)
}

pub fn select_http(
    app: &App,
    body: &protocol::PlaybackRequest,
    authority: &Authority,
    epoch: i64,
) -> Result<Option<Selection>> {
    let binding = http_binding(app, body)?;
    if binding.lifecycle_epoch != epoch
        || serde_json::to_value(&binding.authority).map_err(anyhow::Error::from)?
            != serde_json::to_value(authority).map_err(anyhow::Error::from)?
    {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    // HTTP expiry is enforced by the database authority at admission and
    // again before input/publication; the Server clock is not an extra gate.
    select_candidates(body, binding.candidates, None)
}

async fn http_preflight(
    app: &App,
    user: &User,
    body: &PlaybackCandidateRequest,
    reservation: &playback_requests::Reservation,
    media: Uuid,
    config: &SourceConfig,
) -> Result<Json<PlaybackCandidateSet>> {
    let target_url = providers::validate_url(&config.url)?;
    if target_url.path().to_ascii_lowercase().ends_with(".m3u8") {
        return Ok(fallback("provider_requires_legacy_negotiation"));
    }
    let mut authority = reservation
        .http_file
        .as_deref()
        .cloned()
        .ok_or_else(|| err(StatusCode::CONFLICT, "stale_capability_report"))?;
    let mut resource = json!({"kind":"http","resource":"file","url":config.url,"source_url":config.url,
        "headers":config.headers,"access_policy":config.access_policy,
        "source_id":authority.source_id,"source_policy_revision":authority.source_policy_revision});
    http_file::restrict_binary(&mut resource)?;
    let ticket = token();
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    sqlx::query("SELECT lock_playback_http_representation($1)")
        .bind(reservation.session)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 minute',$8)")
        .bind(reservation.session).bind(user.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation))
        .bind(hash(&ticket)).bind(http_file::wrap_resource(app, &resource, Some(&authority), authority.source_policy_revision, None)?)
        .bind(reservation.lifecycle_epoch).execute(&mut *tx).await?;
    tx.commit().await?;
    let base = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let response = reqwest::Client::new()
        .get(format!(
            "{base}/media-delivery/{}/probe",
            reservation.session
        ))
        .query(&[("token", ticket)])
        .timeout(std::time::Duration::from_secs(35))
        .send()
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
    if !response.status().is_success() {
        let status = response.status();
        let error = response.json::<protocol::ErrorResponse>().await.ok();
        let mut tx = app.db.begin().await?;
        playback_requests::guard(app, &mut tx, reservation).await?;
        tx.commit().await?;
        if status == StatusCode::CONFLICT
            && error
                .as_ref()
                .is_some_and(|e| e.error.code == protocol::ErrorCode::SourceVersionRequired)
        {
            return Ok(fallback("source_version_required"));
        }
        if status == StatusCode::CONFLICT
            && error
                .as_ref()
                .is_some_and(|e| e.error.code == protocol::ErrorCode::SourceChanged)
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
        if status == StatusCode::BAD_GATEWAY
            && error
                .as_ref()
                .is_some_and(|e| e.error.code == protocol::ErrorCode::MediaInputDenied)
        {
            return Err(err(StatusCode::BAD_GATEWAY, "media_input_denied"));
        }
        return Err(err(StatusCode::BAD_GATEWAY, "source_probe_failed"));
    }
    let meta = response
        .json::<Value>()
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    if meta["format"]["format_name"]
        .as_str()
        .is_some_and(|name| name.split(',').any(|name| name == "hls"))
    {
        return Ok(fallback("provider_requires_legacy_negotiation"));
    }
    let candidates =
        media_core::capabilities::candidates(&meta, body.audio_index, body.position_ms).map_err(
            |error| {
                if error.to_string() == "invalid_audio_track" {
                    err(StatusCode::BAD_REQUEST, "invalid_audio_track")
                } else {
                    err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr")
                }
            },
        )?;
    http_representation::guard(&mut tx, reservation.session).await?;
    let (target_sha256, identity) = match http_file::single_identity(&mut tx, reservation.session)
        .await
    {
        Ok(identity) => identity,
        Err(error) if error.0.is_client_error() => return Ok(fallback("source_version_required")),
        Err(error) => return Err(error),
    };
    if target_sha256 != http_file::target(&resource)? {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    authority.candidate = Some(CandidateExpectation {
        target_sha256,
        identity,
        expires: http_expiry(&mut tx).await?,
    });
    let binding = app.encrypt(
        &serde_json::to_value(HttpBinding {
            purpose: HTTP_PURPOSE.into(),
            lifecycle_epoch: reservation.lifecycle_epoch,
            authority,
            candidates: candidates.clone(),
        })
        .map_err(anyhow::Error::from)?,
    )?;
    if binding.len() > 8192 {
        return Err(err(StatusCode::CONFLICT, "source_version_required"));
    }
    // All room/member/login/source/request locks were acquired before the
    // HTTP fence. Re-evaluate wall-clock gates after waiting on that fence;
    // re-entrant guard calls do not introduce a reverse lock acquisition.
    playback_requests::guard(app, &mut tx, reservation).await?;
    require_live_probe(&mut tx, reservation.session).await?;
    tx.commit().await?;
    Ok(Json(PlaybackCandidateSet {
        schema_version: 1,
        http_file_capabilities_version: Some(1),
        binding: Some(binding),
        candidates,
        decision_reason: "actual_http_binary_and_constrained_output_candidates".into(),
    }))
}

/// Use the same wall clock as guard_deadline. Rounding down keeps the
/// authority window at or below five minutes, including under Server skew.
pub(crate) async fn http_expiry(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) -> Result<u64> {
    let expires: i64 =
        sqlx::query_scalar("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint+300")
            .fetch_one(&mut **tx)
            .await?;
    u64::try_from(expires).map_err(|error| anyhow::Error::from(error).into())
}

pub(crate) async fn require_live_probe(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    session: Uuid,
) -> Result<()> {
    let live: bool = sqlx::query_scalar("SELECT NOT stopped AND expires_at>clock_timestamp() AND playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=$1")
        .bind(session).fetch_one(&mut **tx).await?;
    if !live {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates() -> Vec<PlaybackCandidate> {
        media_core::capabilities::candidates(&json!({"format":{"format_name":"mov,mp4","bit_rate":"1000000"},
            "streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":360,
                "avg_frame_rate":"25/1","r_frame_rate":"25/1","extradata":"\n00000000: 0164 000d ffe1 0000                      .d......\n"}]}), None, 0.0).unwrap()
    }
    fn body() -> protocol::PlaybackRequest {
        serde_json::from_value(json!({"room_id":Uuid::nil(),"media_generation":1,"mode":"auto",
            "capabilities":{"progressive_h264_aac":false,"native_hls":false,"mse_h264_aac":false},
            "candidate_report":{"binding":"opaque","results":[
                {"candidate_id":"direct","progressive":"probably","file_decoding":{"supported":true,"smooth":true,"power_efficient":true}},
                {"candidate_id":"remux","progressive":"unknown","mse_supported":true,"mse_decoding":{"supported":true,"smooth":true,"power_efficient":false}},
                {"candidate_id":"transcode_720p","progressive":"unknown","mse_supported":true}
            ]}})).unwrap()
    }

    #[test]
    fn frozen_routes_exclude_decoder_failures_and_preserve_transport_evidence() {
        let mut body = body();
        let selection = select_candidates(&body, candidates(), None)
            .unwrap()
            .unwrap();
        assert_eq!(selection.candidate.id, "direct");
        assert!(selection.source_version.is_none());
        body.candidate_report
            .as_mut()
            .unwrap()
            .excluded_candidates
            .push("direct".into());
        assert_eq!(
            select_candidates(&body, candidates(), None)
                .unwrap()
                .unwrap()
                .candidate
                .id,
            "remux"
        );
        body.position_ms = 100.0;
        assert_eq!(
            select_candidates(&body, candidates(), None)
                .unwrap()
                .unwrap()
                .candidate
                .id,
            "transcode_720p"
        );
        body.candidate_report
            .as_mut()
            .unwrap()
            .excluded_candidates
            .push("transcode_720p".into());
        assert_eq!(
            select_candidates(&body, candidates(), None)
                .err()
                .unwrap()
                .1,
            "device_has_no_compatible_playback_transport"
        );
    }

    #[test]
    fn concrete_negative_and_duplicate_or_unknown_results_fail_closed() {
        let mut body = body();
        let report = body.candidate_report.as_mut().unwrap();
        report.results[0].file_decoding.as_mut().unwrap().supported = false;
        assert_eq!(
            select_candidates(&body, candidates(), None)
                .unwrap()
                .unwrap()
                .candidate
                .id,
            "remux"
        );
        let report = body.candidate_report.as_mut().unwrap();
        report.results.push(report.results[0].clone());
        assert_eq!(
            select_candidates(&body, candidates(), None)
                .err()
                .unwrap()
                .1,
            "invalid_request"
        );
        let report = body.candidate_report.as_mut().unwrap();
        report.results.pop();
        report.results[0].candidate_id = "caller_invented".into();
        assert_eq!(
            select_candidates(&body, candidates(), None)
                .err()
                .unwrap()
                .1,
            "invalid_request"
        );
    }
}
