//! Explicit upstream transcode envelopes are metadata observations and sample
//! probes. They never claim to describe exact encoded bytes or a stable input.
use super::*;
use providers::upstream_profiles::{
    EMBY_AUDIO_RATES, EMBY_PROFILE_ID, PROFILE_ID, UpstreamProfileMetadata, profile_identity,
};
use serde::Serialize;
use sqlx::{Connection, Postgres, pool::PoolConnection};

const PURPOSE: &str = "upstream_transcode_profile_envelope_v1";
const MAX_BINDING_BYTES: usize = 8192;
const TTL_MS: i64 = 300_000;

/// Cancelling a preflight query closes its connection instead of leaving a
/// pool slot waiting for ReadyForQuery. Successful reads return it normally.
struct PreflightDatabase(Option<PoolConnection<Postgres>>);

impl Drop for PreflightDatabase {
    fn drop(&mut self) {
        if let Some(connection) = &mut self.0 {
            connection.close_on_drop();
        }
    }
}

impl PreflightDatabase {
    async fn acquire(pool: &PgPool) -> Result<Self> {
        Ok(Self(Some(pool.acquire().await?)))
    }

    async fn transaction(&mut self) -> Result<sqlx::Transaction<'_, Postgres>> {
        let mut tx = self.0.as_mut().expect("preflight database").begin().await?;
        sqlx::query("SELECT set_config('statement_timeout','750ms',true),set_config('lock_timeout','250ms',true)")
            .execute(&mut *tx).await?;
        Ok(tx)
    }

    fn release(&mut self) {
        drop(self.0.take());
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    user: Uuid,
    room: Uuid,
    membership_epoch: Uuid,
    login_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    purpose: String,
    profile_version: u32,
    profile_id: String,
    identity: Identity,
    lifecycle_epoch: i64,
    media: Uuid,
    media_generation: u32,
    source: Uuid,
    source_revision: i64,
    account_generation: i64,
    kind: String,
    item: String,
    requested_audio: Option<u32>,
    metadata: UpstreamProfileMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile_envelope: Option<Value>,
    issued_at_ms: i64,
    expires_at_ms: i64,
}

#[derive(Clone)]
pub struct Selection {
    binding: Binding,
    pub metadata: UpstreamProfileMetadata,
}

impl Selection {
    pub fn requested_audio(&self) -> Option<u32> {
        self.binding.requested_audio
    }
}

pub struct Scope<'a> {
    pub media: Uuid,
    pub source: Uuid,
    pub source_revision: i64,
    pub account_generation: Option<i64>,
    pub kind: &'a str,
    pub item: &'a str,
    pub login_hash: Option<&'a str>,
}

pub fn envelope(
    kind: &str,
    metadata: &UpstreamProfileMetadata,
) -> Result<protocol::UpstreamTranscodeProfileEnvelope> {
    providers::upstream_profiles::validate_profile_metadata(kind, metadata)
        .map_err(|_| invalid_report())?;
    let evidence = providers::upstream_profiles::evidence(kind, metadata);
    Ok(protocol::UpstreamTranscodeProfileEnvelope {
        profile_version: evidence.profile_version,
        profile_id: evidence.profile_id,
        configuration_semantics:
            protocol::UpstreamProfileSemantics::UpstreamTranscodeProfileEnvelope,
        transport: "hls".into(),
        container: "ts".into(),
        requested_video: protocol::UpstreamVideoProfileBounds {
            codec: evidence.video_codec,
            profile: evidence.video_profile,
            max_level: evidence.max_video_level,
            max_width: evidence.max_width,
            max_height: evidence.max_height,
            max_framerate: evidence.max_frame_rate,
            max_bitrate: evidence.max_video_bit_rate,
            requested_bit_depth: 8,
            requested_range: evidence.video_range,
        },
        requested_audio: metadata
            .audio
            .as_ref()
            .map(|_| protocol::UpstreamAudioProfileBounds {
                codec: "aac".into(),
                max_channels: 2,
                requested_sample_rate: 48_000,
                max_bitrate: 128_000,
            }),
        audio_rate_contract: if kind == "emby" {
            metadata
                .audio
                .as_ref()
                .map(|audio| protocol::UpstreamAudioRateContract {
                    allowed_sample_rates: EMBY_AUDIO_RATES.to_vec(),
                    source_sample_rate: audio.sample_rate,
                    mse_samples: EMBY_AUDIO_RATES
                        .iter()
                        .map(|rate| protocol::AudioCapabilityConfiguration {
                            content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
                            channels: "2".into(),
                            bitrate: 128_000,
                            samplerate: *rate,
                        })
                        .collect(),
                })
        } else {
            None
        },
        mse_sample: protocol::UpstreamProfileProbeSample {
            video: protocol::VideoCapabilityConfiguration {
                content_type: "video/mp4; codecs=\"avc1.4d001f\"".into(),
                width: 1280,
                height: 720,
                bitrate: 4_000_000,
                framerate: 30.0,
            },
            // AAC-LC is a finite browser estimate. The requested output above
            // promises only the AAC family because product support varies.
            audio: metadata
                .audio
                .as_ref()
                .map(|_| protocol::AudioCapabilityConfiguration {
                    content_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
                    channels: "2".into(),
                    bitrate: 128_000,
                    samplerate: 48_000,
                }),
        },
    })
}

