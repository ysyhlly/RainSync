//! Independent, optional client-reported measurements. Durable viewer state is
//! the authority; process-local rate entries and aggregates never replace it.
use super::*;
use media_core::runtime_metrics::{
    PlaybackAttribution, PlaybackMode, PlaybackSource, WorkerOutputEntry,
    WorkerOutputEntryAvailability,
};
use protocol::{
    PlaybackMetricsFirstFrame, PlaybackMetricsOrigin, PlaybackMetricsPacket,
    PlaybackMetricsReceipt, PlaybackMetricsSample, PlaybackMetricsStartupPhases,
    PlaybackMetricsTotals, PlaybackRequest,
};
use sqlx::{Connection, Postgres, Transaction, pool::PoolConnection};
use std::{sync::OnceLock, time::Duration};

const REQUEST_DEADLINE: Duration = Duration::from_secs(3);
const MAX_COOKIE_BYTES: usize = 8192;
const MAX_PAYLOAD_BYTES: usize = 4096;
const MIN_SAMPLE_INTERVAL_MS: u32 = 1000;
const RATE_WINDOW: Duration = Duration::from_secs(10);
const RATE_EXPIRY: Duration = Duration::from_secs(60);
const RATE_REQUESTS: usize = 6;
const MAX_RATE_IDENTITIES: usize = 4096;
static IN_FLIGHT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(32);

// Cancellation must close this connection rather than return an unfinished
// transaction to SQLx's asynchronous rollback/ping path.
struct MetricsConnection {
    connection: PoolConnection<Postgres>,
    reusable: bool,
}
impl Drop for MetricsConnection {
    fn drop(&mut self) {
        if !self.reusable {
            self.connection.close_on_drop();
        }
    }
}

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
struct RateIdentity {
    user: Uuid,
    room: Uuid,
    viewer: Uuid,
}
struct RateEntry {
    requests: std::collections::VecDeque<Instant>,
    touched: Instant,
}
#[derive(Default)]
struct RateMap {
    entries: HashMap<RateIdentity, RateEntry>,
}
#[derive(Debug, PartialEq, Eq)]
enum RateRejection {
    Limited,
    Capacity,
}
impl RateMap {
    fn admit(
        &mut self,
        identity: RateIdentity,
        now: Instant,
    ) -> std::result::Result<(), RateRejection> {
        // Eviction affects only expiring request-rate entries. It never deletes
        // durable viewer high-water, samples, anchors or closed state.
        self.entries
            .retain(|_, entry| now.saturating_duration_since(entry.touched) < RATE_EXPIRY);
        if !self.entries.contains_key(&identity) && self.entries.len() >= MAX_RATE_IDENTITIES {
            return Err(RateRejection::Capacity);
        }
        let entry = self.entries.entry(identity).or_insert_with(|| RateEntry {
            requests: std::collections::VecDeque::with_capacity(RATE_REQUESTS),
            touched: now,
        });
        entry.touched = now;
        while entry
            .requests
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= RATE_WINDOW)
        {
            entry.requests.pop_front();
        }
        if entry.requests.len() >= RATE_REQUESTS {
            return Err(RateRejection::Limited);
        }
        entry.requests.push_back(now);
        Ok(())
    }
}
fn rate(identity: RateIdentity) -> std::result::Result<(), RateRejection> {
    static RATES: OnceLock<std::sync::Mutex<RateMap>> = OnceLock::new();
    RATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .admit(identity, Instant::now())
}
fn rate_error() -> Error {
    Error(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited".into(),
        Some(2),
    )
}
fn session_hash(headers: &HeaderMap) -> Option<String> {
    let mut length = 0usize;
    let mut token = None;
    for cookie in headers.get_all(header::COOKIE) {
        length = length.checked_add(cookie.as_bytes().len())?;
        if length > MAX_COOKIE_BYTES {
            return None;
        }
        for part in cookie.to_str().ok()?.split(';') {
            if let Some(value) = part.trim().strip_prefix("rainsync_session=") {
                if token.is_some()
                    || value.len() != 64
                    || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return None;
                }
                token = Some(value);
            }
        }
    }
    Some(hash(token?))
}
fn origin_name(origin: PlaybackMetricsOrigin) -> &'static str {
    match origin {
        PlaybackMetricsOrigin::UserIntent => "user_intent",
        PlaybackMetricsOrigin::AutomaticLoad => "automatic_load",
    }
}

/// Validate negotiation before any upstream preparation or reservation work.
pub fn validate(body: &PlaybackRequest) -> Result<()> {
    if body
        .playback_metrics_version
        .is_some_and(|version| version != 1)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unsupported_playback_metrics_version",
        ));
    }
    if let Some(versions) = &body.playback_metrics_supported_versions
        && (body.playback_metrics_version != Some(1)
            || versions.is_empty()
            || versions.len() > 2
            || versions.iter().any(|version| !matches!(version, 1 | 2))
            || (versions.len() == 2 && versions[0] == versions[1]))
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_playback_metrics"));
    }
    match (body.playback_metrics_version, &body.playback_metrics) {
        (None, None) => Ok(()),
        (Some(1), Some(intent))
            if body.viewer_id.is_some()
                && body.plan_generation.is_some_and(|generation| {
                    intent.meter_start_generation > 0 && intent.meter_start_generation <= generation
                }) =>
        {
            Ok(())
        }
        _ => Err(err(StatusCode::BAD_REQUEST, "invalid_playback_metrics")),
    }
}

