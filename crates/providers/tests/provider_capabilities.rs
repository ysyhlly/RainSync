//! Capability dispatch exercises real entry points with synthetic inputs only.
use providers::{
    PlaybackOptions, SourceConfig, SourceKind, UpstreamKind,
    capabilities::{Browse, MediaRead, UpstreamNegotiation, UpstreamProbe},
    media_request::MediaRequestError,
};
use serde_json::json;

fn config() -> SourceConfig {
    serde_json::from_value(json!({"url":"https://source.invalid/media.mp4"})).unwrap()
}

#[tokio::test]
async fn browse_capability_keeps_http_projection_and_agent_index_boundary() {
    let config = config();
    let legacy = providers::list_items("http", &config).await.unwrap();
    let typed = Browse::new(SourceKind::Http, &config)
        .unwrap()
        .list()
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(legacy).unwrap(),
        serde_json::to_value(typed).unwrap()
    );
    assert!(Browse::new(SourceKind::Agent, &config).is_none());
    for kind in ["agent", "unknown", "HTTP", "http "] {
        assert_eq!(
            providers::list_items(kind, &config)
                .await
                .unwrap_err()
                .to_string(),
            "source_requires_agent_index"
        );
        assert_eq!(
            providers::list_items_guarded(kind, &config, || std::future::ready(Err::<(), _>(
                anyhow::anyhow!("source_changed")
            )))
            .await
            .unwrap_err()
            .to_string(),
            "source_changed"
        );
    }
}

#[tokio::test]
async fn legacy_s3_mismatch_and_guard_error_precedence_are_unchanged() {
    let mut config = config();
    config.s3 = Some(
        serde_json::from_value(json!({
            "region":"synthetic", "bucket":"synthetic", "credential_ref":{
                "access_key_id_env":"RAINSYNC_S3_SYNTHETIC_KEY",
                "secret_access_key_env":"RAINSYNC_S3_SYNTHETIC_SECRET"
            }
        }))
        .unwrap(),
    );
    for kind in ["local", "http", "jellyfin", "emby", "agent", "unknown"] {
        assert_eq!(
            providers::list_items(kind, &config)
                .await
                .unwrap_err()
                .to_string(),
            "s3_source_kind_mismatch"
        );
    }
    for kind in ["http", "agent", "unknown"] {
        assert_eq!(
            providers::list_items_guarded(kind, &config, || std::future::ready(Err::<(), _>(
                anyhow::anyhow!("source_changed")
            )))
            .await
            .unwrap_err()
            .to_string(),
            "source_changed"
        );
    }
}

#[tokio::test]
async fn probe_and_negotiation_keep_distinct_validation_without_opening_a_request() {
    let config = config();
    let options = PlaybackOptions {
        position_ms: 0.0,
        audio_index: None,
        media_source_id: None,
        progressive: true,
        hls: true,
        force_transcode: false,
    };
    for kind in [UpstreamKind::Jellyfin, UpstreamKind::Emby] {
        assert_eq!(
            UpstreamProbe::new(kind, &config)
                .audio_source("item", 0, "")
                .await
                .unwrap_err()
                .to_string(),
            "invalid_upstream_device"
        );
        assert_eq!(
            UpstreamNegotiation::new(kind, &config)
                .plan("item", &options, "device")
                .await
                .unwrap_err()
                .to_string(),
            "upstream_credentials_required"
        );
    }
    // Header/device validation historically wins over invalid provider only
    // for audio discovery/headers, not for PlaybackInfo dispatch.
    assert_eq!(
        providers::upstream_audio_source("unknown", &config, "item", 0, "")
            .await
            .unwrap_err()
            .to_string(),
        "invalid_upstream_device"
    );
    assert_eq!(
        providers::upstream_audio_source("unknown", &config, "item", 0, "device")
            .await
            .unwrap_err()
            .to_string(),
        "invalid_upstream_kind"
    );
    assert_eq!(
        providers::upstream_plan("unknown", &config, "item", &options, "")
            .await
            .unwrap_err()
            .to_string(),
        "invalid_upstream_kind"
    );
}

#[tokio::test]
async fn controlled_read_capability_does_not_admit_mutating_methods_or_foreign_origins() {
    let config = config();
    let read = MediaRead::new(&config);
    let headers = std::collections::BTreeMap::new();
    for method in [
        reqwest::Method::POST,
        reqwest::Method::DELETE,
        reqwest::Method::PUT,
    ] {
        assert!(matches!(
            read.request(&config.url, method.clone(), &headers).await,
            Err(MediaRequestError::UnsupportedMethod)
        ));
        assert!(matches!(
            providers::source_media_request(&config, &config.url, method, &headers).await,
            Err(MediaRequestError::UnsupportedMethod)
        ));
    }
    for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
        assert!(
            read.request(&config.url, method.clone(), &headers)
                .await
                .is_ok()
        );
        assert!(matches!(
            read.request("https://foreign.invalid/media.mp4", method, &headers)
                .await,
            Err(MediaRequestError::Access(_))
        ));
    }
}

#[tokio::test]
async fn legacy_pure_helpers_keep_their_existing_unknown_kind_defaults() {
    let config = config();
    let metadata = json!({});
    let emby = providers::preview::targets("emby", &config, "item", &metadata)
        .await
        .unwrap();
    let unknown = providers::preview::targets("unknown", &config, "item", &metadata)
        .await
        .unwrap();
    assert_eq!(emby.headers, unknown.headers);
    assert_eq!(emby.video, unknown.video);
    assert_eq!(
        providers::upstream_profiles::profile_identity("unknown"),
        providers::upstream_profiles::profile_identity("jellyfin"),
    );
    assert_ne!(
        providers::upstream_profiles::profile_identity("emby"),
        providers::upstream_profiles::profile_identity("jellyfin"),
    );
}