pub async fn candidates(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<protocol::UpstreamProfileCandidateRequest>,
) -> Result<Json<protocol::UpstreamProfileCandidateSet>> {
    let user = auth(&app, &headers, true).await?;
    member(&app, &user, body.room_id).await?;
    if !matches!(body.profile_version, 1 | 2) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    if !body.position_ms.is_finite() || body.position_ms < 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    let login_hash = cookie(&headers)
        .map(|cookie| hash(&cookie))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?;
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    // The metadata discovery has its own durable preparation and is retained
    // across an HTTP disconnect. It never calls PlaybackInfo or owns a SID.
    tokio::spawn(async move {
        let request: protocol::PlaybackRequest = serde_json::from_value(json!({
            "idempotency_key": Uuid::new_v4(), "room_id":body.room_id,
            "media_generation":body.media_generation, "mode":"capability_probe",
            "position_ms":body.position_ms, "audio_index":body.audio_index,
        })).map_err(anyhow::Error::from)?;
        let reservation = match playback_requests::begin_authenticated(
            &app, user.id, &request, Some(&login_hash),
        ).await? {
            playback_requests::Start::Reserved(reservation) => reservation,
            playback_requests::Start::Replay(_) => {
                return Err(err(StatusCode::CONFLICT, "playback_request_conflict"));
            }
        };
        let result = tokio::select! {
            biased;
            _ = owner.cancelled() => Err(err(StatusCode::SERVICE_UNAVAILABLE, "playback_request_interrupted")),
            result = tokio::time::timeout(
                std::time::Duration::from_secs(25),
                preflight(&app, &user, &body, &reservation, &login_hash),
            ) => result.unwrap_or_else(|_| Err(err(StatusCode::GATEWAY_TIMEOUT, "playback_request_interrupted"))),
        };
        let cleanup = playback_requests::fail(
            &app, &reservation, &err(StatusCode::GONE, "playback_request_cancelled"),
        ).await;
        tokio::spawn(async move { owner.acknowledge(&app, &reservation).await; });
        cleanup?;
        result
    }).await.map_err(anyhow::Error::from)?
}

