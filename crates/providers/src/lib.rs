pub mod access_policy;
pub mod capabilities;
mod source_kind;
pub use source_kind::{SourceKind, UpstreamKind};
pub mod media_request;
pub mod platform;
pub mod source_access_contract;
pub mod static_hls;
pub use media_request::source_media_request;
pub mod account_policy;
pub mod upstream_profiles;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub mod emby;
pub mod jellyfin;
pub mod preview;
pub mod s3;
mod upstream_common;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_assets: Option<media_core::advanced_media::HttpAssetAssociation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3: Option<s3::S3Config>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_policy: Option<access_policy::SourceAccessPolicy>,
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

/// Legacy string boundary. Unknown kinds keep the existing index-only error.
pub async fn list_items(kind: &str, config: &SourceConfig) -> Result<Vec<Item>> {
    let kind = SourceKind::parse(kind);
    // Preserve this validation before an unsupported-kind error.
    anyhow::ensure!(
        kind == Some(SourceKind::S3) || config.s3.is_none(),
        "s3_source_kind_mismatch"
    );
    let browse = kind
        .and_then(|kind| capabilities::Browse::new(kind, config))
        .ok_or_else(|| anyhow::anyhow!("source_requires_agent_index"))?;
    browse.list().await
}

/// Hold the integrator's current-source fence for each browsing request.
pub async fn list_items_guarded<G, F, Fut>(
    kind: &str,
    config: &SourceConfig,
    mut guard: F,
) -> Result<Vec<Item>>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<G>>,
{
    if let Some(browse) =
        SourceKind::parse(kind).and_then(|kind| capabilities::Browse::new(kind, config))
    {
        browse.list_guarded(guard).await
    } else {
        // Unknown/agent kinds historically acquire the fence before reporting
        // the index-only (or S3 mismatch) error. Keep that ordering too.
        let _guard = guard().await?;
        list_items(kind, config).await
    }
}

#[cfg(test)]
mod guarded_scan_tests {
    #[tokio::test]
    async fn changed_source_fence_rejects_before_opening_the_next_request() {
        let config: super::SourceConfig = serde_json::from_value(serde_json::json!({
            "url":"http://127.0.0.1:1", "token":"test-only", "user_id":"test-only"
        }))
        .unwrap();
        for kind in ["http", "jellyfin", "emby"] {
            let result = super::list_items_guarded(kind, &config, || {
                std::future::ready(Err::<(), _>(anyhow::anyhow!("source_changed")))
            })
            .await;
            assert_eq!(result.unwrap_err().to_string(), "source_changed");
        }
    }
}

#[derive(Clone)]
pub struct PlaybackOptions {
    pub position_ms: f64,
    pub audio_index: Option<u32>,
    pub media_source_id: Option<String>,
    pub progressive: bool,
    pub hls: bool,
    pub force_transcode: bool,
}

