//! Pure playback regression tests. Importing only these production rule modules
//! requires no App, database, runtime, network client, owner registry or grant.
#[path = "../src/playback/facts.rs"]
mod facts;
#[path = "../src/playback/selection.rs"]
mod selection;

use facts::{CandidateBinding, CandidateFacts, CandidateScope, SourceFacts};
use protocol::{
    AdvancedPlaybackRequest, DecoderFallbackMode, LocalHlsLadderRequest, PlaybackCandidate,
    PlaybackCandidateReport, PlaybackCandidateResult, PlaybackCapabilities,
};
use selection::{CandidateIntent, HttpOrigin, Rejection, SourceIntent, SourceRoute};
use serde_json::{Value, json};
use uuid::Uuid;

fn source() -> Value {
    json!({
        "format": {"format_name":"mov,mp4", "tags":{"major_brand":"isom"},
            "bit_rate":"1000000", "start_time":"0", "duration":"120"},
        "streams": [
            {"index":7, "codec_type":"video", "codec_name":"h264", "codec_tag_string":"avc1",
                "pix_fmt":"yuv420p", "width":1920, "height":1080, "sample_aspect_ratio":"1:1",
                "disposition":{"attached_pic":0}, "avg_frame_rate":"25/1", "r_frame_rate":"25/1",
                "extradata":"\n00000000: 0164 000d ffe1 0000  ........\n"},
            {"index":0, "codec_type":"audio", "codec_name":"aac", "profile":"LC",
                "channels":2, "sample_rate":"48000", "bit_rate":"128000",
                "extradata":"\n00000000: 1190  ..\n"}
        ]
    })
}

fn candidates() -> Vec<PlaybackCandidate> {
    media_core::capabilities::candidates(&source(), None, 0.0).unwrap()
}

fn capabilities(native_hls: bool) -> PlaybackCapabilities {
    // Exact candidate probes must not depend on the legacy AVC sample gate.
    PlaybackCapabilities {
        progressive_h264_aac: false,
        native_hls,
        mse_h264_aac: false,
        report: None,
    }
}

