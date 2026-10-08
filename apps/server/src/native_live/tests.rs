use super::*;
pub(super) fn sealed() -> Sealed {
    Sealed {
        kind: "native_live".into(),
        version: 1,
        binding: Binding {
            version: 3,
            provider: "bilibili".into(),
            media_id: Uuid::from_u128(1),
            room_id: Uuid::from_u128(2),
            user_id: Uuid::from_u128(3),
            entry_revision: "1".into(),
            credential_mode: "anonymous".into(),
            account_id: None,
            account_revision: None,
            resource: Identity::BilibiliLive {
                room_id: "7".into(),
                uid: "9".into(),
                broadcast_id: "7:9:1700000000".into(),
            },
        },
        scope: GrantScope {
            session_id: Uuid::from_u128(4),
            viewer_id: Uuid::from_u128(5),
            plan_generation: 7,
            media_generation: 2,
            auth_login_hash: "a".repeat(64),
            lifecycle_epoch: 0,
        },
        resolved_at_ms: 1_800_000_000_000,
        url_expires_at_ms: None,
        playlist_url: "https://d1--cn-live.bilivideo.com/live-bvc/room/index.m3u8".into(),
        current_quality: 150,
    }
}
#[test]
fn bounded_policy_never_extends_expiry_or_accepts_expired_root() {
    let grant = sealed();
    assert_eq!(grant.deadline().unwrap(), grant.resolved_at_ms + 120_000);
    assert_eq!(
        policy_deadline(grant.resolved_at_ms, Some(grant.resolved_at_ms + 20_000)).unwrap(),
        grant.resolved_at_ms + 15_000
    );
    assert!(policy_deadline(grant.resolved_at_ms, Some(grant.resolved_at_ms + 4999)).is_err());
}
#[test]
fn restart_is_a_fresh_identity_not_a_mutable_grant() {
    let grant = sealed();
    let mut next = grant.binding.resource.clone();
    let Identity::BilibiliLive { broadcast_id, .. } = &mut next;
    *broadcast_id = "7:9:1700000010".into();
    assert!(next.validate());
    assert_ne!(next.content_id(), grant.binding.resource.content_id());
    assert_ne!(next, grant.binding.resource);
    let entry = Entry {
        media: grant.binding.media_id,
        room: grant.binding.room_id,
        revision: 1,
        identity: next,
    };
    assert!(!grant.binding.matches(&entry));
}
#[test]
fn live_binding_is_closed_and_cannot_reuse_vod_identity() {
    let grant = sealed();
    assert!(grant.binding.validate());
    for value in [json!("native_platform"), json!("http"), json!("static_hls")] {
        let mut json = serde_json::to_value(&grant).unwrap();
        json["kind"] = value;
        let changed: Sealed = serde_json::from_value(json).unwrap();
        assert!(changed.deadline().is_err());
    }
    let mut changed = serde_json::to_value(&grant.binding).unwrap();
    changed["resource"]["url"] = json!("https://evil.invalid");
    assert!(serde_json::from_value::<Binding>(changed).is_err());
    let mut changed = grant.binding.clone();
    changed.version = 2;
    assert!(!changed.validate());
    changed = grant.binding.clone();
    changed.account_id = Some(Uuid::from_u128(5));
    assert!(!changed.validate());
}
#[test]
fn rate_and_byte_budgets_charge_failed_fetches() {
    let now = Instant::now();
    let mut budget = Budget {
        started: now,
        playlists: 0,
        segments: 0,
        bytes: 0,
        reserved: 0,
    };
    for _ in 0..120 {
        assert!(budget.admit(true, now));
    }
    assert!(!budget.admit(true, now));
    assert!(budget.admit(true, now + Duration::from_secs(60)));
    let runtime = Arc::new(Runtime {
        fingerprint: "fixture".into(),
        expires: i64::MAX,
        window: AsyncMutex::new(live::RollingWindow::default()),
        reload: AsyncMutex::new(()),
        segments: Arc::new(Semaphore::new(4)),
        budget: Mutex::new(budget),
        last_reload: Mutex::new(None),
    });
    {
        let _permit = runtime.reserve_bytes().unwrap();
        assert_eq!(
            runtime.budget.lock().unwrap().reserved,
            live::MAX_SEGMENT_BYTES as u64
        );
    }
    assert_eq!(runtime.budget.lock().unwrap().reserved, 0);
    // A request that never reaches the CDN refunds its reservation. A failed
    // fetch of unknown size consumes its full cap, preventing retry amplification.
    {
        let mut failed = runtime.reserve_bytes().unwrap();
        failed.start_fetch();
    }
    assert_eq!(
        runtime.budget.lock().unwrap().bytes,
        live::MAX_SEGMENT_BYTES as u64
    );
    for _ in 0..15 {
        runtime
            .reserve_bytes()
            .unwrap()
            .commit(live::MAX_SEGMENT_BYTES)
            .unwrap();
    }
    assert!(runtime.reserve_bytes().is_err());
}
#[test]
fn revocation_gate_keeps_login_viewer_plan_broadcast_and_exact_media() {
    for fragment in [
        "p.auth_login_hash=$3",
        "p.user_id=$4",
        "NOT p.stopped",
        "p.expires_at>clock_timestamp()",
        "s.state->>'media_id'=p.media_id::text",
        "g.viewer_id=p.viewer_id",
        "g.plan_generation=p.plan_generation",
        "playback_source_allowed(p.media_id,p.resource,p.id)",
        "room_members",
    ] {
        assert!(GATE.contains(fragment));
    }
    let migration = include_str!("../../../../migrations/0058_bilibili_live.sql");
    for fragment in [
        "b.broadcast_id=e.live_broadcast_id",
        "e.resource_kind='live'",
        "playback_http_file_context_allowed",
        "interval '120 seconds'",
        "native_platform_source_allowed_pre_live",
        "last_started_at bigint NOT NULL",
    ] {
        assert!(migration.contains(fragment));
    }
    assert!(!migration.contains("DROP TRIGGER"));
}

