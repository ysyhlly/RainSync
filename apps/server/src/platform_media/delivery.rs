//! Same-origin native delivery. Token alone is never authorization.
use super::*;
use axum::{
    body::{Body, Bytes},
    extract::Query,
    http::Method,
};
use futures_util::{StreamExt, stream};
use providers::platform::http::MediaResponse;
use sqlx::postgres::PgRow;
pub(crate) mod owner;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenQuery {
    token: String,
}
pub(super) struct Grant {
    pub(super) sealed: Sealed,
    expires_at_ms: i64,
}
#[derive(Clone)]
pub(super) struct Authority {
    session: Uuid,
    token_hash: String,
    login_hash: String,
    user: Uuid,
}
// Native grants always have explicit viewer, originating login and target.
// Including the exact target protects against a malformed restored snapshot
// that changed media_id without advancing its media_generation.
const GATE: &str = "p.id=$1 AND p.delivery_token_hash=$2 AND p.auth_login_hash=$3 AND p.user_id=$4 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND p.viewer_id IS NOT NULL AND p.plan_generation IS NOT NULL AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND (s.state->>'media_generation')::bigint=p.generation AND s.state->>'media_id'=p.media_id::text AND playback_source_allowed(p.media_id,p.resource,p.id) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id) AND EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation AND g.auth_login_hash=p.auth_login_hash)";
async fn admit(
    app: &App,
    headers: &HeaderMap,
    session: Uuid,
    query: &TokenQuery,
) -> Result<(Authority, Grant)> {
    let user = auth_viewer(app, headers, false).await?;
    if query.token.len() != 64 || !query.token.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let authority = Authority {
        session,
        token_hash: hash(&query.token),
        login_hash: media_authorization::login_hash(headers)?,
        user: user.id,
    };
    let row=sqlx::query(&format!("SELECT p.media_id,p.room_id,p.user_id,p.resource,floor(extract(epoch FROM p.expires_at)*1000)::bigint AS expires_at_ms FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE}"))
        .bind(session).bind(&authority.token_hash).bind(&authority.login_hash).bind(user.id).fetch_optional(&app.db).await?
        .ok_or_else(invalid)?;
    let data: Value = row.get("resource");
    if data.get("native_platform_compatibility_version").is_some() {
        return Err(invalid());
    }
    let grant = decode_grant(app, &row)?;
    check(app, &authority).await?;
    Ok((authority, grant))
}
pub(super) async fn admit_compatibility(
    app: &App,
    headers: &HeaderMap,
    session: Uuid,
    token: &str,
) -> Result<(Authority, Grant)> {
    let user = auth_viewer(app, headers, false).await?;
    if token.len() != 64 || !token.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let authority = Authority {
        session,
        token_hash: hash(token),
        login_hash: media_authorization::login_hash(headers)?,
        user: user.id,
    };
    let row=sqlx::query(&format!("SELECT p.media_id,p.room_id,p.user_id,p.resource,floor(extract(epoch FROM p.expires_at)*1000)::bigint AS expires_at_ms FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE} AND p.resource->'native_platform_compatibility_version'='1'::jsonb AND native_platform_transcode_session_allowed(p.id)"))
        .bind(session).bind(&authority.token_hash).bind(&authority.login_hash).bind(user.id).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    let grant = decode_grant(app, &row)?;
    check(app, &authority).await?;
    Ok((authority, grant))
}
fn decode_grant(app: &App, row: &PgRow) -> Result<Grant> {
    decode_resource(
        app,
        row.get("resource"),
        row.get("media_id"),
        row.get("room_id"),
        row.get("user_id"),
        row.get("expires_at_ms"),
    )
}
pub(super) fn decode_resource(
    app: &App,
    resource: Value,
    media: Uuid,
    room: Uuid,
    user: Uuid,
    expires: i64,
) -> Result<Grant> {
    let fields = resource.as_object().ok_or_else(invalid)?;
    if !(fields.len() == 3
        || (fields.len() == 4 && resource["native_platform_compatibility_version"] == 1)
        || (fields.len() == 5
            && resource["native_platform_compatibility_version"] == 1
            && resource["native_platform_hls_ladder_version"] == 1))
        || !fields.contains_key("auth_context")
        || !fields.contains_key("native_platform_context")
        || !fields.contains_key("encrypted")
    {
        return Err(invalid());
    }
    let ciphertext = resource["encrypted"]
        .as_str()
        .filter(|v| v.len() <= 256 * 1024)
        .ok_or_else(invalid)?;
    let plaintext = app.decrypt(ciphertext).map_err(|_| invalid())?;
    validate_source_purpose(&plaintext, &resource)?;
    validate_plaintext(
        plaintext,
        &resource["native_platform_context"],
        media,
        room,
        user,
        expires,
    )
}
fn validate_source_purpose(plaintext: &Value, resource: &Value) -> Result<()> {
    if plaintext["descriptor"]
        .get("compatibility_source")
        .is_some()
        && resource["native_platform_compatibility_version"] != 1
    {
        return Err(invalid());
    }
    Ok(())
}
fn validate_plaintext(
    plaintext: Value,
    public_binding: &Value,
    media: Uuid,
    room: Uuid,
    user: Uuid,
    expires: i64,
) -> Result<Grant> {
    let sealed: Sealed = serde_json::from_value(plaintext.clone()).map_err(|_| invalid())?;
    // Option<T> deserialization accepts a missing key. Canonical round-trip
    // equality enforces explicit nulls and every field of this closed envelope.
    if serde_json::to_value(&sealed).map_err(anyhow::Error::from)? != plaintext {
        return Err(invalid());
    }
    let binding_json = serde_json::to_value(&sealed.binding).map_err(anyhow::Error::from)?;
    if *public_binding != binding_json
        || sealed.binding.media_id != media
        || sealed.binding.room_id != room
        || sealed.binding.user_id != user
        || expires > sealed.policy_deadline_ms()?
        || expires <= sealed.resolved_at_ms
    {
        return Err(invalid());
    }
    Ok(Grant {
        sealed,
        expires_at_ms: expires,
    })
}
pub(super) async fn check(app: &App, authority: &Authority) -> Result<()> {
    let query = format!(
        "SELECT EXISTS(SELECT 1 FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE})"
    );
    match tokio::time::timeout(
        Duration::from_secs(2),
        database_checks::boolean(
            &app.db,
            sqlx::query_scalar(&query)
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
/// Internal text authorization retains the exact immutable delivery/login
/// authority. It is deliberately neither serializable nor printable.
pub(crate) struct TextScope {
    authority: Authority,
    pub(crate) entry: native_platform::Entry,
    pub(crate) account: platform_accounts::FrozenAccount,
    pub(crate) duration_ms: u64,
}
pub(crate) async fn admit_text(
    app: &App,
    headers: &HeaderMap,
    session: Uuid,
    token: &str,
) -> Result<TextScope> {
    let marked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND resource->'native_platform_compatibility_version'='1'::jsonb)").bind(session).fetch_one(&app.db).await?;
    let (authority, grant) = if marked {
        admit_compatibility(app, headers, session, token).await?
    } else {
        admit(
            app,
            headers,
            session,
            &TokenQuery {
                token: token.into(),
            },
        )
        .await?
    };
    let generation: i64 = sqlx::query_scalar(&format!("SELECT p.generation FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id WHERE {GATE}"))
        .bind(authority.session).bind(&authority.token_hash).bind(&authority.login_hash).bind(authority.user)
        .fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    let generation = u32::try_from(generation).map_err(|_| invalid())?;
    let mut tx = app.db.begin().await?;
    let entry = native_platform::capture(&mut tx, grant.sealed.binding.room_id, generation).await?;
    tx.rollback().await?;
    let binding = &grant.sealed.binding;
    if !binding.matches_entry(&entry) {
        return Err(invalid());
    }
    let account = if binding.credential_mode == "own_account" {
        platform_accounts::load_for_provider_playback(app, authority.user, &binding.provider)
            .await?
    } else {
        platform_accounts::FrozenAccount::anonymous_for_provider(authority.user, &binding.provider)?
    };
    if account.account_id() != binding.account_id
        || account.revision().map(|v| v.to_string()) != binding.account_revision
    {
        return Err(invalid());
    }
    check(app, &authority).await?;
    let seconds = grant.sealed.descriptor.duration_seconds;
    if !seconds.is_finite() || !(0.001..=604800.0).contains(&seconds) {
        return Err(invalid());
    }
    let duration_ms = (seconds * 1000.0).ceil() as u64;
    Ok(TextScope {
        authority,
        entry,
        account,
        duration_ms,
    })
}
pub(crate) async fn check_text(app: &App, scope: &TextScope) -> Result<()> {
    // GATE includes current entry/account revision, live originating login,
    // exact viewer plan, media generation, membership and room lifecycle.
    check(app, &scope.authority).await
}

fn invalid() -> Error {
    err(StatusCode::GONE, "invalid_playback_session")
}
fn stream_error() -> std::io::Error {
    std::io::Error::other("native_platform_delivery_ended")
}
fn private_headers(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
}

pub async fn manifest(
    State(app): State<App>,
    headers: HeaderMap,
    Path(session): Path<Uuid>,
    Query(query): Query<TokenQuery>,
    method: Method,
) -> Result<Response> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(err(StatusCode::METHOD_NOT_ALLOWED, "invalid_request"));
    }
    let (authority, grant) = admit(&app, &headers, session, &query).await?;
    if grant.sealed.descriptor.transport != Transport::Dash {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    let xml = grant.sealed.descriptor.render_for(
        &grant.sealed.binding.provider,
        session,
        &query.token,
    )?;
    check(&app, &authority).await?;
    let length = xml.len();
    let mut response = Response::new(if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(xml)
    });
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/dash+xml; charset=utf-8".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
    private_headers(&mut response);
    Ok(response)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Range {
    Bounded(u64, u64),
    Open(u64),
    Suffix(u64),
}
fn range(value: &str) -> Result<Range> {
    if value.len() > 96
        || !value.starts_with("bytes=")
        || value.contains(',')
        || value.bytes().any(|c| c.is_ascii_whitespace())
    {
        return Err(range_error());
    }
    let (start, end) = value[6..].split_once('-').ok_or_else(range_error)?;
    let number = |v: &str| -> Result<u64> {
        if v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()) {
            return Err(range_error());
        }
        v.parse::<u64>().map_err(|_| range_error())
    };
    match (start.is_empty(), end.is_empty()) {
        (true, false) => {
            let n = number(end)?;
            if n == 0 {
                return Err(range_error());
            }
            Ok(Range::Suffix(n))
        }
        (false, true) => Ok(Range::Open(number(start)?)),
        (false, false) => {
            let a = number(start)?;
            let b = number(end)?;
            if a > b {
                return Err(range_error());
            }
            Ok(Range::Bounded(a, b))
        }
        _ => Err(range_error()),
    }
}
fn range_error() -> Error {
    err(
        StatusCode::RANGE_NOT_SATISFIABLE,
        "native_platform_range_invalid",
    )
}
fn effective_range(method: &Method, headers: &HeaderMap) -> Result<Option<(String, Range)>> {
    // RFC Range applies only to GET. Without a retained representation validator
    // we cannot assert an If-Range match, so serve the full representation.
    if *method != Method::GET || headers.contains_key(header::IF_RANGE) {
        return Ok(None);
    }
    requested_range(headers)
}
fn requested_range(headers: &HeaderMap) -> Result<Option<(String, Range)>> {
    let mut values = headers.get_all(header::RANGE).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(range_error());
    }
    let raw = value.to_str().map_err(|_| range_error())?;
    Ok(Some((raw.to_owned(), range(raw)?)))
}
fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (bounds, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    let number = |v: &str| {
        if !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit()) {
            v.parse::<u64>().ok()
        } else {
            None
        }
    };
    let (start, end, total) = (number(start)?, number(end)?, number(total)?);
    (start <= end && end < total).then_some((start, end, total))
}
fn response_facts(
    status: StatusCode,
    headers: &HeaderMap,
    requested: Option<Range>,
) -> Result<Option<u64>> {
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::CONTENT_ENCODING,
        header::ETAG,
    ] {
        if headers.get_all(name).iter().count() > 1 {
            return Err(upstream_invalid());
        }
    }
    if headers
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err(upstream_invalid());
    }
    let length = headers
        .get(header::CONTENT_LENGTH)
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|v| *v <= i64::MAX as u64)
        })
        .transpose_option()
        .ok_or_else(upstream_invalid)?;
    if status == StatusCode::PARTIAL_CONTENT {
        let (start, end, total) = headers
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(content_range)
            .ok_or_else(upstream_invalid)?;
        let expected = end
            .checked_sub(start)
            .and_then(|v| v.checked_add(1))
            .ok_or_else(upstream_invalid)?;
        if length != Some(expected) {
            return Err(upstream_invalid());
        }
        let matches = match requested {
            Some(Range::Bounded(a, b)) => a == start && b.min(total - 1) == end,
            Some(Range::Open(a)) => a == start && end == total - 1,
            Some(Range::Suffix(n)) => end == total - 1 && start == total - n.min(total),
            None => false,
        };
        if !matches {
            return Err(upstream_invalid());
        }
        Ok(Some(expected))
    } else if status == StatusCode::OK
        && requested.is_none()
        && !headers.contains_key(header::CONTENT_RANGE)
    {
        Ok(length)
    } else {
        Err(upstream_invalid())
    }
}
fn enforce_representation_facts(
    status: StatusCode,
    headers: &HeaderMap,
    track: &descriptor::Track,
) -> Result<()> {
    if let Some(expected_total) = track.observed_content_length {
        let actual = if status == StatusCode::PARTIAL_CONTENT {
            headers
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(content_range)
                .map(|(_, _, total)| total)
        } else {
            headers
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
        };
        if actual != Some(expected_total) {
            return Err(upstream_invalid());
        }
    }
    if let Some(expected) = &track.strong_etag
        && headers.get(header::ETAG).and_then(|v| v.to_str().ok()) != Some(expected.as_str())
    {
        return Err(upstream_invalid());
    }
    Ok(())
}

