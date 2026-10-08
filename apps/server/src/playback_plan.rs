//! Facts from an already authorized source/plan, never new negotiation or access.
use super::*;
use protocol::{DecoderFallbackMode, PlaybackMediaRange};
use sqlx::postgres::PgRow;

// Readiness and replay share one permission/current-attempt snapshot. Queue
// admission fixes job.id=session.id; a foreign or extra job cannot supply facts.
pub const AUTHORIZED_SNAPSHOT_SQL: &str = "SELECT p.resource,p.plan_generation,j.id AS job_id,j.status AS job_status,j.error AS job_error,j.attempt AS job_attempt,j.owner_id AS job_owner,j.lease_until>clock_timestamp() AS job_lease_live,o.owner_id AS output_owner,o.status AS output_status,o.validation_version,o.ready_segments,o.visible_manifest,o.manifest_sha256,v.seq AS observation_seq,(SELECT min(l.duration_us) FROM local_hls_ladder_manifests l WHERE l.job_id=j.id AND l.attempt=j.attempt AND l.ready_segments=o.ready_segments HAVING count(*)=jsonb_array_length(j.spec->'renditions') AND min(l.duration_us)=max(l.duration_us)) AS ladder_duration_us FROM playback_sessions p JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id LEFT JOIN media_jobs j ON j.session_id=p.id AND j.id=p.id LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt LEFT JOIN playback_observations v ON v.session_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND NOT p.stopped AND playback_source_allowed(p.media_id,p.resource,p.id) AND p.expires_at>clock_timestamp() AND (s.state->>'media_generation')::bigint=p.generation AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans g WHERE g.user_id=p.user_id AND g.room_id=p.room_id AND g.viewer_id=p.viewer_id AND g.plan_generation=p.plan_generation)) AND EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=p.room_id AND m.user_id=p.user_id)";

#[derive(Default)]
pub struct JobFacts {
    pub recorded: bool,
    pub pending_job_id: Option<Uuid>,
    pub seekable_media_ranges_ms: Option<Vec<PlaybackMediaRange>>,
}

/// The local recipe decodes/discards preroll at nonzero starts. A selected
/// stream-copy route cannot claim that exact origin or silently change codec.
pub fn local_timeline_origin(position_ms: f64, mode: &str) -> Option<f64> {
    (position_ms.is_finite()
        && position_ms >= 0.0
        && (mode == "transcode"
            || (matches!(mode, "remux" | "audio_transcode") && position_ms == 0.0)))
        .then_some(position_ms)
}

/// Only the committed manifest is authoritative, not FFmpeg's private file.
pub fn published_duration_ms(manifest: &str, segments: i32) -> Option<f64> {
    let mut count = 0;
    let mut seconds = 0.0;
    for duration in manifest
        .lines()
        .filter_map(|line| line.strip_prefix("#EXTINF:"))
    {
        let value: f64 = duration.split_once(',')?.0.parse().ok()?;
        if !value.is_finite() || value <= 0.0 {
            return None;
        }
        seconds += value;
        count += 1;
    }
    let ms = seconds * 1000.0;
    (count == segments && count > 0 && ms.is_finite()).then_some(ms)
}

fn published_ranges(
    origin: f64,
    output_status: Option<&str>,
    validation_version: Option<i32>,
    segments: i32,
    manifest: Option<&str>,
    manifest_sha256: Option<&str>,
) -> Option<Vec<PlaybackMediaRange>> {
    // Versions are semantic contracts, not a monotonic capability level.
    // Full child v4 uses a dedicated owner/manifest/resource path, never this
    // generic output snapshot adapter (nor an unknown future version).
    if !origin.is_finite()
        || origin < 0.0
        || validation_version.is_some_and(|v| !matches!(v, 2 | 3))
    {
        return None;
    }
    if !matches!(output_status, None | Some("writing" | "published")) {
        return None;
    }
    if output_status != Some("published") && segments == 0 && manifest.is_none_or(str::is_empty) {
        return Some(vec![]);
    }
    let manifest = manifest?;
    if validation_version.is_none() || manifest_sha256 != Some(hash(manifest).as_str()) {
        return None;
    }
    let end = origin + published_duration_ms(manifest, segments)?;
    Some(vec![PlaybackMediaRange::new(origin, end)?])
}

