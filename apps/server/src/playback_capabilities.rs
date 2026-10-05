use super::*;
use playback_requests::http_file_fallback::{self as http_file, Authority, CandidateExpectation};
use protocol::{PlaybackCandidate, PlaybackCandidateRequest, PlaybackCandidateSet};
use providers::SourceConfig;
use serde::Serialize;

const HTTP_PURPOSE: &str = "actual_http_file_capabilities_v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    advanced_assets_sha256: Option<String>,
    purpose: String,
    lifecycle_epoch: i64,
    authority: Authority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    advanced_playback: Option<protocol::AdvancedPlaybackRequest>,
    candidates: Vec<PlaybackCandidate>,
}

#[derive(Serialize, Deserialize)]
struct Binding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    advanced_assets_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_hls_ladder: Option<protocol::LocalHlsLadderRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    advanced_playback: Option<protocol::AdvancedPlaybackRequest>,
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

impl Binding {
    fn matches(
        &self,
        user: Uuid,
        body: &protocol::PlaybackRequest,
        media: Uuid,
        epoch: i64,
        now: u64,
    ) -> bool {
        self.purpose == "actual_media_capabilities_v1"
            && self.user == user
            && self.room == body.room_id
            && self.generation == body.media_generation
            && self.lifecycle_epoch == epoch
            && self.media == media
            && self.audio_index == body.audio_index
            && self.advanced_playback == body.advanced_playback
            && self.local_hls_ladder == body.local_hls_ladder
            && self.expires >= now
    }
}

fn seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn fallback(reason: &str) -> Json<PlaybackCandidateSet> {
    Json(PlaybackCandidateSet {
        local_hls_ladder: None,
        advanced_playback: None,
        schema_version: 1,
        http_file_capabilities_version: None,
        binding: None,
        candidates: Vec::new(),
        decision_reason: reason.into(),
        route_decisions: None,
    })
}

fn refused_legacy_mapping(
    analysis: media_core::capabilities::CandidateAnalysis,
) -> Json<PlaybackCandidateSet> {
    Json(PlaybackCandidateSet {
        local_hls_ladder: None,
        advanced_playback: None,
        schema_version: 1,
        http_file_capabilities_version: None,
        binding: None,
        candidates: analysis.candidates,
        decision_reason: "no_supported_legacy_mapped_route".into(),
        route_decisions: Some(analysis.route_decisions),
    })
}

/// Bind the existing Agent relay probe to the same source configuration, item
/// and indexed stat-v1 change detector. The caller guards the original request
/// before and after these potentially waiting locks. Stat-v1 is not a content
/// hash or an immutable snapshot; the Agent keeps checking its held file too.
pub(crate) async fn guard_agent_source(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    media: Uuid,
    resource: &Value,
    config_encrypted: &str,
) -> Result<()> {
    let changed = || err(StatusCode::CONFLICT, "source_changed");
    let source = resource["source_id"]
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(changed)?;
    let revision = resource["source_policy_revision"]
        .as_i64()
        .ok_or_else(changed)?;
    let item = resource["resource"].as_str().ok_or_else(changed)?;
    let version = resource["source_version"]
        .as_str()
        .filter(|value| media_core::file_version::valid_file_version(value))
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_version_required"))?;
    let agent = resource["agent_id"]
        .as_str()
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(changed)?;
    let current = sqlx::query(
        "SELECT kind,config_encrypted,access_policy_revision FROM sources WHERE id=$1 FOR SHARE",
    )
    .bind(source)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(changed)?;
    if current.get::<String, _>("kind") != "agent"
        || current.get::<String, _>("config_encrypted") != config_encrypted
        || current.get::<i64, _>("access_policy_revision") != revision
    {
        return Err(changed());
    }
    // Serialize metadata publication with scans and other probes rather than
    // taking SHARE and later upgrading it while another probe does the same.
    let item = sqlx::query("SELECT id FROM media_items WHERE id=$1 AND source_id=$2 AND resource=$3 AND source_version=$4 AND available FOR UPDATE")
        .bind(media).bind(source).bind(item).bind(version).fetch_optional(&mut **tx).await?;
    if item.is_none()
        || sqlx::query("SELECT id FROM agents WHERE id=$1 AND NOT revoked FOR SHARE")
            .bind(agent)
            .fetch_optional(&mut **tx)
            .await?
            .is_none()
    {
        return Err(changed());
    }
    Ok(())
}