fn report(candidates: &[PlaybackCandidate]) -> PlaybackCandidateReport {
    serde_json::from_value(json!({
        "binding":"already-decoded-by-adapter",
        "results": candidates.iter().map(|candidate| json!({
            "candidate_id":candidate.id, "progressive":"probably", "mse_supported":true,
            "file_decoding":{"supported":true,"smooth":true,"power_efficient":false},
            "mse_decoding":{"supported":true,"smooth":true,"power_efficient":false}
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

fn choose(
    candidates: Vec<PlaybackCandidate>,
    report: &PlaybackCandidateReport,
    caps: &PlaybackCapabilities,
    mode: &str,
    position_ms: f64,
    ladder: bool,
) -> Result<selection::CandidateSelection, Rejection> {
    selection::select_candidate(
        CandidateIntent {
            requested_mode: mode,
            position_ms,
            ladder,
            report,
            capabilities: caps,
        },
        CandidateFacts {
            candidates,
            source_version: Some("stat-v1:current".into()),
        },
    )
}

fn binding() -> CandidateBinding {
    CandidateBinding {
        purpose: "actual_media_capabilities_v1".into(),
        user: Uuid::from_u128(1),
        room: Uuid::from_u128(2),
        generation: 3,
        lifecycle_epoch: 4,
        media: Uuid::from_u128(5),
        source_version: "source-version".into(),
        audio_index: Some(0),
        expires: 30,
        candidates: candidates(),
        advanced_playback: None,
        local_hls_ladder: None,
        advanced_assets_sha256: None,
    }
}

fn scope(binding: &CandidateBinding) -> CandidateScope<'_> {
    CandidateScope {
        user: binding.user,
        room: binding.room,
        generation: binding.generation,
        lifecycle_epoch: binding.lifecycle_epoch,
        media: binding.media,
        audio_index: binding.audio_index,
        advanced_playback: binding.advanced_playback.as_ref(),
        local_hls_ladder: binding.local_hls_ladder.as_ref(),
    }
}

#[test]
fn decoded_binding_preserves_legacy_wire_shape_and_optional_fields() {
    let binding = binding();
    let encoded = serde_json::to_value(&binding).unwrap();
    assert_eq!(
        encoded,
        json!({
            "purpose":"actual_media_capabilities_v1", "user":Uuid::from_u128(1),
            "room":Uuid::from_u128(2), "generation":3, "lifecycle_epoch":4,
            "media":Uuid::from_u128(5), "source_version":"source-version",
            "audio_index":0, "expires":30, "candidates":binding.candidates,
        })
    );
    let decoded: CandidateBinding = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), encoded);
    // The existing payload was not deny_unknown_fields; don't silently tighten it.
    let mut extended = encoded.clone();
    extended["unknown_historical_field"] = json!(1);
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<CandidateBinding>(extended).unwrap())
            .unwrap(),
        encoded
    );
}

#[test]
fn binding_match_is_point_in_time_and_checks_every_original_scope_field() {
    let mut binding = binding();
    assert!(binding.matches(scope(&binding), 30));
    assert!(!binding.matches(scope(&binding), 31));
    let original = scope(&binding);
    for changed in [
        CandidateScope {
            user: Uuid::nil(),
            ..original
        },
        CandidateScope {
            room: Uuid::nil(),
            ..original
        },
        CandidateScope {
            generation: 9,
            ..original
        },
        CandidateScope {
            lifecycle_epoch: 9,
            ..original
        },
        CandidateScope {
            media: Uuid::nil(),
            ..original
        },
        CandidateScope {
            audio_index: None,
            ..original
        },
        CandidateScope {
            audio_index: Some(1),
            ..original
        },
    ] {
        assert!(!binding.matches(changed, 30));
    }
    binding.purpose = "different-purpose".into();
    assert!(!binding.matches(scope(&binding), 30));
}

#[test]
fn advanced_and_ladder_intent_are_exact_and_zero_audio_is_not_missing() {
    let mut binding = binding();
    binding.advanced_playback = Some(AdvancedPlaybackRequest {
        schema_version: 1,
        tone_map_hdr: true,
        subtitle_stream_index: Some(0),
    });
    binding.local_hls_ladder = Some(LocalHlsLadderRequest { schema_version: 1 });
    binding.advanced_assets_sha256 = Some("unchanged-asset-digest".into());
    let original = scope(&binding);
    assert!(binding.matches(original, 30));
    assert!(!binding.matches(
        CandidateScope {
            advanced_playback: None,
            ..original
        },
        30
    ));
    assert!(!binding.matches(
        CandidateScope {
            local_hls_ladder: None,
            ..original
        },
        30
    ));
    for request in [
        AdvancedPlaybackRequest {
            schema_version: 2,
            tone_map_hdr: true,
            subtitle_stream_index: Some(0),
        },
        AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: false,
            subtitle_stream_index: Some(0),
        },
        AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: true,
            subtitle_stream_index: None,
        },
        AdvancedPlaybackRequest {
            schema_version: 1,
            tone_map_hdr: true,
            subtitle_stream_index: Some(7),
        },
    ] {
        assert!(!binding.matches(
            CandidateScope {
                advanced_playback: Some(&request),
                ..original
            },
            30
        ));
    }
    let changed_ladder = LocalHlsLadderRequest { schema_version: 2 };
    assert!(!binding.matches(
        CandidateScope {
            local_hls_ladder: Some(&changed_ladder),
            ..original
        },
        30
    ));
    let serialized = serde_json::to_value(&binding).unwrap();
    let decoded: CandidateBinding = serde_json::from_value(serialized.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), serialized);
}

#[test]
fn server_candidate_order_wins_over_report_order_and_exclusions_are_exact() {
    let candidates = candidates();
    assert_eq!(
        candidates.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["direct", "remux", "audio_transcode", "transcode_720p"]
    );
    let mut report = report(&candidates);
    report.results.reverse();
    let caps = capabilities(false);
    for expected in ["direct", "remux", "audio_transcode", "transcode_720p"] {
        let selected = choose(candidates.clone(), &report, &caps, "auto", 0.0, false).unwrap();
        assert_eq!(selected.candidate.id, expected);
        assert_eq!(selected.source_version.as_deref(), Some("stat-v1:current"));
        report.excluded_candidates.push(expected.into());
    }
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "auto", 0.0, false).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    report.excluded_candidates = vec!["unoffered-history".into()];
    let mut reversed = candidates;
    reversed.reverse();
    assert_eq!(
        choose(reversed, &report, &caps, "auto", 0.0, false)
            .unwrap()
            .candidate
            .id,
        "transcode_720p"
    );
}

