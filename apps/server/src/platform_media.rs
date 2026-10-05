//! Native platform preparation is supervised and uses ordinary room authority.
//! Every public URL is a RainSync grant; signed CDN addresses stay sealed.
use crate::*;
use providers::platform::bilibili::{self, Client};
use tokio::time::{Duration, Instant as Deadline};
mod bilibili_compatibility_probe;
mod course;
mod delivery;
mod descriptor;
mod pgc;
mod quality;
mod resolver;
pub(crate) mod transcode;
mod youtube_probe;
pub(crate) use delivery::{TextScope, admit_text, check_text};
pub use delivery::{manifest, track};
use descriptor::{Binding, Descriptor, Sealed, Transport};
pub(crate) use resolver::resolve_progressive;
pub(crate) use resolver::resolve_public_progressive;
pub(crate) use resolver::resolve_youtube_with_account;

#[derive(serde::Deserialize)]
struct UpstreamCode {
    code: i64,
}
fn upstream_api_code(body: &[u8]) -> Option<i64> {
    // A typed envelope rejects duplicate, missing and non-integer codes. No
    // provider message, URL, account material or QR payload is retained.
    // Serde also accepts structs as arrays; the API envelope must be an object.
    if body.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'{') {
        return None;
    }
    serde_json::from_slice::<UpstreamCode>(body)
        .ok()
        .map(|value| value.code)
}
struct DiagnosticTransport(providers::platform::http::PlatformHttp);
impl bilibili::Transport for DiagnosticTransport {
    fn get<'a>(
        &'a self,
        request: bilibili::ApiRequest,
        deadline: Deadline,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = std::result::Result<bilibili::ApiResponse, bilibili::Error>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let endpoint = request.endpoint();
            let authenticated = request.headers().contains_key("Cookie");
            let response = bilibili::Transport::get(&self.0, request, deadline).await?;
            if matches!(
                endpoint,
                bilibili::Endpoint::View | bilibili::Endpoint::PlayUrl
            ) && let Some(code) = upstream_api_code(&response.body)
                && code != 0
            {
                tracing::warn!(event = "native_platform_api_rejected", provider = "bilibili",
                    endpoint = ?endpoint, authenticated, upstream_api_code = code);
            }
            Ok(response)
        })
    }
}

pub(crate) fn provider_error(error: bilibili::Error) -> Error {
    provider_error_scoped(error, None)
}
fn provider_error_scoped(error: bilibili::Error, authenticated: Option<bool>) -> Error {
    let (failure_class, upstream_api_code, upstream_http_status, restriction_reason) =
        provider_failure_fields(&error);
    tracing::warn!(
        event = "native_platform_upstream_failed",
        provider = "bilibili",
        authenticated,
        failure_class,
        upstream_api_code,
        upstream_http_status,
        restriction_reason,
    );
    match error {
        bilibili::Error::InvalidResource => err(StatusCode::BAD_REQUEST, "native_platform_invalid"),
        bilibili::Error::Deadline => err(
            StatusCode::GATEWAY_TIMEOUT,
            "native_platform_resolve_timeout",
        ),
        bilibili::Error::Restricted(_)
        | bilibili::Error::Api(-101 | -10403 | -403 | -404 | 62002 | 62004) => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_access_denied",
        ),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_resolve_failed"),
    }
}
fn provider_failure_fields(
    error: &bilibili::Error,
) -> (&'static str, Option<i64>, Option<u16>, &'static str) {
    use bilibili::Error as E;
    match error {
        E::Api(code) => ("provider_api_rejected", Some(*code), None, "none"),
        E::Status(status) => ("provider_http_rejected", None, Some(*status), "none"),
        E::Restricted(reason) => (
            "provider_policy_rejected",
            None,
            None,
            match *reason {
                "authentication_required" => "authentication_required",
                "unavailable_or_permission" => "unavailable_or_permission",
                "upstream_access_or_drm" => "upstream_access_or_drm",
                "preview_or_duration_mismatch" => "preview_or_duration_mismatch",
                "unavailable" => "unavailable",
                "redirected_resource" => "redirected_resource",
                _ => "other_policy_restriction",
            },
        ),
        E::Deadline => ("deadline_exceeded", None, None, "none"),
        E::Transport => ("transport_failed", None, None, "none"),
        E::TooLarge => ("response_limit_exceeded", None, None, "none"),
        E::InvalidJson => ("response_json_invalid", None, None, "none"),
        _ => ("response_schema_invalid", None, None, "none"),
    }
}
fn validate_request(body: &protocol::PlaybackRequest) -> Result<()> {
    validate_contract(body, false)
}
fn compatibility_requested(body: &protocol::PlaybackRequest) -> bool {
    body.native_platform
        .as_ref()
        .is_some_and(|intent| intent.compatibility.is_some())
}
fn ladder_requested(body: &protocol::PlaybackRequest) -> bool {
    body.native_platform
        .as_ref()
        .and_then(|intent| intent.compatibility.as_ref())
        .is_some_and(|intent| {
            intent.mode == protocol::NativePlatformCompatibilityMode::HlsAvcAacLadder
        })
}
fn validate_contract(body: &protocol::PlaybackRequest, compatibility: bool) -> Result<()> {
    quality::validate_shape(body)?;
    let intent = body
        .native_platform
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "native_platform_intent_required"))?;
    if intent.live_version.is_some()
        || intent.version != 1
        || intent.course_version.is_some_and(|version| version != 1)
        || compatibility_requested(body) != compatibility
        || intent
            .compatibility
            .as_ref()
            .is_some_and(|intent| intent.version != 1)
        || (compatibility
            && !body
                .capabilities
                .as_ref()
                .is_some_and(protocol::PlaybackCapabilities::supports_hls))
        || body.viewer_id.is_none()
        || !body.plan_generation.is_some_and(|v| v > 0)
        || (intent.credential_mode == protocol::NativePlatformCredentialMode::Anonymous
            && intent.account_id.is_some())
        || body.candidate_report.is_some()
        || body.advanced_playback.is_some()
        || body.local_hls_ladder.is_some()
        || body.http_file_fallback.is_some()
        || body.http_file_fallback_version.is_some()
        || body.static_hls_fallback_version.is_some()
        || body.upstream_profile_report.is_some()
        || body.audio_index.is_some()
        || body.mode.as_deref().is_some_and(|v| {
            if compatibility {
                v != "transcode"
            } else {
                !matches!(v, "auto" | "direct")
            }
        })
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    if !body.position_ms.is_finite() || body.position_ms < 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    if body.observation_version.is_some_and(|v| v != 1) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unsupported_observation_version",
        ));
    }
    playback_metrics::validate(body)?;
    Ok(())
}

