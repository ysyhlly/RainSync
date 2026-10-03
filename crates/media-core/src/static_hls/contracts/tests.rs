use super::graph::RootGraphStatement;
use super::input::{FrozenInput, IdentityStatement, SelectedAudioStatement};
use super::phase::*;
use super::*;
use serde_json::{Value, json};

const INPUT: &[u8] = include_bytes!("golden_input_v1.json");
const ROOT: &[u8] = include_bytes!("golden_root_v1.json");
const INPUT_HASH: &str = "c93f932283d5105f0f2f18b7f7875305603494793e94cb442890beae473eb784";
const ROOT_HASH: &str = "b5076746d2d8dab38de2587ed8094fbc0f377a1c5745308173df65b553cfef19";
const OWNER: &str = "00000000-0000-0000-0000-00000000000c";

fn input_value() -> Value {
    serde_json::from_slice(INPUT).unwrap()
}
fn root_value() -> Value {
    serde_json::from_slice(ROOT).unwrap()
}
fn input(value: &Value) -> Result<FrozenInput> {
    FrozenInput::parse_private_plaintext(&serde_json::to_vec(value).unwrap())
}
fn graph(value: &Value) -> Result<RootGraphStatement> {
    RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(value).unwrap())
}
fn child_value() -> Value {
    let mut v = input_value();
    v["kind"] = json!("child");
    v["operation_id"] = json!("00000000-0000-0000-0000-00000000000d");
    v["session_id"] = json!("00000000-0000-0000-0000-00000000000e");
    v["request_owner_epoch"] = json!("00000000-0000-0000-0000-00000000000f");
    v["request_sha256"] = json!("2".repeat(64));
    v["plan_generation"] = json!(2);
    v["prepare_started_at_ms"] = json!(2000);
    v["prepare_expires_at_ms"] = json!(47000);
    v["root"] = json!({"parent_session_id":input_value()["session_id"],"parent_capture_id":input_value()["operation_id"],
        "parent_input_sha256":INPUT_HASH,"root_digest":ROOT_HASH,"root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
        "selected_audio":{"kind":"single","stream_index":1}});
    v
}
fn pending(input: FrozenInput) -> PhaseStatement {
    let publication = if input.kind() == super::input::OperationKind::Parent {
        PublicationPhase::PendingParent
    } else {
        PublicationPhase::PendingChild
    };
    PhaseStatement::new(
        input,
        OWNER.into(),
        RequestPhase::Pending,
        publication,
        CaptureState::Capturing,
        None,
        None,
    )
    .unwrap()
}
fn disposal(identity: &IdentityStatement) -> DisposalStatement {
    DisposalStatement {
        operation_id: identity.operation_id.clone(),
        owner_id: OWNER.into(),
        streams_closed: true,
        process_drained: true,
        files_removed: true,
        process_disposition: ProcessDispositionStatement::NeverStarted,
    }
}
fn facts<'a>(
    identity: &'a IdentityStatement,
    scan: Option<&'a RootGraphStatement>,
    disposal: Option<&'a DisposalStatement>,
) -> TransitionStatements<'a> {
    TransitionStatements {
        identity,
        now_ms: 3000,
        pending_lease_expires_at_ms: 45000,
        current_authority_live: true,
        complete_scan: scan,
        same_worker_local_snapshot: true,
        publication_session_and_response_atomic: true,
        explained_native_result: true,
        disposal,
    }
}

#[test]
fn golden_bytes_hashes_numeric_unicode_and_cross_serialization() {
    let frozen = FrozenInput::parse_private_plaintext(INPUT).unwrap();
    assert_eq!(frozen.private_storage_plaintext(), INPUT);
    assert_eq!(frozen.input_sha256(), INPUT_HASH);
    let parsed = input(&input_value()).unwrap(); // Value deliberately sorts keys.
    assert_eq!(parsed.private_storage_plaintext(), INPUT);
    parsed.require_same_frozen_input(&frozen).unwrap();
    for position in [json!(0), json!(0.0), json!(-0.0)] {
        let mut v = input_value();
        v["position_ms"] = position;
        assert_eq!(input(&v).unwrap().input_sha256(), INPUT_HASH);
    }
    let escaped = std::str::from_utf8(INPUT)
        .unwrap()
        .replace("café", "caf\\u00e9");
    assert_eq!(
        FrozenInput::parse_private_plaintext(escaped.as_bytes())
            .unwrap()
            .private_storage_plaintext(),
        INPUT
    );
    let mut decomposed = input_value();
    decomposed["source"]["headers"][0]["value"] = json!("cafe\u{301}");
    assert_ne!(input(&decomposed).unwrap().input_sha256(), INPUT_HASH);
    let graph = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
    assert_eq!(graph.private_storage_plaintext(), ROOT);
    assert_eq!(graph.root_digest(), ROOT_HASH);
    assert_eq!(
        super::tests::graph(&root_value())
            .unwrap()
            .private_storage_plaintext(),
        ROOT
    );
    assert_ne!(
        digest(b"rainsync-static-hls-input-v1\0", ROOT),
        graph.root_digest()
    );
    assert_ne!(digest(b"", INPUT), frozen.input_sha256());
    graph.require_parent_input(&frozen).unwrap();
    let diagnostic = serde_json::to_string(
        &frozen.diagnostic(super::input::ContractErrorCode::InvalidStatement),
    )
    .unwrap();
    assert_eq!(
        diagnostic,
        "{\"reason\":\"invalid_statement\",\"operation_id\":\"00000000-0000-0000-0000-000000000001\"}"
    );
}

