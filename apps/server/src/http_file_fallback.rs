//! One HTTP Binary representation, one atomic decoder continuation. The
//! encrypted request ledger is the authority; observations never grant access.
use crate::*;
use media_core::job_health::PendingJobHealth;
use persistence::http_file_authorization::{self as authorization, Context};
use persistence::media_job_timing::{CancellationScope, cancel_jobs};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction, postgres::PgRow};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Authority {
    pub context: Context,
    pub media_id: Uuid,
    pub media_generation: u32,
    pub source_id: Uuid,
    pub source_policy_revision: i64,
    pub audio_intent: Option<u32>,
    pub claim: Option<Claim>,
    // Older continuation contexts omit this independently scoped expectation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<CandidateExpectation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateExpectation {
    pub target_sha256: String,
    pub identity: Identity,
    pub expires: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub parent: Uuid,
    pub target_sha256: String,
    pub identity: Identity,
    pub deadline_ms: f64,
    pub audio: Audio,
}

// The wire shape is the published Worker 0034 identity. Only a closed,
// reliable Binary identity is copied, independently into every new attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    version: u8,
    metadata: Metadata,
    class: Option<String>,
    consumed: bool,
    changed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    etag: Option<String>,
    modified: Option<String>,
    reliable_modified: bool,
    size: Option<u64>,
}

/// An existing value with no index positively means no audio. Absence of the
/// entire value, or an unknown/multiple stream set, is never equivalent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Audio {
    pub index: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Root {
    version: u8,
    audio: Audio,
}

fn required() -> Error {
    err(StatusCode::CONFLICT, "source_version_required")
}
fn changed() -> Error {
    err(StatusCode::CONFLICT, "source_changed")
}
fn invalid_grant() -> Error {
    err(StatusCode::GONE, "invalid_playback_session")
}

pub fn validate(body: &protocol::PlaybackRequest) -> Result<()> {
    if body.http_file_fallback_version.is_some_and(|v| v != 1) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "unsupported_http_file_fallback_version",
        ));
    }
    if body.http_file_fallback.is_some()
        && (body.http_file_fallback_version != Some(1)
            || body.idempotency_key.is_none()
            || body.viewer_id.is_none()
            || !body.plan_generation.is_some_and(|v| v > 0)
            || body.mode.as_deref() != Some("transcode")
            || body.candidate_report.is_some())
    {
        return Err(required());
    }
    if !body.position_ms.is_finite() || body.position_ms < 0.0 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_position"));
    }
    Ok(())
}

fn strong_etag(value: &str) -> bool {
    value.len() <= 1024
        && value.len() >= 2
        && value.starts_with('"')
        && value.ends_with('"')
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|v| *v == 0x21 || (0x23..=0x7e).contains(v) || *v >= 0x80)
}

// Worker-produced dates are canonical IMF-fixdate. Do not let an unbounded or
// malformed persisted value become an upstream conditional header.
fn canonical_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 29
        || !value.is_ascii()
        || &bytes[3..5] != b", "
        || bytes[7] != b' '
        || bytes[11] != b' '
        || bytes[16] != b' '
        || bytes[19] != b':'
        || bytes[22] != b':'
        || &bytes[25..] != b" GMT"
        || !["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].contains(&&value[..3])
    {
        return false;
    }
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let Some(month) = months.iter().position(|m| *m == &value[8..11]) else {
        return false;
    };
    let number = |start: usize, end: usize| -> Option<u32> {
        bytes[start..end]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| value[start..end].parse().ok())
            .flatten()
    };
    let (Some(day), Some(year), Some(hour), Some(minute), Some(second)) = (
        number(5, 7),
        number(12, 16),
        number(17, 19),
        number(20, 22),
        number(23, 25),
    ) else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if year < 1970 || day == 0 || day > days[month] || hour >= 24 || minute >= 60 || second >= 60 {
        return false;
    }
    let adjusted = if month < 2 { year - 1 } else { year };
    let weekday = (adjusted + adjusted / 4 - adjusted / 100
        + adjusted / 400
        + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][month]
        + day)
        % 7;
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday as usize] == &value[..3]
}

impl Identity {
    pub(crate) fn eligible(&self) -> bool {
        self.version == 1
            && self.class.as_deref() == Some("binary")
            && !self.changed
            && self.metadata.size.is_some()
            && self.metadata.modified.as_deref().is_none_or(canonical_date)
            && if let Some(etag) = &self.metadata.etag {
                !self.metadata.reliable_modified && strong_etag(etag)
            } else {
                self.metadata.reliable_modified && self.metadata.modified.is_some()
            }
    }
}

fn audio(meta: &Value) -> Option<Audio> {
    let streams = meta["streams"].as_array()?;
    // ffprobe returns a complete stream array, not a partial scan summary.
    if streams.iter().any(|s| s["codec_type"].as_str().is_none()) {
        return None;
    }
    let mut tracks = streams.iter().filter(|s| s["codec_type"] == "audio");
    let selected = tracks.next();
    if tracks.next().is_some() {
        return None;
    }
    Some(Audio {
        index: match selected {
            Some(stream) => Some(playback_plan::stream_index(stream)?),
            None => None,
        },
    })
}

pub fn encrypt(app: &App, authority: &Authority) -> Result<String> {
    let value = serde_json::to_value(authority).map_err(anyhow::Error::from)?;
    let encrypted = app.encrypt(&value)?;
    if encrypted.len() > 8192 {
        return Err(required());
    }
    Ok(encrypted)
}

fn decrypt(app: &App, row: &PgRow) -> Result<Option<Authority>> {
    row.get::<Option<String>, _>("http_file_context_encrypted")
        .map(|encrypted| {
            let value = app.decrypt(&encrypted)?;
            serde_json::from_value(value).map_err(|_| invalid_grant())
        })
        .transpose()
}

/// Compare the endpoint caller as well as the still-live frozen login. A
/// second live login for the same user cannot claim or replay this authority.
pub fn restore(app: &App, row: &PgRow, current: Option<&Context>) -> Result<Option<Authority>> {
    let authority = decrypt(app, row)?;
    if authority.as_ref().map(|a| &a.context) != current {
        return Err(invalid_grant());
    }
    if let Some(authority) = &authority {
        let parent: Option<Uuid> = row.get("http_file_parent");
        if parent != authority.claim.as_ref().map(|c| c.parent) {
            return Err(invalid_grant());
        }
    }
    Ok(authority)
}

