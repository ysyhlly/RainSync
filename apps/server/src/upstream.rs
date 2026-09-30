use super::*;
use persistence::upstream_reservations as ledger;
use std::{collections::BTreeMap, sync::Weak, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Default)]
struct Lane {
    origins: Mutex<HashMap<String, Weak<Semaphore>>>,
}

/// Cleanup has independent capacity: stalled negotiations cannot occupy it.
pub struct Runtime {
    negotiations: Arc<Semaphore>,
    reports: Arc<Semaphore>,
    cleanup: Arc<Semaphore>,
    negotiate_lane: Lane,
    report_lane: Lane,
    cleanup_lane: Lane,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            negotiations: Arc::new(Semaphore::new(4)),
            reports: Arc::new(Semaphore::new(4)),
            cleanup: Arc::new(Semaphore::new(4)),
            negotiate_lane: Lane::default(),
            report_lane: Lane::default(),
            cleanup_lane: Lane::default(),
        }
    }
}

impl Lane {
    async fn origin(&self, key: &str) -> Arc<Semaphore> {
        let mut origins = self.origins.lock().await;
        origins.retain(|_, semaphore| semaphore.strong_count() > 0);
        if let Some(semaphore) = origins.get(key).and_then(Weak::upgrade) {
            return semaphore;
        }
        let semaphore = Arc::new(Semaphore::new(2));
        origins.insert(key.into(), Arc::downgrade(&semaphore));
        semaphore
    }
}

struct Permits {
    _global: OwnedSemaphorePermit,
    _origin: OwnedSemaphorePermit,
}

impl Runtime {
    async fn negotiate_permit(&self, key: &str) -> Result<Permits> {
        let origin = self
            .negotiate_lane
            .origin(key)
            .await
            .acquire_owned()
            .await
            .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "upstream_playback_failed"))?;
        let global = self
            .negotiations
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "upstream_playback_failed"))?;
        Ok(Permits {
            _global: global,
            _origin: origin,
        })
    }
    async fn try_permit(&self, key: &str, stop: bool) -> Option<Permits> {
        let (lane, global) = if stop {
            (&self.cleanup_lane, &self.cleanup)
        } else {
            (&self.report_lane, &self.reports)
        };
        let origin = lane.origin(key).await.try_acquire_owned().ok()?;
        let global = global.clone().try_acquire_owned().ok()?;
        Some(Permits {
            _global: global,
            _origin: origin,
        })
    }
}

pub struct Prepare<'a> {
    pub reservation: &'a playback_requests::Reservation,
    pub room: Uuid,
    pub media: Uuid,
    pub source: Uuid,
    pub generation: u32,
    pub kind: &'a str,
    pub config: &'a providers::SourceConfig,
    pub item: &'a str,
    pub options: providers::PlaybackOptions,
}

fn identifier(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
}