struct Slot {
    plan_generation: i64,
    start_generation: Option<i64>,
    media_generation: Option<i64>,
    lifecycle_epoch: Option<i64>,
    origin: Option<String>,
    seq: i64,
    closed: bool,
    payload: Option<PlaybackMetricsPacket>,
    version: Option<i32>,
    anchor_elapsed_ms: Option<i64>,
}
impl Slot {
    fn decode(row: &sqlx::postgres::PgRow) -> Result<Self> {
        let payload: Option<Value> = row.try_get("metrics_payload")?;
        let payload = payload
            .map(serde_json::from_value::<PlaybackMetricsPacket>)
            .transpose()
            .map_err(anyhow::Error::from)?;
        Ok(Self {
            plan_generation: row.try_get("plan_generation")?,
            start_generation: row.try_get("metrics_meter_start_generation")?,
            media_generation: row.try_get("metrics_media_generation")?,
            lifecycle_epoch: row.try_get("metrics_lifecycle_epoch")?,
            origin: row.try_get("metrics_startup_origin")?,
            seq: row.try_get("metrics_seq")?,
            closed: row.try_get("metrics_closed")?,
            payload,
            version: row.try_get("metrics_version")?,
            anchor_elapsed_ms: row.try_get("metrics_anchor_elapsed_ms")?,
        })
    }
    fn matches(&self, body: &PlaybackRequest, lifecycle_epoch: i64) -> bool {
        body.playback_metrics.as_ref().is_some_and(|intent| {
            self.start_generation == Some(i64::from(intent.meter_start_generation))
                && self.media_generation == Some(i64::from(body.media_generation))
                && self.lifecycle_epoch == Some(lifecycle_epoch)
                && self.origin.as_deref() == Some(origin_name(intent.startup_origin))
        })
    }
    fn grant(&self) -> Result<Value> {
        let start = self
            .start_generation
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| err(StatusCode::CONFLICT, "stale_playback_metrics"))?;
        let origin = match self.origin.as_deref() {
            Some("user_intent") => PlaybackMetricsOrigin::UserIntent,
            Some("automatic_load") => PlaybackMetricsOrigin::AutomaticLoad,
            _ => return Err(err(StatusCode::CONFLICT, "stale_playback_metrics")),
        };
        let mut grant = json!({"meter_start_generation":start,"startup_origin":origin,
            "metrics_seq":u64::try_from(self.seq).map_err(anyhow::Error::from)?,"closed":self.closed});
        if let Some(payload) = &self.payload {
            grant["last_sample"] = serde_json::to_value(payload).map_err(anyhow::Error::from)?;
        }
        Ok(grant)
    }
}
async fn slot(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    room: Uuid,
    viewer: Uuid,
) -> Result<Slot> {
    let row = sqlx::query("SELECT * FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 FOR UPDATE")
        .bind(user).bind(room).bind(viewer).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::CONFLICT, "stale_playback_metrics"))?;
    Slot::decode(&row)
}

#[derive(Debug, PartialEq, Eq)]
enum Admission {
    Preserve,
    Close,
    Replace,
}
fn admission(
    current: &Slot,
    body: &PlaybackRequest,
    lifecycle_epoch: i64,
    retry: bool,
) -> Result<Admission> {
    if body.plan_generation.map(i64::from) != Some(current.plan_generation) {
        return Err(err(StatusCode::CONFLICT, "stale_playback_metrics"));
    }
    let Some(intent) = &body.playback_metrics else {
        return Ok(if retry {
            Admission::Preserve
        } else {
            Admission::Close
        });
    };
    if retry {
        // Same-key retry may replay a closed meter; it never reopens one.
        if !current.matches(body, lifecycle_epoch) {
            return Err(err(StatusCode::CONFLICT, "stale_playback_metrics"));
        }
        return Ok(Admission::Preserve);
    }
    if i64::from(intent.meter_start_generation) == current.plan_generation {
        return Ok(Admission::Replace);
    }
    if current.closed {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_closed"));
    }
    if !current.matches(body, lifecycle_epoch) {
        return Err(err(StatusCode::CONFLICT, "stale_playback_metrics"));
    }
    Ok(Admission::Preserve)
}

/// Caller has admitted the existing viewer high-water under room → user locks.
/// This never inserts a viewer and same-key retries never reset or reopen slots.
pub async fn admit(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    body: &PlaybackRequest,
    lifecycle_epoch: i64,
    retry: bool,
) -> Result<()> {
    validate(body)?;
    let (Some(viewer), Some(generation)) = (body.viewer_id, body.plan_generation) else {
        return Ok(());
    };
    let current = slot(tx, user, body.room_id, viewer).await?;
    match admission(&current, body, lifecycle_epoch, retry)? {
        Admission::Preserve => {}
        Admission::Close => {
            sqlx::query("UPDATE playback_viewer_plans SET metrics_closed=true WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND metrics_meter_start_generation IS NOT NULL")
                .bind(user).bind(body.room_id).bind(viewer).execute(&mut **tx).await?;
        }
        Admission::Replace => {
            let intent = body
                .playback_metrics
                .as_ref()
                .expect("validated metrics replacement");
            sqlx::query("UPDATE playback_viewer_plans SET metrics_meter_start_generation=$4,metrics_media_generation=$5,metrics_lifecycle_epoch=$6,metrics_startup_origin=$7,metrics_seq=0,metrics_payload=NULL,metrics_closed=false,metrics_admitted_at=clock_timestamp(),metrics_anchor_elapsed_ms=NULL,metrics_anchor_received_at=NULL,metrics_version=$8,metrics_first_frame_source=NULL,metrics_first_frame_mode=NULL,metrics_first_frame_output_entry=NULL,metrics_first_frame_queue_ms=NULL WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3")
            .bind(user).bind(body.room_id).bind(viewer).bind(i64::from(generation))
            .bind(i64::from(body.media_generation)).bind(lifecycle_epoch)
            .bind(origin_name(intent.startup_origin))
            .bind(if body.playback_metrics_supported_versions.as_ref().is_some_and(|versions| versions.contains(&2)) { 2_i32 } else { 1_i32 })
            .execute(&mut **tx).await?;
        }
    }
    Ok(())
}

