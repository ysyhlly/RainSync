use super::*;
fn identity() -> Identity {
    let provider = live::Provider::YouTube;
    let resource_id = "dQw4w9WgXcQ";
    let owner = "UCabcdefghijklmnopqrstuv";
    let start = 1700000000;
    Identity::OtherLive {
        provider: provider.as_str().into(),
        resource_id: resource_id.into(),
        broadcaster_id: owner.into(),
        started_at: start,
        broadcast_id: live::broadcast_id(provider, resource_id, owner, start),
        canonical_url: format!("https://www.youtube.com/live/{resource_id}"),
    }
}
fn sealed() -> Sealed {
    Sealed {
        kind: "native_other_live".into(),
        version: 1,
        binding: Binding {
            version: 5,
            provider: "youtube".into(),
            media_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(2),
            user_id: Uuid::from_u128(3),
            entry_revision: "1".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: identity(),
        },
        scope: GrantScope {
            session_id: Uuid::from_u128(4),
            viewer_id: Uuid::from_u128(5),
            plan_generation: 1,
            media_generation: 0,
            auth_login_hash: "a".repeat(64),
            lifecycle_epoch: 0,
        },
        resolved_at_ms: 1700000010000,
        url_expires_at_ms: None,
        playlist_url:
            "https://manifest.googlevideo.com/api/manifest/hls_playlist/id/test/index.m3u8".into(),
    }
}
#[test]
fn other_live_identity_is_distinct_and_binds_all_source_axes() {
    let identity = identity();
    assert!(identity.validate());
    let original = serde_json::to_value(&identity).unwrap();
    assert_eq!(original.as_object().unwrap().len(), 7);
    assert_eq!(original["kind"], "other_live");
    assert!(!identity.broadcast_id().contains(':'));
    for (field, value) in [
        ("provider", json!("douyin")),
        ("resource_id", json!("abcdefghijk")),
        ("broadcaster_id", json!("UCotherdifferentownerxxxx")),
        ("started_at", json!(1700000001)),
        ("broadcast_id", json!("7:9:1700000000")),
        (
            "canonical_url",
            json!("https://www.youtube.com/live/abcdefghijk"),
        ),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        let identity: Identity = serde_json::from_value(changed).unwrap();
        assert!(!identity.validate(), "{field}");
    }
    let mut extra = original;
    extra["upstream_url"] = json!("https://secret.invalid");
    assert!(serde_json::from_value::<Identity>(extra).is_err());
}
#[test]
fn sealed_grant_never_uses_bili_context_or_extends_two_minute_custody() {
    let grant = sealed();
    assert_eq!(grant.deadline().unwrap(), grant.resolved_at_ms + 120000);
    assert!(grant.binding.validate());
    for (field, value) in [
        ("kind", json!("native_live")),
        ("version", json!(2)),
        (
            "playlist_url",
            json!("https://d1--cn-live.bilivideo.com/live-bvc/index.m3u8"),
        ),
    ] {
        let mut changed = serde_json::to_value(&grant).unwrap();
        changed[field] = value;
        assert!(
            serde_json::from_value::<Sealed>(changed)
                .unwrap()
                .deadline()
                .is_err()
        );
    }
    let mut changed = sealed();
    changed.binding.version = 3;
    assert!(changed.deadline().is_err());
    changed = sealed();
    changed.binding.provider = "bilibili".into();
    assert!(changed.deadline().is_err());
    let mut expiring = sealed();
    expiring.url_expires_at_ms = Some(grant.resolved_at_ms + 10000);
    assert_eq!(expiring.deadline().unwrap(), grant.resolved_at_ms + 5000);
}
#[test]
fn generated_live_plan_has_explicit_v2_namespace_and_no_vod_observation_or_position() {
    let id = identity();
    let body:protocol::PlaybackRequest=serde_json::from_value(json!({"room_id":Uuid::from_u128(2),"media_generation":0,"viewer_id":Uuid::from_u128(5),"plan_generation":1,"position_ms":0,"native_platform":{"version":1,"live_version":2,"credential_mode":"anonymous"}})).unwrap();
    let entry = Entry {
        media: Uuid::from_u128(1),
        room: body.room_id,
        revision: 1,
        identity: id,
    };
    let reservation = playback_requests::Reservation {
        prepare_until: tokio::time::Instant::now() + std::time::Duration::from_secs(45),
        key: Uuid::from_u128(8),
        session: Uuid::from_u128(4),
        user: Uuid::from_u128(3),
        room_id: body.room_id,
        lifecycle_epoch: 0,
        viewer_id: body.viewer_id,
        plan_generation: body.plan_generation,
        http_file: None,
        static_hls: None,
    };
    let account =
        platform_accounts::FrozenAccount::anonymous_for_provider(reservation.user, "youtube")
            .unwrap();
    let plan =
        prepare::build_live_plan(&entry, &reservation, &account, &body, 120, &"a".repeat(64));
    assert!(
        plan.playback_url
            .starts_with("/api/v1/platform-other-live-delivery/")
    );
    assert_eq!(
        plan.native_platform
            .as_ref()
            .unwrap()
            .live
            .as_ref()
            .unwrap()
            .version,
        2
    );
    assert_eq!(plan.duration_ms, None);
    assert_eq!(plan.timeline_origin_ms, 0.0);
    assert!(plan.observation_version.is_none());
    assert!(plan.observation_seq.is_none());
    assert!(!plan.rebuild_on_seek);
}
#[test]
fn other_live_migration_preserves_legacy_and_requires_fresh_highwater_source_observation() {
    let sql = include_str!("../../../../migrations/0064_other_platform_live.sql");
    for shape in [
        "WHEN 'video'",
        "WHEN 'pgc_episode'",
        "WHEN 'live'",
        "WHEN 'course_episode'",
        "WHEN 'other_live'",
        "native_platform_source_allowed_pre_other_live",
        "'version'='5'::jsonb",
        "interval '120 seconds'",
        "interval '15 seconds'",
        "other_live_broadcast_highwater",
        "other_live_entry_immutable",
    ] {
        assert!(sql.contains(shape), "{shape}");
    }
    assert!(!sql.contains("chr(0)"));
}
#[test]
fn youtube_reloads_keep_original_signed_root_without_extending_immutable_grant() {
    let grant = sealed();
    let resource = grant.binding.resource.selector().unwrap();
    let body = json!({"_type":"video","extractor_key":"Youtube","id":"dQw4w9WgXcQ","channel_id":"UCabcdefghijklmnopqrstuv","release_timestamp":1700000000,"title":"Source stream","is_live":true,"live_status":"is_live","availability":"public","age_limit":0,"protocol":"m3u8_native","vcodec":"avc1.64001F","acodec":"mp4a.40.2","url":"https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1700001010/sig/new%3D/index.m3u8"});
    let refreshed =
        live::parse_youtube_response(&resource, &serde_json::to_vec(&body).unwrap(), 1700000010)
            .unwrap();
    assert_ne!(refreshed.playlist_url, grant.playlist_url);
    assert_eq!(
        playlist_target(&grant, &refreshed).unwrap(),
        grant.playlist_url
    );
    assert_eq!(grant.deadline().unwrap(), grant.resolved_at_ms + 120000);
}
