//! Finite clear-platform jobs: no platform URL, cookie, command or live input
//! crosses the Server custody boundary. Every ingress is attempt-fenced.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub const QUEUE: &str = "native_platform_transcode_v1";
pub const KIND: &str = "native_platform_clear_transcode_v1";
pub const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_INPUT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_DURATION_SECONDS: f64 = 21_600.0;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Track {
    #[serde(
        default,
        skip_serializing_if = "media_core::advanced_media::PrivateInputContainer::is_mp4"
    )]
    pub container: media_core::advanced_media::PrivateInputContainer,
    pub key: String,
    pub ticket: String,
    pub total_bytes: u64,
    pub strong_etag: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_webm: Option<media_core::advanced_media::WebmSourceExpectation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_video: Option<media_core::advanced_media::VideoSourceExpectation>,
    pub kind: String,
    pub recipe_version: u8,
    pub source_kind: String,
    pub negotiated_mode: String,
    pub tracks: Vec<Track>,
    pub output_ticket: String,
    pub duration_seconds: f64,
    pub start_seconds: f64,
    pub deadline_ms: i64,
    pub estimated_output_bytes: u64,
}
pub fn ticket_valid(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn strong_etag_valid(v: &str) -> bool {
    v.len() >= 2
        && v.len() <= 512
        && v.starts_with('"')
        && v.ends_with('"')
        && v.as_bytes()[1..v.len() - 1]
            .iter()
            .all(|b| *b >= 0x21 && *b != b'"' && *b != 0x7f)
}
impl Spec {
    pub fn validate(&self) -> Result<()> {
        if let Some(webm) = &self.source_webm {
            webm.validate()?;
            ensure!(
                self.source_video.is_none()
                    && matches!(self.tracks.as_slice(),[v,a] if v.key == "video" && a.key == "audio" && v.container == media_core::advanced_media::PrivateInputContainer::Webm && a.container.is_mp4()),
                "native_platform_webm_recipe_required"
            );
        } else {
            ensure!(
                self.tracks.iter().all(|t| t.container.is_mp4()),
                "native_platform_webm_recipe_required"
            );
        }
        if let Some(source) = &self.source_video {
            source.validate()?;
        }
        ensure!(
            self.kind == KIND
                && self.recipe_version == 1
                && self.source_kind == "native_platform_private"
                && self.negotiated_mode == "transcode",
            "native_platform_recipe_required"
        );
        ensure!(
            self.duration_seconds.is_finite()
                && (0.001..=MAX_DURATION_SECONDS).contains(&self.duration_seconds)
                && self.start_seconds.is_finite()
                && self.start_seconds >= 0.0
                && self.start_seconds < self.duration_seconds
                && self.deadline_ms > 0
                && self.estimated_output_bytes > 0
                && self.estimated_output_bytes <= 16 * MAX_INPUT_BYTES
                && ticket_valid(&self.output_ticket),
            "native_platform_job_invalid"
        );
        ensure!(
            matches!(self.tracks.as_slice(), [t] if t.key=="progressive")
                || matches!(self.tracks.as_slice(), [v,a] if v.key=="video" && a.key=="audio"),
            "native_platform_tracks_invalid"
        );
        let mut bytes = 0u64;
        for t in &self.tracks {
            ensure!(
                ticket_valid(&t.ticket)
                    && t.ticket != self.output_ticket
                    && strong_etag_valid(&t.strong_etag)
                    && t.total_bytes > 0
                    && t.total_bytes <= MAX_INPUT_BYTES,
                "native_platform_representation_required"
            );
            bytes = bytes
                .checked_add(t.total_bytes)
                .ok_or_else(|| anyhow::anyhow!("native_platform_input_bound"))?;
        }
        ensure!(
            bytes <= MAX_INPUT_BYTES
                && (self.tracks.len() == 1 || self.tracks[0].ticket != self.tracks[1].ticket),
            "native_platform_input_bound"
        );
        Ok(())
    }
    pub fn byte_budget(&self) -> u64 {
        self.tracks.iter().map(|t| t.total_bytes).sum::<u64>() * 2 + 2 * MAX_RANGE_BYTES
    }
}
pub fn validate_spec(value: &Value) -> Result<Spec> {
    let spec: Spec = serde_json::from_value(value.clone())?;
    ensure!(
        serde_json::to_value(&spec)? == *value,
        "native_platform_job_invalid"
    );
    spec.validate()?;
    Ok(spec)
}
/// Purpose-aware opaque ingress validation; legacy output validation remains closed.
pub fn validate_input_spec(value: &Value) -> Result<Spec> {
    if value["kind"] == crate::native_platform_ladder::KIND {
        Ok(crate::native_platform_ladder::validate_spec(value)?.input)
    } else {
        validate_spec(value)
    }
}
/// Normalize decoder's open/suffix requests to a bounded finite range. Multi-
/// ranges and attacker-controlled nested URLs cannot enter the gateway.
pub fn requested_range(raw: Option<&str>, total: u64) -> Result<(u64, u64)> {
    ensure!(
        total > 0 && total <= MAX_INPUT_BYTES,
        "native_platform_input_bound"
    );
    let (start, wanted) = if let Some(raw) = raw {
        ensure!(
            raw.len() <= 96 && !raw.bytes().any(|b| b.is_ascii_whitespace()) && !raw.contains(','),
            "native_platform_range_invalid"
        );
        let (a, b) = raw
            .strip_prefix("bytes=")
            .and_then(|v| v.split_once('-'))
            .ok_or_else(|| anyhow::anyhow!("native_platform_range_invalid"))?;
        let number = |v: &str| -> Result<u64> {
            ensure!(
                !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()),
                "native_platform_range_invalid"
            );
            Ok(v.parse()?)
        };
        if a.is_empty() {
            let n = number(b)?;
            ensure!(n > 0, "native_platform_range_invalid");
            (total - n.min(total), total - 1)
        } else {
            let start = number(a)?;
            let end = if b.is_empty() { total - 1 } else { number(b)? };
            ensure!(
                start < total && end >= start,
                "native_platform_range_invalid"
            );
            (start, end.min(total - 1))
        }
    } else {
        (0, total - 1)
    };
    Ok((start, wanted))
}