/// Only a final, successfully published opted-in grant gets the session marker.
/// Caller already holds its room, viewer and source/account publication locks.
pub async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    body: &PlaybackRequest,
    session: Uuid,
    resource: &Value,
) -> Result<Option<(u32, Value)>> {
    validate(body)?;
    let Some(intent) = &body.playback_metrics else {
        return Ok(None);
    };
    let viewer = body
        .viewer_id
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_playback_metrics"))?;
    let generation = body
        .plan_generation
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_playback_metrics"))?;
    let current = slot(tx, user, body.room_id, viewer).await?;
    if current.plan_generation != i64::from(generation)
        || current.start_generation != Some(i64::from(intent.meter_start_generation))
        || current.media_generation != Some(i64::from(body.media_generation))
        || current.origin.as_deref() != Some(origin_name(intent.startup_origin))
    {
        return Err(err(StatusCode::CONFLICT, "stale_playback_metrics"));
    }
    let version = current
        .version
        .ok_or_else(|| err(StatusCode::CONFLICT, "stale_playback_metrics"))?;
    let attribution = PlaybackAttribution::from_publication(
        resource["kind"].as_str(),
        resource["delivery_mode"].as_str(),
    );
    let published = sqlx::query("UPDATE playback_sessions p SET playback_metrics_version=$9,metrics_meter_start_generation=$4,metrics_source_kind=COALESCE(p.metrics_source_kind,$10),metrics_delivery_mode=COALESCE(p.metrics_delivery_mode,$11),metrics_output_entry_availability=COALESCE(p.metrics_output_entry_availability,$12) WHERE p.id=$1 AND p.user_id=$2 AND p.room_id=$3 AND p.viewer_id=$5 AND p.plan_generation=$6 AND p.generation=$7 AND p.lifecycle_epoch=$8 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_source_allowed(p.media_id,p.resource,p.id) AND EXISTS(SELECT 1 FROM rooms r WHERE r.id=p.room_id AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(session).bind(user).bind(body.room_id).bind(i64::from(intent.meter_start_generation))
        .bind(viewer).bind(i64::from(generation)).bind(i64::from(body.media_generation))
        .bind(current.lifecycle_epoch).bind(version)
        .bind((version == 2).then_some(attribution.source.label()))
        .bind((version == 2).then_some(attribution.mode.label()))
        .bind((version == 2 && resource.get("job_id").is_none()).then_some("not_applicable"))
        .execute(&mut **tx).await?;
    if published.rows_affected() != 1 {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    Ok(Some((version as u32, current.grant()?)))
}

/// Refresh current durable seq/closed/payload on encrypted same-key replay.
pub async fn refresh(tx: &mut Transaction<'_, Postgres>, plan: &mut Value) -> Result<()> {
    if !matches!(plan["playback_metrics_version"].as_u64(), Some(1 | 2)) {
        return Ok(());
    }
    let id: Uuid =
        serde_json::from_value(plan["session_id"].clone()).map_err(anyhow::Error::from)?;
    let identity = sqlx::query("SELECT user_id,room_id,viewer_id,plan_generation,playback_metrics_version,metrics_meter_start_generation FROM playback_sessions WHERE id=$1")
        .bind(id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let user: Option<Uuid> = identity.try_get("user_id")?;
    let room: Option<Uuid> = identity.try_get("room_id")?;
    let viewer: Option<Uuid> = identity.try_get("viewer_id")?;
    let (Some(user), Some(room), Some(viewer)) = (user, room, viewer) else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "playback_metrics_not_negotiated",
        ));
    };
    let current = slot(tx, user, room, viewer).await?;
    if identity.try_get::<Option<i32>, _>("playback_metrics_version")? != current.version
        || identity.try_get::<Option<i64>, _>("plan_generation")? != Some(current.plan_generation)
        || identity.try_get::<Option<i64>, _>("metrics_meter_start_generation")?
            != current.start_generation
    {
        return Err(err(StatusCode::CONFLICT, "stale_playback_metrics"));
    }
    plan["playback_metrics"] =
        serde_json::to_value(current.grant()?).map_err(anyhow::Error::from)?;
    Ok(())
}