async fn preflight(
    app: &App,
    user: &User,
    body: &protocol::UpstreamProfileCandidateRequest,
    reservation: &playback_requests::Reservation,
    login_hash: &str,
) -> Result<Json<protocol::UpstreamProfileCandidateSet>> {
    let mut database = PreflightDatabase::acquire(&app.db).await?;
    let mut tx = database.transaction().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let state: protocol::RoomState = serde_json::from_value(
        sqlx::query_scalar::<_, Value>("SELECT state FROM room_snapshots WHERE room_id=$1")
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?,
    )
    .map_err(anyhow::Error::from)?;
    if state.media_generation != body.media_generation {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let media = state
        .media_id
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "no_media"))?;
    let row = sqlx::query("SELECT m.source_id,m.resource,s.kind,s.config_encrypted,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available")
        .bind(media).fetch_optional(&mut *tx).await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    let kind: String = row.get("kind");
    if !matches!(kind.as_str(), "jellyfin" | "emby") {
        tx.commit().await?;
        database.release();
        return Ok(Json(protocol::UpstreamProfileCandidateSet {
            profile_version: 1,
            binding: None,
            profile: None,
            decision_reason: "provider_requires_legacy_negotiation".into(),
        }));
    }
    if kind == "emby" && body.profile_version < 2 {
        return Err(invalid_report());
    }
    let source: Uuid = row.get("source_id");
    let source_revision: i64 = row.get("access_policy_revision");
    let item: String = row.get("resource");
    let config: providers::SourceConfig =
        serde_json::from_value(app.decrypt(&row.get::<String, _>("config_encrypted"))?)
            .map_err(anyhow::Error::from)?;
    let identity = capture_identity(&mut tx, user.id, body.room_id, login_hash).await?;
    source_access::guard(&mut tx, source, source_revision).await?;
    tx.commit().await?;
    database.release();
    let account_generation = upstream_policy::ensure(app, source, source_revision).await?;
    let mut database = PreflightDatabase::acquire(&app.db).await?;
    let mut tx = database.transaction().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    if capture_identity(&mut tx, user.id, body.room_id, login_hash).await? != identity {
        return Err(invalid_report());
    }
    source_access::guard(&mut tx, source, source_revision).await?;
    upstream_policy::guard(&mut tx, source, source_revision, Some(account_generation)).await?;
    tx.commit().await?;
    database.release();
    let metadata = upstream::profile_metadata(
        app,
        &kind,
        &config,
        &item,
        body.audio_index,
        &format!("rainsync-{}", reservation.session),
    )
    .await?;
    let mut database = PreflightDatabase::acquire(&app.db).await?;
    let mut tx = database.transaction().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let issued_at_ms = clock_ms(&mut tx).await?;
    let profile = envelope(&kind, &metadata)?;
    let binding = Binding {
        purpose: PURPOSE.into(),
        profile_version: u32::from(profile.profile_version),
        profile_id: profile.profile_id.clone(),
        profile_envelope: if kind == "emby" {
            Some(serde_json::to_value(&profile).map_err(anyhow::Error::from)?)
        } else {
            None
        },
        identity,
        lifecycle_epoch: reservation.lifecycle_epoch,
        media,
        media_generation: body.media_generation,
        source,
        source_revision,
        account_generation,
        kind,
        item,
        requested_audio: body.audio_index,
        metadata: metadata.clone(),
        issued_at_ms,
        expires_at_ms: issued_at_ms
            .checked_add(TTL_MS)
            .ok_or_else(invalid_report)?,
    };
    let selection = Selection { binding, metadata };
    guard(app, &mut tx, reservation, &selection).await?;
    let encrypted =
        app.encrypt(&serde_json::to_value(&selection.binding).map_err(anyhow::Error::from)?)?;
    if encrypted.len() > MAX_BINDING_BYTES {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "upstream_device_profile_required",
        ));
    }
    let profile = envelope(&selection.binding.kind, &selection.metadata)?;
    tx.commit().await?;
    database.release();
    Ok(Json(protocol::UpstreamProfileCandidateSet {
        profile_version: profile.profile_version,
        binding: Some(encrypted),
        profile: Some(profile),
        decision_reason: "observed_metadata_and_requested_upstream_profile_envelope".into(),
    }))
}

fn invalid_report() -> Error {
    err(StatusCode::CONFLICT, "stale_capability_report")
}

/// A marked request may never silently enter the legacy negotiation path.
pub fn validate_request(body: &protocol::PlaybackRequest, profile_endpoint: bool) -> Result<()> {
    match (&body.upstream_profile_report, profile_endpoint) {
        (None, false) => Ok(()),
        (Some(report), true) => {
            if !matches!(
                (report.profile_version, report.profile_id.as_str()),
                (1, PROFILE_ID) | (2, EMBY_PROFILE_ID)
            ) || report.binding.is_empty()
                || report.binding.len() > MAX_BINDING_BYTES
                || body.mode.as_deref() != Some("transcode")
                || body.candidate_report.is_some()
                || body.http_file_fallback.is_some()
            {
                return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
            }
            if !report.mse_supported
                || !report
                    .mse_decoding
                    .as_ref()
                    .is_some_and(|sample| sample.supported)
            {
                return Err(err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "device_has_no_compatible_playback_transport",
                ));
            }
            if report.profile_version == 1 && report.audio_rate_reports.is_some() {
                return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
            }
            if report.profile_version == 2 {
                let reports = report
                    .audio_rate_reports
                    .as_ref()
                    .ok_or_else(invalid_report)?;
                if !reports.is_empty()
                    && (reports.len() != 2
                        || reports.iter().zip(EMBY_AUDIO_RATES).any(|(sample, rate)| {
                            sample.sample_rate != rate
                                || !sample.mse_supported
                                || !sample
                                    .mse_decoding
                                    .as_ref()
                                    .is_some_and(|value| value.supported)
                        }))
                {
                    return Err(invalid_report());
                }
            }
            Ok(())
        }
        _ => Err(err(StatusCode::BAD_REQUEST, "invalid_request")),
    }
}

