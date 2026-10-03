use super::*;
use serde_json::{Value, json};

const CAPTURE: &str = "00000000-0000-0000-0000-000000000001";
fn input() -> FrozenInput {
    FrozenInput::parse_private_plaintext(include_bytes!("../golden_input_v1.json")).unwrap()
}
fn expected_at(issued: u64, challenge: &str, cache: &str) -> ExpectedBinding {
    let input = input();
    ExpectedBinding::from_trusted_input(
        &input,
        &input.identity_statement(),
        ChallengeObservation {
            challenge: challenge.into(),
            cache_challenge_sha256: cache.repeat(64),
            challenge_expires_at_ms: issued + RPC_LIFETIME_MS,
        },
        RpcWindow {
            issued_at_ms: issued,
            rpc_expires_at_ms: issued + RPC_LIFETIME_MS,
        },
        issued,
    )
    .unwrap()
}
fn expected() -> ExpectedBinding {
    expected_at(2_000, "00000000-0000-0000-0000-0000000000aa", "c")
}
fn live(expected: &ExpectedBinding) -> CallAuthority<'_> {
    CallAuthority::LivePending(LivePendingAuthorityStatement {
        current_identity: &expected.original_identity,
        current_authority_live: true,
        observed_at_ms: 2_000,
        pending_lease_expires_at_ms: 61_000,
    })
}
fn request() -> OperationRequest {
    OperationRequest::for_expected(
        Action::Query,
        &expected(),
        2_000,
        CallAuthority::ObservationOnly,
    )
    .unwrap()
}
fn response() -> OperationResponse {
    OperationResponse::for_expected(
        Action::Query,
        &expected(),
        OperationResult::Unknown {
            capture_id: None,
            reason: Reason::LocalOwnerMissing,
        },
        2_000,
        CallAuthority::ObservationOnly,
    )
    .unwrap()
}
fn request_value() -> Value {
    serde_json::from_slice(request().private_transport_plaintext()).unwrap()
}
fn response_value() -> Value {
    serde_json::from_slice(response().private_transport_plaintext()).unwrap()
}
fn parse_request(value: &Value) -> Result<OperationRequest> {
    OperationRequest::parse_private_plaintext(&serde_json::to_vec(value).unwrap())
}
fn parse_response(value: &Value) -> Result<OperationResponse> {
    OperationResponse::parse_private_plaintext(&serde_json::to_vec(value).unwrap())
}

#[test]
fn exact_declared_wire_order_and_parse_reserialize_stability() {
    let bytes = concat!(
        "{\"purpose\":\"rainsync-static-hls-query-request-v1\",\"rpc_version\":1,\"binding\":{",
        "\"operation_id\":\"00000000-0000-0000-0000-000000000001\",\"operation_kind\":\"parent\",",
        "\"session_id\":\"00000000-0000-0000-0000-000000000002\",\"request_owner_epoch\":\"00000000-0000-0000-0000-000000000003\",",
        "\"request_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",",
        "\"input_sha256\":\"c93f932283d5105f0f2f18b7f7875305603494793e94cb442890beae473eb784\",",
        "\"worker_instance\":\"00000000-0000-0000-0000-000000000009\",\"database\":\"00000000-0000-0000-0000-00000000000a\",",
        "\"challenge\":\"00000000-0000-0000-0000-0000000000aa\",",
        "\"cache_challenge_sha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",",
        "\"reader_version\":2,\"recipe_version\":1,\"input_version\":1,\"graph_version\":1,",
        "\"issued_at_ms\":2000,\"rpc_expires_at_ms\":8000,\"root_hard_expires_at_ms\":1801000,\"prepare_expires_at_ms\":46000}}"
    ).as_bytes();
    assert_eq!(request().private_transport_plaintext(), bytes);
    assert_eq!(
        parse_request(&request_value())
            .unwrap()
            .private_transport_plaintext(),
        bytes
    );
    assert_eq!(
        OperationRequest::parse_private_plaintext(bytes)
            .unwrap()
            .private_transport_plaintext(),
        bytes
    );
    let text = std::str::from_utf8(bytes)
        .unwrap()
        .replace("query-request", "query-response");
    let expected_response = format!(
        "{},\"result\":{{\"kind\":\"unknown\",\"capture_id\":null,\"reason\":\"local_owner_missing\"}}}}",
        &text[..text.len() - 1]
    );
    assert_eq!(
        response().private_transport_plaintext(),
        expected_response.as_bytes()
    );
    assert_eq!(
        parse_response(&response_value())
            .unwrap()
            .private_transport_plaintext(),
        response().private_transport_plaintext()
    );
    assert!(
        !std::str::from_utf8(bytes)
            .unwrap()
            .contains("auth_login_hash")
    );
}