pub async fn capture_root(
    tx: &mut Transaction<'_, Postgres>,
    body: &protocol::PlaybackRequest,
    state: &Value,
    context: Context,
) -> Result<Authority> {
    if state["media_generation"].as_u64() != Some(u64::from(body.media_generation)) {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    let media_id = serde_json::from_value(state["media_id"].clone()).map_err(|_| required())?;
    let row = sqlx::query("SELECT m.source_id,s.access_policy_revision FROM media_items m JOIN sources s ON s.id=m.source_id WHERE m.id=$1 AND m.available")
        .bind(media_id).fetch_optional(&mut **tx).await?.ok_or_else(required)?;
    let authority = Authority {
        context,
        media_id,
        media_generation: body.media_generation,
        source_id: row.get("source_id"),
        source_policy_revision: row.get("access_policy_revision"),
        audio_intent: body.audio_index,
        claim: None,
        candidate: None,
    };
    guard_scope(tx, &authority, state).await?;
    Ok(authority)
}

pub async fn guard_scope(
    tx: &mut Transaction<'_, Postgres>,
    authority: &Authority,
    state: &Value,
) -> Result<()> {
    if state["media_generation"].as_u64() != Some(u64::from(authority.media_generation))
        || state["media_id"].as_str() != Some(authority.media_id.to_string().as_str())
    {
        return Err(err(StatusCode::CONFLICT, "stale_media"));
    }
    source_access::guard(tx, authority.source_id, authority.source_policy_revision).await?;
    if authority.claim.is_some() || authority.candidate.is_some() {
        require_http_source(tx, authority.source_id).await?;
    }
    let current: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1 AND source_id=$2 AND available)",
    )
    .bind(authority.media_id)
    .bind(authority.source_id)
    .fetch_one(&mut **tx)
    .await?;
    if !current {
        return Err(changed());
    }
    Ok(())
}

async fn require_http_source(tx: &mut Transaction<'_, Postgres>, source: Uuid) -> Result<()> {
    let kind: String = sqlx::query_scalar("SELECT kind FROM sources WHERE id=$1")
        .bind(source)
        .fetch_one(&mut **tx)
        .await?;
    if kind != "http" {
        return Err(changed());
    }
    Ok(())
}

pub async fn guard_deadline(
    tx: &mut Transaction<'_, Postgres>,
    authority: &Authority,
) -> Result<()> {
    if let Some(candidate) = &authority.candidate {
        if authority.claim.is_some() || !candidate.identity.eligible() {
            return Err(required());
        }
        let live: bool =
            sqlx::query_scalar("SELECT clock_timestamp()<to_timestamp($1::double precision)")
                .bind(candidate.expires as f64)
                .fetch_one(&mut **tx)
                .await?;
        if !live {
            return Err(err(StatusCode::CONFLICT, "stale_capability_report"));
        }
    }
    if let Some(claim) = &authority.claim {
        if !claim.identity.eligible() || !claim.deadline_ms.is_finite() {
            return Err(required());
        }
        let live: bool = sqlx::query_scalar(
            "SELECT clock_timestamp()<to_timestamp($1::double precision/1000.0)",
        )
        .bind(claim.deadline_ms)
        .fetch_one(&mut **tx)
        .await?;
        if !live {
            return Err(err(StatusCode::GONE, "playback_request_expired"));
        }
    }
    Ok(())
}

/// Only pending preparation leases use this deadline. A successfully published
/// grant keeps its normal lifetime and current-authority delivery gates.
pub fn preparation_deadline_ms(authority: Option<&Authority>) -> Option<f64> {
    let authority = authority?;
    let claim = authority.claim.as_ref().map(|claim| claim.deadline_ms);
    let candidate = authority
        .candidate
        .as_ref()
        .map(|candidate| candidate.expires as f64 * 1000.0);
    match (claim, candidate) {
        (Some(claim), Some(candidate)) => Some(claim.min(candidate)),
        (claim, candidate) => claim.or(candidate),
    }
}

pub(crate) async fn single_identity(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
) -> Result<(String, Identity)> {
    let rows = sqlx::query(
        "SELECT target_sha256,identity FROM playback_http_representations WHERE session_id=$1 LIMIT 2",
    )
    .bind(session)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() != 1 {
        return Err(required());
    }
    let identity: Identity =
        serde_json::from_value(rows[0].get("identity")).map_err(|_| required())?;
    if !identity.eligible() {
        return Err(required());
    }
    Ok((rows[0].get("target_sha256"), identity))
}

pub(crate) fn target(resource: &Value) -> Result<String> {
    let mut url = providers::validate_url(resource["url"].as_str().ok_or_else(required)?)
        .map_err(|_| required())?;
    // Match the Worker's representation key. Fragments are never sent in an
    // HTTP request; signed query order and values remain part of the identity.
    url.set_fragment(None);
    Ok(hash(url.as_str()))
}

/// Called with the HTTP fence held at publication. Route hints do not confer
/// rights: current probe evidence, one actual Binary pin and one audio choice do.
pub async fn mark_root(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    resource: &mut Value,
    meta: &Value,
    current_metadata: bool,
    mode: &str,
    hls_supported: bool,
) -> Result<bool> {
    if resource["kind"] != "http"
        || mode != "direct"
        || resource["transport"] != "progressive"
        || !current_metadata
        || !hls_supported
        || !playback_plan::local_fallbacks(meta, mode, 0.0, true, true)
            .contains(&protocol::DecoderFallbackMode::Transcode)
        || meta["format"]["format_name"]
            .as_str()
            .is_some_and(|v| v.split(',').any(|v| v == "hls"))
    {
        return Ok(false);
    }
    let Some(audio) = audio(meta) else {
        return Ok(false);
    };
    let (digest, _) = match single_identity(tx, session).await {
        Ok(identity) => identity,
        Err(error) if error.0.is_client_error() => return Ok(false),
        Err(error) => return Err(error),
    };
    if target(resource)? != digest {
        return Ok(false);
    }
    resource["http_file_root"] =
        serde_json::to_value(Root { version: 1, audio }).map_err(anyhow::Error::from)?;
    Ok(true)
}

