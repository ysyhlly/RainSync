//! Metadata-only captions from yt-dlp TikTokBaseIE._get_subtitles.
//! https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py
//! No mirror, signature/challenge solver, arbitrary data URL or borrowed cookie.
use super::*;
use crate::platform::text::{
    self, Availability, Catalog, Endpoint, SubtitleDescriptor, SubtitleFormat, SubtitleTrack,
};
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
                    ));
                }
            }
        }
    }
    if candidates.len() > text::MAX_TRACKS {
        return Err(Error::TooLarge);
    }
    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
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
    for (url, language, format, automatic) in candidates {
        if !text::language(language) {
            return Err(Error::InvalidResponse("caption_language"));
        }
        let format = match format {
            "webvtt" => SubtitleFormat::ByteDanceVtt,
            "srt" => SubtitleFormat::ByteDanceSrt,
            "utterances_json" => SubtitleFormat::ByteDanceJson,
            _ => return Err(Error::Restricted("caption_format_unsupported")),
        };
        text::validate_text_url(endpoint, url, Some(&resource.id))
            .map_err(|_| Error::Restricted("caption_origin_or_path_unsupported"))?;
        if !seen.insert((language, url)) {
            continue;
        }
        tracks.push(SubtitleDescriptor {
            track: SubtitleTrack {
                id: format!("{prefix}{}", tracks.len() + 1),
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
    use crate::platform::text::TextRequest;
}