#[test]
fn all_purposes_and_versions_are_separate_and_diagnostic_is_forbidden() {
    let expected = expected();
    for action in [Action::Create, Action::Query, Action::Cancel] {
        let request =
            OperationRequest::for_expected(action, &expected, 2_000, live(&expected)).unwrap();
        request
            .validate_expected(action, &expected, 2_000, live(&expected))
            .unwrap();
        let response = OperationResponse::for_expected(
            action,
            &expected,
            OperationResult::Refused {
                capture_id: None,
                reason: Reason::Unavailable,
            },
            2_000,
            live(&expected),
        )
        .unwrap();
        response
            .validate_expected(action, &expected, 2_000, live(&expected))
            .unwrap();
        for other in [Action::Create, Action::Query, Action::Cancel]
            .into_iter()
            .filter(|other| *other != action)
        {
            assert_eq!(
                request.validate_expected(other, &expected, 2_000, live(&expected)),
                Err(ContractError::Version)
            );
            assert_eq!(
                response.validate_expected(other, &expected, 2_000, live(&expected)),
                Err(ContractError::Version)
            );
        }
    }
    for purpose in [
        "rainsync-static-hls-contract-request-v1",
        "rainsync-static-hls-query-response-v1",
        "rainsync-static-hls-create-request-v2",
        "",
    ] {
        let mut value = request_value();
        value["purpose"] = json!(purpose);
        assert!(matches!(parse_request(&value), Err(ContractError::Version)));
    }
    for purpose in [
        "rainsync-static-hls-contract-response-v1",
        "rainsync-static-hls-query-request-v1",
        "rainsync-static-hls-create-response-v2",
        "",
    ] {
        let mut value = response_value();
        value["purpose"] = json!(purpose);
        assert!(matches!(
            parse_response(&value),
            Err(ContractError::Version)
        ));
    }
    for field in [
        "rpc_version",
        "reader_version",
        "recipe_version",
        "input_version",
        "graph_version",
    ] {
        let mut value = request_value();
        if field == "rpc_version" {
            value[field] = json!(9);
        } else {
            value["binding"][field] = json!(9);
        }
        assert!(matches!(parse_request(&value), Err(ContractError::Version)));
    }
}

#[test]
fn both_directions_compare_every_echoed_binding_against_trusted_context() {
    let expected = expected();
    for field in [
        "operation_id",
        "operation_kind",
        "session_id",
        "request_owner_epoch",
        "request_sha256",
        "input_sha256",
        "worker_instance",
        "database",
        "challenge",
        "cache_challenge_sha256",
        "issued_at_ms",
        "rpc_expires_at_ms",
        "root_hard_expires_at_ms",
        "prepare_expires_at_ms",
    ] {
        let mut request = request_value();
        let field_value = &mut request["binding"][field];
        *field_value = match field {
            "operation_kind" => json!("child"),
            "request_sha256" | "input_sha256" | "cache_challenge_sha256" => json!("d".repeat(64)),
            "issued_at_ms" => json!(2_001),
            "rpc_expires_at_ms" => json!(7_999),
            "root_hard_expires_at_ms" => json!(1_801_001),
            "prepare_expires_at_ms" => json!(46_001),
            _ => json!("00000000-0000-0000-0000-0000000000ff"),
        };
        let parsed = parse_request(&request).unwrap();
        assert_eq!(
            parsed.validate_expected(
                Action::Query,
                &expected,
                2_001,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Identity),
            "{field}"
        );
        let mut response = response_value();
        response["binding"] = request["binding"].clone();
        assert_eq!(
            parse_response(&response).unwrap().validate_expected(
                Action::Query,
                &expected,
                2_001,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Identity),
            "{field}"
        );
    }
    let input = input();
    for change in ["login", "request", "worker", "database", "membership"] {
        let mut current = input.identity_statement();
        match change {
            "login" => current.auth_login_hash = "d".repeat(64),
            "request" => current.request_sha256 = "d".repeat(64),
            "worker" => current.worker_instance = CAPTURE.into(),
            "database" => current.database = CAPTURE.into(),
            "membership" => current.auth_membership_epoch = CAPTURE.into(),
            _ => unreachable!(),
        }
        assert!(matches!(
            ExpectedBinding::from_trusted_input(
                &input,
                &current,
                ChallengeObservation {
                    challenge: CAPTURE.into(),
                    cache_challenge_sha256: "c".repeat(64),
                    challenge_expires_at_ms: 8_000
                },
                RpcWindow {
                    issued_at_ms: 2_000,
                    rpc_expires_at_ms: 8_000
                },
                2_000
            ),
            Err(ContractError::Identity)
        ));
    }
}