pub async fn prepare(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    if compatibility_requested(&body) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    if native_other_live::is_live_request(&app, &headers, &body).await? {
        return native_other_live::prepare(State(app), headers, Json(body)).await;
    }
    if native_live::is_live_request(&app, &headers, &body).await? {
        return native_live::prepare(State(app), headers, Json(body)).await;
    }
    validate_request(&body)?;
    let user = auth(&app, &headers, true).await?;
    member(&app, &user, body.room_id).await?;
    let login = media_authorization::login_hash(&headers)?;
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    // A dropped browser waiter cannot orphan an untracked durable reservation.
    tokio::spawn(owned_prepare(app, user, body, login, owner))
        .await
        .map_err(anyhow::Error::from)?
}
/// Explicit finite clear-media compatibility entry. The original resolver and
/// account authority are retained; Live and composition options never enter it.
pub async fn prepare_compatibility(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    validate_contract(&body, true)?;
    let user = auth(&app, &headers, true).await?;
    member(&app, &user, body.room_id).await?;
    let login = media_authorization::login_hash(&headers)?;
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    tokio::spawn(owned_prepare(app, user, body, login, owner))
        .await
        .map_err(anyhow::Error::from)?
}
async fn owned_prepare(
    app: App,
    user: User,
    body: protocol::PlaybackRequest,
    login: String,
    owner: preparation_owner::Owner,
) -> Result<Json<Value>> {
    let reservation =
        match playback_requests::begin_authenticated(&app, user.id, &body, Some(&login)).await? {
            playback_requests::Start::Replay(mut plan) => {
                if plan["native_platform"]["version"] != 1 {
                    return Err(err(StatusCode::GONE, "invalid_playback_session"));
                }
                refresh_live_plan(&app, user.id, &body, &login, &mut plan).await?;
                return Ok(Json(plan));
            }
            playback_requests::Start::Reserved(reservation) => reservation,
            playback_requests::Start::StaticHlsPublished { .. } => {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    "native_platform_invalid_intent",
                ));
            }
        };
    let scope = media_core::child_process::Scope::new();
    let result = scope.run(async { tokio::select! {
        biased;
        _=owner.cancelled()=>Err(err(StatusCode::SERVICE_UNAVAILABLE,"playback_request_interrupted")),
        result=tokio::time::timeout(Duration::from_secs(45),resolve_and_publish(&app,&user,&body,&login,&reservation))=>result.unwrap_or_else(|_|Err(err(StatusCode::GATEWAY_TIMEOUT,"playback_request_interrupted"))),
    }}).await;
    let outcome = match result {
        Ok(mut plan) => refresh_live_plan(&app, user.id, &body, &login, &mut plan)
            .await
            .map(|_| Json(plan)),
        Err(error) => match playback_requests::fail(&app, &reservation, &error).await {
            Ok(Some(mut plan)) => refresh_live_plan(&app, user.id, &body, &login, &mut plan)
                .await
                .map(|_| Json(plan)),
            Ok(None) => Err(error),
            Err(error) => Err(error),
        },
    };
    // Cancellation drops only the resolver waiter. Positively drain its scoped
    // extractor/process tree before acknowledging the durable reservation. A
    // cleanup error leaves the reservation unacknowledged, never falsely drained.
    scope.shutdown().await.map_err(anyhow::Error::from)?;
    tokio::spawn(async move {
        owner.acknowledge(&app, &reservation).await;
    });
    outcome
}

fn validate_entry_intent(body: &protocol::PlaybackRequest, provider: &str) -> Result<()> {
    if body.native_platform.is_none() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_intent_required",
        ));
    }
    if !matches!(provider, "bilibili" | "douyin" | "tiktok" | "youtube") {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    if !compatibility_requested(body)
        && body.capabilities.as_ref().is_some_and(|caps| {
            if provider == "bilibili" {
                !caps.mse_h264_aac
            } else if provider == "youtube" {
                !caps.mse_h264_aac && !caps.progressive_h264_aac
            } else {
                !caps.progressive_h264_aac
            }
        })
    {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_device_unsupported",
        ));
    }
    Ok(())
}
fn validate_transport_capability(
    body: &protocol::PlaybackRequest,
    transport: Transport,
) -> Result<()> {
    if !compatibility_requested(body)
        && body
            .capabilities
            .as_ref()
            .is_some_and(|caps| match transport {
                Transport::Dash => !caps.mse_h264_aac,
                Transport::Progressive => !caps.progressive_h264_aac,
            })
    {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_device_unsupported",
        ));
    }
    Ok(())
}

fn youtube_selection_mode(
    body: &protocol::PlaybackRequest,
) -> providers::platform::youtube::SelectionMode {
    if compatibility_requested(body) {
        return providers::platform::youtube::SelectionMode::CompatibilityAdaptive;
    }
    // Decide before extraction. An ordinary muxed selection for a non-MSE
    // device does not reinterpret or downgrade a rejected adaptive result.
    if !compatibility_requested(body)
        && body
            .capabilities
            .as_ref()
            .is_some_and(|caps| !caps.mse_h264_aac && caps.progressive_h264_aac)
    {
        providers::platform::youtube::SelectionMode::ProgressiveOnly
    } else {
        providers::platform::youtube::SelectionMode::PreferAdaptive
    }
}

