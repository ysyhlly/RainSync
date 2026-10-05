//! Opt-in motion-video selection and job mapping. Production admission remains
//! on the legacy recipe until the paired Server/Worker switch is qualified.
use anyhow::{Result, anyhow, ensure};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VideoMapping {
    Absolute {
        index: u32,
    },
    /// Old jobs and catalogs with no index retain FFmpeg's first-video mapping.
    /// This is compatible interpretation, not evidence of an absolute index.
    LegacyFirstVideo,
}
impl VideoMapping {
    pub fn ffmpeg_specifier(self) -> String {
        match self {
            Self::Absolute { index } => format!("0:{index}"),
            Self::LegacyFirstVideo => "0:v:0".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoOrdering {
    AbsoluteStreamIndex,
    /// An incomplete legacy catalog preserves its existing row order.
    LegacyCatalogOrder,
}

/// Private binding facts. The digest covers the selected probe row, including
/// rotation, SAR, frame rates, pixel range and codec headers, even when a fixed
/// output candidate would otherwise remain identical after a source change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VideoSelectionIdentity {
    pub mapping: VideoMapping,
    pub ordering: VideoOrdering,
    pub stream_sha256: String,
}

pub struct SelectedMotionVideo<'a> {
    pub stream: &'a Value,
    pub identity: VideoSelectionIdentity,
}

/// Exclude only ffprobe's explicit numeric attached_pic=1. A missing
/// disposition (or an unrecognized value) retains the historical interpretation
/// as an ordinary video; it never proves that a motion stream was observed.
pub fn is_attached_picture(stream: &Value) -> bool {
    stream["disposition"]["attached_pic"].as_f64() == Some(1.0)
}

/// Prove that complete source facts select exactly the streams consumed by the
/// unchanged legacy recipe and analyzer. Compatible interpretation by `select`
/// or `select_audio` is deliberately insufficient evidence for this gate.
///
/// Every catalog row must have an identifiable type and a unique, bounded
/// absolute index. The selected motion must be explicitly marked numeric zero,
/// be the lowest-index video (covers included), and be the first JSON video.
/// Default audio must likewise be both lowest-index and first JSON audio; a
/// complete catalog without audio proves the optional `0:a:0?` map is empty.
/// Explicit audio retains its absolute intent, including `Some(0)`.
/// The caller must supply trustworthy, fresh, complete ffprobe input; this pure
/// predicate cannot establish metadata freshness or source authenticity.
pub fn legacy_mapping_equivalent(meta: &Value, requested_audio: Option<u32>) -> Result<()> {
    let unsupported = || anyhow!("legacy_stream_mapping_unsupported");
    let streams = meta["streams"].as_array().ok_or_else(unsupported)?;
    if let Some(requested) = requested_audio {
        // Check the explicit intent across all types before the generic catalog
        // refusal so a cross-type duplicate cannot masquerade as valid audio.
        let mut matching = streams
            .iter()
            .filter(|row| row["index"].as_u64() == Some(u64::from(requested)));
        let audio = matching
            .next()
            .ok_or_else(|| anyhow!("invalid_audio_track"))?;
        ensure!(
            audio["codec_type"] == "audio" && matching.next().is_none(),
            "invalid_audio_track"
        );
    }
    let mut seen = std::collections::BTreeSet::new();
    let indexed = streams
        .iter()
        .map(|row| {
            ensure!(
                matches!(
                    row["codec_type"].as_str(),
                    Some("video" | "audio" | "subtitle" | "data" | "attachment")
                ),
                "legacy_stream_mapping_unsupported"
            );
            let index = row["index"]
                .as_u64()
                .and_then(|index| u32::try_from(index).ok())
                .ok_or_else(unsupported)?;
            ensure!(seen.insert(index), "legacy_stream_mapping_unsupported");
            Ok((row, index))
        })
        .collect::<Result<Vec<_>>>()?;
    let videos: Vec<_> = indexed
        .iter()
        .filter(|(row, _)| row["codec_type"] == "video")
        .collect();
    let first_video = videos.first().ok_or_else(unsupported)?;
    let lowest_video = videos.iter().min_by_key(|(_, index)| *index).unwrap();
    let motion = videos
        .iter()
        .filter(|(row, _)| !is_attached_picture(row))
        .min_by_key(|(_, index)| *index)
        .ok_or_else(unsupported)?;
    ensure!(
        motion.0["disposition"]["attached_pic"].as_f64() == Some(0.0)
            && motion.1 == lowest_video.1
            && motion.1 == first_video.1,
        "legacy_stream_mapping_unsupported"
    );
    if requested_audio.is_none() {
        let audio: Vec<_> = indexed
            .iter()
            .filter(|(row, _)| row["codec_type"] == "audio")
            .collect();
        if let Some(first_audio) = audio.first() {
            let lowest_audio = audio.iter().min_by_key(|(_, index)| *index).unwrap();
            ensure!(
                first_audio.1 == lowest_audio.1,
                "legacy_stream_mapping_unsupported"
            );
        }
    }
    Ok(())
}

fn index(stream: &Value) -> Result<Option<u32>> {
    match stream.get("index") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| anyhow!("invalid_video_stream_index")),
    }
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut rows: Vec<_> = object.iter().collect();
            rows.sort_unstable_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                rows.into_iter()
                    .map(|(k, v)| (k.clone(), canonical(v)))
                    .collect(),
            )
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

