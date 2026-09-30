use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub mod preview;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConfig {
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub title: String,
    pub resource: String,
    pub duration_ms: Option<f64>,
    pub metadata: Value,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("HTTP client")
}
pub fn validate_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        bail!("invalid_source_url")
    }
    Ok(url)
}
/// PlaybackInfo may contain absolute URLs, but credentials must stay at the configured origin.
pub fn upstream_url(base: &reqwest::Url, path: &str) -> Result<reqwest::Url> {
    let joined = if path.starts_with("//") {
        base.join(path)?
    } else {
        base.join(path.trim_start_matches('/'))?
    };
    let url = validate_url(joined.as_str())?;
    anyhow::ensure!(url.origin() == base.origin(), "upstream_origin_mismatch");
    Ok(url)
}
fn base(config: &SourceConfig) -> Result<String> {
    Ok(validate_url(&config.url)?
        .as_str()
        .trim_end_matches('/')
        .to_string())
}

pub async fn list_items(kind: &str, config: &SourceConfig) -> Result<Vec<Item>> {
    match kind {
        "local" => {
            let root = std::path::PathBuf::from(&config.root).canonicalize()?;
            tokio::task::spawn_blocking(move || {
                let mut stack = vec![root.clone()];
                let mut items = vec![];
                while let Some(dir) = stack.pop() {
                    for entry in std::fs::read_dir(dir)? {
                        let entry = entry?;
                        let ty = entry.file_type()?;
                        if ty.is_symlink() {
                            continue;
                        };
                        if ty.is_dir() {
                            stack.push(entry.path());
                            continue;
                        };
                        let p = entry.path();
                        let ext = p
                            .extension()
                            .and_then(|x| x.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        if ["mp4", "mkv", "webm", "mov", "m4v"].contains(&ext.as_str()) {
                            items.push(Item {
                                title: p.file_stem().unwrap().to_string_lossy().into(),
                                resource: p
                                    .strip_prefix(&root)?
                                    .to_string_lossy()
                                    .replace('\\', "/"),
                                duration_ms: None,
                                metadata: json!({}),
                            });
                        }
                    }
                }
                Ok(items)
            })
            .await?
        }
        "http" => {
            validate_url(&config.url)?;
            Ok(vec![Item {
                title: "HTTP media".into(),
                resource: config.url.clone(),
                duration_ms: None,
                metadata: json!({}),
            }])
        }
        "jellyfin" | "emby" => {
            if config.user_id.is_empty() || config.token.is_empty() {
                bail!("upstream_credentials_required")
            }
            let mut result = vec![];
            let mut start = 0;
            let mut expected_total = None;
            loop {
                let url = format!("{}/Users/{}/Items", base(config)?, config.user_id);
                let mut req = client().get(url).query(&[
                    ("Recursive", "true"),
                    ("IncludeItemTypes", "Movie,Episode,Video,MusicVideo"),
                    ("Limit", "200"),
                    ("StartIndex", &start.to_string()),
                ]);
                req = if kind == "jellyfin" {
                    req.header(
                        "Authorization",
                        format!("MediaBrowser Token=\"{}\"", config.token),
                    )
                } else {
                    req.header("X-Emby-Token", &config.token)
                };
                let value: Value = req.send().await?.error_for_status()?.json().await?;
                let total = value["TotalRecordCount"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("invalid_library_total"))?;
                anyhow::ensure!(
                    expected_total.is_none_or(|n| n == total),
                    "library_changed_during_scan"
                );
                expected_total = Some(total);
                let rows = value["Items"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("invalid_library_response"))?;
                for v in rows {
                    result.push(Item {
                        title: v["Name"].as_str().unwrap_or("Untitled").into(),
                        resource: v["Id"]
                            .as_str()
                            .ok_or_else(|| anyhow::anyhow!("missing_id"))?
                            .into(),
                        duration_ms: v["RunTimeTicks"].as_f64().map(|v| v / 10000.0),
                        metadata: json!({"ImageTags":v["ImageTags"],"BackdropImageTags":v["BackdropImageTags"]}),
                    });
                }
                start += rows.len();
                anyhow::ensure!(start as u64 <= total, "invalid_library_total");
                if start as u64 == total {
                    break;
                };
                anyhow::ensure!(!rows.is_empty(), "incomplete_library_response");
            }
            Ok(result)
        }
        _ => bail!("source_requires_agent_index"),
    }
}

#[derive(Clone)]
pub struct PlaybackOptions {
    pub position_ms: f64,
    pub audio_index: Option<u32>,
    pub progressive: bool,
    pub hls: bool,
    pub force_transcode: bool,
}

pub fn playback_request(config: &SourceConfig, options: &PlaybackOptions) -> Value {
    let direct = options.progressive && !options.force_transcode && options.audio_index.is_none();
    json!({"UserId":config.user_id,"IsPlayback":true,"AutoOpenLiveStream":false,
    "StartTimeTicks":(options.position_ms * 10000.0).round() as i64,
    "AudioStreamIndex":options.audio_index,"SubtitleStreamIndex":-1,
    "EnableDirectPlay":direct,"EnableDirectStream":options.hls && !options.force_transcode,
    "EnableTranscoding":options.hls,"AllowVideoStreamCopy":!options.force_transcode,
    "DeviceProfile":{"Name":"RainSync Web","MaxStreamingBitrate":12000000,
            "SubtitleProfiles":[{"Format":"vtt","Method":"External"}],
        "DirectPlayProfiles":if direct {json!([{"Container":"mp4","Type":"Video","VideoCodec":"h264","AudioCodec":"aac"}])}else{json!([])},
        "TranscodingProfiles":if options.hls {json!([{"Container":"ts","Type":"Video","Protocol":"hls","VideoCodec":"h264","AudioCodec":"aac","Context":"Streaming","MaxAudioChannels":"2"}])}else{json!([])}
    }})
}

pub async fn upstream_plan(
    kind: &str,
    config: &SourceConfig,
    item: &str,
    options: &PlaybackOptions,
    device_id: &str,
) -> Result<Value> {
    let body = playback_request(config, options);
    let mut url = validate_url(&format!("{}/", base(config)?))?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid_upstream_base"))?
        .pop_if_empty()
        .extend(["Items", item, "PlaybackInfo"]);
    let mut req = client().post(url).json(&body);
    for (name, value) in upstream_headers(kind, config, device_id)? {
        req = req.header(name, value);
    }
    Ok(req.send().await?.error_for_status()?.json().await?)
}

/// The same device identity must accompany negotiation, media/subtitle delivery
/// and playback check-ins. Tokens remain inside encrypted server-side scope.
pub fn upstream_headers(
    kind: &str,
    config: &SourceConfig,
    device_id: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    anyhow::ensure!(
        !device_id.is_empty()
            && device_id.len() <= 128
            && device_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid_upstream_device"
    );
    let token = config.token.replace('\\', "\\\\").replace('"', "\\\"");
    let prefix = match kind {
        "jellyfin" => "MediaBrowser",
        "emby" => "Emby",
        _ => bail!("invalid_upstream_kind"),
    };
    let identity = format!(
        "{prefix} Client=\"RainSync\", Device=\"Web\", DeviceId=\"{device_id}\", Version=\"0.1.0\", Token=\"{token}\""
    );
    let mut headers: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    headers.insert(
        if kind == "jellyfin" {
            "Authorization"
        } else {
            "X-Emby-Authorization"
        }
        .into(),
        identity,
    );
    if kind == "emby" {
        headers.insert("X-Emby-Token".into(), config.token.clone());
    }
    for (name, value) in &headers {
        reqwest::header::HeaderName::from_bytes(name.as_bytes())?;
        reqwest::header::HeaderValue::from_str(value)?;
    }
    Ok(headers)
}

/// Reject URLs naming another playback/device pair and encode both identifiers.
pub fn bind_playback_identity(
    mut url: reqwest::Url,
    sid: &str,
    device: &str,
) -> Result<reqwest::Url> {
    let mut session = false;
    let mut identity = false;
    for (name, value) in url.query_pairs() {
        if name.eq_ignore_ascii_case("PlaySessionId") {
            anyhow::ensure!(value == sid, "upstream_session_mismatch");
            session = true;
        }
        if name.eq_ignore_ascii_case("DeviceId") {
            anyhow::ensure!(value == device, "upstream_device_mismatch");
            identity = true;
        }
    }
    if !session {
        url.query_pairs_mut().append_pair("PlaySessionId", sid);
    }
    if !identity {
        url.query_pairs_mut().append_pair("DeviceId", device);
    }
    Ok(url)
}

/// Accepted/redirect/error responses do not confirm a check-in executed.
pub fn checkin_confirmed(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::OK | reqwest::StatusCode::NO_CONTENT
    )
}