#[test]
fn sensitive_input_and_identity_have_no_debug_or_serde_projection() {
    // Negative trait assertions: adding either sensitive projection makes this
    // inference ambiguous and fails compilation, even if runtime tests pass.
    trait AmbiguousDebug<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousDebug<()> for T {}
    impl<T: ?Sized + std::fmt::Debug> AmbiguousDebug<u8> for T {}
    let _ = <FrozenInput as AmbiguousDebug<_>>::check;
    let _ = <IdentityStatement as AmbiguousDebug<_>>::check;
    trait AmbiguousSerialize<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousSerialize<()> for T {}
    impl<T: ?Sized + serde::Serialize> AmbiguousSerialize<u8> for T {}
    let _ = <FrozenInput as AmbiguousSerialize<_>>::check;
    let _ = <IdentityStatement as AmbiguousSerialize<_>>::check;
}

#[test]
fn input_closed_objects_duplicates_required_null_and_versions() {
    for pointer in ["", "/source", "/source/headers/0", "/audio_intent"] {
        let mut v = input_value();
        v.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert!(matches!(input(&v), Err(ContractError::Shape)));
    }
    for name in [
        "input_version",
        "graph_version",
        "reader_version",
        "recipe_version",
    ] {
        let mut v = input_value();
        v[name] = json!(9);
        assert!(matches!(input(&v), Err(ContractError::Version)));
    }
    for (needle, replacement) in [
        (
            "\"input_version\":1",
            "\"input_version\":1,\"input_version\":1",
        ),
        (
            "\"kind\":\"parent\"",
            "\"kind\":\"parent\",\"kind\":\"parent\"",
        ),
        (
            "\"kind\":\"default\"",
            "\"kind\":\"default\",\"kind\":\"default\"",
        ),
        (
            "\"name\":\"x-label\"",
            "\"name\":\"x-label\",\"name\":\"x-label\"",
        ),
    ] {
        let text = std::str::from_utf8(INPUT)
            .unwrap()
            .replace(needle, replacement);
        assert!(matches!(
            FrozenInput::parse_private_plaintext(text.as_bytes()),
            Err(ContractError::Shape)
        ));
    }
    let mut v = input_value();
    v["source"].as_object_mut().unwrap().remove("access_policy");
    assert!(matches!(input(&v), Err(ContractError::Shape)));
    let mut v = input_value();
    v["source"]["access_policy"] = json!({"schema_version":1,"origins":[{"origin":"https://source.example","cidrs":["192.0.2.0/24"]}]});
    assert!(matches!(input(&v), Err(ContractError::Shape)));
    v["source"]["access_policy"]["redirects"] = Value::Null;
    input(&v).unwrap();
    let mut v = child_value();
    v["root"].as_object_mut().unwrap().remove("selected_audio");
    assert!(matches!(input(&v), Err(ContractError::Shape)));
    for (key, val) in [
        ("plan_generation", json!(0)),
        ("lifecycle_epoch", json!(MAX_SAFE_INTEGER + 1)),
        ("position_ms", json!(-1)),
        ("position_ms", json!("0")),
        (
            "operation_id",
            json!("00000000-0000-0000-0000-000000000000"),
        ),
        ("database", json!("00000000-0000-0000-0000-00000000000A")),
        ("auth_login_hash", json!("A".repeat(64))),
    ] {
        let mut v = input_value();
        v[key] = val;
        assert!(input(&v).is_err());
    }
    let text = std::str::from_utf8(INPUT)
        .unwrap()
        .replace("\"position_ms\":0.0", "\"position_ms\":1e400");
    assert!(matches!(
        FrozenInput::parse_private_plaintext(text.as_bytes()),
        Err(ContractError::Shape)
    ));
}

fn positional_array(value: &Value, fields: &[&str]) -> Value {
    json!(
        fields
            .iter()
            .map(|field| value[*field].clone())
            .collect::<Vec<_>>()
    )
}

