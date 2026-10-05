//! Opt-in owned-local recipes. Browser input is finite intent, never FFmpeg data.
use super::*;
use media_core::advanced_media;
use protocol::{AdvancedPlaybackCapabilities, AdvancedPlaybackFacts, AdvancedPlaybackRequest};

pub(crate) fn request(value: &AdvancedPlaybackRequest) -> Result<advanced_media::Request> {
    let request = advanced_media::Request {
        schema_version: value.schema_version,
        tone_map_hdr: value.tone_map_hdr,
        subtitle_stream_index: value.subtitle_stream_index,
    };
    request
        .validate()
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_request"))?;
    if !request.requires_transform() {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(request)
}

pub(crate) fn validate(body: &protocol::PlaybackRequest, dedicated: bool) -> Result<()> {
    let Some(value) = &body.advanced_playback else {
        return if dedicated {
            Err(err(StatusCode::BAD_REQUEST, "invalid_request"))
        } else {
            Ok(())
        };
    };
    if !dedicated {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "dedicated_advanced_endpoint_required",
        ));
    }
    request(value)?;
    if body.mode.as_deref() != Some("transcode")
        || body.native_platform.is_some()
        || body.static_hls_fallback_version.is_some()
        || body.http_file_fallback.is_some()
        || body.http_file_fallback_version.is_some_and(|v| v != 1)
        || body.upstream_profile_report.is_some()
        || body.candidate_report.is_none()
        || body.capabilities.is_none()
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(())
}

pub(crate) fn require_local(kind: &str, version: Option<&str>) -> Result<()> {
    if !matches!(kind, "local" | "agent" | "http") || !cfg!(target_os = "linux") {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "advanced_local_source_required",
        ));
    }
    if kind != "http" && !version.is_some_and(media_core::file_version::valid_file_version) {
        return Err(err(StatusCode::CONFLICT, "source_version_required"));
    }
    Ok(())
}