trait TransposeOption<T> {
    fn transpose_option(self) -> Option<Option<T>>;
}
impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> Option<Option<T>> {
        match self {
            None => Some(None),
            Some(Some(v)) => Some(Some(v)),
            Some(None) => None,
        }
    }
}
fn upstream_invalid() -> Error {
    err(StatusCode::BAD_GATEWAY, "native_platform_delivery_invalid")
}

pub async fn track(
    State(app): State<App>,
    headers: HeaderMap,
    Path((session, key)): Path<(Uuid, String)>,
    Query(query): Query<TokenQuery>,
    method: Method,
) -> Result<Response> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(err(StatusCode::METHOD_NOT_ALLOWED, "invalid_request"));
    }
    let (authority, grant) = admit(&app, &headers, session, &query).await?;
    if !descriptor::valid_key(&key) {
        return Err(err(StatusCode::NOT_FOUND, "media_not_found"));
    }
    let track = grant
        .sealed
        .descriptor
        .tracks
        .iter()
        .find(|t| t.key == key)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "media_not_found"))?;
    let requested = effective_range(&method, &headers)?;
    let until = grant
        .expires_at_ms
        .checked_sub(unix_ms()?)
        .filter(|v| *v > 0)
        .ok_or_else(invalid)?;
    let deadline = Deadline::now() + Duration::from_millis(until as u64);
    check(&app, &authority).await?;
    let (upstream, owned_body) = owner::start(
        &app,
        &authority,
        grant.sealed.binding.room_id,
        app.platform_http,
        owner::Request {
            provider: grant.sealed.binding.provider.clone(),
            target: track.url.clone(),
            method: method.clone(),
            range: requested.as_ref().map(|(raw, _)| raw.clone()),
            deadline,
        },
    )
    .await?;
    let status = upstream.status;
    let expected = response_facts(status, &upstream.headers, requested.map(|(_, r)| r))?;
    enforce_representation_facts(status, &upstream.headers, track)?;
    let mut output_headers =
        delivery_headers(&grant.sealed.binding.provider, &upstream.headers, track)?;
    if grant.sealed.binding.version == 4 {
        hide_course_entity_metadata(&mut output_headers);
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let state = StreamState {
            upstream: owned_body,
            remaining: expected,
        };
        // The owner task is the only in-flight GATE. Revocation closes this body.
        Body::from_stream(stream::try_unfold(state, |mut state| async move {
            let result = state
                .upstream
                .next()
                .await
                .transpose()
                .map_err(|_| stream_error())?;
            match result {
                Some(chunk) => {
                    if let Some(remaining) = state.remaining.as_mut() {
                        if chunk.len() as u64 > *remaining {
                            return Err(stream_error());
                        }
                        *remaining -= chunk.len() as u64;
                    }
                    Ok(Some((chunk, state)))
                }
                None => {
                    if state.remaining.is_some_and(|v| v != 0) {
                        return Err(stream_error());
                    }
                    Ok(None)
                }
            }
        }))
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = output_headers;
    private_headers(&mut response);
    Ok(response)
}
fn delivery_headers(
    provider: &str,
    upstream: &HeaderMap,
    track: &descriptor::Track,
) -> Result<HeaderMap> {
    let mut output = HeaderMap::new();
    for name in [header::CONTENT_LENGTH, header::CONTENT_RANGE] {
        if let Some(value) = upstream.get(&name) {
            output.insert(name, value.clone());
        }
    }
    if let Some(value) = upstream.get(header::ACCEPT_RANGES)
        && (provider != "youtube"
            || (upstream.get_all(header::ACCEPT_RANGES).iter().count() == 1
                && matches!(value.as_bytes(), b"bytes" | b"none")))
    {
        output.insert(header::ACCEPT_RANGES, value.clone());
    }
    // YouTube validators are private representation facts. Opaque provider
    // strings must not expose signed URLs or token material to the browser.
    // Retain the historical header behavior for existing providers. Course
    // callers separately remove entity metadata using their closed v4 binding.
    if provider != "youtube" {
        for name in [header::ETAG, header::LAST_MODIFIED] {
            if let Some(value) = upstream.get(&name) {
                output.insert(name, value.clone());
            }
        }
    }
    // Closed validated descriptor metadata, never arbitrary provider text.
    output.insert(
        header::CONTENT_TYPE,
        track.mime_type.parse().map_err(|_| upstream_invalid())?,
    );
    Ok(output)
}

