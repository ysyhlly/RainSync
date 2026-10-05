//! Anonymous, provider-bound byte probes. Never fetch an upstream manifest or
//! collect an unrestricted/full media response. Cancellation drops each read.
use super::*;
use descriptor::Track;
use futures_util::{Stream, StreamExt, stream};
use providers::platform::{
    http::PlatformHttp,
    youtube::{self, mp4},
};
use std::{future::Future, pin::Pin};

struct Reader<'a> {
    http: PlatformHttp,
    url: &'a str,
    provider: &'static str,
    deadline: Deadline,
}
impl mp4::RangeReader for Reader<'_> {
    fn read<'a>(
        &'a self,
        request: mp4::RangeRequest,
    ) -> Pin<Box<dyn Future<Output = mp4::Result<mp4::RangeResponse>> + Send + 'a>> {
        Box::pin(async move {
            if request.deadline != self.deadline || request.max_body_bytes > mp4::MAX_PROBE_BYTES {
                return Err(mp4::ProbeError::InvalidResponse);
            }
            if request.range.len()? > request.max_body_bytes {
                return Err(mp4::ProbeError::TooLarge);
            }
            if Deadline::now() >= self.deadline {
                return Err(mp4::ProbeError::Deadline);
            }
            let range = request.range.header();
            let upstream = self
                .http
                .media_request_for(
                    self.provider,
                    self.url,
                    reqwest::Method::GET,
                    Some(&range),
                    self.deadline,
                )
                .await
                .map_err(transport_error)?;
            let status = upstream.status().as_u16();
            let headers = range_headers(upstream.headers())?;
            // Validate status, exact single framing, representation identity and
            // its consistency before asking the response for its first chunk.
            mp4::validate_range_headers(&request, status, &headers)?;
            let chunks = stream::try_unfold(upstream, |mut response| async move {
                match response.next_chunk().await.map_err(transport_error)? {
                    Some(bytes) => Ok(Some((bytes, response))),
                    None => Ok(None),
                }
            });
            let body = collect_body(chunks, &request).await?;
            Ok(mp4::RangeResponse {
                status,
                headers,
                body,
            })
        })
    }
}
fn transport_error(error: bilibili::Error) -> mp4::ProbeError {
    match error {
        bilibili::Error::Deadline => mp4::ProbeError::Deadline,
        bilibili::Error::TooLarge => mp4::ProbeError::TooLarge,
        bilibili::Error::InvalidResponse(_) => mp4::ProbeError::InvalidResponse,
        _ => mp4::ProbeError::Transport,
    }
}
fn range_headers(headers: &HeaderMap) -> mp4::Result<mp4::RangeHeaders> {
    let values = |name: header::HeaderName| {
        headers
            .get_all(name)
            .iter()
            .map(|v| {
                v.to_str()
                    .map(str::to_owned)
                    .map_err(|_| mp4::ProbeError::InvalidResponse)
            })
            .collect::<mp4::Result<Vec<_>>>()
    };
    Ok(mp4::RangeHeaders {
        content_range: values(header::CONTENT_RANGE)?,
        content_length: values(header::CONTENT_LENGTH)?,
        content_encoding: values(header::CONTENT_ENCODING)?,
        etag: values(header::ETAG)?,
        last_modified: values(header::LAST_MODIFIED)?,
    })
}
async fn collect_body<S>(chunks: S, request: &mp4::RangeRequest) -> mp4::Result<Vec<u8>>
where
    S: Stream<Item = mp4::Result<Vec<u8>>>,
{
    let expected = request.range.len()?;
    if expected > request.max_body_bytes || expected > mp4::MAX_PROBE_BYTES {
        return Err(mp4::ProbeError::TooLarge);
    }
    let mut body = Vec::with_capacity(expected);
    tokio::pin!(chunks);
    while let Some(chunk) = tokio::time::timeout_at(request.deadline, chunks.next())
        .await
        .map_err(|_| mp4::ProbeError::Deadline)?
    {
        let chunk = chunk?;
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|n| n > expected)
        {
            return Err(mp4::ProbeError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    if body.len() != expected {
        return Err(mp4::ProbeError::InvalidResponse);
    }
    Ok(body)
}

pub(super) async fn prepare(
    http: PlatformHttp,
    resolved: &youtube::ResolvedVideo,
    video: &youtube::AdaptiveVideo,
    audio: &youtube::AdaptiveAudio,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>)> {
    // Both requests preserve the original extraction budget; no independent
    // track timeout can reset it. Neither failure is a progressive fallback.
    let video_reader = Reader {
        http,
        url: &video.url,
        provider: "youtube",
        deadline,
    };
    let audio_reader = Reader {
        http,
        url: &audio.url,
        provider: "youtube",
        deadline,
    };
    let (video_probe, audio_probe) = tokio::try_join!(
        mp4::probe(&video_reader, mp4::TrackKind::Video, deadline),
        mp4::probe(&audio_reader, mp4::TrackKind::Audio, deadline),
    )
    .map_err(probe_error)?;
    descriptor_from_probes(resolved, video, audio, &video_probe, &audio_probe)
}
pub(super) async fn prepare_compatibility(
    http: PlatformHttp,
    resolved: &youtube::ResolvedVideo,
    video: &youtube::AdaptiveVideo,
    audio: &youtube::AdaptiveAudio,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>)> {
    if video.container == media_core::advanced_media::PrivateInputContainer::Webm {
        return prepare_webm_compatibility(http, resolved, video, audio, deadline).await;
    }
    let vr = Reader {
        http,
        url: &video.url,
        provider: "youtube",
        deadline,
    };
    let ar = Reader {
        http,
        url: &audio.url,
        provider: "youtube",
        deadline,
    };
    let (v, a) = tokio::try_join!(
        mp4::probe_clear_hevc_compatibility(&vr, mp4::TrackKind::Video, deadline),
        mp4::probe(&ar, mp4::TrackKind::Audio, deadline)
    )
    .map_err(probe_error)?;
    descriptor_from_probes_mode(resolved, video, audio, &v, &a, true)
}
async fn prepare_webm_compatibility(
    http: PlatformHttp,
    resolved: &youtube::ResolvedVideo,
    video: &youtube::AdaptiveVideo,
    audio: &youtube::AdaptiveAudio,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>)> {
    let vr = Reader {
        http,
        url: &video.url,
        provider: "youtube",
        deadline,
    };
    let ar = Reader {
        http,
        url: &audio.url,
        provider: "youtube",
        deadline,
    };
    let (v, a) = tokio::try_join!(
        youtube::webm::probe(&vr, mp4::TrackKind::Video, deadline),
        mp4::probe(&ar, mp4::TrackKind::Audio, deadline)
    )
    .map_err(probe_error)?;
    let youtube::webm::Codec::Video(mut e) = v.codec else {
        return Err(unsupported());
    };
    youtube::webm::bind_codec_hint(&mut e, &video.codec).map_err(probe_error)?;
    let mp4::Codec::AacLc {
        sample_rate,
        channels,
    } = a.codec
    else {
        return Err(unsupported());
    };
    let audio_duration = probe_duration(&a)?;
    if e.width != video.width
        || e.height != video.height
        || !youtube::valid_webm_video_hint(&video.codec)
        || (e.codec == "vp9") != (video.codec.starts_with("vp9") || video.codec.starts_with("vp09"))
        || audio.codec != "mp4a.40.2"
        || sample_rate != audio.sample_rate
        || u32::from(channels) != audio.channels
        || (v.duration_seconds - audio_duration).abs() > 0.250
        || (v.duration_seconds - resolved.duration_seconds).abs() > 2.0
        || resolved.expires_at_unix_ms
            != Some(video.expires_at_unix_ms.min(audio.expires_at_unix_ms))
        || !video.fps.is_finite()
        || !(0.001..=120.0).contains(&video.fps)
    {
        return Err(unsupported());
    }
    let fps = (video.fps * 1000.0).round() as u32;
    let d = Descriptor {
        compatibility_source: Some(descriptor::CompatibilitySource::ClearWebmV1),
        transport: Transport::Dash,
        duration_seconds: v.duration_seconds.max(audio_duration),
        min_buffer_seconds: 1.5,
        tracks: vec![
            Track {
                source_webm: Some(e.clone()),
                source_video: None,
                key: "video".into(),
                kind: "video".into(),
                url: video.url.clone(),
                observed_url_expires_at_ms: Some(video.expires_at_unix_ms),
                codecs: e.codec,
                mime_type: "video/webm".into(),
                bandwidth: video.bitrate_bps,
                start_with_sap: 0,
                index_start: 0,
                index_end: 0,
                initialization_start: 0,
                initialization_end: v.metadata_end.checked_sub(1).ok_or_else(unsupported)?,
                width: Some(video.width),
                height: Some(video.height),
                frame_rate: Some(format!("{fps}/1000")),
                sar: Some("1:1".into()),
                sampling_rate: None,
                observed_content_length: Some(v.total_bytes),
                strong_etag: Some(v.strong_etag),
            },
            Track {
                source_webm: None,
                source_video: None,
                key: "audio".into(),
                kind: "audio".into(),
                url: audio.url.clone(),
                observed_url_expires_at_ms: Some(audio.expires_at_unix_ms),
                codecs: audio.codec.clone(),
                mime_type: "audio/mp4".into(),
                bandwidth: audio.bitrate_bps,
                start_with_sap: 0,
                index_start: a.index.start,
                index_end: a.index.end,
                initialization_start: a.initialization.start,
                initialization_end: a.initialization.end,
                width: None,
                height: None,
                frame_rate: None,
                sar: None,
                sampling_rate: Some(sample_rate),
                observed_content_length: Some(a.total_bytes),
                strong_etag: a.strong_etag,
            },
        ],
    };
    d.validate_for("youtube")?;
    let expires = d.earliest_known_expiry_ms();
    Ok((d, expires))
}
pub(super) async fn probe_bilibili_compatibility(
    http: PlatformHttp,
    url: &str,
    kind: mp4::TrackKind,
    deadline: Deadline,
) -> Result<mp4::Probe> {
    let reader = Reader {
        http,
        url,
        provider: "bilibili",
        deadline,
    };
    mp4::probe_clear_hevc_compatibility(&reader, kind, deadline)
        .await
        .map_err(probe_error)
}
fn probe_error(error: mp4::ProbeError) -> Error {
    match error {
        mp4::ProbeError::Deadline => err(
            StatusCode::GATEWAY_TIMEOUT,
            "native_platform_resolve_timeout",
        ),
        mp4::ProbeError::Unsupported | mp4::ProbeError::TooLarge => unsupported(),
        _ => err(StatusCode::BAD_GATEWAY, "native_platform_probe_failed"),
    }
}
fn unsupported() -> Error {
    err(
        StatusCode::UNPROCESSABLE_ENTITY,
        "native_platform_descriptor_unsupported",
    )
}
fn probe_duration(probe: &mp4::Probe) -> Result<f64> {
    if probe.timescale == 0 || probe.duration_ticks == 0 {
        return Err(unsupported());
    }
    let duration = probe.duration_ticks as f64 / f64::from(probe.timescale);
    if !duration.is_finite() || !(0.001..=604800.0).contains(&duration) {
        return Err(unsupported());
    }
    Ok(duration)
}
fn descriptor_from_probes(
    resolved: &youtube::ResolvedVideo,
    video: &youtube::AdaptiveVideo,
    audio: &youtube::AdaptiveAudio,
    video_probe: &mp4::Probe,
    audio_probe: &mp4::Probe,
) -> Result<(Descriptor, Option<i64>)> {
    descriptor_from_probes_mode(resolved, video, audio, video_probe, audio_probe, false)
}
fn descriptor_from_probes_mode(
    resolved: &youtube::ResolvedVideo,
    video: &youtube::AdaptiveVideo,
    audio: &youtube::AdaptiveAudio,
    video_probe: &mp4::Probe,
    audio_probe: &mp4::Probe,
    compatibility: bool,
) -> Result<(Descriptor, Option<i64>)> {
    match &video_probe.codec {
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
        } if compatibility
            && mp4::clear_extended_codec_hint(rfc6381, &video.codec)
            && *width == video.width
            && *height == video.height => {}
        mp4::Codec::Avc {
            rfc6381,
            width,
            height,
        } if rfc6381.eq_ignore_ascii_case(&video.codec)
            && *width == video.width
            && *height == video.height => {}
        _ => return Err(unsupported()),
    }
    match audio_probe.codec {
        mp4::Codec::AacLc {
            sample_rate,
            channels,
        } if audio.codec == "mp4a.40.2"
            && sample_rate == audio.sample_rate
            && u32::from(channels) == audio.channels => {}
        _ => return Err(unsupported()),
    }
    let video_duration = probe_duration(video_probe)?;
    let audio_duration = probe_duration(audio_probe)?;
    // The subset permits zero-origin SIDX only and rejects edit lists. Allow a
    // last AAC frame and extractor rounding, but never distinct AV timelines.
    if (video_duration - audio_duration).abs() > 0.250
        || !resolved.duration_seconds.is_finite()
        || !(0.001..=604800.0).contains(&resolved.duration_seconds)
        || (video_duration - resolved.duration_seconds).abs() > 2.0
        || (audio_duration - resolved.duration_seconds).abs() > 2.0
        || resolved.expires_at_unix_ms
            != Some(video.expires_at_unix_ms.min(audio.expires_at_unix_ms))
        || !video.fps.is_finite()
        || !(0.001..=120.0).contains(&video.fps)
    {
        return Err(unsupported());
    }
    let fps_numerator = (video.fps * 1000.0).round() as u32;
    if fps_numerator == 0 {
        return Err(unsupported());
    }
    let make_track =
        |probe: &mp4::Probe, key: &str, url: &str, expiry: i64, codecs: &str, bandwidth: u64| {
            Track {
                source_webm: None,
                source_video: None,
                key: key.into(),
                kind: key.into(),
                url: url.into(),
                observed_url_expires_at_ms: Some(expiry),
                codecs: codecs.into(),
                mime_type: format!("{key}/mp4"),
                bandwidth,
                start_with_sap: if key == "video" { 2 } else { 0 },
                index_start: probe.index.start,
                index_end: probe.index.end,
                initialization_start: probe.initialization.start,
                initialization_end: probe.initialization.end,
                width: None,
                height: None,
                frame_rate: None,
                sar: None,
                sampling_rate: None,
                observed_content_length: Some(probe.total_bytes),
                strong_etag: probe.strong_etag.clone(),
            }
        };
    let mut video_track = make_track(
        video_probe,
        "video",
        &video.url,
        video.expires_at_unix_ms,
        if compatibility {
            match &video_probe.codec {
                mp4::Codec::Hevc { rfc6381, .. }
                | mp4::Codec::HevcMain10 { rfc6381, .. }
                | mp4::Codec::Av1 { rfc6381, .. }
                | mp4::Codec::Vp9 { rfc6381, .. } => rfc6381,
                _ => &video.codec,
            }
        } else {
            &video.codec
        },
        video.bitrate_bps,
    );
    if compatibility && !matches!(video_probe.codec, mp4::Codec::Avc { .. }) {
        video_track.source_video = Some(
            video_probe
                .codec
                .source_expectation()
                .ok_or_else(unsupported)?,
        );
    }
    video_track.width = Some(video.width);
    video_track.height = Some(video.height);
    video_track.frame_rate = Some(format!("{fps_numerator}/1000"));
    video_track.sar = Some("1:1".into());
    let mut audio_track = make_track(
        audio_probe,
        "audio",
        &audio.url,
        audio.expires_at_unix_ms,
        &audio.codec,
        audio.bitrate_bps,
    );
    audio_track.sampling_rate = Some(audio.sample_rate);
    let descriptor = Descriptor {
        compatibility_source: if compatibility
            && !matches!(video_probe.codec, mp4::Codec::Avc { .. })
        {
            Some(descriptor::CompatibilitySource::ClearExtendedV1)
        } else {
            None
        },
        transport: Transport::Dash,
        duration_seconds: video_duration.max(audio_duration),
        min_buffer_seconds: 1.5,
        tracks: vec![video_track, audio_track],
    };
    descriptor
        .validate_for("youtube")
        .map_err(|_| unsupported())?;
    let expires = descriptor.earliest_known_expiry_ms();
    Ok((descriptor, expires))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> mp4::RangeRequest {
        mp4::RangeRequest {
            range: mp4::ByteRange { start: 0, end: 3 },
            deadline: Deadline::now() + Duration::from_secs(1),
            max_body_bytes: 4,
            expected: None,
        }
    }
    fn selected() -> (youtube::ResolvedVideo, mp4::Probe, mp4::Probe) {
        let video = youtube::AdaptiveVideo {
            container: Default::default(),
            url: "https://rr1.googlevideo.com/videoplayback?signature=private-video".into(),
            expires_at_unix_ms: 180000,
            width: 1920,
            height: 1080,
            fps: 30.0,
            codec: "avc1.640028".into(),
            bitrate_bps: 1_000_000,
        };
        let audio = youtube::AdaptiveAudio {
            url: "https://rr1.googlevideo.com/videoplayback?signature=private-audio".into(),
            expires_at_unix_ms: 190000,
            sample_rate: 48000,
            channels: 2,
            codec: "mp4a.40.2".into(),
            bitrate_bps: 192000,
        };
        let resolved = youtube::ResolvedVideo {
            content_id: "dQw4w9WgXcQ".into(),
            canonical_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
            title: "Video".into(),
            duration_seconds: 120.0,
            expires_at_unix_ms: Some(180000),
            playback: youtube::Playback::Adaptive { video, audio },
            available_heights: vec![1080],
        };
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
            segments: vec![mp4::Segment {
                range: mp4::ByteRange {
                    start: 201,
                    end: 9999,
                },
                duration_ticks: 120000,
            }],
            total_bytes: 10000,
            strong_etag: Some("\"fixture-validator\"".into()),
        };
        (
            resolved,
            probe(mp4::Codec::Avc {
                rfc6381: "avc1.640028".into(),
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
    fn selected_tracks_must_match_probed_codec_shape_timeline_and_expiry() {
        let (resolved, video_probe, audio_probe) = selected();
        let youtube::Playback::Adaptive { video, audio } = &resolved.playback else {
            unreachable!()
        };
        let (descriptor, expiry) =
            descriptor_from_probes(&resolved, video, audio, &video_probe, &audio_probe).unwrap();
        assert!(descriptor.validate_for("youtube").is_ok());
        assert_eq!(expiry, Some(180000));
        assert_eq!(descriptor.tracks[0].observed_content_length, Some(10000));
        assert_eq!(
            descriptor.tracks[0].strong_etag.as_deref(),
            Some("\"fixture-validator\"")
        );
        let mut changed = video_probe.clone();
        changed.codec = mp4::Codec::Avc {
            rfc6381: "avc1.640028".into(),
            width: 1280,
            height: 720,
        };
        assert!(descriptor_from_probes(&resolved, video, audio, &changed, &audio_probe).is_err());
        changed.codec = mp4::Codec::Avc {
            rfc6381: "avc1.640029".into(),
            width: 1920,
            height: 1080,
        };
        assert!(descriptor_from_probes(&resolved, video, audio, &changed, &audio_probe).is_err());
        let mut changed = audio_probe.clone();
        changed.codec = mp4::Codec::AacLc {
            sample_rate: 44100,
            channels: 2,
        };
        assert!(descriptor_from_probes(&resolved, video, audio, &video_probe, &changed).is_err());
        changed.codec = mp4::Codec::AacLc {
            sample_rate: 48000,
            channels: 1,
        };
        assert!(descriptor_from_probes(&resolved, video, audio, &video_probe, &changed).is_err());
        let mut changed = audio_probe.clone();
        changed.duration_ticks += 251;
        assert!(descriptor_from_probes(&resolved, video, audio, &video_probe, &changed).is_err());
        changed.duration_ticks = 120249;
        assert!(descriptor_from_probes(&resolved, video, audio, &video_probe, &changed).is_ok());
        let mut changed = resolved.clone();
        changed.duration_seconds = 123.0;
        assert!(
            descriptor_from_probes(&changed, video, audio, &video_probe, &audio_probe).is_err()
        );
        changed.duration_seconds = 120.0;
        changed.expires_at_unix_ms = Some(190000);
        assert!(
            descriptor_from_probes(&changed, video, audio, &video_probe, &audio_probe).is_err()
        );
    }

    #[tokio::test]
    async fn adapter_bounds_body_and_original_deadline_without_network() {
        let request = request();
        let body = collect_body(stream::iter([Ok(vec![1, 2]), Ok(vec![3, 4])]), &request)
            .await
            .unwrap();
        assert_eq!(body, [1, 2, 3, 4]);
        assert_eq!(
            collect_body(stream::iter([Ok(vec![1, 2, 3, 4, 5])]), &request)
                .await
                .unwrap_err(),
            mp4::ProbeError::TooLarge
        );
        assert_eq!(
            collect_body(stream::iter([Ok(vec![1, 2, 3])]), &request)
                .await
                .unwrap_err(),
            mp4::ProbeError::InvalidResponse
        );
        let mut expired = request;
        expired.deadline = Deadline::now();
        assert_eq!(
            collect_body(stream::pending(), &expired).await.unwrap_err(),
            mp4::ProbeError::Deadline
        );
    }
    #[test]
    fn adapter_retains_duplicate_framing_and_never_accepts_200() {
        let request = request();
        let mut raw = HeaderMap::new();
        raw.insert(header::CONTENT_RANGE, "bytes 0-3/5000".parse().unwrap());
        raw.insert(header::CONTENT_LENGTH, "4".parse().unwrap());
        let headers = range_headers(&raw).unwrap();
        assert!(mp4::validate_range_headers(&request, 206, &headers).is_ok());
        assert!(mp4::validate_range_headers(&request, 200, &headers).is_err());
        raw.append(header::CONTENT_LENGTH, "4".parse().unwrap());
        assert!(mp4::validate_range_headers(&request, 206, &range_headers(&raw).unwrap()).is_err());
    }
}