#[expect(
    clippy::too_many_arguments,
    reason = "Keep transaction observations separate from serialized grant authority"
)]
pub async fn claim(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    user: Uuid,
    body: &protocol::PlaybackRequest,
    state: &Value,
    context: Context,
    lifecycle_epoch: i64,
    job_health: &mut PendingJobHealth,
) -> Result<Authority> {
    let parent = body
        .http_file_fallback
        .as_ref()
        .ok_or_else(required)?
        .parent_session_id;
    let request = sqlx::query("SELECT * FROM playback_requests WHERE session_id=$1 AND user_id=$2 AND room_id=$3 FOR UPDATE")
        .bind(parent).bind(user).bind(body.room_id).fetch_optional(&mut **tx).await?.ok_or_else(required)?;
    let mut authority = restore(app, &request, Some(&context))?.ok_or_else(required)?;
    if request.get::<String, _>("status") != "completed"
        || authority.claim.is_some()
        || authority.candidate.is_some()
        || request.get::<Option<Uuid>, _>("http_file_parent").is_some()
    {
        return Err(required());
    }
    guard_scope(tx, &authority, state).await?;
    require_http_source(tx, authority.source_id).await?;
    if !persistence::source_account_policy::lock_session(tx, parent).await? {
        return Err(invalid_grant());
    }
    // Worker always takes HTTP fence before session locks. Final observation
    // and retirement follow that order in this same transaction.
    http_representation::guard(tx, parent).await?;
    let grant = playback_observations::lock_grant(tx, parent, user)
        .await?
        .ok_or_else(invalid_grant)?;
    let row = &grant.row;
    if row.get::<Uuid, _>("room_id") != body.room_id
        || row.get::<Uuid, _>("media_id") != authority.media_id
        || row.get::<i64, _>("generation") != i64::from(body.media_generation)
        || row.get::<i64, _>("lifecycle_epoch") != lifecycle_epoch
        || row.get::<Option<Uuid>, _>("viewer_id") != body.viewer_id
        || !row
            .get::<Option<i64>, _>("plan_generation")
            .is_some_and(|v| body.plan_generation.is_some_and(|new| i64::from(new) > v))
    {
        return Err(required());
    }
    super::guard_generation(
        tx,
        user,
        body.room_id,
        row.get("viewer_id"),
        row.get::<Option<i64>, _>("plan_generation")
            .map(|v| v as u32),
    )
    .await?;
    let outer: Value = row.get("resource");
    if !authorization::resource_scope_matches(&outer, Some(user), Some(body.room_id))
        || outer["http_file_context"]
            != serde_json::to_value(&context).map_err(anyhow::Error::from)?
    {
        return Err(invalid_grant());
    }
    let resource = app.decrypt(outer["encrypted"].as_str().ok_or_else(required)?)?;
    let root: Root =
        serde_json::from_value(resource["http_file_root"].clone()).map_err(|_| required())?;
    if root.version != 1
        || resource["kind"] != "http"
        || resource["delivery_mode"] != "direct"
        || resource["transport"] != "progressive"
        || body.audio_index != root.audio.index
        || body
            .capabilities
            .as_ref()
            .is_some_and(|c| !c.supports_hls())
    {
        return Err(required());
    }
    let (target_sha256, identity) = single_identity(tx, parent).await?;
    if target(&resource)? != target_sha256 {
        return Err(required());
    }
    let claimed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM playback_requests WHERE http_file_parent=$1)",
    )
    .bind(parent)
    .fetch_one(&mut **tx)
    .await?;
    if claimed {
        return Err(required());
    }
    check_live_parent(tx, parent).await?;
    if let Some(sample) = &body.http_file_fallback.as_ref().unwrap().final_observation {
        playback_observations::accept(tx, &grant, sample, false).await?;
    }
    // Sample acceptance can wait on its own row; recheck wall-clock expiry and
    // current policy after every wait, before freezing and retiring authority.
    check_live_parent(tx, parent).await?;
    let deadline_ms: f64 = sqlx::query_scalar("SELECT EXTRACT(EPOCH FROM LEAST(expires_at,clock_timestamp()+interval '335 seconds'))::double precision*1000.0 FROM playback_sessions WHERE id=$1")
        .bind(parent).fetch_one(&mut **tx).await?;
    authority.claim = Some(Claim {
        parent,
        target_sha256,
        identity,
        deadline_ms,
        audio: root.audio,
    });
    // Check the bounded ledger payload before accepting a destructive step.
    encrypt(app, &authority)?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(parent)
        .execute(&mut **tx)
        .await?;
    job_health.merge(cancel_jobs(&mut **tx, CancellationScope::Session(parent)).await?);
    Ok(authority)
}

async fn check_live_parent(tx: &mut Transaction<'_, Postgres>, parent: Uuid) -> Result<()> {
    let live: bool = sqlx::query_scalar("SELECT NOT stopped AND expires_at>clock_timestamp() AND playback_source_allowed(media_id,resource) FROM playback_sessions WHERE id=$1")
        .bind(parent).fetch_one(&mut **tx).await?;
    if !live {
        return Err(invalid_grant());
    }
    Ok(())
}

pub fn wrap_resource(
    app: &App,
    resource: &Value,
    authority: Option<&Authority>,
    revision: i64,
    generation: Option<i64>,
) -> Result<Value> {
    let mut outer = json!({"encrypted":app.encrypt(resource)?,"source_policy_revision":revision,"account_policy_generation":generation});
    if let Some(authority) = authority {
        outer["http_file_context"] =
            serde_json::to_value(&authority.context).map_err(anyhow::Error::from)?;
    }
    Ok(outer)
}

/// No child source I/O until its own independent pin and restricted provisional
/// session have committed. Retry attempts copy the frozen claim, never parent state.
pub async fn seed(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    authority: Option<&Authority>,
) -> Result<()> {
    let Some((target, identity)) = frozen_pin(authority) else {
        return Ok(());
    };
    if !identity.eligible() {
        return Err(required());
    }
    sqlx::query("SELECT lock_playback_http_representation($1)")
        .bind(session)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO playback_http_representations(session_id,target_sha256,identity) VALUES($1,$2,$3)")
        .bind(session).bind(target).bind(serde_json::to_value(identity).map_err(anyhow::Error::from)?)
        .execute(&mut **tx).await?;
    Ok(())
}

