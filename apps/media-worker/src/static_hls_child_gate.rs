//! Pre-side-effect refusal for the Worker's existing generic encoder path.
//!
//! Call `reject_unsupported_claim` immediately after obtaining a Claim, before
//! cache reservation, input-ticket/path handling, output directory creation or
//! recipe construction. This does not replace the queued-candidate/final-UPDATE
//! fences required before advancing attempts, fairness turns and ownership.
//!
//! A WorkerStatement is compatibility data. The current Claim has no opaque
//! child-attempt proof, and PersistedPendingCapturePermit is minted only for a
//! parent. Neither can authorize child encoding. Until the actual child owner,
//! permit and durable attempt binding exist, all marked claims are refused here.
use media_core::static_hls::contracts::{
    input::FrozenInput,
    worker::{
        ChildJobSpec, MAX_CHILD_JOB_SPEC_BYTES, Task, TaskRefusal, WorkerStatement,
        require_task_statement,
    },
};
use persistence::media_jobs::Claim;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Refusal {
    InvalidJobSpec,
    ChildExecutionUnavailable,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::InvalidJobSpec => "static_hls_child_job_invalid",
            Self::ChildExecutionUnavailable => "static_hls_child_execution_unavailable",
        })
    }
}
impl std::error::Error for Refusal {}

/// Legacy generic specs remain unchanged. A partial, malformed or future
/// static-HLS spec must not fall through to the generic root/input-ticket recipe.
/// Even a valid closed child spec cannot run without an original child permit
/// and a freshly fenced SQL child-attempt proof; no such proof exists yet.
pub(super) fn reject_unsupported_claim(claim: &Claim) -> Result<(), Refusal> {
    let marked = claim
        .spec
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| kind.starts_with("static_hls"))
        || [
            "capture_id",
            "input_sha256",
            "root_digest",
            "worker_instance",
            "reader_version",
            "recipe_version",
            "input_version",
            "graph_version",
        ]
        .iter()
        .any(|key| claim.spec.get(*key).is_some());
    if !marked {
        return Ok(());
    }

    // Serialize into a fixed buffer: oversized stored JSON cannot allocate
    // another unbounded copy, and parser/serializer details never enter errors.
    let mut bytes = [0; MAX_CHILD_JOB_SPEC_BYTES];
    let len = {
        let mut writer = std::io::Cursor::new(bytes.as_mut_slice());
        serde_json::to_writer(&mut writer, &claim.spec).map_err(|_| Refusal::InvalidJobSpec)?;
        writer.position() as usize
    };
    ChildJobSpec::parse_private_plaintext(&bytes[..len]).map_err(|_| Refusal::InvalidJobSpec)?;
    Err(Refusal::ChildExecutionUnavailable)
}

