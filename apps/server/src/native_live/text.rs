//! Private live text relay: same exact viewer/login/account/media/broadcast
//! authority as HLS, no shared socket/client ID, raw user fields or persistence.
use super::*;
use axum::extract::Query;
use futures_util::stream;
use providers::platform::{
    bilibili,
    text::{self, Availability, TextRequest},
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryToken {
    token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamQuery {
    token: String,
    consent_client_id: u32,
}
fn live_text_error(error: bilibili::Error) -> Error {
    match error {
        bilibili::Error::Restricted("live_danmaku_auth_denied") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_live_danmaku_auth_denied",
        ),
        bilibili::Error::Restricted("live_danmaku_protocol_unsupported") => err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_live_danmaku_protocol_unsupported",
        ),
        bilibili::Error::Restricted("live_danmaku_closed") => {
            err(StatusCode::GONE, "native_live_danmaku_closed")
        }
        other => provider_error(other),
    }
}
// The upstream-request deadline helper caps a fetch at 20 seconds. A relay
// instead retains one monotonic deadline for the original immutable grant;
// setup, heartbeat writes and reads still use their own shorter bounds.
fn relay_deadline(expires: i64, now: i64, began: Instant) -> Result<Instant> {
    let remaining = expires
        .checked_sub(now)
        .filter(|value| *value > 0)
        .ok_or_else(invalid)?;
    began
        .checked_add(Duration::from_millis(remaining.min(MAX_GRANT_MS) as u64))
        .ok_or_else(invalid)
}
async fn scope(
    app: &App,
    headers: &HeaderMap,
    session: Uuid,
    token: &str,
) -> Result<(
    delivery::Authority,
    delivery::Grant,
    platform_accounts::FrozenAccount,
)> {
    let (authority, grant, _) = delivery::admit(
        app,
        headers,
        session,
        &delivery::TokenQuery {
            token: token.into(),
        },
    )
    .await?;
    let account = account_for(app, authority.user, &grant.sealed.binding).await?;
    let deadline = delivery::deadline(grant.expires)?.min(Instant::now() + Duration::from_secs(20));
    verify_broadcast(app, &grant.sealed.binding.resource, &account, deadline).await?;
    delivery::check(app, &authority).await?;
    Ok((authority, grant, account))
}
pub async fn catalog(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<QueryToken>,
) -> Result<Response> {
    let (authority, _, _) = scope(&app, &headers, session, &query.token).await?;
    delivery::check(&app, &authority).await?;
    Ok(media_titles::private_json(
        json!({"subtitle_tracks":[],"subtitles_status":Availability::Unsupported,"danmaku_status":Availability::Available}),
    ))
}
pub async fn history(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<QueryToken>,
) -> Result<Response> {
    let (authority, grant, account) = scope(&app, &headers, session, &query.token).await?;
    let identity = grant.sealed.binding.resource;
    let room = identity.room_id().parse::<u64>().map_err(|_| invalid())?;
    let started = identity
        .broadcast_id()
        .rsplit(':')
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(invalid)?;
    let deadline = delivery::deadline(grant.expires)?.min(Instant::now() + Duration::from_secs(20));
    let bytes = text::fetch(
        &app.platform_http,
        TextRequest::bilibili_live_history(room).map_err(live_text_error)?,
        deadline,
    )
    .await
    .map_err(live_text_error)?;
    let now = u64::try_from(now_ms()?).map_err(|_| invalid())?;
    let cues = text::live::parse_history(&bytes, started, now).map_err(live_text_error)?;
    verify_broadcast(&app, &identity, &account, deadline).await?;
    delivery::check(&app, &authority).await?;
    Ok(media_titles::private_json(
        json!({"cues":cues,"snapshot":true,"broadcast_started_ms":started*1000,"server_now_ms":now}),
    ))
}
struct Relay {
    app: App,
    authority: delivery::Authority,
    identity: Identity,
    account: platform_accounts::FrozenAccount,
    socket: text::live::Socket,
    until: Instant,
    next_heartbeat: Instant,
    last_heartbeat_reply: Instant,
    next_broadcast_check: Instant,
    started_ms: u64,
    bytes: usize,
    terminal: bool,
}
impl Relay {
    async fn next(mut self) -> Option<(std::io::Result<axum::body::Bytes>, Self)> {
        if self.terminal {
            return None;
        }
        let result: Result<Vec<u8>> = async {
            if Instant::now() >= self.until {
                return Err(invalid());
            }
            delivery::check(&self.app, &self.authority).await?;
            // Independent delivery owner checks durable authority even while
            // a client stops polling; this source also fences the broadcast.
            if Instant::now() >= self.next_broadcast_check {
                verify_broadcast(
                    &self.app,
                    &self.identity,
                    &self.account,
                    self.until.min(Instant::now() + Duration::from_secs(3)),
                )
                .await?;
                self.next_broadcast_check = Instant::now() + Duration::from_secs(10);
            }
            if Instant::now().duration_since(self.last_heartbeat_reply) > Duration::from_secs(60) {
                return Err(err(
                    StatusCode::GATEWAY_TIMEOUT,
                    "native_live_danmaku_heartbeat_timeout",
                ));
            }
            if Instant::now() >= self.next_heartbeat {
                self.socket
                    .heartbeat(self.until.min(Instant::now() + Duration::from_secs(3)))
                    .await
                    .map_err(live_text_error)?;
                self.next_heartbeat = Instant::now() + Duration::from_secs(30);
            }
            let events = match self
                .socket
                .next(self.until.min(Instant::now() + Duration::from_secs(2)))
                .await
            {
                Ok(events) => events,
                Err(bilibili::Error::Deadline) if Instant::now() < self.until => Vec::new(),
                Err(error) => return Err(live_text_error(error)),
            };
            delivery::check(&self.app, &self.authority).await?;
            let now = u64::try_from(now_ms()?).map_err(|_| invalid())?;
            let mut cues = Vec::new();
            for event in events {
                if event == text::live::Event::Heartbeat {
                    self.last_heartbeat_reply = Instant::now();
                }
                if let text::live::Event::Text { epoch_ms, text } = event {
                    if epoch_ms < self.started_ms || epoch_ms + 120_000 < now {
                        continue;
                    }
                    if epoch_ms > now + 5000 {
                        return Err(invalid());
                    }
                    cues.push(text::DanmakuCue {
                        at_ms: epoch_ms - self.started_ms,
                        text,
                        mode: text::DanmakuMode::Scroll,
                        style: None,
                        position: None,
                        advanced_unsupported: None,
                    });
                }
            }
            let cues = text::bounded_danmaku(cues);
            let mut bytes = serde_json::to_vec(&json!({
                "cues": cues, "snapshot": false,
                "broadcast_started_ms": self.started_ms, "server_now_ms": now,
            }))
            .map_err(anyhow::Error::from)?;
            bytes.push(b'\n');
            self.bytes = self.bytes.checked_add(bytes.len()).ok_or_else(invalid)?;
            if self.bytes > text::MAX_TEXT_BYTES {
                return Err(err(
                    StatusCode::BAD_GATEWAY,
                    "native_live_danmaku_output_limit",
                ));
            }
            Ok(bytes)
        }
        .await;
        match result {
            Ok(bytes) => Some((Ok(bytes.into()), self)),
            Err(error) => {
                self.terminal = true;
                let code = protocol::ErrorCode::from_reason(&error.1, error.0.as_u16());
                let message = protocol::ApiError::new(code, Uuid::new_v4());
                let mut bytes = serde_json::to_vec(&json!({"error":message})).unwrap_or_default();
                bytes.push(b'\n');
                Some((Ok(bytes.into()), self))
            }
        }
    }
}
pub async fn realtime(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<StreamQuery>,
) -> Result<Response> {
    if query.consent_client_id != 1 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "native_live_danmaku_client_id_consent_required",
        ));
    }
    let (authority, grant, account) = scope(&app, &headers, session, &query.token).await?;
    let expires = grant.expires;
    let identity = grant.sealed.binding.resource;
    let room = identity.room_id().parse::<u64>().map_err(|_| invalid())?;
    let started_ms = identity
        .broadcast_id()
        .rsplit(':')
        .next()
        .and_then(|v| v.parse::<u64>().ok())
        .and_then(|v| v.checked_mul(1000))
        .ok_or_else(invalid)?;
    let began = Instant::now();
    let until = relay_deadline(expires, now_ms()?, began)?;
    let registry = app.live_playback.deliveries.clone();
    let check_app = app.clone();
    let check_authority = authority.clone();
    let checker: media_core::finite_delivery::Checker = Arc::new(move || {
        let app = check_app.clone();
        let authority = check_authority.clone();
        Box::pin(async move {
            delivery::check(&app, &authority)
                .await
                .map_err(|_| anyhow::anyhow!("native_live_danmaku_ended"))?;
            let left = expires
                .checked_sub(now_ms().map_err(|_| anyhow::anyhow!("native_live_danmaku_ended"))?)
                .filter(|v| *v > 0)
                .ok_or_else(|| anyhow::anyhow!("native_live_danmaku_ended"))?;
            Ok(media_core::finite_delivery::Evidence {
                grant_remaining: Duration::from_millis(left as u64),
                lease_remaining: Duration::from_secs(2).min(Duration::from_millis(left as u64)),
            })
        })
    });
    media_core::finite_delivery::serve(
        registry,
        checker,
        move || async move {
            let deadline = until.min(Instant::now() + Duration::from_secs(20));
            // One legitimate nav, SPI issuance and signed discovery. No persistent
            // cookie/device identifier, blank-token fallback or challenged retry.
            let nav = bilibili::Client::new(app.platform_http, account.cookie().cloned())
                .nav(deadline)
                .await
                .map_err(live_text_error)?;
            if account.account_id().is_some() && !nav.is_logged_in {
                return Err(err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "native_live_danmaku_login_required",
                ));
            }
            delivery::check(&app, &authority).await?;
            let client_id = text::live::parse_client_id(
                &text::fetch(
                    &app.platform_http,
                    TextRequest::bilibili_client_id(),
                    deadline,
                )
                .await
                .map_err(live_text_error)?,
            )
            .map_err(live_text_error)?;
            let now = u64::try_from(now_ms()? / 1000).map_err(|_| invalid())?;
            let discovery = text::live::parse_discovery(
                &text::fetch(
                    &app.platform_http,
                    TextRequest::bilibili_live_info(
                        room,
                        &nav.wbi,
                        now,
                        account.cookie(),
                        &client_id,
                    )
                    .map_err(live_text_error)?,
                    deadline,
                )
                .await
                .map_err(live_text_error)?,
                room,
                if nav.is_logged_in {
                    nav.user_id
                        .as_deref()
                        .and_then(|id| id.parse::<u64>().ok())
                        .filter(|id| *id > 0)
                        .ok_or_else(invalid)?
                } else {
                    0
                },
            )
            .map_err(live_text_error)?;
            verify_broadcast(&app, &identity, &account, deadline).await?;
            delivery::check(&app, &authority).await?;
            let mut socket = app
                .platform_http
                .connect_live_text(&discovery, deadline)
                .await
                .map_err(live_text_error)?;
            socket
                .authenticate(&discovery, &client_id, deadline)
                .await
                .map_err(live_text_error)?;
            verify_broadcast(&app, &identity, &account, deadline).await?;
            delivery::check(&app, &authority).await?;
            let relay = Relay {
                app,
                authority,
                identity,
                account,
                socket,
                until,
                next_heartbeat: Instant::now(),
                last_heartbeat_reply: Instant::now(),
                next_broadcast_check: Instant::now() + Duration::from_secs(10),
                started_ms,
                bytes: 0,
                terminal: false,
            };
            let mut response = Response::new(axum::body::Body::from_stream(stream::unfold(
                relay,
                |relay| relay.next(),
            )));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                "application/x-ndjson; charset=utf-8".parse().unwrap(),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
            response
                .headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            response
                .headers_mut()
                .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
            response.headers_mut().insert(
                "cross-origin-resource-policy",
                "same-origin".parse().unwrap(),
            );
            Ok(response)
        },
        Arc::new(invalid),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_uses_original_grant_window_without_fetch_cap_or_renewal() {
        let began = Instant::now();
        let now = 1_700_000_000_000;
        let until = relay_deadline(now + MAX_GRANT_MS, now, began).unwrap();
        assert_eq!(until.duration_since(began), Duration::from_secs(120));
        let setup_until = until.min(began + Duration::from_secs(20));
        assert_eq!(setup_until.duration_since(began), Duration::from_secs(20));
        // Even if setup takes its whole allowance, recurring heartbeat and
        // missing-reply checks remain reachable within the unchanged grant.
        assert!(setup_until + Duration::from_secs(30) < until);
        assert!(setup_until + Duration::from_secs(60) < until);
        assert_eq!(
            until.duration_since(began + Duration::from_secs(70)),
            Duration::from_secs(50)
        );
        assert_eq!(
            relay_deadline(now + 70_000, now, began).unwrap(),
            began + Duration::from_secs(70)
        );
        assert_eq!(
            relay_deadline(now + MAX_GRANT_MS + 1, now, began).unwrap(),
            until
        );
        assert!(relay_deadline(now, now, began).is_err());
        assert!(relay_deadline(now - 1, now, began).is_err());
        assert!(relay_deadline(i64::MAX, i64::MIN, began).is_err());
    }
}