#[test]
fn runtime_is_exact_session_bounded_and_never_extends_or_transplants_grants() {
    let store = LiveStore::default();
    let mut grant = sealed();
    grant.resolved_at_ms = now_ms().unwrap();
    let expiry = grant.resolved_at_ms + 60_000;
    let session = grant.scope.session_id;
    let one = store.runtime(session, &grant, expiry).unwrap();
    let repeated = store.runtime(session, &grant, expiry).unwrap();
    assert!(Arc::ptr_eq(&one, &repeated));
    assert!(store.runtime(session, &grant, expiry + 1).is_err());
    assert!(store.runtime(Uuid::from_u128(900), &grant, expiry).is_err());
    let mut altered = grant.clone();
    altered.scope.plan_generation += 1;
    assert!(store.runtime(session, &altered, expiry).is_err());
    for n in 10..10 + MAX_ACTIVE_GRANTS - 1 {
        grant.scope.session_id = Uuid::from_u128(n as u128);
        store
            .runtime(grant.scope.session_id, &grant, expiry)
            .unwrap();
    }
    grant.scope.session_id = Uuid::from_u128(999);
    assert!(
        store
            .runtime(grant.scope.session_id, &grant, expiry)
            .is_err()
    );
    assert_eq!(store.entries.lock().unwrap().len(), MAX_ACTIVE_GRANTS);
}

#[tokio::test]
async fn expiry_disposes_the_retained_graph_without_another_request() {
    let store = LiveStore::default();
    let mut grant = sealed();
    grant.resolved_at_ms = now_ms().unwrap();
    store
        .runtime(grant.scope.session_id, &grant, grant.resolved_at_ms + 500)
        .unwrap();
    assert_eq!(store.entries.lock().unwrap().len(), 1);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(store.entries.lock().unwrap().is_empty());
}

#[test]
fn moving_window_expiry_is_a_specific_non_generic_retry_signal() {
    let error = provider_error(providers::platform::bilibili::Error::Restricted(
        "live_window_expired",
    ));
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert_eq!(error.1, "native_live_window_expired");
    let code = protocol::ErrorCode::from_reason(&error.1, error.0.as_u16());
    assert_eq!(code, protocol::ErrorCode::NativeLiveWindowExpired);
    assert!(!code.retryable());
}

#[test]
fn terminal_playlist_dispatch_preserves_exact_old_broadcast_scope() {
    use providers::platform::bilibili::Error as ProviderError;
    assert!(terminal_playlist_error(&ProviderError::Restricted(
        "live_broadcast_ended"
    )));
    for error in [
        ProviderError::InvalidResponse("live_playlist_shape"),
        ProviderError::Restricted("live_playlist_tag_denied"),
        ProviderError::Restricted("platform_challenge"),
        ProviderError::Transport,
        ProviderError::Deadline,
        ProviderError::Status(403),
    ] {
        assert!(!terminal_playlist_error(&error));
    }
    let old = sealed().binding.resource;
    assert_eq!(offline_scope(&old).unwrap(), ("7", "9", "7:9:1700000000"));
    let newer = Identity::BilibiliLive {
        room_id: "7".into(),
        uid: "9".into(),
        broadcast_id: "7:9:1700000010".into(),
    };
    assert_ne!(offline_scope(&old).unwrap(), offline_scope(&newer).unwrap());
    let malformed = Identity::BilibiliLive {
        room_id: "7".into(),
        uid: "8".into(),
        broadcast_id: old.broadcast_id().into(),
    };
    assert!(offline_scope(&malformed).is_err());
}
