use protocol::*;
use ts_rs::TS;
fn output(path: std::path::PathBuf, content: String) {
    if std::env::args().any(|arg| arg == "--check") {
        assert_eq!(
            std::fs::read_to_string(&path)
                .unwrap_or_default()
                .replace("\r\n", "\n"),
            content,
            "generated contract is stale: {}",
            path.display()
        );
    } else {
        std::fs::write(path, content).unwrap();
    }
}
fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol");
    std::fs::create_dir_all(&root).unwrap();
    let declarations = [
        DistributedComputePlaybackIntent::decl(),
        DistributedComputePlaybackFacts::decl(),
        LocalHlsLadderRequest::decl(),
        LocalHlsRendition::decl(),
        LocalHlsLadderCapabilities::decl(),
        LocalHlsLadderFacts::decl(),
        AdvancedPlaybackRequest::decl(),
        AdvancedSubtitleCodec::decl(),
        AdvancedSubtitleTrack::decl(),
        AdvancedPlaybackCapabilities::decl(),
        DolbyVisionConfiguration::decl(),
        AdvancedPlaybackFacts::decl(),
        NativePlatformCredentialMode::decl(),
        NativePlatformProvider::decl(),
        NativePlatformResolvedCredentialMode::decl(),
        NativePlatformMaxHeight::decl(),
        NativePlatformQualityIntent::decl(),
        NativePlatformQualityOption::decl(),
        NativePlatformQualityBinding::decl(),
        NativePlatformCompatibilityMode::decl(),
        NativePlatformCompatibilityIntent::decl(),
        NativePlatformCompatibilityOutput::decl(),
        NativePlatformCompatibilityBinding::decl(),
        NativePlatformLiveSyncMode::decl(),
        NativePlatformLiveBinding::decl(),
        NativePlatformPlaybackIntent::decl(),
        NativePlatformPlaybackBinding::decl(),
        PlaybackStatus::decl(),
        RoomState::decl(),
        PresenceMember::decl(),
        PresenceSnapshot::decl(),
        ControlRecoveryMessageType::decl(),
        ControlRecoveryMetricsSample::decl(),
        NasUplinkOutcomeTotals::decl(),
        NasUplinkTotals::decl(),
        NasUplinkMetricsSample::decl(),
        Action::decl(),
        Command::decl(),
        ControlEpoch::decl(),
        MediaTrack::decl(),
        SubtitleDeliveryMode::decl(),
        DecoderFallbackMode::decl(),
        PlaybackMediaRange::decl(),
        HttpFileFallback::decl(),
        PlaybackPlan::decl(),
        PreparationStatus::decl(),
        PlaybackReadiness::decl(),
        MediaTypeSupport::decl(),
        VideoCapabilityConfiguration::decl(),
        AudioCapabilityConfiguration::decl(),
        MediaDecodingSupport::decl(),
        MediaCapabilityCandidate::decl(),
        CapabilityReport::decl(),
        PlaybackCandidateRequest::decl(),
        PlaybackCandidate::decl(),
        PlaybackRouteReason::decl(),
        PlaybackRouteDecision::decl(),
        PlaybackOutputBasis::decl(),
        PlaybackSelectedOutput::decl(),
        PlaybackCandidateSet::decl(),
        PlaybackCandidateResult::decl(),
        PlaybackCandidateReport::decl(),
        UpstreamProfileSemantics::decl(),
        UpstreamVideoProfileBounds::decl(),
        UpstreamAudioProfileBounds::decl(),
        UpstreamProfileProbeSample::decl(),
        UpstreamAudioRateContract::decl(),
        UpstreamAudioRateReport::decl(),
        UpstreamTranscodeProfileEnvelope::decl(),
        UpstreamProfileCandidateRequest::decl(),
        UpstreamProfileCandidateSet::decl(),
        UpstreamProfileReport::decl(),
        UpstreamMeasuredVideo::decl(),
        UpstreamMeasuredAudio::decl(),
        UpstreamMeasuredOutput::decl(),
        PlaybackCapabilities::decl(),
        PlaybackRequest::decl(),
        PlaybackMetricsOrigin::decl(),
        PlaybackMetricsFrameEvidence::decl(),
        PlaybackMetricsIntent::decl(),
        PlaybackMetricsTotals::decl(),
        PlaybackMetricsFirstFrame::decl(),
        PlaybackMetricsSample::decl(),
        PlaybackMetricsStartupPhases::decl(),
        PlaybackMetricsSampleV2::decl(),
        PlaybackMetricsPacket::decl(),
        PlaybackMetricsGrantV2::decl(),
        PlaybackMetricsGrantWire::decl(),
        PlaybackMetricsGrant::decl(),
        PlaybackMetricsReceipt::decl(),
        PlaybackObservationEvent::decl(),
        PlaybackObservation::decl(),
        PlaybackObservationReceipt::decl(),
        ErrorCode::decl(),
        ApiError::decl(),
        ErrorResponse::decl(),
    ];
    output(
        root.join("index.ts"),
        declarations
            .iter()
            .map(|s| {
                format!(
                    "export {}\n",
                    s.lines().map(str::trim_end).collect::<Vec<_>>().join("\n")
                )
            })
            .collect::<String>(),
    );
    for (name, schema) in [
        ("command", schemars::schema_for!(Command)),
        ("control-epoch", schemars::schema_for!(ControlEpoch)),
        ("room-state", schemars::schema_for!(RoomState)),
        ("presence-snapshot", schemars::schema_for!(PresenceSnapshot)),
        (
            "control-recovery-metrics",
            schemars::schema_for!(ControlRecoveryMetricsSample),
        ),
        (
            "nas-uplink-metrics",
            schemars::schema_for!(NasUplinkMetricsSample),
        ),
        ("playback-request", schemars::schema_for!(PlaybackRequest)),
        (
            "upstream-measured-output",
            schemars::schema_for!(UpstreamMeasuredOutput),
        ),
        (
            "playback-metrics-sample",
            schemars::schema_for!(PlaybackMetricsSample),
        ),
        (
            "playback-metrics-v2-sample",
            schemars::schema_for!(PlaybackMetricsSampleV2),
        ),
        (
            "playback-metrics-packet",
            schemars::schema_for!(PlaybackMetricsPacket),
        ),
        (
            "playback-metrics-receipt",
            schemars::schema_for!(PlaybackMetricsReceipt),
        ),
        (
            "playback-candidate-request",
            schemars::schema_for!(PlaybackCandidateRequest),
        ),
        (
            "playback-candidates",
            schemars::schema_for!(PlaybackCandidateSet),
        ),
        ("error-response", schemars::schema_for!(ErrorResponse)),
        ("playback-plan", schemars::schema_for!(PlaybackPlan)),
        (
            "upstream-profile-candidate-request",
            schemars::schema_for!(UpstreamProfileCandidateRequest),
        ),
        (
            "upstream-profile-candidates",
            schemars::schema_for!(UpstreamProfileCandidateSet),
        ),
        (
            "playback-observation",
            schemars::schema_for!(PlaybackObservation),
        ),
        (
            "playback-observation-receipt",
            schemars::schema_for!(PlaybackObservationReceipt),
        ),
        (
            "playback-readiness",
            schemars::schema_for!(PlaybackReadiness),
        ),
        (
            "playback-capabilities",
            schemars::schema_for!(PlaybackCapabilities),
        ),
    ] {
        output(
            root.join(format!("{name}.schema.json")),
            serde_json::to_string_pretty(&schema).unwrap(),
        );
    }
}