pub fn job_facts(app: &App, row: &PgRow) -> Result<JobFacts> {
    let stored: Value = row.get("resource");
    let encrypted = stored["encrypted"]
        .as_str()
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let resource = app.decrypt(encrypted)?;
    // Old resources never recorded these facts. Do not retrofit a measurement
    // or invent a historical source/job binding on an idempotent replay.
    if resource["plan_facts_version"] != 1 {
        return Ok(JobFacts::default());
    }
    let empty = || JobFacts {
        recorded: true,
        ..JobFacts::default()
    };
    if !matches!(resource["kind"].as_str(), Some("local" | "http" | "agent")) {
        return Ok(empty());
    }
    let Some(job) = row.get::<Option<Uuid>, _>("job_id") else {
        return Ok(empty());
    };
    if resource["job_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        != Some(job)
    {
        return Ok(empty());
    }
    let status: Option<String> = row.get("job_status");
    let pending_job_id = matches!(status.as_deref(), Some("queued" | "running")).then_some(job);
    let output_status: Option<String> = row.get("output_status");
    let owner = row.get::<Option<Uuid>, _>("job_owner");
    let owned_output = owner.is_some() && owner == row.get::<Option<Uuid>, _>("output_owner");
    let readable = owned_output
        && match status.as_deref() {
            Some("running") => {
                row.get::<Option<bool>, _>("job_lease_live") == Some(true)
                    && output_status.as_deref() == Some("writing")
            }
            Some("succeeded") => output_status.as_deref() == Some("published"),
            _ => false,
        };
    let queued_unstarted = status.as_deref() == Some("queued")
        && row.get::<Option<i64>, _>("job_attempt") == Some(0)
        && output_status.is_none()
        && row.get::<Option<i32>, _>("validation_version").is_none()
        && row.get::<Option<i32>, _>("ready_segments").is_none()
        && row.get::<Option<String>, _>("visible_manifest").is_none();
    if stored.get("local_hls_ladder_version").is_some()
        || resource.get("local_hls_ladder_version").is_some()
    {
        // Dedicated validation5 admits no legacy scalar playlist or output. Its
        // master hash and every common rung duration must agree in this one row.
        let seekable_media_ranges_ms = resource["timeline_origin_ms"].as_f64().and_then(|origin| {
            if stored["local_hls_ladder_version"] != 1
                || resource["local_hls_ladder_version"] != 1
                || !origin.is_finite()
                || origin < 0.0
            {
                return None;
            }
            if queued_unstarted {
                return Some(vec![]);
            }
            if !readable || row.get::<Option<i32>, _>("validation_version") != Some(5) {
                return None;
            }
            let count = row.get::<Option<i32>, _>("ready_segments").unwrap_or(0);
            let text = row.get::<Option<String>, _>("visible_manifest");
            if count == 0 && text.is_none() && status.as_deref() == Some("running") {
                return Some(vec![]);
            }
            let text = text?;
            media_core::hls_ladder::parse_master(&text).ok()?;
            if row.get::<Option<String>, _>("manifest_sha256").as_deref()
                != Some(hash(&text).as_str())
            {
                return None;
            }
            let duration = row.get::<Option<i64>, _>("ladder_duration_us")?;
            if count <= 0 || duration <= 0 {
                return None;
            }
            Some(vec![PlaybackMediaRange::new(
                origin,
                origin + duration as f64 / 1000.0,
            )?])
        });
        return Ok(JobFacts {
            recorded: true,
            pending_job_id,
            seekable_media_ranges_ms,
        });
    }
    let seekable_media_ranges_ms = resource["timeline_origin_ms"].as_f64().and_then(|origin| {
        if !origin.is_finite() || origin < 0.0 {
            return None;
        }
        if queued_unstarted {
            return Some(vec![]);
        }
        if !readable {
            return None;
        }
        published_ranges(
            origin,
            output_status.as_deref(),
            row.get("validation_version"),
            row.get::<Option<i32>, _>("ready_segments").unwrap_or(0),
            row.get::<Option<String>, _>("visible_manifest").as_deref(),
            row.get::<Option<String>, _>("manifest_sha256").as_deref(),
        )
    });
    Ok(JobFacts {
        recorded: true,
        pending_job_id,
        seekable_media_ranges_ms,
    })
}

pub async fn refresh(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user: Uuid,
    session: Uuid,
    plan: &mut Value,
) -> Result<()> {
    let row = sqlx::query(AUTHORIZED_SNAPSHOT_SQL)
        .bind(session)
        .bind(user)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let facts = job_facts(app, &row)?;
    if !facts.recorded {
        return Ok(());
    }
    let object = plan
        .as_object_mut()
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    object.remove("pending_job_id");
    object.remove("seekable_media_ranges_ms");
    if let Some(job) = facts.pending_job_id {
        object.insert("pending_job_id".into(), json!(job));
    }
    if let Some(ranges) = facts.seekable_media_ranges_ms {
        object.insert("seekable_media_ranges_ms".into(), json!(ranges));
    }
    Ok(())
}

pub fn stream_index(stream: &Value) -> Option<u32> {
    stream["index"].as_u64().and_then(|v| u32::try_from(v).ok())
}

/// DefaultAudioStreamIndex is evidence only for the current, unambiguous source
/// and a unique Audio stream. Array order and item-list metadata are not proof.
pub fn upstream_audio(info: &Value, requested: Option<u32>, mode: &str) -> Option<u32> {
    let sources = info["MediaSources"].as_array()?;
    if sources.len() != 1 {
        return None;
    }
    let source = &sources[0];
    let source_id = source["Id"].as_str()?;
    if source_id.trim().is_empty()
        || source_id.len() > 512
        || source_id.chars().any(char::is_control)
    {
        return None;
    }
    let streams = source["MediaStreams"].as_array()?;
    if mode == "direct" && streams.iter().filter(|s| s["Type"] == "Audio").count() != 1 {
        return None;
    }
    let index = source["DefaultAudioStreamIndex"]
        .as_u64()
        .filter(|v| *v <= i32::MAX as u64)? as u32;
    if requested.is_some_and(|v| v != index) {
        return None;
    }
    (source["MediaStreams"]
        .as_array()?
        .iter()
        .filter(|s| s["Type"] == "Audio" && s["Index"].as_u64() == Some(u64::from(index)))
        .count()
        == 1)
        .then_some(index)
}

/// Generated local HLS explicitly maps 0:a:0 or the validated absolute index.
/// Progressive multi-audio files leave track selection to the media element.
pub fn mapped_audio(
    meta: &Value,
    requested: Option<u32>,
    mode: &str,
    current: bool,
) -> Option<u32> {
    if !current {
        return None;
    }
    let audio: Vec<_> = meta["streams"]
        .as_array()?
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    if let Some(index) = requested {
        return (mode != "direct"
            && audio
                .iter()
                .filter(|s| stream_index(s) == Some(index))
                .count()
                == 1)
            .then_some(index);
    }
    if mode == "direct" && audio.len() != 1 {
        return None;
    }
    stream_index(audio.first()?)
}

pub fn local_fallbacks(
    meta: &Value,
    mode: &str,
    position_ms: f64,
    current: bool,
    hls: bool,
) -> Vec<DecoderFallbackMode> {
    if !current || !hls || mode == "transcode" {
        return vec![];
    }
    let known_video = meta["streams"].as_array().is_some_and(|streams| {
        streams.iter().any(|s| {
            s["codec_type"] == "video" && s["codec_name"].as_str().is_some_and(|v| !v.is_empty())
        })
    });
    let Ok(compatible) = media_core::compatible_mode(meta, false) else {
        return vec![];
    };
    if !known_video {
        return vec![];
    }
    let mut modes = Vec::new();
    if mode == "direct"
        && compatible != "transcode"
        && position_ms == 0.0
        && !media_core::hls_needs_video_transform(meta)
    {
        modes.push(DecoderFallbackMode::Remux);
    }
    modes.push(DecoderFallbackMode::Transcode);
    modes
}

/// Local, reliable HTTP and Agent jobs use the original first-video/default-
/// audio recipe. A continuation hint must meet the same mapping proof as new
/// admission, using this attempt's trustworthy source facts.
pub fn legacy_mapped_fallbacks(
    meta: &Value,
    audio_index: Option<u32>,
    mode: &str,
    position_ms: f64,
    current: bool,
    hls: bool,
) -> Vec<DecoderFallbackMode> {
    if media_core::motion_video::legacy_mapping_equivalent(meta, audio_index).is_err() {
        return vec![];
    }
    local_fallbacks(meta, mode, position_ms, current, hls)
}

/// Check the actual generated route after every negotiation path converges.
/// Candidate discovery and continuation hints do not grant job admission.
pub fn require_legacy_job_mapping(
    kind: &str,
    local_job: bool,
    meta: &Value,
    audio_index: Option<u32>,
    current_probe: bool,
) -> Result<()> {
    if !local_job || !matches!(kind, "local" | "http" | "agent") {
        return Ok(());
    }
    if !current_probe {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "legacy_stream_mapping_unsupported",
        ));
    }
    media_core::motion_video::legacy_mapping_equivalent(meta, audio_index)
        .map_err(playback_capabilities::probe_error)
}

