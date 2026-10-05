//! Dedicated clear-SDR owned-local HLS ladder admission.
use super::*;
use media_core::hls_ladder::LadderRecipe;
use protocol::{
    LocalHlsLadderCapabilities, LocalHlsLadderFacts, LocalHlsLadderRequest, LocalHlsRendition,
};

pub(crate) fn request(value: &LocalHlsLadderRequest) -> Result<()> {
    if value.schema_version != 1 {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(())
}
pub(crate) fn validate(body: &protocol::PlaybackRequest, dedicated: bool) -> Result<()> {
    let Some(value) = &body.local_hls_ladder else {
        return if dedicated {
            Err(err(StatusCode::BAD_REQUEST, "invalid_request"))
        } else {
            Ok(())
        };
    };
    request(value)?;
    if let Some(value) = &body.advanced_playback {
        super::advanced_playback::request(value)?;
    }
    if !dedicated {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "dedicated_local_hls_ladder_endpoint_required",
        ));
    }
    if body.mode.as_deref() != Some("transcode")
        || body.native_platform.is_some()
        || body.static_hls_fallback_version.is_some()
        || body.http_file_fallback.is_some()
        || body.http_file_fallback_version.is_some()
        || body.upstream_profile_report.is_some()
        || body.candidate_report.is_none()
        || body.capabilities.is_none()
        || body.viewer_id.is_none()
        || body.plan_generation.is_none()
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    Ok(())
}
pub(crate) fn require_local(kind: &str, version: Option<&str>) -> Result<()> {
    if kind != "local" || !cfg!(target_os = "linux") {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "local_hls_ladder_source_required",
        ));
    }
    if !version.is_some_and(media_core::file_version::valid_file_version) {
        return Err(err(StatusCode::CONFLICT, "source_version_required"));
    }
    Ok(())
}
pub(crate) fn recipe(meta: &Value, audio: Option<u32>, position_ms: f64) -> Result<LadderRecipe> {
    LadderRecipe::from_probe(meta, audio, position_ms / 1000.0).map_err(|error| {
        match error.to_string().as_str() {
            "invalid_audio_track" => err(StatusCode::BAD_REQUEST, "invalid_audio_track"),
            "drm_unsupported" => err(StatusCode::UNPROCESSABLE_ENTITY, "drm_unsupported"),
            _ => err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "local_hls_ladder_source_unsupported",
            ),
        }
    })
}
pub(crate) fn recipe_with_advanced(
    meta: &Value,
    audio: Option<u32>,
    position_ms: f64,
    value: &protocol::AdvancedPlaybackRequest,
) -> Result<LadderRecipe> {
    let request = super::advanced_playback::request(value)?;
    LadderRecipe::from_advanced_probe(meta, audio, position_ms / 1000.0, &request).map_err(|_| {
        err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "local_hls_ladder_source_unsupported",
        )
    })
}
pub(crate) fn analyze_with_advanced(
    meta: &Value,
    audio: Option<u32>,
    position_ms: f64,
    value: &protocol::AdvancedPlaybackRequest,
) -> Result<media_core::capabilities::CandidateAnalysis> {
    let recipe = recipe_with_advanced(meta, audio, position_ms, value)?;
    let candidates = recipe.candidates();
    let route_decisions = candidates
        .iter()
        .map(|candidate| protocol::PlaybackRouteDecision {
            candidate_id: candidate.id.clone(),
            offered: true,
            reason: protocol::PlaybackRouteReason::ConstrainedEncoderRecipe,
        })
        .collect();
    Ok(media_core::capabilities::CandidateAnalysis {
        candidates,
        route_decisions,
    })
}
pub(crate) fn capabilities_with_advanced(
    meta: &Value,
    audio: Option<u32>,
    value: &protocol::AdvancedPlaybackRequest,
) -> LocalHlsLadderCapabilities {
    LocalHlsLadderCapabilities {
        schema_version: 1,
        renditions: if cfg!(target_os = "linux") {
            recipe_with_advanced(meta, audio, 0.0, value)
                .map(|r| renditions(&r))
                .unwrap_or_default()
        } else {
            vec![]
        },
        worker_runtime_required: true,
    }
}
fn renditions(recipe: &LadderRecipe) -> Vec<LocalHlsRendition> {
    recipe
        .renditions()
        .iter()
        .map(|r| LocalHlsRendition {
            id: r.id.as_str().into(),
            width: r.width,
            height: r.height,
            bandwidth: r.bandwidth,
            codecs: r.codecs(),
        })
        .collect()
}
pub(crate) fn capabilities(meta: &Value, audio: Option<u32>) -> LocalHlsLadderCapabilities {
    LocalHlsLadderCapabilities {
        schema_version: 1,
        renditions: if cfg!(target_os = "linux") {
            recipe(meta, audio, 0.0)
                .map(|r| renditions(&r))
                .unwrap_or_default()
        } else {
            vec![]
        },
        worker_runtime_required: true,
    }
}
pub(crate) fn facts(recipe: &LadderRecipe, request: &LocalHlsLadderRequest) -> LocalHlsLadderFacts {
    LocalHlsLadderFacts {
        request: request.clone(),
        renditions: renditions(recipe),
        video_basis: protocol::PlaybackOutputBasis::ConstrainedEncoderRecipe,
    }
}
pub(crate) fn analyze(
    meta: &Value,
    audio: Option<u32>,
    position_ms: f64,
) -> Result<media_core::capabilities::CandidateAnalysis> {
    media_core::hls_ladder::analyze(meta, audio, position_ms).map_err(|_| {
        err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "local_hls_ladder_source_unsupported",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separate_and_generation_bound_admission() {
        let mut body:protocol::PlaybackRequest=serde_json::from_value(json!({"room_id":Uuid::nil(),"media_generation":0,"viewer_id":Uuid::nil(),"plan_generation":1,"mode":"transcode","local_hls_ladder":{"schema_version":1},"capabilities":{"progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":true},"candidate_report":{"binding":"sealed","results":[],"excluded_candidates":[]}})).unwrap();
        assert!(validate(&body, true).is_ok());
        assert!(validate(&body, false).is_err());
        body.advanced_playback = Some(protocol::AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: true,
            subtitle_stream_index: None,
        });
        assert!(validate(&body, true).is_ok());
        body.advanced_playback = None;
        body.plan_generation = None;
        assert!(validate(&body, true).is_err());
        assert!(require_local("http", None).is_err());
        assert!(
            capabilities(&json!({"streams":[]}), None)
                .renditions
                .is_empty()
        );
    }
}