pub async fn verify_pin(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    authority: Option<&Authority>,
) -> Result<()> {
    let Some((expected_target, expected_identity)) = frozen_pin(authority) else {
        return Ok(());
    };
    let (target, identity) = single_identity(tx, session).await?;
    if target != expected_target
        || identity.metadata != expected_identity.metadata
        || identity.class != expected_identity.class
    {
        return Err(changed());
    }
    Ok(())
}

fn frozen_pin(authority: Option<&Authority>) -> Option<(&str, &Identity)> {
    let authority = authority?;
    if let Some(candidate) = &authority.candidate {
        Some((&candidate.target_sha256, &candidate.identity))
    } else {
        authority
            .claim
            .as_ref()
            .map(|claim| (claim.target_sha256.as_str(), &claim.identity))
    }
}

/// The restriction remains inside the encrypted resource. It creates no new
/// authorization and prevents the Worker from expanding a Binary into HLS.
pub fn restrict_binary(resource: &mut Value) -> Result<()> {
    resource["http_file_binary_only"] = json!({"version":1,"target_sha256":target(resource)?});
    Ok(())
}

pub fn verify_target(resource: &Value, authority: Option<&Authority>) -> Result<()> {
    if let Some((expected, _)) = frozen_pin(authority)
        && target(resource)? != expected
    {
        return Err(changed());
    }
    Ok(())
}

pub async fn parent_resource(app: &App, authority: &Authority) -> Result<Value> {
    let claim = authority.claim.as_ref().ok_or_else(required)?;
    let outer: Value = sqlx::query_scalar(
        "SELECT resource FROM playback_sessions WHERE id=$1 AND user_id=$2 AND room_id=$3",
    )
    .bind(claim.parent)
    .bind(authority.context.user_id)
    .bind(authority.context.room_id)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(required)?;
    let mut resource = app.decrypt(outer["encrypted"].as_str().ok_or_else(required)?)?;
    if resource["kind"] != "http"
        || target(&resource)? != claim.target_sha256
        || resource["source_id"] != json!(authority.source_id)
        || resource["source_policy_revision"] != json!(authority.source_policy_revision)
    {
        return Err(changed());
    }
    resource
        .as_object_mut()
        .ok_or_else(required)?
        .remove("http_file_root");
    resource.as_object_mut().unwrap().remove("job_id");
    Ok(resource)
}

