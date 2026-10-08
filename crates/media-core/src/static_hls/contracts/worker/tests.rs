use super::*;
use crate::static_hls::contracts::graph::RootGraphStatement;
use serde_json::{Value, json};

const PARENT: &[u8] = include_bytes!("../golden_input_v1.json");
const ROOT: &[u8] = include_bytes!("../golden_root_v1.json");
const OTHER: &str = "00000000-0000-0000-0000-000000000020";

fn parent() -> FrozenInput {
    FrozenInput::parse_private_plaintext(PARENT).unwrap()
}
fn child_at(position: f64) -> FrozenInput {
    let parent = parent();
    let graph = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
    let mut value: Value = serde_json::from_slice(PARENT).unwrap();
    value["kind"] = json!("child");
    value["operation_id"] = json!("00000000-0000-0000-0000-00000000000d");
    value["session_id"] = json!("00000000-0000-0000-0000-00000000000e");
    value["request_owner_epoch"] = json!("00000000-0000-0000-0000-00000000000f");
    value["request_sha256"] = json!("2".repeat(64));
    value["plan_generation"] = json!(2);
    value["position_ms"] = json!(position);
    value["prepare_started_at_ms"] = json!(2000);
    value["prepare_expires_at_ms"] = json!(47000);
    value["root"] = json!({
        "parent_session_id":parent.identity_statement().session_id,
        "parent_capture_id":parent.identity_statement().operation_id,
        "parent_input_sha256":parent.input_sha256(),"root_digest":graph.root_digest(),
        "root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
        "selected_audio":{"kind":"single","stream_index":1}
    });
    FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn child() -> FrozenInput {
    child_at(1234.125)
}
fn worker_value(input: &FrozenInput) -> Value {
    let identity = input.identity_statement();
    json!({"reader_version":2,"recipe_version":1,"input_version":1,"graph_version":1,
        "worker_instance":identity.worker_instance,"database":identity.database,
        "tasks":["parent_capture","parent_read","parent_publication","child_encode"]})
}
fn worker(value: &Value) -> Result<WorkerStatement> {
    WorkerStatement::parse_private_plaintext(&serde_json::to_vec(value).unwrap())
}
fn job_value(child: &FrozenInput) -> Value {
    let identity = child.identity_statement();
    json!({"kind":"static_hls_child","reader_version":2,"recipe_version":1,
        "input_version":1,"graph_version":1,"capture_id":identity.operation_id,
        "input_sha256":child.input_sha256(),"root_digest":child.child_root().unwrap().root_digest,
        "worker_instance":identity.worker_instance,"position_ms":child.position_ms(),
        "selected_audio":{"kind":"single","stream_index":1},"estimated_output_bytes":33554432})
}
fn job(value: &Value) -> Result<ChildJobSpec> {
    ChildJobSpec::parse_private_plaintext(&serde_json::to_vec(value).unwrap())
}
fn owner(spec: &ChildJobSpec) -> LocalChildOwnerStatement<'_> {
    LocalChildOwnerStatement {
        worker_instance: &spec.0.worker_instance,
        capture_id: &spec.0.capture_id,
        input_sha256: &spec.0.input_sha256,
        root_digest: &spec.0.root_digest,
        snapshot_and_permit_live: true,
    }
}

#[test]
fn constructor_derives_the_exact_closed_spec_from_frozen_child_input() {
    for position in [-0.0, 1234.125, MAX_SAFE_INTEGER as f64] {
        let input = child_at(position);
        let spec = ChildJobSpec::from_child_input(&input).unwrap();
        spec.require_input_statement(&input).unwrap();
        let stored = spec.private_storage_plaintext().unwrap();
        assert!(stored.len() <= MAX_CHILD_JOB_SPEC_BYTES);
        let value: Value = serde_json::from_slice(&stored).unwrap();
        assert_eq!(value, job_value(&input));
        assert_eq!(value.as_object().unwrap().len(), 12);
        assert_ne!(value["input_sha256"], json!(parent().input_sha256()));
        let reloaded = ChildJobSpec::parse_private_plaintext(&stored).unwrap();
        spec.require_same_spec_statement(&reloaded).unwrap();
        reloaded.require_input_statement(&input).unwrap();
        assert_eq!(reloaded.private_storage_plaintext().unwrap(), stored);
        if position == 0.0 {
            assert!(spec.0.position_ms.is_sign_positive());
        }
    }
}

