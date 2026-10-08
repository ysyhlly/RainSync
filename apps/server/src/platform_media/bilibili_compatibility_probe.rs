//! Private clear UGC source proof, only after explicit HLS intent.
//! Provider metadata never substitutes for an exact configuration/range proof.
use super::*;
use providers::platform::{http::PlatformHttp, youtube::mp4};

pub(super) async fn prepare(
    http: PlatformHttp,
    resolved: &bilibili::ResolvedVideo,
    max_height: Option<u32>,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>, Vec<u32>)> {
    let (mut descriptor, heights) =
        Descriptor::bilibili_compatibility_candidate(resolved, max_height)?;
    if descriptor.compatibility_source.is_some() || descriptor.tracks[1].sampling_rate.is_none() {
        // The original extraction deadline also bounds both byte observations.
        let (video, audio) = tokio::try_join!(
            youtube_probe::probe_bilibili_compatibility(
                http,
                &descriptor.tracks[0].url,
                mp4::TrackKind::Video,
                deadline
            ),
            youtube_probe::probe_bilibili_compatibility(
                http,
                &descriptor.tracks[1].url,
                mp4::TrackKind::Audio,
                deadline
            ),
        )?;
        apply_proofs(&mut descriptor, &video, &audio)?;
    }
    descriptor
        .validate_for("bilibili")
        .map_err(|_| unsupported())?;
    let expiry = descriptor.earliest_known_expiry_ms();
    Ok((descriptor, expiry, heights))
}
fn unsupported() -> Error {
    err(
        StatusCode::UNPROCESSABLE_ENTITY,
        "native_platform_compatibility_source_unsupported",
    )
}
fn duration(probe: &mp4::Probe) -> Result<f64> {
    if probe.timescale == 0 || probe.duration_ticks == 0 {
        return Err(unsupported());
    }
    let duration = probe.duration_ticks as f64 / f64::from(probe.timescale);
    if !duration.is_finite() || !(0.001..=21_600.0).contains(&duration) {
        return Err(unsupported());
    }
    Ok(duration)
}
fn apply_proofs(descriptor: &mut Descriptor, video: &mp4::Probe, audio: &mp4::Probe) -> Result<()> {
    if !matches!(
        descriptor.compatibility_source,
        None | Some(
            descriptor::CompatibilitySource::ClearHevcMainV1
                | descriptor::CompatibilitySource::ClearExtendedV1
        )
    ) || descriptor.transport != Transport::Dash
        || descriptor.tracks.len() != 2
    {
        return Err(unsupported());
    }
    let v = &descriptor.tracks[0];
    let a = &descriptor.tracks[1];
    match &video.codec {
        mp4::Codec::Avc {
            rfc6381,
            width,
            height,
        } if descriptor.compatibility_source.is_none()
            && rfc6381.eq_ignore_ascii_case(&v.codecs)
            && Some(*width) == v.width
            && Some(*height) == v.height => {}
        mp4::Codec::Hevc {
            rfc6381,
            width,
            height,
        }
        | mp4::Codec::HevcMain10 {
            rfc6381,
            width,
            height,
            ..
        }
        | mp4::Codec::Av1 {
            rfc6381,
            width,
            height,
        }
        | mp4::Codec::Vp9 {
            rfc6381,
            width,
            height,
        } if descriptor.compatibility_source.is_some()
            && mp4::clear_extended_codec_equivalent(rfc6381, &v.codecs)
            && Some(*width) == v.width
            && Some(*height) == v.height => {}
        _ => return Err(unsupported()),
    }
    let sample_rate = match audio.codec {
        mp4::Codec::AacLc {
            sample_rate,
            channels,
        } if a.codecs == "mp4a.40.2"
            && (8000..=96000).contains(&sample_rate)
            && a.sampling_rate
                .is_none_or(|declared| declared == sample_rate)
            && matches!(channels, 1 | 2) =>
        {
            sample_rate
        }
        _ => return Err(unsupported()),
    };
    if descriptor.compatibility_source == Some(descriptor::CompatibilitySource::ClearExtendedV1) {
        descriptor.tracks[0].source_video =
            Some(video.codec.source_expectation().ok_or_else(unsupported)?);
    }
    let video_duration = duration(video)?;
    let audio_duration = duration(audio)?;
    if (video_duration - audio_duration).abs() > 0.250
        || (video_duration - descriptor.duration_seconds).abs() > 1.5
        || (audio_duration - descriptor.duration_seconds).abs() > 1.5
        || video
            .total_bytes
            .checked_add(audio.total_bytes)
            .is_none_or(|n| n > 2 * 1024 * 1024 * 1024)
    {
        return Err(unsupported());
    }
    for (track, proof) in descriptor.tracks.iter_mut().zip([video, audio]) {
        // A declaration cannot point at different initialization/index bytes.
        // No silent URL/track/range replacement or unsupported-family relabel.
        if proof.initialization.start != track.initialization_start
            || proof.initialization.end != track.initialization_end
            || proof.index.start != track.index_start
            || proof.index.end != track.index_end
            || proof.total_bytes == 0
            || !proof
                .strong_etag
                .as_deref()
                .is_some_and(descriptor::valid_strong_etag)
        {
            return Err(unsupported());
        }
        track.observed_content_length = Some(proof.total_bytes);
        track.strong_etag = proof.strong_etag.clone();
    }
    // Missing declarations become measured facts only after all configuration,
    // representation identity, range, and timeline checks succeed.
    descriptor.tracks[1].sampling_rate = Some(sample_rate);
    descriptor.duration_seconds = video_duration.max(audio_duration);
    descriptor
        .validate_for("bilibili")
        .map_err(|_| unsupported())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selected() -> (Descriptor, mp4::Probe, mp4::Probe) {
        let mut d = descriptor::fixture();
        d.compatibility_source = Some(descriptor::CompatibilitySource::ClearHevcMainV1);
        d.tracks[0].codecs = "hev1.1.6.L120.90".into();
        let probe = |codec| mp4::Probe {
            initialization: mp4::ByteRange { start: 0, end: 99 },
            index: mp4::ByteRange {
                start: 100,
                end: 200,
            },
            track_id: 1,
            codec,
            timescale: 1000,
            duration_ticks: 120000,
            segments: vec![],
            total_bytes: 10000,
            strong_etag: Some("\"byte-proof\"".into()),
        };
        (
            d,
            probe(mp4::Codec::Hevc {
                rfc6381: "hev1.1.6.L120.90".into(),
                width: 1920,
                height: 1080,
            }),
            probe(mp4::Codec::AacLc {
                sample_rate: 48000,
                channels: 2,
            }),
        )
    }
    #[test]
    fn clear_hevc_admission_requires_exact_byte_configuration_and_closed_source_scope() {
        let (mut d, v, a) = selected();
        assert!(d.validate_for("bilibili").is_err()); // metadata alone is insufficient
        apply_proofs(&mut d, &v, &a).unwrap();
        assert!(d.validate_for("bilibili").is_ok());
        assert!(
            d.render_for("bilibili", Uuid::from_u128(1), &"a".repeat(64))
                .is_err()
        );
        assert!(d.validate_for("youtube").is_err());
        assert_eq!(d.tracks[0].codecs, "hev1.1.6.L120.90");
        assert_eq!(
            d.decision_reason("bilibili"),
            "native_platform_clear_media_compatibility"
        );
        let canonical = serde_json::to_value(&d).unwrap();
        let restored: Descriptor = serde_json::from_value(canonical.clone()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), canonical);
        let mut native = d.clone();
        native.compatibility_source = None;
        assert!(native.validate_for("bilibili").is_err());
        let mut relabel = d.clone();
        relabel.tracks[0].codecs = "avc1.640028".into();
        assert!(relabel.validate_for("bilibili").is_err());
    }
    #[test]
    fn missing_audio_rate_is_derived_from_exact_compatibility_byte_proof() {
        for avc in [false, true] {
            let (mut d, mut v, a) = selected();
            d.tracks[1].sampling_rate = None;
            if avc {
                d.compatibility_source = None;
                d.tracks[0].codecs = "avc1.640028".into();
                v.codec = mp4::Codec::Avc {
                    rfc6381: "avc1.640028".into(),
                    width: 1920,
                    height: 1080,
                };
            }
            apply_proofs(&mut d, &v, &a).unwrap();
            assert_eq!(d.tracks[1].sampling_rate, Some(48000));
            assert!(d.validate_for("bilibili").is_ok());
            let mut invalid = d.clone();
            invalid.tracks[1].sampling_rate = None;
            let mut mismatched = a.clone();
            mismatched.index.start += 1;
            assert!(apply_proofs(&mut invalid, &v, &mismatched).is_err());
            assert!(invalid.tracks[1].sampling_rate.is_none());
        }
    }

    #[test]
    fn missing_audio_rate_avc_proof_accepts_equivalent_hex_case() {
        let (mut d, mut v, a) = selected();
        d.compatibility_source = None;
        d.tracks[0].codecs = "avc1.4D401F".into();
        d.tracks[1].sampling_rate = None;
        v.codec = mp4::Codec::Avc {
            rfc6381: "avc1.4d401f".into(),
            width: 1920,
            height: 1080,
        };
        apply_proofs(&mut d, &v, &a).unwrap();
        assert_eq!(d.tracks[1].sampling_rate, Some(48000));
        assert_eq!(d.tracks[0].codecs, "avc1.4D401F");
    }

    #[test]
    fn clear_hevc_sealed_source_cannot_be_restored_as_pgc_course_or_foreign_provider() {
        let (mut d, v, a) = selected();
        apply_proofs(&mut d, &v, &a).unwrap();
        let binding = Binding {
            version: 1,
            provider: "bilibili".into(),
            media_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(2),
            user_id: Uuid::from_u128(3),
            entry_revision: "1".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: None,
        };
        let sealed = Sealed {
            kind: "native_platform".into(),
            version: 1,
            binding,
            resolved_at_ms: 100000,
            url_expires_at_ms: None,
            descriptor: d,
        };
        assert_eq!(sealed.policy_deadline_ms().unwrap(), 220000);
        let mut pgc = sealed.clone();
        pgc.binding.version = 2;
        pgc.binding.resource = Some(native_platform::PgcIdentity::new(
            "1".into(),
            "2".into(),
            "3".into(),
        ));
        assert!(pgc.binding.validate());
        assert!(pgc.policy_deadline_ms().is_err());
        let mut course = sealed.clone();
        course.binding.version = 4;
        course.binding.resource = Some(native_platform::PgcIdentity::new_course(
            "1".into(),
            "2".into(),
            "3".into(),
            "4".into(),
        ));
        assert!(course.binding.validate());
        assert!(course.policy_deadline_ms().is_err());
        let mut foreign = sealed;
        foreign.binding.provider = "youtube".into();
        assert!(foreign.policy_deadline_ms().is_err());
    }
    #[test]
    fn clear_hevc_admission_rejects_mismatched_codec_timeline_ranges_identity_and_size() {
        let (d, v, a) = selected();
        for axis in [
            "codec",
            "width",
            "range",
            "etag",
            "weak",
            "duration",
            "origin-range",
            "size",
            "missing-config",
        ] {
            let mut video = v.clone();
            match axis {
                "codec" => {
                    video.codec = mp4::Codec::Hevc {
                        rfc6381: "hvc1.1.6.L120.90".into(),
                        width: 1920,
                        height: 1080,
                    }
                }
                "width" => {
                    video.codec = mp4::Codec::Hevc {
                        rfc6381: "hev1.1.6.L120.90".into(),
                        width: 1280,
                        height: 1080,
                    }
                }
                "range" => video.index.end = 201,
                "etag" => video.strong_etag = None,
                "weak" => video.strong_etag = Some("W/\"weak\"".into()),
                "duration" => video.duration_ticks = 120251,
                "origin-range" => video.initialization.start = 1,
                "size" => video.total_bytes = 2 * 1024 * 1024 * 1024,
                "missing-config" => {
                    video.codec = mp4::Codec::Avc {
                        rfc6381: "avc1.640028".into(),
                        width: 1920,
                        height: 1080,
                    }
                }
                _ => unreachable!(),
            }
            assert!(apply_proofs(&mut d.clone(), &video, &a).is_err(), "{axis}");
        }
        let mut audio = a.clone();
        audio.codec = mp4::Codec::AacLc {
            sample_rate: 44100,
            channels: 2,
        };
        assert!(apply_proofs(&mut d.clone(), &v, &audio).is_err());
        let mut audio = a;
        audio.index.start = 101;
        assert!(apply_proofs(&mut d.clone(), &v, &audio).is_err());
    }
}