pub fn verify_audio(meta: &Value, authority: Option<&Authority>) -> Result<()> {
    if let Some(claim) = authority.and_then(|a| a.claim.as_ref())
        && audio(meta).as_ref() != Some(&claim.audio)
    {
        return Err(changed());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> Identity {
        serde_json::from_value(json!({"version":1,"metadata":{"etag":"\"a\"","modified":null,"reliable_modified":false,"size":100},"class":"binary","consumed":true,"changed":false})).unwrap()
    }
    #[test]
    fn old_contexts_remain_readable_and_candidate_pins_grant_no_parent_authority() {
        let old = json!({"context":{"version":1,"user_id":Uuid::nil(),"room_id":Uuid::nil(),
            "membership_epoch":Uuid::nil(),"login_hash":"ab".repeat(32)},"media_id":Uuid::nil(),
            "media_generation":1,"source_id":Uuid::nil(),"source_policy_revision":0,"audio_intent":null,"claim":null});
        let mut authority: Authority = serde_json::from_value(old.clone()).unwrap();
        assert!(authority.candidate.is_none());
        assert_eq!(preparation_deadline_ms(Some(&authority)), None);
        assert_eq!(serde_json::to_value(&authority).unwrap(), old);
        authority.candidate = Some(CandidateExpectation {
            target_sha256: hash("https://source.invalid/file?b=2&a=1"),
            identity: identity(),
            expires: 123,
        });
        assert!(authority.claim.is_none());
        assert_eq!(preparation_deadline_ms(Some(&authority)), Some(123_000.0));
        assert!(
            verify_target(
                &json!({"url":"https://source.invalid/file?b=2&a=1#position"}),
                Some(&authority)
            )
            .is_ok()
        );
        assert_eq!(
            verify_target(
                &json!({"url":"https://source.invalid/file?a=1&b=2"}),
                Some(&authority)
            )
            .unwrap_err()
            .1,
            "source_changed"
        );
        assert_eq!(frozen_pin(Some(&authority)).unwrap().1, &identity());
        let mut restricted = json!({"url":"https://source.invalid/file?b=2&a=1#position"});
        restrict_binary(&mut restricted).unwrap();
        assert_eq!(
            restricted["http_file_binary_only"]["target_sha256"],
            authority.candidate.unwrap().target_sha256
        );
    }

    #[test]
    fn target_matches_worker_fragment_normalization_without_rewriting_queries() {
        let plain = target(&json!({"url":"https://source.invalid/file?b=2&a=1"})).unwrap();
        assert_eq!(
            plain,
            target(&json!({"url":"https://source.invalid/file?b=2&a=1#position"})).unwrap()
        );
        assert_ne!(
            plain,
            target(&json!({"url":"https://source.invalid/file?a=1&b=2"})).unwrap()
        );
    }
    #[test]
    fn eligibility_requires_closed_reliable_binary_identity() {
        assert!(identity().eligible());
        let base = serde_json::to_value(identity()).unwrap();
        for (field, value) in [
            ("class", json!("playlist")),
            ("class", Value::Null),
            ("version", json!(2)),
            ("changed", json!(true)),
        ] {
            let mut bad = base.clone();
            bad[field] = value;
            assert!(!serde_json::from_value::<Identity>(bad).unwrap().eligible());
        }
        for (field, value) in [
            ("etag", json!("W/\"a\"")),
            ("etag", Value::Null),
            ("size", Value::Null),
            ("modified", json!("garbage")),
            ("reliable_modified", json!(true)),
        ] {
            let mut bad = base.clone();
            bad["metadata"][field] = value;
            assert!(!serde_json::from_value::<Identity>(bad).unwrap().eligible());
        }
        let mut date = identity();
        date.metadata.etag = None;
        date.metadata.modified = Some("Wed, 21 Oct 2015 07:28:00 GMT".into());
        date.metadata.reliable_modified = true;
        assert!(date.eligible());
        date.metadata.modified = Some("Tue, 21 Oct 2015 07:28:00 GMT".into());
        assert!(!date.eligible());
        date.metadata.modified = Some("Wed, 21 Oct 2015 07:28:00 GMT".into());
        date.metadata.reliable_modified = false;
        assert!(!date.eligible());
        let mut bad = base;
        bad["metadata"]["url"] = json!("untrusted");
        assert!(serde_json::from_value::<Identity>(bad).is_err());
    }
    #[test]
    fn no_audio_requires_positive_complete_evidence() {
        assert_eq!(
            audio(&json!({"streams":[{"codec_type":"video"}]})),
            Some(Audio { index: None })
        );
        assert_eq!(
            audio(&json!({"streams":[{"codec_type":"audio","index":3}]})),
            Some(Audio { index: Some(3) })
        );
        for meta in [
            json!({}),
            json!({"streams":null}),
            json!({"streams":[{}]}),
            json!({"streams":[{"codec_type":"audio"}]}),
            json!({"streams":[{"codec_type":"audio","index":1},{"codec_type":"audio","index":2}]}),
        ] {
            assert_eq!(audio(&meta), None);
        }
    }
    #[test]
    fn continuation_is_explicit_and_cannot_become_fresh_intent() {
        let valid = json!({"room_id":Uuid::nil(),"media_generation":1,"http_file_fallback_version":1,"http_file_fallback":{"parent_session_id":Uuid::nil()},"mode":"transcode","idempotency_key":Uuid::new_v4(),"viewer_id":Uuid::new_v4(),"plan_generation":2});
        assert!(validate(&serde_json::from_value(valid.clone()).unwrap()).is_ok());
        for field in [
            "http_file_fallback_version",
            "mode",
            "idempotency_key",
            "viewer_id",
            "plan_generation",
        ] {
            let mut bad = valid.clone();
            bad.as_object_mut().unwrap().remove(field);
            assert!(validate(&serde_json::from_value(bad).unwrap()).is_err());
        }
    }

    async fn test_app() -> App {
        // Run only using a fresh cluster owned by the fixture coordinator.
        let url = std::env::var("RAINSYNC_HTTP_FILE_TEST_DATABASE")
            .expect("owned test database required");
        let db = persistence::connect(&url).await.unwrap();
        persistence::migrate(&db).await.unwrap();
        App {
            presence_sequence: Default::default(),
            account_security: account_security::Security::configured().unwrap(),
            avatar_settings: avatar_image::Settings::configured().unwrap(),
            session_limit: 8,
            queue_limit: 8,
            preview_settings: persistence::media_previews::Settings::configured().unwrap(),
            metrics: Default::default(),
            readiness: Default::default(),
            db,
            origin: "http://localhost".into(),
            secure: false,
            key: Arc::new(Aes256Gcm::new_from_slice(&[0; 32]).unwrap()),
            epoch: Uuid::new_v4(),
            start: Instant::now(),
            rooms: Default::default(),
            agent_controls: Default::default(),
            upstream: Default::default(),
            upstream_policy: Default::default(),
            preparations: Default::default(),
        }
    }

    struct Fixture {
        user: Uuid,
        body: protocol::PlaybackRequest,
        parent: Uuid,
        login: String,
        headers: HeaderMap,
    }
    async fn fixture(app: &App) -> Fixture {
        let user = Uuid::new_v4();
        let room = Uuid::new_v4();
        let source = Uuid::new_v4();
        let media = Uuid::new_v4();
        let login_token = token();
        let login = hash(&login_token);
        sqlx::query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'fixture')")
            .bind(user)
            .bind(user.to_string())
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'csrf',now()+interval '1 hour')").bind(&login).bind(user).execute(&app.db).await.unwrap();
        sqlx::query("INSERT INTO rooms(id,name,owner_id) VALUES($1,'fixture',$2)")
            .bind(room)
            .bind(user)
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
            .bind(room)
            .bind(user)
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sources(id,name,kind,config_encrypted) VALUES($1,'fixture','http','fixture')").bind(source).execute(&app.db).await.unwrap();
        sqlx::query(
            "INSERT INTO media_items(id,source_id,title,resource) VALUES($1,$2,'fixture','file')",
        )
        .bind(media)
        .bind(source)
        .execute(&app.db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO room_snapshots(room_id,state) VALUES($1,$2)")
            .bind(room)
            .bind(json!({"media_id":media,"media_generation":1}))
            .execute(&app.db)
            .await
            .unwrap();
        let body: protocol::PlaybackRequest = serde_json::from_value(json!({"room_id":room,"media_generation":1,"mode":"direct","http_file_fallback_version":1,"idempotency_key":Uuid::new_v4(),"viewer_id":Uuid::new_v4(),"plan_generation":1})).unwrap();
        let super::super::Start::Reserved(reservation) =
            super::super::begin_authenticated(app, user, &body, Some(&login))
                .await
                .unwrap()
        else {
            panic!("new reservation");
        };
        let parent = reservation.session;
        let resource = json!({"kind":"http","url":"http://127.0.0.1/file","source_id":source,"source_policy_revision":0,"delivery_mode":"direct","transport":"progressive","http_file_root":{"version":1,"audio":{"index":null}}});
        let mut tx = app.db.begin().await.unwrap();
        let outer =
            wrap_resource(app, &resource, reservation.http_file.as_deref(), 0, None).unwrap();
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,1,$5,$6,now()+interval '30 minutes',$7,$8,1)")
            .bind(parent).bind(user).bind(room).bind(media).bind(hash(&token())).bind(outer).bind(reservation.lifecycle_epoch).bind(body.viewer_id).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO playback_http_representations(session_id,target_sha256,identity) VALUES($1,$2,$3)").bind(parent).bind(hash("http://127.0.0.1/file")).bind(serde_json::to_value(identity()).unwrap()).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO playback_observations(session_id,user_id,room_id,media_id,generation,timeline_origin_ms,duration_ms) VALUES($1,$2,$3,$4,1,0,10000)").bind(parent).bind(user).bind(room).bind(media).execute(&mut *tx).await.unwrap();
        super::super::complete(
            app,
            &mut tx,
            &reservation,
            &json!({"session_id":parent,"http_file_fallback_version":1}),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("rainsync_session={login_token}").parse().unwrap(),
        );
        headers.insert(header::ORIGIN, "http://localhost".parse().unwrap());
        headers.insert("x-csrf-token", "csrf".parse().unwrap());
        Fixture {
            user,
            body,
            parent,
            login,
            headers,
        }
    }
    fn child(f: &Fixture) -> protocol::PlaybackRequest {
        let mut body = f.body.clone();
        body.idempotency_key = Some(Uuid::new_v4());
        body.plan_generation = Some(2);
        body.mode = Some("transcode".into());
        body.http_file_fallback = Some(protocol::HttpFileFallback {
            parent_session_id: f.parent,
            final_observation: Some(protocol::PlaybackObservation {
                media_generation: 1,
                seq: 1,
                event: protocol::PlaybackObservationEvent::Progress,
                media_time_ms: 500.0,
                paused: true,
                seeking: false,
                buffering: false,
                playback_rate: 1.0,
                has_played: true,
            }),
        });
        body
    }
    async fn is_stopped(app: &App, id: Uuid) -> bool {
        sqlx::query_scalar("SELECT stopped FROM playback_sessions WHERE id=$1")
            .bind(id)
            .fetch_one(&app.db)
            .await
            .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires fresh owned RAINSYNC_HTTP_FILE_TEST_DATABASE"]
    async fn isolated_atomic_claim_contract() {
        let app = test_app().await;
        // Initial opt-in is global on the client. Non-HTTP reservations keep
        // legacy admission without requiring a login hash or HTTP context.
        for kind in ["local", "agent", "jellyfin", "emby"] {
            let f = fixture(&app).await;
            sqlx::query("UPDATE sources SET kind=$2 WHERE id=(SELECT source_id FROM media_items WHERE id=(SELECT media_id FROM playback_sessions WHERE id=$1))")
                .bind(f.parent).bind(kind).execute(&app.db).await.unwrap();
            let mut request = f.body.clone();
            request.idempotency_key = Some(Uuid::new_v4());
            request.viewer_id = Some(Uuid::new_v4());
            let super::super::Start::Reserved(reservation) =
                super::super::begin(&app, f.user, &request).await.unwrap()
            else {
                panic!("non-HTTP reservation");
            };
            assert!(
                reservation.http_file.is_none(),
                "{kind} keeps provider admission"
            );
            assert!(sqlx::query_scalar::<_,bool>("SELECT http_file_context_encrypted IS NULL AND http_file_parent IS NULL FROM playback_requests WHERE session_id=$1")
                .bind(reservation.session).fetch_one(&app.db).await.unwrap());
        }
        let f = fixture(&app).await;
        // Two simultaneously live logins for the same user are distinct authority.
        let second_login = hash(&token());
        sqlx::query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,'csrf',now()+interval '1 hour')").bind(&second_login).bind(f.user).execute(&app.db).await.unwrap();
        let request = child(&f);
        assert!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&second_login))
                .await
                .is_err()
        );
        assert!(
            super::super::begin_authenticated(&app, f.user, &f.body, Some(&second_login))
                .await
                .is_err()
        );
        assert!(!is_stopped(&app, f.parent).await);
        let mut invalid = request.clone();
        invalid
            .http_file_fallback
            .as_mut()
            .unwrap()
            .final_observation
            .as_mut()
            .unwrap()
            .seq = 0;
        assert!(
            super::super::begin_authenticated(&app, f.user, &invalid, Some(&f.login))
                .await
                .is_err()
        );
        assert!(!is_stopped(&app, f.parent).await);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT seq FROM playback_observations WHERE session_id=$1"
            )
            .bind(f.parent)
            .fetch_one(&app.db)
            .await
            .unwrap(),
            0
        );
        let super::super::Start::Reserved(first) =
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap()
        else {
            panic!("claim");
        };
        assert!(is_stopped(&app, f.parent).await);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT seq FROM playback_observations WHERE session_id=$1"
            )
            .bind(f.parent)
            .fetch_one(&app.db)
            .await
            .unwrap(),
            1
        );
        let frozen = serde_json::to_value(first.http_file.as_deref().unwrap()).unwrap();
        assert!(
            super::super::begin_authenticated(&app, f.user, &child(&f), Some(&f.login))
                .await
                .is_err()
        );
        super::super::fail(
            &app,
            &first,
            &err(StatusCode::GATEWAY_TIMEOUT, "playback_request_interrupted"),
        )
        .await
        .unwrap();
        let super::super::Start::Reserved(retry) =
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap()
        else {
            panic!("retry");
        };
        assert_ne!(first.session, retry.session);
        assert_eq!(
            serde_json::to_value(retry.http_file.as_deref().unwrap()).unwrap(),
            frozen
        );
        // Provisional child identity is copied before any Worker source I/O.
        let mut tx = app.db.begin().await.unwrap();
        let resource = parent_resource(&app, retry.http_file.as_deref().unwrap())
            .await
            .unwrap();
        let outer = wrap_resource(&app, &resource, retry.http_file.as_deref(), 0, None).unwrap();
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) SELECT $1,user_id,room_id,media_id,generation,$2,$3,now()+interval '1 minute',lifecycle_epoch,viewer_id,2 FROM playback_sessions WHERE id=$4")
            .bind(retry.session).bind(hash(&token())).bind(outer).bind(f.parent).execute(&mut *tx).await.unwrap();
        seed(&mut tx, retry.session, retry.http_file.as_deref())
            .await
            .unwrap();
        verify_pin(&mut tx, retry.session, retry.http_file.as_deref())
            .await
            .unwrap();
        super::super::complete(&app, &mut tx, &retry, &json!({"session_id":retry.session}))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!(matches!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap(),
            super::super::Start::Replay(_)
        ));
        assert!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&second_login))
                .await
                .is_err()
        );
        let _ = media::stop(
            State(app.clone()),
            f.headers.clone(),
            Path(f.parent),
            serde_json::to_vec(
                request
                    .http_file_fallback
                    .as_ref()
                    .unwrap()
                    .final_observation
                    .as_ref()
                    .unwrap(),
            )
            .unwrap()
            .into(),
        )
        .await
        .unwrap();
        assert!(!is_stopped(&app, retry.session).await);
        let _ = super::super::cancel(
            State(app.clone()),
            f.headers.clone(),
            Path(request.idempotency_key.unwrap()),
        )
        .await
        .unwrap();
        assert!(is_stopped(&app, retry.session).await);
        assert_eq!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .err()
                .unwrap()
                .1,
            "playback_request_cancelled"
        );
        // Stop-before-begin is a durable tombstone and cannot retire its parent.
        let f = fixture(&app).await;
        let request = child(&f);
        let _ = super::super::cancel(
            State(app.clone()),
            f.headers.clone(),
            Path(request.idempotency_key.unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .err()
                .unwrap()
                .1,
            "playback_request_cancelled"
        );
        assert!(!is_stopped(&app, f.parent).await);
        // Two keys race; only one preserves the sample and obtains the unique claim.
        let f = fixture(&app).await;
        let a = child(&f);
        let b = child(&f);
        let (a, b) = tokio::join!(
            super::super::begin_authenticated(&app, f.user, &a, Some(&f.login)),
            super::super::begin_authenticated(&app, f.user, &b, Some(&f.login))
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM playback_requests WHERE http_file_parent=$1"
            )
            .bind(f.parent)
            .fetch_one(&app.db)
            .await
            .unwrap(),
            1
        );
        // Removal/rejoin cannot restore frozen authority, even with the same login.
        let f = fixture(&app).await;
        sqlx::query("DELETE FROM room_members WHERE room_id=$1 AND user_id=$2")
            .bind(f.body.room_id)
            .bind(f.user)
            .execute(&app.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO room_members(room_id,user_id) VALUES($1,$2)")
            .bind(f.body.room_id)
            .bind(f.user)
            .execute(&app.db)
            .await
            .unwrap();
        assert!(
            super::super::begin_authenticated(&app, f.user, &child(&f), Some(&f.login))
                .await
                .is_err()
        );
        assert!(
            super::super::begin_authenticated(&app, f.user, &f.body, Some(&f.login))
                .await
                .is_err()
        );
        // Publication cannot outlive cancellation, source changes or the frozen deadline.
        let f = fixture(&app).await;
        sqlx::query("UPDATE sources SET kind='local' WHERE id=(SELECT source_id FROM media_items WHERE id=(SELECT media_id FROM playback_sessions WHERE id=$1))")
            .bind(f.parent).execute(&app.db).await.unwrap();
        assert_eq!(
            super::super::begin_authenticated(&app, f.user, &child(&f), Some(&f.login))
                .await
                .err()
                .unwrap()
                .1,
            "source_changed"
        );
        assert!(!is_stopped(&app, f.parent).await);
        let f = fixture(&app).await;
        let request = child(&f);
        let super::super::Start::Reserved(reservation) =
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap()
        else {
            panic!("claim");
        };
        sqlx::query(
            "UPDATE sources SET config_encrypted='changed-fixture',access_policy_revision=access_policy_revision+1 WHERE id=$1",
        )
        .bind(reservation.http_file.as_deref().unwrap().source_id)
        .execute(&app.db)
        .await
        .unwrap();
        assert!(
            super::super::guard(&app, &mut app.db.begin().await.unwrap(), &reservation)
                .await
                .is_err()
        );
        let mut expired = reservation.http_file.as_deref().unwrap().clone();
        expired.claim.as_mut().unwrap().deadline_ms = 1.0;
        assert_eq!(
            guard_deadline(&mut app.db.begin().await.unwrap(), &expired)
                .await
                .err()
                .unwrap()
                .1,
            "playback_request_expired"
        );
        println!(
            "PASS: atomic observation/claim, live-login binding, immutable retry, seeded pin, replay, parent cleanup, cancel tombstones, concurrent keys, rejoin and source/deadline fences"
        );
        app.db.close().await;
    }

    #[tokio::test]
    #[ignore = "requires fresh owned RAINSYNC_HTTP_FILE_TEST_DATABASE"]
    async fn isolated_candidate_expectation_contract() {
        let app = test_app().await;
        let f = fixture(&app).await;
        let row = sqlx::query("SELECT * FROM playback_requests WHERE session_id=$1")
            .bind(f.parent)
            .fetch_one(&app.db)
            .await
            .unwrap();
        let lifecycle_epoch: i64 = row.get("lifecycle_epoch");
        let mut authority = decrypt(&app, &row).unwrap().unwrap();
        let mut clock_tx = app.db.begin().await.unwrap();
        let before: i64 =
            sqlx::query_scalar("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
                .fetch_one(&mut *clock_tx)
                .await
                .unwrap();
        let expires = playback_capabilities::http_expiry(&mut clock_tx)
            .await
            .unwrap();
        let after: i64 =
            sqlx::query_scalar("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
                .fetch_one(&mut *clock_tx)
                .await
                .unwrap();
        assert!(
            (before + 300..=after + 300).contains(&(expires as i64)),
            "expiry comes from the DB clock"
        );
        clock_tx.commit().await.unwrap();
        authority.candidate = Some(CandidateExpectation {
            target_sha256: hash("http://127.0.0.1/file"),
            identity: identity(),
            expires,
        });
        let candidates = media_core::capabilities::candidates(
            &json!({"streams":[{"codec_type":"video","codec_name":"h264"}]}),
            None,
            0.0,
        )
        .unwrap();
        let binding = app
            .encrypt(
                &json!({"purpose":"actual_http_file_capabilities_v1","lifecycle_epoch":lifecycle_epoch,
            "authority":authority,"candidates":candidates}),
            )
            .unwrap();
        let mut request = f.body.clone();
        request.idempotency_key = Some(Uuid::new_v4());
        request.plan_generation = Some(2);
        request.mode = Some("auto".into());
        request.http_file_fallback_version = None;
        request.capabilities = Some(
            serde_json::from_value(
                json!({"progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":true}),
            )
            .unwrap(),
        );
        request.candidate_report=Some(serde_json::from_value(json!({"binding":binding,"results":[{"candidate_id":"transcode_720p","progressive":"probably","mse_supported":true}]})).unwrap());
        let mut explicit_direct = request.clone();
        explicit_direct.mode = Some("direct".into());
        assert_eq!(
            super::super::begin_authenticated(&app, f.user, &explicit_direct, Some(&f.login))
                .await
                .err()
                .unwrap()
                .1,
            "stale_capability_report"
        );
        let super::super::Start::Reserved(first) =
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap()
        else {
            panic!("candidate reservation")
        };
        assert!(first.http_file.as_deref().unwrap().claim.is_none());
        assert_eq!(
            serde_json::to_value(first.http_file.as_deref().unwrap()).unwrap(),
            serde_json::to_value(&authority).unwrap()
        );
        assert!(
            sqlx::query_scalar::<_, bool>(
                "SELECT http_file_parent IS NULL FROM playback_requests WHERE session_id=$1"
            )
            .bind(first.session)
            .fetch_one(&app.db)
            .await
            .unwrap()
        );
        // A waited HTTP fence cannot publish a binding after its probe or
        // request lease expires. Keep the fixture wait below one second.
        let resource = json!({"kind":"http","url":"http://127.0.0.1/file"});
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch) VALUES($1,$2,$3,$4,1,$6,$5,clock_timestamp()+interval '1 minute',$7)")
            .bind(first.session).bind(f.user).bind(f.body.room_id).bind(authority.media_id)
            .bind(wrap_resource(&app,&resource,first.http_file.as_deref(),0,None).unwrap()).bind(hash(&token())).bind(lifecycle_epoch).execute(&app.db).await.unwrap();
        for expiry in ["probe", "request"] {
            if expiry == "probe" {
                sqlx::query("UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1")
                    .bind(first.session).execute(&app.db).await.unwrap();
            } else {
                sqlx::query("UPDATE playback_sessions SET expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1")
                    .bind(first.session).execute(&app.db).await.unwrap();
                sqlx::query("UPDATE playback_requests SET lease_until=clock_timestamp()+interval '250 milliseconds' WHERE session_id=$1")
                    .bind(first.session).execute(&app.db).await.unwrap();
            }
            let mut blocker = app.db.begin().await.unwrap();
            sqlx::query("SELECT lock_playback_http_representation($1)")
                .bind(first.session)
                .execute(&mut *blocker)
                .await
                .unwrap();
            let waited = async {
                let mut tx = app.db.begin().await.unwrap();
                super::super::guard(&app, &mut tx, &first).await.unwrap();
                http_representation::guard(&mut tx, first.session)
                    .await
                    .unwrap();
                super::super::guard(&app, &mut tx, &first).await?;
                playback_capabilities::require_live_probe(&mut tx, first.session).await
            };
            let release = async {
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                blocker.commit().await.unwrap();
            };
            let (result, ()) = tokio::join!(waited, release);
            assert_eq!(
                result.unwrap_err().1,
                if expiry == "probe" {
                    "invalid_playback_session"
                } else {
                    "playback_request_interrupted"
                }
            );
        }
        super::super::fail(
            &app,
            &first,
            &err(StatusCode::GATEWAY_TIMEOUT, "playback_request_interrupted"),
        )
        .await
        .unwrap();
        // A retry uses its ledger expectation, even if unrelated old evidence changes.
        sqlx::query("UPDATE playback_http_representations SET identity=jsonb_set(identity,'{metadata,etag}',$2) WHERE session_id=$1")
            .bind(f.parent).bind(json!("\"new-parent\"")).execute(&app.db).await.unwrap();
        let super::super::Start::Reserved(retry) =
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap()
        else {
            panic!("candidate retry")
        };
        assert_ne!(retry.session, first.session);
        assert_eq!(
            serde_json::to_value(retry.http_file.as_deref().unwrap()).unwrap(),
            serde_json::to_value(&authority).unwrap()
        );
        let resource = json!({"kind":"http","url":"http://127.0.0.1/file"});
        let mut tx = app.db.begin().await.unwrap();
        super::super::guard(&app, &mut tx, &retry).await.unwrap();
        sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation) VALUES($1,$2,$3,$4,1,$7,$5,clock_timestamp()+interval '1 minute',$8,$6,2)")
            .bind(retry.session).bind(f.user).bind(f.body.room_id).bind(authority.media_id).bind(wrap_resource(&app,&resource,retry.http_file.as_deref(),0,None).unwrap()).bind(request.viewer_id).bind(hash(&token())).bind(lifecycle_epoch).execute(&mut *tx).await.unwrap();
        seed(&mut tx, retry.session, retry.http_file.as_deref())
            .await
            .unwrap();
        verify_pin(&mut tx, retry.session, retry.http_file.as_deref())
            .await
            .unwrap();
        super::super::complete(&app, &mut tx, &retry, &json!({"session_id":retry.session}))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        // Binding expiry limits new preparation, not a completed session replay.
        let mut expired = authority.clone();
        expired.candidate.as_mut().unwrap().expires = 1;
        sqlx::query(
            "UPDATE playback_requests SET http_file_context_encrypted=$2 WHERE session_id=$1",
        )
        .bind(retry.session)
        .bind(encrypt(&app, &expired).unwrap())
        .execute(&app.db)
        .await
        .unwrap();
        assert!(matches!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .unwrap(),
            super::super::Start::Replay(_)
        ));
        sqlx::query("UPDATE playback_requests SET status='failed',response_encrypted=NULL,error_status=504,error_code='playback_request_interrupted' WHERE session_id=$1").bind(retry.session).execute(&app.db).await.unwrap();
        assert_eq!(
            super::super::begin_authenticated(&app, f.user, &request, Some(&f.login))
                .await
                .err()
                .unwrap()
                .1,
            "stale_capability_report"
        );
        app.db.close().await;
        println!(
            "PASS: DB-clock candidate deadline, immutable candidate ledger, NULL parent authority, independent retry pin, explicit-direct rejection, completed replay and new-attempt expiry"
        );
    }
}