pub fn playback_request(config: &SourceConfig, options: &PlaybackOptions) -> Value {
    let direct = options.progressive && !options.force_transcode && options.audio_index.is_none();
    json!({"UserId":config.user_id,"IsPlayback":true,"AutoOpenLiveStream":false,
    "StartTimeTicks":(options.position_ms * 10000.0).round() as i64,
    "AudioStreamIndex":options.audio_index,"MediaSourceId":options.media_source_id,"SubtitleStreamIndex":-1,
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
    let kind = UpstreamKind::parse(kind).ok_or_else(|| anyhow::anyhow!("invalid_upstream_kind"))?;
    capabilities::UpstreamNegotiation::new(kind, config)
        .plan(item, options, device_id)
        .await
}

/// Discover an explicit audio track's source without allocating a play session.
pub async fn upstream_audio_source(
    kind: &str,
    config: &SourceConfig,
    item: &str,
    audio_index: u32,
    device_id: &str,
) -> Result<String> {
    // Device validation preceded provider dispatch in the legacy headers path.
    validate_upstream_device(device_id)?;
    let kind = UpstreamKind::parse(kind).ok_or_else(|| anyhow::anyhow!("invalid_upstream_kind"))?;
    capabilities::UpstreamProbe::new(kind, config)
        .audio_source(item, audio_index, device_id)
        .await
}

/// Explicit profile recipe only. The caller owns the reservation and must
/// checkpoint its complete response before validating the returned route.
pub async fn upstream_profile_plan(
    kind: &str,
    config: &SourceConfig,
    item: &str,
    options: &PlaybackOptions,
    metadata: &upstream_profiles::UpstreamProfileMetadata,
    device_id: &str,
) -> Result<Value> {
    let kind = UpstreamKind::parse(kind).ok_or_else(|| anyhow::anyhow!("invalid_upstream_kind"))?;
    capabilities::UpstreamNegotiation::new(kind, config)
        .profile_plan(item, options, metadata, device_id)
        .await
}

/// The same device identity must accompany negotiation, media/subtitle delivery
/// and playback check-ins. Tokens remain inside encrypted server-side scope.
pub fn upstream_headers(
    kind: &str,
    config: &SourceConfig,
    device_id: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    validate_upstream_device(device_id)?;
    let kind = UpstreamKind::parse(kind).ok_or_else(|| anyhow::anyhow!("invalid_upstream_kind"))?;
    let token = config.token.replace('\\', "\\\\").replace('"', "\\\"");
    let prefix = match kind {
        UpstreamKind::Jellyfin => "MediaBrowser",
        UpstreamKind::Emby => "Emby",
    };
    let identity = format!(
        "{prefix} Client=\"RainSync\", Device=\"Web\", DeviceId=\"{device_id}\", Version=\"0.1.0\", Token=\"{token}\""
    );
    let mut headers: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    headers.insert(
        if kind == UpstreamKind::Jellyfin {
            "Authorization"
        } else {
            "X-Emby-Authorization"
        }
        .into(),
        identity,
    );
    if kind == UpstreamKind::Emby {
        headers.insert("X-Emby-Token".into(), config.token.clone());
    }
    for (name, value) in &headers {
        reqwest::header::HeaderName::from_bytes(name.as_bytes())?;
        reqwest::header::HeaderValue::from_str(value)?;
    }
    Ok(headers)
}

fn validate_upstream_device(device_id: &str) -> Result<()> {
    anyhow::ensure!(
        !device_id.is_empty()
            && device_id.len() <= 128
            && device_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid_upstream_device"
    );
    Ok(())
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

/// Source headers are scoped to the configured origin. Authority/hop headers
/// cannot turn an allowed endpoint into a different routing or framing target.
pub fn validate_source_headers(headers: &std::collections::BTreeMap<String, String>) -> Result<()> {
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        anyhow::ensure!(
            !matches!(
                lower.as_str(),
                "host"
                    | "connection"
                    | "proxy-authorization"
                    | "proxy-connection"
                    | "transfer-encoding"
                    | "content-length"
                    | "upgrade"
                    | "te"
                    | "trailer"
                    | "keep-alive"
            ),
            "invalid_source_header"
        );
        reqwest::header::HeaderName::from_bytes(name.as_bytes())?;
        reqwest::header::HeaderValue::from_str(value)?;
    }
    Ok(())
}
pub async fn source_request(
    config: &SourceConfig,
    target: &str,
    method: reqwest::Method,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<reqwest::RequestBuilder> {
    anyhow::ensure!(config.s3.is_none(), "s3_requires_read_transport");
    validate_source_headers(headers)?;
    let access = access_policy::SourceAccess::new(&config.url, config.access_policy.as_ref())?;
    let client = access.client_for(target).await?;
    let mut request = client.request(method);
    if client.source_credentials_allowed() {
        for (name, value) in headers {
            request = request.header(name, value)
        }
    }
    Ok(request)
}

/// Internal encrypted resource envelope; old grants retain the legacy origin.
pub fn resource_config(resource: &Value) -> Result<SourceConfig> {
    let url = resource["source_url"]
        .as_str()
        .or_else(|| resource["upstream_base"].as_str())
        .or_else(|| resource["url"].as_str())
        .ok_or_else(|| anyhow::anyhow!("invalid_source_url"))?;
    let headers = resource
        .get("headers")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(serde_json::from_value(
        json!({"url":url,"headers":headers,"access_policy":resource.get("access_policy"),"s3":resource.get("s3")}),
    )?)
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
        const CHILD_ROOT: &str = "RAINSYNC_PROVIDER_LIBRARY_TEST_ROOT";
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = if let Some(root) = std::env::var_os(CHILD_ROOT) {
            std::path::PathBuf::from(root)
        } else {
            let root = parent.join(format!(
                "rainsync-provider-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "playback_tests::local_library_exceeding_ten_thousand_is_not_discarded",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_ROOT, &root)
                .env("MEDIA_ROOT", &root);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.output().unwrap();
            if root.exists() {
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
            }
            assert!(
                output.status.success(),
                "isolated local library fixture failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
                "isolated fixture did not execute its exact test"
            );
            return;
        };
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
            media_source_id: Some("observed-source".into()),
            progressive: true,
            hls: true,
            force_transcode: false,
        };
        let body = playback_request(&config, &options);
        assert_eq!(body["StartTimeTicks"], 12345000);
        assert_eq!(body["AudioStreamIndex"], 2);
        assert_eq!(body["MediaSourceId"], "observed-source");
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