#[test]
fn every_closed_object_refuses_positional_array_aliases() {
    let mut parent = input_value();
    parent["source"]["access_policy"] = json!({"schema_version":1,
        "origins":[{"origin":"https://source.example","cidrs":["192.0.2.0/24"]}],"redirects":{"max_hops":1}});
    input(&parent).unwrap();
    let input_fields = &[
        "input_version",
        "graph_version",
        "reader_version",
        "recipe_version",
        "kind",
        "operation_id",
        "session_id",
        "request_owner_epoch",
        "request_sha256",
        "user_id",
        "room_id",
        "auth_login_hash",
        "auth_membership_epoch",
        "lifecycle_epoch",
        "media_id",
        "media_generation",
        "viewer_id",
        "plan_generation",
        "worker_instance",
        "database",
        "root_admitted_at_ms",
        "root_hard_expires_at_ms",
        "prepare_started_at_ms",
        "prepare_expires_at_ms",
        "position_ms",
        "audio_intent",
        "source",
    ];
    assert!(matches!(
        input(&positional_array(&parent, input_fields)),
        Err(ContractError::Shape)
    ));
    for (pointer, fields) in [
        (
            "/source",
            &[
                "kind",
                "source_id",
                "source_policy_revision",
                "media_source_generation",
                "configured_base_url",
                "canonical_target",
                "headers",
                "access_policy",
            ][..],
        ),
        ("/source/headers/0", &["name", "value"][..]),
        (
            "/source/access_policy",
            &["schema_version", "origins", "redirects"][..],
        ),
        ("/source/access_policy/origins/0", &["origin", "cidrs"][..]),
        ("/source/access_policy/redirects", &["max_hops"][..]),
        ("/audio_intent", &["kind"][..]),
    ] {
        let mut changed = parent.clone();
        let array = positional_array(changed.pointer(pointer).unwrap(), fields);
        *changed.pointer_mut(pointer).unwrap() = array;
        assert!(
            matches!(input(&changed), Err(ContractError::Shape)),
            "array alias at {pointer}"
        );
    }
    let child = child_value();
    for value in [
        json!(["none"]),
        json!(["single", 1]),
        json!({"kind":"none","extra":1}),
        json!({"kind":"single","stream_index":1,"extra":1}),
    ] {
        assert!(serde_json::from_value::<SelectedAudioStatement>(value).is_err());
    }
    let mut object_kind = parent.clone();
    object_kind["kind"] = json!({"parent":null});
    assert!(matches!(input(&object_kind), Err(ContractError::Shape)));
    let mut object_track_kind = root_value();
    object_track_kind["timeline"]["tracks"][0]["kind"] = json!({"video":null});
    assert!(matches!(
        graph(&object_track_kind),
        Err(ContractError::Shape)
    ));
    for (pointer, fields) in [
        (
            "/root",
            &[
                "parent_session_id",
                "parent_capture_id",
                "parent_input_sha256",
                "root_digest",
                "root_admitted_at_ms",
                "root_hard_expires_at_ms",
                "selected_audio",
            ][..],
        ),
        ("/root/selected_audio", &["kind", "stream_index"][..]),
    ] {
        let mut changed = child.clone();
        let array = positional_array(changed.pointer(pointer).unwrap(), fields);
        *changed.pointer_mut(pointer).unwrap() = array;
        assert!(
            matches!(input(&changed), Err(ContractError::Shape)),
            "array alias at {pointer}"
        );
    }
    let root = root_value();
    for (pointer, fields) in [
        (
            "",
            &[
                "graph_version",
                "parent_input_sha256",
                "inventory",
                "closure",
                "timeline",
            ][..],
        ),
        (
            "/inventory/0",
            &[
                "original_target_sha256",
                "final_target_sha256",
                "strong_etag",
                "bytes",
                "sha256",
            ][..],
        ),
        (
            "/closure",
            &[
                "version",
                "manifest_sha256",
                "manifest_bytes",
                "init",
                "segments",
            ][..],
        ),
        ("/closure/init", &["bytes", "sha256"][..]),
        (
            "/closure/segments/0",
            &["index", "bytes", "sha256", "track_ids"][..],
        ),
        (
            "/timeline",
            &[
                "version",
                "manifest_sha256",
                "manifest_bytes",
                "init",
                "segments",
                "scope",
                "source_origin_ms",
                "duration_ms",
                "media_sequence",
                "tracks",
            ][..],
        ),
        ("/timeline/init", &["bytes", "sha256"][..]),
        (
            "/timeline/segments/0",
            &["index", "bytes", "sha256", "track_ids"][..],
        ),
        (
            "/timeline/tracks/0",
            &[
                "track_id",
                "stream_index",
                "kind",
                "time_base",
                "packet_count",
                "decoded_frames",
                "raw_first_pts",
                "decoded_first_pts",
                "priming_samples",
                "tail_padding_samples",
                "raw_end_seconds",
                "end_seconds",
                "last_frame_pts",
                "codec_config_sha256",
            ][..],
        ),
    ] {
        let mut changed = root.clone();
        let array = positional_array(changed.pointer(pointer).unwrap(), fields);
        *changed.pointer_mut(pointer).unwrap() = array;
        assert!(
            matches!(graph(&changed), Err(ContractError::Shape)),
            "array alias at {pointer}"
        );
    }
}

#[test]
fn stored_strong_etags_match_response_header_ascii_and_interior_grammar() {
    for etag in [
        "\"a b\"",
        "\"a\"b\"",
        "\"café\"",
        "\"a\u{7f}\"",
        "\"a\nb\"",
        "W/\"weak\"",
    ] {
        let mut root = root_value();
        root["inventory"][0]["strong_etag"] = json!(etag);
        assert!(matches!(graph(&root), Err(ContractError::Identity)));
    }
    for etag in ["\"\"", "\"!#~\""] {
        let mut root = root_value();
        root["inventory"][0]["strong_etag"] = json!(etag);
        graph(&root).unwrap();
    }
}

