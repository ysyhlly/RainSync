//! Durable representation identity for generic HTTP playback grants.
//! No URL, source credential, or unbounded response header is persisted.
use crate::{Result, failure, preview_input::http_delivery};
use axum::http::{HeaderMap, StatusCode, header};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

const MAX_TARGETS: i64 = 20_000;

pub fn required() -> (StatusCode, String) {
    (StatusCode::CONFLICT, "source_version_required".into())
}
pub fn changed() -> (StatusCode, String) {
    (StatusCode::CONFLICT, "source_changed".into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    Binary,
    Playlist,
    Key,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    /// Missing legacy evidence proves only an unchanged original destination.
    /// Hash the complete canonical final URL, including any signed query.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_target_sha256: Option<String>,
    pub etag: Option<String>,
    pub modified: Option<String>,
    pub reliable_modified: bool,
    pub size: Option<u64>,
}

fn single(headers: &HeaderMap, name: header::HeaderName) -> anyhow::Result<Option<&str>> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().map(|value| value.to_str()).transpose()?;
    anyhow::ensure!(values.next().is_none(), "duplicate_representation_header");
    Ok(value)
}
pub fn strong_etag(value: &str) -> bool {
    value.len() <= 1024
        && value.starts_with('"')
        && value.ends_with('"')
        && value.len() >= 2
        && value.as_bytes()[1..value.len() - 1]
            .iter()
            .all(|v| *v == 0x21 || (0x23..=0x7e).contains(v) || *v >= 0x80)
}
fn number(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|v| v.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}
impl Metadata {
    pub fn read(status: StatusCode, headers: &HeaderMap) -> anyhow::Result<Self> {
        // Request identity coding explicitly. Encoded bytes cannot be exposed
        // with unencoded offsets or silently decoded into a different length.
        anyhow::ensure!(
            single(headers, header::CONTENT_ENCODING)?
                .is_none_or(|v| v.eq_ignore_ascii_case("identity")),
            "unsupported_upstream_content_encoding"
        );
        let length = single(headers, header::CONTENT_LENGTH)?
            .map(|value| number(value).ok_or_else(|| anyhow::anyhow!("invalid_upstream_length")))
            .transpose()?;
        let range = http_delivery::validate_range_response(status, headers)?;
        anyhow::ensure!(
            matches!(
                status,
                StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
            ) || !headers.contains_key(header::CONTENT_RANGE),
            "unexpected_upstream_content_range"
        );
        let size = range.as_ref().and_then(|v| v.total()).or_else(|| {
            (status != StatusCode::PARTIAL_CONTENT && status != StatusCode::RANGE_NOT_SATISFIABLE)
                .then_some(length)
                .flatten()
        });
        let etag = single(headers, header::ETAG)?.map(str::to_owned);
        anyhow::ensure!(
            etag.as_deref().is_none_or(|v| {
                v.len() <= 1024 && (strong_etag(v) || v.strip_prefix("W/").is_some_and(strong_etag))
            }),
            "invalid_upstream_etag"
        );
        let modified = single(headers, header::LAST_MODIFIED)?
            .map(httpdate::parse_http_date)
            .transpose()?;
        let date = single(headers, header::DATE)?
            .map(httpdate::parse_http_date)
            .transpose()?;
        // RFC 9110 §8.8.2.2: a date is strong only with the original response's
        // Date at least 60 seconds later. A weak ETag prevents date fallback.
        let reliable_modified = etag.is_none()
            && modified.zip(date).is_some_and(|(modified, date)| {
                date.duration_since(modified)
                    .is_ok_and(|age| age >= Duration::from_secs(60))
            });
        Ok(Self {
            final_target_sha256: None,
            etag,
            modified: modified.map(httpdate::fmt_http_date),
            reliable_modified,
            size,
        })
    }
    pub fn with_target(mut self, original: &url::Url, final_target: &url::Url) -> Self {
        self.final_target_sha256 =
            (original != final_target).then(|| crate::hash(final_target.as_str()));
        self
    }
    pub fn reliable(&self) -> bool {
        self.size.is_some()
            && (self.etag.as_deref().is_some_and(strong_etag) || self.reliable_modified)
    }
    pub fn validator(&self) -> Option<&str> {
        if !self.reliable() {
            return None;
        }
        self.etag.as_deref().or(self.modified.as_deref())
    }
    fn agrees(&self, next: &Self) -> bool {
        self.final_target_sha256 == next.final_target_sha256
            && self.size == next.size
            && if self.etag.as_deref().is_some_and(strong_etag) {
                self.etag == next.etag
            } else if self.reliable_modified {
                next.etag.is_none() && self.modified == next.modified
            } else {
                self.etag == next.etag && self.modified == next.modified
            }
    }
    /// HEAD and error responses may legally omit representation metadata.
    /// Supplied conflicts still invalidate the grant, but absence never erases
    /// a validator or length established by an earlier representation.
    pub fn conflicts_with_partial(&self, next: &Self) -> bool {
        self.final_target_sha256 != next.final_target_sha256
            || self
                .size
                .zip(next.size)
                .is_some_and(|(old, new)| old != new)
            || next
                .etag
                .as_ref()
                .is_some_and(|new| self.etag.as_ref().is_some_and(|old| old != new))
            || (self.reliable_modified
                && next
                    .modified
                    .as_ref()
                    .is_some_and(|new| self.modified.as_ref() != Some(new)))
    }
    pub fn condition(
        &self,
        mut request: providers::media_request::MediaRequest,
        ranged: bool,
    ) -> providers::media_request::MediaRequest {
        if let Some(value) = self.validator() {
            request = request.header(
                if self.etag.is_some() {
                    header::IF_MATCH
                } else {
                    header::IF_UNMODIFIED_SINCE
                },
                value,
            );
            if ranged {
                request = request.header(header::IF_RANGE, value);
            }
        }
        request
    }
    pub fn if_range_matches(&self, headers: &HeaderMap) -> bool {
        let Ok(Some(value)) = single(headers, header::IF_RANGE) else {
            return !headers.contains_key(header::IF_RANGE);
        };
        self.validator().is_some_and(|expected| {
            if self.etag.is_some() {
                strong_etag(value) && value == expected
            } else {
                httpdate::parse_http_date(value).ok() == httpdate::parse_http_date(expected).ok()
            }
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    version: u8,
    pub metadata: Metadata,
    pub class: Option<Class>,
    pub consumed: bool,
    pub changed: bool,
}
impl State {
    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(self.version == 1, "unsupported_http_identity");
        anyhow::ensure!(
            self.metadata
                .final_target_sha256
                .as_ref()
                .is_none_or(|value| value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))),
            "invalid_http_identity"
        );
        anyhow::ensure!(
            self.metadata.etag.as_ref().is_none_or(|v| v.len() <= 1024
                && (strong_etag(v) || v.strip_prefix("W/").is_some_and(strong_etag))),
            "invalid_http_identity"
        );
        anyhow::ensure!(
            self.metadata.modified.as_ref().is_none_or(|v| v.len() <= 64
                && httpdate::parse_http_date(v)
                    .is_ok_and(|date| httpdate::fmt_http_date(date) == *v)),
            "invalid_http_identity"
        );
        anyhow::ensure!(
            !self.metadata.reliable_modified
                || (self.metadata.etag.is_none() && self.metadata.modified.is_some()),
            "invalid_http_identity"
        );
        Ok(())
    }
    fn observe(
        &mut self,
        metadata: &Metadata,
        class: Option<Class>,
        body: bool,
        seek: bool,
        head: bool,
    ) -> Result<()> {
        if self.changed {
            return Err(changed());
        }
        if (if head {
            self.metadata.conflicts_with_partial(metadata)
        } else {
            !self.metadata.agrees(metadata)
        }) || self.class.zip(class).is_some_and(|(old, new)| old != new)
        {
            self.changed = true;
            return Err(changed());
        }
        // A HEAD may omit validators but may never downgrade a pinned grant.
        // This deliberately fails closed instead of rebinding a previous body.
        if !self.metadata.reliable() && (seek || (body && self.consumed)) {
            return Err(required());
        }
        self.class = self.class.or(class);
        self.consumed |= body;
        Ok(())
    }
}