async fn resolve_and_publish(
    app: &App,
    user: &User,
    body: &protocol::PlaybackRequest,
    login: &str,
    reservation: &playback_requests::Reservation,
) -> Result<Value> {
    // Resolution and every input proof share this one absolute budget. A late
    // extraction cannot receive a fresh probe or transcode-admission deadline.
    let deadline = Deadline::now() + Duration::from_secs(35);
    let compatibility = compatibility_requested(body);
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let entry = native_platform::capture(&mut tx, body.room_id, body.media_generation).await?;
    tx.rollback().await?;
    validate_entry_intent(body, &entry.provider)?;
    quality::validate_target(body, &entry.provider, entry.media_id)?;
    let intent = body
        .native_platform
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "native_platform_intent_required"))?;
    if (intent.course_version == Some(1)) != entry.course.is_some() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    let account = match (entry.provider.as_str(), intent.credential_mode) {
        ("bilibili", protocol::NativePlatformCredentialMode::Anonymous) => {
            platform_accounts::FrozenAccount::anonymous(user.id)
        }
        (_, protocol::NativePlatformCredentialMode::Anonymous) => {
            platform_accounts::FrozenAccount::anonymous_for_provider(user.id, &entry.provider)?
        }
        ("bilibili", protocol::NativePlatformCredentialMode::OwnOrAnonymous) => {
            platform_accounts::load_for_playback(app, user.id).await?
        }
        (
            "douyin" | "tiktok" | "youtube",
            protocol::NativePlatformCredentialMode::OwnOrAnonymous,
        ) => platform_accounts::load_for_provider_playback(app, user.id, &entry.provider).await?,
        // Unknown providers never borrow another platform's credential vault.
        (_, protocol::NativePlatformCredentialMode::OwnOrAnonymous) => {
            platform_accounts::FrozenAccount::anonymous_for_provider(user.id, &entry.provider)?
        }
    };
    if intent.account_id.is_some() && intent.account_id != account.account_id() {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    // Account retrieval is an await too. Recheck the exact caller and frozen
    // account immediately before contacting the provider, then release locks.
    let mut before_resolve = app.db.begin().await?;
    playback_requests::guard(app, &mut before_resolve, reservation).await?;
    native_platform::guard(&mut before_resolve, &entry, body.media_generation).await?;
    platform_accounts::guard_for_publish(&mut before_resolve, user.id, &account).await?;
    playback_requests::guard(app, &mut before_resolve, reservation).await?;
    before_resolve.rollback().await?;
    let requested_height = quality::requested(body);
    let mut available_heights = vec![];
    let (descriptor, url_expires_at_ms) = if entry.course.is_some() {
        let (descriptor, expiry, heights) = course::resolve(
            app,
            &entry,
            &account,
            Some(requested_height.limit().unwrap_or(1080)),
            deadline,
        )
        .await?;
        available_heights = heights;
        (descriptor, expiry)
    } else if entry.pgc.is_some() {
        let (descriptor, expiry, heights) = pgc::resolve(
            app,
            &entry,
            &account,
            Some(requested_height.limit().unwrap_or(1080)),
            deadline,
        )
        .await?;
        available_heights = heights;
        (descriptor, expiry)
    } else if entry.provider == "bilibili" {
        let resolved = Client::new(
            DiagnosticTransport(app.platform_http),
            account.cookie().cloned(),
        )
        .resolve(
            &entry.resource(),
            // Discover only renditions this exact viewer's provider response
            // admits. Auto keeps the existing 1080p ceiling; labels come
            // from real compatible tracks rather than Bili quality names.
            127,
            deadline,
        )
        .await
        .map_err(|error| provider_error_scoped(error, Some(account.cookie().is_some())))?;
        if resolved.metadata.bvid != entry.content_id
            || resolved.metadata.part != entry.part
            || entry
                .cid
                .is_some_and(|cid| resolved.metadata.cid.parse::<i64>().ok() != Some(cid))
        {
            return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
        }
        if compatibility {
            let (descriptor, expiry, heights) = bilibili_compatibility_probe::prepare(
                app.platform_http,
                &resolved,
                Some(requested_height.limit().unwrap_or(1080)),
                deadline,
            )
            .await?;
            available_heights = heights;
            (descriptor, expiry)
        } else {
            available_heights = Descriptor::bilibili_heights(&resolved);
            Descriptor::from_resolved_with_max_height(
                &resolved,
                Some(requested_height.limit().unwrap_or(1080)),
            )?
        }
    } else if entry.provider == "youtube" {
        // One absolute budget covers extraction and both bounded byte probes.
        let resolved = resolver::resolve_youtube_with_account(
            app,
            &entry.resource(),
            youtube_selection_mode(body),
            quality::youtube_limit(requested_height),
            account.youtube_cookie(),
            deadline,
        )
        .await?;
        available_heights = resolved.available_heights.clone();
        if resolved.content_id != entry.content_id
            || Some(&resolved.canonical_url) != entry.canonical_url.as_ref()
        {
            return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
        }
        match &resolved.playback {
            providers::platform::youtube::Playback::Progressive(playback) => {
                validate_transport_capability(body, Transport::Progressive)?;
                Descriptor::from_progressive(
                    "youtube",
                    &resolver::youtube_progressive(&resolved, playback),
                )?
            }
            providers::platform::youtube::Playback::Adaptive { video, audio } => {
                validate_transport_capability(body, Transport::Dash)?;
                if compatibility_requested(body) {
                    youtube_probe::prepare_compatibility(
                        app.platform_http,
                        &resolved,
                        video,
                        audio,
                        deadline,
                    )
                    .await?
                } else {
                    youtube_probe::prepare(app.platform_http, &resolved, video, audio, deadline)
                        .await?
                }
            }
        }
    } else {
        let resolved = resolve_progressive(
            app,
            &entry.provider,
            &entry.resource(),
            account.short_cookie(),
            deadline,
        )
        .await?;
        if resolved.content_id != entry.content_id
            || Some(&resolved.canonical_url) != entry.canonical_url.as_ref()
        {
            return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
        }
        Descriptor::from_progressive(&entry.provider, &resolved)?
    };
    validate_transport_capability(body, descriptor.transport)?;
    let quality_binding = if matches!(entry.provider.as_str(), "bilibili" | "youtube") {
        // Progressive imports may omit dimensions; do not manufacture options.
        if descriptor.tracks.iter().any(|track| track.height.is_some()) {
            Some(quality::binding(
                requested_height,
                &descriptor,
                available_heights,
            )?)
        } else {
            None
        }
    } else {
        None
    };
    let resolved_at_ms = unix_ms()?;
    let binding = Binding {
        version: entry.resource_version(),
        resource: entry.identity(),
        provider: entry.provider.clone(),
        media_id: entry.media_id,
        room_id: entry.room_id,
        user_id: user.id,
        entry_revision: entry.revision.to_string(),
        credential_mode: if account.account_id().is_some() {
            "own_account"
        } else {
            "anonymous"
        }
        .into(),
        account_id: account.account_id(),
        account_revision: account.revision().map(|v| v.to_string()),
    };
    if !binding.matches_entry(&entry) {
        return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
    }
    let sealed = Sealed {
        kind: "native_platform".into(),
        version: 1,
        binding: binding.clone(),
        resolved_at_ms,
        url_expires_at_ms,
        descriptor,
    };
    let mut expiry = sealed.policy_deadline_ms()?;
    if let Some(account_expiry) = account.credential_expires_at_ms() {
        expiry = expiry.min(account_expiry);
    }
    let prepared_source = if compatibility {
        // Revalidate all frozen authority before another network await, then
        // release row locks. Publication repeats it after the proof completes.
        let mut proof_guard = app.db.begin().await?;
        playback_requests::guard(app, &mut proof_guard, reservation).await?;
        native_platform::guard(&mut proof_guard, &entry, body.media_generation).await?;
        platform_accounts::guard_for_publish(&mut proof_guard, user.id, &account).await?;
        playback_requests::guard(app, &mut proof_guard, reservation).await?;
        let login_expiry: i64 = sqlx::query_scalar("SELECT floor(extract(epoch FROM expires_at)*1000)::bigint FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()")
            .bind(login).bind(user.id).fetch_optional(&mut *proof_guard).await?
            .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "session_expired"))?;
        expiry = expiry.min(login_expiry);
        proof_guard.rollback().await?;
        Some(transcode::prepare_source(app, &sealed, expiry, deadline).await?)
    } else {
        None
    };
    let sealed_json = serde_json::to_value(&sealed).map_err(anyhow::Error::from)?;
    let mut resource =
        json!({"encrypted":app.encrypt(&sealed_json)?,"native_platform_context":binding});
    if compatibility {
        resource["native_platform_compatibility_version"] = json!(1);
        if ladder_requested(body) {
            resource["native_platform_hls_ladder_version"] = json!(1);
        }
    }
    let delivery_token = token();
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    native_platform::guard(&mut tx, &entry, body.media_generation).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, &account).await?;
    // Account row waits cannot authorize publication past login/lifecycle/intent.
    playback_requests::guard(app, &mut tx, reservation).await?;
    let login_expiry:i64=sqlx::query_scalar("SELECT floor(extract(epoch FROM expires_at)*1000)::bigint FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()")
        .bind(login).bind(user.id).fetch_optional(&mut *tx).await?.ok_or_else(||err(StatusCode::UNAUTHORIZED,"session_expired"))?;
    expiry = expiry.min(login_expiry);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT floor(($1::double precision/1000.0)-extract(epoch FROM clock_timestamp()))::bigint",
    )
    .bind(expiry)
    .fetch_one(&mut *tx)
    .await?;
    if remaining < 2 {
        return Err(err(StatusCode::GONE, "native_platform_url_expired"));
    }
    let remaining = u32::try_from(remaining).map_err(anyhow::Error::from)?;
    let refresh = remaining.saturating_sub(30).max(1);
    let protocol_plan = protocol::PlaybackPlan {
        distributed_compute: None,
        local_hls_ladder: None,
        advanced_playback: None,
        native_platform: Some(protocol::NativePlatformPlaybackBinding {
            course_version: entry.course.as_ref().map(|_| 1),
            compatibility: compatibility.then_some(protocol::NativePlatformCompatibilityBinding {
                version: 1,
                mode: if ladder_requested(body) {
                    protocol::NativePlatformCompatibilityMode::HlsAvcAacLadder
                } else {
                    protocol::NativePlatformCompatibilityMode::HlsAvcAac
                },
                output: None,
            }),
            live: None,
            version: 1,
            provider: match entry.provider.as_str() {
                "bilibili" => protocol::NativePlatformProvider::Bilibili,
                "douyin" => protocol::NativePlatformProvider::Douyin,
                "tiktok" => protocol::NativePlatformProvider::Tiktok,
                "youtube" => protocol::NativePlatformProvider::Youtube,
                _ => return Err(err(StatusCode::GONE, "invalid_playback_session")),
            },
            credential_mode: if account.account_id().is_some() {
                protocol::NativePlatformResolvedCredentialMode::OwnAccount
            } else {
                protocol::NativePlatformResolvedCredentialMode::Anonymous
            },
            refresh_after_seconds: refresh,
            quality: quality_binding,
        }),
        session_id: reservation.session,
        media_id: entry.media_id,
        media_generation: body.media_generation,
        plan_generation: reservation.plan_generation,
        delivery_mode: if compatibility { "transcode" } else { "direct" }.into(),
        transport: if compatibility {
            "pending_hls"
        } else {
            match sealed.descriptor.transport {
                Transport::Dash => "dash",
                Transport::Progressive => "progressive",
            }
        }
        .into(),
        playback_url: if compatibility {
            format!(
                "/api/v1/platform-delivery/{}/compatibility/{}?token={delivery_token}",
                reservation.session,
                if ladder_requested(body) {
                    "master.m3u8"
                } else {
                    "index.m3u8"
                }
            )
        } else {
            match sealed.descriptor.transport {
                Transport::Dash => format!(
                    "/api/v1/platform-delivery/{}/manifest.mpd?token={delivery_token}",
                    reservation.session
                ),
                Transport::Progressive => format!(
                    "/api/v1/platform-delivery/{}/tracks/progressive?token={delivery_token}",
                    reservation.session
                ),
            }
        },
        timeline_origin_ms: if compatibility { body.position_ms } else { 0.0 },
        duration_ms: Some(sealed.descriptor.duration_seconds * 1000.0),
        expires_in_seconds: remaining,
        rebuild_on_seek: compatibility,
        audio_tracks: vec![],
        subtitle_tracks: vec![],
        decision_reason: Some(if compatibility {
            "native_platform_clear_media_compatibility".into()
        } else {
            sealed.descriptor.decision_reason(&entry.provider).into()
        }),
        selected_audio_track: None,
        selected_candidate_id: None,
        selected_output: None,
        subtitle_mode: Some(protocol::SubtitleDeliveryMode::None),
        seekable_media_ranges_ms: compatibility.then_some(vec![]),
        pending_job_id: compatibility.then_some(reservation.session),
        decoder_fallback_modes: Some(vec![]),
        http_file_fallback_version: None,
        static_hls_fallback_version: None,
        upstream_profile: None,
        observation_version: body.observation_version,
        observation_seq: body.observation_version.map(|_| 0),
        playback_metrics_version: None,
        playback_metrics: None,
    };
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000.0),$9,$10,$11)")
        .bind(reservation.session).bind(user.id).bind(body.room_id).bind(entry.media_id).bind(i64::from(body.media_generation)).bind(hash(&delivery_token)).bind(&resource).bind(expiry)
        .bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).execute(&mut *tx).await?;
    if let Some(prepared) = &prepared_source {
        // Session, immutable job authority, and completed response commit as
        // one unit. There is never a ready native parent before this enqueue.
        if ladder_requested(body) {
            transcode::enqueue_ladder(
                &mut tx,
                reservation.session,
                prepared,
                body.position_ms / 1000.0,
                body.media_generation,
                body.plan_generation
                    .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_request"))?,
                app.queue_limit,
            )
            .await?;
        } else {
            transcode::enqueue(
                &mut tx,
                reservation.session,
                prepared,
                body.position_ms / 1000.0,
                app.queue_limit,
            )
            .await?;
        }
    }
    let mut plan = serde_json::to_value(&protocol_plan).map_err(anyhow::Error::from)?;
    if body.observation_version == Some(1) {
        persistence::playback_observations::create(&mut tx, user.id, body.room_id, &protocol_plan)
            .await?;
    }
    let attribution = json!({"kind":"native_platform","delivery_mode":if compatibility {"transcode"} else {"direct"}});
    if let Some((version, grant)) =
        playback_metrics::publish(&mut tx, user.id, body, reservation.session, &attribution).await?
    {
        plan["playback_metrics_version"] = json!(version);
        plan["playback_metrics"] = grant;
    }
    native_platform::guard(&mut tx, &entry, body.media_generation).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, &account).await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    playback_requests::complete(app, &mut tx, reservation, &plan).await?;
    // All time-based authority is evaluated again after the final contended lock.
    let live:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND expires_at>clock_timestamp() AND playback_source_allowed(media_id,resource,id))")
        .bind(reservation.session).fetch_one(&mut *tx).await?;
    if !live {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    tx.commit().await?;
    Ok(plan)
}
async fn refresh_live_plan(
    app: &App,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    login: &str,
    plan: &mut Value,
) -> Result<()> {
    let invalid = || err(StatusCode::GONE, "invalid_playback_session");
    if plan["native_platform"]["version"] != 1 {
        return Err(invalid());
    }
    let session = plan["session_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(invalid)?;
    let media = plan["media_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(invalid)?;
    let delivery_token = live_delivery_token(plan, session)?;
    let provider = plan["native_platform"]["provider"]
        .as_str()
        .ok_or_else(invalid)?;
    validate_entry_intent(body, provider)?;
    quality::validate_target(body, provider, media)?;
    if plan["native_platform"]["course_version"].as_u64()
        != body
            .native_platform
            .as_ref()
            .and_then(|intent| intent.course_version)
            .map(u64::from)
    {
        return Err(invalid());
    }
    let compatibility = compatibility_requested(body);
    if compatibility {
        if plan["native_platform"]["compatibility"]["version"] != 1
            || plan["native_platform"]["compatibility"]["mode"]
                != if ladder_requested(body) {
                    "hls_avc_aac_ladder"
                } else {
                    "hls_avc_aac"
                }
            || !matches!(plan["transport"].as_str(), Some("pending_hls" | "hls"))
            || plan["delivery_mode"] != "transcode"
            || plan["rebuild_on_seek"] != true
        {
            return Err(invalid());
        }
    } else {
        if plan["native_platform"].get("compatibility").is_some() {
            return Err(invalid());
        }
        let transport = match plan["transport"].as_str() {
            Some("dash") => Transport::Dash,
            Some("progressive") => Transport::Progressive,
            _ => return Err(invalid()),
        };
        validate_transport_capability(body, transport)?;
    }
    let credential_mode = plan["native_platform"]["credential_mode"]
        .as_str()
        .ok_or_else(invalid)?;
    validate_replay_credential_mode(body, provider, credential_mode)?;
    let account_id = body
        .native_platform
        .as_ref()
        .and_then(|intent| intent.account_id);
    let remaining=tokio::time::timeout(Duration::from_secs(2),database_checks::text(&app.db,
        sqlx::query_scalar("SELECT COALESCE((SELECT floor(extract(epoch FROM(p.expires_at-clock_timestamp())))::bigint FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND p.user_id=$2 AND p.room_id=$3 AND p.auth_login_hash=$4 AND p.media_id=$5 AND p.generation=$6 AND p.viewer_id=$7 AND p.plan_generation=$8 AND p.delivery_token_hash=$9 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.resource ? 'native_platform_context' AND p.resource->'native_platform_context'->>'provider'=$10 AND p.resource->'native_platform_context'->>'credential_mode'=$11 AND ($12::text IS NULL OR p.resource->'native_platform_context'->>'account_id'=$12) AND playback_source_allowed(p.media_id,p.resource,p.id) AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND s.state->>'media_id'=p.media_id::text AND (s.state->>'media_generation')::bigint=p.generation AND EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation AND g.auth_login_hash=p.auth_login_hash) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)),0)::text")
            .bind(session).bind(user).bind(body.room_id).bind(login).bind(media).bind(i64::from(body.media_generation)).bind(body.viewer_id).bind(body.plan_generation.map(i64::from)).bind(hash(delivery_token)).bind(provider).bind(credential_mode).bind(account_id.map(|id|id.to_string())),1500)).await
        .map_err(|_|err(StatusCode::SERVICE_UNAVAILABLE,"service_unavailable"))??;
    let remaining = remaining.parse::<i64>().map_err(|_| invalid())?;
    shrink_live_plan(plan, remaining)?;
    if compatibility {
        transcode::refresh_plan(app, plan).await?;
    }
    Ok(())
}
fn validate_replay_credential_mode(
    body: &protocol::PlaybackRequest,
    _provider: &str,
    credential_mode: &str,
) -> Result<()> {
    let invalid = || err(StatusCode::GONE, "invalid_playback_session");
    let intent = body.native_platform.as_ref().ok_or_else(invalid)?;
    if !matches!(credential_mode, "anonymous" | "own_account")
        || (intent.credential_mode == protocol::NativePlatformCredentialMode::Anonymous
            && credential_mode != "anonymous")
        || (intent.account_id.is_some() && credential_mode != "own_account")
    {
        return Err(invalid());
    }
    Ok(())
}
fn live_delivery_token(plan: &Value, session: Uuid) -> Result<&str> {
    let invalid = || err(StatusCode::GONE, "invalid_playback_session");
    if plan["native_platform"].get("compatibility").is_some() {
        let filename = match plan["native_platform"]["compatibility"]["mode"].as_str() {
            Some("hls_avc_aac") => "index.m3u8",
            Some("hls_avc_aac_ladder") => "master.m3u8",
            _ => return Err(invalid()),
        };
        let prefix = format!("/api/v1/platform-delivery/{session}/compatibility/{filename}?token=");
        let query = plan["playback_url"]
            .as_str()
            .and_then(|url| url.strip_prefix(&prefix))
            .ok_or_else(invalid)?;
        let token = if let Some((token, attempt)) = query.split_once("&attempt=") {
            let actual = attempt
                .parse::<i64>()
                .ok()
                .filter(|value| *value > 0)
                .filter(|value| value.to_string() == attempt)
                .ok_or_else(invalid)?;
            if plan["native_platform"]["compatibility"]["output"]["attempt"].as_i64()
                != Some(actual)
            {
                return Err(invalid());
            }
            token
        } else {
            if plan["transport"] != "pending_hls"
                || plan["native_platform"]["compatibility"]
                    .get("output")
                    .is_some()
            {
                return Err(invalid());
            }
            query
        };
        return token
            .len()
            .eq(&64)
            .then_some(token)
            .filter(|value| value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(invalid);
    }
    let provider = plan["native_platform"]["provider"]
        .as_str()
        .ok_or_else(invalid)?;
    let path = match (provider, plan["transport"].as_str()) {
        ("bilibili" | "youtube", Some("dash")) => "manifest.mpd",
        ("douyin" | "tiktok" | "youtube", Some("progressive")) => "tracks/progressive",
        _ => return Err(invalid()),
    };
    let prefix = format!("/api/v1/platform-delivery/{session}/{path}?token=");
    plan["playback_url"]
        .as_str()
        .and_then(|v| v.strip_prefix(&prefix))
        .filter(|v| v.len() == 64 && v.bytes().all(|v| v.is_ascii_hexdigit()))
        .ok_or_else(invalid)
}
fn shrink_live_plan(plan: &mut Value, remaining: i64) -> Result<()> {
    if remaining < 2 {
        return Err(err(StatusCode::GONE, "native_platform_url_expired"));
    }
    let advertised = plan["expires_in_seconds"]
        .as_u64()
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    plan["expires_in_seconds"] = json!((remaining as u64).min(advertised));
    refresh_replay(plan)
}
fn refresh_replay(plan: &mut Value) -> Result<()> {
    let remaining = plan["expires_in_seconds"]
        .as_u64()
        .filter(|v| *v >= 2 && *v <= u32::MAX as u64)
        .ok_or_else(|| err(StatusCode::GONE, "native_platform_url_expired"))?
        as u32;
    let previous = plan["native_platform"]["refresh_after_seconds"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= u32::MAX as u64)
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?
        as u32;
    plan["native_platform"]["refresh_after_seconds"] =
        json!(previous.min(remaining.saturating_sub(30).max(1)));
    Ok(())
}
fn unix_ms() -> Result<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|v| i64::try_from(v.as_millis()).ok())
        .ok_or_else(|| err(StatusCode::INTERNAL_SERVER_ERROR, "clock_unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upstream_code_diagnostics_require_one_integer_and_discard_provider_payload() {
        assert_eq!(
            upstream_api_code(br#"{"code":-404,"data":{"url":"private"}}"#),
            Some(-404)
        );
        for body in [
            br#"{"code":0,"code":-404}"#.as_slice(),
            br#"{"code":"-404"}"#,
            br#"{"code":true}"#,
            br#"{"data":{"code":-404}}"#,
            br#"[0]"#,
        ] {
            assert_eq!(upstream_api_code(body), None);
        }
    }
    #[test]
    fn bilibili_failure_diagnostics_are_typed_and_never_retain_provider_text() {
        assert_eq!(
            provider_failure_fields(&bilibili::Error::Api(-10403)),
            ("provider_api_rejected", Some(-10403), None, "none")
        );
        assert_eq!(
            provider_failure_fields(&bilibili::Error::Status(403)),
            ("provider_http_rejected", None, Some(403), "none")
        );
        assert_eq!(
            provider_failure_fields(&bilibili::Error::Restricted("authentication_required")),
            (
                "provider_policy_rejected",
                None,
                None,
                "authentication_required"
            )
        );
        for error in [
            bilibili::Error::Restricted("https://private.invalid/?token=secret"),
            bilibili::Error::InvalidResponse("private QR payload"),
        ] {
            assert!(!format!("{:?}", provider_failure_fields(&error)).contains("private"));
        }
    }
    fn request() -> protocol::PlaybackRequest {
        serde_json::from_value(json!({"room_id":Uuid::from_u128(1),"media_generation":1,"viewer_id":Uuid::from_u128(2),"plan_generation":1,"native_platform":{"version":1,"credential_mode":"own_or_anonymous"}})).unwrap()
    }
    fn compatibility_request() -> protocol::PlaybackRequest {
        let mut body = request();
        body.mode = Some("transcode".into());
        body.capabilities = Some(protocol::PlaybackCapabilities {
            progressive_h264_aac: false,
            native_hls: true,
            mse_h264_aac: false,
            report: None,
        });
        body.native_platform.as_mut().unwrap().compatibility =
            Some(protocol::NativePlatformCompatibilityIntent {
                version: 1,
                mode: protocol::NativePlatformCompatibilityMode::HlsAvcAac,
            });
        body
    }
    #[test]
    fn compatibility_is_dedicated_hls_capability_gated_and_excludes_composition_or_live() {
        let body = compatibility_request();
        assert!(validate_contract(&body, true).is_ok());
        assert!(validate_request(&body).is_err());
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            assert!(validate_entry_intent(&body, provider).is_ok());
        }
        assert!(validate_transport_capability(&body, Transport::Dash).is_ok());
        assert!(validate_transport_capability(&body, Transport::Progressive).is_ok());
        let mut changed = body.clone();
        changed.capabilities.as_mut().unwrap().native_hls = false;
        assert!(validate_contract(&changed, true).is_err());
        changed = body.clone();
        changed.native_platform.as_mut().unwrap().live_version = Some(1);
        assert!(validate_contract(&changed, true).is_err());
        changed = body.clone();
        changed
            .native_platform
            .as_mut()
            .unwrap()
            .compatibility
            .as_mut()
            .unwrap()
            .version = 2;
        assert!(validate_contract(&changed, true).is_err());
        changed = body.clone();
        changed.audio_index = Some(0);
        assert!(validate_contract(&changed, true).is_err());
        changed = body.clone();
        changed.advanced_playback = Some(protocol::AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: true,
            subtitle_stream_index: None,
        });
        assert!(validate_contract(&changed, true).is_err());
        changed = body.clone();
        changed.mode = Some("direct".into());
        assert!(validate_contract(&changed, true).is_err());
        changed = body.clone();
        changed.native_platform.as_mut().unwrap().compatibility = None;
        assert!(validate_contract(&changed, true).is_err());
    }
    #[test]
    fn compatibility_token_never_invents_or_transplants_an_attempt() {
        let session = Uuid::from_u128(42);
        let token = "a".repeat(64);
        let url =
            format!("/api/v1/platform-delivery/{session}/compatibility/index.m3u8?token={token}");
        let mut plan = json!({"transport":"pending_hls","playback_url":url,"native_platform":{"provider":"bilibili","compatibility":{"version":1,"mode":"hls_avc_aac"}}});
        assert_eq!(live_delivery_token(&plan, session).unwrap(), token);
        plan["playback_url"] = json!(format!("{url}&attempt=1"));
        assert!(live_delivery_token(&plan, session).is_err());
        plan["transport"] = json!("hls");
        plan["native_platform"]["compatibility"]["output"] = json!({"attempt":7,"complete":false,"codecs":"avc1.64001F,mp4a.40.2","width":1280,"height":720});
        plan["playback_url"] = json!(format!("{url}&attempt=7"));
        assert_eq!(live_delivery_token(&plan, session).unwrap(), token);
        assert!(live_delivery_token(&plan, Uuid::from_u128(43)).is_err());
        for attempt in ["0", "1", "07", "-7", "7&recovery=1"] {
            plan["playback_url"] = json!(format!("{url}&attempt={attempt}"));
            assert!(live_delivery_token(&plan, session).is_err());
        }
    }
    #[test]
    fn youtube_progressive_only_capabilities_preselect_the_strict_muxed_branch() {
        use providers::platform::youtube::SelectionMode;
        let mut body = request();
        assert!(matches!(
            youtube_selection_mode(&body),
            SelectionMode::PreferAdaptive
        ));
        body.capabilities = Some(protocol::PlaybackCapabilities {
            progressive_h264_aac: true,
            native_hls: false,
            mse_h264_aac: false,
            report: None,
        });
        assert!(validate_entry_intent(&body, "youtube").is_ok());
        assert!(matches!(
            youtube_selection_mode(&body),
            SelectionMode::ProgressiveOnly
        ));
        assert!(validate_transport_capability(&body, Transport::Progressive).is_ok());
        assert!(validate_transport_capability(&body, Transport::Dash).is_err());
        body.capabilities.as_mut().unwrap().mse_h264_aac = true;
        assert!(matches!(
            youtube_selection_mode(&body),
            SelectionMode::PreferAdaptive
        ));
        body.capabilities.as_mut().unwrap().progressive_h264_aac = false;
        assert!(matches!(
            youtube_selection_mode(&body),
            SelectionMode::PreferAdaptive
        ));
        assert!(validate_transport_capability(&body, Transport::Dash).is_ok());
    }

    #[test]
    fn replay_refresh_shrinks_with_original_grant_instead_of_extending_it() {
        let mut plan =
            json!({"expires_in_seconds":10,"native_platform":{"refresh_after_seconds":90}});
        refresh_replay(&mut plan).unwrap();
        assert_eq!(plan["native_platform"]["refresh_after_seconds"], 1);
        assert_eq!(plan["expires_in_seconds"], 10);
        plan["expires_in_seconds"] = json!(1);
        assert!(refresh_replay(&mut plan).is_err());
    }
    #[test]
    fn commit_uncertain_recovery_only_shrinks_the_existing_plan() {
        let mut recovered = json!({"session_id":Uuid::from_u128(1),"media_id":Uuid::from_u128(2),"plan_generation":7,"playback_url":"original same-grant URL","expires_in_seconds":1800,"native_platform":{"version":1,"refresh_after_seconds":1770}});
        let original = recovered.clone();
        shrink_live_plan(&mut recovered, 5).unwrap();
        assert_eq!(recovered["expires_in_seconds"], 5);
        assert_eq!(recovered["native_platform"]["refresh_after_seconds"], 1);
        for field in ["session_id", "media_id", "plan_generation", "playback_url"] {
            assert_eq!(recovered[field], original[field]);
        }
        shrink_live_plan(&mut recovered, 500).unwrap();
        assert_eq!(recovered["expires_in_seconds"], 5);
        assert!(shrink_live_plan(&mut recovered, 1).is_err());
        assert!(shrink_live_plan(&mut recovered, -1).is_err());
    }
    #[test]
    fn short_intent_accepts_own_accounts_with_progressive_capability_only() {
        let mut body = request();
        body.capabilities = Some(protocol::PlaybackCapabilities {
            progressive_h264_aac: true,
            native_hls: false,
            mse_h264_aac: false,
            report: None,
        });
        for provider in ["douyin", "tiktok"] {
            assert!(validate_entry_intent(&body, provider).is_ok());
            body.native_platform.as_mut().unwrap().account_id = Some(Uuid::from_u128(9));
            assert!(validate_entry_intent(&body, provider).is_ok());
            body.native_platform.as_mut().unwrap().account_id = None;
        }
        assert!(validate_entry_intent(&body, "youtube").is_ok());
        body.native_platform.as_mut().unwrap().account_id = Some(Uuid::from_u128(9));
        assert!(validate_entry_intent(&body, "youtube").is_ok());
        body.native_platform.as_mut().unwrap().account_id = None;
        assert!(validate_entry_intent(&body, "bilibili").is_err());
        body.capabilities.as_mut().unwrap().progressive_h264_aac = false;
        body.capabilities.as_mut().unwrap().mse_h264_aac = true;
        assert!(validate_entry_intent(&body, "youtube").is_ok());
        assert!(validate_transport_capability(&body, Transport::Dash).is_ok());
        assert!(validate_transport_capability(&body, Transport::Progressive).is_err());
        assert!(validate_entry_intent(&body, "douyin").is_err());
        assert!(validate_entry_intent(&body, "tiktok").is_err());
        assert!(validate_entry_intent(&body, "bilibili").is_ok());
    }
    #[test]
    fn replay_delivery_url_is_exactly_bound_to_provider_transport_and_session() {
        let session = Uuid::from_u128(42);
        let token = "a".repeat(64);
        for (provider, transport, path) in [
            ("bilibili", "dash", "manifest.mpd"),
            ("youtube", "dash", "manifest.mpd"),
            ("douyin", "progressive", "tracks/progressive"),
            ("tiktok", "progressive", "tracks/progressive"),
            ("youtube", "progressive", "tracks/progressive"),
        ] {
            let mut plan = json!({"native_platform":{"provider":provider}, "transport":transport, "playback_url":format!("/api/v1/platform-delivery/{session}/{path}?token={token}")});
            assert_eq!(live_delivery_token(&plan, session).unwrap(), token);
            assert!(live_delivery_token(&plan, Uuid::from_u128(43)).is_err());
            plan["transport"] = json!(if transport == "dash" {
                "progressive"
            } else {
                "dash"
            });
            assert!(live_delivery_token(&plan, session).is_err());
            plan["transport"] = json!(transport);
            plan["playback_url"] = json!(format!(
                "https://evil.example/api/v1/platform-delivery/{session}/{path}?token={token}"
            ));
            assert!(live_delivery_token(&plan, session).is_err());
        }
    }
    #[test]
    fn replay_credential_mode_cannot_upgrade_anonymous_or_lose_selected_account() {
        let mut body = request();
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            assert!(validate_replay_credential_mode(&body, provider, "own_account").is_ok());
            assert!(validate_replay_credential_mode(&body, provider, "anonymous").is_ok());
            assert!(validate_replay_credential_mode(&body, provider, "owner_account").is_err());
        }
        body.native_platform.as_mut().unwrap().account_id = Some(Uuid::from_u128(9));
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            assert!(validate_replay_credential_mode(&body, provider, "anonymous").is_err());
            assert!(validate_replay_credential_mode(&body, provider, "own_account").is_ok());
        }
        body.native_platform.as_mut().unwrap().account_id = None;
        body.native_platform.as_mut().unwrap().credential_mode =
            protocol::NativePlatformCredentialMode::Anonymous;
        for provider in ["bilibili", "douyin", "tiktok", "youtube"] {
            assert!(validate_replay_credential_mode(&body, provider, "own_account").is_err());
            assert!(validate_replay_credential_mode(&body, provider, "anonymous").is_ok());
        }
    }
    #[test]
    fn youtube_own_account_initial_refresh_and_replay_retain_explicit_scope() {
        let mut body = request();
        let session = Uuid::from_u128(42);
        let plan = json!({"native_platform":{"version":1,"provider":"youtube","credential_mode":"own_account"},
            "transport":"dash","playback_url":format!("/api/v1/platform-delivery/{session}/manifest.mpd?token={}","a".repeat(64))});
        // These are the pure guards used by refresh_live_plan immediately after
        // publication and by owned_prepare's replay path, before its SQL gate.
        for account_id in [None, Some(Uuid::from_u128(9))] {
            body.native_platform.as_mut().unwrap().account_id = account_id;
            assert!(validate_request(&body).is_ok());
            assert!(validate_entry_intent(&body, "youtube").is_ok());
            assert!(
                validate_replay_credential_mode(
                    &body,
                    "youtube",
                    plan["native_platform"]["credential_mode"].as_str().unwrap()
                )
                .is_ok()
            );
            assert!(live_delivery_token(&plan, session).is_ok());
        }
        assert!(validate_replay_credential_mode(&body, "youtube", "anonymous").is_err());
        body.native_platform.as_mut().unwrap().account_id = None;
        body.native_platform.as_mut().unwrap().credential_mode =
            protocol::NativePlatformCredentialMode::Anonymous;
        assert!(validate_replay_credential_mode(&body, "youtube", "own_account").is_err());
    }
    #[test]
    fn native_request_requires_generation_and_closed_credential_intent() {
        assert!(validate_request(&request()).is_ok());
        let mut body = request();
        body.viewer_id = None;
        assert!(validate_request(&body).is_err());
        let mut body = request();
        body.plan_generation = Some(0);
        assert!(validate_request(&body).is_err());
        let mut body = request();
        body.audio_index = Some(0);
        assert!(validate_request(&body).is_err());
        let mut body = request();
        body.static_hls_fallback_version = Some(1);
        assert!(validate_request(&body).is_err());
        let mut body = request();
        body.local_hls_ladder = Some(protocol::LocalHlsLadderRequest { schema_version: 1 });
        assert!(validate_request(&body).is_err());
        let mut body = request();
        body.mode = Some("transcode".into());
        assert!(validate_request(&body).is_err());
        let mut body = request();
        body.native_platform.as_mut().unwrap().credential_mode =
            protocol::NativePlatformCredentialMode::Anonymous;
        body.native_platform.as_mut().unwrap().account_id = Some(Uuid::new_v4());
        assert!(validate_request(&body).is_err());
    }
}