#[test]
fn retained_graph_does_not_skip_scan_binding_at_parent_publication() {
    let parent = input(&input_value()).unwrap();
    let identity = parent.identity_statement();
    let mut mismatched = root_value();
    mismatched["parent_input_sha256"] = json!("9".repeat(64));
    let scan = graph(&mismatched).unwrap();
    let before = PhaseStatement::new(
        parent.clone(),
        OWNER.into(),
        RequestPhase::Pending,
        PublicationPhase::PendingParent,
        CaptureState::Verified,
        Some(scan.root_digest().into()),
        None,
    )
    .unwrap();
    let after = PhaseStatement::new(
        parent.clone(),
        OWNER.into(),
        RequestPhase::CompletedMarkedParent,
        PublicationPhase::PublishedParent,
        CaptureState::Verified,
        Some(scan.root_digest().into()),
        Some("7".repeat(64)),
    )
    .unwrap();
    assert_eq!(
        validate_transition(&before, &after, &facts(&identity, Some(&scan), None)),
        Err(ContractError::Identity)
    );
    let matching = graph(&root_value()).unwrap();
    let before = PhaseStatement::new(
        parent.clone(),
        OWNER.into(),
        RequestPhase::Pending,
        PublicationPhase::PendingParent,
        CaptureState::Verified,
        Some(ROOT_HASH.into()),
        None,
    )
    .unwrap();
    let after = PhaseStatement::new(
        parent,
        OWNER.into(),
        RequestPhase::CompletedMarkedParent,
        PublicationPhase::PublishedParent,
        CaptureState::Verified,
        Some(ROOT_HASH.into()),
        Some("7".repeat(64)),
    )
    .unwrap();
    validate_transition(&before, &after, &facts(&identity, Some(&matching), None)).unwrap();
}

#[test]
fn every_deadline_check_preserves_high_water_and_poisoning() {
    let input = input(&input_value()).unwrap();
    let mut missed = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    assert_eq!(missed.require_live(45000), Err(ContractError::Deadline));
    assert_eq!(missed.require_live(1), Err(ContractError::Deadline));
    assert_eq!(missed.complete_preparation(1), Err(ContractError::Deadline));
    let mut completion_missed = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    assert_eq!(
        completion_missed.complete_preparation(45000),
        Err(ContractError::Deadline)
    );
    assert_eq!(
        completion_missed.complete_preparation(1),
        Err(ContractError::Deadline)
    );
    let mut completed = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    completed.complete_preparation(1000).unwrap();
    assert_eq!(
        completed.observe(999, 1001, 100000, None),
        Err(ContractError::Deadline)
    );
    assert_eq!(completed.require_live(1001), Err(ContractError::Deadline));
    let mut monotonic = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    monotonic.require_live(1000).unwrap();
    assert_eq!(monotonic.require_live(999), Err(ContractError::Deadline));
    assert_eq!(monotonic.require_live(1001), Err(ContractError::Deadline));
}

#[test]
fn urls_headers_policy_and_configured_credential_origin_are_bounded() {
    for url in [
        " https://source.example/a",
        "https://source.example/a ",
        "https://u:p@source.example/a",
        "https://source.example:0/a",
        "https://source.example/a#fragment",
        "https://source.example/a\\b",
        "https://source.example/a\n",
        "file:///x",
        "https://SOURCE.example/a",
    ] {
        let mut v = input_value();
        v["source"]["configured_base_url"] = json!(url);
        assert!(input(&v).is_err());
    }
    for name in [
        "host",
        "connection",
        "transfer-encoding",
        "content-length",
        "proxy-authorization",
        "X-UPPER",
        "invalid space",
    ] {
        let mut v = input_value();
        v["source"]["headers"][0]["name"] = json!(name);
        assert!(matches!(input(&v), Err(ContractError::Headers)));
    }
    let mut v = input_value();
    v["source"]["headers"][0]["value"] = json!("a\r\nb");
    assert!(matches!(input(&v), Err(ContractError::Headers)));
    v["source"]["headers"] = json!([{"name":"x-a","value":"a"},{"name":"x-a","value":"b"}]);
    assert!(matches!(input(&v), Err(ContractError::Headers)));
    v["source"]["headers"] = json!([{"name":"x-z","value":"a"},{"name":"x-a","value":"b"}]);
    assert!(matches!(input(&v), Err(ContractError::Headers)));
    let mut v = input_value();
    v["source"]["canonical_target"] = json!("https://cdn.example/selected.m3u8?b=2&a=1");
    assert!(matches!(input(&v), Err(ContractError::Policy)));
    v["source"]["access_policy"] = json!({"schema_version":1,"origins":[
        {"origin":"https://source.example","cidrs":["192.0.2.0/24"]},
        {"origin":"https://cdn.example","cidrs":["198.51.100.0/24"]}],"redirects":{"max_hops":5}});
    let frozen = input(&v).unwrap();
    assert!(
        frozen
            .configured_credentials_match_origin("https://source.example/next")
            .unwrap()
    );
    assert!(
        !frozen
            .configured_credentials_match_origin("https://cdn.example/next")
            .unwrap()
    );
    assert_ne!(
        frozen.target_sha256(),
        input(&input_value()).unwrap().target_sha256()
    );
    for cidr in [
        "192.0.2.1/24",
        "192.0.2.0/024",
        "192.0.2.0/33",
        "::ffff:192.0.2.0/80",
    ] {
        let mut bad = v.clone();
        bad["source"]["access_policy"]["origins"][0]["cidrs"][0] = json!(cidr);
        assert!(matches!(input(&bad), Err(ContractError::Policy)));
    }
    for hops in [0, 6] {
        let mut bad = v.clone();
        bad["source"]["access_policy"]["redirects"]["max_hops"] = json!(hops);
        assert!(matches!(input(&bad), Err(ContractError::Policy)));
    }
    let mut bad = v.clone();
    bad["source"]["access_policy"]["origins"][0]["extra"] = json!(1);
    assert!(matches!(input(&bad), Err(ContractError::Shape)));
    let mut reordered = input_value();
    reordered["source"]["canonical_target"] = json!("https://source.example/vod.m3u8?b=2&a=1");
    assert_ne!(input(&reordered).unwrap().input_sha256(), INPUT_HASH);
}