fn validate_sample(sample: &PlaybackMetricsPacket) -> Result<()> {
    if !matches!(sample.common().version, 1 | 2) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unsupported_playback_metrics_version",
        ));
    }
    if !sample.valid()
        || serde_json::to_vec(sample)
            .map_err(anyhow::Error::from)?
            .len()
            > MAX_PAYLOAD_BYTES
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_playback_metrics"));
    }
    Ok(())
}
struct Credit {
    delta: PlaybackMetricsTotals,
    first: Option<PlaybackMetricsFirstFrame>,
    phases: Option<PlaybackMetricsStartupPhases>,
    attribution: Option<PlaybackAttribution>,
    output: Option<WorkerOutputEntry>,
}
fn transition(current: &Slot, packet: &PlaybackMetricsPacket) -> Result<Option<Credit>> {
    let sample = &packet.common();
    if Some(sample.version as i32) != current.version {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict"));
    }
    if sample.seq < current.seq as u64 {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_sequence_stale"));
    }
    if sample.seq == current.seq as u64 {
        if current.payload.as_ref() != Some(packet) {
            return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict"));
        }
        return Ok(None);
    }
    if current.closed {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_closed"));
    }
    let Some(previous) = &current.payload else {
        return Ok(Some(Credit {
            delta: sample.totals.clone(),
            first: sample.first_frame.clone(),
            phases: packet.startup_phases().cloned(),
            attribution: None,
            output: None,
        }));
    };
    if previous.first_frame_plan_generation().is_some()
        && previous.first_frame_plan_generation() != packet.first_frame_plan_generation()
    {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict"));
    }
    let phases = match (previous.startup_phases(), packet.startup_phases()) {
        (None, None) => None,
        (Some(before), Some(after)) => {
            let delta = after
                .checked_delta(before)
                .ok_or_else(|| err(StatusCode::CONFLICT, "playback_metrics_conflict"))?;
            if previous.common().first_frame.is_some() && delta.sum() != 0 {
                return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict"));
            }
            Some(delta)
        }
        _ => return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict")),
    };
    let previous = previous.common();
    let elapsed_delta = sample
        .elapsed_ms
        .checked_sub(previous.elapsed_ms)
        .ok_or_else(|| err(StatusCode::CONFLICT, "playback_metrics_time_invalid"))?;
    let delta = sample
        .totals
        .checked_delta(&previous.totals)
        .ok_or_else(|| err(StatusCode::CONFLICT, "playback_metrics_conflict"))?;
    if delta.sum() != u64::from(elapsed_delta) {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict"));
    }
    if previous.first_frame.is_some() && sample.first_frame != previous.first_frame {
        return Err(err(StatusCode::CONFLICT, "playback_metrics_conflict"));
    }
    // Cumulative client elapsed is already fixed-anchor bounded below. A small
    // final interval is allowed exactly once; a closed slot cannot accept more.
    if !sample.final_sample && elapsed_delta < MIN_SAMPLE_INTERVAL_MS {
        return Err(rate_error());
    }
    Ok(Some(Credit {
        delta,
        phases,
        attribution: None,
        output: None,
        first: if previous.first_frame.is_none() {
            sample.first_frame.clone()
        } else {
            None
        },
    }))
}
fn within_anchor(sample: &PlaybackMetricsSample, anchor: i64, database_elapsed_ms: i64) -> bool {
    let Some(client_elapsed_ms) = i64::from(sample.elapsed_ms).checked_sub(anchor) else {
        return false;
    };
    client_elapsed_ms >= 0
        && client_elapsed_ms
            <= database_elapsed_ms
                .max(0)
                .saturating_add(i64::from(protocol::PLAYBACK_METRICS_MAX_CAPTURE_LEAD_MS))
}