pub(crate) async fn attach_assets(
    root: &str,
    resource: &str,
    version: &str,
    meta: &mut Value,
) -> Result<()> {
    let root = std::path::PathBuf::from(root);
    let resource = resource.to_owned();
    let version = version.to_owned();
    let catalog = media_core::child_process::blocking(move || {
        advanced_media::AssetCatalog::discover(&root, &resource, &version)
    })
    .await
    .map_err(anyhow::Error::from)??;
    meta["advanced_assets"] = serde_json::to_value(catalog).map_err(anyhow::Error::from)?;
    Ok(())
}
/// Validate the fresh remote catalog before it becomes encrypted session/job
/// authority. Source metadata cannot choose a filename or destination.
pub(crate) fn attach_remote_assets(resource: &mut Value, meta: &Value) -> Result<()> {
    if let Some(value) = meta.get("advanced_remote_assets") {
        let remote: advanced_media::RemoteAssetCatalog =
            serde_json::from_value(value.clone()).map_err(anyhow::Error::from)?;
        let original = if resource["kind"] == "http" {
            resource["url"].as_str()
        } else {
            resource["resource"].as_str()
        }
        .unwrap_or("");
        remote.validate(
            resource["kind"].as_str().unwrap_or(""),
            original,
            resource["source_version"].as_str(),
        )?;
        if serde_json::to_value(&remote.catalog).map_err(anyhow::Error::from)?
            != meta["advanced_assets"]
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
        resource["advanced_remote_assets"] = value.clone();
        resource["advanced_remote_assets_version"] = json!(1);
    }
    Ok(())
}
pub(crate) fn assets_hash(meta: &Value) -> Result<Option<String>> {
    if let Some(value) = meta.get("advanced_remote_assets") {
        let remote: advanced_media::RemoteAssetCatalog =
            serde_json::from_value(value.clone()).map_err(anyhow::Error::from)?;
        remote.validate(
            &remote.source_kind,
            &remote.source_resource,
            (remote.source_kind == "agent").then_some(remote.source_version.as_str()),
        )?;
        return Ok(Some(remote.fingerprint()?));
    }
    if meta.get("advanced_assets").is_none() {
        return Ok(None);
    }
    let catalog: advanced_media::AssetCatalog =
        serde_json::from_value(meta["advanced_assets"].clone()).map_err(anyhow::Error::from)?;
    catalog.validate(&catalog.source_resource, &catalog.source_version)?;
    Ok(Some(catalog.fingerprint()?))
}
pub(crate) fn remote_duration(meta: &Value) -> Result<f64> {
    let duration = meta["format"]["duration"]
        .as_f64()
        .or_else(|| meta["format"]["duration"].as_str()?.parse().ok());
    duration
        .filter(|v| v.is_finite() && (0.001..=21600.0).contains(v))
        .ok_or_else(|| err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr"))
}
pub(crate) fn held_input_bytes(meta: &Value) -> Result<u64> {
    let bytes = meta["format"]["size"]
        .as_u64()
        .or_else(|| meta["format"]["size"].as_str()?.parse().ok());
    bytes
        .filter(|v| (1..=2 * 1024 * 1024 * 1024).contains(v))
        .ok_or_else(|| err(StatusCode::CONFLICT, "source_version_required"))
}

pub(crate) fn analyze(
    meta: &Value,
    audio: Option<u32>,
    position: f64,
    value: &AdvancedPlaybackRequest,
) -> Result<media_core::capabilities::CandidateAnalysis> {
    advanced_media::analyze(meta, audio, position, &request(value)?).map_err(probe_error)
}

fn probe_error(error: anyhow::Error) -> Error {
    match error.to_string().as_str() {
        "invalid_audio_track" => err(StatusCode::BAD_REQUEST, "invalid_audio_track"),
        "invalid_subtitle_track" | "subtitle_burn_in_codec_unsupported" => {
            err(StatusCode::BAD_REQUEST, "invalid_subtitle_track")
        }
        "drm_unsupported" => err(StatusCode::UNPROCESSABLE_ENTITY, "drm_unsupported"),
        _ => err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_video_or_hdr"),
    }
}

fn codec(value: advanced_media::SubtitleKind) -> protocol::AdvancedSubtitleCodec {
    match value {
        advanced_media::SubtitleKind::Ass => protocol::AdvancedSubtitleCodec::Ass,
        advanced_media::SubtitleKind::Ssa => protocol::AdvancedSubtitleCodec::Ssa,
        advanced_media::SubtitleKind::Pgs => protocol::AdvancedSubtitleCodec::Pgs,
    }
}

/// Every advertised transform must pass the same pure admission as a real
/// request. Eligibility is not a claim that Worker filters/devices are present.
pub(crate) fn capabilities(meta: &Value, audio: Option<u32>) -> AdvancedPlaybackCapabilities {
    let mut capabilities = AdvancedPlaybackCapabilities {
        schema_version: 1,
        tone_map_hdr: false,
        subtitle_streams: Vec::new(),
        worker_runtime_required: true,
    };
    if !cfg!(target_os = "linux") {
        return capabilities;
    }
    let hdr_request = AdvancedPlaybackRequest {
        schema_version: 1,
        tone_map_hdr: true,
        subtitle_stream_index: None,
    };
    capabilities.tone_map_hdr =
        media_core::motion_video::select(meta)
            .ok()
            .is_some_and(|selected| {
                advanced_media::classify_hdr(selected.stream)
                    .ok()
                    .flatten()
                    .is_some()
            })
            && analyze(meta, audio, 0.0, &hdr_request).is_ok();
    if let Some(streams) = meta["streams"]
        .as_array()
        .filter(|streams| streams.len() <= 256)
    {
        for stream in streams {
            let Some(index) = stream["index"]
                .as_u64()
                .and_then(|index| u32::try_from(index).ok())
            else {
                continue;
            };
            let request = AdvancedPlaybackRequest {
                schema_version: 1,
                tone_map_hdr: capabilities.tone_map_hdr,
                subtitle_stream_index: Some(index),
            };
            if analyze(meta, audio, 0.0, &request).is_err() {
                continue;
            }
            let Ok(selected) = advanced_media::select_subtitle(meta, index) else {
                continue;
            };
            capabilities
                .subtitle_streams
                .push(protocol::AdvancedSubtitleTrack {
                    index,
                    codec: codec(selected.kind),
                    label: stream["tags"]["title"]
                        .as_str()
                        .unwrap_or("Subtitle")
                        .chars()
                        .take(256)
                        .collect(),
                    language: stream["tags"]["language"]
                        .as_str()
                        .unwrap_or("und")
                        .chars()
                        .take(32)
                        .collect(),
                });
        }
    }
    if let Ok(catalog) =
        serde_json::from_value::<advanced_media::AssetCatalog>(meta["advanced_assets"].clone())
    {
        for asset in &catalog.subtitles {
            let request = AdvancedPlaybackRequest {
                schema_version: 1,
                tone_map_hdr: capabilities.tone_map_hdr,
                subtitle_stream_index: Some(asset.index),
            };
            if analyze(meta, audio, 0.0, &request).is_ok() {
                capabilities
                    .subtitle_streams
                    .push(protocol::AdvancedSubtitleTrack {
                        index: asset.index,
                        codec: codec(asset.kind),
                        label: format!(
                            "外部 {}",
                            match asset.kind {
                                advanced_media::SubtitleKind::Ass => "ASS",
                                advanced_media::SubtitleKind::Ssa => "SSA",
                                advanced_media::SubtitleKind::Pgs => "PGS",
                            }
                        ),
                        language: "und".into(),
                    });
            }
        }
    }
    capabilities
}

pub(crate) fn facts(
    meta: &Value,
    request: &AdvancedPlaybackRequest,
) -> Result<AdvancedPlaybackFacts> {
    let subtitle_codec = request
        .subtitle_stream_index
        .map(|index| {
            if matches!(
                index,
                advanced_media::EXTERNAL_ASS_INDEX
                    | advanced_media::EXTERNAL_SSA_INDEX
                    | advanced_media::EXTERNAL_PGS_INDEX
            ) {
                let catalog: advanced_media::AssetCatalog =
                    serde_json::from_value(meta["advanced_assets"].clone())?;
                catalog.validate(&catalog.source_resource, &catalog.source_version)?;
                Ok(codec(catalog.selected(index)?.kind))
            } else {
                advanced_media::select_subtitle(meta, index).map(|selected| codec(selected.kind))
            }
        })
        .transpose()
        .map_err(probe_error)?;
    Ok(AdvancedPlaybackFacts {
        request: request.clone(),
        subtitle_codec,
        video_basis: protocol::PlaybackOutputBasis::ConstrainedEncoderRecipe,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_schema_and_nonlocal_intents_are_refused() {
        let mut value = AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: false,
            subtitle_stream_index: None,
        };
        assert!(request(&value).is_err());
        value.subtitle_stream_index = Some(0);
        assert_eq!(request(&value).unwrap().subtitle_stream_index, Some(0));
        value.schema_version = 2;
        assert!(request(&value).is_err());
        assert!(require_local("http", None).is_ok());
        assert!(require_local("agent", None).is_err());
        assert!(require_local("jellyfin", None).is_err());
        assert!(require_local("local", Some("opaque_unbound")).is_err());
    }

    #[test]
    fn incomplete_metadata_does_not_advertise_transforms() {
        let caps = capabilities(&json!({"streams":[]}), None);
        assert!(!caps.tone_map_hdr);
        assert!(caps.subtitle_streams.is_empty());
        assert!(caps.worker_runtime_required);
    }

    #[test]
    fn dedicated_admission_cannot_drop_transform_or_mix_other_recipes() {
        let mut body: protocol::PlaybackRequest = serde_json::from_value(json!({
            "room_id":Uuid::nil(),"media_generation":1,"mode":"transcode",
            "advanced_playback":{"schema_version":1,"tone_map_hdr":true,"subtitle_stream_index":null},
            "capabilities":{"progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":true},
            "candidate_report":{"binding":"sealed","results":[],"excluded_candidates":[]}
        })).unwrap();
        assert!(validate(&body, true).is_ok());
        assert!(validate(&body, false).is_err());
        body.http_file_fallback_version = Some(1);
        assert!(validate(&body, true).is_ok());
        body.http_file_fallback_version = Some(2);
        assert!(validate(&body, true).is_err());
        body.http_file_fallback_version = None;
        body.static_hls_fallback_version = Some(1);
        assert!(validate(&body, true).is_err());
        body.static_hls_fallback_version = None;
        body.mode = Some("auto".into());
        assert!(validate(&body, true).is_err());
        body.mode = Some("transcode".into());
        body.candidate_report = None;
        assert!(validate(&body, true).is_err());
        body.advanced_playback = None;
        assert!(validate(&body, true).is_err());
        assert!(validate(&body, false).is_ok());
    }

    fn source() -> Value {
        json!({"format":{"start_time":"0"},"streams":[
            {"index":2,"codec_type":"video","codec_name":"h264","disposition":{"attached_pic":0},
             "pix_fmt":"yuv420p","width":1280,"height":720,"sample_aspect_ratio":"1:1","avg_frame_rate":"30/1","r_frame_rate":"30/1"},
            {"index":0,"codec_type":"subtitle","codec_name":"ass","tags":{"title":"Styled","language":"eng"}}
        ]})
    }

    #[test]
    fn capabilities_and_plan_facts_use_exact_fresh_inventory() {
        let meta = source();
        let caps = capabilities(&meta, None);
        assert!(!caps.tone_map_hdr);
        assert_eq!(caps.subtitle_streams.len(), 1);
        assert_eq!(caps.subtitle_streams[0].index, 0);
        let value = AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: false,
            subtitle_stream_index: Some(0),
        };
        let facts = facts(&meta, &value).unwrap();
        assert_eq!(
            facts.subtitle_codec,
            Some(protocol::AdvancedSubtitleCodec::Ass)
        );
        assert_eq!(facts.request, value);
        assert_eq!(
            analyze(&meta, None, 5000.0, &value).unwrap().candidates[0].delivery_mode,
            "transcode"
        );
        let mut protected = meta.clone();
        protected["streams"][0]["codec_tag_string"] = json!("encv");
        assert!(capabilities(&protected, None).subtitle_streams.is_empty());
        assert!(analyze(&protected, None, 0.0, &value).is_err());
        let mut duplicate = meta.clone();
        duplicate["streams"][0]["index"] = json!(0);
        assert!(capabilities(&duplicate, None).subtitle_streams.is_empty());
    }

    #[test]
    fn classified_hdr_requires_the_explicit_opt_in() {
        let mut meta = source();
        meta["streams"][0]["pix_fmt"] = json!("yuv420p10le");
        meta["streams"][0]["color_transfer"] = json!("smpte2084");
        meta["streams"][0]["color_primaries"] = json!("bt2020");
        meta["streams"][0]["color_space"] = json!("bt2020nc");
        meta["streams"][0]["color_range"] = json!("tv");
        let caps = capabilities(&meta, None);
        assert!(caps.tone_map_hdr);
        assert_eq!(caps.subtitle_streams.len(), 1);
        let mut value = AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: false,
            subtitle_stream_index: Some(0),
        };
        assert!(analyze(&meta, None, 0.0, &value).is_err());
        value.tone_map_hdr = true;
        assert!(analyze(&meta, None, 0.0, &value).is_ok());
        meta["streams"][0]["color_range"] = Value::Null;
        let unavailable = capabilities(&meta, None);
        assert!(!unavailable.tone_map_hdr);
        assert!(unavailable.subtitle_streams.is_empty());
    }
}