#[test]
fn every_collection_and_plaintext_ciphertext_ceiling_is_checked() {
    let mut v = input_value();
    v["source"]["headers"] = json!(
        (0..33)
            .map(|n| json!({"name":format!("x-{n:02}"),"value":"a"}))
            .collect::<Vec<_>>()
    );
    assert!(matches!(input(&v), Err(ContractError::Headers)));
    for (name, value) in [
        ("x-a".to_owned(), "a".repeat(4097)),
        ("x".repeat(129), "a".to_owned()),
    ] {
        let mut v = input_value();
        v["source"]["headers"] = json!([{"name":name,"value":value}]);
        assert!(matches!(input(&v), Err(ContractError::Headers)));
    }
    let mut v = input_value();
    v["source"]["headers"] = json!(
        (0..4)
            .map(|n| json!({"name":format!("x-{n}"),"value":"a".repeat(4096)}))
            .collect::<Vec<_>>()
    );
    assert!(matches!(input(&v), Err(ContractError::Headers)));
    let mut v = input_value();
    v["source"]["configured_base_url"] =
        json!(format!("https://source.example/{}", "a".repeat(16_363)));
    assert!(matches!(input(&v), Err(ContractError::Url)));
    let mut v = input_value();
    v["source"]["configured_base_url"] =
        json!(format!("https://source.example/{}", "a".repeat(16_300)));
    v["source"]["canonical_target"] =
        json!(format!("https://source.example/{}", "a".repeat(15_000)));
    v["source"]["headers"] = json!(
        (0..4)
            .map(|n| json!({"name":format!("x-{n}"),"value":"a".repeat(4000)}))
            .collect::<Vec<_>>()
    );
    let baseline = serde_json::to_vec(&v).unwrap().len();
    assert!(baseline < MAX_INPUT_PLAINTEXT_BYTES);
    let padding = MAX_INPUT_PLAINTEXT_BYTES - baseline;
    v["source"]["canonical_target"] = json!(format!(
        "https://source.example/{}",
        "a".repeat(15_000 + padding)
    ));
    let exact = serde_json::to_vec(&v).unwrap();
    assert_eq!(exact.len(), MAX_INPUT_PLAINTEXT_BYTES);
    assert_eq!(
        FrozenInput::parse_private_plaintext(&exact)
            .unwrap()
            .private_storage_plaintext()
            .len(),
        MAX_INPUT_PLAINTEXT_BYTES
    );
    let mut too_large = exact.clone();
    too_large.push(b' ');
    assert!(matches!(
        FrozenInput::parse_private_plaintext(&too_large),
        Err(ContractError::Bounds)
    ));
    assert!(matches!(
        FrozenInput::parse_private_plaintext(&vec![b' '; 65_537]),
        Err(ContractError::Bounds)
    ));
    assert_eq!(validate_input_ciphertext_size(&vec![b'x'; 65_536]), Ok(()));
    assert_eq!(
        validate_input_ciphertext_size(&vec![b'x'; 65_537]),
        Err(ContractError::Bounds)
    );
    assert_eq!(
        validate_input_ciphertext_size(b""),
        Err(ContractError::Bounds)
    );
    assert_eq!(
        validate_root_ciphertext_size(&vec![b'x'; 262_145]),
        Err(ContractError::Bounds)
    );
}

#[test]
fn input_identity_and_hash_cannot_change_for_retry_or_bookkeeping() {
    let frozen = input(&input_value()).unwrap();
    let changes: &[fn(&mut IdentityStatement)] = &[
        |v| v.operation_id.push('x'),
        |v| v.session_id.push('x'),
        |v| v.request_owner_epoch.push('x'),
        |v| v.request_sha256.push('x'),
        |v| v.input_sha256.push('x'),
        |v| v.user_id.push('x'),
        |v| v.room_id.push('x'),
        |v| v.auth_login_hash.push('x'),
        |v| v.auth_membership_epoch.push('x'),
        |v| v.lifecycle_epoch += 1,
        |v| v.media_id.push('x'),
        |v| v.media_generation += 1,
        |v| v.viewer_id.push('x'),
        |v| v.plan_generation += 1,
        |v| v.worker_instance.push('x'),
        |v| v.database.push('x'),
        |v| v.source_id.push('x'),
        |v| v.source_policy_revision += 1,
        |v| v.media_source_generation += 1,
    ];
    for change in changes {
        let mut observed = frozen.identity_statement();
        change(&mut observed);
        assert_eq!(
            frozen.require_identity_statement(&observed),
            Err(ContractError::Identity)
        );
    }
    for (key, val) in [
        ("prepare_expires_at_ms", json!(45000)),
        ("root_hard_expires_at_ms", json!(1800000)),
        ("position_ms", json!(1.0)),
        ("request_sha256", json!("3".repeat(64))),
    ] {
        let mut v = input_value();
        v[key] = val;
        assert_eq!(
            frozen.require_same_frozen_input(&input(&v).unwrap()),
            Err(ContractError::Immutable)
        );
    }
}

