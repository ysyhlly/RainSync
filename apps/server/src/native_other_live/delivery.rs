//! Every playlist edge and every byte uses the exact durable viewer/login/
//! account/member/media/plan/broadcast fence. Tokens never authorize alone.
use super::*;
use axum::{extract::Query, http::Method};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenQuery {
    pub(super) token: String,
}
#[derive(Clone)]
pub(super) struct Authority {
    pub session: Uuid,
    pub token_hash: String,
    pub login_hash: String,
    pub user: Uuid,
}
pub(super) struct Grant {
    pub sealed: Sealed,
    pub expires: i64,
}
pub(super) fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
pub(super) async fn check(app: &App, authority: &Authority) -> Result<()> {
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE})"
    );
    match tokio::time::timeout(
        Duration::from_secs(2),
        database_checks::boolean(
            &app.db,
            sqlx::query_scalar(&sql)
                .bind(authority.session)
                .bind(&authority.token_hash)
                .bind(&authority.login_hash)
                .bind(authority.user),
            1500,
        ),
    )
    .await
    {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(invalid()),
        _ => Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")),
    }
}
pub(super) async fn load(app: &App, authority: &Authority) -> Result<Grant> {
    let sql = format!(
        "SELECT p.media_id,p.room_id,p.user_id,p.viewer_id,p.plan_generation,p.generation,p.lifecycle_epoch,p.resource,floor(extract(epoch FROM p.expires_at)*1000)::bigint AS expires FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE}"
    );
    let row = sqlx::query(&sql)
        .bind(authority.session)
        .bind(&authority.token_hash)
        .bind(&authority.login_hash)
        .bind(authority.user)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(invalid)?;
    let scope = GrantScope {
        session_id: authority.session,
        viewer_id: row
            .get::<Option<Uuid>, _>("viewer_id")
            .ok_or_else(invalid)?,
        plan_generation: row
            .get::<Option<i64>, _>("plan_generation")
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(invalid)?,
        media_generation: u32::try_from(row.get::<i64, _>("generation")).map_err(|_| invalid())?,
        auth_login_hash: authority.login_hash.clone(),
        lifecycle_epoch: row.get("lifecycle_epoch"),
    };
    let grant = decode(
        app,
        row.get("resource"),
        row.get("media_id"),
        row.get("room_id"),
        row.get("user_id"),
        row.get("expires"),
        &scope,
    )?;
    check(app, authority).await?;
    Ok(grant)
}
fn decode(
    app: &App,
    resource: Value,
    media: Uuid,
    room: Uuid,
    user: Uuid,
    expires: i64,
    scope: &GrantScope,
) -> Result<Grant> {
    let fields = resource.as_object().ok_or_else(invalid)?;
    if fields.len() != 3
        || !fields.contains_key("encrypted")
        || !fields.contains_key("native_platform_context")
        || !fields.contains_key("auth_context")
    {
        return Err(invalid());
    }
    let cipher = resource["encrypted"]
        .as_str()
        .filter(|v| v.len() <= 64 * 1024)
        .ok_or_else(invalid)?;
    let plaintext = app.decrypt(cipher).map_err(|_| invalid())?;
    validate_plaintext(
        plaintext,
        &resource["native_platform_context"],
        media,
        room,
        user,
        expires,
        scope,
    )
}
fn validate_plaintext(
    plaintext: Value,
    public: &Value,
    media: Uuid,
    room: Uuid,
    user: Uuid,
    expires: i64,
    scope: &GrantScope,
) -> Result<Grant> {
    let sealed: Sealed = serde_json::from_value(plaintext.clone()).map_err(|_| invalid())?;
    if serde_json::to_value(&sealed).map_err(anyhow::Error::from)? != plaintext
        || serde_json::to_value(&sealed.binding).map_err(anyhow::Error::from)? != *public
        || sealed.binding.media_id != media
        || sealed.binding.room_id != room
        || sealed.binding.user_id != user
        || sealed.scope != *scope
        || expires > sealed.deadline()?
        || expires <= sealed.resolved_at_ms
    {
        return Err(invalid());
    }
    Ok(Grant { sealed, expires })
}
pub(super) async fn admit(
    app: &App,
    headers: &HeaderMap,
    session: Uuid,
    query: &TokenQuery,
) -> Result<(Authority, Grant, Arc<Runtime>)> {
    if !app.other_live_enabled {
        return Err(err(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_other_live_provider_unavailable",
        ));
    }
    let user = auth(app, headers, false).await?;
    if !hex64(&query.token) {
        return Err(invalid());
    }
    let authority = Authority {
        session,
        token_hash: hash(&query.token),
        login_hash: media_authorization::login_hash(headers)?,
        user: user.id,
    };
    let grant = load(app, &authority).await?;
    let runtime = app
        .other_live_playback
        .runtime(session, &grant.sealed, grant.expires)?;
    Ok((authority, grant, runtime))
}
pub(super) fn private(response: &mut Response, content_type: &'static str, length: usize) {
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    headers.insert(
        "cross-origin-resource-policy",
        "same-origin".parse().unwrap(),
    );
}
pub(super) fn deadline(expires: i64) -> Result<Instant> {
    let remaining = expires
        .checked_sub(now_ms()?)
        .filter(|v| *v > 0)
        .ok_or_else(invalid)?;
    Ok(Instant::now() + Duration::from_millis(remaining.min(20_000) as u64))
}
pub(super) fn key(identity: &Identity, segment: &live::Segment) -> Result<String> {
    let url =
        live::validate_segment_url(identity.provider()?, &segment.url).map_err(provider_error)?;
    // Signed query renewal doesn't change the immutable graph edge identity.
    Ok(hash(&format!(
        "{}|{}|{}|{}|{}",
        identity.broadcast_id(),
        segment.sequence,
        segment.discontinuity,
        url.origin().ascii_serialization(),
        url.path()
    )))
}
fn rewrite(
    playlist: &live::Playlist,
    identity: &Identity,
    session: Uuid,
    token: &str,
) -> Result<String> {
    playlist
        .rewrite(|segment| {
            let key = key(identity, segment).map_err(|_| {
                providers::platform::bilibili::Error::InvalidResponse("live_graph_key")
            })?;
            Ok(format!(
                "/api/v1/platform-other-live-delivery/{session}/segments/{key}?token={token}"
            ))
        })
        .map_err(provider_error)
}
fn method_allowed(method: &Method, headers: &HeaderMap) -> Result<()> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return Err(err(StatusCode::METHOD_NOT_ALLOWED, "invalid_request"));
    }
    if headers.contains_key(header::RANGE) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_platform_invalid_range",
        ));
    }
    Ok(())
}
pub async fn playlist(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<TokenQuery>,
    method: Method,
) -> Result<Response> {
    method_allowed(&method, &headers)?;
    let (authority, grant, runtime) = admit(&app, &headers, session, &query).await?;
    runtime.admit(true)?;
    let work_app = app.clone();
    let work_authority = authority.clone();
    let expires = grant.expires;
    producer::owned_response(app, authority, expires, None, async move {
        let app = work_app;
        // Serialize reloads for this immutable grant. Fast polls reuse only the
        // already verified bounded graph and cannot trigger unbounded provider IO.
        let _reload = runtime
            .reload
            .try_lock()
            .map_err(|_| err(StatusCode::TOO_MANY_REQUESTS, "native_live_rate_limited"))?;
        let cached = {
            let state = runtime.window.lock().await;
            state.latest().cloned()
        };
        let can_reload = {
            let last = runtime.last_reload.lock().map_err(|_| invalid())?;
            cached.as_ref().is_none_or(|playlist| {
                last.is_none_or(|value| {
                    value.elapsed()
                        >= Duration::from_millis(
                            u64::from(playlist.target_duration_ms / 2).max(1000),
                        )
                })
            })
        };
        let current = if can_reload {
            check(&app, &work_authority).await?;
            let account = account_for(&app, work_authority.user, &grant.sealed.binding).await?;
            let deadline = deadline(grant.expires)?;
            let resolved =
                bound_resolve(&app, &grant.sealed.binding.resource, &account, deadline).await?;
            check(&app, &work_authority).await?;
            let target = playlist_target(&grant.sealed, &resolved)?;
            let response = app
                .platform_http
                .other_live_playlist(resolved.metadata.provider, target, deadline)
                .await
                .map_err(provider_error)?;
            let next =
                parse_bound_playlist(&app, &grant.sealed.binding.resource, &response.body, target)
                    .await?;
            verify_broadcast(&app, &grant.sealed.binding.resource, &account, deadline).await?;
            check(&app, &work_authority).await?;
            let mut state = runtime.window.lock().await;
            state.accept(next).map_err(|error| match error {
                error @ providers::platform::bilibili::Error::Restricted("live_window_expired") => {
                    provider_error(error)
                }
                _ => err(StatusCode::CONFLICT, "native_live_playlist_changed"),
            })?;
            *runtime.last_reload.lock().map_err(|_| invalid())? = Some(Instant::now());
            state.latest().cloned().ok_or_else(invalid)?
        } else {
            let account = account_for(&app, work_authority.user, &grant.sealed.binding).await?;
            verify_broadcast(
                &app,
                &grant.sealed.binding.resource,
                &account,
                deadline(grant.expires)?,
            )
            .await?;
            cached.ok_or_else(invalid)?
        };
        let text = rewrite(
            &current,
            &grant.sealed.binding.resource,
            session,
            &query.token,
        )?;
        check(&app, &work_authority).await?;
        Ok(producer::Ready {
            payload: text.into_bytes(),
            permits: vec![],
            head: method == Method::HEAD,
            content_type: "application/vnd.apple.mpegurl",
        })
    })
    .await
}