fn valid_login_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

async fn capture_identity(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    room: Uuid,
    login_hash: &str,
) -> Result<Identity> {
    if !valid_login_hash(login_hash) {
        return Err(invalid_report());
    }
    let membership_epoch: Uuid = sqlx::query_scalar(
        "SELECT membership_epoch FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(room)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(invalid_report)?;
    let login: Option<String> = sqlx::query_scalar(
        "SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR KEY SHARE",
    )
    .bind(login_hash)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?;
    // Evaluate expiry after both identity locks have been acquired.
    let current: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp())",
    )
    .bind(login_hash)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if login.is_none() || !current {
        return Err(invalid_report());
    }
    Ok(Identity {
        user,
        room,
        membership_epoch,
        login_hash: login_hash.into(),
    })
}

async fn clock_ms(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut **tx)
            .await?,
    )
}

fn bounded_contract(binding: &Binding) -> bool {
    binding.purpose == PURPOSE
        && binding.profile_version == u32::from(profile_identity(&binding.kind).0)
        && binding.profile_id == profile_identity(&binding.kind).1
        && match envelope(&binding.kind, &binding.metadata) {
            Ok(profile) if binding.kind == "emby" => {
                serde_json::to_value(profile).ok().as_ref() == binding.profile_envelope.as_ref()
            }
            Ok(_) => binding.profile_envelope.is_none(),
            Err(_) => false,
        }
        && binding
            .expires_at_ms
            .checked_sub(binding.issued_at_ms)
            .is_some_and(|ttl| (1..=TTL_MS).contains(&ttl))
}

fn report_matches_binding(report: &protocol::UpstreamProfileReport, binding: &Binding) -> bool {
    report.profile_version as u32 == binding.profile_version
        && if binding.kind == "emby" {
            report.audio_rate_reports.as_ref().is_some_and(|reports| {
                let rates: &[u32] = if binding.metadata.audio.is_some() {
                    &EMBY_AUDIO_RATES
                } else {
                    &[]
                };
                reports.len() == rates.len()
                    && reports.iter().zip(rates).all(|(sample, rate)| {
                        sample.sample_rate == *rate
                            && sample.mse_supported
                            && sample
                                .mse_decoding
                                .as_ref()
                                .is_some_and(|value| value.supported)
                    })
            })
        } else {
            report.audio_rate_reports.is_none()
        }
}

fn current(binding: &Binding, now: i64) -> bool {
    bounded_contract(binding) && binding.issued_at_ms <= now && binding.expires_at_ms > now
}

