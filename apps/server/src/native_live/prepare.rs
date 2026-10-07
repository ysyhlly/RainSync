use super::*;

pub(crate) async fn is_live_request(
    app: &App,
    headers: &HeaderMap,
    body: &protocol::PlaybackRequest,
) -> Result<bool> {
    let user = auth_viewer(app, headers, true).await?;
    member(app, &user, body.room_id).await?;
    // Inspect the authoritative current selection, regardless of the supplied
    // generation. A stale client can never route a live row into finite VOD.
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM room_snapshots s JOIN room_platform_media e ON e.room_id=s.room_id AND e.media_id::text=s.state->>'media_id' WHERE s.room_id=$1 AND e.resource_kind='live')").bind(body.room_id).fetch_one(&app.db).await?)
}
fn validate(body: &protocol::PlaybackRequest) -> Result<()> {
    let intent = body
        .native_platform
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "native_platform_intent_required"))?;
    if intent.live_version != Some(1) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_live_client_unsupported",
        ));
    }
    if intent.compatibility.is_some()
        || intent.course_version.is_some()
        || intent.version != 1
        || intent.quality.is_some()
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
        || body
            .mode
            .as_deref()
            .is_some_and(|v| !matches!(v, "auto" | "direct"))
        || body.observation_version.is_some_and(|v| v != 1)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_intent",
        ));
    }
    if !body.position_ms.is_finite() || body.position_ms != 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "native_live_seek_unsupported"));
    }
    if !body
        .capabilities
        .as_ref()
        .is_some_and(protocol::PlaybackCapabilities::supports_hls)
    {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_device_unsupported",
        ));
    }
    playback_metrics::validate(body)?;
    Ok(())
}
pub(crate) async fn prepare(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<protocol::PlaybackRequest>,
) -> Result<Json<Value>> {
    validate(&body)?;
    let user = auth_viewer(&app, &headers, true).await?;
    member(&app, &user, body.room_id).await?;
    let login = media_authorization::login_hash(&headers)?;
    let owner = app.preparations.admit().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "playback_request_interrupted",
        )
    })?;
    tokio::spawn(owned(app, user, body, login, owner))
        .await
        .map_err(anyhow::Error::from)?
}
async fn owned(
    app: App,
    user: User,
    body: protocol::PlaybackRequest,
    login: String,
    owner: preparation_owner::Owner,
) -> Result<Json<Value>> {
    let reservation =
        match playback_requests::begin_authenticated(&app, user.id, &body, Some(&login)).await? {
            playback_requests::Start::Reserved(value) => value,
            playback_requests::Start::Replay(mut plan) => {
                refresh(&app, user.id, &body, &login, &mut plan).await?;
                return Ok(Json(plan));
            }
            playback_requests::Start::StaticHlsPublished { .. } => {
                return Err(err(
                    StatusCode::BAD_REQUEST,
                    "native_platform_invalid_intent",
                ));
            }
        };
    let outcome = tokio::select! {biased;_=owner.cancelled()=>Err(err(StatusCode::SERVICE_UNAVAILABLE,"playback_request_interrupted")),value=tokio::time::timeout(Duration::from_secs(45),publish(&app,&user,&body,&login,&reservation))=>value.unwrap_or_else(|_|Err(err(StatusCode::GATEWAY_TIMEOUT,"playback_request_interrupted")))};
    let result = match outcome {
        Ok(mut plan) => refresh(&app, user.id, &body, &login, &mut plan)
            .await
            .map(|_| Json(plan)),
        Err(error) => match playback_requests::fail(&app, &reservation, &error).await {
            Ok(Some(mut plan)) => refresh(&app, user.id, &body, &login, &mut plan)
                .await
                .map(|_| Json(plan)),
            Ok(None) => Err(error),
            Err(error) => Err(error),
        },
    };
    tokio::spawn(async move {
        owner.acknowledge(&app, &reservation).await;
    });
    result
}
fn build_live_plan(
    entry: &Entry,
    reservation: &playback_requests::Reservation,
    account: &platform_accounts::FrozenAccount,
    body: &protocol::PlaybackRequest,
    remaining: u32,
    delivery_token: &str,
) -> protocol::PlaybackPlan {
    protocol::PlaybackPlan {
        distributed_compute: None,
        local_hls_ladder: None,
        advanced_playback: None,
        upstream_profile: None,
        native_platform: Some(protocol::NativePlatformPlaybackBinding {
            compatibility: None,
            version: 1,
            course_version: None,
            provider: protocol::NativePlatformProvider::Bilibili,
            credential_mode: if account.account_id().is_some() {
                protocol::NativePlatformResolvedCredentialMode::OwnAccount
            } else {
                protocol::NativePlatformResolvedCredentialMode::Anonymous
            },
            refresh_after_seconds: remaining.saturating_sub(30).max(1),
            quality: None,
            live: Some(protocol::NativePlatformLiveBinding {
                version: 1,
                broadcast_id: entry.identity.broadcast_id().into(),
                sync_mode: protocol::NativePlatformLiveSyncMode::LiveEdgeControl,
            }),
        }),
        session_id: reservation.session,
        plan_generation: reservation.plan_generation,
        media_id: entry.media,
        media_generation: body.media_generation,
        delivery_mode: "direct".into(),
        transport: "hls".into(),
        playback_url: format!(
            "/api/v1/platform-live-delivery/{}/playlist.m3u8?token={delivery_token}",
            reservation.session
        ),
        timeline_origin_ms: 0.0,
        duration_ms: None,
        expires_in_seconds: remaining,
        rebuild_on_seek: false,
        audio_tracks: vec![],
        subtitle_tracks: vec![],
        decision_reason: Some("native_live_edge_control".into()),
        selected_audio_track: None,
        selected_candidate_id: None,
        selected_output: None,
        subtitle_mode: Some(protocol::SubtitleDeliveryMode::None),
        seekable_media_ranges_ms: Some(vec![]),
        pending_job_id: None,
        decoder_fallback_modes: Some(vec![]),
        http_file_fallback_version: None,
        static_hls_fallback_version: None,
        observation_version: None,
        observation_seq: None,
        playback_metrics_version: None,
        playback_metrics: None,
    }
}
async fn publish(
    app: &App,
    user: &User,
    body: &protocol::PlaybackRequest,
    login: &str,
    reservation: &playback_requests::Reservation,
) -> Result<Value> {
    let mut before = app.db.begin().await?;
    playback_requests::guard(app, &mut before, reservation).await?;
    let entry = capture(&mut before, body.room_id, body.media_generation).await?;
    before.rollback().await?;
    let intent = body.native_platform.as_ref().ok_or_else(invalid)?;
    let account = match intent.credential_mode {
        protocol::NativePlatformCredentialMode::Anonymous => {
            platform_accounts::FrozenAccount::anonymous(user.id)
        }
        protocol::NativePlatformCredentialMode::OwnOrAnonymous => {
            platform_accounts::load_for_provider_playback(app, user.id, "bilibili").await?
        }
    };
    if intent.account_id.is_some() && intent.account_id != account.account_id() {
        return Err(err(StatusCode::CONFLICT, "platform_account_changed"));
    }
    let mut before = app.db.begin().await?;
    playback_requests::guard(app, &mut before, reservation).await?;
    guard(&mut before, &entry, body.media_generation).await?;
    platform_accounts::guard_for_publish(&mut before, user.id, &account).await?;
    before.rollback().await?;
    let deadline = Instant::now() + Duration::from_secs(35);
    let resolved = bound_resolve(app, &entry.identity, &account, deadline).await?;
    let response = app
        .platform_http
        .live_playlist(&resolved.playlist_url, deadline)
        .await
        .map_err(provider_error)?;
    let playlist =
        parse_bound_playlist(app, &entry.identity, &response.body, &resolved.playlist_url).await?;
    verify_broadcast(app, &entry.identity, &account, deadline).await?;
    let binding = Binding {
        version: 3,
        provider: "bilibili".into(),
        media_id: entry.media,
        room_id: entry.room,
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
        resource: entry.identity.clone(),
    };
    if !binding.matches(&entry) {
        return Err(invalid());
    }
    let sealed = Sealed {
        kind: "native_live".into(),
        version: 1,
        binding: binding.clone(),
        scope: GrantScope {
            session_id: reservation.session,
            viewer_id: reservation.viewer_id.ok_or_else(invalid)?,
            plan_generation: reservation.plan_generation.ok_or_else(invalid)?,
            media_generation: body.media_generation,
            auth_login_hash: login.into(),
            lifecycle_epoch: reservation.lifecycle_epoch,
        },
        resolved_at_ms: now_ms()?,
        url_expires_at_ms: resolved
            .expires_at
            .and_then(|v| i64::try_from(v).ok())
            .and_then(|v| v.checked_mul(1000)),
        playlist_url: resolved.playlist_url,
        current_quality: resolved.current_quality,
    };
    let mut expiry = sealed.deadline()?;
    if let Some(value) = account.credential_expires_at_ms() {
        expiry = expiry.min(value);
    }
    let resource = json!({"encrypted":app.encrypt(&serde_json::to_value(&sealed).map_err(anyhow::Error::from)?)?,"native_platform_context":binding});
    let delivery_token = token();
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    guard(&mut tx, &entry, body.media_generation).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, &account).await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    let login_expiry:i64=sqlx::query_scalar("SELECT floor(extract(epoch FROM expires_at)*1000)::bigint FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()").bind(login).bind(user.id).fetch_optional(&mut *tx).await?.ok_or_else(invalid)?;
    expiry = expiry.min(login_expiry);
    let remaining = expiry.checked_sub(now_ms()?).ok_or_else(invalid)? / 1000;
    if remaining < 2 {
        return Err(err(StatusCode::GONE, "native_platform_url_expired"));
    }
    let remaining = u32::try_from(remaining).map_err(|_| invalid())?;
    let public_plan = build_live_plan(
        &entry,
        reservation,
        &account,
        body,
        remaining,
        &delivery_token,
    );
    sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000.0),$9,$10,$11)")
        .bind(reservation.session).bind(user.id).bind(body.room_id).bind(entry.media).bind(i64::from(body.media_generation)).bind(hash(&delivery_token)).bind(&resource).bind(expiry).bind(reservation.lifecycle_epoch).bind(reservation.viewer_id).bind(reservation.plan_generation.map(i64::from)).execute(&mut *tx).await?;
    let mut plan = serde_json::to_value(&public_plan).map_err(anyhow::Error::from)?;
    // Live-edge/control playback has no certified original-media timeline, so
    // decoder PTS must never create an observation-v1 row or mapping grant.
    if let Some((version, grant)) = playback_metrics::publish(
        &mut tx,
        user.id,
        body,
        reservation.session,
        &json!({"kind":"native_platform","delivery_mode":"direct"}),
    )
    .await?
    {
        plan["playback_metrics_version"] = json!(version);
        plan["playback_metrics"] = grant;
    }
    guard(&mut tx, &entry, body.media_generation).await?;
    platform_accounts::guard_for_publish(&mut tx, user.id, &account).await?;
    playback_requests::guard(app, &mut tx, reservation).await?;
    playback_requests::complete(app, &mut tx, reservation, &plan).await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND expires_at>clock_timestamp() AND playback_source_allowed(media_id,resource,id))").bind(reservation.session).fetch_one(&mut *tx).await?;
    if !allowed {
        return Err(invalid());
    }
    let runtime = app
        .live_playback
        .runtime(reservation.session, &sealed, expiry)?;
    runtime
        .window
        .lock()
        .await
        .accept(playlist)
        .map_err(provider_error)?;
    tx.commit().await?;
    Ok(plan)
}
async fn refresh(
    app: &App,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    login: &str,
    plan: &mut Value,
) -> Result<()> {
    let session = plan["session_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(invalid)?;
    if plan["native_platform"]["live"]["version"] != 1
        || plan["native_platform"]["live"]["sync_mode"] != "live_edge_control"
        || plan["media_generation"] != body.media_generation
        || plan["plan_generation"].as_u64() != body.plan_generation.map(u64::from)
    {
        return Err(invalid());
    }
    let prefix = format!("/api/v1/platform-live-delivery/{session}/playlist.m3u8?token=");
    let token = plan["playback_url"]
        .as_str()
        .and_then(|v| v.strip_prefix(&prefix))
        .filter(|v| delivery::hex64(v))
        .ok_or_else(invalid)?;
    let authority = delivery::Authority {
        session,
        token_hash: hash(token),
        login_hash: login.into(),
        user,
    };
    let grant = delivery::load(app, &authority).await?;
    let decoded: protocol::PlaybackPlan =
        serde_json::from_value(plan.clone()).map_err(|_| invalid())?;
    let public = decoded.native_platform.as_ref().ok_or_else(invalid)?;
    if serde_json::to_value(&decoded).map_err(anyhow::Error::from)? != *plan
        || Some(grant.sealed.scope.viewer_id) != body.viewer_id
        || Some(grant.sealed.scope.plan_generation) != body.plan_generation
        || grant.sealed.scope.media_generation != body.media_generation
        || decoded.transport != "hls"
        || decoded.delivery_mode != "direct"
        || decoded.duration_ms.is_some()
        || decoded.timeline_origin_ms != 0.0
        || decoded.rebuild_on_seek
        || decoded.observation_version.is_some()
        || decoded.observation_seq.is_some()
        || !decoded.audio_tracks.is_empty()
        || !decoded.subtitle_tracks.is_empty()
        || decoded.seekable_media_ranges_ms.as_deref() != Some(&[])
        || public.provider != protocol::NativePlatformProvider::Bilibili
        || public.quality.is_some()
        || public.course_version.is_some()
        || !public
            .live
            .as_ref()
            .is_some_and(protocol::NativePlatformLiveBinding::valid)
        || ((public.credential_mode == protocol::NativePlatformResolvedCredentialMode::OwnAccount)
            != (grant.sealed.binding.credential_mode == "own_account"))
        || body
            .native_platform
            .as_ref()
            .and_then(|intent| intent.account_id)
            .is_some_and(|account| Some(account) != grant.sealed.binding.account_id)
        || (body.native_platform.as_ref().is_some_and(|intent| {
            intent.credential_mode == protocol::NativePlatformCredentialMode::Anonymous
        }) && grant.sealed.binding.account_id.is_some())
    {
        return Err(invalid());
    }
    if plan["media_id"] != grant.sealed.binding.media_id.to_string()
        || plan["native_platform"]["live"]["broadcast_id"]
            != grant.sealed.binding.resource.broadcast_id()
    {
        return Err(invalid());
    }
    let account = account_for(app, user, &grant.sealed.binding).await?;
    verify_broadcast(
        app,
        &grant.sealed.binding.resource,
        &account,
        Instant::now() + Duration::from_secs(20),
    )
    .await?;
    delivery::check(app, &authority).await?;
    let remaining = grant.expires.checked_sub(now_ms()?).ok_or_else(invalid)? / 1000;
    if remaining < 2 {
        return Err(err(StatusCode::GONE, "native_platform_url_expired"));
    }
    let previous = plan["expires_in_seconds"].as_u64().ok_or_else(invalid)?;
    plan["expires_in_seconds"] = json!(previous.min(remaining as u64));
    plan["native_platform"]["refresh_after_seconds"] =
        json!((remaining as u64).saturating_sub(30).max(1));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        json!({"room_id":Uuid::from_u128(1),"media_generation":2,"viewer_id":Uuid::from_u128(2),"plan_generation":1,"position_ms":0,"capabilities":{"progressive_h264_aac":false,"native_hls":false,"mse_h264_aac":true},"native_platform":{"version":1,"live_version":1,"credential_mode":"anonymous"}})
    }
    #[test]
    fn live_prepare_requires_explicit_opt_in_and_closed_live_edge_only_recipe() {
        let value = request();
        assert!(validate(&serde_json::from_value(value.clone()).unwrap()).is_ok());
        for (field, value) in [
            ("position_ms", json!(1)),
            ("mode", json!("transcode")),
            ("viewer_id", Value::Null),
            ("plan_generation", json!(0)),
            ("http_file_fallback_version", json!(1)),
            ("static_hls_fallback_version", json!(1)),
            ("audio_index", json!(0)),
        ] {
            let mut changed = request();
            changed[field] = value;
            assert!(
                validate(&serde_json::from_value(changed).unwrap()).is_err(),
                "{field}"
            );
        }
        for opt_in in [Value::Null, json!(2)] {
            let mut changed = request();
            changed["native_platform"]["live_version"] = opt_in;
            assert!(validate(&serde_json::from_value(changed).unwrap()).is_err());
        }
        let mut changed = request();
        changed["capabilities"]["mse_h264_aac"] = json!(false);
        assert!(validate(&serde_json::from_value(changed).unwrap()).is_err());
        let mut changed = request();
        changed["native_platform"]["url"] = json!("https://evil.invalid");
        assert!(serde_json::from_value::<protocol::PlaybackRequest>(changed).is_err());
        let mut native = request();
        native["capabilities"]["mse_h264_aac"] = json!(false);
        native["capabilities"]["native_hls"] = json!(true);
        assert!(validate(&serde_json::from_value(native).unwrap()).is_ok());
    }
    #[test]
    fn live_plans_never_negotiate_vod_position_observations() {
        let mut value = request();
        value["observation_version"] = json!(1);
        let body: protocol::PlaybackRequest = serde_json::from_value(value).unwrap();
        assert!(validate(&body).is_ok());
        let entry = Entry {
            media: Uuid::from_u128(8),
            room: body.room_id,
            revision: 1,
            identity: Identity::BilibiliLive {
                room_id: "7".into(),
                uid: "9".into(),
                broadcast_id: "7:9:1700000000".into(),
            },
        };
        let reservation = playback_requests::Reservation {
            prepare_until: tokio::time::Instant::now() + std::time::Duration::from_secs(45),
            key: Uuid::from_u128(10),
            session: Uuid::from_u128(11),
            user: Uuid::from_u128(12),
            room_id: body.room_id,
            lifecycle_epoch: 0,
            viewer_id: body.viewer_id,
            plan_generation: body.plan_generation,
            http_file: None,
            static_hls: None,
        };
        let account = platform_accounts::FrozenAccount::anonymous(reservation.user);
        let plan = build_live_plan(&entry, &reservation, &account, &body, 120, &"a".repeat(64));
        assert!(plan.observation_version.is_none());
        assert!(plan.observation_seq.is_none());
        let value = serde_json::to_value(&plan).unwrap();
        assert!(value.get("observation_version").is_none());
        assert!(value.get("observation_seq").is_none());
        assert_eq!(
            value["native_platform"]["live"]["sync_mode"],
            "live_edge_control"
        );
        assert_eq!(plan.duration_ms, None);
        assert_eq!(plan.timeline_origin_ms, 0.0);
    }
}
