//! Optional caption metadata is parsed separately from the media contract. Only
//! fixed JSON3 timedtext descriptors survive; unknown extractor fields (cookies,
//! page HTML, request options, credentials) are skipped, never retained.
//! https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py
use super::{Error, Result, VideoRef};
use crate::platform::text::{self, Endpoint, SubtitleDescriptor, SubtitleFormat, SubtitleTrack};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Captions {
    #[serde(rename = "_type")]
    kind: String,
    id: String,
    extractor_key: String,
    live_status: String,
    #[serde(default)]
    is_live: bool,
    #[serde(default)]
    was_live: bool,
    availability: Option<String>,
    age_limit: Option<u32>,
    duration: f64,
    #[serde(default)]
    subtitles: BTreeMap<String, Vec<Caption>>,
    #[serde(default)]
    automatic_captions: BTreeMap<String, Vec<Caption>>,
}
#[derive(Deserialize)]
struct Caption {
    ext: String,
    url: Option<String>,
    name: Option<String>,
}
pub(super) fn parse(bytes: &[u8], reference: &VideoRef) -> Result<Vec<SubtitleDescriptor>> {
    if bytes.len() > super::MAX_JSON_BYTES {
        return Err(Error::TooLarge);
    }
    let extracted: Captions = serde_json::from_slice(bytes).map_err(|_| Error::InvalidResponse)?;
    if extracted.kind != "video"
        || extracted.id != reference.id
        || extracted.extractor_key != "Youtube"
        || extracted.live_status != "not_live"
        || extracted.is_live
        || extracted.was_live
        || !extracted.duration.is_finite()
        || !(0.001..=604800.0).contains(&extracted.duration)
        || extracted.age_limit.is_some_and(|n| n > 0)
        || extracted
            .availability
            .as_deref()
            .is_some_and(|v| !matches!(v, "public" | "unlisted"))
    {
        return Err(Error::Unsupported);
    }
    if extracted.subtitles.len() > 256 || extracted.automatic_captions.len() > 256 {
        return Err(Error::TooLarge);
    }
    let mut tracks = Vec::new();
    for (automatic, languages) in [
        (false, extracted.subtitles),
        (true, extracted.automatic_captions),
    ] {
        for (language, formats) in languages {
            if !text::language(&language) || formats.len() > 16 {
                return Err(Error::InvalidResponse);
            }
            // Prefer original captions. Translated tracks still describe their
            // own language and automatic origin; they never borrow credentials.
            let candidates: Vec<_> = formats.into_iter().filter(|f| f.ext == "json3").collect();
            if candidates.len() > 4 {
                return Err(Error::TooLarge);
            }
            let mut selected = None;
            for caption in candidates {
                let Some(url) = caption.url else { continue };
                text::validate_text_url(Endpoint::YoutubeCaption, &url, Some(&reference.id))
                    .map_err(|_| Error::InvalidResponse)?;
                let label = text::plain_text(caption.name.as_deref().unwrap_or(&language), 80);
                let descriptor = SubtitleDescriptor {
                    track: SubtitleTrack {
                        id: format!("y{}{language}", if automatic { "a" } else { "m" }),
                        language: language.clone(),
                        label: if label.is_empty() {
                            language.clone()
                        } else {
                            label
                        },
                        automatic,
                    },
                    content_id: reference.id.clone(),
                    url,
                    format: SubtitleFormat::YoutubeJson3,
                };
                let translated = reqwest::Url::parse(&descriptor.url)
                    .map_err(|_| Error::InvalidResponse)?
                    .query_pairs()
                    .any(|(n, _)| n == "tlang");
                if selected.is_none() || !translated {
                    selected = Some((translated, descriptor))
                }
            }
            if let Some((translated, descriptor)) = selected {
                tracks.push((translated, descriptor))
            }
        }
    }
    // Every map/format/URL is validated even when the display cap is reached.
    tracks.sort_by(|a, b| {
        (a.0, a.1.track.automatic, &a.1.track.language).cmp(&(
            b.0,
            b.1.track.automatic,
            &b.1.track.language,
        ))
    });
    Ok(tracks
        .into_iter()
        .take(text::MAX_TRACKS)
        .map(|(_, t)| t)
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> serde_json::Value {
        json!({"_type":"video","id":"dQw4w9WgXcQ","extractor_key":"Youtube","live_status":"not_live","duration":120,"availability":"public","subtitles":{"en":[{"ext":"json3","url":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=json3&sig=secret","name":"English","http_headers":{"Authorization":"secret"}}]},"automatic_captions":{"zh-Hans":[{"ext":"json3","url":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=json3&tlang=zh-Hans"}]},"cookies":"secret","webpage":"<script>secret</script>"})
    }
    #[test]
    fn optional_caption_metadata_preserves_identity_and_redaction() {
        let reference = VideoRef {
            id: "dQw4w9WgXcQ".into(),
        };
        let f = fixture();
        let tracks = parse(&serde_json::to_vec(&f).unwrap(), &reference).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].track.id, "ymen");
        assert!(tracks[1].track.automatic);
        assert!(!format!("{:?}", tracks).contains("secret"));
        assert!(
            !serde_json::to_string(&tracks[0].track)
                .unwrap()
                .contains("timedtext")
        );
        for path in ["id", "extractor_key", "live_status", "availability"] {
            let mut changed = f.clone();
            changed[path] = json!("invalid");
            assert!(parse(&serde_json::to_vec(&changed).unwrap(), &reference).is_err())
        }
        let mut changed = f.clone();
        changed["subtitles"]["en"][0]["url"] =
            json!("https://www.youtube.com/api/timedtext?v=other&fmt=json3");
        assert!(parse(&serde_json::to_vec(&changed).unwrap(), &reference).is_err());
        let mut changed = f;
        changed["subtitles"]["en"][0]["url"] =
            json!("https://evil.example/api/timedtext?v=dQw4w9WgXcQ&fmt=json3");
        assert!(parse(&serde_json::to_vec(&changed).unwrap(), &reference).is_err());
    }
}