/// Save encrypted scope before the wire request, then give negotiation an
/// independent owner. Dropping the prepare waiter does not lose a late SID.
pub async fn negotiate(app: &App, p: Prepare<'_>) -> Result<Value> {
    let device_id = format!("rainsync-{}", p.reservation.session);
    providers::upstream_headers(p.kind, p.config, &device_id)?;
    let origin_key = hash(
        providers::validate_url(&p.config.url)?
            .origin()
            .ascii_serialization()
            .as_str(),
    );
    let permits = app.upstream.negotiate_permit(&origin_key).await?;
    let scope = app.encrypt(&json!({"config":p.config,"item":p.item}))?;
    let mut tx = app.db.begin().await?;
    playback_requests::guard(app, &mut tx, p.reservation).await?;
    let state: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(p.room)
            .fetch_one(&mut *tx)
            .await?;
    if state["media_generation"].as_u64() != Some(u64::from(p.generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    ledger::reserve(
        &mut tx,
        &ledger::Reservation {
            id: p.reservation.session,
            user: p.reservation.user,
            request_key: p.reservation.key,
            owner_epoch: app.epoch,
            room: p.room,
            media: p.media,
            source: p.source,
            generation: i64::from(p.generation),
            kind: p.kind,
            device_id: &device_id,
            origin_key: &origin_key,
            scope_encrypted: &scope,
        },
    )
    .await?;
    tx.commit().await?;
    let id = p.reservation.session;
    let app = app.clone();
    let kind = p.kind.to_owned();
    let config = p.config.clone();
    let item = p.item.to_owned();
    let options = p.options;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _permits = permits;
        let result: Result<Value> = async {
            let token = Uuid::new_v4();
            if !ledger::begin_negotiation(&app.db, id, app.epoch, token).await? {
                let mut tx = app.db.begin().await?;
                ledger::close(&mut tx, id, "playback_request_interrupted").await?;
                tx.commit().await?;
                return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
            }
            let result = tokio::time::timeout(
                Duration::from_secs(ledger::NEGOTIATION_SECONDS),
                providers::upstream_plan(&kind, &config, &item, &options, &device_id)
            ).await;
            let info = match result {
                Ok(Ok(info)) => info,
                _ => {
                    ledger::negotiation_unknown(&app.db, id, token).await?;
                    return Err(err(StatusCode::BAD_GATEWAY, "upstream_playback_failed"));
                }
            };
            let sid = identifier(&info["PlaySessionId"]);
            let source = info["MediaSources"].as_array().and_then(|s| s.first());
            let media_source = source.and_then(|s| identifier(&s["Id"]));
            let live_stream = source.and_then(|s| identifier(&s["LiveStreamId"]));
            let encrypted = app.encrypt(&info)?;
            if !ledger::checkpoint(&app.db, id, token, &encrypted, sid, media_source, live_stream).await? || sid.is_none() {
                return Err(err(StatusCode::BAD_GATEWAY, "upstream_playback_failed"));
            }
            // A late checkpoint is retained after revoke. Only final activation
            // can grant media, and its transaction still checks request ownership.
            let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM upstream_reservations u JOIN playback_requests r ON r.session_id=u.id JOIN room_snapshots s ON s.room_id=u.room_id JOIN room_members m ON m.room_id=u.room_id AND m.user_id=u.user_id WHERE u.id=$1 AND u.state='preparing' AND r.status='pending' AND r.owner_epoch=$2 AND r.lease_until>clock_timestamp() AND (s.state->>'media_generation')::bigint=u.generation)")
                .bind(id).bind(app.epoch).fetch_one(&app.db).await?;
            if !valid {
                let mut tx = app.db.begin().await?;
                ledger::close(&mut tx, id, "playback_request_interrupted").await?;
                tx.commit().await?;
                return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
            }
            Ok(info)
        }.await;
        let _ = sender.send(result);
    });
    receiver
        .await
        .map_err(|_| err(StatusCode::CONFLICT, "playback_request_interrupted"))?
}