/// Local jobs bind the source configuration and indexed item as well as the
/// held-file stat detector. Configuration labels cannot redirect a sealed job.
pub(crate) async fn guard_local_source(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    media: Uuid,
    source: Uuid,
    item: &str,
    config_encrypted: &str,
    revision: i64,
) -> Result<()> {
    let changed = || err(StatusCode::CONFLICT, "source_changed");
    let current = sqlx::query(
        "SELECT kind,config_encrypted,access_policy_revision FROM sources WHERE id=$1 FOR SHARE",
    )
    .bind(source)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(changed)?;
    if current.get::<String, _>("kind") != "local"
        || current.get::<String, _>("config_encrypted") != config_encrypted
        || current.get::<i64, _>("access_policy_revision") != revision
        || sqlx::query("SELECT id FROM media_items WHERE id=$1 AND source_id=$2 AND resource=$3 AND available FOR UPDATE")
            .bind(media).bind(source).bind(item).fetch_optional(&mut **tx).await?.is_none()
    {
        return Err(changed());
    }
    Ok(())
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
    if let Some(value) = &body.local_hls_ladder {
        local_hls_ladder::request(value)?;
    }
    if body
        .local_hls_ladder_capabilities_version
        .is_some_and(|v| v != 1)
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    if let Some(value) = &body.advanced_playback {
        advanced_playback::request(value)?;
    }
    if body
        .advanced_playback_capabilities_version
        .is_some_and(|version| version != 1)
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
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
            distributed_compute: None,
            finite_hls_version: None,
            local_hls_ladder: body.local_hls_ladder.clone(),
            advanced_playback: body.advanced_playback.clone(),
            native_platform: None,
            static_hls_fallback_version: None,
            http_file_fallback_version: (body.http_file_capabilities_version==Some(1)||body.advanced_playback_capabilities_version==Some(1)||body.advanced_playback.is_some()).then_some(1),
            http_file_fallback: None,
            observation_version: None,
            playback_metrics_version: None,
            playback_metrics: None,
            playback_metrics_supported_versions: None,
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
            upstream_profile_report: None,
        };
        let start = playback_requests::begin_authenticated(&app, user.id, &request, login_hash.as_deref()).await?;
        let reservation = match start {
            playback_requests::Start::Reserved(value) => value,
            playback_requests::Start::Replay(_) | playback_requests::Start::StaticHlsPublished { .. } => {
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
    private_library::authorize_media(app, user.id, media, "play", Some(body.room_id)).await?;
    let row=sqlx::query("SELECT m.source_id,m.resource,m.metadata,m.source_version,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available")
        .bind(media).fetch_optional(&app.db).await?.ok_or_else(||err(StatusCode::NOT_FOUND,"media_not_found"))?;
    let kind: String = row.get("kind");
    if body.local_hls_ladder.is_some() && (kind != "local" || !cfg!(target_os = "linux")) {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "local_hls_ladder_source_required",
        ));
    }
    if body.advanced_playback.is_some()
        && (!matches!(kind.as_str(), "local" | "agent" | "http") || !cfg!(target_os = "linux"))
    {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "advanced_local_source_required",
        ));
    }
    if reservation.http_file.is_some() && kind != "http" {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let config: SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    if kind == "http"
        && (body.http_file_capabilities_version == Some(1)
            || body.advanced_playback.is_some()
            || body.advanced_playback_capabilities_version == Some(1))
    {
        return http_preflight(app, user, &body, reservation, media, &config).await;
    }
    let old: Value = row.get("metadata");
    let offer_advanced =
        body.advanced_playback_capabilities_version == Some(1) || body.advanced_playback.is_some();
    let mut header_complete = true;
    let (mut meta, version) = if kind == "local" {
        let item: String = row.get("resource");
        if body.advanced_playback.is_some() {
            probe_local_advanced(&config.root, &item).await?
        } else {
            match probe_local(&config.root, &item).await {
                Ok(probe) => probe,
                // Large embedded fonts can exceed the ordinary codec-header
                // dump bound. A fresh metadata-only probe can expose advanced
                // options, but must never supply original/copy codec facts.
                Err(error)
                    if offer_advanced
                        && error.0 == StatusCode::BAD_GATEWAY
                        && error.1 == "source_probe_failed" =>
                {
                    header_complete = false;
                    probe_local_advanced(&config.root, &item).await?
                }
                Err(error) => return Err(error),
            }
        }
    } else if kind == "agent" {
        let version: Option<String> = row.get("source_version");
        let Some(version) = version.filter(|v| media_core::file_version::valid_file_version(v))
        else {
            return Ok(fallback("source_version_required"));
        };
        // A version-matched cache is not this attempt's complete probe. Use
        // the existing relay, which checks stat-v1 on every Agent file read.
        {
            let ticket = token();
            let resource = json!({"kind":"agent","agent_id":config.agent_id,"resource":row.get::<String,_>("resource"),"root":config.root,"headers":{},"source_version":version,"advanced_probe":if body.advanced_playback.is_some(){"metadata_only"}else if offer_advanced{"offer"}else{"legacy"},
                "source_id":row.get::<Uuid,_>("source_id"),"source_policy_revision":row.get::<i64,_>("access_policy_revision")});
            let mut tx = app.db.begin().await?;
            playback_requests::guard(app, &mut tx, reservation).await?;
            guard_agent_source(
                &mut tx,
                media,
                &resource,
                &row.get::<String, _>("config_encrypted"),
            )
            .await?;
            playback_requests::guard(app, &mut tx, reservation).await?;
            sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 minute',$8)")
                .bind(reservation.session).bind(user.id).bind(body.room_id).bind(media).bind(i64::from(body.media_generation)).bind(hash(&ticket)).bind(http_file::wrap_resource(app, &resource, None, row.get("access_policy_revision"), None)?).bind(epoch).execute(&mut *tx).await?;
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
        }
    } else {
        return Ok(fallback("provider_requires_legacy_negotiation"));
    };
    if meta["advanced_metadata_only"] == true {
        header_complete = false;
    }
    if old.get("sidecars").is_some() {
        meta["sidecars"] = old["sidecars"].clone();
    }
    if kind == "local" && offer_advanced {
        advanced_playback::attach_assets(
            &config.root,
            &row.get::<String, _>("resource"),
            &version,
            &mut meta,
        )
        .await?;
    }
    let ladder_capabilities = (kind == "local"
        && (body.local_hls_ladder_capabilities_version == Some(1)
            || body.local_hls_ladder.is_some()))
    .then(|| {
        if let Some(request) = &body.advanced_playback {
            local_hls_ladder::capabilities_with_advanced(&meta, body.audio_index, request)
        } else {
            local_hls_ladder::capabilities(&meta, body.audio_index)
        }
    });
    let advanced_capabilities = (matches!(kind.as_str(), "local" | "agent") && offer_advanced)
        .then(|| advanced_playback::capabilities(&meta, body.audio_index));
    let analysis = if body.local_hls_ladder.is_some() {
        local_hls_ladder::require_local(&kind, Some(&version))?;
        if let Some(request) = &body.advanced_playback {
            local_hls_ladder::analyze_with_advanced(
                &meta,
                body.audio_index,
                body.position_ms,
                request,
            )?
        } else {
            local_hls_ladder::analyze(&meta, body.audio_index, body.position_ms)?
        }
    } else if let Some(value) = &body.advanced_playback {
        advanced_playback::require_local(&kind, Some(&version))?;
        advanced_playback::analyze(&meta, body.audio_index, body.position_ms, value)?
    } else if !header_complete {
        media_core::capabilities::CandidateAnalysis {
            candidates: vec![],
            route_decisions: vec![],
        }
    } else {
        match media_core::capabilities::analyze_legacy_mapped_source(
            &meta,
            body.audio_index,
            body.position_ms,
        ) {
            Ok(analysis) => analysis,
            Err(error)
                if matches!(kind.as_str(), "local" | "agent")
                    && offer_advanced
                    && error.to_string() == "hdr_unsupported" =>
            {
                media_core::capabilities::CandidateAnalysis {
                    candidates: vec![],
                    route_decisions: vec![],
                }
            }
            Err(error) => return Err(probe_error(error)),
        }
    };
    if analysis.candidates.is_empty()
        && advanced_capabilities.is_none()
        && ladder_capabilities.is_none()
    {
        return Ok(refused_legacy_mapping(analysis));
    }
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
    if kind == "agent" {
        let resource = json!({"kind":"agent","agent_id":config.agent_id,"resource":row.get::<String,_>("resource"),"source_version":version,
            "source_id":row.get::<Uuid,_>("source_id"),"source_policy_revision":row.get::<i64,_>("access_policy_revision")});
        guard_agent_source(
            &mut tx,
            media,
            &resource,
            &row.get::<String, _>("config_encrypted"),
        )
        .await?;
        playback_requests::guard(app, &mut tx, reservation).await?;
        require_live_probe(&mut tx, reservation.session).await?;
    }
    // Empty legacy HDR sets still publish source eligibility under the same
    // fences, so a user can explicitly request the separate advanced recipe.
    let candidates = analysis.candidates;
    meta["capability_source_version"] = json!(version);
    let duration = meta["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v * 1000.0);
    if kind == "local" {
        guard_local_source(
            &mut tx,
            media,
            row.get("source_id"),
            &row.get::<String, _>("resource"),
            &row.get::<String, _>("config_encrypted"),
            row.get("access_policy_revision"),
        )
        .await?;
        playback_requests::guard(app, &mut tx, reservation).await?;
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
    // Source locks may have waited behind a scan/configuration change. Recheck
    // the original login, membership, lifecycle and request deadline afterward.
    if kind == "agent" {
        playback_requests::guard(app, &mut tx, reservation).await?;
        require_live_probe(&mut tx, reservation.session).await?;
    }
    if kind == "local" {
        playback_requests::guard(app, &mut tx, reservation).await?;
        if current_local_version(&config.root, &row.get::<String, _>("resource"))
            .ok()
            .as_deref()
            != Some(&version)
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
    }
    tx.commit().await?;
    if candidates.is_empty() {
        let Json(mut set) = refused_legacy_mapping(media_core::capabilities::CandidateAnalysis {
            candidates,
            route_decisions: analysis.route_decisions,
        });
        set.advanced_playback = advanced_capabilities;
        set.local_hls_ladder = ladder_capabilities;
        return Ok(Json(set));
    }
    let binding = Binding {
        advanced_assets_sha256: if body.advanced_playback.is_some() {
            advanced_playback::assets_hash(&meta)?
        } else {
            None
        },
        local_hls_ladder: body.local_hls_ladder,
        advanced_playback: body.advanced_playback,
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
        local_hls_ladder: ladder_capabilities,
        advanced_playback: advanced_capabilities,
        schema_version: 1,
        http_file_capabilities_version: None,
        binding: Some(app.encrypt(&serde_json::to_value(binding).map_err(anyhow::Error::from)?)?),
        candidates,
        decision_reason: "actual_source_and_constrained_output_candidates".into(),
        route_decisions: Some(analysis.route_decisions),
    }))
}