/// Keep plain original-file direct behavior. Agent requests that can create a
/// generated job, or report a bound candidate, reuse the existing relay probe;
/// cached inventory cannot establish the current legacy stream mapping.
pub fn needs_preparation_probe(
    kind: &str,
    requested_mode: &str,
    selected: bool,
    audio_index: Option<u32>,
    progressive_supported: bool,
) -> bool {
    match kind {
        "http" => requested_mode != "direct",
        "agent" => {
            requested_mode != "direct"
                || selected
                || audio_index.is_some()
                || !progressive_supported
        }
        _ => false,
    }
}

pub fn upstream_fallbacks(
    info: &Value,
    mode: &str,
    hls: bool,
    base: &str,
) -> Vec<DecoderFallbackMode> {
    let Some(sources) = info["MediaSources"].as_array().filter(|s| s.len() == 1) else {
        return vec![];
    };
    let source = &sources[0];
    let audio_known = upstream_audio(info, None, mode).is_some()
        || source["MediaStreams"]
            .as_array()
            .is_some_and(|streams| streams.iter().all(|stream| stream["Type"] != "Audio"));
    if !audio_known || mode != "direct" || !hls || source["SupportsTranscoding"] != true {
        return vec![];
    }
    let route = source["TranscodingUrl"].as_str().filter(|v| !v.is_empty());
    let valid = providers::validate_url(&format!("{}/", base.trim_end_matches('/')))
        .ok()
        .zip(route)
        .is_some_and(|(base, route)| providers::upstream_url(&base, route).is_ok());
    if valid {
        vec![DecoderFallbackMode::Transcode]
    } else {
        vec![]
    }
}