pub async fn load(pool: &PgPool, session: Uuid, target: &str) -> Result<Option<State>> {
    let value: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT identity FROM playback_http_representations WHERE session_id=$1 AND target_sha256=$2",
    )
    .bind(session).bind(crate::hash(target)).fetch_optional(pool).await.map_err(failure)?;
    value
        .map(|value| {
            let state: State = serde_json::from_value(value).map_err(failure)?;
            state.validate().map_err(failure)?;
            if state.changed {
                return Err(changed());
            }
            Ok(state)
        })
        .transpose()
}

/// Lock order matches playback session lifecycle writes. No upstream request or
/// body polling occurs while this transaction owns a database lock.
pub async fn commit(
    pool: &PgPool,
    session: Uuid,
    target: &str,
    metadata: &Metadata,
    class: Option<Class>,
    body: bool,
    seek: bool,
) -> Result<State> {
    commit_observation(
        pool,
        session,
        target,
        metadata,
        Observation {
            class,
            body,
            seek,
            head: false,
        },
    )
    .await
}

pub async fn head(
    pool: &PgPool,
    session: Uuid,
    target: &str,
    metadata: &Metadata,
) -> Result<State> {
    commit_observation(
        pool,
        session,
        target,
        metadata,
        Observation {
            class: None,
            body: false,
            seek: false,
            head: true,
        },
    )
    .await
}