#[test]
fn graph_closed_shapes_inventory_order_tracks_timeline_and_scan_bounds() {
    for pointer in [
        "",
        "/inventory/0",
        "/closure",
        "/closure/init",
        "/closure/segments/0",
        "/timeline",
        "/timeline/tracks/0",
    ] {
        let mut v = root_value();
        v.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(1));
        assert!(matches!(graph(&v), Err(ContractError::Shape)));
    }
    let duplicate = std::str::from_utf8(ROOT).unwrap().replace(
        "\"graph_version\":1",
        "\"graph_version\":1,\"graph_version\":1",
    );
    assert!(matches!(
        RootGraphStatement::parse_private_plaintext(duplicate.as_bytes()),
        Err(ContractError::Shape)
    ));
    for (pointer, val) in [
        ("/graph_version", json!(2)),
        ("/closure/version", json!(2)),
        ("/inventory/0/bytes", json!(121)),
        ("/timeline/manifest_bytes", json!(121)),
        ("/closure/segments/0/index", json!(1)),
        ("/closure/segments/0/track_ids", json!([1, 1])),
        ("/timeline/tracks/0/packet_count", json!(70001)),
        ("/timeline/tracks/0/time_base", json!("1/0")),
        (
            "/timeline/tracks/0/raw_first_pts",
            json!(MAX_SAFE_INTEGER + 1),
        ),
        ("/timeline/duration_ms", json!(300001)),
        ("/timeline/media_sequence", json!(MAX_SAFE_INTEGER + 1)),
        ("/inventory/0/strong_etag", json!("W/\"weak\"")),
    ] {
        let mut v = root_value();
        *v.pointer_mut(pointer).unwrap() = val;
        assert!(graph(&v).is_err());
    }
    let mut v = root_value();
    v["inventory"].as_array_mut().unwrap().swap(0, 1);
    assert!(graph(&v).is_err());
    let mut v = root_value();
    v["inventory"].as_array_mut().unwrap().pop();
    assert!(matches!(graph(&v), Err(ContractError::Bounds)));
    let mut v = root_value();
    v["timeline"]["tracks"][1]["stream_index"] = json!(0);
    assert!(graph(&v).is_err());
    let mut v = root_value();
    v["timeline"]["tracks"][1]["tail_padding_samples"] = json!(127);
    assert!(matches!(graph(&v), Err(ContractError::Audio)));
    // 64 segments and 66 resources form the exact maximum shape; byte/record
    // ceilings remain independently enforced. This is synthetic data only.
    let mut v = root_value();
    let mut segments = Vec::new();
    let mut inventory = v["inventory"].as_array().unwrap()[..2].to_vec();
    for i in 0..64 {
        let mut segment = v["closure"]["segments"][0].clone();
        segment["index"] = json!(i);
        segments.push(segment);
        inventory.push(v["inventory"][2].clone());
    }
    v["closure"]["segments"] = json!(segments);
    v["timeline"]["segments"] = v["closure"]["segments"].clone();
    v["inventory"] = json!(inventory);
    graph(&v).unwrap();
    let extra = v["closure"]["segments"][0].clone();
    v["closure"]["segments"].as_array_mut().unwrap().push(extra);
    assert!(matches!(graph(&v), Err(ContractError::Bounds)));
}

#[test]
fn child_preserves_parent_input_digest_source_audio_and_complete_root() {
    let parent = input(&input_value()).unwrap();
    let child = input(&child_value()).unwrap();
    let root = graph(&root_value()).unwrap();
    child
        .require_child_of(
            &parent,
            ROOT_HASH,
            SelectedAudioStatement::Single { stream_index: 1 },
        )
        .unwrap();
    assert_ne!(child.input_sha256(), parent.input_sha256());
    root.require_child_recapture(&graph(&root_value()).unwrap(), &child)
        .unwrap();
    let mut wrong = root_value();
    wrong["parent_input_sha256"] = json!(child.input_sha256());
    assert_eq!(
        root.require_child_recapture(&graph(&wrong).unwrap(), &child),
        Err(ContractError::Identity)
    );
    for pointer in [
        "/inventory/2/final_target_sha256",
        "/inventory/2/original_target_sha256",
        "/inventory/2/strong_etag",
    ] {
        let mut changed = root_value();
        *changed.pointer_mut(pointer).unwrap() = if pointer.ends_with("strong_etag") {
            json!("\"v2\"")
        } else {
            json!("6".repeat(64))
        };
        assert_eq!(
            root.require_child_recapture(&graph(&changed).unwrap(), &child),
            Err(ContractError::SourceChanged)
        );
    }
    let mut child_changed = child_value();
    child_changed["source"]["headers"][0]["value"] = json!("changed");
    assert_eq!(
        input(&child_changed).unwrap().require_child_of(
            &parent,
            ROOT_HASH,
            SelectedAudioStatement::Single { stream_index: 1 }
        ),
        Err(ContractError::Identity)
    );
    let mut no_audio = child_value();
    no_audio["root"]["selected_audio"] = json!({"kind":"none"});
    assert!(matches!(input(&no_audio), Err(ContractError::Audio)));
    let mut explicit = input_value();
    explicit["audio_intent"] = json!({"kind":"stream","index":2});
    assert_eq!(
        input(&explicit)
            .unwrap()
            .require_audio_statement(SelectedAudioStatement::Single { stream_index: 1 }),
        Err(ContractError::Audio)
    );
    assert_eq!(
        input(&explicit)
            .unwrap()
            .require_audio_statement(SelectedAudioStatement::None {}),
        Err(ContractError::Audio)
    );
    // Default intent is compatible with a separately supplied scanner result;
    // it never asserts absence by itself.
    parent
        .require_audio_statement(SelectedAudioStatement::Single { stream_index: 1 })
        .unwrap();
    let mut video_only = root_value();
    video_only["timeline"]["tracks"]
        .as_array_mut()
        .unwrap()
        .pop();
    video_only["closure"]["segments"][0]["track_ids"] = json!([1]);
    video_only["timeline"]["segments"][0]["track_ids"] = json!([1]);
    let no_audio_graph = graph(&video_only).unwrap();
    assert_eq!(
        no_audio_graph.selected_audio_statement(),
        SelectedAudioStatement::None {}
    );
    no_audio_graph.require_parent_input(&parent).unwrap();
}