#[test]
fn constructor_refuses_parent_input_and_mismatched_selected_audio_intent() {
    assert!(matches!(
        ChildJobSpec::from_child_input(&parent()),
        Err(ContractError::Identity)
    ));
    let input = child();
    let mut value: Value = serde_json::from_slice(input.private_storage_plaintext()).unwrap();
    value["audio_intent"] = json!({"kind":"stream","index":2});
    let mismatched =
        FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(matches!(
        ChildJobSpec::from_child_input(&mismatched),
        Err(ContractError::Audio)
    ));
    value["audio_intent"] = json!({"kind":"stream","index":1});
    let matched =
        FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
    ChildJobSpec::from_child_input(&matched)
        .unwrap()
        .require_input_statement(&matched)
        .unwrap();
}

#[test]
fn constructor_preserves_absolute_selected_audio_index_and_frozen_identity() {
    let input = child();
    let original = ChildJobSpec::from_child_input(&input).unwrap();
    for stream_index in [0, u32::MAX] {
        let mut value: Value = serde_json::from_slice(input.private_storage_plaintext()).unwrap();
        value["audio_intent"] = json!({"kind":"stream","index":stream_index});
        value["root"]["selected_audio"] = json!({"kind":"single","stream_index":stream_index});
        value["root"]["root_digest"] = json!("a".repeat(64));
        value["operation_id"] = json!(OTHER);
        value["worker_instance"] = json!(OTHER);
        value["position_ms"] = json!(1234.126);
        let changed =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        let spec = ChildJobSpec::from_child_input(&changed).unwrap();
        assert_eq!(spec.0.capture_id, OTHER);
        assert_eq!(spec.0.worker_instance, OTHER);
        assert_eq!(spec.0.input_sha256, changed.input_sha256());
        assert_eq!(spec.0.root_digest, "a".repeat(64));
        assert_eq!(spec.0.position_ms, 1234.126);
        assert_eq!(
            spec.0.selected_audio,
            SelectedAudioStatement::Single { stream_index }
        );
        spec.require_input_statement(&changed).unwrap();
        assert!(spec.require_input_statement(&input).is_err());
        assert_eq!(
            original.require_same_spec_statement(&spec),
            Err(ContractError::Immutable)
        );
    }
}

#[test]
fn reader_recipe_input_and_graph_versions_are_exact_on_both_boundaries() {
    let input = child();
    for (key, supported) in [
        ("reader_version", 2),
        ("recipe_version", 1),
        ("input_version", 1),
        ("graph_version", 1),
    ] {
        for unsupported in [0, supported - 1, supported + 1, 255] {
            let mut capability = worker_value(&input);
            let mut spec = job_value(&input);
            capability[key] = json!(unsupported);
            spec[key] = json!(unsupported);
            assert!(
                matches!(worker(&capability), Err(ContractError::Version)),
                "{key}"
            );
            assert!(matches!(job(&spec), Err(ContractError::Version)), "{key}");
        }
        for invalid in [
            json!(null),
            json!("1"),
            json!(true),
            json!(1.0),
            json!(-1),
            json!(256),
        ] {
            let mut capability = worker_value(&input);
            let mut spec = job_value(&input);
            capability[key] = invalid.clone();
            spec[key] = invalid;
            assert!(worker(&capability).is_err());
            assert!(job(&spec).is_err());
        }
    }
}

#[test]
fn capabilities_are_explicit_and_never_inferred_from_versions() {
    let input = child();
    let mut value = worker_value(&input);
    value["tasks"] = json!(["parent_capture", "parent_read", "parent_publication"]);
    let observed = worker(&value).unwrap();
    assert_eq!(
        require_task_statement(None, Task::ChildEncode, &input),
        Err(TaskRefusal::WorkerUnknown)
    );
    assert_eq!(
        require_task_statement(Some(&observed), Task::ChildEncode, &input),
        Err(TaskRefusal::TaskUnsupported)
    );
    for tasks in [
        json!([]),
        json!(["child_encode", "child_encode"]),
        json!(["generic_encode"]),
        json!([{"child_encode":null}]),
        json!(null),
        json!("child_encode"),
    ] {
        value["tasks"] = tasks;
        assert!(worker(&value).is_err());
    }
}

#[test]
fn tasks_require_the_correct_input_kind_and_actual_startup_and_database() {
    let parent = parent();
    let child = child();
    let observed = worker(&worker_value(&parent)).unwrap();
    for task in [
        Task::ParentCapture,
        Task::ParentRead,
        Task::ParentPublication,
    ] {
        require_task_statement(Some(&observed), task, &parent).unwrap();
        assert_eq!(
            require_task_statement(Some(&observed), task, &child),
            Err(TaskRefusal::InputMismatch)
        );
    }
    require_task_statement(Some(&observed), Task::ChildEncode, &child).unwrap();
    assert_eq!(
        require_task_statement(Some(&observed), Task::ChildEncode, &parent),
        Err(TaskRefusal::InputMismatch)
    );
    for key in ["worker_instance", "database"] {
        let mut value = worker_value(&child);
        value[key] = json!(OTHER);
        let foreign = worker(&value).unwrap();
        assert_eq!(
            require_task_statement(Some(&foreign), Task::ChildEncode, &child),
            Err(TaskRefusal::WorkerMismatch)
        );
    }
}