struct Observation {
    class: Option<Class>,
    body: bool,
    seek: bool,
    head: bool,
}

async fn commit_observation(
    pool: &PgPool,
    session: Uuid,
    target: &str,
    metadata: &Metadata,
    observation: Observation,
) -> Result<State> {
    let Observation {
        class,
        body,
        seek,
        head,
    } = observation;
    let mut tx = pool.begin().await.map_err(failure)?;
    sqlx::query("SELECT lock_playback_http_representation($1)")
        .bind(session)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    let active: Option<bool> = sqlx::query_scalar(
        "SELECT NOT stopped AND expires_at>clock_timestamp() FROM playback_sessions WHERE id=$1 FOR UPDATE",
    ).bind(session).fetch_optional(&mut *tx).await.map_err(failure)?;
    let invalidated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_http_representations WHERE session_id=$1 AND identity->>'changed'='true')")
        .bind(session).fetch_one(&mut *tx).await.map_err(failure)?;
    if invalidated {
        return Err(changed());
    }
    if active != Some(true) {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    let digest = crate::hash(target);
    let previous: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT identity FROM playback_http_representations WHERE session_id=$1 AND target_sha256=$2",
    ).bind(session).bind(&digest).fetch_optional(&mut *tx).await.map_err(failure)?;
    let mut state = if let Some(value) = previous {
        let state: State = serde_json::from_value(value).map_err(failure)?;
        state.validate().map_err(failure)?;
        state
    } else {
        if head && !metadata.reliable() {
            // Incomplete HEAD data must not poison the first actual GET.
            return Ok(State {
                version: 1,
                metadata: metadata.clone(),
                class: None,
                consumed: false,
                changed: false,
            });
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM playback_http_representations WHERE session_id=$1",
        )
        .bind(session)
        .fetch_one(&mut *tx)
        .await
        .map_err(failure)?;
        if count >= MAX_TARGETS {
            return Err(failure("http_resource_limit"));
        }
        State {
            version: 1,
            metadata: metadata.clone(),
            class: None,
            consumed: false,
            changed: false,
        }
    };
    let result = state.observe(metadata, class, body, seek, head);
    sqlx::query("INSERT INTO playback_http_representations(session_id,target_sha256,identity) VALUES($1,$2,$3) ON CONFLICT(session_id,target_sha256) DO UPDATE SET identity=EXCLUDED.identity")
        .bind(session).bind(digest).bind(serde_json::to_value(&state).map_err(failure)?)
        .execute(&mut *tx).await.map_err(failure)?;
    if state.changed {
        sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
            .bind(session)
            .execute(&mut *tx)
            .await
            .map_err(failure)?;
    }
    tx.commit().await.map_err(failure)?;
    result?;
    Ok(state)
}