/// Declaration/spec/input compatibility only, including this actual startup.
/// The declared database identity is compared by the core contract; success
/// does not prove the current database/cache context, source authority, a live
/// local snapshot/permit or `(job_id, attempt, owner_id)` ownership. In particular
/// this function accepts no caller-supplied LocalChildOwnerStatement or live bool.
/// Keep `reject_unsupported_claim` in the execution path even after this passes.
#[allow(dead_code)]
pub(super) fn require_child_compatibility(
    observed: Option<&WorkerStatement>,
    spec: &ChildJobSpec,
    input: &FrozenInput,
) -> Result<(), TaskRefusal> {
    require_task_statement(observed, Task::ChildEncode, input)?;
    spec.require_input_statement(input)
        .map_err(|_| TaskRefusal::JobMismatch)?;
    if input.identity_statement().worker_instance
        != super::static_hls_contract::INSTANCE.to_string()
    {
        return Err(TaskRefusal::WorkerMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_core::static_hls::contracts::graph::RootGraphStatement;
    use serde_json::{Value, json};
    use uuid::Uuid;

    const PARENT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json");
    const ROOT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_root_v1.json");
    const OTHER: &str = "00000000-0000-0000-0000-000000000020";

    fn child(worker: &str) -> FrozenInput {
        let parent = FrozenInput::parse_private_plaintext(PARENT).unwrap();
        let root = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
        let mut value: Value = serde_json::from_slice(PARENT).unwrap();
        value["kind"] = json!("child");
        value["operation_id"] = json!("00000000-0000-0000-0000-00000000000d");
        value["session_id"] = json!("00000000-0000-0000-0000-00000000000e");
        value["request_owner_epoch"] = json!("00000000-0000-0000-0000-00000000000f");
        value["request_sha256"] = json!("2".repeat(64));
        value["plan_generation"] = json!(2);
        value["worker_instance"] = json!(worker);
        value["prepare_started_at_ms"] = json!(2000);
        value["prepare_expires_at_ms"] = json!(47000);
        value["root"] = json!({
            "parent_session_id":parent.identity_statement().session_id,
            "parent_capture_id":parent.identity_statement().operation_id,
            "parent_input_sha256":parent.input_sha256(), "root_digest":root.root_digest(),
            "root_admitted_at_ms":1000, "root_hard_expires_at_ms":1801000,
            "selected_audio":{"kind":"single","stream_index":1}
        });
        FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap()
    }
    fn declaration(input: &FrozenInput, tasks: Value) -> WorkerStatement {
        let identity = input.identity_statement();
        WorkerStatement::parse_private_plaintext(&serde_json::to_vec(&json!({
            "reader_version":2, "recipe_version":1, "input_version":1, "graph_version":1,
            "worker_instance":identity.worker_instance, "database":identity.database, "tasks":tasks
        })).unwrap()).unwrap()
    }
    fn claim(spec: Value) -> Claim {
        Claim {
            id: Uuid::new_v4(),
            owner: Uuid::new_v4(),
            attempt: 1,
            spec,
        }
    }
    fn stored(spec: &ChildJobSpec) -> Value {
        serde_json::from_slice(&spec.private_storage_plaintext().unwrap()).unwrap()
    }

    #[test]
    fn legacy_specs_pass_without_changing_claim_or_input() {
        for spec in [
            json!({"root":"legacy-root","resource":"input.mp4","source_kind":"local","transcode":true}),
            json!({"input_ticket":"legacy-ticket","source_kind":"http","audio_index":null,"estimated_output_bytes":33554432}),
        ] {
            let claim = claim(spec);
            let before = (claim.id, claim.owner, claim.attempt, claim.spec.clone());
            assert_eq!(reject_unsupported_claim(&claim), Ok(()));
            assert_eq!((claim.id, claim.owner, claim.attempt, claim.spec), before);
        }
    }

    #[test]
    fn valid_same_startup_declaration_and_spec_never_authorize_execution() {
        let input = child(&super::super::static_hls_contract::INSTANCE.to_string());
        let spec = ChildJobSpec::from_child_input(&input).unwrap();
        let observed = declaration(&input, json!(["child_encode"]));
        assert_eq!(
            require_child_compatibility(Some(&observed), &spec, &input),
            Ok(())
        );
        let claim = claim(stored(&spec));
        assert_eq!(
            reject_unsupported_claim(&claim),
            Err(Refusal::ChildExecutionUnavailable)
        );
        // A stored owner UUID and syntactically plausible attempt cannot mint
        // the missing original capture permit or child SQL execution proof.
        assert_eq!(claim.attempt, 1);
    }

    #[test]
    fn malformed_partial_future_and_oversized_specs_refuse_generic_fallback() {
        let input = child(&super::super::static_hls_contract::INSTANCE.to_string());
        let spec = ChildJobSpec::from_child_input(&input).unwrap();
        for candidate in [
            json!({"kind":"static_hls_child","root":"must-not-open","resource":"x"}),
            json!({"kind":"static_hls_child_v2"}),
            json!({"reader_version":null,"root":"must-not-open"}),
            json!({"capture_id":true,"input_ticket":"must-not-decrypt"}),
        ] {
            assert_eq!(
                reject_unsupported_claim(&claim(candidate)),
                Err(Refusal::InvalidJobSpec)
            );
        }
        for field in ["root", "input_ticket", "argv", "browser_options"] {
            let mut candidate = stored(&spec);
            candidate[field] = json!("must-not-use");
            assert_eq!(
                reject_unsupported_claim(&claim(candidate)),
                Err(Refusal::InvalidJobSpec)
            );
        }
        let mut candidate = stored(&spec);
        candidate["capture_id"] = json!("x".repeat(MAX_CHILD_JOB_SPEC_BYTES + 1));
        assert_eq!(
            reject_unsupported_claim(&claim(candidate)),
            Err(Refusal::InvalidJobSpec)
        );
    }

    #[test]
    fn missing_capability_foreign_startup_and_changed_input_refuse() {
        let input = child(&super::super::static_hls_contract::INSTANCE.to_string());
        let spec = ChildJobSpec::from_child_input(&input).unwrap();
        assert_eq!(
            require_child_compatibility(None, &spec, &input),
            Err(TaskRefusal::WorkerUnknown)
        );
        let parent_only = declaration(&input, json!(["parent_capture"]));
        assert_eq!(
            require_child_compatibility(Some(&parent_only), &spec, &input),
            Err(TaskRefusal::TaskUnsupported)
        );
        let foreign = child(OTHER);
        let foreign_spec = ChildJobSpec::from_child_input(&foreign).unwrap();
        let foreign_worker = declaration(&foreign, json!(["child_encode"]));
        assert_eq!(
            require_child_compatibility(Some(&foreign_worker), &foreign_spec, &foreign),
            Err(TaskRefusal::WorkerMismatch)
        );
        let observed = declaration(&input, json!(["child_encode"]));
        let mut changed: Value = serde_json::from_slice(input.private_storage_plaintext()).unwrap();
        changed["position_ms"] = json!(1234.125);
        let changed =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&changed).unwrap()).unwrap();
        assert_eq!(
            require_child_compatibility(Some(&observed), &spec, &changed),
            Err(TaskRefusal::JobMismatch)
        );
    }
}