#[test]
fn map_only_required_fields_duplicate_unknown_and_exact_scalar_types() {
    for is_response in [false, true] {
        let baseline = if is_response {
            response_value()
        } else {
            request_value()
        };
        let parse = |value: &Value| {
            if is_response {
                parse_response(value).map(|_| ())
            } else {
                parse_request(value).map(|_| ())
            }
        };
        for pointer in ["", "/binding"] {
            let mut value = baseline.clone();
            let object = value.pointer_mut(pointer).unwrap();
            let array = object
                .as_object()
                .unwrap()
                .values()
                .cloned()
                .collect::<Vec<_>>();
            *object = json!(array);
            assert_eq!(parse(&value), Err(ContractError::Shape));
            let mut value = baseline.clone();
            value
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("url".into(), json!("https://secret.invalid/?key=PRIVATE"));
            let error = parse(&value).unwrap_err();
            assert_eq!(error, ContractError::Shape);
            assert!(!error.to_string().contains("PRIVATE"));
            for key in baseline
                .pointer(pointer)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
            {
                let mut value = baseline.clone();
                value
                    .pointer_mut(pointer)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(key);
                assert_eq!(parse(&value), Err(ContractError::Shape), "{pointer}/{key}");
            }
        }
        let text = serde_json::to_string(&baseline).unwrap();
        for (needle, duplicate) in [
            ("\"rpc_version\":1", "\"rpc_version\":1,\"rpc_version\":1"),
            (
                "\"issued_at_ms\":2000",
                "\"issued_at_ms\":2000,\"issued_at_ms\":2000",
            ),
            (
                "\"operation_kind\":\"parent\"",
                "\"operation_kind\":\"parent\",\"operation_kind\":\"parent\"",
            ),
        ] {
            let bytes = text.replace(needle, duplicate);
            let result = if is_response {
                OperationResponse::parse_private_plaintext(bytes.as_bytes()).map(|_| ())
            } else {
                OperationRequest::parse_private_plaintext(bytes.as_bytes()).map(|_| ())
            };
            assert_eq!(result, Err(ContractError::Shape));
        }
        for field in [
            "issued_at_ms",
            "rpc_expires_at_ms",
            "root_hard_expires_at_ms",
            "prepare_expires_at_ms",
        ] {
            for scalar in [
                json!(-1),
                json!(2_000.0),
                json!("2000"),
                json!(null),
                json!(true),
            ] {
                let mut value = baseline.clone();
                value["binding"][field] = scalar;
                assert_eq!(parse(&value), Err(ContractError::Shape));
            }
            let mut value = baseline.clone();
            value["binding"][field] = json!(MAX_SAFE_INTEGER + 1);
            assert_eq!(parse(&value), Err(ContractError::Bounds));
        }
        for field in [
            "operation_id",
            "session_id",
            "request_owner_epoch",
            "worker_instance",
            "database",
            "challenge",
        ] {
            for uuid in [
                "00000000-0000-0000-0000-000000000000",
                "00000000-0000-0000-0000-0000000000AA",
                "not-a-uuid",
            ] {
                let mut value = baseline.clone();
                value["binding"][field] = json!(uuid);
                assert_eq!(parse(&value), Err(ContractError::Identity));
            }
        }
        let mut value = baseline.clone();
        value["binding"]["operation_kind"] = json!({"parent":null});
        assert_eq!(parse(&value), Err(ContractError::Shape));
        for field in ["request_sha256", "input_sha256", "cache_challenge_sha256"] {
            let mut value = baseline.clone();
            value["binding"][field] = json!("A".repeat(64));
            assert_eq!(parse(&value), Err(ContractError::Identity));
        }
    }
}