/// A binding's five-minute deadline admits a new preparation. Once published,
/// replay instead follows that exact session's existing lifetime, while still
/// requiring the same current login/member identity and source/account scope.
pub async fn guard_replay(
    app: &App,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    login_hash: Option<&str>,
    plan: &Value,
) -> Result<()> {
    let Some(report) = &body.upstream_profile_report else {
        return Ok(());
    };
    validate_request(body, true)?;
    let binding: Binding =
        serde_json::from_value(app.decrypt(&report.binding).map_err(|_| invalid_report())?)
            .map_err(|_| invalid_report())?;
    let session = plan["session_id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(invalid_report)?;
    let key = body.idempotency_key.ok_or_else(invalid_report)?;
    if !bounded_contract(&binding)
        || binding.identity.user != user
        || binding.identity.room != body.room_id
        || login_hash != Some(binding.identity.login_hash.as_str())
        || binding.media_generation != body.media_generation
        || binding.requested_audio != body.audio_index
        || !report_matches_binding(report, &binding)
        || report.profile_id != binding.profile_id
        || plan["media_id"].as_str() != Some(binding.media.to_string().as_str())
        || plan["media_generation"].as_u64() != Some(u64::from(binding.media_generation))
        || plan["delivery_mode"] != "transcode"
        || plan["transport"] != "hls"
        || plan["upstream_profile"]
            != serde_json::to_value(envelope(&binding.kind, &binding.metadata)?)
                .map_err(anyhow::Error::from)?
    {
        return Err(invalid_report());
    }
    let mut tx = app.db.begin().await?;
    let epoch = persistence::room_lifecycle::lock_active(&mut tx, body.room_id)
        .await
        .map_err(|error| match error.to_string().as_str() {
            "room_not_active" => err(StatusCode::CONFLICT, "room_not_active"),
            _ => error.into(),
        })?;
    let state: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(body.room_id)
            .fetch_one(&mut *tx)
            .await?;
    if epoch != binding.lifecycle_epoch
        || state["media_id"].as_str() != Some(binding.media.to_string().as_str())
        || state["media_generation"].as_u64() != Some(u64::from(binding.media_generation))
        || capture_identity(&mut tx, user, body.room_id, &binding.identity.login_hash).await?
            != binding.identity
    {
        return Err(invalid_report());
    }
    source_access::guard(&mut tx, binding.source, binding.source_revision).await?;
    upstream_policy::guard(
        &mut tx,
        binding.source,
        binding.source_revision,
        Some(binding.account_generation),
    )
    .await?;
    let row = sqlx::query("SELECT p.resource,p.media_id,p.user_id,p.room_id,p.generation,p.lifecycle_epoch,m.source_id,m.resource AS item,s.kind FROM playback_sessions p JOIN media_items m ON m.id=p.media_id JOIN sources s ON s.id=m.source_id WHERE p.id=$1 FOR SHARE OF p")
        .bind(session).fetch_optional(&mut *tx).await?.ok_or_else(invalid_report)?;
    let resource: Value = row.get("resource");
    let inner = app
        .decrypt(resource["encrypted"].as_str().ok_or_else(invalid_report)?)
        .map_err(|_| invalid_report())?;
    if row.get::<Uuid, _>("user_id") != user
        || row.get::<Uuid, _>("room_id") != body.room_id
        || row.get::<Uuid, _>("media_id") != binding.media
        || row.get::<i64, _>("generation") != i64::from(binding.media_generation)
        || row.get::<i64, _>("lifecycle_epoch") != binding.lifecycle_epoch
        || row.get::<Uuid, _>("source_id") != binding.source
        || row.get::<String, _>("item") != binding.item
        || row.get::<String, _>("kind") != binding.kind
        || resource["source_policy_revision"].as_i64() != Some(binding.source_revision)
        || resource["account_policy_generation"].as_i64() != Some(binding.account_generation)
        || inner["source_id"].as_str() != Some(binding.source.to_string().as_str())
        || inner["kind"] != binding.kind
        || inner["resource"] != binding.item
        || inner["upstream_media_source"] != binding.metadata.media_source_id
        || inner["upstream_profile_binding_hash"].as_str() != Some(hash(&report.binding).as_str())
        || inner["delivery_mode"] != "transcode"
        || inner["transport"] != "hls"
    {
        return Err(invalid_report());
    }
    // Replay the deterministic request completion from the original checkpoint,
    // never from the already-completed URL. No network or second SID is created.
    let checkpoint = sqlx::query("SELECT response_encrypted,scope_encrypted,device_id,play_session_id,media_source_id FROM upstream_reservations WHERE id=$1 AND user_id=$2 AND request_key=$3 AND source_id=$4 AND state='active' AND negotiation='received'")
        .bind(session).bind(user).bind(key).bind(binding.source)
        .fetch_optional(&mut *tx).await?.ok_or_else(invalid_report)?;
    let original = app
        .decrypt(
            checkpoint
                .get::<Option<String>, _>("response_encrypted")
                .as_deref()
                .ok_or_else(invalid_report)?,
        )
        .map_err(|_| invalid_report())?;
    let scope = app
        .decrypt(&checkpoint.get::<String, _>("scope_encrypted"))
        .map_err(|_| invalid_report())?;
    let config: providers::SourceConfig =
        serde_json::from_value(scope["config"].clone()).map_err(|_| invalid_report())?;
    let device = checkpoint.get::<String, _>("device_id");
    if scope["item"] != binding.item
        || device != format!("rainsync-{session}")
        || checkpoint
            .get::<Option<String>, _>("play_session_id")
            .as_deref()
            != original["PlaySessionId"].as_str()
        || checkpoint
            .get::<Option<String>, _>("media_source_id")
            .as_deref()
            != Some(binding.metadata.media_source_id.as_str())
    {
        return Err(invalid_report());
    }
    let expected = providers::upstream_profiles::complete_route(
        &binding.kind,
        &config,
        &binding.metadata,
        &original,
        &device,
    )
    .map_err(|_| invalid_report())?;
    let completion = expected
        .provenance
        .server_requested_audio_sample_rate
        .is_some();
    let persisted = &inner["upstream_profile_route_provenance"];
    // Pre-upgrade echoed-rate grants may lack this new diagnostic field; no
    // pre-upgrade grant could have used the newly authorized absent-only path.
    if inner["url"].as_str() != Some(expected.url.as_str())
        || inner["upstream_device"] != device
        || inner["upstream_session"] != original["PlaySessionId"]
        || ((!persisted.is_null() || completion || binding.kind == "emby")
            && *persisted != json!(expected.provenance))
        || (plan["decision_reason"] == "emby_server_requested_audio_sample_rate_48000")
            != completion
    {
        return Err(invalid_report());
    }
    // Re-evaluate clock expiry, exact membership and actual grant association
    // after the contended session lock. A valid context is not any-grant access.
    let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id JOIN room_members m ON m.room_id=p.room_id AND m.user_id=p.user_id JOIN sessions login ON login.user_id=p.user_id WHERE p.id=$1 AND p.user_id=$2 AND p.room_id=$3 AND p.media_id=$4 AND p.lifecycle_epoch=$5 AND p.generation=$6 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_source_allowed(p.media_id,p.resource) AND r.user_id=$2 AND r.idempotency_key=$7 AND r.status='completed' AND m.membership_epoch=$8 AND login.token_hash=$9 AND login.expires_at>clock_timestamp() AND $10::bigint<=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint)")
        .bind(session).bind(user).bind(body.room_id).bind(binding.media).bind(binding.lifecycle_epoch)
        .bind(i64::from(binding.media_generation)).bind(key).bind(binding.identity.membership_epoch)
        .bind(&binding.identity.login_hash).bind(binding.issued_at_ms).fetch_one(&mut *tx).await?;
    if !valid {
        return Err(invalid_report());
    }
    tx.commit().await?;
    Ok(())
}