fn changed_child_target_values() -> [Value; 2] {
    std::array::from_fn(|index| {
        let mut value = child_value();
        let mut target =
            url::Url::parse(value["source"]["canonical_target"].as_str().unwrap()).unwrap();
        if index == 0 {
            target.set_path(&format!("{}-different", target.path()));
        } else {
            target.set_query(Some("different=1"));
        }
        value["source"]["canonical_target"] = json!(target.as_str());
        value
    })
}

#[test]
fn child_scan_recapture_rejects_changed_target_with_retained_root() {
    let retained = graph(&root_value()).unwrap();
    let recapture = graph(&root_value()).unwrap();
    retained
        .require_child_recapture(&recapture, &input(&child_value()).unwrap())
        .unwrap();
    for value in changed_child_target_values() {
        let child = input(&value).unwrap();
        assert_eq!(
            retained.require_child_recapture(&recapture, &child),
            Err(ContractError::Identity)
        );
    }
}

#[test]
fn child_scan_publication_rejects_changed_target_with_retained_root() {
    let scan = graph(&root_value()).unwrap();
    let publish = |child: FrozenInput| {
        let identity = child.identity_statement();
        let before = pending(child.clone());
        let after = PhaseStatement::new(
            child,
            OWNER.into(),
            RequestPhase::CompletedChild,
            PublicationPhase::PublishedChild,
            CaptureState::Verified,
            Some(ROOT_HASH.into()),
            Some("8".repeat(64)),
        )
        .unwrap();
        validate_transition(&before, &after, &facts(&identity, Some(&scan), None))
    };
    assert_eq!(publish(input(&child_value()).unwrap()), Ok(()));
    for value in changed_child_target_values() {
        assert_eq!(
            publish(input(&value).unwrap()),
            Err(ContractError::Identity)
        );
    }
}

#[test]
fn pending_marked_unmarked_publication_requires_distinct_complete_facts() {
    let before = pending(input(&input_value()).unwrap());
    let identity = before.input().identity_statement();
    let scan = graph(&root_value()).unwrap();
    let after = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::CompletedMarkedParent,
        PublicationPhase::PublishedParent,
        CaptureState::Verified,
        Some(ROOT_HASH.into()),
        Some("7".repeat(64)),
    )
    .unwrap();
    validate_transition(&before, &after, &facts(&identity, Some(&scan), None)).unwrap();
    let mut missing = facts(&identity, None, None);
    assert_eq!(
        validate_transition(&before, &after, &missing),
        Err(ContractError::Facts)
    );
    missing.complete_scan = Some(&scan);
    missing.publication_session_and_response_atomic = false;
    assert_eq!(
        validate_transition(&before, &after, &missing),
        Err(ContractError::Facts)
    );
    missing.publication_session_and_response_atomic = true;
    missing.same_worker_local_snapshot = false;
    assert_eq!(
        validate_transition(&before, &after, &missing),
        Err(ContractError::Facts)
    );
    let disposed = disposal(&identity);
    let native = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::CompletedUnmarkedNative,
        PublicationPhase::PendingParent,
        CaptureState::Disposed,
        None,
        Some("8".repeat(64)),
    )
    .unwrap();
    validate_transition(&before, &native, &facts(&identity, None, Some(&disposed))).unwrap();
    assert_eq!(
        validate_transition(&before, &native, &facts(&identity, None, None)),
        Err(ContractError::Facts)
    );
    let mut bad = disposal(&identity);
    bad.files_removed = false;
    assert_eq!(
        validate_transition(&before, &native, &facts(&identity, None, Some(&bad))),
        Err(ContractError::Facts)
    );
    let mut expired = facts(&identity, None, Some(&disposed));
    expired.now_ms = before.input().preparation_deadline_ms();
    assert_eq!(
        validate_transition(&before, &native, &expired),
        Err(ContractError::Deadline)
    );
    let mut unexplained = facts(&identity, None, Some(&disposed));
    unexplained.explained_native_result = false;
    assert_eq!(
        validate_transition(&before, &native, &unexplained),
        Err(ContractError::Facts)
    );
}