fn request_headers(
    request: reqwest::RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> reqwest::RequestBuilder {
    headers.iter().fold(request, |request, (name, value)| {
        request.header(name, value)
    })
}

fn report_body(app: &App, claim: &ledger::Claim, item: &str) -> anyhow::Result<Value> {
    let state = claim
        .state
        .clone()
        .map(serde_json::from_value::<protocol::RoomState>)
        .transpose()?;
    let position = state
        .as_ref()
        .map_or(0.0, |s| room_core::position(s, app.now()));
    Ok(json!({
        "ItemId":item,"PlaySessionId":claim.sid,"MediaSourceId":claim.media_source,
        "LiveStreamId":claim.live_stream,"PositionTicks":(position*10000.0).round() as u64,
        "IsPaused":state.as_ref().is_none_or(|s|s.playback_status!=protocol::PlaybackStatus::Playing),
        "CanSeek":true,"PlayMethod":claim.play_method.as_deref().unwrap_or("DirectPlay")
    }))
}

async fn perform(app: &App, claim: ledger::Claim) -> anyhow::Result<()> {
    let scope = app.decrypt(&claim.scope_encrypted)?;
    let config: providers::SourceConfig = serde_json::from_value(scope["config"].clone())?;
    let item = scope["item"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("upstream_scope_invalid"))?;
    let headers = providers::upstream_headers(&claim.kind, &config, &claim.device_id)?;
    let base = providers::validate_url(&format!("{}/", config.url.trim_end_matches('/')))?;
    let body = report_body(app, &claim, item)?;
    let endpoint = match claim.event.as_str() {
        "start" => "Sessions/Playing",
        "stop" => "Sessions/Playing/Stopped",
        _ => "Sessions/Playing/Progress",
    };
    let url = providers::upstream_url(&base, endpoint)?;
    if claim.event != "stop" {
        let successful = matches!(
            tokio::time::timeout(Duration::from_secs(ledger::CLEANUP_SECONDS), async {
                let response = request_headers(providers::client().post(url).json(&body), &headers)
                    .send()
                    .await?;
                Ok::<_, reqwest::Error>(providers::checkin_confirmed(response.status()))
            })
            .await,
            Ok(Ok(true))
        );
        ledger::finish_report(&app.db, &claim, successful).await?;
        return Ok(());
    }
    let mut stopped = claim.stop_confirmed;
    let mut encoding_stopped = claim.encoding_stop_confirmed;
    // One attempt has a total three-second budget, including both Emby calls.
    // A successful Stopped POST alone does not confirm its encoder stopped.
    let _ = tokio::time::timeout(Duration::from_secs(ledger::CLEANUP_SECONDS), async {
        if !stopped {
            let response = request_headers(providers::client().post(url).json(&body), &headers)
                .send()
                .await?;
            anyhow::ensure!(
                providers::checkin_confirmed(response.status()),
                "upstream_stop_unconfirmed"
            );
            stopped = true;
        }
        if claim.kind == "emby" && !encoding_stopped {
            let mut url = providers::upstream_url(&base, "Videos/ActiveEncodings")?;
            url.query_pairs_mut()
                .append_pair("DeviceId", &claim.device_id)
                .append_pair("PlaySessionId", &claim.sid);
            let response = request_headers(providers::client().delete(url), &headers)
                .send()
                .await?;
            anyhow::ensure!(
                response.status() == reqwest::StatusCode::OK,
                "upstream_encoding_stop_unconfirmed"
            );
            encoding_stopped = true;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await;
    ledger::finish_stop(&app.db, &claim, stopped, encoding_stopped).await?;
    if stopped && (claim.kind == "jellyfin" || encoding_stopped) {
        sqlx::query("UPDATE playback_sessions SET stopped=true,resource=resource||'{\"upstream_closed\":true}'::jsonb WHERE id=$1 AND EXISTS(SELECT 1 FROM upstream_reservations WHERE id=$1 AND state='closed')")
            .bind(claim.id).execute(&app.db).await?;
    }
    Ok(())
}

pub async fn report(app: &App, id: Uuid, event: &str) -> anyhow::Result<()> {
    let origin: Option<String> =
        sqlx::query_scalar("SELECT origin_key FROM upstream_reservations WHERE id=$1")
            .bind(id)
            .fetch_optional(&app.db)
            .await?;
    let Some(origin) = origin else {
        return legacy_report(app, id, event).await;
    };
    let Some(permits) = app.upstream.try_permit(&origin, false).await else {
        return Ok(());
    };
    let app = app.clone();
    // HTTP waiter cancellation cannot strand this claim until lease expiry.
    tokio::spawn(async move {
        let _permits = permits;
        if let Some(claim) = ledger::claim_io(&app.db, id, false).await? {
            perform(&app, claim).await?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    Ok(())
}

pub async fn maintenance(app: App) {
    tokio::spawn(legacy_maintenance(app.clone()));
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if ledger::reconcile(&app.db, app.epoch).await.is_err() {
            tracing::warn!("upstream reconciliation failed");
            continue;
        }
        for stop in [true, false] {
            let Ok(rows) = ledger::ready(&app.db, stop).await else {
                continue;
            };
            for (id, origin) in rows {
                let Some(permits) = app.upstream.try_permit(&origin, stop).await else {
                    continue;
                };
                let app = app.clone();
                tokio::spawn(async move {
                    let _permits = permits;
                    let result = async {
                        if let Some(claim) = ledger::claim_io(&app.db, id, stop).await? {
                            perform(&app, claim).await?;
                        }
                        Ok::<_, anyhow::Error>(())
                    }
                    .await;
                    if result.is_err() {
                        tracing::warn!(session=%id, "upstream operation failed");
                    }
                });
            }
        }
    }
}

/// Adapter for already published plans. Old Jellyfin used 'rainsync'; never
/// invent a new identity for an existing SID. Old Emby has no proven device.
async fn legacy_report(app: &App, id: Uuid, event: &str) -> anyhow::Result<()> {
    // Claim the I/O and retry budget together. A selected row can become busy,
    // renewed or stopped before this task runs; that does not spend an attempt.
    let claim_started = tokio::time::Instant::now();
    let token = Uuid::new_v4().to_string();
    let claimed: Option<Value> = sqlx::query_scalar("UPDATE playback_sessions p SET stopped=stopped OR $3::text='stop',resource=resource||jsonb_build_object('upstream_io_claim',$2::text,'upstream_io_kind',$3::text,'upstream_io_lease_until',CASE WHEN $3::text='stop' THEN LEAST(clock_timestamp()+interval '10 seconds',COALESCE((resource->>'upstream_cleanup_deadline')::timestamptz,clock_timestamp()+interval '60 seconds')) ELSE clock_timestamp()+interval '10 seconds' END,'upstream_io_pending',true,'upstream_io_uncertain',COALESCE((resource->>'upstream_io_uncertain')::boolean,false) OR (COALESCE((resource->>'upstream_io_pending')::boolean,false) AND COALESCE(resource->>'upstream_io_kind','progress')<>'stop'))||CASE WHEN $3::text='stop' THEN jsonb_build_object('upstream_cleanup_attempts',COALESCE((resource->>'upstream_cleanup_attempts')::integer,0)+1,'upstream_cleanup_deadline',COALESCE((resource->>'upstream_cleanup_deadline')::timestamptz,clock_timestamp()+interval '60 seconds'),'upstream_cleanup_after',clock_timestamp()+make_interval(secs=>LEAST(16,power(2,COALESCE((resource->>'upstream_cleanup_attempts')::integer,0)+1)::integer))) ELSE jsonb_build_object('upstream_last_report_at',clock_timestamp()) END WHERE id=$1 AND NOT(resource ? 'upstream_closed') AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=p.id) AND (NOT(resource ? 'upstream_io_claim') OR (resource->>'upstream_io_lease_until')::timestamptz<=clock_timestamp()) AND CASE WHEN $3::text='stop' THEN COALESCE((resource->>'upstream_cleanup_attempts')::integer,0)<5 AND (NOT(resource ? 'upstream_cleanup_deadline') OR (resource->>'upstream_cleanup_deadline')::timestamptz>clock_timestamp()) AND (NOT(resource ? 'upstream_cleanup_after') OR (resource->>'upstream_cleanup_after')::timestamptz<=clock_timestamp()) AND (stopped OR expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM room_snapshots s WHERE s.room_id=p.room_id AND (s.state->>'media_generation')::bigint<>p.generation)) ELSE NOT stopped AND expires_at>clock_timestamp() AND NOT COALESCE((resource->>'upstream_io_uncertain')::boolean,false) AND ($3::text='start' OR NOT(resource ? 'upstream_last_report_at') OR (resource->>'upstream_last_report_at')::timestamptz<=clock_timestamp()-interval '10 seconds') AND EXISTS(SELECT 1 FROM room_snapshots s WHERE s.room_id=p.room_id AND (s.state->>'media_generation')::bigint=p.generation) END RETURNING jsonb_build_object('resource',resource,'cleanup_remaining_ms',CASE WHEN $3::text='stop' THEN EXTRACT(epoch FROM ((resource->>'upstream_cleanup_deadline')::timestamptz-clock_timestamp()))*1000 ELSE 3000 END)")
        .bind(id).bind(&token).bind(event).fetch_optional(&app.db).await?;
    let Some(claimed) = claimed else {
        return Ok(());
    };
    let encrypted = &claimed["resource"];
    let remaining_ms = claimed["cleanup_remaining_ms"]
        .as_f64()
        .filter(|ms| ms.is_finite())
        .unwrap_or(0.0)
        .clamp(0.0, 60000.0);
    let cleanup_remaining = Duration::from_secs_f64(remaining_ms / 1000.0);
    let mut can_close = false;
    let result = async {
    let row = sqlx::query("SELECT p.resource,s.state FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE p.id=$1 AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=p.id)")
        .bind(id).fetch_one(&app.db).await?;
    let resource = app.decrypt(encrypted["encrypted"].as_str().unwrap_or(""))?;
    let Some(base) = resource["upstream_base"].as_str() else {
        can_close = true; // A non-upstream legacy resource issued no remote I/O.
        return Ok(());
    };
    anyhow::ensure!(
        identifier(&resource["upstream_session"]).is_some(),
        "legacy_upstream_session_unknown"
    );
    let state: protocol::RoomState = serde_json::from_value(row.get("state"))?;
    let body = json!({
        "ItemId":resource["upstream_item"],"PlaySessionId":resource["upstream_session"],
        "PositionTicks":(room_core::position(&state,app.now())*10000.0)as u64,
        "IsPaused":state.playback_status!=protocol::PlaybackStatus::Playing,"CanSeek":true,
        "PlayMethod":if resource["transport"]=="hls" {"Transcode"} else {"DirectPlay"}
    });
    let endpoint = match event {
        "start" => "Sessions/Playing",
        "stop" => "Sessions/Playing/Stopped",
        _ => "Sessions/Playing/Progress",
    };
    let mut request = providers::client()
        .post(format!("{}/{endpoint}", base.trim_end_matches('/')))
        .json(&body);
    if let Some(headers) = resource["headers"].as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                let value = if name.eq_ignore_ascii_case("Authorization")
                    && resource["kind"] == "jellyfin"
                {
                    format!(
                        "{value}, Client=\"RainSync\", Device=\"Web\", DeviceId=\"rainsync\", Version=\"0.1.0\""
                    )
                } else {
                    value.into()
                };
                request = request.header(name, value);
            }
        }
    }
    let timeout = if event == "stop" {
        // The SQL clock supplies remaining total budget. Subtracting elapsed
        // time since before the claim also conservatively covers DB latency.
        cleanup_remaining.saturating_sub(claim_started.elapsed())
            .min(Duration::from_secs(ledger::CLEANUP_SECONDS))
    } else {
        Duration::from_secs(ledger::CLEANUP_SECONDS)
    };
    anyhow::ensure!(!timeout.is_zero(), "legacy_upstream_cleanup_deadline");
    let response = request.timeout(timeout).send().await?;
    anyhow::ensure!(
        providers::checkin_confirmed(response.status()),
        "legacy_upstream_io_unconfirmed"
    );
    can_close = resource["kind"] != "emby";
    Ok::<_, anyhow::Error>(())
    }.await;
    // Clear only our claim, retaining uncertainty about older remote work.
    // A known SID and a Stop check-in cannot recover an old Emby device ID.
    let finished: Option<bool> = sqlx::query_scalar("UPDATE playback_sessions SET resource=(resource-'upstream_io_pending'-'upstream_io_claim'-'upstream_io_kind'-'upstream_io_lease_until')||jsonb_build_object('upstream_io_uncertain',COALESCE((resource->>'upstream_io_uncertain')::boolean,false) OR ($3::text<>'stop' AND NOT $4::boolean))||CASE WHEN $3::text='stop' THEN CASE WHEN $4::boolean AND $5::boolean AND NOT COALESCE((resource->>'upstream_io_uncertain')::boolean,false) THEN '{\"upstream_closed\":true}'::jsonb ELSE '{\"upstream_cleanup_failed\":true}'::jsonb END ELSE '{}'::jsonb END WHERE id=$1 AND resource->>'upstream_io_claim'=$2 AND (resource->>'upstream_io_lease_until')::timestamptz>clock_timestamp() RETURNING COALESCE((resource->>'upstream_io_uncertain')::boolean,false)")
        .bind(id).bind(&token).bind(event).bind(result.is_ok()).bind(can_close).fetch_optional(&app.db).await?;
    anyhow::ensure!(finished.is_some(), "legacy_upstream_io_unconfirmed");
    result?;
    anyhow::ensure!(
        event != "stop" || (can_close && finished == Some(false)),
        "legacy_upstream_identity_unknown"
    );
    Ok(())
}

async fn legacy_maintenance(app: App) {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _=sqlx::query("UPDATE playback_sessions SET resource=resource||jsonb_build_object('upstream_cleanup_failed',true,'upstream_cleanup_error','upstream_cleanup_deadline') WHERE NOT(resource ? 'upstream_closed') AND (resource->>'upstream_cleanup_deadline')::timestamptz<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=playback_sessions.id)").execute(&app.db).await;
        for stop in [true, false] {
            let query = if stop {
                "SELECT p.id,p.resource FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE NOT(p.resource ? 'upstream_closed') AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=p.id) AND (p.stopped OR p.expires_at<=clock_timestamp() OR (s.state->>'media_generation')::bigint<>p.generation) AND COALESCE((p.resource->>'upstream_cleanup_attempts')::integer,0)<5 AND (NOT(p.resource ? 'upstream_cleanup_deadline') OR (p.resource->>'upstream_cleanup_deadline')::timestamptz>clock_timestamp()) AND (NOT(p.resource ? 'upstream_cleanup_after') OR (p.resource->>'upstream_cleanup_after')::timestamptz<=clock_timestamp()) AND (NOT(p.resource ? 'upstream_io_claim') OR (p.resource->>'upstream_io_lease_until')::timestamptz<=clock_timestamp()) ORDER BY (p.resource->>'upstream_cleanup_after')::timestamptz NULLS FIRST,p.id LIMIT 32"
            } else {
                "SELECT p.id,p.resource FROM playback_sessions p JOIN room_snapshots s ON s.room_id=p.room_id WHERE NOT(p.resource ? 'upstream_closed') AND NOT EXISTS(SELECT 1 FROM upstream_reservations WHERE id=p.id) AND NOT p.stopped AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation AND NOT COALESCE((p.resource->>'upstream_io_uncertain')::boolean,false) AND (NOT(p.resource ? 'upstream_last_report_at') OR (p.resource->>'upstream_last_report_at')::timestamptz<=clock_timestamp()-interval '10 seconds') AND (NOT(p.resource ? 'upstream_io_claim') OR (p.resource->>'upstream_io_lease_until')::timestamptz<=clock_timestamp()) ORDER BY (p.resource->>'upstream_last_report_at')::timestamptz NULLS FIRST,p.id LIMIT 32"
            };
            let rows = sqlx::query(query)
                .fetch_all(&app.db)
                .await
                .unwrap_or_default();
            for row in rows {
                let id: Uuid = row.get("id");
                let resource: Value = row.get("resource");
                // Credentials stay encrypted in storage; deleted mutable source
                // configuration is not consulted when choosing an I/O budget.
                let origin = app
                    .decrypt(resource["encrypted"].as_str().unwrap_or(""))
                    .ok()
                    .and_then(|r| {
                        r["upstream_base"]
                            .as_str()
                            .and_then(|s| providers::validate_url(s).ok())
                    })
                    .map_or_else(
                        || format!("legacy-{id}"),
                        |url| hash(&url.origin().ascii_serialization()),
                    );
                let Some(permits) = app.upstream.try_permit(&origin, stop).await else {
                    continue;
                };
                let app = app.clone();
                tokio::spawn(async move {
                    let _permits = permits;
                    if legacy_report(&app, id, if stop { "stop" } else { "progress" })
                        .await
                        .is_err()
                    {
                        tracing::warn!(session=%id,"legacy upstream operation failed");
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Runtime, identifier};
    use serde_json::json;
    #[test]
    fn known_session_id_survives_unusable_stream_response() {
        for bad in [
            json!(null),
            json!(42),
            json!(""),
            json!("bad\nheader"),
            json!("x".repeat(513)),
        ] {
            assert!(identifier(&bad).is_none());
        }
        let wire = json!({"PlaySessionId":"session-known","MediaSources":[]});
        assert_eq!(identifier(&wire["PlaySessionId"]), Some("session-known"));
        assert!(wire["MediaSources"].as_array().unwrap().is_empty());
    }
    #[tokio::test]
    async fn stalled_negotiations_cannot_occupy_cleanup_capacity() {
        let runtime = Runtime::default();
        let mut negotiations = Vec::new();
        for origin in ["slow", "slow", "other", "other"] {
            negotiations.push(runtime.negotiate_permit(origin).await.unwrap());
        }
        assert_eq!(runtime.negotiations.available_permits(), 0);
        let mut stops = Vec::new();
        stops.push(runtime.try_permit("slow", true).await.unwrap());
        stops.push(runtime.try_permit("slow", true).await.unwrap());
        assert!(runtime.try_permit("slow", true).await.is_none());
        stops.push(runtime.try_permit("fast", true).await.unwrap());
        stops.push(runtime.try_permit("fast", true).await.unwrap());
        assert!(runtime.try_permit("third", true).await.is_none());
        assert!(runtime.try_permit("third", false).await.is_some());
        drop(stops);
        assert!(runtime.try_permit("fast", true).await.is_some());
        assert_eq!(runtime.negotiations.available_permits(), 0);
        drop(negotiations);
        assert_eq!(runtime.negotiations.available_permits(), 4);
    }
}