async fn receive(
    tx: &mut Transaction<'_, Postgres>,
    app: &App,
    headers: &HeaderMap,
    session_hash: &str,
    id: Uuid,
    packet: &PlaybackMetricsPacket,
) -> Result<(PlaybackMetricsReceipt, Option<Credit>)> {
    let sample = &packet.common();
    // Auth shares the cancellation-owned connection and statement limits. Do
    // not call the normal pool-based auth outside the whole request deadline.
    let authentication = sqlx::query("SELECT u.id,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()")
        .bind(session_hash).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "session_expired"))?;
    let user: Uuid = authentication.try_get("id")?;
    origin(app, headers)?;
    if headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        != Some(authentication.try_get::<String, _>("csrf")?.as_str())
    {
        return Err(err(StatusCode::FORBIDDEN, "csrf_rejected"));
    }
    // Historical or already revoked grants cannot allocate a rate bucket or
    // consume the allowance of their current viewer's successor. This is only
    // a pre-contention filter; every authority is checked again under locks.
    let identity = sqlx::query("SELECT p.room_id,p.viewer_id,p.playback_metrics_version FROM playback_sessions p WHERE p.id=$1 AND p.user_id=$2 AND playback_caller_allowed(p.resource,$2,$3) AND NOT p.stopped AND p.expires_at>clock_timestamp() AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation)) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)")
        .bind(id).bind(user).bind(session_hash).fetch_optional(&mut **tx).await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let room: Option<Uuid> = identity.try_get("room_id")?;
    let viewer: Option<Uuid> = identity.try_get("viewer_id")?;
    let (Some(room), Some(viewer)) = (room, viewer) else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "playback_metrics_not_negotiated",
        ));
    };
    if identity.try_get::<Option<i32>, _>("playback_metrics_version")?
        != Some(sample.version as i32)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "playback_metrics_not_negotiated",
        ));
    }
    match rate(RateIdentity { user, room, viewer }) {
        Ok(()) => {}
        Err(RateRejection::Limited) => return Err(rate_error()),
        Err(RateRejection::Capacity) => {
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"));
        }
    }
    // Match preparation/stop lock order. Source observers lock source before
    // session, so source/account locks must precede our session lock too.
    let lifecycle =
        sqlx::query("SELECT lifecycle,lifecycle_epoch FROM rooms WHERE id=$1 FOR NO KEY UPDATE")
            .bind(room)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let epoch: i64 = lifecycle.try_get("lifecycle_epoch")?;
    if lifecycle.try_get::<String, _>("lifecycle")? != "active" {
        return Err(err(StatusCode::CONFLICT, "room_not_active"));
    }
    let state: Value =
        sqlx::query_scalar("SELECT state FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
            .bind(room)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    if sqlx::query("SELECT user_id FROM room_members WHERE room_id=$1 AND user_id=$2 FOR KEY SHARE")
        .bind(room)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?
        .is_none()
    {
        return Err(err(StatusCode::FORBIDDEN, "not_a_member"));
    }
    // Recheck and lock the exact original caller before mutable viewer state.
    // Never substitute another still-live login belonging to the same user.
    media_authorization::lock_caller(tx, id, user, session_hash).await?;
    let current = slot(tx, user, room, viewer).await?;
    if !persistence::source_account_policy::lock_session(tx, id).await? {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    let grant =
        sqlx::query("SELECT * FROM playback_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE")
            .bind(id)
            .bind(user)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    if grant.try_get::<Option<Uuid>, _>("room_id")? != Some(room)
        || grant.try_get::<Option<Uuid>, _>("viewer_id")? != Some(viewer)
        || grant.try_get::<Option<i32>, _>("playback_metrics_version")?
            != Some(sample.version as i32)
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "playback_metrics_not_negotiated",
        ));
    }
    if grant.try_get::<Option<i64>, _>("plan_generation")?
        != Some(i64::from(sample.plan_generation))
        || current.plan_generation != i64::from(sample.plan_generation)
        || grant.try_get::<Option<i64>, _>("metrics_meter_start_generation")?
            != Some(i64::from(sample.meter_start_generation))
        || current.start_generation != Some(i64::from(sample.meter_start_generation))
        || current.media_generation != Some(i64::from(sample.media_generation))
        || current.lifecycle_epoch != Some(epoch)
        || current.origin.as_deref() != Some(origin_name(sample.startup_origin))
    {
        return Err(err(StatusCode::CONFLICT, "stale_playback_metrics"));
    }
    if grant.try_get::<i64, _>("lifecycle_epoch")? != epoch {
        return Err(err(StatusCode::CONFLICT, "room_not_active"));
    }
    if grant.try_get::<i64, _>("generation")? != i64::from(sample.media_generation)
        || state["media_generation"].as_u64() != Some(u64::from(sample.media_generation))
        || state["media_id"].as_str()
            != Some(grant.try_get::<Uuid, _>("media_id")?.to_string().as_str())
    {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    // Recheck expiry and all volatile source/account authority only after every
    // contended lock. A replay is authorized by today's grant, not its old ACK.
    let live: bool = sqlx::query_scalar("SELECT NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_caller_allowed(p.resource,$2,$3) AND playback_source_allowed(p.media_id,p.resource,p.id) AND EXISTS(SELECT 1 FROM rooms r WHERE r.id=p.room_id AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id) AND EXISTS(SELECT 1 FROM sessions s WHERE s.token_hash=$3 AND s.user_id=p.user_id AND s.expires_at>clock_timestamp()) FROM playback_sessions p WHERE p.id=$1 AND p.user_id=$2")
        .bind(id).bind(user).bind(session_hash).fetch_one(&mut **tx).await?;
    if !live {
        return Err(err(StatusCode::GONE, "invalid_playback_session"));
    }
    let mut credit = transition(&current, packet)?;
    if let Some(accepted) = &mut credit
        && accepted.first.is_some()
        && sample.version == 2
    {
        // This historical row supplies attribution only. Today's grant above
        // alone authorizes receipt; an old stopped grant is never revived.
        let frame_generation = packet
            .first_frame_plan_generation()
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_playback_metrics"))?;
        let historical = sqlx::query("SELECT metrics_source_kind,metrics_delivery_mode,metrics_output_entry_availability,metrics_output_entry_completed,metrics_output_entry_queue_ms FROM playback_sessions WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3 AND generation=$4 AND lifecycle_epoch=$5 AND metrics_meter_start_generation=$6 AND plan_generation=$7 AND auth_login_hash IS NOT DISTINCT FROM $8 AND playback_metrics_version=2 LIMIT 2")
                .bind(user).bind(room).bind(viewer).bind(i64::from(sample.media_generation)).bind(epoch)
                .bind(i64::from(sample.meter_start_generation)).bind(i64::from(frame_generation))
                .bind(grant.try_get::<Option<String>, _>("auth_login_hash")?)
                .fetch_all(&mut **tx).await?;
        // Ambiguous/reclaimed history remains unknown, never the current grant.
        let attribution = if historical.len() == 1 {
            PlaybackAttribution::from_publication(
                historical[0]
                    .try_get::<Option<String>, _>("metrics_source_kind")?
                    .as_deref(),
                historical[0]
                    .try_get::<Option<String>, _>("metrics_delivery_mode")?
                    .as_deref(),
            )
        } else {
            PlaybackAttribution {
                source: PlaybackSource::Unknown,
                mode: PlaybackMode::Unknown,
            }
        };
        accepted.attribution = Some(attribution);
        let output = if historical.len() == 1 {
            let availability = WorkerOutputEntryAvailability::from_name(
                historical[0]
                    .try_get::<Option<String>, _>("metrics_output_entry_availability")?
                    .as_deref(),
            );
            let queue_ms = if historical[0].try_get::<bool, _>("metrics_output_entry_completed")?
                && matches!(
                    availability,
                    WorkerOutputEntryAvailability::ColdWaiting
                        | WorkerOutputEntryAvailability::Warm
                ) {
                historical[0]
                    .try_get::<Option<i64>, _>("metrics_output_entry_queue_ms")?
                    .and_then(|value| u32::try_from(value).ok())
                    .filter(|value| *value <= protocol::PLAYBACK_METRICS_MAX_ELAPSED_MS)
            } else {
                None
            };
            WorkerOutputEntry {
                availability,
                queue_ms,
            }
        } else {
            WorkerOutputEntry {
                availability: WorkerOutputEntryAvailability::Unknown,
                queue_ms: None,
            }
        };
        accepted.output = Some(output);
    }
    if credit.is_some() {
        if let Some(anchor) = current.anchor_elapsed_ms {
            let elapsed: i64 = sqlx::query_scalar("SELECT GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-metrics_anchor_received_at))*1000))::bigint FROM playback_viewer_plans WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3")
                .bind(user).bind(room).bind(viewer).fetch_one(&mut **tx).await?;
            if !within_anchor(sample, anchor, elapsed) {
                return Err(err(StatusCode::CONFLICT, "playback_metrics_time_invalid"));
            }
        }
        let payload = serde_json::to_value(packet).map_err(anyhow::Error::from)?;
        sqlx::query("UPDATE playback_viewer_plans SET metrics_seq=$4,metrics_payload=$5,metrics_closed=$6,metrics_anchor_elapsed_ms=COALESCE(metrics_anchor_elapsed_ms,$7),metrics_anchor_received_at=COALESCE(metrics_anchor_received_at,clock_timestamp()),metrics_first_frame_source=COALESCE(metrics_first_frame_source,$8),metrics_first_frame_mode=COALESCE(metrics_first_frame_mode,$9),metrics_first_frame_output_entry=COALESCE(metrics_first_frame_output_entry,$10),metrics_first_frame_queue_ms=COALESCE(metrics_first_frame_queue_ms,$11) WHERE user_id=$1 AND room_id=$2 AND viewer_id=$3")
            .bind(user).bind(room).bind(viewer).bind(sample.seq as i64).bind(payload)
            .bind(sample.final_sample).bind(i64::from(sample.elapsed_ms))
            .bind(credit.as_ref().and_then(|credit| credit.attribution).map(|value| value.source.label()))
            .bind(credit.as_ref().and_then(|credit| credit.attribution).map(|value| value.mode.label()))
            .bind(credit.as_ref().and_then(|credit| credit.output).map(|value| value.availability.label()))
            .bind(credit.as_ref().and_then(|credit| credit.output).and_then(|value| value.queue_ms).map(i64::from))
            .execute(&mut **tx).await?;
    }
    Ok((
        PlaybackMetricsReceipt {
            session_id: id,
            meter_start_generation: sample.meter_start_generation,
            metrics_seq: sample.seq,
            closed: if credit.is_some() {
                sample.final_sample
            } else {
                current.closed
            },
        },
        credit,
    ))
}