/// Complete catalogs choose the lowest absolute stream index, independent of
/// JSON row order. Incomplete catalogs preserve first-video order. An omitted
/// selected index can only use the legacy mapping when that row is the first
/// source video; a cover-first catalog must provide an actual absolute index.
pub fn select(meta: &Value) -> Result<SelectedMotionVideo<'_>> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow!("no_streams"))?;
    let videos: Vec<_> = streams
        .iter()
        .filter(|row| row["codec_type"] == "video")
        .collect();
    let mut motion: Vec<_> = videos
        .iter()
        .copied()
        .filter(|row| !is_attached_picture(row))
        .map(|row| Ok((row, index(row)?)))
        .collect::<Result<_>>()?;
    ensure!(!motion.is_empty(), "no_motion_video");
    let ordering = if motion.iter().all(|(_, index)| index.is_some()) {
        motion.sort_unstable_by_key(|(_, index)| index.expect("complete catalog"));
        VideoOrdering::AbsoluteStreamIndex
    } else {
        VideoOrdering::LegacyCatalogOrder
    };
    let (stream, selected_index) = motion[0];
    let mapping = if let Some(index) = selected_index {
        // Never confuse a row position, video ordinal or duplicate stream ID
        // with the absolute input-stream index used by FFmpeg's 0:<index>.
        ensure!(
            streams
                .iter()
                .filter(|row| row["index"].as_u64() == Some(u64::from(index)))
                .count()
                == 1,
            "invalid_video_stream_index"
        );
        VideoMapping::Absolute { index }
    } else {
        ensure!(
            std::ptr::eq(stream, videos[0]),
            "video_stream_index_required"
        );
        VideoMapping::LegacyFirstVideo
    };
    let stream_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(stream))?)
    );
    Ok(SelectedMotionVideo {
        stream,
        identity: VideoSelectionIdentity {
            mapping,
            ordering,
            stream_sha256,
        },
    })
}

/// Audio facts and source-recipe mapping use the same opt-in selection. Explicit
/// intent is an absolute index. Complete default catalogs choose the lowest
/// absolute index, matching FFmpeg's first audio stream even if JSON rows move.
/// Incomplete catalogs retain documented legacy row order; omitted indices are
/// never replaced with row positions.
pub fn select_audio(meta: &Value, requested: Option<u32>) -> Result<Option<&Value>> {
    let streams = meta["streams"]
        .as_array()
        .ok_or_else(|| anyhow!("no_streams"))?;
    let audio: Vec<_> = streams
        .iter()
        .filter(|row| row["codec_type"] == "audio")
        .collect();
    let selected = if let Some(requested) = requested {
        let mut matches = audio
            .iter()
            .copied()
            .filter(|row| row["index"].as_u64() == Some(u64::from(requested)));
        let row = matches
            .next()
            .ok_or_else(|| anyhow!("invalid_audio_track"))?;
        ensure!(matches.next().is_none(), "invalid_audio_track");
        Some(row)
    } else {
        let indexed: Vec<_> = audio
            .iter()
            .copied()
            .map(|row| {
                index(row)
                    .map(|index| (row, index))
                    .map_err(|_| anyhow!("invalid_audio_track"))
            })
            .collect::<Result<_>>()?;
        if indexed.iter().all(|(_, index)| index.is_some()) {
            indexed
                .into_iter()
                .min_by_key(|(_, index)| *index)
                .map(|(row, _)| row)
        } else {
            audio.first().copied()
        }
    };
    if let Some(row) = selected
        && let Some(index) = index(row).map_err(|_| anyhow!("invalid_audio_track"))?
    {
        ensure!(
            streams
                .iter()
                .filter(|row| row["index"].as_u64() == Some(u64::from(index)))
                .count()
                == 1,
            "invalid_audio_track"
        );
    }
    Ok(selected)
}