pub async fn select(
    app: &App,
    body: &protocol::PlaybackRequest,
    reservation: &playback_requests::Reservation,
    scope: Scope<'_>,
) -> Result<Option<Selection>> {
    let Some(report) = &body.upstream_profile_report else {
        return Ok(None);
    };
    validate_request(body, true)?;
    let binding: Binding =
        serde_json::from_value(app.decrypt(&report.binding).map_err(|_| invalid_report())?)
            .map_err(|_| invalid_report())?;
    providers::upstream_profiles::validate_metadata_proof(&binding.metadata)
        .map_err(|_| invalid_report())?;
    if binding.identity.user != reservation.user
        || binding.identity.room != body.room_id
        || scope.login_hash != Some(binding.identity.login_hash.as_str())
        || binding.lifecycle_epoch != reservation.lifecycle_epoch
        || binding.media != scope.media
        || binding.media_generation != body.media_generation
        || binding.source != scope.source
        || binding.source_revision != scope.source_revision
        || Some(binding.account_generation) != scope.account_generation
        || binding.kind != scope.kind
        || binding.item != scope.item
        || binding.requested_audio != body.audio_index
        || !report_matches_binding(report, &binding)
        || report.profile_id != binding.profile_id
        || !matches!(scope.kind, "jellyfin" | "emby")
    {
        return Err(invalid_report());
    }
    let selection = Selection {
        metadata: binding.metadata.clone(),
        binding,
    };
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    guard(app, &mut tx, reservation, &selection).await?;
    tx.commit().await?;
    Ok(Some(selection))
}