/// Translate only known media classifications; never expose raw probe details.
pub fn probe_error(error: anyhow::Error) -> Error {
    let reason = error.to_string();
    match reason.as_str() {
        "invalid_audio_track" => err(StatusCode::BAD_REQUEST, "invalid_audio_track"),
        "legacy_stream_mapping_unsupported" => err(StatusCode::UNPROCESSABLE_ENTITY, &reason),
        "hdr_unsupported" | "drm_unsupported" => err(StatusCode::UNPROCESSABLE_ENTITY, &reason),
        _ => err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr"),
    }
}

/// Publish facts only after the current guarded probe reproduces this exact
/// server-bound candidate. Mixed copy/encode routes keep track-specific bases.
pub fn selected_output(
    selection: &Selection,
    meta: &Value,
    audio_index: Option<u32>,
    position_ms: f64,
) -> Result<protocol::PlaybackSelectedOutput> {
    let actual = media_core::capabilities::candidates(meta, audio_index, position_ms)
        .map_err(|_| err(StatusCode::CONFLICT, "source_changed"))?;
    let expected = serde_json::to_value(&selection.candidate).map_err(anyhow::Error::from)?;
    if !actual
        .iter()
        .any(|candidate| serde_json::to_value(candidate).ok().as_ref() == Some(&expected))
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    use protocol::PlaybackOutputBasis::{ConstrainedEncoderRecipe, SourceProbe};
    let mode = selection.candidate.delivery_mode.as_str();
    Ok(protocol::PlaybackSelectedOutput {
        configuration: selection.candidate.clone(),
        video_basis: if mode == "transcode" {
            ConstrainedEncoderRecipe
        } else {
            SourceProbe
        },
        audio_basis: selection.candidate.audio.as_ref().map(|_| {
            if matches!(mode, "transcode" | "audio_transcode") {
                ConstrainedEncoderRecipe
            } else {
                SourceProbe
            }
        }),
    })
}