/// Resolve the selected audio row to the actual absolute index for the opt-in
/// source recipe. None means no audio, or an index-less compatible first-audio
/// interpretation; callers then retain the optional legacy 0:a:0? mapping.
pub fn selected_audio_index(meta: &Value, requested: Option<u32>) -> Result<Option<u32>> {
    select_audio(meta, requested)?
        .map(index)
        .transpose()
        .map(Option::flatten)
        .map_err(|_| anyhow!("invalid_audio_track"))
}

/// New Worker parsing contract, intentionally not wired to production yet.
/// Absent video_index preserves old queued specs; a present malformed value
/// fails rather than silently reverting to first-video selection. Old Workers
/// ignore this field, so it is NOT a mixed-version admission boundary.
pub fn job_mapping(spec: &Value) -> Result<VideoMapping> {
    match spec.get("video_index") {
        None => Ok(VideoMapping::LegacyFirstVideo),
        Some(value) => value
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(|index| VideoMapping::Absolute { index })
            .ok_or_else(|| anyhow!("invalid_video_stream_index")),
    }
}

pub fn require_same_selection(meta: &Value, expected: &VideoSelectionIdentity) -> Result<()> {
    ensure!(&select(meta)?.identity == expected, "source_changed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities::{
        analyze_motion_source, negotiated_hls_args_for_video, validate_motion_source,
    };
    use protocol::PlaybackRouteReason as Reason;
    use serde_json::json;

    fn film(index: u32) -> Value {
        json!({"index":index,"codec_type":"video","codec_name":"h264","codec_tag_string":"avc1",
            "pix_fmt":"yuv420p","width":640,"height":360,"avg_frame_rate":"25/1","r_frame_rate":"25/1",
            "extradata":"\n00000000: 0164 000d ffe1 0000                      .d......\n",
            "disposition":{"attached_pic":0}})
    }
    fn cover(index: u32) -> Value {
        json!({"index":index,"codec_type":"video","codec_name":"mjpeg","pix_fmt":"rgb48le",
            "width":300,"height":300,"avg_frame_rate":"0/0","r_frame_rate":"0/0",
            "disposition":{"attached_pic":1},"tags":{"rotate":"90"}})
    }
    fn meta(rows: Vec<Value>) -> Value {
        json!({"format":{"format_name":"mov,mp4","tags":{"major_brand":"isom"},"bit_rate":"1000000"},"streams":rows})
    }
    fn offered(meta: &Value) -> Vec<String> {
        analyze_motion_source(meta, None, 0.0)
            .unwrap()
            .candidates
            .into_iter()
            .map(|c| c.id)
            .collect()
    }

    #[test]
    fn strict_legacy_equivalence_accepts_complete_ordinary_and_cover_last_catalogs() {
        for rows in [
            vec![film(0)],
            vec![film(7), cover(42)],
            vec![film(7), film(42)],
            vec![
                json!({"codec_type":"audio","index":0}),
                film(7),
                json!({"codec_type":"subtitle","index":2}),
                json!({"codec_type":"audio","index":42}),
                cover(u32::MAX),
            ],
        ] {
            legacy_mapping_equivalent(&meta(rows), None).unwrap();
        }
        for kind in ["subtitle", "data", "attachment"] {
            legacy_mapping_equivalent(
                &meta(vec![film(7), json!({"codec_type":kind,"index":0})]),
                None,
            )
            .unwrap();
        }
    }

    #[test]
    fn strict_legacy_equivalence_keeps_explicit_alternate_and_zero_audio_intent() {
        let m = meta(vec![
            film(7),
            json!({"codec_type":"audio","index":42}),
            json!({"codec_type":"audio","index":0}),
        ]);
        assert_eq!(
            legacy_mapping_equivalent(&m, None).unwrap_err().to_string(),
            "legacy_stream_mapping_unsupported"
        );
        for requested in [0, 42] {
            legacy_mapping_equivalent(&m, Some(requested)).unwrap();
            let args = crate::capabilities::negotiated_hls_args(
                "input",
                "index.m3u8",
                0.0,
                "remux",
                Some(requested),
            );
            let maps: Vec<_> = args
                .windows(2)
                .filter(|pair| pair[0] == "-map")
                .map(|pair| pair[1].as_str())
                .collect();
            let expected_audio = format!("0:{requested}");
            assert_eq!(maps, ["0:v:0", expected_audio.as_str()]);
        }
    }

    #[test]
    fn strict_legacy_equivalence_refuses_cover_first_and_reordered_video_even_same_codec() {
        for rows in [
            vec![cover(0), film(7)],
            vec![cover(42), film(7)],
            vec![film(7), cover(0)],
            vec![film(42), film(7)],
        ] {
            let m = meta(rows);
            assert!(select(&m).is_ok());
            assert_eq!(
                legacy_mapping_equivalent(&m, None).unwrap_err().to_string(),
                "legacy_stream_mapping_unsupported"
            );
        }
    }

    #[test]
    fn strict_legacy_equivalence_refuses_reordered_default_audio_even_same_codec() {
        let m = meta(vec![
            film(1),
            json!({"codec_type":"audio","codec_name":"aac","index":42}),
            json!({"codec_type":"audio","codec_name":"aac","index":3}),
        ]);
        assert_eq!(select_audio(&m, None).unwrap().unwrap()["index"], 3);
        assert_eq!(
            legacy_mapping_equivalent(&m, None).unwrap_err().to_string(),
            "legacy_stream_mapping_unsupported"
        );
        legacy_mapping_equivalent(&m, Some(42)).unwrap();
        legacy_mapping_equivalent(&m, Some(3)).unwrap();
    }

    #[test]
    fn strict_legacy_equivalence_requires_complete_inventory_and_all_absolute_indices() {
        legacy_mapping_equivalent(&meta(vec![film(7)]), None).unwrap();
        for m in [
            json!({}),
            json!({"streams":null}),
            json!({"streams":{}}),
            meta(vec![]),
        ] {
            assert_eq!(
                legacy_mapping_equivalent(&m, None).unwrap_err().to_string(),
                "legacy_stream_mapping_unsupported"
            );
        }
        for kind in ["video", "audio", "subtitle", "data", "attachment"] {
            for malformed in [
                Value::Null,
                json!("3"),
                json!(true),
                json!(-1),
                json!(3.5),
                json!(4294967296u64),
            ] {
                let mut other = json!({"codec_type":kind,"index":3});
                other["index"] = malformed;
                assert_eq!(
                    legacy_mapping_equivalent(&meta(vec![film(0), other]), None)
                        .unwrap_err()
                        .to_string(),
                    "legacy_stream_mapping_unsupported"
                );
            }
            assert!(
                legacy_mapping_equivalent(&meta(vec![film(0), json!({"codec_type":kind})]), None)
                    .is_err()
            );
        }
        let mut missing = film(7);
        missing.as_object_mut().unwrap().remove("index");
        let m = meta(vec![missing]);
        assert!(select(&m).is_ok());
        assert!(legacy_mapping_equivalent(&m, None).is_err());
    }

    #[test]
    fn strict_legacy_equivalence_requires_identifiable_types_and_cross_type_unique_indices() {
        for row in [
            json!({"index":3}),
            json!({"codec_type":"unknown","index":3}),
            json!({"codec_type":"future_type","index":3}),
            json!({"codec_type":false,"index":3}),
            json!(null),
            json!("stream"),
        ] {
            assert!(legacy_mapping_equivalent(&meta(vec![film(0), row]), None).is_err());
        }
        for kind in ["video", "audio", "subtitle", "data", "attachment"] {
            assert!(
                legacy_mapping_equivalent(
                    &meta(vec![film(0), json!({"codec_type":kind,"index":0})]),
                    None
                )
                .is_err()
            );
            // Duplicates on unselected streams also invalidate the inventory.
            assert!(
                legacy_mapping_equivalent(
                    &meta(vec![
                        film(0),
                        cover(3),
                        json!({"codec_type":kind,"index":3}),
                    ]),
                    None
                )
                .is_err()
            );
        }
    }

    #[test]
    fn strict_legacy_equivalence_reports_absent_or_ambiguous_explicit_audio() {
        assert_eq!(
            legacy_mapping_equivalent(&meta(vec![film(7)]), Some(0))
                .unwrap_err()
                .to_string(),
            "invalid_audio_track"
        );
        for kind in ["video", "audio", "subtitle", "data", "attachment"] {
            let m = meta(vec![
                film(7),
                json!({"codec_type":"audio","index":0}),
                json!({"codec_type":kind,"index":0}),
            ]);
            assert_eq!(
                legacy_mapping_equivalent(&m, Some(0))
                    .unwrap_err()
                    .to_string(),
                "invalid_audio_track"
            );
        }
        assert_eq!(
            legacy_mapping_equivalent(&meta(vec![film(0)]), Some(0))
                .unwrap_err()
                .to_string(),
            "invalid_audio_track"
        );
    }

    #[test]
    fn strict_legacy_equivalence_requires_explicit_numeric_zero_motion_disposition() {
        for value in [json!(0), json!(0.0)] {
            let mut m = meta(vec![film(7)]);
            m["streams"][0]["disposition"]["attached_pic"] = value;
            legacy_mapping_equivalent(&m, None).unwrap();
        }
        for value in [
            Value::Null,
            json!("0"),
            json!(false),
            json!(true),
            json!(1),
            json!(2),
        ] {
            let mut m = meta(vec![film(7)]);
            m["streams"][0]["disposition"]["attached_pic"] = value;
            assert!(legacy_mapping_equivalent(&m, None).is_err());
        }
        let mut m = meta(vec![film(7)]);
        m["streams"][0]["disposition"] = json!({});
        assert!(legacy_mapping_equivalent(&m, None).is_err());
        m["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("disposition");
        assert!(select(&m).is_ok());
        assert!(legacy_mapping_equivalent(&m, None).is_err());
    }

    #[test]
    fn cover_first_and_last_select_motion_without_broadening_direct() {
        for rows in [vec![cover(0), film(9)], vec![film(9), cover(12)]] {
            let m = meta(rows);
            let selected = validate_motion_source(&m).unwrap();
            assert_eq!(
                selected.identity.mapping,
                VideoMapping::Absolute { index: 9 }
            );
            assert_eq!(selected.stream["width"], 640);
            assert_eq!(offered(&m), ["remux", "transcode_720p"]);
            assert_eq!(
                analyze_motion_source(&m, None, 0.0)
                    .unwrap()
                    .route_decisions[0]
                    .reason,
                Reason::TrackMappingRequired
            );
        }
        assert!(offered(&meta(vec![film(0)])).contains(&"direct".into()));
    }

    #[test]
    fn noncontiguous_indices_and_multiple_motion_use_canonical_absolute_order() {
        let m = meta(vec![
            film(42),
            json!({"codec_type":"audio","index":3}),
            cover(1),
            film(7),
        ]);
        let selected = select(&m).unwrap();
        assert_eq!(
            selected.identity.mapping,
            VideoMapping::Absolute { index: 7 }
        );
        assert_eq!(
            selected.identity.ordering,
            VideoOrdering::AbsoluteStreamIndex
        );
        assert_eq!(selected.identity.mapping.ffmpeg_specifier(), "0:7");
        let mut reordered = m.clone();
        reordered["streams"].as_array_mut().unwrap().reverse();
        assert_eq!(select(&reordered).unwrap().identity, selected.identity);
        assert!(!offered(&m).contains(&"direct".into()));
    }

    #[test]
    fn explicit_numeric_attached_pic_is_the_only_cover_indicator() {
        for value in [json!(1), json!(1.0)] {
            let mut m = meta(vec![film(0)]);
            m["streams"][0]["disposition"]["attached_pic"] = value;
            assert_eq!(select(&m).err().unwrap().to_string(), "no_motion_video");
        }
        for value in [Value::Null, json!(0), json!("1"), json!(true), json!(2)] {
            let mut m = meta(vec![film(0)]);
            m["streams"][0]["disposition"]["attached_pic"] = value;
            assert!(select(&m).is_ok());
        }
        let mut m = meta(vec![film(0)]);
        m["streams"][0]
            .as_object_mut()
            .unwrap()
            .remove("disposition");
        assert!(select(&m).is_ok());
    }

    #[test]
    fn missing_catalog_facts_keep_explicit_legacy_interpretation() {
        let mut unknown = film(0);
        unknown.as_object_mut().unwrap().remove("index");
        unknown.as_object_mut().unwrap().remove("disposition");
        let m = meta(vec![unknown.clone(), film(9)]);
        let selected = select(&m).unwrap();
        assert_eq!(selected.identity.mapping, VideoMapping::LegacyFirstVideo);
        assert_eq!(
            selected.identity.ordering,
            VideoOrdering::LegacyCatalogOrder
        );
        assert_eq!(selected.identity.mapping.ffmpeg_specifier(), "0:v:0");
        let cover_first = meta(vec![cover(0), unknown]);
        assert_eq!(
            select(&cover_first).err().unwrap().to_string(),
            "video_stream_index_required"
        );
    }

    #[test]
    fn malformed_or_duplicate_absolute_indices_never_use_array_positions() {
        for index in [json!(-1), json!(1.5), json!("7"), json!(4294967296u64)] {
            let mut m = meta(vec![film(7)]);
            m["streams"][0]["index"] = index;
            assert_eq!(
                select(&m).err().unwrap().to_string(),
                "invalid_video_stream_index"
            );
        }
        for other in [film(7), json!({"codec_type":"audio","index":7}), cover(7)] {
            assert_eq!(
                select(&meta(vec![film(7), other]))
                    .err()
                    .unwrap()
                    .to_string(),
                "invalid_video_stream_index"
            );
        }
    }

    #[test]
    fn cover_only_and_audio_only_explain_all_video_routes_as_not_offered() {
        for rows in [
            vec![cover(0)],
            vec![json!({"codec_type":"audio","index":5})],
            vec![],
        ] {
            let m = meta(rows);
            let analysis = analyze_motion_source(&m, None, 0.0).unwrap();
            assert!(analysis.candidates.is_empty());
            assert_eq!(analysis.route_decisions.len(), 4);
            assert!(
                analysis
                    .route_decisions
                    .iter()
                    .all(|d| !d.offered && d.reason == Reason::VideoConfigurationUnavailable)
            );
        }
        assert!(analyze_motion_source(&json!({}), None, 0.0).is_err());
    }

    #[test]
    fn selected_rotation_vfr_and_sar_drive_transform_not_other_video_facts() {
        for fact in [
            json!({"tags":{"rotate":"90"}}),
            json!({"r_frame_rate":"50/1","avg_frame_rate":"25/1"}),
            json!({"sample_aspect_ratio":"16:15"}),
        ] {
            let mut selected = film(7);
            selected
                .as_object_mut()
                .unwrap()
                .extend(fact.as_object().unwrap().clone());
            let m = meta(vec![cover(0), selected, film(12)]);
            assert_eq!(offered(&m), ["transcode_720p"]);
            let mut other = film(12);
            other
                .as_object_mut()
                .unwrap()
                .extend(fact.as_object().unwrap().clone());
            let m = meta(vec![cover(0), film(7), other]);
            assert_eq!(offered(&m), ["remux", "transcode_720p"]);
        }
    }

    #[test]
    fn selected_depth_range_and_global_protection_are_preserved() {
        let mut high = film(7);
        high["pix_fmt"] = json!("p010le");
        let mut m = meta(vec![cover(0), high.clone()]);
        assert_eq!(
            validate_motion_source(&m).err().unwrap().to_string(),
            "unclassified_video_range"
        );
        m["streams"][1]["color_transfer"] = json!("bt709");
        assert_eq!(offered(&m), ["transcode_720p"]);
        m["streams"][1]["color_transfer"] = json!("smpte2084");
        assert_eq!(
            validate_motion_source(&m).err().unwrap().to_string(),
            "hdr_unsupported"
        );
        for stream in [0, 1, 2] {
            let mut m = meta(vec![cover(0), film(7), film(12)]);
            m["streams"][stream]["codec_tag_string"] = json!("encv");
            assert_eq!(
                validate_motion_source(&m).err().unwrap().to_string(),
                "drm_unsupported"
            );
        }
        let mut unselected = film(12);
        unselected["pix_fmt"] = json!("p010le");
        unselected["color_transfer"] = json!("smpte2084");
        assert_eq!(
            offered(&meta(vec![cover(0), film(7), unselected])),
            ["remux", "transcode_720p"]
        );
    }

    #[test]
    fn selected_source_changes_are_bound_even_for_same_fixed_output() {
        let m = meta(vec![cover(0), film(7), film(12)]);
        let identity = select(&m).unwrap().identity;
        require_same_selection(&m, &identity).unwrap();
        for (field, value) in [
            ("index", json!(8)),
            ("width", json!(1920)),
            ("sample_aspect_ratio", json!("16:15")),
            ("pix_fmt", json!("yuv422p")),
            ("avg_frame_rate", json!("24/1")),
            ("tags", json!({"rotate":"90"})),
        ] {
            let mut changed = m.clone();
            changed["streams"][1][field] = value;
            let before = analyze_motion_source(&m, None, 0.0)
                .unwrap()
                .candidates
                .pop()
                .unwrap();
            let after = analyze_motion_source(&changed, None, 0.0)
                .unwrap()
                .candidates
                .pop()
                .unwrap();
            assert_eq!(
                serde_json::to_value(before).unwrap(),
                serde_json::to_value(after).unwrap()
            );
            assert_eq!(
                require_same_selection(&changed, &identity)
                    .unwrap_err()
                    .to_string(),
                "source_changed"
            );
        }
    }

    #[test]
    fn provenance_requires_selection_and_exact_current_configuration() {
        let m = meta(vec![cover(0), film(7)]);
        let identity = select(&m).unwrap().identity;
        let analysis = analyze_motion_source(&m, None, 0.0).unwrap();
        for candidate in analysis.candidates {
            crate::capabilities::require_current_motion_candidate(
                &m, &identity, &candidate, None, 0.0,
            )
            .unwrap();
            let mut changed = m.clone();
            changed["streams"][1]["index"] = json!(8);
            assert_eq!(
                crate::capabilities::require_current_motion_candidate(
                    &changed, &identity, &candidate, None, 0.0
                )
                .unwrap_err()
                .to_string(),
                "source_changed"
            );
            let mut contradictory = candidate.clone();
            contradictory.video.width += 1;
            assert_eq!(
                crate::capabilities::require_current_motion_candidate(
                    &m,
                    &identity,
                    &contradictory,
                    None,
                    0.0
                )
                .unwrap_err()
                .to_string(),
                "source_changed"
            );
        }
        // A separately selected audio index is still validated by analysis.
        assert!(
            crate::capabilities::require_current_motion_candidate(
                &m,
                &identity,
                &analyze_motion_source(&m, None, 0.0).unwrap().candidates[0],
                Some(77),
                0.0
            )
            .is_err()
        );
    }

    #[test]
    fn compatible_motion_mode_preserves_total_video_direct_and_selected_transform() {
        assert_eq!(
            crate::compatible_motion_mode(&meta(vec![film(0)]), false).unwrap(),
            "direct"
        );
        assert_eq!(
            crate::compatible_motion_mode(&meta(vec![cover(0), film(7)]), false).unwrap(),
            "remux"
        );
        assert_eq!(
            crate::compatible_motion_mode(&meta(vec![film(0), film(7)]), false).unwrap(),
            "remux"
        );
        assert_eq!(
            crate::compatible_motion_mode(
                &meta(vec![
                    film(0),
                    json!({"codec_type":"audio","codec_name":"aac","index":1}),
                    json!({"codec_type":"audio","codec_name":"aac","index":2})
                ]),
                false
            )
            .unwrap(),
            "remux"
        );
        let mut rotated = film(7);
        rotated["tags"]["rotate"] = json!(90);
        assert_eq!(
            crate::compatible_motion_mode(&meta(vec![cover(0), rotated]), false).unwrap(),
            "transcode"
        );
        assert!(crate::compatible_motion_mode(&meta(vec![cover(0)]), false).is_err());
    }

    #[test]
    fn reordered_default_audio_facts_provenance_and_mapping_agree() {
        let aac = json!({"codec_type":"audio","index":42,"codec_name":"aac","profile":"LC",
            "sample_rate":"48000","channels":2,"bit_rate":"128000",
            "extradata":"\n00000000: 1190                                     ..\n"});
        let ac3 = json!({"codec_type":"audio","index":3,"codec_name":"ac3",
            "sample_rate":"48000","channels":2,"bit_rate":"192000"});
        let m = meta(vec![film(1), aac, ac3]);
        assert_eq!(select_audio(&m, None).unwrap().unwrap()["index"], 3);
        assert_eq!(selected_audio_index(&m, None).unwrap(), Some(3));
        let analysis = analyze_motion_source(&m, None, 0.0).unwrap();
        assert!(
            !analysis
                .candidates
                .iter()
                .any(|candidate| candidate.id == "remux")
        );
        let identity = select(&m).unwrap().identity;
        for candidate in &analysis.candidates {
            crate::capabilities::require_current_motion_candidate(
                &m, &identity, candidate, None, 0.0,
            )
            .unwrap();
        }
        let args = crate::capabilities::negotiated_hls_args_for_motion_source(
            &m,
            "input",
            "index.m3u8",
            0.0,
            "audio_transcode",
            None,
        )
        .unwrap();
        let maps: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "-map")
            .map(|pair| pair[1].as_str())
            .collect();
        assert_eq!(maps, ["0:1", "0:3"]);
        let explicit = analyze_motion_source(&m, Some(42), 0.0).unwrap();
        let copied = explicit
            .candidates
            .iter()
            .find(|candidate| candidate.id == "remux")
            .unwrap();
        crate::capabilities::require_current_motion_candidate(&m, &identity, copied, None, 0.0)
            .unwrap_err();
        let explicit_args = crate::capabilities::negotiated_hls_args_for_motion_source(
            &m,
            "input",
            "index.m3u8",
            0.0,
            "remux",
            Some(42),
        )
        .unwrap();
        assert!(
            explicit_args
                .windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "0:42")
        );
        let mut reordered = m.clone();
        reordered["streams"].as_array_mut().unwrap().reverse();
        assert_eq!(
            serde_json::to_value(analysis.candidates).unwrap(),
            serde_json::to_value(
                analyze_motion_source(&reordered, None, 0.0)
                    .unwrap()
                    .candidates
            )
            .unwrap()
        );
        assert_eq!(
            crate::capabilities::negotiated_hls_args_for_motion_source(
                &reordered,
                "input",
                "index.m3u8",
                0.0,
                "audio_transcode",
                None
            )
            .unwrap(),
            args
        );
        // Legacy APIs preserve their previous row-first audio interpretation.
        assert!(
            crate::capabilities::analyze(&m, None, 0.0)
                .unwrap()
                .candidates
                .iter()
                .any(|candidate| candidate.id == "remux")
        );
        assert!(
            crate::capabilities::negotiated_hls_args("input", "index.m3u8", 0.0, "remux", None)
                .windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "0:a:0?")
        );
        assert!(
            crate::hls_args_for_motion_source(&m, "input", "index.m3u8", 0.0, false, None)
                .unwrap()
                .windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "0:3")
        );
    }

    #[test]
    fn incomplete_or_ambiguous_audio_indices_remain_explicit() {
        let mut missing = json!({"codec_type":"audio","codec_name":"ac3"});
        let m = meta(vec![
            film(0),
            missing.clone(),
            json!({"codec_type":"audio","index":42,"codec_name":"aac"}),
        ]);
        assert_eq!(
            select_audio(&m, None).unwrap().unwrap()["codec_name"],
            "ac3"
        );
        assert_eq!(selected_audio_index(&m, None).unwrap(), None);
        assert!(
            crate::capabilities::negotiated_hls_args_for_motion_source(
                &m,
                "input",
                "index.m3u8",
                0.0,
                "transcode",
                None
            )
            .unwrap()
            .windows(2)
            .any(|pair| pair[0] == "-map" && pair[1] == "0:a:0?")
        );
        for value in [json!(-1), json!(1.5), json!("3"), json!(4294967296u64)] {
            missing["index"] = value;
            assert!(select_audio(&meta(vec![film(0), missing.clone()]), None).is_err());
        }
        let duplicate = meta(vec![
            film(0),
            json!({"codec_type":"audio","index":3}),
            json!({"codec_type":"audio","index":3}),
        ]);
        assert!(select_audio(&duplicate, None).is_err());
        assert!(select_audio(&duplicate, Some(3)).is_err());
        assert!(select_audio(&meta(vec![film(0)]), Some(3)).is_err());
        assert_eq!(
            selected_audio_index(&meta(vec![film(0)]), None).unwrap(),
            None
        );
    }

    #[test]
    fn paired_recipes_map_selected_video_keep_audio_and_legacy_jobs() {
        let mapping = VideoMapping::Absolute { index: 7 };
        for mode in ["remux", "audio_transcode", "transcode"] {
            for start in [0.0, 9.0] {
                let args = negotiated_hls_args_for_video(
                    "input",
                    "index.m3u8",
                    start,
                    mode,
                    mapping,
                    Some(42),
                );
                let maps: Vec<_> = args
                    .windows(2)
                    .filter(|p| p[0] == "-map")
                    .map(|p| p[1].as_str())
                    .collect();
                assert_eq!(maps, ["0:7", "0:42"]);
                let legacy = crate::capabilities::negotiated_hls_args(
                    "input",
                    "index.m3u8",
                    start,
                    mode,
                    Some(42),
                );
                let mut expected = legacy.clone();
                let position = expected.iter().position(|a| a == "0:v:0").unwrap();
                expected[position] = "0:7".into();
                assert_eq!(args, expected);
            }
        }
        let mut expected = crate::hls_args("input", "index.m3u8", 9.0, false, Some(42));
        let position = expected.iter().position(|a| a == "0:v:0").unwrap();
        expected[position] = "0:7".into();
        assert_eq!(
            crate::hls_args_for_video("input", "index.m3u8", 9.0, false, mapping, Some(42)),
            expected
        );
        assert_eq!(
            job_mapping(&json!({"audio_index":42})).unwrap(),
            VideoMapping::LegacyFirstVideo
        );
        assert_eq!(
            job_mapping(&json!({"video_index":0})).unwrap(),
            VideoMapping::Absolute { index: 0 }
        );
        assert_eq!(job_mapping(&json!({"video_index":7})).unwrap(), mapping);
        for value in [
            Value::Null,
            json!(-1),
            json!(1.5),
            json!("7"),
            json!(4294967296u64),
        ] {
            assert!(job_mapping(&json!({"video_index":value})).is_err());
        }
    }
}