pub async fn invalidate(pool: &PgPool, session: Uuid) -> Result<()> {
    // Keep the resource and upstream session-stop obligation intact.
    let mut tx = pool.begin().await.map_err(failure)?;
    sqlx::query("SELECT lock_playback_http_representation($1)")
        .bind(session)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    sqlx::query("UPDATE playback_sessions SET stopped=true WHERE id=$1")
        .bind(session)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    sqlx::query("UPDATE playback_http_representations SET identity=jsonb_set(identity,'{changed}','true') WHERE session_id=$1")
        .bind(session).execute(&mut *tx).await.map_err(failure)?;
    tx.commit().await.map_err(failure)?;
    Err(changed())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Range {
    From(u64, Option<u64>),
    Suffix(u64),
}
impl Range {
    pub fn read(headers: &HeaderMap) -> Option<Self> {
        let raw = single(headers, header::RANGE)
            .ok()
            .flatten()?
            .strip_prefix("bytes=")?;
        let (start, end) = raw.split_once('-')?;
        if start.is_empty() {
            Some(Self::Suffix(number(end)?))
        } else {
            let start = number(start)?;
            let end = if end.is_empty() {
                None
            } else {
                Some(number(end)?)
            };
            end.is_none_or(|end| end >= start)
                .then_some(Self::From(start, end))
        }
    }
    pub fn selected(self, size: u64) -> Option<(u64, u64)> {
        if size == 0 {
            return None;
        }
        match self {
            Self::From(start, end) if start < size => {
                Some((start, end.unwrap_or(size - 1).min(size - 1)))
            }
            Self::Suffix(length) if length > 0 => Some((size.saturating_sub(length), size - 1)),
            _ => None,
        }
    }
    pub fn validate(self, status: StatusCode, headers: &HeaderMap) -> anyhow::Result<()> {
        if status == StatusCode::PARTIAL_CONTENT {
            let Some(http_delivery::ContentRange::Partial {
                start,
                end,
                total: Some(total),
            }) = http_delivery::validate_range_response(status, headers)?
            else {
                anyhow::bail!("unknown_upstream_range_total");
            };
            anyhow::ensure!(
                self.selected(total) == Some((start, end)),
                "upstream_range_mismatch"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metadata(etag: Option<&str>, length: u64) -> Metadata {
        Metadata {
            final_target_sha256: None,
            etag: etag.map(str::to_owned),
            modified: None,
            reliable_modified: false,
            size: Some(length),
        }
    }
    fn state(value: Metadata) -> State {
        State {
            version: 1,
            metadata: value,
            class: None,
            consumed: false,
            changed: false,
        }
    }
    #[test]
    fn validator_strength_length_and_dates_are_conservative() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_LENGTH, "10".parse().unwrap());
        headers.insert(
            header::LAST_MODIFIED,
            "Wed, 30 Sep 2026 08:00:00 GMT".parse().unwrap(),
        );
        headers.insert(
            header::DATE,
            "Wed, 30 Sep 2026 08:00:59 GMT".parse().unwrap(),
        );
        assert!(!Metadata::read(StatusCode::OK, &headers).unwrap().reliable());
        headers.insert(
            header::DATE,
            "Wed, 30 Sep 2026 08:01:00 GMT".parse().unwrap(),
        );
        assert!(Metadata::read(StatusCode::OK, &headers).unwrap().reliable());
        headers.insert(header::ETAG, "W/\"a\"".parse().unwrap());
        assert!(!Metadata::read(StatusCode::OK, &headers).unwrap().reliable());
        headers.insert(header::ETAG, "\"a\"".parse().unwrap());
        assert!(Metadata::read(StatusCode::OK, &headers).unwrap().reliable());
        headers.remove(header::CONTENT_LENGTH);
        assert!(!Metadata::read(StatusCode::OK, &headers).unwrap().reliable());
        headers.insert(header::CONTENT_RANGE, "bytes 0-1/10".parse().unwrap());
        headers.insert(header::CONTENT_LENGTH, "2".parse().unwrap());
        let parsed = Metadata::read(StatusCode::PARTIAL_CONTENT, &headers).unwrap();
        assert_eq!(parsed.size, Some(10));
        assert!(parsed.reliable());
        headers.append(header::ETAG, "\"a\"".parse().unwrap());
        assert!(Metadata::read(StatusCode::PARTIAL_CONTENT, &headers).is_err());
    }
    #[test]
    fn a_changed_grant_never_rebinds_even_if_the_origin_reverts() {
        let original = metadata(Some("\"a\""), 10);
        for next in [
            metadata(Some("\"b\""), 10),
            metadata(Some("\"a\""), 11),
            metadata(None, 10),
        ] {
            let mut state = state(original.clone());
            state
                .observe(&original, Some(Class::Binary), true, true, false)
                .unwrap();
            assert_eq!(
                state
                    .observe(&next, Some(Class::Binary), true, true, false)
                    .unwrap_err(),
                changed()
            );
            assert_eq!(
                state
                    .observe(&original, Some(Class::Binary), true, true, false)
                    .unwrap_err(),
                changed()
            );
        }
    }
    #[test]
    fn unvalidated_fallback_is_a_single_whole_body_and_head_does_not_consume() {
        let original = metadata(Some("W/\"a\""), 10);
        let mut state = state(original.clone());
        state.observe(&original, None, false, false, false).unwrap();
        assert!(!state.consumed);
        assert_eq!(
            state
                .observe(&original, None, true, true, false)
                .unwrap_err(),
            required()
        );
        state
            .observe(&original, Some(Class::Binary), true, false, false)
            .unwrap();
        assert_eq!(
            state
                .observe(&original, Some(Class::Binary), true, false, false)
                .unwrap_err(),
            required()
        );
    }
    #[test]
    fn if_range_uses_strong_exact_etags_and_original_reliable_dates() {
        let identity = metadata(Some("\"a\""), 10);
        let mut headers = HeaderMap::new();
        for (value, matches) in [
            ("\"a\"", true),
            ("\"b\"", false),
            ("W/\"a\"", false),
            ("Wed, 30 Sep 2026 08:00:00 GMT", false),
        ] {
            headers.insert(header::IF_RANGE, value.parse().unwrap());
            assert_eq!(identity.if_range_matches(&headers), matches);
        }
        headers.append(header::IF_RANGE, "\"a\"".parse().unwrap());
        assert!(!identity.if_range_matches(&headers));
    }
    #[test]
    fn redirected_identity_binds_complete_final_url_and_legacy_means_no_follow() {
        let original = url::Url::parse("https://media.invalid/start?original=private").unwrap();
        let final_url = url::Url::parse("https://cdn.invalid/media?signature=private").unwrap();
        let legacy = metadata(Some("\"same\""), 10);
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        assert!(legacy_json.get("final_target_sha256").is_none());
        let legacy: Metadata = serde_json::from_value(legacy_json).unwrap();
        let direct = legacy.clone().with_target(&original, &original);
        assert_eq!(direct, legacy);
        let redirected = legacy.clone().with_target(&original, &final_url);
        assert!(
            !serde_json::to_string(&redirected)
                .unwrap()
                .contains("private")
        );
        let mut bound = state(redirected.clone());
        bound.validate().unwrap();
        bound.observe(&redirected, None, true, true, false).unwrap();
        let mut sparse = Metadata::read(StatusCode::OK, &HeaderMap::new())
            .unwrap()
            .with_target(&original, &final_url);
        bound.observe(&sparse, None, false, false, true).unwrap();
        for other in [
            original.clone(),
            url::Url::parse("https://other-cdn.invalid/media?signature=private").unwrap(),
            url::Url::parse("https://cdn.invalid/other?signature=private").unwrap(),
            url::Url::parse("https://cdn.invalid/media?signature=rotated").unwrap(),
        ] {
            let next = legacy.clone().with_target(&original, &other);
            assert!(redirected.conflicts_with_partial(&next));
            assert!(!redirected.agrees(&next));
            let mut previous = state(redirected.clone());
            assert_eq!(
                previous.observe(&next, None, false, false, true),
                Err(changed())
            );
        }
        for (previous, next) in [
            (legacy.clone(), redirected.clone()),
            (redirected.clone(), legacy.clone()),
        ] {
            let mut previous = state(previous);
            assert_eq!(
                previous.observe(&next, None, false, false, false),
                Err(changed())
            );
        }
        sparse.final_target_sha256 = Some("not-a-digest".into());
        assert!(state(sparse).validate().is_err());
    }

    #[test]
    fn ranges_cover_empty_suffix_tail_multi_and_overflow() {
        for (value, expected) in [
            ("bytes=0-", Some((0, 19))),
            ("bytes=3-9", Some((3, 9))),
            ("bytes=19-99", Some((19, 19))),
            ("bytes=-500", Some((0, 19))),
            ("bytes=20-", None),
            ("bytes=-0", None),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, value.parse().unwrap());
            let range = Range::read(&headers).unwrap();
            assert_eq!(range.selected(20), expected);
            assert_eq!(range.selected(0), None);
        }
        for value in [
            "bytes=0-1,3-4",
            "bytes=4-3",
            "bytes=18446744073709551616-",
            "bytes=+1-2",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, value.parse().unwrap());
            assert_eq!(Range::read(&headers), None);
        }
    }
}