pub fn bounded_range(raw: Option<&str>, total: u64) -> Result<(u64, u64)> {
    let (start, end) = requested_range(raw, total)?;
    Ok((start, end.min(start.saturating_add(MAX_RANGE_BYTES - 1))))
}
pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Spec,
    limit: i64,
) -> Result<bool> {
    spec.validate()?;
    sqlx::query("INSERT INTO native_platform_transcodes(session_id,user_id,room_id,media_id,generation,viewer_id,plan_generation,auth_login_hash,lifecycle_epoch,frozen_resource,deadline_ms,byte_limit) SELECT id,user_id,room_id,media_id,generation,viewer_id,plan_generation,auth_login_hash,lifecycle_epoch,resource,$2,$3 FROM playback_sessions WHERE id=$1 AND resource ? 'native_platform_context' AND resource->'native_platform_context'->'version' IN ('1'::jsonb,'2'::jsonb,'4'::jsonb) AND NOT stopped AND expires_at>clock_timestamp()")
        .bind(session).bind(spec.deadline_ms).bind(i64::try_from(spec.byte_budget())?).execute(&mut **tx).await?;
    Ok(crate::media_queue::enqueue_native_platform(
        tx,
        session,
        &serde_json::to_value(spec)?,
        limit,
    )
    .await?)
}
pub async fn allowed(pool: &PgPool, session: Uuid) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT native_platform_transcode_session_allowed($1)")
            .bind(session)
            .fetch_one(pool)
            .await?,
    )
}
pub async fn owned(pool: &PgPool, job: Uuid, owner: Uuid, attempt: i64) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND native_platform_transcode_session_allowed(j.session_id))")
        .bind(job).bind(owner).bind(attempt).fetch_one(pool).await?)
}
/// Charge the requested range before opening upstream; retries and repeated
/// seeks consume the original cumulative budget, never a new per-request grant.
pub async fn charge(
    pool: &PgPool,
    job: Uuid,
    owner: Uuid,
    attempt: i64,
    bytes: u64,
) -> Result<bool> {
    ensure!(
        bytes > 0 && bytes <= MAX_RANGE_BYTES,
        "native_platform_range_bound"
    );
    Ok(sqlx::query("UPDATE native_platform_transcodes n SET bytes_used=n.bytes_used+$4 FROM media_jobs j WHERE n.session_id=j.session_id AND j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND n.bytes_used+$4<=n.byte_limit AND native_platform_transcode_session_allowed(n.session_id)")
        .bind(job).bind(owner).bind(attempt).bind(i64::try_from(bytes)?).execute(pool).await?.rows_affected()==1)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> Spec {
        Spec {
            source_webm: None,
            source_video: None,
            kind: KIND.into(),
            recipe_version: 1,
            source_kind: "native_platform_private".into(),
            negotiated_mode: "transcode".into(),
            tracks: vec![Track {
                container: Default::default(),
                key: "progressive".into(),
                ticket: "a".repeat(64),
                total_bytes: 99,
                strong_etag: "\"representation\"".into(),
            }],
            output_ticket: "b".repeat(64),
            duration_seconds: 30.0,
            start_seconds: 0.0,
            deadline_ms: 1000,
            estimated_output_bytes: 999,
        }
    }
    #[test]
    fn webm_video_is_a_closed_private_pair_not_an_implicit_container_upgrade() {
        let mut value = serde_json::to_value(spec()).unwrap();
        value["source_webm"] = serde_json::json!({"schema_version":1,"codec":"av1","width":128,"height":96,"profile":0,"bit_depth":8,"color_primaries":1,"color_transfer":1,"color_space":1,"color_range":1});
        value["tracks"] = serde_json::json!([
            {"key":"video","container":"webm","ticket":"a".repeat(64),"total_bytes":999,"strong_etag":"\"v\""},
            {"key":"audio","ticket":"c".repeat(64),"total_bytes":100,"strong_etag":"\"a\""}
        ]);
        assert!(validate_spec(&value).is_ok());
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove("source_webm");
        assert!(validate_spec(&missing).is_err());
        let mut changed = value.clone();
        changed["tracks"][1]["container"] = serde_json::json!("webm");
        assert!(validate_spec(&changed).is_err());
        let mut implicit = value.clone();
        implicit["tracks"][0]
            .as_object_mut()
            .unwrap()
            .remove("container");
        assert!(validate_spec(&implicit).is_err());
        value["source_webm"]["url"] = serde_json::json!("https://unbound.invalid");
        assert!(validate_spec(&value).is_err());
    }
    #[test]
    fn closed_recipe_rejects_urls_live_and_unbounded_inputs() {
        let value = serde_json::to_value(spec()).unwrap();
        assert!(validate_spec(&value).is_ok());
        for key in ["url", "cookie", "filter", "live", "command"] {
            let mut v = value.clone();
            v[key] = serde_json::json!("x");
            assert!(validate_spec(&v).is_err());
        }
        let mut s = spec();
        s.tracks[0].key = "live".into();
        assert!(s.validate().is_err());
        s = spec();
        s.tracks[0].strong_etag = "W/\"weak\"".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn ranges_are_finite_bounded_and_never_multipart() {
        assert_eq!(bounded_range(Some("bytes=10-"), 99).unwrap(), (10, 98));
        assert_eq!(bounded_range(Some("bytes=-5"), 99).unwrap(), (94, 98));
        assert_eq!(
            bounded_range(None, MAX_INPUT_BYTES).unwrap(),
            (0, MAX_RANGE_BYTES - 1)
        );
        for r in [
            "bytes=99-",
            "bytes=5-4",
            "bytes=0-1,3-4",
            "bytes=-0",
            "bytes= 0-1",
        ] {
            assert!(bounded_range(Some(r), 99).is_err());
        }
    }
    #[test]
    fn split_tracks_require_distinct_tickets_and_fixed_order() {
        let mut s = spec();
        s.tracks[0].key = "video".into();
        let mut a = s.tracks[0].clone();
        a.key = "audio".into();
        a.ticket = "c".repeat(64);
        s.tracks.push(a);
        assert!(s.validate().is_ok());
        s.tracks.swap(0, 1);
        assert!(s.validate().is_err());
    }
    #[test]
    fn migration_preserves_finite_authority_queue_and_publication_fences() {
        let migration = include_str!("../../../migrations/0060_native_platform_transcode.sql");
        for fence in [
            "p.resource=n.frozen_resource",
            "p.viewer_id=n.viewer_id",
            "p.plan_generation=n.plan_generation",
            "p.auth_login_hash=n.auth_login_hash",
            "p.media_id=n.media_id",
            "p.generation=n.generation",
            "r.lifecycle_epoch=p.lifecycle_epoch",
            "e.resource_kind<>'live'",
            "playback_source_allowed(p.media_id,p.resource)",
            "native_platform_worker_recipe_required",
            "native_platform_output_file_authority_revoked",
            "NEW.logical_queue IS DISTINCT FROM 'native_platform_transcode_v1'",
            "NEW.bytes_used<OLD.bytes_used",
        ] {
            assert!(migration.contains(fence), "{fence}");
        }
        assert!(migration.contains("IN ('1'::jsonb,'2'::jsonb,'4'::jsonb)"));
        assert!(!migration.contains("'3'::jsonb"));
    }
}
