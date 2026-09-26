use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
                        if items.len() > 10000 {
                            bail!("library_limit")
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
                        metadata: json!({}),
                    });
                }
                start += rows.len();
                if rows.is_empty()
                    || start >= value["TotalRecordCount"].as_u64().unwrap_or(start as u64) as usize
                {
                    break;
                };
                if start >= 10000 {
                    bail!("library_limit")
                }
            }
            Ok(result)
        }
        _ => bail!("source_requires_agent_index"),
    }
}

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
) -> Result<Value> {
    let body = playback_request(config, options);
    let url = format!("{}/Items/{}/PlaybackInfo", base(config)?, item);
    let req = client().post(url).json(&body);
    let req = if kind == "jellyfin" {
        req.header("Authorization",format!("MediaBrowser Client=\"RainSync\", Device=\"Web\", DeviceId=\"rainsync\", Version=\"0.1.0\", Token=\"{}\"",config.token))
    } else {
        req.header("X-Emby-Token", &config.token)
    };
    Ok(req.send().await?.error_for_status()?.json().await?)
}

#[cfg(test)]
mod playback_tests {
    use super::*;
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
