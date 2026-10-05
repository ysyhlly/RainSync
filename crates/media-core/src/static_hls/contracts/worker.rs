//! Inactive Stage B Worker/task compatibility statements. These pure checks
//! neither advertise production capabilities nor authorize or dispatch work.
//! The existing startup/DB/cache probe alone cannot establish task support,
//! publication, a live local permit, drain or production activation. Consumers
//! must obtain fresh authenticated statements and apply the durable SQL fences
//! before changing attempts, fairness turns, ownership or making file/process
//! side effects. A refusal has no legacy/generic recipe continuation.
use super::input::{FrozenInput, OperationKind, SelectedAudioStatement};
use super::*;
use serde::{Deserialize, Serialize};

pub const MAX_WORKER_STATEMENT_BYTES: usize = 4_096;
pub const MAX_CHILD_JOB_SPEC_BYTES: usize = 4_096;
pub const CHILD_ESTIMATED_OUTPUT_BYTES: u64 = 33_554_432;

/// Separate capabilities: understanding reader2 does not prove an encoder ran.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum Task {
    #[serde(rename = "parent_capture")]
    ParentCapture,
    #[serde(rename = "parent_read")]
    ParentRead,
    #[serde(rename = "parent_publication")]
    ParentPublication,
    #[serde(rename = "child_encode")]
    ChildEncode,
}
impl<'de> Deserialize<'de> for Task {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "parent_capture" => Ok(Self::ParentCapture),
            "parent_read" => Ok(Self::ParentRead),
            "parent_publication" => Ok(Self::ParentPublication),
            "child_encode" => Ok(Self::ChildEncode),
            _ => Err(serde::de::Error::custom("unsupported worker task")),
        }
    }
}
impl Task {
    fn input_kind(self) -> OperationKind {
        match self {
            Self::ParentCapture | Self::ParentRead | Self::ParentPublication => {
                OperationKind::Parent
            }
            Self::ChildEncode => OperationKind::Child,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerWire {
    reader_version: u8,
    recipe_version: u8,
    input_version: u8,
    graph_version: u8,
    worker_instance: String,
    database: String,
    tasks: Vec<Task>,
}

/// Validated declaration only; no default or automatic child capability.
/// The caller supplies actual runtime capabilities through an authenticated
/// envelope. This type is not an extension of Stage A's WorkerContract probe.
pub struct WorkerStatement(WorkerWire);
impl WorkerStatement {
    pub fn parse_private_plaintext(bytes: &[u8]) -> Result<Self> {
        bounded(bytes, MAX_WORKER_STATEMENT_BYTES)?;
        let Object(wire): Object<WorkerWire> =
            serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
        exact_versions(
            wire.reader_version,
            wire.recipe_version,
            wire.input_version,
            wire.graph_version,
        )?;
        require(
            uuid(&wire.worker_instance) && uuid(&wire.database),
            ContractError::Identity,
        )?;
        require(
            !wire.tasks.is_empty()
                && wire.tasks.len() <= 4
                && wire
                    .tasks
                    .iter()
                    .enumerate()
                    .all(|(index, task)| !wire.tasks[..index].contains(task)),
            ContractError::Bounds,
        )?;
        Ok(Self(wire))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskRefusal {
    WorkerUnknown,
    WorkerMismatch,
    TaskUnsupported,
    InputMismatch,
    JobMismatch,
    LocalOwnerMissing,
}
impl std::fmt::Display for TaskRefusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::WorkerUnknown => "static_hls_worker_unknown",
            Self::WorkerMismatch => "static_hls_worker_mismatch",
            Self::TaskUnsupported => "static_hls_worker_task_unsupported",
            Self::InputMismatch => "static_hls_worker_input_mismatch",
            Self::JobMismatch => "static_hls_worker_job_mismatch",
            Self::LocalOwnerMissing => "static_hls_local_owner_missing",
        })
    }
}
impl std::error::Error for TaskRefusal {}

/// Compatibility only. Success is not a live grant, scheduling claim or permit.
pub fn require_task_statement(
    observed: Option<&WorkerStatement>,
    task: Task,
    input: &FrozenInput,
) -> std::result::Result<(), TaskRefusal> {
    let observed = observed.ok_or(TaskRefusal::WorkerUnknown)?;
    if !observed.0.tasks.contains(&task) {
        return Err(TaskRefusal::TaskUnsupported);
    }
    if task.input_kind() != input.kind() {
        return Err(TaskRefusal::InputMismatch);
    }
    let identity = input.identity_statement();
    if observed.0.worker_instance != identity.worker_instance
        || observed.0.database != identity.database
    {
        return Err(TaskRefusal::WorkerMismatch);
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ChildJobWire {
    kind: String,
    reader_version: u8,
    recipe_version: u8,
    input_version: u8,
    graph_version: u8,
    capture_id: String,
    input_sha256: String,
    root_digest: String,
    worker_instance: String,
    position_ms: f64,
    selected_audio: SelectedAudioStatement,
    estimated_output_bytes: u64,
}

/// Closed Stage B spec from the design's existing static_hls_v1 queue. Generic
/// root/path/input_ticket/argv/browser/indexed recipe fields are never accepted.
/// Retain the validated spec immutably for the attempt; parsing does not claim it.
pub struct ChildJobSpec(ChildJobWire);
impl ChildJobSpec {
    /// Build the closed queue statement from an already validated child input.
    /// This only binds frozen fields; it does not prove verified custody, live
    /// ownership, worker capability or permission to enqueue/execute the job.
    pub fn from_child_input(child: &FrozenInput) -> Result<Self> {
        let root = child.child_root().ok_or(ContractError::Identity)?;
        let identity = child.identity_statement();
        let spec = Self::from_wire(ChildJobWire {
            kind: "static_hls_child".to_owned(),
            reader_version: READER_VERSION,
            recipe_version: RECIPE_VERSION,
            input_version: INPUT_VERSION,
            graph_version: GRAPH_VERSION,
            capture_id: identity.operation_id,
            input_sha256: child.input_sha256().to_owned(),
            root_digest: root.root_digest.clone(),
            worker_instance: identity.worker_instance,
            position_ms: child.position_ms(),
            selected_audio: root.selected_audio,
            estimated_output_bytes: CHILD_ESTIMATED_OUTPUT_BYTES,
        })?;
        spec.require_input_statement(child)?;
        Ok(spec)
    }

    pub fn parse_private_plaintext(bytes: &[u8]) -> Result<Self> {
        bounded(bytes, MAX_CHILD_JOB_SPEC_BYTES)?;
        let Object(wire): Object<ChildJobWire> =
            serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
        Self::from_wire(wire)
    }

    fn from_wire(mut wire: ChildJobWire) -> Result<Self> {
        require(wire.kind == "static_hls_child", ContractError::Shape)?;
        exact_versions(
            wire.reader_version,
            wire.recipe_version,
            wire.input_version,
            wire.graph_version,
        )?;
        require(
            uuid(&wire.capture_id)
                && uuid(&wire.worker_instance)
                && hash(&wire.input_sha256)
                && hash(&wire.root_digest),
            ContractError::Identity,
        )?;
        require(
            finite_nonnegative(wire.position_ms)
                && wire.estimated_output_bytes == CHILD_ESTIMATED_OUTPUT_BYTES,
            ContractError::Bounds,
        )?;
        require(
            matches!(wire.selected_audio, SelectedAudioStatement::Single { .. }),
            ContractError::Audio,
        )?;
        normalized_zero(&mut wire.position_ms);
        Ok(Self(wire))
    }
    /// Closed bytes for immutable private storage, not a public playback DTO.
    pub fn private_storage_plaintext(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(&self.0).map_err(|_| ContractError::Shape)
    }
    pub fn require_same_spec_statement(&self, next: &Self) -> Result<()> {
        require(self.0 == next.0, ContractError::Immutable)
    }
    pub fn require_input_statement(&self, child: &FrozenInput) -> Result<()> {
        let root = child.child_root().ok_or(ContractError::Identity)?;
        let identity = child.identity_statement();
        require(
            self.0.capture_id == identity.operation_id
                && self.0.worker_instance == identity.worker_instance
                && self.0.input_sha256 == child.input_sha256()
                && self.0.root_digest == root.root_digest
                && self.0.position_ms == child.position_ms(),
            ContractError::Identity,
        )?;
        require(
            self.0.selected_audio == root.selected_audio,
            ContractError::Audio,
        )?;
        child.require_audio_statement(self.0.selected_audio)
    }
    /// Before claim/encode side effects, compare the actual live local owner in
    /// addition to the authenticated capability statement and frozen input. A
    /// different startup cannot adopt the job, even with the same reader number.
    /// The caller still needs live authority, SQL fences and the actual permit.
    pub fn require_execution_statement(
        &self,
        observed: Option<&WorkerStatement>,
        child: &FrozenInput,
        local: Option<&LocalChildOwnerStatement<'_>>,
    ) -> std::result::Result<(), TaskRefusal> {
        require_task_statement(observed, Task::ChildEncode, child)?;
        self.require_input_statement(child)
            .map_err(|_| TaskRefusal::JobMismatch)?;
        let local = local.ok_or(TaskRefusal::LocalOwnerMissing)?;
        if !local.snapshot_and_permit_live
            || local.worker_instance != self.0.worker_instance
            || local.capture_id != self.0.capture_id
            || local.input_sha256 != self.0.input_sha256
            || local.root_digest != self.0.root_digest
        {
            return Err(TaskRefusal::LocalOwnerMissing);
        }
        Ok(())
    }
}

/// Caller-observed ownership facts only; never reconstructed from a UUID file,
/// lease expiry, readiness, an empty database query or a remote declaration.
pub struct LocalChildOwnerStatement<'a> {
    pub worker_instance: &'a str,
    pub capture_id: &'a str,
    pub input_sha256: &'a str,
    pub root_digest: &'a str,
    pub snapshot_and_permit_live: bool,
}

fn bounded(bytes: &[u8], max: usize) -> Result<()> {
    require(
        !bytes.is_empty() && bytes.len() <= max,
        ContractError::Bounds,
    )
}
fn exact_versions(reader: u8, recipe: u8, input: u8, graph: u8) -> Result<()> {
    require(
        (reader, recipe, input, graph)
            == (READER_VERSION, RECIPE_VERSION, INPUT_VERSION, GRAPH_VERSION),
        ContractError::Version,
    )
}

#[cfg(test)]
mod tests;