#[test]
fn rpc_and_challenge_freshness_do_not_extend_original_work_fences() {
    let expected = expected();
    assert_eq!(expected.require_fresh(1_999), Err(ContractError::Deadline));
    expected.require_fresh(2_000).unwrap();
    expected.require_fresh(7_999).unwrap();
    assert_eq!(expected.require_fresh(8_000), Err(ContractError::Deadline));
    let mut too_long = request_value();
    too_long["binding"]["rpc_expires_at_ms"] = json!(8_001);
    assert!(matches!(
        parse_request(&too_long),
        Err(ContractError::Deadline)
    ));
    let mut zero = request_value();
    zero["binding"]["rpc_expires_at_ms"] = json!(2_000);
    assert!(matches!(parse_request(&zero), Err(ContractError::Deadline)));
    let input = input();
    let short_cache = ExpectedBinding::from_trusted_input(
        &input,
        &input.identity_statement(),
        ChallengeObservation {
            challenge: CAPTURE.into(),
            cache_challenge_sha256: "d".repeat(64),
            challenge_expires_at_ms: 3_000,
        },
        RpcWindow {
            issued_at_ms: 2_000,
            rpc_expires_at_ms: 8_000,
        },
        2_000,
    )
    .unwrap();
    short_cache.require_fresh(2_999).unwrap();
    assert_eq!(
        short_cache.require_fresh(3_000),
        Err(ContractError::Deadline)
    );
    assert!(matches!(
        OperationRequest::for_expected(
            Action::Create,
            &expected,
            2_000,
            CallAuthority::ObservationOnly
        ),
        Err(ContractError::Facts)
    ));
    assert!(
        OperationRequest::for_expected(Action::Create, &expected, 2_000, live(&expected)).is_ok()
    );
    for fence in [46_000, 1_801_000, 1_801_001] {
        let next = expected_at(fence, CAPTURE, "d");
        for action in [Action::Query, Action::Cancel] {
            OperationRequest::for_expected(action, &next, fence, CallAuthority::ObservationOnly)
                .unwrap();
            OperationResponse::for_expected(
                action,
                &next,
                OperationResult::Disposed {
                    capture_id: CAPTURE.into(),
                    disposed_at_ms: fence,
                },
                fence,
                CallAuthority::ObservationOnly,
            )
            .unwrap();
        }
        assert!(matches!(
            OperationRequest::for_expected(Action::Create, &next, fence, live(&next)),
            Err(ContractError::Deadline)
        ));
        assert_eq!(
            next.binding.root_hard_expires_at_ms,
            expected.binding.root_hard_expires_at_ms
        );
        assert_eq!(
            next.binding.prepare_expires_at_ms,
            expected.binding.prepare_expires_at_ms
        );
    }
    for (live_authority, observed, lease) in [
        (false, 2_000, 61_000),
        (true, 2_001, 61_000),
        (true, 2_000, 2_000),
    ] {
        let statement = CallAuthority::LivePending(LivePendingAuthorityStatement {
            current_identity: &expected.original_identity,
            current_authority_live: live_authority,
            observed_at_ms: observed,
            pending_lease_expires_at_ms: lease,
        });
        assert!(matches!(
            OperationRequest::for_expected(Action::Create, &expected, 2_000, statement),
            Err(ContractError::Deadline)
        ));
    }
    let mut wrong_login = expected.original_identity.clone();
    wrong_login.auth_login_hash = "d".repeat(64);
    assert_eq!(
        request().validate_expected(Action::Create, &expected, 2_000, live(&expected)),
        Err(ContractError::Version)
    );
    let created =
        OperationRequest::for_expected(Action::Create, &expected, 2_000, live(&expected)).unwrap();
    assert_eq!(
        created.validate_expected(
            Action::Create,
            &expected,
            2_000,
            CallAuthority::LivePending(LivePendingAuthorityStatement {
                current_identity: &wrong_login,
                current_authority_live: true,
                observed_at_ms: 2_000,
                pending_lease_expires_at_ms: 61_000
            })
        ),
        Err(ContractError::Identity)
    );
    // Equality tests intentionally accept the same statement twice. A future
    // one-use challenge store must reject consumed/replayed observations.
    request()
        .validate_expected(
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
    request()
        .validate_expected(
            Action::Query,
            &expected,
            2_000,
            CallAuthority::ObservationOnly,
        )
        .unwrap();
    let next = expected_at(2_001, CAPTURE, "d");
    let next_request =
        OperationRequest::for_expected(Action::Query, &next, 2_001, CallAuthority::ObservationOnly)
            .unwrap();
    next_request
        .validate_expected(Action::Query, &next, 2_001, CallAuthority::ObservationOnly)
        .unwrap();
    assert_eq!(
        next_request.validate_expected(
            Action::Query,
            &expected,
            2_001,
            CallAuthority::ObservationOnly
        ),
        Err(ContractError::Identity)
    );
}

#[test]
fn every_closed_result_capture_null_reason_and_audio_shape() {
    let variants = [
        json!({"kind":"pending","capture_id":CAPTURE,"stage":"capture"}),
        json!({"kind":"verified","capture_id":CAPTURE,"root_digest":"d".repeat(64),"verified_at_ms":1999,"selected_audio":{"kind":"single","stream_index":1}}),
        json!({"kind":"cancel_requested","capture_id":CAPTURE}),
        json!({"kind":"refused","capture_id":null,"reason":"deadline"}),
        json!({"kind":"disposed","capture_id":CAPTURE,"disposed_at_ms":1999}),
        json!({"kind":"unknown","capture_id":null,"reason":"local_owner_missing"}),
    ];
    for result in variants {
        let mut value = response_value();
        value["result"] = result.clone();
        parse_response(&value)
            .unwrap()
            .validate_expected(
                Action::Query,
                &expected(),
                2_000,
                CallAuthority::ObservationOnly,
            )
            .unwrap();
        let mut foreign = value.clone();
        foreign["result"]["capture_id"] = json!("00000000-0000-0000-0000-0000000000ff");
        let foreign = parse_response(&foreign).unwrap();
        assert_eq!(
            foreign.validate_expected(
                Action::Query,
                &expected(),
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Identity)
        );
        assert!(matches!(
            OperationResponse::for_expected(
                Action::Query,
                &expected(),
                foreign.wire.result,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Identity)
        ));
        for key in result.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing["result"].as_object_mut().unwrap().remove(key);
            assert!(
                matches!(parse_response(&missing), Err(ContractError::Shape)),
                "{key}"
            );
        }
        let mut extra = value.clone();
        extra["result"]["proof"] = json!("opaque");
        assert!(matches!(parse_response(&extra), Err(ContractError::Shape)));
        let mut array = value.clone();
        array["result"] = json!(result.as_object().unwrap().values().collect::<Vec<_>>());
        assert!(matches!(parse_response(&array), Err(ContractError::Shape)));
        let text = serde_json::to_string(&value).unwrap();
        for (key, data) in result.as_object().unwrap() {
            let needle = format!(
                "{}:{}",
                serde_json::to_string(key).unwrap(),
                serde_json::to_string(data).unwrap()
            );
            let duplicate = text.replacen(&needle, &format!("{needle},{needle}"), 1);
            assert!(
                matches!(
                    OperationResponse::parse_private_plaintext(duplicate.as_bytes()),
                    Err(ContractError::Shape)
                ),
                "{key}"
            );
        }
        if !matches!(result["kind"].as_str(), Some("refused" | "unknown")) {
            let mut null = value.clone();
            null["result"]["capture_id"] = Value::Null;
            assert!(matches!(parse_response(&null), Err(ContractError::Shape)));
        }
    }
    for reason in [
        "unsupported_input",
        "source_changed",
        "authority_revoked",
        "deadline",
        "capacity",
        "unsupported_version",
        "worker_mismatch",
        "local_owner_missing",
        "operation_conflict",
        "cancelled",
        "unavailable",
    ] {
        let mut value = response_value();
        value["result"]["reason"] = json!(reason);
        parse_response(&value).unwrap();
    }
    for reason in [
        json!("upstream_error_detail"),
        json!({"deadline":null}),
        json!(null),
    ] {
        let mut value = response_value();
        value["result"]["reason"] = reason;
        assert!(matches!(parse_response(&value), Err(ContractError::Shape)));
    }
    for stage in ["capture", "verify", "drain"] {
        let mut value = response_value();
        value["result"] = json!({"kind":"pending","capture_id":CAPTURE,"stage":stage});
        parse_response(&value).unwrap();
    }
    for audio in [
        json!({"kind":"none"}),
        json!({"kind":"single","stream_index":0}),
    ] {
        let mut value = response_value();
        value["result"] = json!({"kind":"verified","capture_id":CAPTURE,"root_digest":"d".repeat(64),"verified_at_ms":2000,"selected_audio":audio});
        parse_response(&value).unwrap();
    }
    for audio in [
        json!(["single", 1]),
        json!({"kind":"single","stream_index":1,"url":"private"}),
        json!({"kind":"single"}),
        json!({"kind":"none","stream_index":1}),
    ] {
        let mut value = response_value();
        value["result"] = json!({"kind":"verified","capture_id":CAPTURE,"root_digest":"d".repeat(64),"verified_at_ms":2000,"selected_audio":audio});
        assert!(matches!(parse_response(&value), Err(ContractError::Shape)));
    }
    let mut future = response_value();
    future["result"] = json!({"kind":"disposed","capture_id":CAPTURE,"disposed_at_ms":2001});
    assert_eq!(
        parse_response(&future).unwrap().validate_expected(
            Action::Query,
            &expected(),
            2_000,
            CallAuthority::ObservationOnly
        ),
        Err(ContractError::Deadline)
    );
    future["result"]["disposed_at_ms"] = json!(MAX_SAFE_INTEGER + 1);
    assert!(matches!(
        parse_response(&future),
        Err(ContractError::Bounds)
    ));
}