pub async fn endpoint(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(sample): Json<PlaybackMetricsPacket>,
) -> Result<Json<PlaybackMetricsReceipt>> {
    use media_core::runtime_metrics::ClientMetricsDrop;
    let deadline = tokio::time::Instant::now() + REQUEST_DEADLINE;
    let Ok(_permit) = IN_FLIGHT.try_acquire() else {
        app.metrics
            .runtime
            .client_playback_dropped(ClientMetricsDrop::Capacity);
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"));
    };
    let session_hash =
        session_hash(&headers).ok_or_else(|| err(StatusCode::UNAUTHORIZED, "login_required"))?;
    validate_sample(&sample).inspect_err(|_| {
        app.metrics
            .runtime
            .client_playback_dropped(ClientMetricsDrop::Invalid);
    })?;
    let result = tokio::time::timeout_at(deadline, async {
        let mut owned = MetricsConnection { connection: app.db.acquire().await?, reusable: false };
        let mut tx = owned.connection.begin().await?;
        sqlx::query("SELECT set_config('statement_timeout','1000ms',true),set_config('lock_timeout','500ms',true)")
            .execute(&mut *tx).await?;
        let received = receive(&mut tx, &app, &headers, &session_hash, id, &sample).await;
        match received {
            Ok(result) => {
                tx.commit().await?;
                owned.reusable = true;
                Ok(result)
            },
            Err(error) => {
                tx.rollback().await?;
                owned.reusable = true;
                Err(error)
            },
        }
    }).await;
    let (receipt, credit) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            let drop = match error.1.as_str() {
                "rate_limited" => Some(ClientMetricsDrop::RateLimited),
                "service_unavailable" | "database_error" => Some(ClientMetricsDrop::Unavailable),
                "invalid_playback_metrics"
                | "playback_metrics_sequence_stale"
                | "playback_metrics_conflict"
                | "playback_metrics_closed"
                | "playback_metrics_time_invalid"
                | "stale_playback_metrics" => Some(ClientMetricsDrop::Invalid),
                _ => None,
            };
            if let Some(reason) = drop {
                app.metrics.runtime.client_playback_dropped(reason);
            }
            return Err(error);
        }
        Err(_) => {
            app.metrics
                .runtime
                .client_playback_dropped(ClientMetricsDrop::Unavailable);
            return Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"));
        }
    };
    // Persistence is authoritative. A crash in this small commit/collector gap
    // can lose credit; replay deliberately never credits the aggregate twice.
    if let Some(credit) = credit {
        app.metrics.runtime.client_playback_sample_with_output(
            sample.common().startup_origin,
            &credit.delta,
            credit.first.as_ref(),
            credit.phases.as_ref(),
            credit.attribution,
            credit.output,
        );
    }
    Ok(Json(receipt))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(elapsed: u32, seq: u64) -> PlaybackMetricsSample {
        serde_json::from_value(json!({"version":1,"media_generation":1,"plan_generation":2,"meter_start_generation":1,"seq":seq,"startup_origin":"user_intent","elapsed_ms":elapsed,"totals":{"startup_ms":elapsed,"autoplay_blocked_ms":0,"background_ms":0,"paused_ms":0,"seeking_ms":0,"rebuffer_ms":0,"playing_ms":0,"unobserved_ms":0},"final":false})).unwrap()
    }
    fn transition(current: &Slot, sample: &PlaybackMetricsSample) -> Result<Option<Credit>> {
        super::transition(current, &PlaybackMetricsPacket::V1(sample.clone()))
    }
    fn current(payload: Option<PlaybackMetricsSample>) -> Slot {
        Slot {
            plan_generation: 2,
            start_generation: Some(1),
            media_generation: Some(1),
            lifecycle_epoch: Some(1),
            origin: Some("user_intent".into()),
            seq: payload.as_ref().map_or(0, |value| value.seq as i64),
            closed: payload.as_ref().is_some_and(|value| value.final_sample),
            anchor_elapsed_ms: payload.as_ref().map(|value| i64::from(value.elapsed_ms)),
            payload: payload.map(PlaybackMetricsPacket::V1),
            version: Some(1),
        }
    }
    fn reason<T>(result: Result<T>) -> String {
        result.err().expect("must fail").1
    }
    fn v2(elapsed: u32, seq: u64) -> PlaybackMetricsPacket {
        let mut value = serde_json::to_value(sample(elapsed, seq)).unwrap();
        value["version"] = json!(2);
        value["startup_phases"] =
            json!({"preparation_ms":elapsed,"loading_ms":0,"unobserved_ms":0});
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn v2_phase_regression_and_frame_generation_relabeling_reject() {
        let mut previous = v2(2000, 1);
        if let PlaybackMetricsPacket::V2(sample) = &mut previous {
            sample.first_frame = Some(PlaybackMetricsFirstFrame {
                elapsed_ms: 1900,
                confirmed_elapsed_ms: 2000,
                evidence: protocol::PlaybackMetricsFrameEvidence::VideoFrameCallback,
            });
            sample.first_frame_plan_generation = Some(1);
        }
        let mut slot = current(None);
        slot.version = Some(2);
        slot.seq = 1;
        slot.payload = Some(previous.clone());
        assert!(super::transition(&slot, &previous).unwrap().is_none());
        let mut next = previous.clone();
        if let PlaybackMetricsPacket::V2(sample) = &mut next {
            sample.elapsed_ms = 3000;
            sample.seq = 2;
            sample.totals.startup_ms = 3000;
        }
        let credit = super::transition(&slot, &next).unwrap().unwrap();
        assert!(credit.first.is_none());
        assert_eq!(credit.phases.unwrap().sum(), 0);
        if let PlaybackMetricsPacket::V2(sample) = &mut next {
            sample.first_frame_plan_generation = Some(2);
        }
        assert_eq!(
            reason(super::transition(&slot, &next)),
            "playback_metrics_conflict"
        );
        if let PlaybackMetricsPacket::V2(sample) = &mut next {
            sample.first_frame_plan_generation = Some(1);
            sample.startup_phases.preparation_ms -= 1;
            sample.startup_phases.loading_ms += 1;
        }
        assert_eq!(
            reason(super::transition(&slot, &next)),
            "playback_metrics_conflict"
        );
        assert_eq!(
            reason(super::transition(
                &slot,
                &PlaybackMetricsPacket::V1(sample(3000, 2))
            )),
            "playback_metrics_conflict"
        );
    }
    #[test]
    fn v2_offer_is_outer_optional_and_legacy_canonical_request_stays_identical() {
        let raw = json!({"room_id":Uuid::nil(),"media_generation":1});
        let mut request: PlaybackRequest = serde_json::from_value(raw).unwrap();
        let before = serde_json::to_value(&request).unwrap();
        assert!(before.get("playback_metrics_supported_versions").is_none());
        request.playback_metrics_version = Some(1);
        request.viewer_id = Some(Uuid::nil());
        request.plan_generation = Some(1);
        request.playback_metrics = Some(protocol::PlaybackMetricsIntent {
            meter_start_generation: 1,
            startup_origin: PlaybackMetricsOrigin::UserIntent,
        });
        request.playback_metrics_supported_versions = Some(vec![1, 2]);
        assert!(validate(&request).is_ok());
        for versions in [vec![], vec![1, 1], vec![1, 2, 2], vec![3]] {
            request.playback_metrics_supported_versions = Some(versions);
            assert!(validate(&request).is_err());
        }
    }
    #[test]
    fn negotiation_is_paired_and_requires_current_viewer_generation() {
        let mut request: PlaybackRequest =
            serde_json::from_value(json!({"room_id":Uuid::nil(),"media_generation":1})).unwrap();
        assert!(validate(&request).is_ok());
        request.playback_metrics_version = Some(2);
        assert_eq!(
            reason(validate(&request)),
            "unsupported_playback_metrics_version"
        );
        request.playback_metrics_version = Some(1);
        assert_eq!(reason(validate(&request)), "invalid_playback_metrics");
        request.playback_metrics = Some(protocol::PlaybackMetricsIntent {
            meter_start_generation: 1,
            startup_origin: PlaybackMetricsOrigin::UserIntent,
        });
        assert_eq!(reason(validate(&request)), "invalid_playback_metrics");
        request.viewer_id = Some(Uuid::nil());
        request.plan_generation = Some(2);
        assert!(validate(&request).is_ok());
        request
            .playback_metrics
            .as_mut()
            .unwrap()
            .meter_start_generation = 3;
        assert_eq!(reason(validate(&request)), "invalid_playback_metrics");
    }
    #[test]
    fn retry_preserves_closed_meter_and_fallback_preserves_unsampled_prefix() {
        let mut request: PlaybackRequest = serde_json::from_value(json!({
            "room_id":Uuid::nil(), "media_generation":1,
            "viewer_id":Uuid::nil(), "plan_generation":2,
            "playback_metrics_version":1,
            "playback_metrics":{"meter_start_generation":1,"startup_origin":"user_intent"}
        }))
        .unwrap();
        let mut slot = current(None);
        assert_eq!(
            admission(&slot, &request, 1, false).unwrap(),
            Admission::Preserve
        );
        slot.closed = true;
        assert_eq!(
            admission(&slot, &request, 1, true).unwrap(),
            Admission::Preserve
        );
        assert_eq!(
            reason(admission(&slot, &request, 1, false)),
            "playback_metrics_closed"
        );
        request
            .playback_metrics
            .as_mut()
            .unwrap()
            .meter_start_generation = 2;
        assert_eq!(
            admission(&slot, &request, 1, false).unwrap(),
            Admission::Replace
        );
        assert_eq!(
            reason(admission(&slot, &request, 1, true)),
            "stale_playback_metrics"
        );
        request.playback_metrics = None;
        request.playback_metrics_version = None;
        assert_eq!(
            admission(&slot, &request, 1, false).unwrap(),
            Admission::Close
        );
        assert_eq!(
            admission(&slot, &request, 1, true).unwrap(),
            Admission::Preserve
        );
    }
    #[test]
    fn continuation_cannot_change_origin_media_lifecycle_or_current_plan() {
        let request: PlaybackRequest = serde_json::from_value(json!({
            "room_id":Uuid::nil(), "media_generation":1,
            "viewer_id":Uuid::nil(), "plan_generation":2,
            "playback_metrics_version":1,
            "playback_metrics":{"meter_start_generation":1,"startup_origin":"user_intent"}
        }))
        .unwrap();
        let slot = current(None);
        assert_eq!(
            reason(admission(&slot, &request, 2, false)),
            "stale_playback_metrics"
        );
        let mut changed = request.clone();
        changed.media_generation = 2;
        assert_eq!(
            reason(admission(&slot, &changed, 1, false)),
            "stale_playback_metrics"
        );
        changed = request.clone();
        changed.plan_generation = Some(3);
        assert_eq!(
            reason(admission(&slot, &changed, 1, false)),
            "stale_playback_metrics"
        );
        changed = request;
        changed.playback_metrics.as_mut().unwrap().startup_origin =
            PlaybackMetricsOrigin::AutomaticLoad;
        assert_eq!(
            reason(admission(&slot, &changed, 1, false)),
            "stale_playback_metrics"
        );
    }
    #[test]
    fn independent_sequences_replay_without_credit_and_allow_gaps() {
        let previous = sample(1000, 8);
        let slot = current(Some(previous.clone()));
        assert!(transition(&slot, &previous).unwrap().is_none());
        assert_eq!(
            reason(transition(&slot, &sample(2000, 7))),
            "playback_metrics_sequence_stale"
        );
        assert_eq!(
            reason(transition(&slot, &sample(2000, 8))),
            "playback_metrics_conflict"
        );
        assert_eq!(
            transition(&slot, &sample(3000, 20))
                .unwrap()
                .unwrap()
                .delta
                .sum(),
            2000
        );
    }
    #[test]
    fn category_regressions_and_first_frame_mutation_fail() {
        let mut previous = sample(2000, 1);
        previous.first_frame = Some(PlaybackMetricsFirstFrame {
            elapsed_ms: 100,
            confirmed_elapsed_ms: 120,
            evidence: protocol::PlaybackMetricsFrameEvidence::VideoFrameCallback,
        });
        let slot = current(Some(previous.clone()));
        let mut next = sample(3000, 2);
        assert_eq!(
            reason(transition(&slot, &next)),
            "playback_metrics_conflict"
        );
        next.first_frame = previous.first_frame.clone();
        assert!(transition(&slot, &next).unwrap().unwrap().first.is_none());
        next.totals.startup_ms = 1999;
        next.totals.playing_ms = 1001;
        assert_eq!(
            reason(transition(&slot, &next)),
            "playback_metrics_conflict"
        );
        let slot = current(Some(sample(2000, 1)));
        next.totals.startup_ms = 3000;
        next.totals.playing_ms = 0;
        assert_eq!(
            transition(&slot, &next).unwrap().unwrap().first,
            previous.first_frame
        );
    }
    #[test]
    fn final_is_the_only_short_interval_and_closed_replay_is_exact() {
        let slot = current(Some(sample(1000, 1)));
        let mut terminal = sample(1001, 2);
        assert_eq!(reason(transition(&slot, &terminal)), "rate_limited");
        terminal.final_sample = true;
        assert_eq!(
            transition(&slot, &terminal).unwrap().unwrap().delta.sum(),
            1
        );
        let closed = current(Some(terminal.clone()));
        assert!(transition(&closed, &terminal).unwrap().is_none());
        assert_eq!(
            reason(transition(&closed, &sample(3000, 3))),
            "playback_metrics_closed"
        );
    }
    #[test]
    fn anchor_lead_is_fixed_and_initial_prefix_is_not_backdated() {
        assert!(within_anchor(&sample(604_800_000, 1), 604_800_000, 0));
        assert!(within_anchor(&sample(16_000, 2), 1000, 0));
        assert!(!within_anchor(&sample(16_001, 3), 1000, 0));
        assert!(within_anchor(&sample(17_000, 3), 1000, 1000));
        assert!(!within_anchor(&sample(32_000, 4), 1000, 1000));
        assert!(!within_anchor(&sample(999, 2), 1000, 20_000));
        assert!(!within_anchor(&sample(16_001, 2), 1000, -1000));
    }
    #[test]
    fn rate_map_is_bounded_monotonic_and_expires_only_rate_state() {
        let mut map = RateMap::default();
        let now = Instant::now();
        let identity = RateIdentity {
            user: Uuid::nil(),
            room: Uuid::nil(),
            viewer: Uuid::nil(),
        };
        for _ in 0..RATE_REQUESTS {
            assert!(map.admit(identity, now).is_ok());
        }
        assert_eq!(map.admit(identity, now), Err(RateRejection::Limited));
        assert!(map.admit(identity, now + RATE_WINDOW).is_ok());
        for value in 1..MAX_RATE_IDENTITIES {
            let identity = RateIdentity {
                viewer: Uuid::from_u128(value as u128),
                ..identity
            };
            assert!(map.admit(identity, now + RATE_WINDOW).is_ok());
        }
        let extra = RateIdentity {
            viewer: Uuid::from_u128(MAX_RATE_IDENTITIES as u128),
            ..identity
        };
        assert_eq!(
            map.admit(extra, now + RATE_WINDOW),
            Err(RateRejection::Capacity)
        );
        assert_eq!(map.entries.len(), MAX_RATE_IDENTITIES);
        assert!(map.admit(extra, now + RATE_WINDOW + RATE_EXPIRY).is_ok());
        assert_eq!(map.entries.len(), 1);
    }
    #[test]
    fn cookie_size_and_duplicate_authentication_are_bounded() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("rainsync_session={}", "a".repeat(64))
                .parse()
                .unwrap(),
        );
        assert_eq!(session_hash(&headers), Some(hash(&"a".repeat(64))));
        headers.append(
            header::COOKIE,
            format!("rainsync_session={}", "a".repeat(64))
                .parse()
                .unwrap(),
        );
        assert!(session_hash(&headers).is_none());
        headers.remove(header::COOKIE);
        headers.insert(
            header::COOKIE,
            format!(
                "rainsync_session={}; other={}",
                "a".repeat(64),
                "x".repeat(MAX_COOKIE_BYTES)
            )
            .parse()
            .unwrap(),
        );
        assert!(session_hash(&headers).is_none());
    }
}
