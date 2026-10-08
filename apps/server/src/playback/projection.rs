//! Pure track inventory and plan facts for one converged route. URLs and
//! encrypted/persisted resources remain the preparation adapter's responsibility.
//! Exact output-proof helpers remain compatibility dependencies on the existing
//! capability adapter; only its synchronous, side-effect-free functions are used.
use super::{
    facts,
    route::{Intent, RouteDecision},
    selection,
};
use crate::{Result, err, playback_capabilities};
use axum::http::StatusCode;
use protocol::{DecoderFallbackMode, MediaTrack, PlaybackSelectedOutput, SubtitleDeliveryMode};
use serde_json::Value;

pub(crate) struct TrackInventory {
    pub audio_tracks: Vec<MediaTrack>,
    /// External subtitle descriptors; the adapter supplies the existing URL.
    pub subtitle_tracks: Vec<MediaTrack>,
}

pub(crate) fn tracks(meta: &Value, audio_index: Option<u32>) -> Result<TrackInventory> {
    let streams = meta["streams"].as_array();
    let audio_tracks = streams
        .map(|rows| {
            rows.iter()
                .filter(|s| s["codec_type"] == "audio")
                .filter_map(|s| {
                    Some(protocol::MediaTrack {
                        index: facts::stream_index(s)?,
                        label: s["tags"]["title"].as_str().unwrap_or("Audio").into(),
                        language: s["tags"]["language"].as_str().unwrap_or("und").into(),
                        url: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(index) = audio_index
        && audio_tracks.iter().filter(|t| t.index == index).count() != 1
    {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_audio_track"));
    }
    let mut subtitle_tracks = streams
        .map(|rows| {
            rows.iter()
                .filter(|s| {
                    s["codec_type"] == "subtitle"
                        && matches!(
                            s["codec_name"].as_str(),
                            Some("subrip" | "webvtt" | "mov_text")
                        )
                })
                .filter_map(|s| {
                    let index = facts::stream_index(s)?;
                    Some(protocol::MediaTrack {
                        index,
                        label: s["tags"]["title"].as_str().unwrap_or("Subtitle").into(),
                        language: s["tags"]["language"].as_str().unwrap_or("und").into(),
                        url: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(files) = meta["sidecars"].as_object() {
        for (index, path) in files {
            if let Ok(index) = index.parse::<u32>() {
                subtitle_tracks.push(protocol::MediaTrack {
                    index,
                    label: path.as_str().unwrap_or("Subtitle").into(),
                    language: "und".into(),
                    url: None,
                })
            }
        }
    }
    Ok(TrackInventory {
        audio_tracks,
        subtitle_tracks,
    })
}

#[derive(Clone, Copy)]
pub(crate) struct ProjectionFacts<'a> {
    pub source: selection::SourceRoute<'a>,
    pub metadata: &'a Value,
    pub current_metadata: bool,
    pub probed: bool,
    pub selected: Option<&'a selection::CandidateSelection>,
    pub upstream_profile: bool,
    pub negotiated_info: Option<&'a Value>,
    pub upstream_base: &'a str,
    pub has_external_subtitle: bool,
    pub server_requested_audio_sample_rate_48000: bool,
}

pub(crate) struct PlanFacts {
    pub decoder_fallback_modes: Vec<DecoderFallbackMode>,
    pub selected_audio_track: Option<u32>,
    pub subtitle_mode: SubtitleDeliveryMode,
    pub selected_output: Option<PlaybackSelectedOutput>,
    pub selected_candidate_id: Option<String>,
    pub decision_reason: String,
}

pub(crate) fn plan_facts(
    input: ProjectionFacts<'_>,
    intent: Intent<'_>,
    route: &RouteDecision,
) -> Result<PlanFacts> {
    let kind = input.source.kind();
    let meta = input.metadata;
    let selected = input.selected;
    let upstream_profile = input.upstream_profile;
    let negotiated_info = input.negotiated_info;
    let current_metadata = input.current_metadata;
    let probed = input.probed;
    let body = intent;
    let mode = route.delivery().mode.as_str();
    let position_ms = route.delivery().position_ms;
    let requested_mode = intent.requested_mode;
    let hls_supported = body.capabilities.as_ref().is_none_or(|c| c.supports_hls());
    let decoder_fallback_modes = if selected.is_some()
        || upstream_profile
        || body.advanced_playback.is_some()
        || body.local_hls_ladder.is_some()
    {
        vec![]
    } else if let Some(info) = &negotiated_info {
        selection::upstream_fallbacks(info, mode, hls_supported, input.upstream_base)
    } else if matches!(kind, "local" | "http" | "agent") {
        selection::legacy_mapped_fallbacks(
            meta,
            body.audio_index,
            mode,
            position_ms,
            current_metadata && (kind != "agent" || probed),
            hls_supported,
        )
    } else {
        selection::local_fallbacks(meta, mode, position_ms, current_metadata, hls_supported)
    };
    let selected_audio_track =
        if body.advanced_playback.is_some() || route.ladder_recipe().is_some() {
            media_core::motion_video::selected_audio_index(meta, body.audio_index)
                .map_err(playback_capabilities::probe_error)?
        } else if matches!(kind, "jellyfin" | "emby") {
            negotiated_info
                .as_ref()
                .and_then(|info| facts::upstream_audio(info, body.audio_index, mode))
        } else {
            facts::mapped_audio(meta, body.audio_index, mode, current_metadata)
        };
    let subtitle_mode = if body
        .advanced_playback
        .as_ref()
        .is_some_and(|request| request.subtitle_stream_index.is_some())
    {
        // Burned pixels cannot be switched off by the browser VTT selector.
        protocol::SubtitleDeliveryMode::BurnedIn
    } else if input.has_external_subtitle {
        protocol::SubtitleDeliveryMode::ExternalVtt
    } else {
        protocol::SubtitleDeliveryMode::None
    };
    // A master has multiple configurations; a scalar selected_output would
    // misrepresent the currently decoded ABR rung. Exact recipe facts are separate.
    let selected_output = if route.ladder_recipe().is_some() {
        None
    } else if let Some(request) = &body.advanced_playback {
        selected
            .as_ref()
            .map(|selection| {
                playback_capabilities::selected_advanced_output(
                    selection,
                    meta,
                    body.audio_index,
                    body.requested_position_ms,
                    request,
                )
            })
            .transpose()?
    } else if kind == "agent" {
        selected
            .as_ref()
            .map(|selection| {
                playback_capabilities::selected_agent_output(
                    selection,
                    meta,
                    body.audio_index,
                    body.requested_position_ms,
                    current_metadata && probed,
                )
            })
            .transpose()?
            .flatten()
    } else if current_metadata && matches!(kind, "local" | "http") {
        selected
            .as_ref()
            .map(|selection| {
                playback_capabilities::selected_output(
                    selection,
                    meta,
                    body.audio_index,
                    body.requested_position_ms,
                )
            })
            .transpose()?
    } else {
        None
    };
    let decision_reason = if route.ladder_recipe().is_some() {
        "local_hls_ladder_constrained_recipe".into()
    } else if intent.advanced_playback.is_some() {
        "advanced_local_constrained_recipe".into()
    } else if input.server_requested_audio_sample_rate_48000 {
        "emby_server_requested_audio_sample_rate_48000".into()
    } else {
        selection::decision_reason(
            kind,
            requested_mode,
            mode,
            current_metadata,
            probed,
            selected.as_ref().map(|s| s.candidate.id.as_str()),
        )
    };
    Ok(PlanFacts {
        decoder_fallback_modes,
        selected_audio_track,
        subtitle_mode,
        selected_output,
        selected_candidate_id: if route.ladder_recipe().is_some() {
            None
        } else {
            selected.map(|s| s.candidate.id.clone())
        },
        decision_reason,
    })
}