#[test]
fn worker_and_job_are_closed_objects_with_all_fields_required() {
    let input = child();
    let capability = worker_value(&input);
    let spec = job_value(&input);
    for key in capability.as_object().unwrap().keys() {
        let mut value = capability.clone();
        value.as_object_mut().unwrap().remove(key);
        assert!(worker(&value).is_err(), "{key}");
    }
    for key in spec.as_object().unwrap().keys() {
        let mut value = spec.clone();
        value.as_object_mut().unwrap().remove(key);
        assert!(job(&value).is_err(), "{key}");
    }
    let mut value = capability.clone();
    value["unknown"] = json!(true);
    assert!(matches!(worker(&value), Err(ContractError::Shape)));
    let positional = Value::Array(capability.as_object().unwrap().values().cloned().collect());
    assert!(worker(&positional).is_err());
    let positional = Value::Array(spec.as_object().unwrap().values().cloned().collect());
    assert!(job(&positional).is_err());
    let duplicate = serde_json::to_string(&capability).unwrap().replace(
        "\"recipe_version\":1",
        "\"recipe_version\":1,\"recipe_version\":1",
    );
    assert!(WorkerStatement::parse_private_plaintext(duplicate.as_bytes()).is_err());
    let duplicate = serde_json::to_string(&spec).unwrap().replace(
        "\"capture_id\":",
        "\"capture_id\":\"00000000-0000-0000-0000-000000000020\",\"capture_id\":",
    );
    assert!(ChildJobSpec::parse_private_plaintext(duplicate.as_bytes()).is_err());
    let duplicate = serde_json::to_string(&spec).unwrap().replace(
        "\"stream_index\":1",
        "\"stream_index\":1,\"stream_index\":1",
    );
    assert!(ChildJobSpec::parse_private_plaintext(duplicate.as_bytes()).is_err());
}

#[test]
fn stage_a_binary_generic_and_indexed_recipe_shapes_cannot_be_aliases() {
    let input = child();
    let original = job_value(&input);
    for kind in ["hls", "parent", "static_hls_v1", "http_file", "indexed_hls"] {
        let mut value = original.clone();
        value["kind"] = json!(kind);
        assert!(job(&value).is_err());
    }
    for key in [
        "root",
        "resource",
        "path",
        "input_ticket",
        "argv",
        "browser_options",
        "transcode",
        "negotiated_mode",
        "start_seconds",
        "audio_index",
        "video_index",
        "http_file_fallback_version",
        "static_hls_fallback_version",
    ] {
        let mut value = original.clone();
        value[key] = json!("https://source.invalid/?token=secret");
        let Err(error) = job(&value) else {
            panic!("generic alias accepted: {key}")
        };
        assert_eq!(error.to_string(), "static_hls_contract_shape");
    }
    let probe = json!({"version":1,"instance":OTHER,"database":OTHER,"cache_identity":"cache","challenge":OTHER});
    assert!(worker(&probe).is_err());
}

#[test]
fn identities_hashes_audio_budget_and_scalar_bounds_are_checked() {
    let input = child();
    for (key, invalid) in [
        ("capture_id", json!("00000000-0000-0000-0000-000000000000")),
        (
            "worker_instance",
            json!("00000000-0000-0000-0000-00000000000A"),
        ),
        ("input_sha256", json!("B".repeat(64))),
        ("root_digest", json!("a".repeat(63))),
        ("position_ms", json!(-1.0)),
        ("position_ms", json!(9_007_199_254_740_992u64)),
        ("estimated_output_bytes", json!(33554431)),
        ("estimated_output_bytes", json!(33554433)),
        ("selected_audio", json!({"kind":"none"})),
        ("selected_audio", json!({"kind":"single","stream_index":-1})),
        (
            "selected_audio",
            json!({"kind":"single","stream_index":4294967296u64}),
        ),
        (
            "selected_audio",
            json!({"kind":"single","stream_index":1,"index":1}),
        ),
        ("selected_audio", json!(["single", 1])),
    ] {
        let mut value = job_value(&input);
        value[key] = invalid;
        assert!(job(&value).is_err(), "{key}");
    }
    for key in ["worker_instance", "database"] {
        let mut value = worker_value(&input);
        value[key] = json!("00000000-0000-0000-0000-000000000000");
        assert!(matches!(worker(&value), Err(ContractError::Identity)));
    }
    // Index zero is a real absolute stream, not an omitted/default audio map.
    let mut value = job_value(&input);
    value["selected_audio"]["stream_index"] = json!(0);
    assert!(job(&value).is_ok());
    assert_eq!(
        job(&value).unwrap().require_input_statement(&input),
        Err(ContractError::Audio)
    );
}