#[test]
fn invalid_report_ids_are_rejected_before_exclusion_or_ladder_eligibility() {
    let candidates = candidates();
    let caps = capabilities(false);
    let mut report = report(&candidates);
    report.results.push(report.results[0].clone());
    report.excluded_candidates.push("direct".into());
    for ladder in [false, true] {
        assert_eq!(
            choose(candidates.clone(), &report, &caps, "auto", 0.0, ladder).unwrap_err(),
            Rejection::InvalidRequest
        );
    }
    report.results.pop();
    report.results[0].candidate_id = "unknown".into();
    assert_eq!(
        choose(candidates, &report, &caps, "auto", 0.0, false).unwrap_err(),
        Rejection::InvalidRequest
    );
}

#[test]
fn remux_intent_can_choose_audio_transcode_but_never_a_nonzero_copy_origin() {
    let candidates = candidates();
    let mut report = report(&candidates);
    let caps = capabilities(false);
    report.excluded_candidates.push("remux".into());
    let selected = choose(candidates.clone(), &report, &caps, "remux", 0.0, false).unwrap();
    assert_eq!(selected.candidate.delivery_mode, "audio_transcode");
    for position in [0.001, 12345.0] {
        assert_eq!(
            choose(candidates.clone(), &report, &caps, "remux", position, false).unwrap_err(),
            Rejection::NoCompatibleTransport
        );
        assert_eq!(
            choose(candidates.clone(), &report, &caps, "auto", position, false)
                .unwrap()
                .candidate
                .id,
            "direct"
        );
    }
    report.excluded_candidates.push("direct".into());
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "auto", 12345.0, false)
            .unwrap()
            .candidate
            .id,
        "transcode_720p"
    );
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "transcode", 0.0, false)
            .unwrap()
            .candidate
            .id,
        "transcode_720p"
    );
    assert_eq!(
        choose(candidates, &report, &caps, "unknown", 0.0, false).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
}

#[test]
fn concrete_decoder_evidence_and_conservative_missing_api_fallback_are_unchanged() {
    let candidates = candidates();
    let mut report = report(&candidates);
    let caps = capabilities(false);
    for result in &mut report.results {
        result.file_decoding = None;
        result.mse_decoding = None;
    }
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "auto", 0.0, false)
            .unwrap()
            .candidate
            .id,
        "transcode_720p"
    );
    for result in &mut report.results {
        result.mse_supported = Some(false);
    }
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "auto", 0.0, false).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    assert_eq!(
        choose(
            candidates.clone(),
            &report,
            &capabilities(true),
            "auto",
            0.0,
            false
        )
        .unwrap()
        .candidate
        .id,
        "transcode_720p"
    );
    let fixed = report.results.last_mut().unwrap();
    fixed.file_decoding = Some(protocol::MediaDecodingSupport {
        supported: false,
        smooth: true,
        power_efficient: true,
    });
    assert_eq!(
        choose(candidates, &report, &capabilities(true), "auto", 0.0, false).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
}

#[test]
fn no_hls_does_not_block_progressive_and_legacy_mse_sample_does_not_veto_exact_probe() {
    let candidates = candidates();
    let mut report = report(&candidates);
    let caps = capabilities(false);
    assert!(!caps.supports_hls());
    for result in &mut report.results {
        result.mse_supported = Some(false);
    }
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "auto", 0.0, false)
            .unwrap()
            .candidate
            .id,
        "direct"
    );
    report.excluded_candidates.push("direct".into());
    assert_eq!(
        choose(candidates.clone(), &report, &caps, "auto", 0.0, false).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    report.results[1].mse_supported = Some(true);
    assert_eq!(
        choose(candidates, &report, &caps, "auto", 0.0, false)
            .unwrap()
            .candidate
            .id,
        "remux"
    );
}

