//! Pure choices from decoded facts and intent; no database, clock, network,
//! request ownership or grant creation belongs here.
use super::facts::{CandidateFacts, SourceFacts, upstream_audio};
use protocol::{
    DecoderFallbackMode, PlaybackCandidate, PlaybackCandidateReport, PlaybackCapabilities,
};
use serde_json::Value;

/// Only inputs used by concrete candidate selection. The binding has already
/// been decoded and checked by the adapter; this value grants no authority.
pub struct CandidateIntent<'a> {
    pub requested_mode: &'a str,
    pub position_ms: f64,
    pub ladder: bool,
    pub report: &'a PlaybackCandidateReport,
    pub capabilities: &'a PlaybackCapabilities,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    InvalidRequest,
    NoCompatibleTransport,
    FiniteHlsSourceUnsupported,
    LocalHlsLadderSourceRequired,
    AdvancedLocalSourceRequired,
    StaleCapabilityReport,
}

#[derive(Clone, Copy, Default)]
pub struct SourceIntent {
    pub finite_hls: bool,
    pub ladder: bool,
    pub advanced: bool,
    pub candidate_report: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpOrigin {
    Http,
    S3,
}

/// The current preparation dispatch, not a provider configuration parser or
/// an authorization result. Unknown kinds keep their existing pass-through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceRoute<'a> {
    Local,
    Agent,
    Http(HttpOrigin),
    Jellyfin,
    Emby,
    Other(&'a str),
}

impl<'a> SourceRoute<'a> {
    pub fn kind(self) -> &'a str {
        match self {
            Self::Local => "local",
            Self::Agent => "agent",
            Self::Http(_) => "http",
            Self::Jellyfin => "jellyfin",
            Self::Emby => "emby",
            Self::Other(kind) => kind,
        }
    }
}

/// Preserve the adapter's rejection order, including the original storage
/// check before S3 is normalized to the HTTP transport.
pub fn source_route<'a>(
    facts: SourceFacts<'a>,
    intent: SourceIntent,
) -> Result<SourceRoute<'a>, Rejection> {
    if intent.finite_hls && facts.storage_kind != "http" {
        return Err(Rejection::FiniteHlsSourceUnsupported);
    }
    let route = match facts.storage_kind {
        "local" => SourceRoute::Local,
        "agent" => SourceRoute::Agent,
        "http" => SourceRoute::Http(HttpOrigin::Http),
        "s3" => SourceRoute::Http(HttpOrigin::S3),
        "jellyfin" => SourceRoute::Jellyfin,
        "emby" => SourceRoute::Emby,
        kind => SourceRoute::Other(kind),
    };
    let kind = route.kind();
    if intent.ladder && (kind != "local" || !facts.linux) {
        return Err(Rejection::LocalHlsLadderSourceRequired);
    }
    if intent.advanced && (!matches!(kind, "local" | "http" | "agent") || !facts.linux) {
        return Err(Rejection::AdvancedLocalSourceRequired);
    }
    if intent.candidate_report && !matches!(kind, "local" | "agent" | "http") {
        return Err(Rejection::StaleCapabilityReport);
    }
    Ok(route)
}

#[derive(Debug)]
pub struct CandidateSelection {
    pub candidate: PlaybackCandidate,
    pub source_version: Option<String>,
}

pub fn playable(
    candidate: &PlaybackCandidate,
    result: &protocol::PlaybackCandidateResult,
    caps: &protocol::PlaybackCapabilities,
) -> bool {
    if candidate.video.dolby_vision.is_some() && result.dolby_vision_supported != Some(true) {
        return false;
    }
    let progressive = matches!(
        result.progressive,
        protocol::MediaTypeSupport::Maybe | protocol::MediaTypeSupport::Probably
    );
    let file = result.file_decoding.as_ref().map(|v| v.supported);
    let mse = result.mse_decoding.as_ref().map(|v| v.supported);
    // Actual passthrough configurations require the concrete decoding API. If
    // unavailable, only the fixed conservative output recipe may use MIME hints.
    let fallback = candidate.id == "transcode_720p"
        || matches!(
            candidate.id.as_str(),
            "hls_ladder_low" | "hls_ladder_medium" | "hls_ladder_high"
        );
    let file_ok = progressive && (file == Some(true) || (fallback && file.is_none()));
    let mse_ok =
        result.mse_supported == Some(true) && (mse == Some(true) || (fallback && mse.is_none()));
    if candidate.transport == "progressive" {
        file_ok
    } else {
        // The exact lower-level codec probe can succeed even when the legacy
        // High/Level-4 AVC sample failed. Never gate it on that unrelated sample.
        (caps.native_hls && file_ok) || mse_ok
    }
}

pub fn select_candidate(
    intent: CandidateIntent<'_>,
    facts: CandidateFacts,
) -> Result<CandidateSelection, Rejection> {
    let CandidateFacts {
        candidates,
        source_version,
    } = facts;
    let report = intent.report;
    let caps = intent.capabilities;
    let mut seen = std::collections::HashSet::new();
    for result in &report.results {
        if !seen.insert(&result.candidate_id)
            || !candidates.iter().any(|c| c.id == result.candidate_id)
        {
            return Err(Rejection::InvalidRequest);
        }
    }
    if intent.ladder
        && (!report.excluded_candidates.is_empty()
            || candidates.is_empty()
            || candidates.len() > 3
            || !candidates.iter().all(|candidate| {
                report
                    .results
                    .iter()
                    .find(|r| r.candidate_id == candidate.id)
                    .is_some_and(|result| playable(candidate, result, caps))
            }))
    {
        return Err(Rejection::NoCompatibleTransport);
    }
    for candidate in candidates {
        if report.excluded_candidates.contains(&candidate.id) {
            continue;
        }
        let requested = intent.requested_mode;
        if requested != "auto"
            && candidate.delivery_mode != requested
            && !(requested == "remux" && candidate.delivery_mode == "audio_transcode")
        {
            continue;
        }
        if candidate.delivery_mode != "direct"
            && candidate.delivery_mode != "transcode"
            && intent.position_ms > 0.0
        {
            continue;
        }
        if report
            .results
            .iter()
            .find(|r| r.candidate_id == candidate.id)
            .is_some_and(|r| playable(&candidate, r, caps))
        {
            return Ok(CandidateSelection {
                candidate,
                source_version,
            });
        }
    }
    Err(Rejection::NoCompatibleTransport)
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