#[test]
fn frozen_input_binds_every_child_job_field_and_rejects_parent_input() {
    let input = child();
    let original = job_value(&input);
    let spec = job(&original).unwrap();
    spec.require_input_statement(&input).unwrap();
    assert_eq!(
        spec.require_input_statement(&parent()),
        Err(ContractError::Identity)
    );
    for (key, changed) in [
        ("capture_id", json!(OTHER)),
        ("worker_instance", json!(OTHER)),
        ("input_sha256", json!("a".repeat(64))),
        ("root_digest", json!("a".repeat(64))),
        ("position_ms", json!(1234.126)),
        ("selected_audio", json!({"kind":"single","stream_index":0})),
    ] {
        let mut value = original.clone();
        value[key] = changed;
        let changed = job(&value).unwrap();
        assert!(changed.require_input_statement(&input).is_err(), "{key}");
        assert_eq!(
            spec.require_same_spec_statement(&changed),
            Err(ContractError::Immutable)
        );
    }
    assert!(spec.require_input_statement(&child_at(1234.126)).is_err());
}

#[test]
fn child_execution_requires_explicit_capability_and_matching_live_local_owner() {
    let input = child();
    let spec = job(&job_value(&input)).unwrap();
    let observed = worker(&worker_value(&input)).unwrap();
    spec.require_execution_statement(Some(&observed), &input, Some(&owner(&spec)))
        .unwrap();
    assert_eq!(
        spec.require_execution_statement(None, &input, Some(&owner(&spec))),
        Err(TaskRefusal::WorkerUnknown)
    );
    assert_eq!(
        spec.require_execution_statement(Some(&observed), &input, None),
        Err(TaskRefusal::LocalOwnerMissing)
    );
    for field in 0..5 {
        let mut local = owner(&spec);
        match field {
            0 => local.snapshot_and_permit_live = false,
            1 => local.worker_instance = OTHER,
            2 => local.capture_id = OTHER,
            3 => local.input_sha256 = "a",
            _ => local.root_digest = "a",
        }
        assert_eq!(
            spec.require_execution_statement(Some(&observed), &input, Some(&local)),
            Err(TaskRefusal::LocalOwnerMissing)
        );
    }
    let mut declaration = worker_value(&input);
    declaration["tasks"] = json!(["parent_read"]);
    let read_only = worker(&declaration).unwrap();
    assert_eq!(
        spec.require_execution_statement(Some(&read_only), &input, Some(&owner(&spec))),
        Err(TaskRefusal::TaskUnsupported)
    );
    declaration["tasks"] = json!(["child_encode"]);
    declaration["worker_instance"] = json!(OTHER);
    let foreign = worker(&declaration).unwrap();
    assert_eq!(
        spec.require_execution_statement(Some(&foreign), &input, Some(&owner(&spec))),
        Err(TaskRefusal::WorkerMismatch)
    );
    assert_eq!(
        spec.require_execution_statement(Some(&observed), &child_at(1234.126), Some(&owner(&spec))),
        Err(TaskRefusal::JobMismatch)
    );
}

#[test]
fn limits_apply_before_parsing_and_errors_do_not_echo_private_payloads() {
    for bytes in [Vec::new(), vec![b' '; MAX_WORKER_STATEMENT_BYTES + 1]] {
        assert!(matches!(
            WorkerStatement::parse_private_plaintext(&bytes),
            Err(ContractError::Bounds)
        ));
        assert!(matches!(
            ChildJobSpec::parse_private_plaintext(&bytes),
            Err(ContractError::Bounds)
        ));
    }
    for bytes in [
        b"{\"kind\":\"secret-url\"}".as_slice(),
        b"[]",
        b"null",
        &[0xff],
    ] {
        let Err(error) = ChildJobSpec::parse_private_plaintext(bytes) else {
            panic!("malformed spec accepted")
        };
        assert_eq!(error.to_string(), "static_hls_contract_shape");
    }
}

#[test]
fn job_storage_roundtrip_keeps_the_frozen_spec_and_normalizes_zero() {
    for position in [0.0, 1234.125] {
        let input = child_at(position);
        let mut value = job_value(&input);
        if position == 0.0 {
            value["position_ms"] = json!(-0.0);
        }
        let spec = job(&value).unwrap();
        spec.require_input_statement(&input).unwrap();
        let stored = spec.private_storage_plaintext().unwrap();
        let reloaded = ChildJobSpec::parse_private_plaintext(&stored).unwrap();
        spec.require_same_spec_statement(&reloaded).unwrap();
        assert_eq!(reloaded.private_storage_plaintext().unwrap(), stored);
        if position == 0.0 {
            assert!(spec.0.position_ms.is_sign_positive());
        }
    }
}