#[test]
fn verified_statements_cannot_contradict_frozen_audio_child_root_or_work_deadline() {
    let make_expected = |input: &FrozenInput| {
        ExpectedBinding::from_trusted_input(
            input,
            &input.identity_statement(),
            ChallengeObservation {
                challenge: "00000000-0000-0000-0000-0000000000aa".into(),
                cache_challenge_sha256: "c".repeat(64),
                challenge_expires_at_ms: 8_000,
            },
            RpcWindow {
                issued_at_ms: 2_000,
                rpc_expires_at_ms: 8_000,
            },
            2_000,
        )
        .unwrap()
    };
    let mut value: Value =
        serde_json::from_slice(include_bytes!("../golden_input_v1.json")).unwrap();
    value["audio_intent"] = json!({"kind":"stream","index":1});
    let parent =
        FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
    let expected = make_expected(&parent);
    let verified =
        |root: &str, audio: SelectedAudioStatement, time: u64| OperationResult::Verified {
            capture_id: expected.binding.operation_id.clone(),
            root_digest: root.repeat(64),
            verified_at_ms: time,
            selected_audio: audio,
        };
    for audio in [
        SelectedAudioStatement::None {},
        SelectedAudioStatement::Single { stream_index: 2 },
    ] {
        assert!(matches!(
            OperationResponse::for_expected(
                Action::Query,
                &expected,
                verified("d", audio, 2_000),
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Audio)
        ));
        let mut response = response_value();
        response["binding"] = serde_json::to_value(&expected.binding).unwrap();
        response["result"] = serde_json::to_value(verified("d", audio, 2_000)).unwrap();
        assert_eq!(
            parse_response(&response).unwrap().validate_expected(
                Action::Query,
                &expected,
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::Audio)
        );
    }
    value["kind"] = json!("child");
    value["operation_id"] = json!("00000000-0000-0000-0000-00000000000d");
    value["session_id"] = json!("00000000-0000-0000-0000-00000000000e");
    value["root"] = json!({
        "parent_session_id":"00000000-0000-0000-0000-000000000002",
        "parent_capture_id":CAPTURE,"parent_input_sha256":parent.input_sha256(),
        "root_digest":"d".repeat(64),"root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
        "selected_audio":{"kind":"single","stream_index":1}
    });
    let child = FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
    let expected = make_expected(&child);
    let verified = |root: &str, audio: SelectedAudioStatement| OperationResult::Verified {
        capture_id: expected.binding.operation_id.clone(),
        root_digest: root.repeat(64),
        verified_at_ms: 2_000,
        selected_audio: audio,
    };
    OperationResponse::for_expected(
        Action::Query,
        &expected,
        verified("d", SelectedAudioStatement::Single { stream_index: 1 }),
        2_000,
        CallAuthority::ObservationOnly,
    )
    .unwrap();
    assert!(matches!(
        OperationResponse::for_expected(
            Action::Query,
            &expected,
            verified("e", SelectedAudioStatement::Single { stream_index: 1 }),
            2_000,
            CallAuthority::ObservationOnly
        ),
        Err(ContractError::SourceChanged)
    ));
    // Default intent still must preserve the child's scanner-selected root audio.
    value["audio_intent"] = json!({"kind":"default"});
    let default_child =
        FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
    let default_expected = make_expected(&default_child);
    for audio in [
        SelectedAudioStatement::None {},
        SelectedAudioStatement::Single { stream_index: 2 },
    ] {
        assert!(matches!(
            OperationResponse::for_expected(
                Action::Query,
                &default_expected,
                verified("d", audio),
                2_000,
                CallAuthority::ObservationOnly
            ),
            Err(ContractError::SourceChanged)
        ));
    }
    let expired = expected_at(46_000, "00000000-0000-0000-0000-0000000000aa", "c");
    assert!(matches!(
        OperationResponse::for_expected(
            Action::Query,
            &expired,
            OperationResult::Verified {
                capture_id: CAPTURE.into(),
                root_digest: "d".repeat(64),
                verified_at_ms: 46_000,
                selected_audio: SelectedAudioStatement::None {}
            },
            46_000,
            CallAuthority::ObservationOnly
        ),
        Err(ContractError::Deadline)
    ));
    OperationResponse::for_expected(
        Action::Query,
        &expired,
        OperationResult::Verified {
            capture_id: CAPTURE.into(),
            root_digest: "d".repeat(64),
            verified_at_ms: 45_999,
            selected_audio: SelectedAudioStatement::None {},
        },
        46_000,
        CallAuthority::ObservationOnly,
    )
    .unwrap();
}