fn hide_course_entity_metadata(headers: &mut HeaderMap) {
    headers.remove(header::ETAG);
    headers.remove(header::LAST_MODIFIED);
}

struct StreamState {
    upstream: owner::OwnedBody,
    remaining: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_hevc_source_requires_explicit_compatibility_resource_purpose() {
        let plaintext = json!({"descriptor":{"compatibility_source":"clear_hevc_main_v1"}});
        assert!(validate_source_purpose(&plaintext, &json!({})).is_err());
        assert!(
            validate_source_purpose(
                &plaintext,
                &json!({"native_platform_compatibility_version":2})
            )
            .is_err()
        );
        assert!(
            validate_source_purpose(
                &plaintext,
                &json!({"native_platform_compatibility_version":1})
            )
            .is_ok()
        );
        assert!(validate_source_purpose(&json!({"descriptor":{}}), &json!({})).is_ok());
    }
    #[test]
    fn observed_course_audio_identity_is_enforced_without_exporting_entity_metadata() {
        let mut audio = descriptor::fixture().tracks.remove(1);
        audio.observed_content_length = Some(10000);
        audio.strong_etag = Some("\"course-audio\"".into());
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/10000".parse().unwrap());
        headers.insert(header::CONTENT_LENGTH, "100".parse().unwrap());
        headers.insert(header::ETAG, "\"course-audio\"".parse().unwrap());
        headers.insert(
            header::LAST_MODIFIED,
            "Wed, 01 Jan 2020 00:00:00 GMT".parse().unwrap(),
        );
        assert!(
            response_facts(
                StatusCode::PARTIAL_CONTENT,
                &headers,
                Some(Range::Bounded(0, 99))
            )
            .is_ok()
        );
        assert!(
            enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, &audio).is_ok()
        );
        let mut public = delivery_headers("bilibili", &headers, &audio).unwrap();
        hide_course_entity_metadata(&mut public);
        assert!(!public.contains_key(header::ETAG));
        assert!(!public.contains_key(header::LAST_MODIFIED));
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/10001".parse().unwrap());
        assert!(
            enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, &audio).is_err()
        );
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/10000".parse().unwrap());
        headers.insert(header::ETAG, "\"changed\"".parse().unwrap());
        assert!(
            enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, &audio).is_err()
        );
    }
    #[test]
    fn course_version_four_grants_reject_axis_transplant_and_expiry_extension() {
        let (media, room, user) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let identity = native_platform::PgcIdentity::new_course(
            "7".into(),
            "10".into(),
            "8".into(),
            "9".into(),
        );
        let entry = native_platform::Entry {
            media_id: media,
            room_id: room,
            provider: "bilibili".into(),
            canonical_url: Some("https://www.bilibili.com/cheese/play/ep7".into()),
            content_id: "course:ep7".into(),
            part: 1,
            cid: Some(8),
            revision: 1,
            pgc: None,
            course: Some(identity),
        };
        let binding = Binding {
            version: 4,
            provider: "bilibili".into(),
            media_id: media,
            room_id: room,
            user_id: user,
            entry_revision: "1".into(),
            credential_mode: "own_account".into(),
            account_id: Some(Uuid::from_u128(4)),
            account_revision: Some("2".into()),
            resource: entry.identity(),
        };
        assert!(binding.matches_entry(&entry));
        let sealed = Sealed {
            kind: "native_platform".into(),
            version: 1,
            binding: binding.clone(),
            resolved_at_ms: 100000,
            url_expires_at_ms: None,
            descriptor: descriptor::fixture(),
        };
        let plaintext = serde_json::to_value(&sealed).unwrap();
        let public = serde_json::to_value(&binding).unwrap();
        assert_eq!(public.as_object().unwrap().len(), 10);
        assert!(validate_plaintext(plaintext.clone(), &public, media, room, user, 200000).is_ok());
        assert!(validate_plaintext(plaintext.clone(), &public, media, room, user, 220001).is_err());
        for version in [1, 2, 3] {
            let mut b = binding.clone();
            b.version = version;
            assert!(!b.validate());
        }
        for axis in ["ep_id", "aid", "cid", "season_id"] {
            let mut wrong = public.clone();
            wrong["resource"][axis] = json!("99");
            assert!(
                validate_plaintext(plaintext.clone(), &wrong, media, room, user, 200000).is_err()
            );
        }
        for field in [
            "media_id",
            "room_id",
            "user_id",
            "account_id",
            "account_revision",
            "entry_revision",
        ] {
            let mut wrong = public.clone();
            wrong[field] = json!("99");
            assert!(
                validate_plaintext(plaintext.clone(), &wrong, media, room, user, 200000).is_err()
            );
        }
        for kind in ["bilibili_pgc", "bilibili_live", "video"] {
            let mut wrong = plaintext.clone();
            wrong["binding"]["resource"]["kind"] = json!(kind);
            let p = wrong["binding"].clone();
            assert!(validate_plaintext(wrong, &p, media, room, user, 200000).is_err());
        }
        let mut unknown = plaintext.clone();
        unknown["binding"]["resource"]["bvid"] = json!("BV1xx411c7mD");
        let p = unknown["binding"].clone();
        assert!(validate_plaintext(unknown, &p, media, room, user, 200000).is_err());
    }
    #[test]
    fn pgc_version_two_grants_bind_exact_resource_and_preserve_legacy_canonical_shape() {
        let (media, room, user) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let entry = native_platform::Entry {
            media_id: media,
            room_id: room,
            provider: "bilibili".into(),
            canonical_url: Some("https://www.bilibili.com/bangumi/play/ep7".into()),
            content_id: "ep7".into(),
            part: 1,
            cid: Some(8),
            revision: 1,
            pgc: Some(native_platform::PgcIdentity::new(
                "7".into(),
                "8".into(),
                "9".into(),
            )),
            course: None,
        };
        let binding = Binding {
            version: 2,
            provider: "bilibili".into(),
            media_id: media,
            room_id: room,
            user_id: user,
            entry_revision: "1".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: entry.pgc.clone(),
        };
        assert!(binding.matches_entry(&entry));
        let sealed = Sealed {
            kind: "native_platform".into(),
            version: 1,
            binding: binding.clone(),
            resolved_at_ms: 100000,
            url_expires_at_ms: None,
            descriptor: descriptor::fixture(),
        };
        let public = serde_json::to_value(&binding).unwrap();
        let plaintext = serde_json::to_value(&sealed).unwrap();
        assert_eq!(public.as_object().unwrap().len(), 10);
        assert!(validate_plaintext(plaintext.clone(), &public, media, room, user, 200000).is_ok());
        assert!(
            validate_plaintext(
                plaintext.clone(),
                &public,
                media,
                room,
                Uuid::from_u128(4),
                200000
            )
            .is_err()
        );
        for axis in ["ep_id", "cid", "season_id"] {
            let mut wrong = binding.clone();
            wrong.resource = Some(match axis {
                "ep_id" => native_platform::PgcIdentity::new("70".into(), "8".into(), "9".into()),
                "cid" => native_platform::PgcIdentity::new("7".into(), "80".into(), "9".into()),
                _ => native_platform::PgcIdentity::new("7".into(), "8".into(), "90".into()),
            });
            assert!(!wrong.matches_entry(&entry));
            let changed_public = serde_json::to_value(wrong).unwrap();
            assert!(
                validate_plaintext(
                    plaintext.clone(),
                    &changed_public,
                    media,
                    room,
                    user,
                    200000
                )
                .is_err()
            );
        }
        for field in ["provider", "version", "resource"] {
            let mut changed = plaintext.clone();
            changed["binding"][field] = match field {
                "provider" => json!("youtube"),
                "version" => json!(1),
                _ => Value::Null,
            };
            let changed_public = changed["binding"].clone();
            assert!(
                validate_plaintext(changed, &changed_public, media, room, user, 200000).is_err()
            );
        }
        for mutation in ["media", "room", "revision", "provider", "resource"] {
            let mut wrong = binding.clone();
            match mutation {
                "media" => wrong.media_id = Uuid::from_u128(4),
                "room" => wrong.room_id = Uuid::from_u128(4),
                "revision" => wrong.entry_revision = "2".into(),
                "provider" => wrong.provider = "youtube".into(),
                _ => wrong.resource = None,
            }
            assert!(!wrong.matches_entry(&entry));
        }
        let mut legacy = binding;
        legacy.version = 1;
        legacy.resource = None;
        let value = serde_json::to_value(&legacy).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 9);
        assert!(
            serde_json::from_value::<Binding>(value.clone())
                .is_ok_and(|b| serde_json::to_value(b).unwrap() == value)
        );
    }
    #[test]
    fn adaptive_youtube_grants_roundtrip_anonymous_and_refuse_fact_or_provider_transplants() {
        let (media, room, user) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let binding = Binding {
            version: 1,
            provider: "youtube".into(),
            media_id: media,
            room_id: room,
            user_id: user,
            entry_revision: "1".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: None,
        };
        let sealed = Sealed {
            kind: "native_platform".into(),
            version: 1,
            binding: binding.clone(),
            resolved_at_ms: 100000,
            url_expires_at_ms: Some(180000),
            descriptor: descriptor::youtube_fixture(),
        };
        let public = serde_json::to_value(binding).unwrap();
        let plaintext = serde_json::to_value(sealed).unwrap();
        assert!(validate_plaintext(plaintext.clone(), &public, media, room, user, 150000).is_ok());
        assert!(validate_plaintext(plaintext.clone(), &public, media, room, user, 150001).is_err());
        for provider in ["bilibili", "douyin", "tiktok"] {
            let mut changed = plaintext.clone();
            changed["binding"]["provider"] = json!(provider);
            let changed_public = changed["binding"].clone();
            assert!(
                validate_plaintext(changed, &changed_public, media, room, user, 150000).is_err()
            );
        }
        let mut changed = plaintext.clone();
        changed["binding"]["credential_mode"] = json!("own_account");
        changed["binding"]["account_id"] = json!(Uuid::from_u128(9));
        changed["binding"]["account_revision"] = json!("1");
        let changed_public = changed["binding"].clone();
        // Viewer-owned YouTube sessions are now explicitly supported. The sealed
        // and public bindings must agree, and database admission still checks
        // the exact viewer/provider/account revision and live credential.
        assert!(
            validate_plaintext(changed.clone(), &changed_public, media, room, user, 150000).is_ok()
        );
        assert!(
            validate_plaintext(
                changed.clone(),
                &changed_public,
                media,
                room,
                Uuid::from_u128(4),
                150000
            )
            .is_err()
        );
        changed["binding"]["account_revision"] = Value::Null;
        let changed_public = changed["binding"].clone();
        assert!(validate_plaintext(changed, &changed_public, media, room, user, 150000).is_err());
        let mut changed = plaintext.clone();
        changed["descriptor"]["tracks"][0]["observed_content_length"] = Value::Null;
        assert!(validate_plaintext(changed, &public, media, room, user, 150000).is_err());
        let mut changed = plaintext;
        changed["url_expires_at_ms"] = json!(190000);
        assert!(validate_plaintext(changed, &public, media, room, user, 150000).is_err());
    }

    #[test]
    fn youtube_delivery_does_not_publish_opaque_upstream_validator_text() {
        let descriptor = descriptor::youtube_fixture();
        let track = &descriptor.tracks[0];
        let mut upstream = HeaderMap::new();
        upstream.insert(
            header::ETAG,
            "\"https://rr1.googlevideo.com/?signature=private\""
                .parse()
                .unwrap(),
        );
        upstream.insert(
            header::LAST_MODIFIED,
            "private-upstream-text".parse().unwrap(),
        );
        upstream.insert(
            header::ACCEPT_RANGES,
            "private-upstream-text".parse().unwrap(),
        );
        upstream.insert(
            header::CONTENT_TYPE,
            "private-upstream-text".parse().unwrap(),
        );
        upstream.insert(header::SET_COOKIE, "session=private".parse().unwrap());
        let headers = delivery_headers("youtube", &upstream, track).unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[header::CONTENT_TYPE], "video/mp4");
        upstream.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
        let headers = delivery_headers("youtube", &upstream, track).unwrap();
        assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
        let historical = delivery_headers("bilibili", &upstream, track).unwrap();
        assert_eq!(historical[header::ETAG], upstream[header::ETAG]);
        assert_eq!(
            historical[header::LAST_MODIFIED],
            upstream[header::LAST_MODIFIED]
        );
    }

    #[test]
    fn probed_youtube_totals_and_strong_validator_are_enforced_on_head_and_ranges() {
        let descriptor = descriptor::youtube_fixture();
        let track = &descriptor.tracks[0];
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "100".parse().unwrap());
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/10000".parse().unwrap());
        headers.insert(
            header::ETAG,
            track.strong_etag.as_ref().unwrap().parse().unwrap(),
        );
        assert!(
            response_facts(
                StatusCode::PARTIAL_CONTENT,
                &headers,
                Some(Range::Bounded(0, 99))
            )
            .is_ok()
        );
        assert!(enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, track).is_ok());
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/10001".parse().unwrap());
        assert!(
            enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, track).is_err()
        );
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/10000".parse().unwrap());
        headers.insert(header::ETAG, "\"changed\"".parse().unwrap());
        assert!(
            enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, track).is_err()
        );
        headers.remove(header::ETAG);
        assert!(
            enforce_representation_facts(StatusCode::PARTIAL_CONTENT, &headers, track).is_err()
        );
        headers.insert(
            header::ETAG,
            track.strong_etag.as_ref().unwrap().parse().unwrap(),
        );
        headers.remove(header::CONTENT_RANGE);
        headers.insert(header::CONTENT_LENGTH, "10000".parse().unwrap());
        assert!(enforce_representation_facts(StatusCode::OK, &headers, track).is_ok());
        headers.remove(header::CONTENT_LENGTH);
        assert!(enforce_representation_facts(StatusCode::OK, &headers, track).is_err());
    }
    #[test]
    fn delivery_rejects_duplicate_framing_and_encoded_bytes() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "100".parse().unwrap());
        headers.append(header::CONTENT_LENGTH, "100".parse().unwrap());
        assert!(response_facts(StatusCode::OK, &headers, None).is_err());
        headers.insert(header::CONTENT_LENGTH, "100".parse().unwrap());
        headers.insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        assert!(response_facts(StatusCode::OK, &headers, None).is_err());
        headers.insert(header::CONTENT_ENCODING, "identity".parse().unwrap());
        assert!(response_facts(StatusCode::OK, &headers, None).is_ok());
        headers.append(header::ETAG, "\"one\"".parse().unwrap());
        headers.append(header::ETAG, "\"two\"".parse().unwrap());
        assert!(response_facts(StatusCode::OK, &headers, None).is_err());
    }

    #[test]
    fn short_own_grants_are_viewer_account_and_revision_bound_without_credentials() {
        let media = Uuid::from_u128(1);
        let room = Uuid::from_u128(2);
        let user = Uuid::from_u128(3);
        for provider in ["douyin", "tiktok"] {
            let binding = Binding {
                version: 1,
                provider: provider.into(),
                media_id: media,
                room_id: room,
                user_id: user,
                entry_revision: "1".into(),
                credential_mode: "own_account".into(),
                account_id: Some(Uuid::from_u128(4)),
                account_revision: Some("5".into()),
                resource: None,
            };
            let sealed = Sealed {
                kind: "native_platform".into(),
                version: 1,
                binding: binding.clone(),
                resolved_at_ms: 100000,
                url_expires_at_ms: None,
                descriptor: descriptor::progressive_fixture(provider),
            };
            let public = serde_json::to_value(&binding).unwrap();
            let plaintext = serde_json::to_value(&sealed).unwrap();
            assert!(
                validate_plaintext(plaintext.clone(), &public, media, room, user, 200000).is_ok()
            );
            assert!(
                validate_plaintext(
                    plaintext.clone(),
                    &public,
                    media,
                    room,
                    Uuid::from_u128(9),
                    200000
                )
                .is_err()
            );
            for (field, value) in [
                ("user_id", json!(Uuid::from_u128(9))),
                ("room_id", json!(Uuid::from_u128(9))),
                ("account_id", json!(Uuid::from_u128(9))),
                ("account_revision", json!("6")),
                (
                    "provider",
                    json!(if provider == "douyin" {
                        "tiktok"
                    } else {
                        "douyin"
                    }),
                ),
                ("credential_mode", json!("anonymous")),
            ] {
                let mut changed = public.clone();
                changed[field] = value;
                assert!(
                    validate_plaintext(plaintext.clone(), &changed, media, room, user, 200000)
                        .is_err()
                );
            }
            for field in [
                "cookie",
                "headers",
                "owner_id",
                "shared_account",
                "credential",
            ] {
                assert!(public.get(field).is_none());
                assert!(plaintext.get(field).is_none());
                let mut changed = plaintext.clone();
                changed["binding"][field] = json!("synthetic-private-value");
                assert!(validate_plaintext(changed, &public, media, room, user, 200000).is_err());
            }
        }
    }

    #[test]
    fn sealed_binding_cannot_be_transplanted_or_incompletely_restored() {
        let media = Uuid::from_u128(1);
        let room = Uuid::from_u128(2);
        let user = Uuid::from_u128(3);
        let binding = Binding {
            version: 1,
            provider: "bilibili".into(),
            media_id: media,
            room_id: room,
            user_id: user,
            entry_revision: "7".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: None,
        };
        let sealed = Sealed {
            kind: "native_platform".into(),
            version: 1,
            binding: binding.clone(),
            resolved_at_ms: 100000,
            url_expires_at_ms: None,
            descriptor: descriptor::fixture(),
        };
        let public = serde_json::to_value(&binding).unwrap();
        assert_eq!(public.as_object().unwrap().len(), 9);
        let plaintext = serde_json::to_value(&sealed).unwrap();
        assert!(validate_plaintext(plaintext.clone(), &public, media, room, user, 200000).is_ok());
        for (m, r, u) in [
            (Uuid::from_u128(4), room, user),
            (media, Uuid::from_u128(4), user),
            (media, room, Uuid::from_u128(4)),
        ] {
            assert!(validate_plaintext(plaintext.clone(), &public, m, r, u, 200000).is_err());
        }
        let mut changed = public.clone();
        changed["entry_revision"] = json!("8");
        assert!(
            validate_plaintext(plaintext.clone(), &changed, media, room, user, 200000).is_err()
        );
        let mut changed = plaintext.clone();
        changed["binding"]
            .as_object_mut()
            .unwrap()
            .remove("account_id");
        assert!(validate_plaintext(changed, &public, media, room, user, 200000).is_err());
        let mut changed = plaintext.clone();
        changed["cookie"] = json!("fixture");
        assert!(validate_plaintext(changed, &public, media, room, user, 200000).is_err());
        assert!(validate_plaintext(plaintext, &public, media, room, user, 220001).is_err());
    }
    #[test]
    fn progressive_grants_cannot_restore_as_dash_or_transplant_provider() {
        let media = Uuid::from_u128(1);
        let room = Uuid::from_u128(2);
        let user = Uuid::from_u128(3);
        for provider in ["douyin", "tiktok", "youtube"] {
            let binding = Binding {
                version: 1,
                provider: provider.into(),
                media_id: media,
                room_id: room,
                user_id: user,
                entry_revision: "1".into(),
                credential_mode: "anonymous".into(),
                account_id: None,
                account_revision: None,
                resource: None,
            };
            let sealed = Sealed {
                kind: "native_platform".into(),
                version: 1,
                binding: binding.clone(),
                resolved_at_ms: 100000,
                url_expires_at_ms: None,
                descriptor: descriptor::progressive_fixture(provider),
            };
            let public = serde_json::to_value(&binding).unwrap();
            let plaintext = serde_json::to_value(&sealed).unwrap();
            assert!(
                validate_plaintext(plaintext.clone(), &public, media, room, user, 200000).is_ok()
            );
            assert!(
                validate_plaintext(plaintext.clone(), &public, media, room, user, 220001).is_err()
            );
            let mut changed = plaintext.clone();
            changed["descriptor"]
                .as_object_mut()
                .unwrap()
                .remove("transport");
            assert!(validate_plaintext(changed, &public, media, room, user, 200000).is_err());
            let mut changed = plaintext.clone();
            changed["binding"]["provider"] = json!("bilibili");
            let changed_public = changed["binding"].clone();
            assert!(
                validate_plaintext(changed, &changed_public, media, room, user, 200000).is_err()
            );
        }
    }
    #[test]
    fn only_single_truthful_ranges_are_accepted() {
        for value in [
            "bytes=0-1,4-5",
            "bytes=-0",
            "bytes=2-1",
            "bytes= -1",
            "items=0-1",
            "bytes=1-2-3",
            "bytes=-",
        ] {
            assert!(range(value).is_err());
        }
        assert_eq!(range("bytes=0-99").unwrap(), Range::Bounded(0, 99));
        assert_eq!(range("bytes=100-").unwrap(), Range::Open(100));
        assert_eq!(range("bytes=-100").unwrap(), Range::Suffix(100));
    }
    #[test]
    fn head_and_unproven_if_range_describe_the_full_representation() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=0-99".parse().unwrap());
        assert!(effective_range(&Method::HEAD, &headers).unwrap().is_none());
        assert_eq!(
            effective_range(&Method::GET, &headers).unwrap().unwrap().1,
            Range::Bounded(0, 99)
        );
        headers.insert(header::IF_RANGE, "\"unproven-etag\"".parse().unwrap());
        assert!(effective_range(&Method::GET, &headers).unwrap().is_none());
        headers.insert(header::RANGE, "bytes=0-1,4-5".parse().unwrap());
        assert!(effective_range(&Method::GET, &headers).unwrap().is_none());
        assert!(effective_range(&Method::HEAD, &headers).unwrap().is_none());
    }
    #[test]
    fn partial_length_and_range_cannot_be_forged_or_promoted_to_full() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_RANGE, "bytes 0-99/1000".parse().unwrap());
        headers.insert(header::CONTENT_LENGTH, "100".parse().unwrap());
        assert_eq!(
            response_facts(
                StatusCode::PARTIAL_CONTENT,
                &headers,
                Some(Range::Bounded(0, 99))
            )
            .unwrap(),
            Some(100)
        );
        assert!(response_facts(StatusCode::PARTIAL_CONTENT, &headers, None).is_err());
        assert!(response_facts(StatusCode::OK, &headers, Some(Range::Bounded(0, 99))).is_err());
        headers.insert(header::CONTENT_LENGTH, "99".parse().unwrap());
        assert!(
            response_facts(
                StatusCode::PARTIAL_CONTENT,
                &headers,
                Some(Range::Bounded(0, 99))
            )
            .is_err()
        );
        assert_eq!(content_range("bytes 999-1000/1000"), None);
        assert_eq!(content_range("bytes 0-10/*"), None);
    }
    #[test]
    fn delivery_gate_has_every_current_grant_fence() {
        for fence in [
            "p.delivery_token_hash=$2",
            "p.auth_login_hash=$3",
            "p.user_id=$4",
            "NOT p.stopped",
            "p.expires_at>clock_timestamp()",
            "r.lifecycle_epoch=p.lifecycle_epoch",
            "s.state->>'media_id'=p.media_id::text",
            "playback_source_allowed",
            "g.plan_generation=p.plan_generation",
            "g.auth_login_hash=p.auth_login_hash",
            "room_members",
        ] {
            assert!(GATE.contains(fence));
        }
    }
}