#[cfg(test)]
mod playback_tests {
    use super::*;
    #[test]
    fn playback_identity_is_consistent_and_rejects_cross_session_urls() {
        let config: SourceConfig =
            serde_json::from_value(json!({"token":"private-token"})).unwrap();
        let a = "rainsync-01234567-0123-4567-89ab-0123456789ab";
        let b = "rainsync-12345678-1234-4567-89ab-0123456789ab";
        for kind in ["jellyfin", "emby"] {
            let headers = upstream_headers(kind, &config, a).unwrap();
            let field = if kind == "jellyfin" {
                "Authorization"
            } else {
                "X-Emby-Authorization"
            };
            assert!(headers[field].contains(&format!("DeviceId=\"{a}\"")));
            assert_ne!(headers, upstream_headers(kind, &config, b).unwrap());
            if kind == "emby" {
                assert_eq!(headers["X-Emby-Token"], "private-token");
            }
        }
        for bad in ["", "rainsync\"injected", "rainsync\nnew-header"] {
            assert!(upstream_headers("jellyfin", &config, bad).is_err());
        }
        let url = validate_url("https://media.example/master.m3u8?keep=1").unwrap();
        let bound = bind_playback_identity(url, "sid +&/?", a).unwrap();
        let values: std::collections::BTreeMap<_, _> = bound.query_pairs().into_owned().collect();
        assert_eq!(values["PlaySessionId"], "sid +&/?");
        assert_eq!(values["DeviceId"], a);
        assert_eq!(values["keep"], "1");
        for query in [
            "PlaySessionId=other",
            "DeviceId=other",
            "playsessionid=other",
            "PlaySessionId=sid&PlaySessionId=other",
        ] {
            assert!(
                bind_playback_identity(
                    validate_url(&format!("https://media.example/master.m3u8?{query}")).unwrap(),
                    "sid",
                    a
                )
                .is_err()
            );
        }
    }
    #[test]
    fn only_completed_checkin_responses_confirm_remote_execution() {
        for code in [200, 204] {
            assert!(checkin_confirmed(
                reqwest::StatusCode::from_u16(code).unwrap()
            ));
        }
        for code in [202, 301, 401, 403, 404, 429, 500, 503] {
            assert!(!checkin_confirmed(
                reqwest::StatusCode::from_u16(code).unwrap()
            ));
        }
    }
    #[tokio::test]
    async fn local_library_exceeding_ten_thousand_is_not_discarded() {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = parent.join(format!(
            "rainsync-provider-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        for i in 0..10001 {
            std::fs::write(root.join(format!("{i}.mp4")), []).unwrap();
        }
        let config: SourceConfig = serde_json::from_value(json!({"root":root})).unwrap();
        let result = list_items("local", &config).await;
        assert_eq!(
            root.canonicalize().unwrap().parent(),
            Some(parent.as_path())
        );
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("rainsync-provider-test-")
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result.unwrap().len(), 10001);
    }
    #[test]
    fn playback_url_cannot_move_credentials_to_another_origin() {
        let base = validate_url("https://media.example/emby/").unwrap();
        for path in [
            "https://evil.example/stream",
            "//evil.example/stream",
            "http://media.example/stream",
            "https://media.example:444/stream",
            "https://user:pass@media.example/stream",
        ] {
            assert!(upstream_url(&base, path).is_err(), "{path}");
        }
        for path in [
            "Videos/1/master.m3u8",
            "/Videos/1/master.m3u8",
            "https://media.example/stream",
        ] {
            assert_eq!(upstream_url(&base, path).unwrap().origin(), base.origin());
        }
    }
    #[test]
    fn playback_request_preserves_seek_audio_and_transport_constraints() {
        let config: SourceConfig = serde_json::from_value(json!({"user_id":"viewer"})).unwrap();
        let options = PlaybackOptions {
            position_ms: 1234.5,
            audio_index: Some(2),
            progressive: true,
            hls: true,
            force_transcode: false,
        };
        let body = playback_request(&config, &options);
        assert_eq!(body["StartTimeTicks"], 12345000);
        assert_eq!(body["AudioStreamIndex"], 2);
        assert_eq!(body["EnableDirectPlay"], false);
        assert_eq!(body["AllowVideoStreamCopy"], true);
        let body = playback_request(
            &config,
            &PlaybackOptions {
                hls: false,
                audio_index: None,
                ..options
            },
        );
        assert_eq!(body["EnableTranscoding"], false);
        assert_eq!(body["DeviceProfile"]["TranscodingProfiles"], json!([]));
    }
}