/// Caller first holds the reservation's room/snapshot locks. Identity locks
/// precede source/account locks and never span upstream network I/O.
pub async fn guard(
    _app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    reservation: &playback_requests::Reservation,
    selection: &Selection,
) -> Result<()> {
    let binding = &selection.binding;
    if binding.identity.user != reservation.user
        || binding.identity.room != reservation.room_id
        || binding.lifecycle_epoch != reservation.lifecycle_epoch
        || selection.metadata != binding.metadata
        || capture_identity(
            tx,
            binding.identity.user,
            binding.identity.room,
            &binding.identity.login_hash,
        )
        .await?
            != binding.identity
        || !current(binding, clock_ms(tx).await?)
    {
        return Err(invalid_report());
    }
    source_access::guard(tx, binding.source, binding.source_revision).await?;
    upstream_policy::guard(
        tx,
        binding.source,
        binding.source_revision,
        Some(binding.account_generation),
    )
    .await?;
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_items m JOIN sources s ON s.id=m.source_id JOIN room_snapshots r ON r.room_id=$1 WHERE m.id=$2 AND m.available AND m.source_id=$3 AND m.resource=$4 AND s.kind=$5 AND s.access_policy_revision=$6 AND r.state->>'media_id'=$7 AND (r.state->>'media_generation')::bigint=$8)",
    )
    .bind(binding.identity.room).bind(binding.media).bind(binding.source).bind(&binding.item)
    .bind(&binding.kind).bind(binding.source_revision).bind(binding.media.to_string())
    .bind(i64::from(binding.media_generation)).fetch_one(&mut **tx).await?;
    if !valid {
        return Err(invalid_report());
    }
    // Source/account locks may have contended after identity capture. Expiry
    // and all wall-clock authorization evidence are checked again afterwards.
    let current: bool = sqlx::query_scalar(
        "SELECT $1::bigint>FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=$2 AND user_id=$3 AND expires_at>clock_timestamp()) AND source_account_policy_allowed($4,$5,$6) AND EXISTS(SELECT 1 FROM room_members WHERE room_id=$7 AND user_id=$3 AND membership_epoch=$8)",
    )
    .bind(binding.expires_at_ms).bind(&binding.identity.login_hash).bind(binding.identity.user)
    .bind(binding.source).bind(binding.source_revision).bind(binding.account_generation)
    .bind(binding.identity.room).bind(binding.identity.membership_epoch)
    .fetch_one(&mut **tx).await?;
    if !current {
        return Err(invalid_report());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> protocol::PlaybackRequest {
        serde_json::from_value(json!({
            "room_id":Uuid::nil(), "media_generation":1, "mode":"transcode",
            "capabilities":{"progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":true},
            "upstream_profile_report":{
                "profile_version":1,"binding":"encrypted","profile_id":PROFILE_ID,
                "mse_supported":true,
                "mse_decoding":{"supported":true,"smooth":true,"power_efficient":false}
            }
        }))
        .unwrap()
    }

    fn metadata() -> UpstreamProfileMetadata {
        serde_json::from_value(json!({
            "item_id":"item", "media_source_id":"source", "runtime_ticks":10_000_000,
            "video":{"index":0,"codec":"h264","width":640,"height":360,
                "frame_rate":24.0,"bit_depth":8,"bit_rate":1_000_000,
                "profile":"main","level":31.0,"range":"SDR","color_transfer":"bt709"},
            "audio":{"index":1,"codec":"aac","channels":2,"sample_rate":48000,
                "bit_rate":128000,"profile":"lc"}
        }))
        .unwrap()
    }

    fn binding() -> Binding {
        Binding {
            purpose: PURPOSE.into(),
            profile_version: 1,
            profile_id: PROFILE_ID.into(),
            identity: Identity {
                user: Uuid::nil(),
                room: Uuid::nil(),
                membership_epoch: Uuid::from_u128(1),
                login_hash: "ab".repeat(32),
            },
            lifecycle_epoch: 1,
            media: Uuid::nil(),
            media_generation: 1,
            source: Uuid::nil(),
            source_revision: 2,
            account_generation: 3,
            kind: "jellyfin".into(),
            item: "item".into(),
            requested_audio: None,
            metadata: metadata(),
            profile_envelope: None,
            issued_at_ms: 1000,
            expires_at_ms: 1000 + TTL_MS,
        }
    }

    #[test]
    fn marked_profile_requires_positive_path_specific_mse_without_native_fallback() {
        let mut body = request();
        assert!(validate_request(&body, true).is_ok());
        assert!(validate_request(&body, false).is_err());
        body.upstream_profile_report.as_mut().unwrap().mse_supported = false;
        assert_eq!(
            validate_request(&body, true).unwrap_err().1,
            "device_has_no_compatible_playback_transport"
        );
        body.upstream_profile_report.as_mut().unwrap().mse_supported = true;
        body.upstream_profile_report
            .as_mut()
            .unwrap()
            .mse_decoding
            .as_mut()
            .unwrap()
            .supported = false;
        assert!(validate_request(&body, true).is_err());
        body.upstream_profile_report.as_mut().unwrap().mse_decoding = None;
        assert!(validate_request(&body, true).is_err());
    }

    #[test]
    fn missing_unknown_or_mixed_profile_requests_never_enter_legacy_admission() {
        let mut body = request();
        body.upstream_profile_report
            .as_mut()
            .unwrap()
            .profile_version = 2;
        assert!(validate_request(&body, true).is_err());
        body.upstream_profile_report
            .as_mut()
            .unwrap()
            .profile_version = 1;
        body.upstream_profile_report.as_mut().unwrap().profile_id = "caller_recipe".into();
        assert!(validate_request(&body, true).is_err());
        body.upstream_profile_report.as_mut().unwrap().profile_id = PROFILE_ID.into();
        body.upstream_profile_report.as_mut().unwrap().binding = "x".repeat(MAX_BINDING_BYTES + 1);
        assert!(validate_request(&body, true).is_err());
        body.upstream_profile_report.as_mut().unwrap().binding = "encrypted".into();
        for mode in ["auto", "direct", "remux"] {
            body.mode = Some(mode.into());
            assert!(validate_request(&body, true).is_err());
        }
        body.mode = Some("transcode".into());
        body.candidate_report = Some(protocol::PlaybackCandidateReport {
            binding: "exact".into(),
            results: vec![],
            excluded_candidates: vec![],
        });
        assert!(validate_request(&body, true).is_err());
        body.candidate_report = None;
        body.upstream_profile_report = None;
        assert!(validate_request(&body, true).is_err());
        assert!(validate_request(&body, false).is_ok());
    }

    #[test]
    fn bindings_are_purpose_separated_and_expire_within_five_minutes() {
        let mut proof = binding();
        assert!(current(&proof, 1000));
        assert!(current(&proof, proof.expires_at_ms - 1));
        assert!(!current(&proof, proof.expires_at_ms));
        assert!(!current(&proof, proof.issued_at_ms - 1));
        proof.expires_at_ms += 1;
        assert!(!current(&proof, 1000));
        proof.expires_at_ms -= 1;
        proof.purpose = "actual_media_capabilities_v1".into();
        assert!(!current(&proof, 1000));
        proof.purpose = PURPOSE.into();
        proof.profile_version = 2;
        assert!(!current(&proof, 1000));
        let mut value = serde_json::to_value(binding()).unwrap();
        value["immutable_content_digest"] = json!("not-authority");
        assert!(serde_json::from_value::<Binding>(value).is_err());
    }

    #[test]
    fn envelope_preserves_requested_bounds_and_advisory_sample_as_separate_fields() {
        let mut observed = metadata();
        let profile = envelope("jellyfin", &observed).unwrap();
        assert_eq!(profile.requested_video.profile, "main");
        assert_eq!(profile.requested_video.max_width, 1280);
        assert_eq!(profile.requested_video.max_height, 720);
        assert_eq!(profile.requested_video.max_framerate, 30);
        assert_eq!(
            profile.mse_sample.video.content_type,
            "video/mp4; codecs=\"avc1.4d001f\""
        );
        assert_eq!(profile.requested_audio.unwrap().codec, "aac");
        assert!(
            profile
                .mse_sample
                .audio
                .unwrap()
                .content_type
                .contains("mp4a.40.2")
        );
        observed.audio = None;
        let silent = envelope("jellyfin", &observed).unwrap();
        assert!(silent.requested_audio.is_none());
        assert!(silent.mse_sample.audio.is_none());
        assert!(valid_login_hash(&"ab".repeat(32)));
        assert!(!valid_login_hash(&"AB".repeat(32)));
    }
    #[test]
    fn emby_v2_binds_full_discrete_contract_and_requires_every_rate() {
        let mut proof = binding();
        proof.kind = "emby".into();
        proof.profile_version = 2;
        proof.profile_id = EMBY_PROFILE_ID.into();
        proof.profile_envelope = Some(json!(envelope("emby", &proof.metadata).unwrap()));
        assert!(bounded_contract(&proof));
        let mut body = request();
        let report = body.upstream_profile_report.as_mut().unwrap();
        report.profile_version = 2;
        report.profile_id = EMBY_PROFILE_ID.into();
        report.audio_rate_reports = Some(
            EMBY_AUDIO_RATES
                .iter()
                .map(|rate| protocol::UpstreamAudioRateReport {
                    sample_rate: *rate,
                    mse_supported: true,
                    mse_decoding: report.mse_decoding.clone(),
                })
                .collect(),
        );
        assert!(report_matches_binding(report, &proof));
        report.audio_rate_reports.as_mut().unwrap().reverse();
        assert!(!report_matches_binding(report, &proof));
        report.audio_rate_reports = Some(vec![]);
        assert!(!report_matches_binding(report, &proof));
        proof.profile_envelope.as_mut().unwrap()["audio_rate_contract"]["allowed_sample_rates"] =
            json!([48_000]);
        assert!(!bounded_contract(&proof));
        proof.metadata.audio = None;
        proof.profile_envelope = Some(json!(envelope("emby", &proof.metadata).unwrap()));
        assert!(bounded_contract(&proof));
        assert!(report_matches_binding(report, &proof));
        proof.profile_version = 1;
        assert!(!bounded_contract(&proof));
    }
}