pub async fn segment(
    State(app): State<App>,
    headers: HeaderMap,
    Path((session, segment_key)): Path<(Uuid, String)>,
    Query(query): Query<TokenQuery>,
    method: Method,
) -> Result<Response> {
    method_allowed(&method, &headers)?;
    if !hex64(&segment_key) {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    let (authority, grant, runtime) = admit(&app, &headers, session, &query).await?;
    runtime.admit(false)?;
    let work_app = app.clone();
    let work_authority = authority.clone();
    let expires = grant.expires;
    let graph = producer::Graph {
        runtime: Arc::downgrade(&runtime),
        identity: grant.sealed.binding.resource.clone(),
        key: segment_key.clone(),
    };
    producer::owned_response(app, authority, expires, Some(graph), async move {
        let app = work_app;
        let local_permit = runtime
            .segments
            .clone()
            .try_acquire_owned()
            .map_err(|_| err(StatusCode::TOO_MANY_REQUESTS, "native_live_capacity"))?;
        let global_permit = app
            .other_live_playback
            .bytes_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| err(StatusCode::TOO_MANY_REQUESTS, "native_live_capacity"))?;
        let target = {
            let state = runtime.window.lock().await;
            state
                .latest()
                .and_then(|playlist| {
                    playlist.segments.iter().find(|segment| {
                        key(&grant.sealed.binding.resource, segment)
                            .is_ok_and(|value| value == segment_key)
                    })
                })
                .cloned()
                .ok_or_else(|| err(StatusCode::GONE, "native_live_playlist_changed"))?
        };
        let fetch_deadline = deadline(grant.expires)?;
        // Header construction/source verification is independently bounded too,
        // including account/observation DB waits before the producer takes over.
        let upstream = tokio::time::timeout_at(fetch_deadline, async {
            let mut budget = runtime.reserve_bytes()?;
            check(&app, &work_authority).await?;
            let account = account_for(&app, work_authority.user, &grant.sealed.binding).await?;
            let deadline = fetch_deadline;
            verify_broadcast(&app, &grant.sealed.binding.resource, &account, deadline).await?;
            check(&app, &work_authority).await?;
            budget.start_fetch();
            let upstream = app
                .platform_http
                .other_live_segment(
                    grant.sealed.binding.resource.provider()?,
                    &target.url,
                    deadline,
                )
                .await
                .map_err(provider_error)?;
            // A successful fetch consumes the known bytes even if a later authority
            // check fails; an unknown-size failed fetch conservatively consumes its cap.
            budget.commit(upstream.body.len())?;
            // After the whole bounded upstream body, repeat broadcast/account/login/
            // membership checks before any application byte can be returned.
            verify_broadcast(&app, &grant.sealed.binding.resource, &account, deadline).await?;
            check(&app, &work_authority).await?;
            {
                let window = runtime.window.lock().await;
                if !window.latest().is_some_and(|playlist| {
                    playlist.segments.iter().any(|segment| {
                        key(&grant.sealed.binding.resource, segment)
                            .is_ok_and(|key| key == segment_key)
                    })
                }) {
                    return Err(err(StatusCode::GONE, "native_live_playlist_changed"));
                }
            }
            Ok::<_, Error>(upstream)
        })
        .await
        .map_err(|_| {
            err(
                StatusCode::GATEWAY_TIMEOUT,
                "native_platform_resolve_timeout",
            )
        })??;
        Ok(producer::Ready {
            payload: upstream.body,
            permits: vec![local_permit, global_permit],
            head: method == Method::HEAD,
            content_type: "video/mp2t",
        })
    })
    .await
}