#[test]
fn committed_failure_revocation_and_disposal_keep_exact_identity_and_evidence() {
    let before = pending(input(&input_value()).unwrap());
    let identity = before.input().identity_statement();
    let failed = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::Failed,
        PublicationPhase::PendingParent,
        CaptureState::Unknown,
        None,
        None,
    )
    .unwrap();
    let mut revoked = facts(&identity, None, None);
    revoked.current_authority_live = false;
    revoked.now_ms = 2_000_000;
    validate_transition(&before, &failed, &revoked).unwrap();
    assert_eq!(
        validate_transition(&failed, &before, &revoked),
        Err(ContractError::Transition)
    );
    let disposed = disposal(&identity);
    let closed = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::Failed,
        PublicationPhase::PendingParent,
        CaptureState::Disposed,
        None,
        None,
    )
    .unwrap();
    revoked.disposal = Some(&disposed);
    validate_transition(&failed, &closed, &revoked).unwrap();
    let mut wrong_identity = identity.clone();
    wrong_identity.auth_login_hash = "9".repeat(64);
    assert_eq!(
        validate_transition(
            &failed,
            &closed,
            &facts(&wrong_identity, None, Some(&disposed))
        ),
        Err(ContractError::Identity)
    );
    let wrong_owner = PhaseStatement::new(
        before.input().clone(),
        "00000000-0000-0000-0000-000000000010".into(),
        RequestPhase::Failed,
        PublicationPhase::PendingParent,
        CaptureState::Unknown,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        validate_transition(&failed, &wrong_owner, &revoked),
        Err(ContractError::Identity)
    );
    let verified = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::CompletedMarkedParent,
        PublicationPhase::PublishedParent,
        CaptureState::Verified,
        Some(ROOT_HASH.into()),
        Some("7".repeat(64)),
    )
    .unwrap();
    let tombstone = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::Failed,
        PublicationPhase::PublishedParent,
        CaptureState::Unknown,
        Some(ROOT_HASH.into()),
        None,
    )
    .unwrap();
    validate_transition(&verified, &tombstone, &revoked).unwrap();
    assert_eq!(
        validate_transition(&tombstone, &verified, &revoked),
        Err(ContractError::Transition)
    );
    let rewritten = PhaseStatement::new(
        before.input().clone(),
        OWNER.into(),
        RequestPhase::CompletedMarkedParent,
        PublicationPhase::PublishedParent,
        CaptureState::Verified,
        Some(ROOT_HASH.into()),
        Some("8".repeat(64)),
    )
    .unwrap();
    assert_eq!(
        validate_transition(&verified, &rewritten, &revoked),
        Err(ContractError::Immutable)
    );
    assert_eq!(
        validate_transition(&verified, &before, &revoked),
        Err(ContractError::Immutable)
    );
}

#[test]
fn shorter_phase_can_end_but_root_deadline_never_extends() {
    let input = input(&input_value()).unwrap();
    let mut fences = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    fences.observe(100, 850, 1_900_000, Some(100_000)).unwrap();
    fences.complete_preparation(1000).unwrap();
    fences.require_live(60_000).unwrap(); // old pending phase no longer applies
    fences.observe(60_000, 60_750, 2_000_000, None).unwrap();
    assert_eq!(fences.require_live(1_800_000), Err(ContractError::Deadline));
    let mut fences = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    assert_eq!(
        fences.observe(1000, 1750, 10000, Some(750)),
        Err(ContractError::Deadline)
    );
    assert_eq!(
        fences.complete_preparation(1750),
        Err(ContractError::Deadline)
    );
    let mut fences = DeadlineFenceStatements::from_input(&input, 1000, 0).unwrap();
    assert_eq!(
        fences.observe(1, 2, 1000, None),
        Err(ContractError::Deadline)
    );
    assert_eq!(fences.require_live(2), Err(ContractError::Deadline));
    for (key, val) in [
        ("root_hard_expires_at_ms", json!(1801001)),
        ("prepare_expires_at_ms", json!(46001)),
        ("prepare_started_at_ms", json!(999)),
    ] {
        let mut v = input_value();
        v[key] = val;
        assert!(matches!(
            super::tests::input(&v),
            Err(ContractError::Deadline)
        ));
    }
}

#[test]
fn child_output_survives_positive_input_disposal_under_its_own_binding() {
    let child = input(&child_value()).unwrap();
    let identity = child.identity_statement();
    let scan = graph(&root_value()).unwrap();
    let before = pending(child.clone());
    let output = PhaseStatement::new(
        child.clone(),
        OWNER.into(),
        RequestPhase::CompletedChild,
        PublicationPhase::PublishedChild,
        CaptureState::Verified,
        Some(ROOT_HASH.into()),
        Some("8".repeat(64)),
    )
    .unwrap();
    validate_transition(&before, &output, &facts(&identity, Some(&scan), None)).unwrap();
    let disposed = disposal(&identity);
    let closed = PhaseStatement::new(
        child.clone(),
        OWNER.into(),
        RequestPhase::CompletedChild,
        PublicationPhase::PublishedChild,
        CaptureState::Disposed,
        Some(ROOT_HASH.into()),
        Some("8".repeat(64)),
    )
    .unwrap();
    validate_transition(&output, &closed, &facts(&identity, None, Some(&disposed))).unwrap();
    let mut delivery = DeliveryStatements {
        identity: &identity,
        now_ms: 60_000,
        current_authority_live: true,
        grant_live: true,
        input_sha256: child.input_sha256(),
        root_digest: ROOT_HASH,
        reader_version: 2,
        recipe_version: 1,
        same_worker_local_snapshot: false,
        verified_job_attempt_output_binding: true,
    };
    validate_child_output_statement(&closed, &delivery).unwrap();
    delivery.verified_job_attempt_output_binding = false;
    assert_eq!(
        validate_child_output_statement(&closed, &delivery),
        Err(ContractError::Facts)
    );
    delivery.verified_job_attempt_output_binding = true;
    delivery.now_ms = child.root_deadline_ms();
    assert_eq!(
        validate_child_output_statement(&closed, &delivery),
        Err(ContractError::Deadline)
    );
}