pub fn selected_advanced_output(
    selection: &Selection,
    meta: &Value,
    audio_index: Option<u32>,
    position_ms: f64,
    request: &protocol::AdvancedPlaybackRequest,
) -> Result<protocol::PlaybackSelectedOutput> {
    let analysis = advanced_playback::analyze(meta, audio_index, position_ms, request)?;
    let expected = serde_json::to_value(&selection.candidate).map_err(anyhow::Error::from)?;
    if !analysis
        .candidates
        .iter()
        .any(|candidate| serde_json::to_value(candidate).ok().as_ref() == Some(&expected))
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(protocol::PlaybackSelectedOutput {
        configuration: selection.candidate.clone(),
        video_basis: protocol::PlaybackOutputBasis::ConstrainedEncoderRecipe,
        audio_basis: selection
            .candidate
            .audio
            .as_ref()
            .map(|_| protocol::PlaybackOutputBasis::ConstrainedEncoderRecipe),
    })
}

/// Agent output provenance needs a fresh version-bound inventory and proof
/// that the unchanged generated recipe consumes the described streams. An
/// unproven original-file direct route remains playable without these facts.
pub fn selected_agent_output(
    selection: &Selection,
    meta: &Value,
    audio_index: Option<u32>,
    position_ms: f64,
    current_probe: bool,
) -> Result<Option<protocol::PlaybackSelectedOutput>> {
    if !current_probe {
        return Ok(None);
    }
    let version = selection
        .source_version
        .as_deref()
        .filter(|value| media_core::file_version::valid_file_version(value))
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_changed"))?;
    if meta["capability_source_version"].as_str() != Some(version) {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    match media_core::motion_video::legacy_mapping_equivalent(meta, audio_index) {
        Ok(()) => selected_output(selection, meta, audio_index, position_ms).map(Some),
        Err(error)
            if error.to_string() == "legacy_stream_mapping_unsupported"
                && selection.candidate.delivery_mode == "direct" =>
        {
            Ok(None)
        }
        Err(error) => Err(probe_error(error)),
    }
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
    let fallback = candidate.id == "transcode_720p"
        || matches!(
            candidate.id.as_str(),
            "hls_ladder_low" | "hls_ladder_medium" | "hls_ladder_high"
        );
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
    current_meta: &Value,
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
    if !binding.matches(user, body, media, epoch, seconds()) {
        return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
    }
    if binding.advanced_assets_sha256
        != if body.advanced_playback.is_some() {
            advanced_playback::assets_hash(current_meta)?
        } else {
            None
        }
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    if binding.source_version != current_version {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    if body.local_hls_ladder.is_some() {
        let fresh = if let Some(request) = &body.advanced_playback {
            local_hls_ladder::analyze_with_advanced(
                current_meta,
                body.audio_index,
                body.position_ms,
                request,
            )?
        } else {
            local_hls_ladder::analyze(current_meta, body.audio_index, body.position_ms)?
        };
        if serde_json::to_value(&fresh.candidates).map_err(anyhow::Error::from)?
            != serde_json::to_value(&binding.candidates).map_err(anyhow::Error::from)?
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
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
    if body.local_hls_ladder.is_some()
        && (!report.excluded_candidates.is_empty()
            || candidates.is_empty()
            || candidates.len() > 3
            || !candidates.iter().all(|candidate| {
                report
                    .results
                    .iter()
                    .find(|r| r.candidate_id == candidate.id)
                    .is_some_and(|result| playable(candidate, result, caps))
            }))
    {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "device_has_no_compatible_playback_transport",
        ));
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

/// Bind ffprobe facts to a held local file and the current authorized path.
/// Stat identity detects ordinary replacement/edits; it is not an immutable
/// snapshot or a content hash. Delivery and jobs must keep checking the version.
pub async fn probe_local(root: &str, item: &str) -> Result<(Value, String)> {
    probe_local_policy(root, item, false).await
}

pub async fn probe_local_advanced(root: &str, item: &str) -> Result<(Value, String)> {
    probe_local_policy(root, item, true).await
}

async fn probe_local_policy(
    root: &str,
    item: &str,
    metadata_only: bool,
) -> Result<(Value, String)> {
    let path = media_core::safe_path(std::path::Path::new(root), item)?;
    let file = std::fs::File::open(&path).map_err(anyhow::Error::from)?;
    let before = media_core::file_version::snapshot_file(&file).map_err(anyhow::Error::from)?;
    let probe = if metadata_only {
        media_core::advanced_media::probe_metadata(&path.to_string_lossy()).await
    } else {
        media_core::probe(&path.to_string_lossy()).await
    };
    // Re-resolve the source-relative path too: an ancestor or symlink may have
    // changed while ffprobe used the previously canonicalized path.
    let unchanged = (|| -> anyhow::Result<bool> {
        let current_path = media_core::safe_path(std::path::Path::new(root), item)?;
        let current = std::fs::File::open(current_path)?;
        Ok(media_core::file_version::snapshot_file(&file)? == before
            && media_core::file_version::snapshot_file(&current)? == before)
    })();
    if !matches!(unchanged, Ok(true)) {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let meta = probe.map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?;
    Ok((meta, before.version))
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
        || binding.advanced_playback != body.advanced_playback
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

pub(crate) fn verify_http_assets(
    app: &App,
    body: &protocol::PlaybackRequest,
    meta: &Value,
) -> Result<()> {
    let binding = http_binding(app, body)?;
    let actual = if body.advanced_playback.is_some() {
        advanced_playback::assets_hash(meta)?
    } else {
        None
    };
    if binding.advanced_assets_sha256 != actual {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(())
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
    if let Some(association) = &config.advanced_assets {
        resource["advanced_asset_association"] =
            serde_json::to_value(association).map_err(anyhow::Error::from)?;
    }
    resource["advanced_probe"] = json!(if body.advanced_playback.is_some() {
        "metadata_only"
    } else if body.advanced_playback_capabilities_version == Some(1) {
        "offer"
    } else {
        "legacy"
    });
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
    let offer_advanced =
        body.advanced_playback_capabilities_version == Some(1) || body.advanced_playback.is_some();
    let advanced_capabilities =
        offer_advanced.then(|| advanced_playback::capabilities(&meta, body.audio_index));
    let analysis = if let Some(request) = &body.advanced_playback {
        advanced_playback::analyze(&meta, body.audio_index, body.position_ms, request)?
    } else if meta["advanced_metadata_only"] == true {
        media_core::capabilities::CandidateAnalysis {
            candidates: vec![],
            route_decisions: vec![],
        }
    } else {
        match media_core::capabilities::analyze_legacy_mapped_source(
            &meta,
            body.audio_index,
            body.position_ms,
        ) {
            Ok(value) => value,
            Err(error) if offer_advanced && error.to_string() == "hdr_unsupported" => {
                media_core::capabilities::CandidateAnalysis {
                    candidates: vec![],
                    route_decisions: vec![],
                }
            }
            Err(error) => return Err(probe_error(error)),
        }
    };
    if analysis.candidates.is_empty() {
        let Json(mut set) = refused_legacy_mapping(analysis);
        set.advanced_playback = advanced_capabilities;
        return Ok(Json(set));
    }
    let candidates = analysis.candidates;
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
            advanced_assets_sha256: if body.advanced_playback.is_some() {
                advanced_playback::assets_hash(&meta)?
            } else {
                None
            },
            purpose: HTTP_PURPOSE.into(),
            lifecycle_epoch: reservation.lifecycle_epoch,
            authority,
            advanced_playback: body.advanced_playback.clone(),
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
        local_hls_ladder: None,
        advanced_playback: advanced_capabilities,
        schema_version: 1,
        http_file_capabilities_version: Some(1),
        binding: Some(binding),
        candidates,
        decision_reason: "actual_http_binary_and_constrained_output_candidates".into(),
        route_decisions: Some(analysis.route_decisions),
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
    let live: bool = sqlx::query_scalar("SELECT NOT stopped AND expires_at>clock_timestamp() AND playback_source_allowed(media_id,resource,id) FROM playback_sessions WHERE id=$1")
        .bind(session).fetch_one(&mut **tx).await?;
    if !live {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ladder_requires_every_bound_rung_and_exact_intent_scope() {
        let meta = json!({"format":{"start_time":"0","duration":"120"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","sample_aspect_ratio":"1:1","avg_frame_rate":"30/1","r_frame_rate":"30/1","disposition":{"attached_pic":0}}]});
        let candidates = local_hls_ladder::analyze(&meta, None, 0.0)
            .unwrap()
            .candidates;
        assert_eq!(candidates.len(), 3);
        let mut body = body();
        body.local_hls_ladder = Some(protocol::LocalHlsLadderRequest { schema_version: 1 });
        body.mode = Some("transcode".into());
        body.capabilities.as_mut().unwrap().native_hls = true;
        body.candidate_report=Some(serde_json::from_value(json!({"binding":"bound","results":candidates.iter().map(|c|json!({"candidate_id":c.id,"progressive":"maybe"})).collect::<Vec<_>>(),"excluded_candidates":[]})).unwrap());
        assert!(select_candidates(&body, candidates.clone(), Some("source".into())).is_ok());
        body.candidate_report.as_mut().unwrap().results.pop();
        assert!(select_candidates(&body, candidates.clone(), Some("source".into())).is_err());
        body.candidate_report.as_mut().unwrap().results.push(
            serde_json::from_value(
                json!({"candidate_id":"hls_ladder_high","progressive":"unsupported"}),
            )
            .unwrap(),
        );
        assert!(select_candidates(&body, candidates.clone(), Some("source".into())).is_err());
        let binding = Binding {
            advanced_assets_sha256: None,
            local_hls_ladder: body.local_hls_ladder.clone(),
            advanced_playback: None,
            purpose: "actual_media_capabilities_v1".into(),
            user: Uuid::nil(),
            room: body.room_id,
            generation: body.media_generation,
            lifecycle_epoch: 1,
            media: Uuid::nil(),
            source_version: "version".into(),
            audio_index: body.audio_index,
            expires: 10,
            candidates,
        };
        assert!(binding.matches(Uuid::nil(), &body, Uuid::nil(), 1, 10));
        body.local_hls_ladder = None;
        assert!(!binding.matches(Uuid::nil(), &body, Uuid::nil(), 1, 10));
    }

    #[test]
    fn advanced_candidate_binding_preserves_exact_transform_and_scope() {
        let user = Uuid::new_v4();
        let media = Uuid::new_v4();
        let mut body = body();
        body.advanced_playback = Some(protocol::AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: true,
            subtitle_stream_index: Some(0),
        });
        let binding = Binding {
            advanced_assets_sha256: None,
            local_hls_ladder: None,
            purpose: "actual_media_capabilities_v1".into(),
            user,
            room: body.room_id,
            generation: body.media_generation,
            lifecycle_epoch: 9,
            media,
            source_version: "bound-stat-version".into(),
            audio_index: body.audio_index,
            expires: 30,
            candidates: vec![],
            advanced_playback: body.advanced_playback.clone(),
        };
        assert!(binding.matches(user, &body, media, 9, 30));
        assert!(!binding.matches(user, &body, media, 9, 31));
        assert!(!binding.matches(Uuid::new_v4(), &body, media, 9, 1));
        assert!(!binding.matches(user, &body, Uuid::new_v4(), 9, 1));
        assert!(!binding.matches(user, &body, media, 10, 1));
        for value in [
            None,
            Some(protocol::AdvancedPlaybackRequest {
                schema_version: 1,
                tone_map_hdr: false,
                subtitle_stream_index: Some(0),
            }),
            Some(protocol::AdvancedPlaybackRequest {
                schema_version: 1,
                tone_map_hdr: true,
                subtitle_stream_index: Some(7),
            }),
        ] {
            body.advanced_playback = value;
            assert!(!binding.matches(user, &body, media, 9, 1));
        }
        let mut legacy = serde_json::to_value(&binding).unwrap();
        legacy.as_object_mut().unwrap().remove("advanced_playback");
        let legacy: Binding = serde_json::from_value(legacy).unwrap();
        assert!(legacy.advanced_playback.is_none());
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("advanced_playback")
                .is_none()
        );
    }

    #[test]
    fn refused_mapping_is_unmarked_unbound_and_has_four_negative_decisions() {
        let meta = json!({"streams":[
            {"index":0,"codec_type":"video","disposition":{"attached_pic":1}},
            {"index":7,"codec_type":"video","disposition":{"attached_pic":0}}
        ]});
        let analysis =
            media_core::capabilities::analyze_legacy_mapped_source(&meta, None, 0.0).unwrap();
        let Json(set) = refused_legacy_mapping(analysis);
        assert!(set.http_file_capabilities_version.is_none());
        assert!(set.binding.is_none());
        assert!(set.candidates.is_empty());
        let decisions = set.route_decisions.unwrap();
        assert_eq!(decisions.len(), 4);
        assert!(decisions.iter().all(|decision| !decision.offered));
        assert!(
            decisions
                .iter()
                .all(|decision| decision.reason
                    == protocol::PlaybackRouteReason::TrackMappingRequired)
        );
    }

    #[test]
    fn mapping_probe_errors_are_distinct_from_hdr_and_invalid_audio() {
        let error = probe_error(anyhow::anyhow!("legacy_stream_mapping_unsupported"));
        assert_eq!(error.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.1, "legacy_stream_mapping_unsupported");
        assert_eq!(
            probe_error(anyhow::anyhow!("hdr_unsupported")).1,
            "hdr_unsupported"
        );
        assert_eq!(
            probe_error(anyhow::anyhow!("drm_unsupported")).1,
            "drm_unsupported"
        );
        let audio = probe_error(anyhow::anyhow!("invalid_audio_track"));
        assert_eq!(audio.0, StatusCode::BAD_REQUEST);
        assert_eq!(audio.1, "invalid_audio_track");
    }

    fn candidates() -> Vec<PlaybackCandidate> {
        media_core::capabilities::candidates(&json!({"format":{"format_name":"mov,mp4","tags":{"major_brand":"isom"},"bit_rate":"1000000"},
            "streams":[{"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","pix_fmt":"yuv420p","width":640,"height":360,
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
    #[test]
    fn configuration_facts_require_current_exact_candidate_equivalence() {
        let meta = json!({"format":{"format_name":"mp4","tags":{"major_brand":"isom"},"bit_rate":"1000000"},"streams":[
            {"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","pix_fmt":"yuv420p","width":640,"height":360,
             "avg_frame_rate":"25/1","r_frame_rate":"25/1","extradata":"\n00000000: 0164 000d ffe1 0000  ........\n"},
            {"index":1,"codec_type":"audio","codec_name":"aac","profile":"LC","channels":2,"sample_rate":"48000","bit_rate":"128000","extradata":"\n00000000: 1190  ..\n"}]});
        for candidate in media_core::capabilities::candidates(&meta, None, 0.0).unwrap() {
            let mut selection = Selection {
                candidate,
                source_version: Some("current".into()),
            };
            let facts = selected_output(&selection, &meta, None, 0.0).unwrap();
            use protocol::PlaybackOutputBasis::{ConstrainedEncoderRecipe, SourceProbe};
            assert_eq!(
                facts.video_basis,
                if selection.candidate.delivery_mode == "transcode" {
                    ConstrainedEncoderRecipe
                } else {
                    SourceProbe
                }
            );
            assert_eq!(
                facts.audio_basis,
                Some(
                    if matches!(
                        selection.candidate.delivery_mode.as_str(),
                        "transcode" | "audio_transcode"
                    ) {
                        ConstrainedEncoderRecipe
                    } else {
                        SourceProbe
                    }
                )
            );
            selection.candidate.video.width += 1;
            assert_eq!(
                selected_output(&selection, &meta, None, 0.0).unwrap_err().1,
                "source_changed"
            );
        }
    }

    fn agent_metadata() -> Value {
        json!({"capability_source_version":format!("stat-v1:{}", "0".repeat(64)),
        "format":{"format_name":"mp4","tags":{"major_brand":"isom"},"bit_rate":"1000000"},
        "streams":[
            {"index":7,"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1",
             "pix_fmt":"yuv420p","width":640,"height":360,"avg_frame_rate":"25/1","r_frame_rate":"25/1",
             "extradata":"\n00000000: 0164 000d ffe1 0000  ........\n","disposition":{"attached_pic":0}},
            {"index":0,"codec_type":"audio","codec_name":"aac","profile":"LC","channels":2,
             "sample_rate":"48000","bit_rate":"128000","extradata":"\n00000000: 1190  ..\n"}
        ]})
    }

    #[test]
    fn agent_configuration_facts_require_fresh_version_mapping_and_exact_candidate() {
        let meta = agent_metadata();
        for candidate in media_core::capabilities::candidates(&meta, None, 0.0).unwrap() {
            let mut selection = Selection {
                candidate,
                source_version: Some(meta["capability_source_version"].as_str().unwrap().into()),
            };
            assert!(
                selected_agent_output(&selection, &meta, None, 0.0, false)
                    .unwrap()
                    .is_none()
            );
            let facts = selected_agent_output(&selection, &meta, None, 0.0, true)
                .unwrap()
                .unwrap();
            use protocol::PlaybackOutputBasis::{ConstrainedEncoderRecipe, SourceProbe};
            assert_eq!(
                facts.video_basis,
                if selection.candidate.delivery_mode == "transcode" {
                    ConstrainedEncoderRecipe
                } else {
                    SourceProbe
                }
            );
            assert_eq!(
                facts.audio_basis,
                Some(
                    if matches!(
                        selection.candidate.delivery_mode.as_str(),
                        "transcode" | "audio_transcode"
                    ) {
                        ConstrainedEncoderRecipe
                    } else {
                        SourceProbe
                    }
                )
            );
            selection.candidate.video.width += 1;
            assert_eq!(
                selected_agent_output(&selection, &meta, None, 0.0, true)
                    .unwrap_err()
                    .1,
                "source_changed"
            );
        }
        let candidate = media_core::capabilities::candidates(&meta, None, 0.0)
            .unwrap()
            .remove(0);
        let mut selection = Selection {
            candidate,
            source_version: Some(format!("stat-v1:{}", "1".repeat(64))),
        };
        assert_eq!(
            selected_agent_output(&selection, &meta, None, 0.0, true)
                .unwrap_err()
                .1,
            "source_changed"
        );
        selection.source_version = None;
        assert_eq!(
            selected_agent_output(&selection, &meta, None, 0.0, true)
                .unwrap_err()
                .1,
            "source_changed"
        );
    }

    #[test]
    fn agent_generated_provenance_refuses_fixed_output_with_changed_mapping() {
        let meta = agent_metadata();
        let selection = Selection {
            candidate: media_core::capabilities::candidates(&meta, None, 0.0)
                .unwrap()
                .into_iter()
                .find(|candidate| candidate.id == "transcode_720p")
                .unwrap(),
            source_version: Some(meta["capability_source_version"].as_str().unwrap().into()),
        };
        let mut cover_first = meta.clone();
        cover_first["streams"].as_array_mut().unwrap().insert(0,
            json!({"index":1,"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}));
        let mut reordered_audio = meta.clone();
        let mut alternate_audio = reordered_audio["streams"][1].clone();
        alternate_audio["index"] = json!(12);
        reordered_audio["streams"]
            .as_array_mut()
            .unwrap()
            .insert(1, alternate_audio);
        let mut incomplete = meta.clone();
        incomplete["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("index");
        let mut ambiguous = meta.clone();
        ambiguous["streams"]
            .as_array_mut()
            .unwrap()
            .push(json!({"index":0,"codec_type":"data"}));
        for invalid in [cover_first, reordered_audio, incomplete, ambiguous] {
            assert_eq!(
                selected_agent_output(&selection, &invalid, None, 0.0, true)
                    .unwrap_err()
                    .1,
                "legacy_stream_mapping_unsupported"
            );
        }
    }

    #[test]
    fn agent_unproven_original_direct_omits_provenance_and_explicit_audio_keeps_zero() {
        let meta = agent_metadata();
        let direct = Selection {
            candidate: media_core::capabilities::candidates(&meta, None, 0.0)
                .unwrap()
                .remove(0),
            source_version: Some(meta["capability_source_version"].as_str().unwrap().into()),
        };
        let mut incomplete = meta.clone();
        incomplete["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("disposition");
        assert!(
            selected_agent_output(&direct, &incomplete, None, 0.0, true)
                .unwrap()
                .is_none()
        );
        let alternate = Selection {
            candidate: media_core::capabilities::candidates(&meta, Some(0), 0.0)
                .unwrap()
                .remove(0),
            source_version: direct.source_version.clone(),
        };
        assert!(
            selected_agent_output(&alternate, &meta, Some(0), 0.0, true)
                .unwrap()
                .is_some()
        );
        let mut no_audio = meta;
        no_audio["streams"]
            .as_array_mut()
            .unwrap()
            .retain(|stream| stream["codec_type"] != "audio");
        let selection = Selection {
            candidate: media_core::capabilities::candidates(&no_audio, None, 0.0)
                .unwrap()
                .remove(0),
            source_version: direct.source_version,
        };
        assert!(
            selected_agent_output(&selection, &no_audio, None, 0.0, true)
                .unwrap()
                .unwrap()
                .audio_basis
                .is_none()
        );
    }
    #[test]
    fn hevc_passthrough_still_requires_concrete_file_decode_estimate() {
        let mut candidate = candidates().remove(0);
        candidate.content_type = "video/mp4; codecs=\"hvc1.1.6.L93.B0\"".into();
        candidate.video.content_type = candidate.content_type.clone();
        let body = body();
        let caps = body.capabilities.as_ref().unwrap();
        let mut result = body.candidate_report.as_ref().unwrap().results[0].clone();
        assert!(playable(&candidate, &result, caps));
        result.file_decoding = None;
        assert!(!playable(&candidate, &result, caps));
        result.file_decoding = Some(protocol::MediaDecodingSupport {
            supported: false,
            smooth: true,
            power_efficient: true,
        });
        assert!(!playable(&candidate, &result, caps));
    }
}
