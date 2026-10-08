//! Metadata-only captions from yt-dlp TikTokBaseIE._get_subtitles.
//! https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py
//! No mirror, signature/challenge solver, arbitrary data URL or borrowed cookie.
use super::*;
use crate::platform::text::{
    self, Availability, Catalog, Endpoint, SubtitleDescriptor, SubtitleFormat, SubtitleTrack,
};
use sha2::{Digest, Sha256};
pub(super) fn parse(resource: &VideoRef, item: &Value) -> Result<Catalog> {
    let video = object(
        item.get("video")
            .ok_or(Error::InvalidResponse("caption_video"))?,
    )?;
    let mut candidates = Vec::new();
    let mut declared = false;
    if let Some(raw) = optional_alias(video, &["subtitleInfos"])? {
        declared = true;
        let tracks = raw
            .as_array()
            .ok_or(Error::InvalidResponse("caption_tracks"))?;
        if tracks.len() > text::MAX_TRACKS {
            return Err(Error::TooLarge);
        }
        for track in tracks {
            let obj = object(track)?;
            candidates.push((
                required_alias(obj, &["Url"])?
                    .as_str()
                    .ok_or(Error::InvalidResponse("caption_url"))?,
                required_alias(obj, &["LanguageCodeName"])?
                    .as_str()
                    .ok_or(Error::InvalidResponse("caption_language"))?,
                required_alias(obj, &["Format"])?
                    .as_str()
                    .ok_or(Error::InvalidResponse("caption_format"))?,
                matches!(
                    obj.get("Source").and_then(Value::as_str),
                    Some("ASR" | "MT")
                ) || obj.get("isAutoGen").and_then(Value::as_bool) == Some(true),
                caption_role(obj)?,
            ));
        }
    }
    if let Some(cla) = optional_alias(video, &["cla_info", "claInfo"])? {
        let cla = object(cla)?;
        if let Some(raw) = optional_alias(cla, &["caption_infos", "captionInfos"])? {
            declared = true;
            let tracks = raw
                .as_array()
                .ok_or(Error::InvalidResponse("caption_tracks"))?;
            if tracks.len() > text::MAX_TRACKS {
                return Err(Error::TooLarge);
            }
            for track in tracks {
                let obj = object(track)?;
                candidates.push((
                    required_alias(obj, &["url", "Url"])?
                        .as_str()
                        .ok_or(Error::InvalidResponse("caption_url"))?,
                    required_alias(obj, &["lang", "LanguageCodeName"])?
                        .as_str()
                        .ok_or(Error::InvalidResponse("caption_language"))?,
                    required_alias(obj, &["Format"])?
                        .as_str()
                        .ok_or(Error::InvalidResponse("caption_format"))?,
                    matches!(
                        obj.get("Source").and_then(Value::as_str),
                        Some("ASR" | "MT")
                    ) || obj.get("isAutoGen").and_then(Value::as_bool) == Some(true),
                    caption_role(obj)?,
                ));
            }
        }
    }
    if let Some(raw) = item.get("interaction_stickers") {
        let stickers = raw
            .as_array()
            .ok_or(Error::InvalidResponse("caption_stickers"))?;
        if stickers.len() > 64 {
            return Err(Error::TooLarge);
        }
        for sticker in stickers {
            if let Some(raw) = sticker.pointer("/auto_video_caption_info/auto_captions") {
                declared = true;
                let tracks = raw
                    .as_array()
                    .ok_or(Error::InvalidResponse("caption_tracks"))?;
                if tracks.len() > text::MAX_TRACKS {
                    return Err(Error::TooLarge);
                }
                for track in tracks {
                    let obj = object(track)?;
                    let urls = obj
                        .get("url")
                        .and_then(|v| v.get("url_list"))
                        .and_then(Value::as_array)
                        .ok_or(Error::InvalidResponse("caption_urls"))?;
                    if urls.len() != 1 {
                        return Err(Error::Restricted("caption_url_ambiguous"));
                    }
                    candidates.push((
                        urls[0]
                            .as_str()
                            .ok_or(Error::InvalidResponse("caption_url"))?,
                        obj.get("language")
                            .and_then(Value::as_str)
                            .ok_or(Error::InvalidResponse("caption_language"))?,
                        "utterances_json",
                        true,
                        "ASR",
                    ));
                }
            }
        }
    }
    if candidates.len() > text::MAX_TRACKS {
        return Err(Error::TooLarge);
    }
    let mut tracks = Vec::new();
    let mut seen = BTreeMap::new();
    let endpoint = if resource.platform == Platform::Douyin {
        Endpoint::DouyinCaption
    } else {
        Endpoint::TikTokCaption
    };
    let prefix = if resource.platform == Platform::Douyin {
        "dy"
    } else {
        "tt"
    };
    for (url, language, format_name, automatic, role) in candidates {
        if !text::language(language) {
            return Err(Error::InvalidResponse("caption_language"));
        }
        let format = match format_name {
            "webvtt" => SubtitleFormat::ByteDanceVtt,
            "srt" => SubtitleFormat::ByteDanceSrt,
            "utterances_json" => SubtitleFormat::ByteDanceJson,
            _ => return Err(Error::Restricted("caption_format_unsupported")),
        };
        text::validate_text_url(endpoint, url, Some(&resource.id))
            .map_err(|_| Error::Restricted("caption_origin_or_path_unsupported"))?;
        // Position and signed delivery URLs are not track identities. The
        // supported metadata has no validated stable per-track key, so bind
        // language and role to the exact content and provider instead. If two
        // distinct tracks have indistinguishable metadata, fail explicitly.
        let mut hash = Sha256::new();
        for part in [
            "rainsync-short-caption-v1",
            resource.platform.id(),
            resource.id.as_str(),
            language,
            if automatic { "automatic" } else { "manual" },
            role,
        ] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        let id = format!("{prefix}{:x}", hash.finalize());
        if let Some(previous) = seen.insert(id.clone(), (url, format_name)) {
            if previous == (url, format_name) {
                continue;
            }
            return Err(Error::Restricted("caption_identity_ambiguous"));
        }
        tracks.push(SubtitleDescriptor {
            track: SubtitleTrack {
                id,
                language: language.into(),
                label: language.into(),
                automatic,
            },
            content_id: resource.id.clone(),
            url: url.into(),
            format,
        });
    }
    if !declared {
        return Err(Error::Restricted("caption_metadata_unavailable"));
    }
    Ok(Catalog {
        status: if !tracks.is_empty() {
            Availability::Available
        } else if declared {
            Availability::None
        } else {
            Availability::Unsupported
        },
        tracks,
    })
}
fn caption_role(track: &Map<String, Value>) -> Result<&str> {
    match track.get("Source") {
        None | Some(Value::Null) => Ok("unspecified"),
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= 48
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')) =>
        {
            Ok(value)
        }
        _ => Err(Error::InvalidResponse("caption_role")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_declared_owned_plain_caption_urls_survive() {
        let reference = parse_resource(Platform::TikTok, "7398162058153315605").unwrap();
        let mut item = serde_json::json!({"video":{"subtitleInfos":[{"Url":"https://v16-webapp.tiktokcdn.com/captions/one.vtt?sig=secret","Format":"webvtt","LanguageCodeName":"en","Source":"ASR"}]}});
        let catalog = parse(&reference, &item).unwrap();
        assert_eq!(catalog.status, Availability::Available);
        assert!(catalog.tracks[0].track.automatic);
        assert!(!format!("{:?}", catalog.tracks).contains("secret"));
        assert!(
            TextRequest::subtitle(&catalog.tracks[0])
                .unwrap()
                .cookie()
                .is_none()
        );
        item["video"]["subtitleInfos"][0]["Url"] =
            serde_json::json!("https://evil.example/one.vtt");
        assert!(parse(&reference, &item).is_err());
        assert_eq!(
            parse(&reference, &serde_json::json!({"video":{}})).err(),
            Some(Error::Restricted("caption_metadata_unavailable"))
        );
        assert_eq!(
            parse(
                &reference,
                &serde_json::json!({"video":{"subtitleInfos":[]}})
            )
            .unwrap()
            .status,
            Availability::None
        );
    }

    fn caption(language: &str, automatic: bool, name: &str) -> Value {
        serde_json::json!({
            "Url": format!("https://v16-webapp.tiktokcdn.com/captions/{name}.vtt?sig=original"),
            "Format": "webvtt", "LanguageCodeName": language,
            "isAutoGen": automatic, "Source": if automatic { "ASR" } else { "manual" },
        })
    }
    fn catalog_for(tracks: Vec<Value>) -> Value {
        serde_json::json!({"video":{"subtitleInfos":tracks}})
    }
    #[test]
    fn selected_identity_survives_reordering_neighbors_and_signed_url_rotation() {
        for platform in [Platform::TikTok, Platform::Douyin] {
            let resource = parse_resource(platform, "7398162058153315605").unwrap();
            let make = |mut values: Vec<Value>| {
                if platform == Platform::Douyin {
                    for value in &mut values {
                        value["Url"] =
                            Value::String(value["Url"].as_str().unwrap().replace(
                                "v16-webapp.tiktokcdn.com",
                                "v9-v2-mps-cdn.douyinvod.com",
                            ));
                    }
                }
                parse(&resource, &catalog_for(values)).unwrap()
            };
            let english = caption("en", false, "english");
            let japanese = caption("ja", false, "japanese");
            let automatic = caption("en", true, "automatic");
            let original = make(vec![english.clone(), japanese.clone(), automatic.clone()]);
            let selected = original.tracks[0].track.id.clone();
            let auto_id = original.tracks[2].track.id.clone();
            assert_ne!(selected, auto_id);
            let mut rotated = english.clone();
            rotated["Url"] = Value::String(
                rotated["Url"]
                    .as_str()
                    .unwrap()
                    .replace("sig=original", "sig=rotated"),
            );
            for values in [
                vec![japanese.clone(), rotated.clone(), automatic.clone()],
                vec![
                    caption("fr", false, "french"),
                    japanese.clone(),
                    rotated.clone(),
                ],
                vec![rotated.clone()],
            ] {
                let rediscovered = make(values);
                let exact = rediscovered
                    .tracks
                    .iter()
                    .find(|d| d.track.id == selected)
                    .unwrap();
                assert_eq!(exact.track.language, "en");
                assert!(!exact.track.automatic);
                assert!(exact.url.contains("sig=rotated"));
            }
            let removed = make(vec![japanese, automatic]);
            assert!(!removed.tracks.iter().any(|d| d.track.id == selected));
            assert!(!selected.contains("original"));
            assert!(selected.len() <= 80);
        }
    }
    #[test]
    fn caption_identity_is_content_provider_and_role_bound_and_ambiguity_fails_closed() {
        let reference = parse_resource(Platform::TikTok, "7398162058153315605").unwrap();
        let a = caption("en", false, "one");
        let original = parse(&reference, &catalog_for(vec![a.clone()])).unwrap();
        let other = parse_resource(Platform::TikTok, "7398162058153315606").unwrap();
        assert_ne!(
            original.tracks[0].track.id,
            parse(&other, &catalog_for(vec![a.clone()])).unwrap().tracks[0]
                .track
                .id,
        );
        let mut translated = caption("en", true, "automatic");
        let automatic = parse(&reference, &catalog_for(vec![translated.clone()])).unwrap();
        translated["Source"] = serde_json::json!("MT");
        assert_ne!(
            automatic.tracks[0].track.id,
            parse(&reference, &catalog_for(vec![translated]))
                .unwrap()
                .tracks[0]
                .track
                .id,
        );
        let duplicate = parse(&reference, &catalog_for(vec![a.clone(), a.clone()])).unwrap();
        assert_eq!(duplicate.tracks.len(), 1);
        for values in [
            vec![a.clone(), caption("en", false, "other")],
            vec![caption("en", false, "other"), a],
        ] {
            assert_eq!(
                parse(&reference, &catalog_for(values)).err(),
                Some(Error::Restricted("caption_identity_ambiguous")),
            );
        }
    }
    use crate::platform::text::TextRequest;
}
