use super::{projection, route, selection};
use crate::{advanced_playback, err, local_hls_ladder, playback_capabilities, playback_plan};
use axum::http::StatusCode;
use protocol::{AdvancedPlaybackRequest, LocalHlsLadderRequest, PlaybackCapabilities};
use serde_json::{Value, json};
use uuid::Uuid;

const VERSION: &str = "stat-v1:0000000000000000000000000000000000000000000000000000000000000000";

fn source() -> Value {
    json!({"capability_source_version":VERSION,
    "format":{"format_name":"mp4","tags":{"major_brand":"isom"},"bit_rate":"1000000","start_time":"0","duration":"120"},
    "streams":[
        {"index":7,"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1","pix_fmt":"yuv420p",
         "width":1920,"height":1080,"sample_aspect_ratio":"1:1","avg_frame_rate":"25/1","r_frame_rate":"25/1",
         "disposition":{"attached_pic":0},"extradata":"\n00000000: 0164 000d ffe1 0000  ........\n"},
        {"index":0,"codec_type":"audio","codec_name":"aac","profile":"LC","channels":2,
         "sample_rate":"48000","bit_rate":"128000","extradata":"\n00000000: 1190  ..\n"}
    ]})
}
fn intent() -> route::Intent<'static> {
    route::Intent {
        requested_mode: "auto",
        requested_position_ms: 0.0,
        audio_index: None,
        capabilities: None,
        advanced_playback: None,
        local_hls_ladder: None,
        static_hls: false,
    }
}
fn facts(meta: &Value) -> route::RouteFacts<'_> {
    route::RouteFacts {
        source: selection::SourceRoute::Local,
        metadata: meta,
        current_metadata: true,
        probed: true,
        local_fact_version: Some(VERSION),
        source_version: Some(VERSION),
        selected: None,
        upstream_profile: false,
        mode: "direct",
        transport: "progressive",
        position_ms: 0.0,
        duration_ms: Some(120000.0),
    }
}
fn projection(facts: route::RouteFacts<'_>) -> projection::ProjectionFacts<'_> {
    projection::ProjectionFacts {
        source: facts.source,
        metadata: facts.metadata,
        current_metadata: facts.current_metadata,
        probed: facts.probed,
        selected: facts.selected,
        upstream_profile: facts.upstream_profile,
        negotiated_info: None,
        upstream_base: "https://media.example",
        has_external_subtitle: false,
        server_requested_audio_sample_rate_48000: false,
    }
}
fn actual(
    input: route::RouteFacts<'_>,
    intent: route::Intent<'_>,
    mut projection: projection::ProjectionFacts<'_>,
) -> crate::Result<Value> {
    let projection::TrackInventory {
        audio_tracks,
        mut subtitle_tracks,
    } = projection::tracks(input.metadata, intent.audio_index)?;
    let id = Uuid::nil();
    let t = "test-only";
    for track in &mut subtitle_tracks {
        track.url = Some(format!(
            "/media-delivery/{id}/subtitle-{}.vtt?token={t}",
            track.index
        ));
    }
    let route = route::select(input, intent)?;
    let delivery = route.delivery();
    let mut resource = json!({});
    if projection.server_requested_audio_sample_rate_48000 {
        resource["upstream_profile_route_provenance"] =
            json!({"server_requested_audio_sample_rate":48000});
    }
    resource["subtitle_files"] = input.metadata["sidecars"].clone();
    resource["subtitle_indices"] =
        json!(subtitle_tracks.iter().map(|t| t.index).collect::<Vec<_>>());
    if let Some(version) = input.selected.and_then(|s| s.source_version.as_ref()) {
        resource["source_version"] = json!(version);
    }
    if route.ladder_recipe().is_some() {
        resource["local_hls_ladder_version"] = json!(1);
        if intent.advanced_playback.is_some() {
            resource["advanced_hls_ladder_version"] = json!(1);
        }
    }
    if route.generated() {
        resource["job_id"] = json!(id);
        if intent.advanced_playback.is_some() && intent.local_hls_ladder.is_none() {
            resource["advanced_owned_session_id"] = json!(id);
        }
    }
    resource["transport"] = json!(delivery.transport);
    resource["delivery_mode"] = json!(delivery.mode);
    resource["timeline_origin_ms"] = json!(delivery.timeline_origin_ms);
    resource["plan_facts_version"] = json!(1);
    projection.has_external_subtitle = subtitle_tracks.iter().any(|t| t.url.is_some());
    let projected = projection::plan_facts(projection, intent, &route)?;
    if projected.subtitle_mode == protocol::SubtitleDeliveryMode::BurnedIn {
        subtitle_tracks.clear();
        resource["subtitle_indices"] = json!([]);
    }
    if let Some(output) = &projected.selected_output {
        resource["selected_output"] = serde_json::to_value(output).map_err(anyhow::Error::from)?;
    }
    let advanced_facts = intent
        .advanced_playback
        .map(|request| advanced_playback::facts(input.metadata, request))
        .transpose()?;
    Ok(json!({
        "route":match &route{route::RouteDecision::SourceDelivery{..}=>"source",route::RouteDecision::LegacyGeneratedHls{..}=>"legacy",route::RouteDecision::AdvancedGeneratedHls{..}=>"advanced",route::RouteDecision::LadderGeneratedHls{..}=>"ladder"},
        "mode":delivery.mode,"transport":delivery.transport,"position":delivery.position_ms,"timeline":delivery.timeline_origin_ms,
        "local_job":route.generated(),"resource":resource,"audio_tracks":audio_tracks,"subtitle_tracks":subtitle_tracks,
        "fallbacks":projected.decoder_fallback_modes,"audio":projected.selected_audio_track,"subtitle_mode":projected.subtitle_mode,
        "output":projected.selected_output,"candidate":projected.selected_candidate_id,"reason":projected.decision_reason,
        "ladder":route.ladder_recipe().zip(intent.local_hls_ladder).map(|(recipe,request)|local_hls_ladder::facts(recipe,request)),
        "advanced":advanced_facts,
    }))
}
fn outcome(result: crate::Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"ok":value}),
        Err(error) => json!({"status":error.0.as_u16(),"reason":error.1}),
    }
}
fn parity(
    facts: route::RouteFacts<'_>,
    intent: route::Intent<'_>,
    projection: projection::ProjectionFacts<'_>,
) -> Value {
    let actual = outcome(actual(facts, intent, projection));
    assert_eq!(actual, outcome(legacy_reference(facts, intent, projection)));
    actual
}