pub fn decision_reason(
    kind: &str,
    requested: &str,
    mode: &str,
    current_metadata: bool,
    probed: bool,
    candidate: Option<&str>,
) -> String {
    if let Some(candidate) = candidate {
        return format!("actual_media_{candidate}");
    }
    if matches!(kind, "jellyfin" | "emby") {
        return format!("{kind}_negotiated_{mode}");
    }
    let evidence = if probed {
        "authorized_probe"
    } else if current_metadata {
        "source_version_matched_metadata"
    } else {
        "legacy_transport_policy"
    };
    let intent = if requested == "auto" {
        "automatic"
    } else {
        "requested"
    };
    format!("{kind}_{intent}_{mode}_{evidence}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped_source() -> Value {
        json!({"format":{"format_name":"mp4"},"streams":[
            {"index":5,"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p",
                "disposition":{"attached_pic":0},"avg_frame_rate":"25/1","r_frame_rate":"25/1"},
            {"index":0,"codec_type":"audio","codec_name":"aac"},
            {"index":12,"codec_type":"audio","codec_name":"aac"}
        ]})
    }

    #[test]
    fn generated_admission_requires_fresh_mapping_after_route_selection() {
        let mut uncertain = mapped_source();
        uncertain["streams"].as_array_mut().unwrap().insert(
            0,
            json!({"index":1,"codec_type":"video","disposition":{"attached_pic":1}}),
        );
        // Candidate selection, legacy auto/remux/transcode, explicit-direct
        // audio conversion and continuation all converge on this same guard.
        for context in [
            "candidate",
            "legacy_auto",
            "legacy_remux",
            "legacy_transcode",
            "forced_direct_with_audio",
            "continuation",
        ] {
            for kind in ["local", "http", "agent"] {
                let audio = (context == "forced_direct_with_audio").then_some(0);
                assert!(
                    require_legacy_job_mapping(kind, true, &mapped_source(), audio, true).is_ok(),
                    "{kind}/{context}"
                );
                let error =
                    require_legacy_job_mapping(kind, true, &uncertain, audio, true).unwrap_err();
                assert_eq!(
                    error.0,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "{kind}/{context}"
                );
                assert_eq!(error.1, "legacy_stream_mapping_unsupported");
                assert_eq!(
                    require_legacy_job_mapping(kind, true, &mapped_source(), audio, false)
                        .unwrap_err()
                        .1,
                    "legacy_stream_mapping_unsupported"
                );
            }
        }
        assert_eq!(
            require_legacy_job_mapping("local", true, &mapped_source(), Some(99), true)
                .unwrap_err()
                .1,
            "invalid_audio_track"
        );
        // The original-file route creates no job; upstream negotiation does
        // not use the local generated recipe.
        assert!(require_legacy_job_mapping("http", false, &json!({}), None, false).is_ok());
        assert!(require_legacy_job_mapping("local", false, &uncertain, None, true).is_ok());
        assert!(require_legacy_job_mapping("agent", false, &uncertain, None, false).is_ok());
        for kind in ["jellyfin", "emby"] {
            assert!(require_legacy_job_mapping(kind, true, &json!({}), None, false).is_ok());
        }
    }

    #[test]
    fn agent_candidate_and_generated_intents_reuse_the_preparation_probe() {
        for mode in ["auto", "remux", "transcode"] {
            for selected in [false, true] {
                assert!(needs_preparation_probe("agent", mode, selected, None, true));
            }
        }
        assert!(needs_preparation_probe("agent", "direct", true, None, true));
        assert!(needs_preparation_probe(
            "agent",
            "direct",
            false,
            Some(0),
            true
        ));
        assert!(needs_preparation_probe(
            "agent", "direct", false, None, false
        ));
        assert!(!needs_preparation_probe(
            "agent", "direct", false, None, true
        ));
        // Keep HTTP's existing probe policy, including forced-direct input.
        assert!(needs_preparation_probe("http", "auto", true, None, true));
        assert!(!needs_preparation_probe(
            "http",
            "direct",
            true,
            Some(0),
            false
        ));
        for kind in ["local", "jellyfin", "emby"] {
            assert!(!needs_preparation_probe(kind, "auto", true, Some(0), false));
        }
    }

    #[test]
    fn generated_continuation_hints_require_the_same_mapping() {
        let meta = mapped_source();
        assert_eq!(
            legacy_mapped_fallbacks(&meta, None, "direct", 0.0, true, true),
            vec![DecoderFallbackMode::Remux, DecoderFallbackMode::Transcode]
        );
        assert_eq!(
            legacy_mapped_fallbacks(&meta, Some(12), "remux", 0.0, true, true),
            vec![DecoderFallbackMode::Transcode]
        );
        let mut reordered = meta.clone();
        reordered["streams"].as_array_mut().unwrap().swap(1, 2);
        assert!(legacy_mapped_fallbacks(&reordered, None, "direct", 0.0, true, true).is_empty());
        assert_eq!(
            legacy_mapped_fallbacks(&reordered, Some(0), "remux", 0.0, true, true),
            vec![DecoderFallbackMode::Transcode]
        );
        let mut unknown = meta.clone();
        unknown["streams"][0]["disposition"] = Value::Null;
        assert!(legacy_mapped_fallbacks(&unknown, None, "direct", 0.0, true, true).is_empty());
        assert!(legacy_mapped_fallbacks(&meta, None, "direct", 0.0, false, true).is_empty());
        assert!(legacy_mapped_fallbacks(&meta, None, "direct", 0.0, true, false).is_empty());
        assert!(legacy_mapped_fallbacks(&meta, None, "transcode", 0.0, true, true).is_empty());
    }

    #[test]
    fn audio_requires_current_unique_source_and_default() {
        let mut info = json!({"MediaSources":[{"Id":"observed", "DefaultAudioStreamIndex":2,
            "MediaStreams":[{"Type":"Audio","Index":1},{"Type":"Audio","Index":2}]}]});
        assert_eq!(upstream_audio(&info, None, "transcode"), Some(2));
        assert_eq!(upstream_audio(&info, None, "direct"), None);
        assert_eq!(upstream_audio(&info, Some(2), "transcode"), Some(2));
        assert_eq!(upstream_audio(&info, Some(1), "transcode"), None);
        info["MediaSources"][0]["DefaultAudioStreamIndex"] = json!(3);
        assert_eq!(upstream_audio(&info, None, "transcode"), None);
        info["MediaSources"][0]
            .as_object_mut()
            .unwrap()
            .remove("DefaultAudioStreamIndex");
        assert_eq!(upstream_audio(&info, None, "transcode"), None);
        let source = info["MediaSources"][0].clone();
        info["MediaSources"].as_array_mut().unwrap().push(source);
        assert_eq!(upstream_audio(&info, None, "transcode"), None);
        let meta =
            json!({"streams":[{"codec_type":"audio","index":1},{"codec_type":"audio","index":2}]});
        assert_eq!(mapped_audio(&meta, None, "direct", true), None);
        assert_eq!(mapped_audio(&meta, None, "remux", true), Some(1));
        assert_eq!(mapped_audio(&meta, Some(2), "transcode", true), Some(2));
        assert_eq!(mapped_audio(&meta, Some(2), "transcode", false), None);
    }

    #[test]
    fn ranges_use_published_prefix_and_original_coordinates() {
        let manifest = "#EXTINF:4.125,\nindex0.m4s\n#EXTINF:2,\nindex1.m4s\n";
        assert_eq!(published_duration_ms(manifest, 2), Some(6125.0));
        assert_eq!(
            published_ranges(5000.0, Some("writing"), Some(3), 0, None, None),
            Some(vec![])
        );
        assert_eq!(
            published_ranges(
                5000.0,
                Some("published"),
                Some(3),
                2,
                Some(manifest),
                Some(hash(manifest).as_str())
            ),
            Some(vec![PlaybackMediaRange::new(5000.0, 11125.0).unwrap()])
        );
        assert_eq!(
            published_ranges(0.0, Some("legacy"), Some(1), 0, None, None),
            None
        );
        assert_eq!(
            published_ranges(
                0.0,
                Some("published"),
                Some(3),
                3,
                Some(manifest),
                Some(hash(manifest).as_str())
            ),
            None
        );
        assert_eq!(
            published_ranges(
                5000.0,
                Some("writing"),
                Some(3),
                2,
                Some(manifest),
                Some(hash(manifest).as_str())
            ),
            Some(vec![PlaybackMediaRange::new(5000.0, 11125.0).unwrap()])
        );
        assert_eq!(
            published_ranges(
                0.0,
                Some("writing"),
                Some(3),
                2,
                Some(manifest),
                Some("invalid")
            ),
            None
        );
        assert_eq!(
            published_ranges(0.0, Some("abandoned"), Some(3), 0, None, None),
            None
        );
        let overflow = "#EXTINF:1e305,\nindex0.m4s\n";
        assert_eq!(
            published_ranges(
                1e308,
                Some("published"),
                Some(3),
                1,
                Some(overflow),
                Some(hash(overflow).as_str())
            ),
            None
        );
        for duration in ["NaN", "inf", "-1", "0", "1e308", "broken"] {
            assert_eq!(
                published_duration_ms(&format!("#EXTINF:{duration},\n"), 1),
                None
            );
        }
    }

    #[test]
    fn generic_ranges_do_not_adopt_child_or_unknown_validation_versions() {
        let manifest = "#EXTM3U\n#EXTINF:2.000000,\ns000.m4s\n#EXT-X-ENDLIST\n";
        let digest = hash(manifest);
        for version in [0, 1, 4, 5, i32::MAX] {
            assert!(
                published_ranges(
                    1013.0,
                    Some("published"),
                    Some(version),
                    1,
                    Some(manifest),
                    Some(&digest),
                )
                .is_none()
            );
            assert!(
                published_ranges(1013.0, Some("writing"), Some(version), 0, None, None,).is_none()
            );
        }
    }

    #[test]
    fn fallback_hints_require_known_source_and_hls_and_never_repeat_transcode() {
        let meta = json!({"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","avg_frame_rate":"25/1","r_frame_rate":"25/1"}],"format":{"format_name":"mp4"}});
        assert_eq!(
            local_fallbacks(&meta, "direct", 0.0, true, true),
            vec![DecoderFallbackMode::Remux, DecoderFallbackMode::Transcode]
        );
        assert_eq!(
            local_fallbacks(&meta, "remux", 0.0, true, true),
            vec![DecoderFallbackMode::Transcode]
        );
        assert_eq!(
            local_fallbacks(&meta, "direct", 1000.0, true, true),
            vec![DecoderFallbackMode::Transcode]
        );
        assert!(local_fallbacks(&meta, "transcode", 0.0, true, true).is_empty());
        assert!(local_fallbacks(&meta, "direct", 0.0, false, true).is_empty());
        assert!(local_fallbacks(&meta, "direct", 0.0, true, false).is_empty());
        let mut hdr = meta.clone();
        hdr["streams"][0]["color_transfer"] = json!("smpte2084");
        assert!(local_fallbacks(&hdr, "direct", 0.0, true, true).is_empty());
    }

    #[test]
    fn nonzero_local_origin_requires_the_exact_decoded_recipe() {
        assert_eq!(local_timeline_origin(0.0, "remux"), Some(0.0));
        assert_eq!(local_timeline_origin(0.0, "audio_transcode"), Some(0.0));
        assert_eq!(local_timeline_origin(12_345.0, "transcode"), Some(12_345.0));
        assert_eq!(local_timeline_origin(12_345.0, "remux"), None);
        assert_eq!(local_timeline_origin(12_345.0, "audio_transcode"), None);
        assert_eq!(local_timeline_origin(0.0, "direct"), None);
        for position in [f64::NAN, f64::INFINITY, -1.0] {
            assert_eq!(local_timeline_origin(position, "transcode"), None);
        }
    }
}
