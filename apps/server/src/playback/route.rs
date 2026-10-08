//! Converged playback route choices from already obtained facts. No I/O,
//! authorization, resource ownership or publication occurs in this module.
//! The narrow synchronous recipe/mapping helpers are still housed in existing
//! adapters. Those compatibility dependencies do not include their I/O paths.
use super::{
    facts,
    selection::{CandidateSelection, SourceRoute},
};
use crate::{
    Result, advanced_playback, err, local_hls_ladder, playback_capabilities, playback_plan,
};
use axum::http::StatusCode;
use media_core::hls_ladder::LadderRecipe;
use protocol::{AdvancedPlaybackRequest, LocalHlsLadderRequest, PlaybackCapabilities};
use serde_json::Value;

#[derive(Clone, Copy)]
pub(crate) struct Intent<'a> {
    pub requested_mode: &'a str,
    pub requested_position_ms: f64,
    pub audio_index: Option<u32>,
    pub capabilities: Option<&'a PlaybackCapabilities>,
    pub advanced_playback: Option<&'a AdvancedPlaybackRequest>,
    pub local_hls_ladder: Option<&'a LocalHlsLadderRequest>,
    pub static_hls: bool,
}

#[derive(Clone, Copy)]
pub(crate) struct RouteFacts<'a> {
    pub source: SourceRoute<'a>,
    pub metadata: &'a Value,
    pub current_metadata: bool,
    pub probed: bool,
    pub local_fact_version: Option<&'a str>,
    pub source_version: Option<&'a str>,
    pub selected: Option<&'a CandidateSelection>,
    /// Only the outcome of the existing upstream guarded selection. It is not
    /// reusable authorization and never replaces publication's final checks.
    pub upstream_profile: bool,
    pub mode: &'a str,
    pub transport: &'a str,
    pub position_ms: f64,
    pub duration_ms: Option<f64>,
}

#[derive(Debug)]
pub(crate) struct DeliveryFacts {
    pub mode: String,
    pub transport: String,
    pub position_ms: f64,
    pub timeline_origin_ms: f64,
}

/// Mutually exclusive preparation outcomes. These classify only this route,
/// not grants, process disposal or authority for a later database transaction.
#[derive(Debug)]
pub(crate) enum RouteDecision {
    SourceDelivery {
        delivery: DeliveryFacts,
    },
    LegacyGeneratedHls {
        delivery: DeliveryFacts,
    },
    AdvancedGeneratedHls {
        delivery: DeliveryFacts,
    },
    LadderGeneratedHls {
        delivery: DeliveryFacts,
        recipe: Box<LadderRecipe>,
    },
}

impl RouteDecision {
    pub fn delivery(&self) -> &DeliveryFacts {
        match self {
            Self::SourceDelivery { delivery }
            | Self::LegacyGeneratedHls { delivery }
            | Self::AdvancedGeneratedHls { delivery }
            | Self::LadderGeneratedHls { delivery, .. } => delivery,
        }
    }
    pub fn generated(&self) -> bool {
        !matches!(self, Self::SourceDelivery { .. })
    }
    pub fn ladder_recipe(&self) -> Option<&LadderRecipe> {
        match self {
            Self::LadderGeneratedHls { recipe, .. } => Some(recipe.as_ref()),
            _ => None,
        }
    }
}

pub(crate) fn select(facts: RouteFacts<'_>, intent: Intent<'_>) -> Result<RouteDecision> {
    let kind = facts.source.kind();
    let meta = facts.metadata;
    let current_metadata = facts.current_metadata;
    let probed = facts.probed;
    let local_fact_version = facts.local_fact_version;
    let source_version = facts.source_version;
    let selected = facts.selected;
    let upstream_profile = facts.upstream_profile;
    let body = intent;
    let mut mode = facts.mode;
    let mut transport = facts.transport;
    let mut position_ms = facts.position_ms;
    let duration = facts.duration_ms;
    let mut timeline = 0.0;
    // A progressive file exposes the original/default track to the browser.
    // Honor an explicit track selection through the local HLS mapping path.
    if body.audio_index.is_some() && mode == "direct" && matches!(kind, "local" | "http" | "agent")
    {
        mode =
            media_core::compatible_mode(meta, true).map_err(playback_capabilities::probe_error)?;
    }
    if let Some(selection) = &selected {
        mode = &selection.candidate.delivery_mode;
        transport = &selection.candidate.transport;
    } else if upstream_profile {
        mode = "transcode";
        transport = "hls";
    } else if let Some(caps) = &body.capabilities {
        let (selected_mode, selected_transport) =
            caps.negotiate(mode, transport).ok_or_else(|| {
                err(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "device_has_no_compatible_playback_transport",
                )
            })?;
        if selected_mode != mode && matches!(kind, "jellyfin" | "emby") {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "upstream_device_profile_required",
            ));
        }
        mode = selected_mode;
        transport = selected_transport;
    }
    position_ms = protocol::bounded_position(position_ms, duration);
    let local_job = matches!(kind, "local" | "http" | "agent") && mode != "direct";
    if intent.static_hls && (local_job || body.audio_index.is_some()) {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "static_hls_native_transport_unavailable",
        ));
    }
    let ladder_recipe = if body.local_hls_ladder.is_some() {
        local_hls_ladder::require_local(kind, local_fact_version)?;
        if !local_job || mode != "transcode" || selected.is_none() {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "local_hls_ladder_source_unsupported",
            ));
        }
        Some(if let Some(request) = &body.advanced_playback {
            local_hls_ladder::recipe_with_advanced(meta, body.audio_index, position_ms, request)?
        } else {
            local_hls_ladder::recipe(meta, body.audio_index, position_ms)?
        })
    } else {
        None
    };
    if let Some(request) = body.advanced_playback.filter(|_| ladder_recipe.is_none()) {
        advanced_playback::require_local(kind, local_fact_version.or(source_version))?;
        advanced_playback::analyze(meta, body.audio_index, position_ms, request)?;
        if !local_job || mode != "transcode" || selected.is_none() {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_video_or_hdr",
            ));
        }
    } else if ladder_recipe.is_none() {
        playback_plan::require_legacy_job_mapping(
            kind,
            local_job,
            meta,
            body.audio_index,
            current_metadata && probed && (kind != "local" || local_fact_version.is_some()),
        )?;
    }
    if local_job {
        if selected.is_none()
            && mode == "remux"
            && (position_ms > 0.0 || media_core::hls_needs_video_transform(meta))
        {
            mode = "transcode";
        }
        // A concrete remux was probed as stream-copy, so it must not silently
        // become the nonzero exact-decode recipe in hls_args. No measured
        // keyframe origin exists for that route; request a new compatible plan.
        timeline = facts::local_timeline_origin(position_ms, mode)
            .ok_or_else(|| err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_timeline"))?;
        transport = "hls";
    }
    let delivery = DeliveryFacts {
        mode: mode.into(),
        transport: transport.into(),
        position_ms,
        timeline_origin_ms: timeline,
    };
    Ok(if let Some(recipe) = ladder_recipe {
        RouteDecision::LadderGeneratedHls {
            delivery,
            recipe: Box::new(recipe),
        }
    } else if local_job && body.advanced_playback.is_some() {
        RouteDecision::AdvancedGeneratedHls { delivery }
    } else if local_job {
        RouteDecision::LegacyGeneratedHls { delivery }
    } else {
        RouteDecision::SourceDelivery { delivery }
    })
}