// Test-only frozen reference of the converged pure decisions at 5466561.
// This deliberately keeps the pre-extraction expressions for differential
// behavior checks; it never opens SQL, probes a source or allocates a grant.
fn legacy_reference(
    input: route::RouteFacts<'_>,
    body: route::Intent<'_>,
    projection: projection::ProjectionFacts<'_>,
) -> crate::Result<Value> {
    let kind = input.source.kind().to_owned();
    let meta = input.metadata;
    let selected = input.selected;
    let upstream_profile = input.upstream_profile.then_some(());
    let current_metadata = input.current_metadata;
    let probed = input.probed;
    let local_fact_version = input.local_fact_version.map(str::to_owned);
    let source_version = input.source_version.map(str::to_owned);
    let mut mode = input.mode;
    let mut transport = input.transport;
    let mut position_ms = input.position_ms;
    let duration = input.duration_ms;
    let mut timeline = 0.0;
    let requested_mode = body.requested_mode;
    let negotiated_info = projection.negotiated_info;
    struct Config<'a> {
        url: &'a str,
    }
    let config = Config {
        url: projection.upstream_base,
    };
    let id = Uuid::nil();
    let t = "test-only";
    let mut resource = json!({});
    if projection.server_requested_audio_sample_rate_48000 {
        resource["upstream_profile_route_provenance"] =
            json!({"server_requested_audio_sample_rate":48000});
    }
    let streams = meta["streams"].as_array();
    let audio_tracks = streams
        .map(|rows| {
            rows.iter()
                .filter(|s| s["codec_type"] == "audio")
                .filter_map(|s| {
                    Some(protocol::MediaTrack {
                        index: playback_plan::stream_index(s)?,
                        label: s["tags"]["title"].as_str().unwrap_or("Audio").into(),
                        language: s["tags"]["language"].as_str().unwrap_or("und").into(),
                        url: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(index) = body.audio_index
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
                    let index = playback_plan::stream_index(s)?;
                    Some(protocol::MediaTrack {
                        index,
                        label: s["tags"]["title"].as_str().unwrap_or("Subtitle").into(),
                        language: s["tags"]["language"].as_str().unwrap_or("und").into(),
                        url: Some(format!(
                            "/media-delivery/{id}/subtitle-{index}.vtt?token={t}"
                        )),
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
                    url: Some(format!(
                        "/media-delivery/{id}/subtitle-{index}.vtt?token={t}"
                    )),
                })
            }
        }
    }
    resource["subtitle_files"] = meta["sidecars"].clone();
    resource["subtitle_indices"] =
        json!(subtitle_tracks.iter().map(|t| t.index).collect::<Vec<_>>());
    // A progressive file exposes the original/default track to the browser.
    // Honor an explicit track selection through the local HLS mapping path.
    if body.audio_index.is_some()
        && mode == "direct"
        && matches!(kind.as_str(), "local" | "http" | "agent")
    {
        mode =
            media_core::compatible_mode(meta, true).map_err(playback_capabilities::probe_error)?;
    }
    if let Some(selection) = &selected {
        mode = &selection.candidate.delivery_mode;
        transport = &selection.candidate.transport;
        if let Some(version) = &selection.source_version {
            resource["source_version"] = json!(version);
        }
    } else if upstream_profile.is_some() {
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
        if selected_mode != mode && matches!(kind.as_str(), "jellyfin" | "emby") {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "upstream_device_profile_required",
            ));
        }
        mode = selected_mode;
        transport = selected_transport;
    }
    position_ms = protocol::bounded_position(position_ms, duration);
    let local_job = matches!(kind.as_str(), "local" | "http" | "agent") && mode != "direct";
    if body.static_hls && (local_job || body.audio_index.is_some()) {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "static_hls_native_transport_unavailable",
        ));
    }
    let ladder_recipe = if body.local_hls_ladder.is_some() {
        local_hls_ladder::require_local(&kind, local_fact_version.as_deref())?;
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
    if ladder_recipe.is_some() {
        resource["local_hls_ladder_version"] = json!(1);
        if body.advanced_playback.is_some() {
            resource["advanced_hls_ladder_version"] = json!(1);
        }
    } else if let Some(request) = &body.advanced_playback {
        advanced_playback::require_local(
            &kind,
            local_fact_version.as_deref().or(source_version.as_deref()),
        )?;
        advanced_playback::analyze(meta, body.audio_index, position_ms, request)?;
        if !local_job || mode != "transcode" || selected.is_none() {
            return Err(err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_video_or_hdr",
            ));
        }
    } else {
        playback_plan::require_legacy_job_mapping(
            &kind,
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
        timeline = playback_plan::local_timeline_origin(position_ms, mode)
            .ok_or_else(|| err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_timeline"))?;
        transport = "hls";
        resource["job_id"] = json!(id);
        if body.advanced_playback.is_some() && body.local_hls_ladder.is_none() {
            resource["advanced_owned_session_id"] = json!(id);
        }
    }
    resource["transport"] = json!(transport);
    resource["delivery_mode"] = json!(mode);
    resource["timeline_origin_ms"] = json!(timeline);
    resource["plan_facts_version"] = json!(1);
    let hls_supported = body.capabilities.as_ref().is_none_or(|c| c.supports_hls());
    let decoder_fallback_modes = if selected.is_some()
        || upstream_profile.is_some()
        || body.advanced_playback.is_some()
        || body.local_hls_ladder.is_some()
    {
        vec![]
    } else if let Some(info) = &negotiated_info {
        playback_plan::upstream_fallbacks(info, mode, hls_supported, config.url)
    } else if matches!(kind.as_str(), "local" | "http" | "agent") {
        playback_plan::legacy_mapped_fallbacks(
            meta,
            body.audio_index,
            mode,
            position_ms,
            current_metadata && (kind != "agent" || probed),
            hls_supported,
        )
    } else {
        playback_plan::local_fallbacks(meta, mode, position_ms, current_metadata, hls_supported)
    };
    let selected_audio_track = if body.advanced_playback.is_some() || ladder_recipe.is_some() {
        media_core::motion_video::selected_audio_index(meta, body.audio_index)
            .map_err(playback_capabilities::probe_error)?
    } else if matches!(kind.as_str(), "jellyfin" | "emby") {
        negotiated_info
            .as_ref()
            .and_then(|info| playback_plan::upstream_audio(info, body.audio_index, mode))
    } else {
        playback_plan::mapped_audio(meta, body.audio_index, mode, current_metadata)
    };
    let subtitle_mode = if body
        .advanced_playback
        .as_ref()
        .is_some_and(|request| request.subtitle_stream_index.is_some())
    {
        // Burned pixels cannot be switched off by the browser VTT selector.
        subtitle_tracks.clear();
        resource["subtitle_indices"] = json!([]);
        protocol::SubtitleDeliveryMode::BurnedIn
    } else if subtitle_tracks.iter().any(|track| track.url.is_some()) {
        protocol::SubtitleDeliveryMode::ExternalVtt
    } else {
        protocol::SubtitleDeliveryMode::None
    };
    // A master has multiple configurations; a scalar selected_output would
    // misrepresent the currently decoded ABR rung. Exact recipe facts are separate.
    let selected_output = if ladder_recipe.is_some() {
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
    } else if current_metadata && matches!(kind.as_str(), "local" | "http") {
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
    if let Some(facts) = &selected_output {
        resource["selected_output"] = serde_json::to_value(facts).map_err(anyhow::Error::from)?;
    }
    let decision_reason = if ladder_recipe.is_some() {
        "local_hls_ladder_constrained_recipe".into()
    } else if body.advanced_playback.is_some() {
        "advanced_local_constrained_recipe".into()
    } else if resource["upstream_profile_route_provenance"]["server_requested_audio_sample_rate"]
        == 48_000
    {
        "emby_server_requested_audio_sample_rate_48000".into()
    } else {
        playback_plan::decision_reason(
            &kind,
            requested_mode,
            mode,
            current_metadata,
            probed,
            selected.as_ref().map(|s| s.candidate.id.as_str()),
        )
    };
    let advanced_facts = body
        .advanced_playback
        .map(|request| advanced_playback::facts(meta, request))
        .transpose()?;
    Ok(json!({
        "route": if ladder_recipe.is_some() { "ladder" } else if local_job && body.advanced_playback.is_some() { "advanced" } else if local_job { "legacy" } else { "source" },
        "mode":mode, "transport":transport, "position":position_ms, "timeline":timeline,
        "local_job":local_job, "resource":resource, "audio_tracks":audio_tracks, "subtitle_tracks":subtitle_tracks,
        "fallbacks":decoder_fallback_modes, "audio":selected_audio_track, "subtitle_mode":subtitle_mode,
        "output":selected_output, "candidate":if ladder_recipe.is_some() { None } else { selected.map(|s|s.candidate.id.clone()) },
        "reason":decision_reason,
        "ladder":ladder_recipe.as_ref().zip(body.local_hls_ladder.as_ref()).map(|(recipe,request)|local_hls_ladder::facts(recipe,request)),
        "advanced":advanced_facts,
    }))
}

#[test]
fn legacy_routes_and_projection_match_the_frozen_behavior_matrix() {
    let meta = source();
    let caps = [
        PlaybackCapabilities {
            progressive_h264_aac: true,
            native_hls: true,
            mse_h264_aac: false,
            report: None,
        },
        PlaybackCapabilities {
            progressive_h264_aac: true,
            native_hls: false,
            mse_h264_aac: false,
            report: None,
        },
        PlaybackCapabilities {
            progressive_h264_aac: false,
            native_hls: true,
            mse_h264_aac: false,
            report: None,
        },
        PlaybackCapabilities {
            progressive_h264_aac: false,
            native_hls: false,
            mse_h264_aac: false,
            report: None,
        },
    ];
    let mut checked = 0;
    for source in [
        selection::SourceRoute::Local,
        selection::SourceRoute::Agent,
        selection::SourceRoute::Http(selection::HttpOrigin::Http),
        selection::SourceRoute::Http(selection::HttpOrigin::S3),
        selection::SourceRoute::Jellyfin,
        selection::SourceRoute::Emby,
        selection::SourceRoute::Other("legacy"),
    ] {
        for mode in ["direct", "remux", "transcode"] {
            for capability in [
                None,
                Some(&caps[0]),
                Some(&caps[1]),
                Some(&caps[2]),
                Some(&caps[3]),
            ] {
                for position in [0.0, 1000.0, 120100.0] {
                    for (current_metadata, probed) in
                        [(false, false), (false, true), (true, false), (true, true)]
                    {
                        for audio in [None, Some(0)] {
                            let facts = route::RouteFacts {
                                source,
                                mode,
                                position_ms: position,
                                current_metadata,
                                probed,
                                ..facts(&meta)
                            };
                            let intent = route::Intent {
                                capabilities: capability,
                                audio_index: audio,
                                requested_position_ms: position,
                                ..intent()
                            };
                            parity(facts, intent, projection(facts));
                            checked += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(checked, 2520);
}

#[test]
fn actual_candidate_precedes_upstream_and_legacy_hints_without_new_codec_gates() {
    let meta = source();
    let caps = PlaybackCapabilities {
        progressive_h264_aac: false,
        native_hls: false,
        mse_h264_aac: false,
        report: None,
    };
    let mut checked = 0;
    for candidate in media_core::capabilities::candidates(&meta, None, 0.0).unwrap() {
        let selection = selection::CandidateSelection {
            candidate,
            source_version: Some(VERSION.into()),
        };
        for source in [
            selection::SourceRoute::Local,
            selection::SourceRoute::Agent,
            selection::SourceRoute::Http(selection::HttpOrigin::Http),
            selection::SourceRoute::Jellyfin,
        ] {
            for upstream_profile in [false, true] {
                for position in [0.0, 5000.0] {
                    let facts = route::RouteFacts {
                        source,
                        selected: Some(&selection),
                        upstream_profile,
                        position_ms: position,
                        ..facts(&meta)
                    };
                    let intent = route::Intent {
                        capabilities: Some(&caps),
                        requested_position_ms: position,
                        ..intent()
                    };
                    let actual = parity(facts, intent, projection(facts));
                    if position == 0.0 {
                        assert_eq!(actual["ok"]["mode"], selection.candidate.delivery_mode);
                        assert!(actual["ok"]["fallbacks"].as_array().unwrap().is_empty());
                    }
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 64);
}

#[test]
fn upstream_profile_and_provider_transport_keep_their_original_precedence() {
    let meta = source();
    let caps = PlaybackCapabilities {
        progressive_h264_aac: false,
        native_hls: true,
        mse_h264_aac: false,
        report: None,
    };
    for source in [
        selection::SourceRoute::Jellyfin,
        selection::SourceRoute::Emby,
    ] {
        let f = route::RouteFacts {
            source,
            ..facts(&meta)
        };
        let i = route::Intent {
            capabilities: Some(&caps),
            ..intent()
        };
        assert_eq!(
            parity(f, i, projection(f)),
            json!({"status":422,"reason":"upstream_device_profile_required"})
        );
        let f = route::RouteFacts {
            upstream_profile: true,
            ..f
        };
        let result = parity(f, i, projection(f));
        assert_eq!(result["ok"]["route"], "source");
        assert_eq!(result["ok"]["mode"], "transcode");
        assert_eq!(result["ok"]["transport"], "hls");
        assert_eq!(result["ok"]["local_job"], false);
        assert_eq!(result["ok"]["fallbacks"], json!([]));
    }
}

#[test]
fn legacy_remux_promotion_and_concrete_copy_rejection_remain_distinct() {
    let meta = source();
    let f = route::RouteFacts {
        mode: "remux",
        position_ms: 5432.0,
        ..facts(&meta)
    };
    let i = route::Intent {
        requested_mode: "remux",
        requested_position_ms: 5432.0,
        ..intent()
    };
    let output = parity(f, i, projection(f));
    assert_eq!(output["ok"]["mode"], "transcode");
    assert_eq!(output["ok"]["timeline"], 5432.0);
    for candidate in media_core::capabilities::candidates(&meta, None, 0.0)
        .unwrap()
        .into_iter()
        .filter(|c| matches!(c.delivery_mode.as_str(), "remux" | "audio_transcode"))
    {
        let selected = selection::CandidateSelection {
            candidate,
            source_version: Some(VERSION.into()),
        };
        let f = route::RouteFacts {
            selected: Some(&selected),
            ..f
        };
        assert_eq!(
            parity(f, i, projection(f)),
            json!({"status":422,"reason":"unsupported_timeline"})
        );
    }
    let mut rotated = meta.clone();
    rotated["streams"][0]["side_data_list"] =
        json!([{"side_data_type":"Display Matrix","rotation":90}]);
    let f = route::RouteFacts {
        metadata: &rotated,
        position_ms: 0.0,
        ..f
    };
    let output = parity(f, intent(), projection(f));
    assert_eq!(output["ok"]["mode"], "transcode");
}

#[test]
fn a_new_probe_duration_rebounds_delivery_but_not_the_requested_candidate_position() {
    let meta = source();
    let f = route::RouteFacts {
        mode: "transcode",
        position_ms: 9000.0,
        duration_ms: Some(4000.0),
        ..facts(&meta)
    };
    let i = route::Intent {
        requested_position_ms: 12000.0,
        ..intent()
    };
    let output = parity(f, i, projection(f));
    assert_eq!(output["ok"]["position"], 4000.0);
    assert_eq!(output["ok"]["timeline"], 4000.0);
    let selected = selection::CandidateSelection {
        candidate: media_core::capabilities::candidates(&meta, None, 0.0)
            .unwrap()
            .into_iter()
            .find(|c| c.id == "remux")
            .unwrap(),
        source_version: Some(VERSION.into()),
    };
    // Rebounding delivery to zero must not turn the original positive-position
    // candidate proof into a zero-position proof.
    let f = route::RouteFacts {
        selected: Some(&selected),
        duration_ms: Some(0.0),
        ..f
    };
    assert_eq!(
        parity(f, i, projection(f)),
        json!({"status":409,"reason":"source_changed"})
    );
}

#[test]
fn static_parent_rejection_precedes_recipe_or_version_errors() {
    let meta = json!({"streams":[]});
    let advanced = AdvancedPlaybackRequest {
        schema_version: 1,
        tone_map_hdr: true,
        subtitle_stream_index: None,
    };
    let ladder = LocalHlsLadderRequest { schema_version: 1 };
    for (advanced_playback, local_hls_ladder) in [
        (None, None),
        (Some(&advanced), None),
        (Some(&advanced), Some(&ladder)),
    ] {
        let f = route::RouteFacts {
            mode: "transcode",
            local_fact_version: None,
            ..facts(&meta)
        };
        let i = route::Intent {
            static_hls: true,
            advanced_playback,
            local_hls_ladder,
            ..intent()
        };
        assert_eq!(
            parity(f, i, projection(f)),
            json!({"status":422,"reason":"static_hls_native_transport_unavailable"})
        );
    }
}

fn subtitle_source() -> Value {
    let mut meta = source();
    meta["streams"].as_array_mut().unwrap().push(json!({"index":10,"codec_type":"subtitle","codec_name":"ass","tags":{"title":"Styled","language":"eng"}}));
    meta["streams"].as_array_mut().unwrap().push(json!({"index":11,"codec_type":"subtitle","codec_name":"subrip","tags":{"title":"Captions","language":"eng"}}));
    meta
}

#[test]
fn advanced_route_preserves_source_version_analysis_and_selected_requirements() {
    let meta = subtitle_source();
    let advanced = AdvancedPlaybackRequest {
        schema_version: 1,
        tone_map_hdr: false,
        subtitle_stream_index: Some(10),
    };
    let candidate = advanced_playback::analyze(&meta, None, 0.0, &advanced)
        .unwrap()
        .candidates
        .remove(0);
    let selected = selection::CandidateSelection {
        candidate,
        source_version: Some(VERSION.into()),
    };
    let i = route::Intent {
        advanced_playback: Some(&advanced),
        ..intent()
    };
    for source in [
        selection::SourceRoute::Local,
        selection::SourceRoute::Agent,
        selection::SourceRoute::Http(selection::HttpOrigin::Http),
    ] {
        let f = route::RouteFacts {
            source,
            mode: "transcode",
            selected: Some(&selected),
            ..facts(&meta)
        };
        let value = parity(f, i, projection(f));
        assert_eq!(value["ok"]["route"], "advanced");
        assert_eq!(value["ok"]["subtitle_tracks"], json!([]));
        assert_eq!(value["ok"]["subtitle_mode"], "burned_in");
        assert_eq!(value["ok"]["fallbacks"], json!([]));
        assert_eq!(value["ok"]["resource"]["subtitle_indices"], json!([]));
        assert_eq!(value["ok"]["reason"], "advanced_local_constrained_recipe");
        let missing = route::RouteFacts {
            selected: None,
            ..f
        };
        assert_eq!(
            parity(missing, i, projection(missing)),
            json!({"status":422,"reason":"unsupported_video_or_hdr"})
        );
        let unversioned = route::RouteFacts {
            source_version: None,
            local_fact_version: None,
            ..f
        };
        let value = parity(unversioned, i, projection(unversioned));
        if matches!(source, selection::SourceRoute::Http(_)) {
            assert!(value.get("ok").is_some());
        } else {
            assert_eq!(
                value,
                json!({"status":409,"reason":"source_version_required"})
            );
        }
    }
}

#[test]
fn advanced_ladder_wins_over_scalar_advanced_output_and_keeps_its_recipe() {
    let meta = subtitle_source();
    let advanced = AdvancedPlaybackRequest {
        schema_version: 1,
        tone_map_hdr: false,
        subtitle_stream_index: Some(10),
    };
    let ladder = LocalHlsLadderRequest { schema_version: 1 };
    let selected = selection::CandidateSelection {
        candidate: local_hls_ladder::analyze_with_advanced(&meta, None, 0.0, &advanced)
            .unwrap()
            .candidates
            .remove(0),
        source_version: Some(VERSION.into()),
    };
    let f = route::RouteFacts {
        selected: Some(&selected),
        mode: "transcode",
        ..facts(&meta)
    };
    let i = route::Intent {
        advanced_playback: Some(&advanced),
        local_hls_ladder: Some(&ladder),
        ..intent()
    };
    let output = parity(f, i, projection(f));
    assert_eq!(output["ok"]["route"], "ladder");
    assert_eq!(output["ok"]["candidate"], Value::Null);
    assert_eq!(output["ok"]["output"], Value::Null);
    assert_eq!(output["ok"]["subtitle_tracks"], json!([]));
    assert_eq!(output["ok"]["resource"]["advanced_hls_ladder_version"], 1);
    assert_eq!(
        output["ok"]["resource"].get("advanced_owned_session_id"),
        None
    );
    assert_eq!(
        output["ok"]["reason"],
        "local_hls_ladder_constrained_recipe"
    );
    assert_eq!(
        output["ok"]["ladder"]["renditions"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn ladder_source_version_selection_and_recipe_rejections_keep_their_order() {
    let meta = source();
    let ladder = LocalHlsLadderRequest { schema_version: 1 };
    let i = route::Intent {
        local_hls_ladder: Some(&ladder),
        ..intent()
    };
    let f = route::RouteFacts {
        mode: "transcode",
        ..facts(&meta)
    };
    assert_eq!(
        parity(f, i, projection(f)),
        json!({"status":422,"reason":"local_hls_ladder_source_unsupported"})
    );
    let f = route::RouteFacts {
        local_fact_version: None,
        ..f
    };
    assert_eq!(
        parity(f, i, projection(f)),
        json!({"status":409,"reason":"source_version_required"})
    );
    let f = route::RouteFacts {
        source: selection::SourceRoute::Http(selection::HttpOrigin::Http),
        ..f
    };
    assert_eq!(
        parity(f, i, projection(f)),
        json!({"status":422,"reason":"local_hls_ladder_source_required"})
    );
    let selected = selection::CandidateSelection {
        candidate: local_hls_ladder::analyze(&meta, None, 0.0)
            .unwrap()
            .candidates
            .remove(0),
        source_version: Some(VERSION.into()),
    };
    let f = route::RouteFacts {
        selected: Some(&selected),
        mode: "transcode",
        ..facts(&meta)
    };
    assert_eq!(parity(f, i, projection(f))["ok"]["route"], "ladder");
    let mut no_duration = meta.clone();
    no_duration["format"]["duration"] = Value::Null;
    let f = route::RouteFacts {
        metadata: &no_duration,
        duration_ms: None,
        ..f
    };
    // Duration remains a publication/job-spec check. Extraction must not move
    // that existing failure in front of the publication transaction's guards.
    assert!(parity(f, i, projection(f)).get("ok").is_some());
    let mut invalid_recipe = meta.clone();
    invalid_recipe["streams"][0]["sample_aspect_ratio"] = json!("2:1");
    let f = route::RouteFacts {
        metadata: &invalid_recipe,
        ..f
    };
    assert_eq!(
        parity(f, i, projection(f)),
        json!({"status":422,"reason":"local_hls_ladder_source_unsupported"})
    );
}

#[test]
fn track_inventory_preserves_zero_duplicate_rejection_and_sidecar_order() {
    let mut meta = subtitle_source();
    meta["sidecars"] = json!({"20":"Twenty","12":"Twelve","bad":"ignored","0":null});
    let f = facts(&meta);
    let i = route::Intent {
        audio_index: Some(0),
        ..intent()
    };
    let output = parity(f, i, projection(f));
    assert_eq!(output["ok"]["audio"], 0);
    let rows = output["ok"]["subtitle_tracks"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["index"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [11, 0, 12, 20]
    );
    assert_eq!(rows[1]["label"], "Subtitle");
    assert_eq!(
        rows[0]["url"],
        format!(
            "/media-delivery/{}/subtitle-11.vtt?token=test-only",
            Uuid::nil()
        )
    );
    let duplicate = meta["streams"][1].clone();
    meta["streams"].as_array_mut().unwrap().push(duplicate);
    let f = route::RouteFacts {
        mode: "transcode",
        local_fact_version: None,
        ..facts(&meta)
    };
    let advanced = AdvancedPlaybackRequest {
        schema_version: 9,
        tone_map_hdr: false,
        subtitle_stream_index: None,
    };
    let i = route::Intent {
        audio_index: Some(0),
        advanced_playback: Some(&advanced),
        static_hls: true,
        ..intent()
    };
    assert_eq!(
        parity(f, i, projection(f)),
        json!({"status":400,"reason":"invalid_audio_track"})
    );
}

#[test]
fn agent_output_and_fallback_facts_require_the_original_freshness_evidence() {
    let meta = source();
    let selected = selection::CandidateSelection {
        candidate: media_core::capabilities::candidates(&meta, None, 0.0)
            .unwrap()
            .remove(0),
        source_version: Some(VERSION.into()),
    };
    for (current_metadata, probed) in [(false, false), (false, true), (true, false), (true, true)] {
        let f = route::RouteFacts {
            source: selection::SourceRoute::Agent,
            current_metadata,
            probed,
            selected: Some(&selected),
            ..facts(&meta)
        };
        let result = parity(f, intent(), projection(f));
        assert_eq!(
            result["ok"]["output"].is_null(),
            !(current_metadata && probed)
        );
        let f = route::RouteFacts {
            selected: None,
            ..f
        };
        let result = parity(f, intent(), projection(f));
        assert_eq!(
            result["ok"]["fallbacks"].as_array().unwrap().is_empty(),
            !(current_metadata && probed)
        );
    }
    let mut changed = meta;
    changed["capability_source_version"] = json!("different");
    let f = route::RouteFacts {
        source: selection::SourceRoute::Agent,
        selected: Some(&selected),
        ..facts(&changed)
    };
    assert_eq!(
        parity(f, intent(), projection(f)),
        json!({"status":409,"reason":"source_changed"})
    );
}

#[test]
fn output_basis_and_reason_projection_preserve_per_track_and_profile_precedence() {
    let meta = source();
    for candidate in media_core::capabilities::candidates(&meta, None, 0.0).unwrap() {
        let selected = selection::CandidateSelection {
            candidate,
            source_version: Some(VERSION.into()),
        };
        let f = route::RouteFacts {
            selected: Some(&selected),
            ..facts(&meta)
        };
        let result = parity(f, intent(), projection(f));
        assert_eq!(
            result["ok"]["output"]["video_basis"],
            if selected.candidate.delivery_mode == "transcode" {
                "constrained_encoder_recipe"
            } else {
                "source_probe"
            }
        );
        assert_eq!(
            result["ok"]["output"]["audio_basis"],
            if matches!(
                selected.candidate.delivery_mode.as_str(),
                "transcode" | "audio_transcode"
            ) {
                "constrained_encoder_recipe"
            } else {
                "source_probe"
            }
        );
        let p = projection::ProjectionFacts {
            server_requested_audio_sample_rate_48000: true,
            ..projection(f)
        };
        assert_eq!(
            parity(f, intent(), p)["ok"]["reason"],
            "emby_server_requested_audio_sample_rate_48000"
        );
    }
    let info = json!({"MediaSources":[{"Id":"source","DefaultAudioStreamIndex":0,"MediaStreams":[{"Type":"Audio","Index":0}],"SupportsTranscoding":true,"TranscodingUrl":"/master.m3u8"}]});
    let f = route::RouteFacts {
        source: selection::SourceRoute::Emby,
        ..facts(&meta)
    };
    let p = projection::ProjectionFacts {
        negotiated_info: Some(&info),
        ..projection(f)
    };
    let result = parity(f, intent(), p);
    assert_eq!(result["ok"]["fallbacks"], json!(["transcode"]));
    assert_eq!(result["ok"]["audio"], 0);
}