#[test]
fn dolby_passthrough_requires_its_own_positive_probe() {
    let mut candidate = candidates().remove(0);
    candidate.video.dolby_vision = Some(protocol::DolbyVisionConfiguration {
        profile: 8,
        level: 6,
        compatibility_id: 1,
        codec: "dvh1.08.06".into(),
    });
    let mut result = report(&[candidate.clone()]).results.remove(0);
    let caps = capabilities(true);
    assert!(!selection::playable(&candidate, &result, &caps));
    result.dolby_vision_supported = Some(false);
    assert!(!selection::playable(&candidate, &result, &caps));
    result.dolby_vision_supported = Some(true);
    assert!(selection::playable(&candidate, &result, &caps));
}

#[test]
fn ladder_requires_all_bound_rungs_without_any_exclusions() {
    let ladder = media_core::hls_ladder::LadderRecipe::from_probe(&source(), None, 0.0)
        .unwrap()
        .candidates();
    assert_eq!(ladder.len(), 3);
    let mut report = report(&ladder);
    for result in &mut report.results {
        result.file_decoding = None;
        result.mse_decoding = None;
    }
    let caps = capabilities(false);
    assert!(choose(ladder.clone(), &report, &caps, "transcode", 0.0, true).is_ok());
    let last = report.results.pop().unwrap();
    assert_eq!(
        choose(ladder.clone(), &report, &caps, "transcode", 0.0, true).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    report.results.push(PlaybackCandidateResult {
        mse_supported: Some(false),
        ..last.clone()
    });
    assert_eq!(
        choose(ladder.clone(), &report, &caps, "transcode", 0.0, true).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    *report.results.last_mut().unwrap() = last;
    report.excluded_candidates.push("unrelated-history".into());
    assert_eq!(
        choose(ladder.clone(), &report, &caps, "transcode", 0.0, true).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    report.excluded_candidates.clear();
    let mut oversized = ladder;
    oversized.push(oversized[0].clone());
    assert_eq!(
        choose(oversized, &report, &caps, "transcode", 0.0, true).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
    report.results.clear();
    assert_eq!(
        choose(vec![], &report, &caps, "transcode", 0.0, true).unwrap_err(),
        Rejection::NoCompatibleTransport
    );
}

#[test]
fn http_and_s3_share_transport_but_only_http_can_request_finite_hls() {
    for (storage_kind, origin) in [("http", HttpOrigin::Http), ("s3", HttpOrigin::S3)] {
        let facts = SourceFacts {
            storage_kind,
            linux: true,
        };
        let route = selection::source_route(facts, SourceIntent::default()).unwrap();
        assert_eq!(route, SourceRoute::Http(origin));
        assert_eq!(route.kind(), "http");
        let finite = selection::source_route(
            facts,
            SourceIntent {
                finite_hls: true,
                ..SourceIntent::default()
            },
        );
        if storage_kind == "http" {
            assert_eq!(finite.unwrap(), route);
        } else {
            assert_eq!(finite.unwrap_err(), Rejection::FiniteHlsSourceUnsupported);
        }
    }
}

#[test]
fn source_route_preserves_source_and_platform_rejections_in_original_order() {
    for linux in [true, false] {
        for storage_kind in [
            "local", "http", "s3", "agent", "jellyfin", "emby", "other", "",
        ] {
            let facts = SourceFacts {
                storage_kind,
                linux,
            };
            let route = selection::source_route(facts, SourceIntent::default()).unwrap();
            assert_eq!(
                route.kind(),
                if storage_kind == "s3" {
                    "http"
                } else {
                    storage_kind
                }
            );
            let advanced = selection::source_route(
                facts,
                SourceIntent {
                    advanced: true,
                    candidate_report: true,
                    ..SourceIntent::default()
                },
            );
            if linux && ["local", "http", "s3", "agent"].contains(&storage_kind) {
                assert!(advanced.is_ok());
            } else {
                assert_eq!(
                    advanced.unwrap_err(),
                    Rejection::AdvancedLocalSourceRequired
                );
            }
            let ladder = selection::source_route(
                facts,
                SourceIntent {
                    ladder: true,
                    advanced: true,
                    candidate_report: true,
                    ..SourceIntent::default()
                },
            );
            if linux && storage_kind == "local" {
                assert!(ladder.is_ok());
            } else {
                assert_eq!(ladder.unwrap_err(), Rejection::LocalHlsLadderSourceRequired);
            }
            let candidate = selection::source_route(
                facts,
                SourceIntent {
                    candidate_report: true,
                    ..SourceIntent::default()
                },
            );
            if ["local", "http", "s3", "agent"].contains(&storage_kind) {
                assert!(candidate.is_ok());
            } else {
                assert_eq!(candidate.unwrap_err(), Rejection::StaleCapabilityReport);
            }
            let finite_first = selection::source_route(
                facts,
                SourceIntent {
                    finite_hls: true,
                    ladder: true,
                    advanced: true,
                    candidate_report: true,
                },
            );
            assert_eq!(
                finite_first.unwrap_err(),
                if storage_kind == "http" {
                    Rejection::LocalHlsLadderSourceRequired
                } else {
                    Rejection::FiniteHlsSourceUnsupported
                }
            );
        }
    }
}

#[test]
fn local_timeline_keeps_copy_zero_only_and_exact_transcode_origin() {
    for mode in ["remux", "audio_transcode"] {
        assert_eq!(facts::local_timeline_origin(0.0, mode), Some(0.0));
        assert_eq!(facts::local_timeline_origin(12345.0, mode), None);
    }
    assert_eq!(
        facts::local_timeline_origin(12345.0, "transcode"),
        Some(12345.0)
    );
    assert_eq!(facts::local_timeline_origin(0.0, "direct"), None);
    for invalid in [-1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(facts::local_timeline_origin(invalid, "transcode"), None);
    }
}

#[test]
fn track_facts_preserve_zero_uniqueness_and_current_metadata_requirements() {
    let mut meta = source();
    assert_eq!(facts::mapped_audio(&meta, None, "direct", true), Some(0));
    assert_eq!(facts::mapped_audio(&meta, Some(0), "direct", true), None);
    assert_eq!(facts::mapped_audio(&meta, Some(0), "remux", true), Some(0));
    assert_eq!(facts::mapped_audio(&meta, Some(0), "remux", false), None);
    let duplicate = meta["streams"][1].clone();
    meta["streams"].as_array_mut().unwrap().push(duplicate);
    assert_eq!(facts::mapped_audio(&meta, Some(0), "remux", true), None);
    assert_eq!(facts::mapped_audio(&meta, None, "direct", true), None);
    for invalid in [json!(-1), json!(4294967296_u64), json!(0.5), json!("0")] {
        assert_eq!(facts::stream_index(&json!({"index":invalid})), None);
    }
    assert_eq!(
        facts::stream_index(&json!({"index":4294967295_u64})),
        Some(u32::MAX)
    );
}

#[test]
fn fallback_hints_require_current_mapping_hls_and_zero_origin_for_remux() {
    let source = source();
    assert_eq!(
        selection::legacy_mapped_fallbacks(&source, None, "direct", 0.0, true, true),
        [DecoderFallbackMode::Remux, DecoderFallbackMode::Transcode]
    );
    assert_eq!(
        selection::legacy_mapped_fallbacks(&source, None, "direct", 12345.0, true, true),
        [DecoderFallbackMode::Transcode]
    );
    for (current, hls, mode) in [
        (false, true, "direct"),
        (true, false, "direct"),
        (true, true, "transcode"),
    ] {
        assert!(
            selection::legacy_mapped_fallbacks(&source, None, mode, 0.0, current, hls).is_empty()
        );
    }
    let mut ambiguous = source.clone();
    ambiguous["streams"][0]["disposition"] = Value::Null;
    assert!(
        selection::legacy_mapped_fallbacks(&ambiguous, None, "direct", 0.0, true, true).is_empty()
    );
    let mut hdr = source;
    hdr["streams"][0]["color_transfer"] = json!("smpte2084");
    assert!(selection::local_fallbacks(&hdr, "direct", 0.0, true, true).is_empty());
}

#[test]
fn upstream_audio_and_fallback_need_current_unambiguous_same_origin_route() {
    let mut info = json!({"MediaSources":[{"Id":"current", "DefaultAudioStreamIndex":0,
        "MediaStreams":[{"Type":"Audio","Index":0}], "SupportsTranscoding":true,
        "TranscodingUrl":"/Videos/current/master.m3u8"}]});
    assert_eq!(facts::upstream_audio(&info, None, "direct"), Some(0));
    assert_eq!(facts::upstream_audio(&info, Some(0), "direct"), Some(0));
    assert_eq!(facts::upstream_audio(&info, Some(1), "direct"), None);
    assert_eq!(
        selection::upstream_fallbacks(&info, "direct", true, "https://media.example"),
        [DecoderFallbackMode::Transcode]
    );
    assert!(
        selection::upstream_fallbacks(&info, "direct", false, "https://media.example").is_empty()
    );
    assert!(
        selection::upstream_fallbacks(&info, "transcode", true, "https://media.example").is_empty()
    );
    info["MediaSources"][0]["TranscodingUrl"] = json!("https://untrusted.example/master.m3u8");
    assert!(
        selection::upstream_fallbacks(&info, "direct", true, "https://media.example").is_empty()
    );
    let duplicate = info["MediaSources"][0].clone();
    info["MediaSources"].as_array_mut().unwrap().push(duplicate);
    assert_eq!(facts::upstream_audio(&info, None, "direct"), None);
    assert!(
        selection::upstream_fallbacks(&info, "direct", true, "https://media.example").is_empty()
    );
}

#[test]
fn preparation_probe_policy_distinguishes_agent_and_http_direct_intents() {
    for requested in ["auto", "remux", "transcode"] {
        assert!(selection::needs_preparation_probe(
            "agent", requested, false, None, true
        ));
        assert!(selection::needs_preparation_probe(
            "http", requested, false, None, true
        ));
    }
    assert!(!selection::needs_preparation_probe(
        "agent", "direct", false, None, true
    ));
    for (selected, audio, progressive) in [
        (true, None, true),
        (false, Some(0), true),
        (false, None, false),
    ] {
        assert!(selection::needs_preparation_probe(
            "agent",
            "direct",
            selected,
            audio,
            progressive
        ));
        assert!(!selection::needs_preparation_probe(
            "http",
            "direct",
            selected,
            audio,
            progressive
        ));
    }
    for kind in ["local", "jellyfin", "emby", "unknown"] {
        assert!(!selection::needs_preparation_probe(
            kind,
            "auto",
            true,
            Some(0),
            false
        ));
    }
}

#[test]
fn decision_reason_retains_candidate_upstream_and_freshness_precedence() {
    assert_eq!(
        selection::decision_reason("jellyfin", "auto", "direct", true, true, Some("direct")),
        "actual_media_direct"
    );
    for kind in ["jellyfin", "emby"] {
        assert_eq!(
            selection::decision_reason(kind, "direct", "transcode", false, false, None),
            format!("{kind}_negotiated_transcode")
        );
    }
    assert_eq!(
        selection::decision_reason("local", "auto", "direct", true, true, None),
        "local_automatic_direct_authorized_probe"
    );
    assert_eq!(
        selection::decision_reason("agent", "direct", "direct", true, false, None),
        "agent_requested_direct_source_version_matched_metadata"
    );
    assert_eq!(
        selection::decision_reason("http", "auto", "direct", false, false, None),
        "http_automatic_direct_legacy_transport_policy"
    );
}

#[test]
fn equal_inputs_repeat_exact_configuration_and_never_modify_borrowed_evidence() {
    let candidates = candidates();
    let report = report(&candidates);
    let caps = capabilities(false);
    let before = serde_json::to_value((&report, &caps, &candidates)).unwrap();
    let mut previous = None;
    for _ in 0..3 {
        let selected = choose(candidates.clone(), &report, &caps, "remux", 0.0, false).unwrap();
        let exact = serde_json::to_value((&selected.candidate, &selected.source_version)).unwrap();
        if let Some(previous) = previous {
            assert_eq!(exact, previous);
        }
        previous = Some(exact);
        assert_eq!(
            serde_json::to_value((&report, &caps, &candidates)).unwrap(),
            before
        );
    }
    let http = selection::select_candidate(
        CandidateIntent {
            requested_mode: "auto",
            position_ms: 0.0,
            ladder: false,
            report: &report,
            capabilities: &caps,
        },
        CandidateFacts {
            candidates,
            source_version: None,
        },
    )
    .unwrap();
    assert!(http.source_version.is_none());
}