#[test]
fn exact_plaintext_limits_and_no_sensitive_projection_traits() {
    let request = request();
    let response = response();
    for (bytes, maximum, is_response) in [
        (
            request.private_transport_plaintext(),
            MAX_REQUEST_PLAINTEXT_BYTES,
            false,
        ),
        (
            response.private_transport_plaintext(),
            MAX_RESPONSE_PLAINTEXT_BYTES,
            true,
        ),
    ] {
        let mut padded = bytes.to_vec();
        padded.resize(maximum, b' ');
        let parse = |bytes: &[u8]| {
            if is_response {
                OperationResponse::parse_private_plaintext(bytes).map(|_| ())
            } else {
                OperationRequest::parse_private_plaintext(bytes).map(|_| ())
            }
        };
        parse(&padded).unwrap();
        padded.push(b' ');
        assert_eq!(parse(&padded), Err(ContractError::Bounds));
        assert_eq!(parse(b""), Err(ContractError::Bounds));
    }
    trait AmbiguousDebug<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousDebug<()> for T {}
    impl<T: ?Sized + std::fmt::Debug> AmbiguousDebug<u8> for T {}
    let _ = <ExpectedBinding as AmbiguousDebug<_>>::check;
    let _ = <OperationRequest as AmbiguousDebug<_>>::check;
    let _ = <OperationResponse as AmbiguousDebug<_>>::check;
    trait AmbiguousSerialize<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousSerialize<()> for T {}
    impl<T: ?Sized + serde::Serialize> AmbiguousSerialize<u8> for T {}
    let _ = <ExpectedBinding as AmbiguousSerialize<_>>::check;
    let _ = <OperationRequest as AmbiguousSerialize<_>>::check;
    let _ = <OperationResponse as AmbiguousSerialize<_>>::check;
}
