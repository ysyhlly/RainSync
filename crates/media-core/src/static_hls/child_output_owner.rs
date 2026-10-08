//! Actual, original-attempt ownership of candidate child output.
//!
//! This owns filesystem and drain evidence, not a playback/publication grant or
//! a database release. Equal IDs, an expired lease, Drop, and an input execution
//! receipt cannot reconstruct it. Install `prepare`'s value before awaiting
//! `create_in`; its independent owner retains partially created resources too.
use super::{CaptureFuture, EncoderInputLease, ProcessDisposition, VerifiedCapture};
use anyhow::{Result, ensure};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::watch, time::Instant};

#[cfg(target_os = "linux")]
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::fs::MetadataExt,
};

const FILE_BYTES: u64 = super::child_recipe::MAX_OUTPUT_RESOURCE_BYTES;
const TOTAL_BYTES: u64 = super::child_recipe::MAX_OUTPUT_BYTES;
const FILES: usize = super::child_recipe::MAX_OUTPUT_FILES;
const OWNER: &str = "owner";

/// Read-only identity observation. Constructing this metadata gives no permit,
/// filesystem capability, execution ownership, or disposal proof.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutputIdentity {
    job_id: String,
    attempt: i64,
    owner_id: String,
}
impl OutputIdentity {
    pub fn new(job_id: String, attempt: i64, owner_id: String) -> Result<Self> {
        let identity = Self {
            job_id,
            attempt,
            owner_id,
        };
        identity.validate()?;
        Ok(identity)
    }
    pub fn job_id(&self) -> &str {
        &self.job_id
    }
    pub fn attempt(&self) -> i64 {
        self.attempt
    }
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
    pub fn relative_key(&self) -> String {
        format!("{}/{}", self.job_id, self.attempt)
    }
    fn validate(&self) -> Result<()> {
        fn uuid(value: &str) -> bool {
            value.len() == 36
                && value.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                    }
                })
        }
        ensure!(
            uuid(&self.job_id) && uuid(&self.owner_id) && self.attempt == 1,
            "static_hls_child_output_identity"
        );
        Ok(())
    }
    fn marker(&self) -> Vec<u8> {
        format!(
            "rainsync-static-hls-child-output-v1\n{}\n{}\n{}\n",
            self.job_id, self.attempt, self.owner_id
        )
        .into_bytes()
    }
}

/// Implemented by the genuinely opaque, successfully admitted persistence
/// reservation. `check` must repeat its original claim/input/local and current
/// ordered database authority fence. There is no bool/proof constructor here.
pub trait OutputPermit: Send + Sync {
    fn identity(&self) -> OutputIdentity;
    fn check(&self) -> CaptureFuture<'_, ()>;
    fn check_write(&self) -> CaptureFuture<'_, ()>;
    /// Verify the actual original execution's encoder input owner. A second
    /// lease of the same capture, equal IDs or matching JSON cannot substitute.
    fn require_original_input(&self, _: &Arc<EncoderInputLease>) -> Result<()> {
        anyhow::bail!("static_hls_child_output_original_input_owner_required")
    }

    /// Frozen original root deadline from actual durable admission. None cannot
    /// authorize publication retention; later observations may only shorten it.
    fn root_deadline(&self) -> Option<Instant> {
        None
    }
}

/// Implemented only by the persistence object's POSITIVELY acknowledged COMMIT
/// receipt, retaining its exact original write permit. Equal IDs/rows/JSON or
/// an uncertain COMMIT never make this authority. Retention and public reads
/// have separate predicates; read additionally requires positive input disposal.
pub trait PublishedOutputPermit: Send + Sync {
    fn identity(&self) -> OutputIdentity;
    fn original_write_permit(&self) -> &Arc<dyn OutputPermit>;
    fn root_deadline(&self) -> Instant;
    fn require_same_frozen_input(&self, input: &super::contracts::input::FrozenInput)
    -> Result<()>;
    fn check_retention(&self) -> CaptureFuture<'_, ()>;
    fn check_read(&self) -> CaptureFuture<'_, ()>;
}

struct Readers {
    closed: bool,
    count: usize,
}
pub(super) struct OutputReaderGuard {
    owner: Arc<Owner>,
}
impl Drop for OutputReaderGuard {
    fn drop(&mut self) {
        let mut readers = self.owner.readers.lock().expect("child output readers");
        readers.count -= 1;
        self.owner.reader_count.send_replace(readers.count);
    }
}

enum Retention {
    Encoding,
    Publishing,
    Published(Arc<dyn PublishedOutputPermit>),
}

/// Only the original independent owner mints this, after a real input encoder
/// drain, its own blocking scope drain, and exact owned-directory deletion.
/// Intentionally no public constructor, Clone, Deserialize, or Serialize.
pub struct ChildOutputDisposalProof {
    identity: OutputIdentity,
    original_permit: Arc<dyn OutputPermit>,
    process: ProcessDisposition,
    // Retained inode observations of the exact deleted owned directories.
    directory_device: u64,
    directory_inode: u64,
}
impl ChildOutputDisposalProof {
    /// Future consuming persistence must check its actual original permit, not
    /// merely IDs. A different permit with equal metadata cannot release it.
    pub fn require_original_permit(&self, permit: &Arc<dyn OutputPermit>) -> Result<()> {
        ensure!(
            Arc::ptr_eq(&self.original_permit, permit),
            "static_hls_child_output_original_disposal_permit_required"
        );
        Ok(())
    }
    pub fn identity(&self) -> &OutputIdentity {
        &self.identity
    }
    pub fn process_disposition(&self) -> ProcessDisposition {
        self.process
    }
    pub fn directory_device(&self) -> u64 {
        self.directory_device
    }
    pub fn directory_inode(&self) -> u64 {
        self.directory_inode
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputDisposalState {
    Pending,
    Unresolved,
    Removed,
}

/// Bounds observations only; no media validation or serving authority.
pub struct OutputFileObservation {
    pub name: String,
    pub bytes: u64,
}

enum InputOwner {
    Original(Arc<EncoderInputLease>),
    #[cfg(test)]
    NeverStarted,
}
impl InputOwner {
    fn cancel(&self) {
        match self {
            Self::Original(input) => input.cancel(),
            #[cfg(test)]
            Self::NeverStarted => {}
        }
    }
    async fn drain(&self) -> Result<()> {
        match self {
            Self::Original(input) => input.close_and_drain().await,
            #[cfg(test)]
            Self::NeverStarted => Ok(()),
        }
    }
    fn original(&self) -> Result<&Arc<EncoderInputLease>> {
        match self {
            Self::Original(input) => Ok(input),
            #[cfg(test)]
            Self::NeverStarted => anyhow::bail!("static_hls_child_output_input_required"),
        }
    }
}

#[derive(Default)]
struct Directory {
    root: Option<Arc<File>>,
    parent: Option<File>,
    directory: Option<File>,
    marker: Option<File>,
    names: BTreeSet<String>,
    // First private closed snapshot pins every actual output inode. Later
    // validation/publication snapshots can never adopt an equal-byte replacement.
    snapshot_files: Option<BTreeMap<String, File>>,
    complete: bool,
    // Only a successful actual managed spawn authorizes its closed name set.
    encoder_planned: bool,
    encoder_started: bool,
    removed: bool,
}

struct Owner {
    identity: OutputIdentity,
    permit: Arc<dyn OutputPermit>,
    input: InputOwner,
    scope: crate::child_process::Scope,
    directory: Arc<Mutex<Directory>>,
    stop: watch::Sender<bool>,
    state: watch::Sender<OutputDisposalState>,
    proof: OnceLock<Arc<ChildOutputDisposalProof>>,
    create_started: AtomicBool,
    writers_closed: AtomicBool,
    inspection_ready: AtomicBool,
    until: Instant,
    root_until: Option<Instant>,
    retention: Mutex<Retention>,
    recipe_binding: Mutex<Option<super::child_recipe::RecipeBinding>>,
    readers: Mutex<Readers>,
    reader_count: watch::Sender<usize>,
}

type Owners = HashMap<String, Arc<Owner>>;
fn owners() -> &'static Mutex<Owners> {
    static OWNERS: OnceLock<Mutex<Owners>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Owner {
    fn deadline(&self) -> Instant {
        match &*self.retention.lock().expect("child output retention") {
            Retention::Encoding => self.until.min(self.root_until.unwrap_or(self.until)),
            Retention::Publishing => self.root_until.unwrap_or(self.until),
            Retention::Published(receipt) => receipt
                .root_deadline()
                .min(self.root_until.unwrap_or(self.until)),
        }
    }
    fn detached_from_encoder(&self) -> bool {
        !matches!(
            *self.retention.lock().expect("child output retention"),
            Retention::Encoding
        )
    }
    fn live(&self) -> Result<()> {
        ensure!(
            !*self.stop.borrow() && Instant::now() < self.deadline(),
            "static_hls_child_output_revoked"
        );
        ensure!(
            self.permit.identity() == self.identity,
            "static_hls_child_output_original_permit_required"
        );
        Ok(())
    }
    fn writable(&self) -> Result<()> {
        self.live()?;
        ensure!(
            !self.writers_closed.load(Ordering::SeqCst),
            "static_hls_child_output_writer_closed"
        );
        Ok(())
    }
    async fn check(&self) -> Result<()> {
        self.writable()?;
        tokio::time::timeout_at(self.until, self.permit.check_write())
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_child_output_authority_timeout"))??;
        self.writable()
    }
    async fn check_current(&self) -> Result<()> {
        self.live()?;
        let published = match &*self.retention.lock().expect("child output retention") {
            Retention::Encoding => None,
            // In-flight/unknown commit retains private original custody only.
            // It cannot authorize writers or public reads. Ordered publication
            // SQL independently repeats the current authority fence.
            Retention::Publishing => return self.live(),
            Retention::Published(receipt) => Some(receipt.clone()),
        };
        let deadline = self.deadline();
        if let Some(receipt) = published {
            tokio::time::timeout_at(deadline, receipt.check_retention())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_child_output_authority_timeout"))??;
        } else {
            tokio::time::timeout_at(deadline, self.permit.check())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_child_output_authority_timeout"))??;
        }
        self.live()
    }
    fn readonly(&self) -> Result<()> {
        self.live()?;
        ensure!(
            self.writers_closed.load(Ordering::SeqCst)
                && self.inspection_ready.load(Ordering::SeqCst),
            "static_hls_child_output_readonly_phase_required"
        );
        Ok(())
    }
    fn cancel(&self) {
        // Admission and closure serialize; no body guard can register after a
        // supposedly empty reader drain has been observed.
        let mut readers = self.readers.lock().expect("child output readers");
        readers.closed = true;
        self.writers_closed.store(true, Ordering::SeqCst);
        self.stop.send_replace(true);
        // Request real encoder shutdown immediately, even while this owner's
        // current-authority database check is waiting. Its original independent
        // input supervisor owns reaping; this call is not a drain receipt.
        self.input.cancel();
    }
    async fn supervise(self: Arc<Self>, mut stopped: watch::Receiver<bool>) {
        let mut next_authority = Instant::now() + Duration::from_secs(1);
        loop {
            if *stopped.borrow_and_update() || Instant::now() >= self.deadline() {
                break;
            }
            tokio::select! {
                _ = stopped.changed() => {},
                _ = tokio::time::sleep_until(self.deadline()) => {},
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    // A normal owned writer is bounded before writing. Actual
                    // FFmpeg is also monitored and bounded by RLIMIT_FSIZE;
                    // final inventory is checked again only after actual reap.
                    let directory = self.directory.clone();
                    let identity = self.identity.clone();
                    let bounded = self.scope.run(crate::child_process::blocking(move || {
                        let directory = directory.lock().expect("child output directory");
                        if directory.complete && !directory.removed {
                            directory.inventory(&identity, false).map(|_| ())
                        } else { Ok(()) }
                    })).await;
                    if !bounded.is_ok_and(|result| result.is_ok()) { break; }
                    if Instant::now() >= next_authority {
                        if self.check_current().await.is_err() { break; }
                        next_authority = Instant::now() + Duration::from_secs(1);
                    }
                }
            }
        }
        self.cancel();
        loop {
            // The input is the ORIGINAL shared encoder scope. An empty output
            // scope alone is never evidence that the input-spawned FFmpeg ended.
            let drained = self.input.drain().await;
            let blocked = self.scope.shutdown().await;
            if drained.is_ok() && blocked.is_ok() {
                let mut readers = self.reader_count.subscribe();
                while *readers.borrow_and_update() != 0 {
                    if readers.changed().await.is_err() {
                        break;
                    }
                }
                if *readers.borrow() != 0 {
                    self.state.send_replace(OutputDisposalState::Unresolved);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                let directory = self.directory.clone();
                let identity = self.identity.clone();
                // The scope is closed; no new scoped writer can race deletion.
                // This independent owner retains the blocking deletion's state
                // and real handle until its result, regardless of public waiters.
                let removed = crate::child_process::blocking(move || {
                    directory
                        .lock()
                        .expect("child output directory")
                        .remove(&identity)
                })
                .await;
                if let Ok(Ok((device, inode, process))) = removed {
                    let proof = Arc::new(ChildOutputDisposalProof {
                        identity: self.identity.clone(),
                        original_permit: self.permit.clone(),
                        process,
                        directory_device: device,
                        directory_inode: inode,
                    });
                    // This original owner and the same proof remain retained for
                    // future consuming persistence acknowledgment. No DB release.
                    if self.proof.set(proof).is_ok() {
                        self.state.send_replace(OutputDisposalState::Removed);
                        return;
                    }
                }
            }
            self.state.send_replace(OutputDisposalState::Unresolved);
            // Retry only the same original scope/path/marker. Never adopt a
            // replacement, mint from timeout, or create a new namespace.
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

enum SnapshotAuthority {
    Original(Arc<dyn OutputPermit>),
    Published(Arc<dyn PublishedOutputPermit>),
}

/// Private, completed full-resource batch. Its constructor stays in the actual
/// original owner; bytes and matching IDs cannot reconstruct the authority fence.
/// It is consumed only after the validator has compared ALL resource hashes.
pub(super) struct ChildOutputSnapshot {
    owner: Arc<Owner>,
    authority: SnapshotAuthority,
    until: Instant,
    resources: Vec<(String, Vec<u8>)>,
}
impl ChildOutputSnapshot {
    pub(super) fn resources(&self) -> &[(String, Vec<u8>)] {
        &self.resources
    }
}

/// Original local owner. Dropping this is only a cleanup request; a separate
/// task and registry keep all real descriptors/scopes/permit and eventual proof.
pub struct ChildOutputOwner {
    owner: Arc<Owner>,
}
impl ChildOutputOwner {
    pub fn prepare(
        permit: Arc<dyn OutputPermit>,
        input: Arc<EncoderInputLease>,
        until: Instant,
    ) -> Result<Self> {
        Self::prepare_inner(permit, InputOwner::Original(input), until)
    }
    fn prepare_inner(
        permit: Arc<dyn OutputPermit>,
        input: InputOwner,
        until: Instant,
    ) -> Result<Self> {
        ensure!(cfg!(target_os = "linux"), "static_hls_linux_required");
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| anyhow::anyhow!("static_hls_child_output_owner_runtime_required"))?;
        match &input {
            InputOwner::Original(original) => permit.require_original_input(original)?,
            #[cfg(test)]
            InputOwner::NeverStarted => (),
        }
        let identity = permit.identity();
        identity.validate()?;
        ensure!(until > Instant::now(), "static_hls_child_output_deadline");
        let (stop, stopped) = watch::channel(false);
        let (state, _) = watch::channel(OutputDisposalState::Pending);
        let owner = Arc::new(Owner {
            identity,
            permit: permit.clone(),
            input,
            scope: crate::child_process::Scope::new(),
            directory: Arc::new(Mutex::new(Directory::default())),
            stop,
            state,
            proof: OnceLock::new(),
            create_started: AtomicBool::new(false),
            writers_closed: AtomicBool::new(false),
            inspection_ready: AtomicBool::new(false),
            until,
            root_until: permit.root_deadline(),
            retention: Mutex::new(Retention::Encoding),
            recipe_binding: Mutex::new(None),
            readers: Mutex::new(Readers {
                closed: false,
                count: 0,
            }),
            reader_count: watch::channel(0).0,
        });
        let mut held = owners().lock().expect("child output original owners");
        ensure!(
            !held.contains_key(&owner.identity.relative_key()),
            "static_hls_child_output_owner_already_exists"
        );
        held.insert(owner.identity.relative_key(), owner.clone());
        drop(held);
        runtime.spawn(owner.clone().supervise(stopped));
        Ok(Self { owner })
    }
    pub(super) fn retain_for_validation(&self) -> Self {
        Self {
            owner: self.owner.clone(),
        }
    }
    pub(super) fn encoder_argv_sha256(&self) -> Result<String> {
        self.owner
            .recipe_binding
            .lock()
            .expect("child output recipe binding")
            .as_ref()
            .map(|binding| binding.argv_sha256.clone())
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_closed_recipe_required"))
    }
    pub(super) fn acquire_read_guard(&self) -> Result<OutputReaderGuard> {
        let mut readers = self.owner.readers.lock().expect("child output readers");
        ensure!(!readers.closed, "static_hls_child_output_read_revoked");
        ensure!(readers.count < 2, "static_hls_child_output_read_busy");
        self.owner.readonly()?;
        ensure!(
            matches!(
                *self.owner.retention.lock().expect("child output retention"),
                Retention::Published(_)
            ),
            "static_hls_child_output_publication_commit_required"
        );
        readers.count += 1;
        self.owner.reader_count.send_replace(readers.count);
        Ok(OutputReaderGuard {
            owner: self.owner.clone(),
        })
    }

    pub(super) fn record_candidate_recipe(
        &self,
        recipe: &super::child_recipe::CandidateChildRecipe<'_>,
        argv_sha256: String,
    ) -> Result<()> {
        self.owner.writable()?;
        let binding = recipe.execution_binding(argv_sha256)?;
        let mut current = self
            .owner
            .recipe_binding
            .lock()
            .expect("child output recipe binding");
        ensure!(
            current.is_none(),
            "static_hls_child_output_recipe_already_bound"
        );
        *current = Some(binding);
        Ok(())
    }
    pub(super) fn require_candidate_recipe(
        &self,
        recipe: &super::child_recipe::CandidateChildRecipe<'_>,
    ) -> Result<super::CaptureOwnerIdentity> {
        self.owner.live()?;
        let current = self
            .owner
            .recipe_binding
            .lock()
            .expect("child output recipe binding");
        let actual = current
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_closed_recipe_required"))?;
        let expected = recipe.execution_binding(actual.argv_sha256.clone())?;
        ensure!(
            *actual == expected,
            "static_hls_child_output_original_recipe_required"
        );
        let source_identity = actual.source_identity.clone();
        drop(current);
        ensure!(
            self.owner
                .directory
                .lock()
                .expect("child output directory")
                .encoder_started,
            "static_hls_child_output_actual_encoder_required"
        );
        Ok(source_identity)
    }
    pub(super) fn require_original_permit(&self, permit: &Arc<dyn OutputPermit>) -> Result<()> {
        ensure!(
            Arc::ptr_eq(&self.owner.permit, permit),
            "static_hls_child_output_original_permit_required"
        );
        Ok(())
    }
    fn require_snapshot(&self, snapshot: &ChildOutputSnapshot) -> Result<()> {
        self.owner.readonly()?;
        ensure!(
            Arc::ptr_eq(&self.owner, &snapshot.owner) && Instant::now() < snapshot.until,
            "static_hls_child_output_original_snapshot_required"
        );
        match &snapshot.authority {
            SnapshotAuthority::Original(permit) => self.require_original_permit(permit),
            SnapshotAuthority::Published(receipt) => self.require_snapshot_receipt(receipt),
        }
    }
    pub(super) fn begin_publication(&self, snapshot: ChildOutputSnapshot) -> Result<()> {
        self.require_snapshot(&snapshot)?;
        ensure!(
            matches!(snapshot.authority, SnapshotAuthority::Original(_)),
            "static_hls_child_output_original_snapshot_required"
        );
        let root = self.owner.root_until.ok_or_else(|| {
            anyhow::anyhow!("static_hls_child_output_original_root_deadline_required")
        })?;
        ensure!(
            root > Instant::now() && root >= self.owner.until,
            "static_hls_child_output_root_deadline"
        );
        let mut state = self.owner.retention.lock().expect("child output retention");
        ensure!(
            matches!(*state, Retention::Encoding),
            "static_hls_child_output_publication_already_started"
        );
        ensure!(
            !*self.owner.stop.borrow() && Instant::now() < self.owner.until,
            "static_hls_child_output_publication_deadline"
        );
        *state = Retention::Publishing;
        Ok(())
    }
    fn require_snapshot_receipt(&self, receipt: &Arc<dyn PublishedOutputPermit>) -> Result<()> {
        self.owner.readonly()?;
        self.require_original_permit(receipt.original_write_permit())?;
        let root = self.owner.root_until.ok_or_else(|| {
            anyhow::anyhow!("static_hls_child_output_original_root_deadline_required")
        })?;
        ensure!(
            receipt.identity() == self.owner.identity
                && receipt.root_deadline() <= root
                && receipt.root_deadline() > Instant::now(),
            "static_hls_child_output_committed_receipt_binding"
        );
        let state = self.owner.retention.lock().expect("child output retention");
        ensure!(
            matches!(&*state, Retention::Publishing)
                || matches!(&*state, Retention::Published(existing) if Arc::ptr_eq(existing, receipt)),
            "static_hls_child_output_original_receipt_required"
        );
        Ok(())
    }
    pub(super) fn confirm_publication(
        &self,
        receipt: Arc<dyn PublishedOutputPermit>,
        snapshot: ChildOutputSnapshot,
    ) -> Result<()> {
        self.require_snapshot(&snapshot)?;
        ensure!(
            matches!(&snapshot.authority, SnapshotAuthority::Published(actual) if Arc::ptr_eq(actual, &receipt)),
            "static_hls_child_output_original_receipt_required"
        );
        self.require_snapshot_receipt(&receipt)?;
        let mut state = self.owner.retention.lock().expect("child output retention");
        match &*state {
            Retention::Publishing => *state = Retention::Published(receipt),
            Retention::Published(existing) if Arc::ptr_eq(existing, &receipt) => (),
            _ => anyhow::bail!("static_hls_child_output_original_receipt_required"),
        }
        Ok(())
    }
    pub(super) fn published_receipt(&self) -> Result<Arc<dyn PublishedOutputPermit>> {
        self.owner.readonly()?;
        match &*self.owner.retention.lock().expect("child output retention") {
            Retention::Published(receipt) => Ok(receipt.clone()),
            _ => anyhow::bail!("static_hls_child_output_publication_commit_required"),
        }
    }
    pub fn identity(&self) -> &OutputIdentity {
        &self.owner.identity
    }
    pub fn control(&self) -> ChildOutputControl {
        ChildOutputControl {
            owner: self.owner.clone(),
        }
    }

    /// The configured task cache root is the ONLY caller-supplied path. Job and
    /// attempt names are identity-derived. Both directories must be newly made;
    /// an existing directory/symlink is a refusal, never adopted or overwritten.
    /// Calling again after any outcome cannot allocate an alternative attempt.
    pub async fn create_in(&self, cache_root: &Path) -> Result<()> {
        self.owner.check().await?;
        ensure!(
            self.owner
                .create_started
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok(),
            "static_hls_child_output_creation_already_started"
        );
        let owner = self.owner.clone();
        let path = cache_root.to_owned();
        self.owner
            .scope
            .run(crate::child_process::blocking(move || {
                owner.writable()?;
                // Store each real handle IN the independent owner's state before
                // returning or doing the next operation, including partial errors.
                owner
                    .directory
                    .lock()
                    .expect("child output directory")
                    .create(&path, &owner.identity)
            }))
            .await??;
        self.owner.writable()
    }

    /// No writable File, raw fd, or independently spawneable output path escapes.
    /// The same scope retains a cancelled blocking write through handle closure.
    pub async fn write_complete(&self, name: &str, bytes: Vec<u8>) -> Result<()> {
        ensure!(output_name(name), "static_hls_child_output_name");
        ensure!(
            !bytes.is_empty() && bytes.len() as u64 <= FILE_BYTES,
            "static_hls_child_output_file_bound"
        );
        self.owner.check().await?;
        let owner = self.owner.clone();
        let name = name.to_owned();
        self.owner
            .scope
            .run(crate::child_process::blocking(move || {
                owner.writable()?;
                let mut directory = owner.directory.lock().expect("child output directory");
                ensure!(
                    !directory.encoder_planned,
                    "static_hls_child_output_encoder_writer"
                );
                directory.write(&owner.identity, &name, &bytes)
            }))
            .await??;
        self.owner.writable()
    }

    /// Build and launch through the ORIGINAL input's managed process owner. The
    /// builder is synchronous; it must not separately spawn or retain handles.
    /// We inherit this owner's output descriptor only in the child pre-exec.
    #[cfg(target_os = "linux")]
    pub async fn spawn_via_input(
        &self,
        capture: &VerifiedCapture,
        build: impl FnOnce(std::os::fd::BorrowedFd<'_>, &Path) -> Result<tokio::process::Command>,
    ) -> Result<crate::child_process::Child> {
        self.owner.check().await?;
        let input = self.owner.input.original()?;
        let child = input
            .spawn(capture, |input_fd| {
                self.owner.writable()?;
                let mut directory = self.owner.directory.lock().expect("child output directory");
                directory.verify(&self.owner.identity)?;
                ensure!(
                    !directory.encoder_planned && directory.names.is_empty(),
                    "static_hls_child_output_encoder_already_started"
                );
                let fd = directory
                    .directory
                    .as_ref()
                    .expect("verified output directory")
                    .as_raw_fd();
                let path = PathBuf::from(format!("/proc/self/fd/{fd}"));
                let mut command = build(input_fd, &path)?;
                command
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null());
                unsafe {
                    command.pre_exec(move || {
                        let flags = libc::fcntl(fd, libc::F_GETFD);
                        if flags < 0
                            || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                        for (resource, limit) in [
                            (libc::RLIMIT_FSIZE, FILE_BYTES),
                            (libc::RLIMIT_CPU, super::child_recipe::MAX_CPU_SECONDS),
                            (
                                libc::RLIMIT_AS,
                                super::child_recipe::MAX_ADDRESS_SPACE_BYTES,
                            ),
                        ] {
                            let bound = libc::rlimit {
                                rlim_cur: limit as libc::rlim_t,
                                rlim_max: limit as libc::rlim_t,
                            };
                            if libc::setrlimit(resource, &bound) != 0 {
                                return Err(std::io::Error::last_os_error());
                            }
                        }
                        Ok(())
                    });
                }
                self.owner.writable()?;
                // Mark this *planned* closed name set before spawn, so a cancelled
                // successful spawn cannot strand its files. A failed spawn produces
                // no process receipt; the original input scope is still drained.
                directory.encoder_planned = true;
                Ok(command)
            })
            .await?;
        // No intervening await: a cancelled successful spawn cannot lose this
        // actual admission observation. Planned argv alone never means Reaped.
        self.owner
            .directory
            .lock()
            .expect("child output directory")
            .encoder_started = true;
        Ok(child)
    }

    /// Drain the actual encoder, then observe this exact directory's final
    /// closed name/count/byte inventory. No media/container/playback claim is made.
    pub async fn inspect_after_reap(&self) -> Result<Vec<OutputFileObservation>> {
        if !self.owner.inspection_ready.load(Ordering::SeqCst) {
            self.owner.check().await?;
            ensure!(
                self.owner
                    .writers_closed
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok(),
                "static_hls_child_output_already_draining"
            );
            self.owner.input.drain().await?;
            // This phase can only be entered by the actual original input's
            // positive scope receipt. There is no caller-supplied bool witness.
            self.owner.inspection_ready.store(true, Ordering::SeqCst);
        }
        self.owner.check_current().await?;
        let owner = self.owner.clone();
        self.owner
            .scope
            .run(crate::child_process::blocking(move || {
                owner.live()?;
                owner
                    .directory
                    .lock()
                    .expect("child output directory")
                    .inventory(&owner.identity, true)
            }))
            .await?
    }
    /// Private verifier access is admitted only after the ORIGINAL encoder
    /// input scope has positively reaped and all writers were permanently shut.
    /// No path, raw fd, writable handle or caller-made receipt escapes here.
    pub(super) async fn read_after_reap(&self, name: &str, maximum: usize) -> Result<Vec<u8>> {
        ensure!(
            output_name(name)
                && !name.ends_with(".tmp")
                && maximum > 0
                && maximum as u64 <= FILE_BYTES,
            "static_hls_child_output_read_name_or_bound"
        );
        self.check_readonly().await?;
        let owner = self.owner.clone();
        let name = name.to_owned();
        let bytes = self
            .owner
            .scope
            .run(crate::child_process::blocking(move || {
                owner.readonly()?;
                let directory = owner.directory.lock().expect("child output directory");
                directory.read(&owner.identity, &name, maximum)
            }))
            .await??;
        self.check_readonly().await?;
        Ok(bytes)
    }

    /// One bounded private snapshot, with fresh COMPLETE database authority on
    /// either side of all original-scope blocking reads. Public per-request and
    /// per-chunk gates deliberately continue using read_after_reap/check_read.
    /// In-flight/unknown custody alone grants no snapshot authority: promotion
    /// must supply the positively committed SAME original receipt.
    pub(super) async fn snapshot_after_reap(
        &self,
        publication: Option<&Arc<dyn PublishedOutputPermit>>,
    ) -> Result<ChildOutputSnapshot> {
        self.owner.readonly()?;
        let authority = if let Some(receipt) = publication {
            self.require_snapshot_receipt(receipt)?;
            SnapshotAuthority::Published(receipt.clone())
        } else {
            match &*self.owner.retention.lock().expect("child output retention") {
                Retention::Encoding => SnapshotAuthority::Original(self.owner.permit.clone()),
                Retention::Published(receipt) => SnapshotAuthority::Published(receipt.clone()),
                Retention::Publishing => {
                    anyhow::bail!("static_hls_child_output_positive_publication_receipt_required")
                }
            }
        };
        let until = match &authority {
            SnapshotAuthority::Original(_) => self.owner.deadline(),
            SnapshotAuthority::Published(receipt) => {
                self.owner.deadline().min(receipt.root_deadline())
            }
        };
        let mut stop = self.owner.stop.subscribe();
        let work = async {
            self.check_snapshot_authority(&authority, until).await?;
            let owner = self.owner.clone();
            let resources = self
                .owner
                .scope
                .run(crate::child_process::blocking(move || {
                    owner.readonly()?;
                    let mut directory = owner.directory.lock().expect("child output directory");
                    directory.snapshot(&owner.identity, || {
                        owner.readonly()?;
                        ensure!(
                            Instant::now() < until,
                            "static_hls_child_output_snapshot_deadline"
                        );
                        Ok(())
                    })
                }))
                .await??;
            self.check_snapshot_authority(&authority, until).await?;
            Ok::<_, anyhow::Error>(resources)
        };
        let resources = tokio::select! {
            biased;
            _ = stop.changed() => anyhow::bail!("static_hls_child_output_revoked"),
            _ = tokio::time::sleep_until(until) => anyhow::bail!("static_hls_child_output_snapshot_deadline"),
            result = work => result?,
        };
        self.owner.readonly()?;
        ensure!(
            Instant::now() < until,
            "static_hls_child_output_snapshot_deadline"
        );
        Ok(ChildOutputSnapshot {
            owner: self.owner.clone(),
            authority,
            until,
            resources,
        })
    }

    async fn check_snapshot_authority(
        &self,
        authority: &SnapshotAuthority,
        until: Instant,
    ) -> Result<()> {
        self.owner.readonly()?;
        ensure!(
            Instant::now() < until,
            "static_hls_child_output_snapshot_deadline"
        );
        match authority {
            SnapshotAuthority::Original(permit) => {
                self.require_original_permit(permit)?;
                ensure!(
                    matches!(
                        *self.owner.retention.lock().expect("child output retention"),
                        Retention::Encoding
                    ),
                    "static_hls_child_output_original_snapshot_required"
                );
                tokio::time::timeout_at(until, permit.check())
                    .await
                    .map_err(|_| anyhow::anyhow!("static_hls_child_output_authority_timeout"))??;
                ensure!(
                    matches!(
                        *self.owner.retention.lock().expect("child output retention"),
                        Retention::Encoding
                    ),
                    "static_hls_child_output_original_snapshot_required"
                );
            }
            SnapshotAuthority::Published(receipt) => {
                self.require_snapshot_receipt(receipt)?;
                tokio::time::timeout_at(until, receipt.check_retention())
                    .await
                    .map_err(|_| anyhow::anyhow!("static_hls_child_output_authority_timeout"))??;
                self.require_snapshot_receipt(receipt)?;
            }
        }
        self.owner.readonly()?;
        ensure!(
            Instant::now() < until,
            "static_hls_child_output_snapshot_deadline"
        );
        Ok(())
    }

    pub(super) async fn check_readonly(&self) -> Result<()> {
        self.owner.readonly()?;
        self.owner.check_current().await?;
        self.owner.readonly()
    }

    pub(super) fn require_successful_encoder_reap(&self) -> Result<()> {
        self.owner.readonly()?;
        self.owner.input.original()?.require_successful_reap()
    }

    pub(super) fn readonly_live(&self) -> Result<()> {
        self.owner.readonly()
    }

    /// All verifier subprocesses and non-interruptible work enter THIS output
    /// owner's real scope. The drained input scope is never reopened or reused.
    /// Cancelling this future leaves registrations with the independent owner.
    pub(super) async fn validation_work<F, T>(&self, work: F) -> Result<T>
    where
        F: std::future::Future<Output = Result<T>>,
    {
        self.check_readonly().await?;
        let mut stop = self.owner.stop.subscribe();
        let work = self.owner.scope.run(work);
        let result = tokio::select! {
            biased;
            _ = stop.changed() => Err(anyhow::anyhow!("static_hls_child_output_revoked")),
            _ = tokio::time::sleep_until(self.owner.until) => Err(anyhow::anyhow!("static_hls_child_output_validation_deadline")),
            result = work => result,
        };
        self.owner.readonly()?;
        result
    }

    #[cfg(target_os = "linux")]
    pub(super) async fn spawn_readonly_validator(
        &self,
        build: impl FnOnce(std::os::fd::BorrowedFd<'_>) -> Result<tokio::process::Command>,
    ) -> Result<crate::child_process::Child> {
        use std::os::fd::AsFd;
        self.check_readonly().await?;
        self.owner
            .scope
            .run(async {
                self.owner.readonly()?;
                let directory = self.owner.directory.lock().expect("child output directory");
                directory.inventory(&self.owner.identity, true)?;
                ensure!(
                    directory.encoder_started,
                    "static_hls_child_output_actual_encoder_required"
                );
                let held = directory
                    .directory
                    .as_ref()
                    .expect("verified output directory");
                let fd = held.as_raw_fd();
                let mut command = build(held.as_fd())?;
                unsafe {
                    command.pre_exec(move || {
                        let flags = libc::fcntl(fd, libc::F_GETFD);
                        if flags < 0
                            || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                        {
                            return Err(std::io::Error::last_os_error());
                        }
                        for (resource, maximum) in [
                            (libc::RLIMIT_CPU, super::child_recipe::MAX_CPU_SECONDS),
                            (
                                libc::RLIMIT_AS,
                                super::child_recipe::MAX_ADDRESS_SPACE_BYTES,
                            ),
                        ] {
                            let limit = libc::rlimit {
                                rlim_cur: maximum as libc::rlim_t,
                                rlim_max: maximum as libc::rlim_t,
                            };
                            if libc::setrlimit(resource, &limit) < 0 {
                                return Err(std::io::Error::last_os_error());
                            }
                        }
                        Ok(())
                    });
                }
                self.owner.readonly()?;
                crate::child_process::spawn(command)
                    .map_err(|_| anyhow::anyhow!("static_hls_child_output_validator_spawn"))
            })
            .await
    }

    pub fn cancel(&self) {
        self.owner.cancel();
    }
    pub async fn close_and_dispose(&self) -> Result<Arc<ChildOutputDisposalProof>> {
        self.control().close_and_dispose().await
    }
}
impl Drop for ChildOutputOwner {
    fn drop(&mut self) {
        // The same original independent owner now owns in-flight/unknown or
        // committed retention. Old encoder handles cannot revoke the handoff.
        // Explicit controller shutdown still cancels and positively drains it.
        if !self.owner.detached_from_encoder() {
            self.owner.cancel();
        }
    }
}

/// A clone of the original in-process controller, never reconstructed by UUID.
#[derive(Clone)]
pub struct ChildOutputControl {
    owner: Arc<Owner>,
}
impl ChildOutputControl {
    pub fn identity(&self) -> &OutputIdentity {
        &self.owner.identity
    }
    pub fn cancel(&self) {
        self.owner.cancel();
    }
    pub fn disposal_state(&self) -> OutputDisposalState {
        *self.owner.state.borrow()
    }
    pub fn disposal_proof(&self) -> Option<Arc<ChildOutputDisposalProof>> {
        self.owner.proof.get().cloned()
    }
    pub async fn close_and_dispose(&self) -> Result<Arc<ChildOutputDisposalProof>> {
        self.cancel();
        let mut state = self.owner.state.subscribe();
        loop {
            match *state.borrow_and_update() {
                OutputDisposalState::Removed => {
                    return self
                        .disposal_proof()
                        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_proof_missing"));
                }
                OutputDisposalState::Unresolved => {
                    anyhow::bail!("static_hls_child_output_disposal_unconfirmed")
                }
                OutputDisposalState::Pending => {}
            }
            state
                .changed()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_child_output_owner_unknown"))?;
        }
    }
}

fn output_name(name: &str) -> bool {
    matches!(name, "index.m3u8" | "index.m3u8.tmp" | "init.mp4") || {
        let name = name.strip_suffix(".tmp").unwrap_or(name);
        name.strip_prefix('s')
            .and_then(|s| s.strip_suffix(".m4s"))
            .is_some_and(|s| {
                s.len() == 3
                    && s.bytes().all(|b| b.is_ascii_digit())
                    && s.parse::<usize>()
                        .is_ok_and(|n| n < 5 && format!("{n:03}") == s)
            })
    }
}

#[cfg(target_os = "linux")]
fn c(value: &str) -> Result<std::ffi::CString> {
    std::ffi::CString::new(value).map_err(|_| anyhow::anyhow!("static_hls_child_output_path"))
}
#[cfg(target_os = "linux")]
fn open_at(directory: &File, name: &str, flags: i32) -> Result<File> {
    let name = c(name)?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    ensure!(fd >= 0, "static_hls_child_output_open");
    Ok(unsafe { File::from_raw_fd(fd) })
}
#[cfg(target_os = "linux")]
fn cache_root(path: &Path) -> Result<File> {
    use std::{os::unix::fs::OpenOptionsExt, path::Component};
    ensure!(path.is_absolute(), "static_hls_child_output_cache_root");
    let mut directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open("/")?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = open_at(
                    &directory,
                    name.to_str()
                        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_cache_root"))?,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                )?
            }
            _ => anyhow::bail!("static_hls_child_output_cache_root"),
        }
    }
    let meta = directory.metadata()?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o022 == 0,
        "static_hls_child_output_cache_root_permissions"
    );
    Ok(directory)
}
#[cfg(target_os = "linux")]
fn same_file(a: &File, b: &File) -> Result<()> {
    let a = a.metadata()?;
    let b = b.metadata()?;
    ensure!(
        a.dev() == b.dev() && a.ino() == b.ino(),
        "static_hls_child_output_owner_mismatch"
    );
    Ok(())
}
#[cfg(target_os = "linux")]
fn entries(directory: &File) -> Result<BTreeSet<String>> {
    std::fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))?
        .map(|entry| {
            let name = entry?
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("static_hls_child_output_name"))?;
            Ok(name)
        })
        .collect()
}

#[cfg(target_os = "linux")]
impl Directory {
    fn create(&mut self, path: &Path, identity: &OutputIdentity) -> Result<()> {
        self.root = Some(Arc::new(cache_root(path)?));
        let root = self.root.as_ref().expect("stored cache root");
        let job = c(identity.job_id())?;
        ensure!(
            unsafe { libc::mkdirat(root.as_raw_fd(), job.as_ptr(), 0o700) } == 0,
            "static_hls_child_output_parent_exists_or_create_failed"
        );
        self.parent = Some(open_at(
            root,
            identity.job_id(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        let parent = self.parent.as_ref().expect("stored output parent");
        let attempt = identity.attempt().to_string();
        let name = c(&attempt)?;
        ensure!(
            unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } == 0,
            "static_hls_child_output_attempt_exists_or_create_failed"
        );
        let directory = open_at(parent, &attempt, libc::O_RDONLY | libc::O_DIRECTORY)?;
        // Above stdio and never closed/reused before original input drain.
        let fd = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
        ensure!(fd >= 0, "static_hls_child_output_handle");
        self.directory = Some(unsafe { File::from_raw_fd(fd) });
        let directory = self.directory.as_ref().expect("stored output directory");
        self.marker = Some(open_at(
            directory,
            OWNER,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        )?);
        let marker = self.marker.as_mut().expect("stored output marker");
        marker.write_all(&identity.marker())?;
        marker.sync_all()?;
        directory.sync_all()?;
        parent.sync_all()?;
        self.complete = true;
        self.verify(identity)
    }
    fn verify(&self, identity: &OutputIdentity) -> Result<()> {
        ensure!(
            self.complete && !self.removed,
            "static_hls_child_output_not_created"
        );
        let root = self.root.as_ref().expect("complete cache root");
        let parent = self.parent.as_ref().expect("complete output parent");
        let directory = self.directory.as_ref().expect("complete output directory");
        same_file(
            parent,
            &open_at(root, identity.job_id(), libc::O_RDONLY | libc::O_DIRECTORY)?,
        )?;
        same_file(
            directory,
            &open_at(
                parent,
                &identity.attempt().to_string(),
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?,
        )?;
        for held in [parent, directory] {
            let meta = held.metadata()?;
            ensure!(
                meta.is_dir()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.mode() & 0o077 == 0,
                "static_hls_child_output_directory_permissions"
            );
        }
        let file = open_at(directory, OWNER, libc::O_RDONLY)?;
        same_file(self.marker.as_ref().expect("complete output marker"), &file)?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file()
                && meta.nlink() == 1
                && meta.uid() == unsafe { libc::geteuid() }
                && meta.len() == identity.marker().len() as u64,
            "static_hls_child_output_marker"
        );
        let mut actual = Vec::new();
        file.take(513).read_to_end(&mut actual)?;
        ensure!(
            actual == identity.marker(),
            "static_hls_child_output_marker"
        );
        Ok(())
    }
    fn owned_name(&self, name: &str) -> bool {
        self.names.contains(name) || (self.encoder_planned && output_name(name))
    }
    fn inventory(
        &self,
        identity: &OutputIdentity,
        final_output: bool,
    ) -> Result<Vec<OutputFileObservation>> {
        self.verify(identity)?;
        let directory = self.directory.as_ref().expect("verified output directory");
        let names = entries(directory)?;
        ensure!(names.contains(OWNER), "static_hls_child_output_marker");
        ensure!(
            names.len().saturating_sub(1) <= FILES,
            "static_hls_child_output_file_count"
        );
        let mut total = identity.marker().len() as u64;
        let mut files = Vec::new();
        for name in names.iter().filter(|name| name.as_str() != OWNER) {
            ensure!(
                output_name(name) && self.owned_name(name),
                "static_hls_child_output_unowned_entry"
            );
            let file = open_at(directory, name, libc::O_RDONLY)?;
            let meta = file.metadata()?;
            ensure!(
                meta.is_file() && meta.nlink() == 1 && meta.uid() == unsafe { libc::geteuid() },
                "static_hls_child_output_not_regular"
            );
            ensure!(
                meta.len() <= FILE_BYTES && (!final_output || meta.len() > 0),
                "static_hls_child_output_file_bound"
            );
            ensure!(
                !final_output || !name.ends_with(".tmp"),
                "static_hls_child_output_temporary_entry"
            );
            total = total
                .checked_add(meta.len())
                .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_total_bound"))?;
            ensure!(total <= TOTAL_BYTES, "static_hls_child_output_total_bound");
            files.push(OutputFileObservation {
                name: name.clone(),
                bytes: meta.len(),
            });
        }
        if final_output {
            ensure!(
                names.contains("index.m3u8")
                    && names.contains("init.mp4")
                    && names.contains("s000.m4s"),
                "static_hls_child_output_incomplete"
            );
            let count = files
                .iter()
                .filter(|file| file.name.ends_with(".m4s"))
                .count();
            ensure!(
                (1..=5).contains(&count)
                    && (0..count).all(|i| names.contains(&format!("s{i:03}.m4s"))),
                "static_hls_child_output_segment_set"
            );
        }
        Ok(files)
    }
    fn read(&self, identity: &OutputIdentity, name: &str, maximum: usize) -> Result<Vec<u8>> {
        self.inventory(identity, true)?;
        ensure!(
            self.owned_name(name),
            "static_hls_child_output_unowned_entry"
        );
        let directory = self.directory.as_ref().expect("verified output directory");
        let mut file = open_at(directory, name, libc::O_RDONLY)?;
        let before = file.metadata()?;
        ensure!(
            before.len() > 0 && before.len() <= maximum as u64,
            "static_hls_child_output_read_bound"
        );
        let mut bytes = Vec::with_capacity(before.len() as usize);
        (&mut file)
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        same_file(&file, &open_at(directory, name, libc::O_RDONLY)?)?;
        ensure!(
            bytes.len() as u64 == before.len()
                && before.len() == after.len()
                && before.mtime() == after.mtime()
                && before.mtime_nsec() == after.mtime_nsec()
                && before.ctime() == after.ctime()
                && before.ctime_nsec() == after.ctime_nsec(),
            "static_hls_child_output_changed_during_read"
        );
        self.verify(identity)?;
        Ok(bytes)
    }
    fn snapshot(
        &mut self,
        identity: &OutputIdentity,
        mut readonly: impl FnMut() -> Result<()>,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        readonly()?;
        let inventory = self.inventory(identity, true)?;
        let directory = self.directory.as_ref().expect("verified output directory");
        if self.snapshot_files.is_none() {
            let mut held = BTreeMap::new();
            for entry in &inventory {
                readonly()?;
                let file = open_at(directory, &entry.name, libc::O_RDONLY)?;
                let meta = file.metadata()?;
                ensure!(
                    meta.is_file()
                        && meta.nlink() == 1
                        && meta.uid() == unsafe { libc::geteuid() }
                        && meta.len() == entry.bytes,
                    "static_hls_child_output_inventory_changed"
                );
                held.insert(entry.name.clone(), file);
            }
            // Pin all descriptors together in original independent custody.
            // A later cancelled snapshot cannot lose or replace this inode set.
            self.snapshot_files = Some(held);
        }
        let held = self.snapshot_files.as_mut().expect("pinned output files");
        ensure!(
            held.len() == inventory.len()
                && inventory.iter().all(|entry| held.contains_key(&entry.name)),
            "static_hls_child_output_complete_closed_names"
        );
        let mut resources = Vec::with_capacity(inventory.len());
        let mut observations = BTreeMap::new();
        let mut total = identity.marker().len() as u64;
        for entry in &inventory {
            readonly()?;
            let file = held.get_mut(&entry.name).expect("exact pinned output name");
            same_file(file, &open_at(directory, &entry.name, libc::O_RDONLY)?)?;
            let before = file.metadata()?;
            let maximum = match entry.name.as_str() {
                "index.m3u8" => super::MANIFEST_BYTES as u64,
                "init.mp4" => (super::INIT_BYTES as u64).min(FILE_BYTES),
                _ => FILE_BYTES,
            };
            ensure!(
                before.is_file()
                    && before.nlink() == 1
                    && before.uid() == unsafe { libc::geteuid() }
                    && before.len() == entry.bytes
                    && before.len() > 0
                    && before.len() <= maximum,
                "static_hls_child_output_read_bound"
            );
            file.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::with_capacity(before.len() as usize);
            let mut buffer = [0u8; 65536];
            loop {
                readonly()?;
                let n = file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                ensure!(
                    n as u64 <= maximum.saturating_sub(bytes.len() as u64),
                    "static_hls_child_output_read_bound"
                );
                bytes.extend_from_slice(&buffer[..n]);
            }
            readonly()?;
            let after = file.metadata()?;
            same_file(file, &open_at(directory, &entry.name, libc::O_RDONLY)?)?;
            unchanged_snapshot_file(&before, &after, bytes.len())?;
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_total_bound"))?;
            ensure!(total <= TOTAL_BYTES, "static_hls_child_output_total_bound");
            observations.insert(entry.name.clone(), before);
            resources.push((entry.name.clone(), bytes));
        }
        // Recheck the WHOLE retained inventory after the last byte, including
        // files read earlier. No extra names, inode swap or late same-size edit
        // can hide behind a successful read of the final segment.
        readonly()?;
        self.verify(identity)?;
        ensure!(
            entries(directory)?
                == inventory
                    .iter()
                    .map(|entry| entry.name.clone())
                    .chain(std::iter::once(OWNER.to_owned()))
                    .collect::<BTreeSet<_>>(),
            "static_hls_child_output_complete_closed_names"
        );
        for (name, before) in &observations {
            readonly()?;
            let file = self
                .snapshot_files
                .as_ref()
                .expect("pinned output files")
                .get(name)
                .expect("exact pinned output name");
            same_file(file, &open_at(directory, name, libc::O_RDONLY)?)?;
            unchanged_snapshot_file(before, &file.metadata()?, before.len() as usize)?;
        }
        readonly()?;
        Ok(resources)
    }
    fn write(&mut self, identity: &OutputIdentity, name: &str, bytes: &[u8]) -> Result<()> {
        let files = self.inventory(identity, false)?;
        ensure!(
            files.len() < FILES && !self.names.contains(name),
            "static_hls_child_output_file_count"
        );
        let used = files
            .iter()
            .try_fold(identity.marker().len() as u64, |sum, file| {
                sum.checked_add(file.bytes)
                    .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_total_bound"))
            })?;
        ensure!(
            used.checked_add(bytes.len() as u64)
                .is_some_and(|n| n <= TOTAL_BYTES),
            "static_hls_child_output_total_bound"
        );
        let directory = self.directory.as_ref().expect("verified output directory");
        let mut file = open_at(
            directory,
            name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        // Register immediately, before any write or error/cancel can return.
        self.names.insert(name.to_owned());
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        directory.sync_all()?;
        Ok(())
    }
    fn remove(&mut self, identity: &OutputIdentity) -> Result<(u64, u64, ProcessDisposition)> {
        self.verify(identity)?;
        let parent = self.parent.as_ref().expect("verified output parent");
        let directory = self.directory.as_ref().expect("verified output directory");
        let meta = directory.metadata()?;
        let names = entries(directory)?;
        ensure!(
            names.contains(OWNER)
                && names
                    .iter()
                    .all(|name| name == OWNER || self.owned_name(name)),
            "static_hls_child_output_cleanup_unowned_entry"
        );
        ensure!(
            entries(parent)? == BTreeSet::from([identity.attempt().to_string()]),
            "static_hls_child_output_cleanup_parent_entry"
        );
        // Refuse symlinks, directories and hardlinks before removing anything.
        for name in names.iter().filter(|name| name.as_str() != OWNER) {
            let file = open_at(directory, name, libc::O_RDONLY)?;
            let meta = file.metadata()?;
            ensure!(
                meta.is_file() && meta.nlink() == 1 && meta.uid() == unsafe { libc::geteuid() },
                "static_hls_child_output_cleanup_not_regular"
            );
        }
        for name in names.iter().filter(|name| name.as_str() != OWNER) {
            let name = c(name)?;
            ensure!(
                unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == 0,
                "static_hls_child_output_cleanup_file"
            );
        }
        self.verify(identity)?;
        let marker = c(OWNER)?;
        ensure!(
            unsafe { libc::unlinkat(directory.as_raw_fd(), marker.as_ptr(), 0) } == 0,
            "static_hls_child_output_cleanup_marker"
        );
        let attempt = c(&identity.attempt().to_string())?;
        ensure!(
            unsafe { libc::unlinkat(parent.as_raw_fd(), attempt.as_ptr(), libc::AT_REMOVEDIR) }
                == 0,
            "static_hls_child_output_cleanup_directory"
        );
        let root = self.root.as_ref().expect("verified cache root");
        same_file(
            parent,
            &open_at(root, identity.job_id(), libc::O_RDONLY | libc::O_DIRECTORY)?,
        )?;
        let job = c(identity.job_id())?;
        ensure!(
            unsafe { libc::unlinkat(root.as_raw_fd(), job.as_ptr(), libc::AT_REMOVEDIR) } == 0,
            "static_hls_child_output_cleanup_parent"
        );
        parent.sync_all()?;
        root.sync_all()?;
        let process = if self.encoder_started {
            ProcessDisposition::Reaped
        } else {
            ProcessDisposition::NeverStarted
        };
        self.removed = true;
        self.names.clear();
        // Close every original descriptor before returning the positive witness.
        self.snapshot_files.take();
        self.marker.take();
        self.directory.take();
        self.parent.take();
        self.root.take();
        // Actual scope drain was checked by the independent caller above.
        Ok((meta.dev(), meta.ino(), process))
    }
}
#[cfg(target_os = "linux")]
fn unchanged_snapshot_file(
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
    bytes: usize,
) -> Result<()> {
    ensure!(
        after.is_file()
            && after.nlink() == 1
            && after.uid() == unsafe { libc::geteuid() }
            && before.dev() == after.dev()
            && before.ino() == after.ino()
            && bytes as u64 == before.len()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "static_hls_child_output_changed_during_read"
    );
    Ok(())
}
#[cfg(not(target_os = "linux"))]
impl Directory {
    fn create(&mut self, _: &Path, _: &OutputIdentity) -> Result<()> {
        anyhow::bail!("static_hls_linux_required")
    }
    fn inventory(&self, _: &OutputIdentity, _: bool) -> Result<Vec<OutputFileObservation>> {
        anyhow::bail!("static_hls_linux_required")
    }
    fn read(&self, _: &OutputIdentity, _: &str, _: usize) -> Result<Vec<u8>> {
        anyhow::bail!("static_hls_linux_required")
    }
    fn snapshot(
        &mut self,
        _: &OutputIdentity,
        _: impl FnMut() -> Result<()>,
    ) -> Result<Vec<(String, Vec<u8>)>> {
        anyhow::bail!("static_hls_linux_required")
    }
    fn write(&mut self, _: &OutputIdentity, _: &str, _: &[u8]) -> Result<()> {
        anyhow::bail!("static_hls_linux_required")
    }
    fn remove(&mut self, _: &OutputIdentity) -> Result<(u64, u64, ProcessDisposition)> {
        anyhow::bail!("static_hls_linux_required")
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Permit {
        identity: OutputIdentity,
        checks: AtomicUsize,
    }
    impl OutputPermit for Permit {
        fn identity(&self) -> OutputIdentity {
            self.identity.clone()
        }
        fn check(&self) -> CaptureFuture<'_, ()> {
            Box::pin(async move {
                self.checks.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        }
        fn check_write(&self) -> CaptureFuture<'_, ()> {
            self.check()
        }
    }
    fn fixture() -> (PathBuf, Arc<Permit>, ChildOutputOwner) {
        let root =
            std::env::temp_dir().join(format!("rainsync-child-owned-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let identity = OutputIdentity::new(
            uuid::Uuid::new_v4().to_string(),
            1,
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let permit = Arc::new(Permit {
            identity,
            checks: AtomicUsize::new(0),
        });
        let owner = ChildOutputOwner::prepare_inner(
            permit.clone(),
            InputOwner::NeverStarted,
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap();
        (root, permit, owner)
    }
    async fn disposed(owner: &ChildOutputOwner) -> Arc<ChildOutputDisposalProof> {
        tokio::time::timeout(Duration::from_secs(3), owner.close_and_dispose())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn promotion_keeps_same_owner_and_separates_retention_from_read_authority() {
        // Custody-only unit fixture. These bytes/permits cannot manufacture a
        // ValidatedChildOutput, durable COMMIT receipt or production media grant.
        struct RootPermit {
            identity: OutputIdentity,
            root: Instant,
        }
        impl OutputPermit for RootPermit {
            fn identity(&self) -> OutputIdentity {
                self.identity.clone()
            }
            fn check(&self) -> CaptureFuture<'_, ()> {
                Box::pin(async { Ok(()) })
            }
            fn check_write(&self) -> CaptureFuture<'_, ()> {
                Box::pin(async { Ok(()) })
            }
            fn root_deadline(&self) -> Option<Instant> {
                Some(self.root)
            }
        }
        struct Receipt {
            original: Arc<dyn OutputPermit>,
            root: Instant,
            checks: Arc<AtomicUsize>,
        }
        impl PublishedOutputPermit for Receipt {
            fn identity(&self) -> OutputIdentity {
                self.original.identity()
            }
            fn original_write_permit(&self) -> &Arc<dyn OutputPermit> {
                &self.original
            }
            fn root_deadline(&self) -> Instant {
                self.root
            }
            fn require_same_frozen_input(
                &self,
                _: &super::super::contracts::input::FrozenInput,
            ) -> Result<()> {
                anyhow::bail!("unit_no_durable_frozen_input")
            }
            fn check_retention(&self) -> CaptureFuture<'_, ()> {
                Box::pin(async {
                    self.checks.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            }
            fn check_read(&self) -> CaptureFuture<'_, ()> {
                Box::pin(async { anyhow::bail!("unit_input_disposal_not_proven") })
            }
        }
        let root = std::env::temp_dir().join(format!("child-promotion-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root_until = Instant::now() + Duration::from_secs(4);
        let original: Arc<dyn OutputPermit> = Arc::new(RootPermit {
            identity: OutputIdentity::new(
                uuid::Uuid::new_v4().to_string(),
                1,
                uuid::Uuid::new_v4().to_string(),
            )
            .unwrap(),
            root: root_until,
        });
        let owner = ChildOutputOwner::prepare_inner(
            original.clone(),
            InputOwner::NeverStarted,
            Instant::now() + Duration::from_millis(200),
        )
        .unwrap();
        owner.create_in(&root).await.unwrap();
        for (name, bytes) in [
            ("index.m3u8", b"custody-only".as_slice()),
            ("init.mp4", b"init".as_slice()),
            ("s000.m4s", b"segment".as_slice()),
        ] {
            owner.write_complete(name, bytes.to_vec()).await.unwrap();
        }
        owner.inspect_after_reap().await.unwrap();
        let snapshot = owner.snapshot_after_reap(None).await.unwrap();
        owner.begin_publication(snapshot).unwrap();
        assert!(
            owner.snapshot_after_reap(None).await.is_err(),
            "unknown/in-flight custody has no snapshot authority"
        );
        assert!(owner.write_complete("s001.m4s", vec![1]).await.is_err());
        let receipt_checks = Arc::new(AtomicUsize::new(0));
        let late: Arc<dyn PublishedOutputPermit> = Arc::new(Receipt {
            original: original.clone(),
            root: root_until + Duration::from_secs(1),
            checks: receipt_checks.clone(),
        });
        assert!(
            owner.snapshot_after_reap(Some(&late)).await.is_err(),
            "original root cannot expand"
        );
        let equal_ids: Arc<dyn OutputPermit> = Arc::new(RootPermit {
            identity: original.identity(),
            root: root_until,
        });
        let imitation: Arc<dyn PublishedOutputPermit> = Arc::new(Receipt {
            original: equal_ids,
            root: root_until,
            checks: receipt_checks.clone(),
        });
        assert!(
            owner.snapshot_after_reap(Some(&imitation)).await.is_err(),
            "same IDs do not substitute original permit"
        );
        let receipt: Arc<dyn PublishedOutputPermit> = Arc::new(Receipt {
            original: original.clone(),
            root: root_until,
            checks: receipt_checks.clone(),
        });
        let different_receipt: Arc<dyn PublishedOutputPermit> = Arc::new(Receipt {
            original,
            root: root_until,
            checks: receipt_checks.clone(),
        });
        let snapshot = owner.snapshot_after_reap(Some(&receipt)).await.unwrap();
        assert_eq!(receipt_checks.load(Ordering::SeqCst), 2);
        assert!(
            owner
                .confirm_publication(different_receipt, snapshot)
                .is_err(),
            "equal receipt metadata does not substitute the actual fenced receipt Arc"
        );
        let snapshot = owner.snapshot_after_reap(Some(&receipt)).await.unwrap();
        let before_promotion = receipt_checks.load(Ordering::SeqCst);
        owner
            .confirm_publication(receipt.clone(), snapshot)
            .unwrap();
        assert_eq!(
            receipt_checks.load(Ordering::SeqCst),
            before_promotion,
            "consuming the exact completed batch needs no redundant database fence"
        );
        assert!(
            receipt.check_read().await.is_err(),
            "retention does not authorize public reads"
        );
        let first_reader = owner.acquire_read_guard().unwrap();
        let second_reader = owner.acquire_read_guard().unwrap();
        assert!(
            owner.acquire_read_guard().is_err(),
            "two actual body guards bound admission"
        );
        let control = owner.control();
        let attempt = root.join(owner.identity().relative_key());
        drop(owner); // Old encoder custody has actually handed off, cannot cancel.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            attempt.is_dir(),
            "encoding wall expiry does not delete committed retained output"
        );
        assert!(control.disposal_proof().is_none());
        assert!(
            tokio::time::timeout(Duration::from_millis(20), control.close_and_dispose())
                .await
                .is_err()
        );
        assert!(
            attempt.is_dir(),
            "body guards retain files after a canceled drain waiter"
        );
        assert!(control.disposal_proof().is_none());
        drop(first_reader);
        assert!(
            control.disposal_proof().is_none(),
            "remaining real reader blocks disposal"
        );
        drop(second_reader);
        let proof = control.close_and_dispose().await.unwrap();
        assert_eq!(
            proof.process_disposition(),
            ProcessDisposition::NeverStarted
        );
        assert!(!attempt.exists());
        std::fs::remove_dir(root).unwrap();
    }

    async fn closed_fixture(segments: usize) -> (PathBuf, Arc<Permit>, ChildOutputOwner) {
        let (root, permit, owner) = fixture();
        owner.create_in(&root).await.unwrap();
        owner
            .write_complete("index.m3u8", b"manifest".to_vec())
            .await
            .unwrap();
        owner
            .write_complete("init.mp4", b"init".to_vec())
            .await
            .unwrap();
        for index in 0..segments {
            owner
                .write_complete(&format!("s{index:03}.m4s"), vec![index as u8; 65537])
                .await
                .unwrap();
        }
        owner.inspect_after_reap().await.unwrap();
        (root, permit, owner)
    }

    #[tokio::test]
    async fn private_snapshot_fences_complete_batch_twice_and_pins_original_inodes() {
        let (root, permit, owner) = closed_fixture(5).await;
        let before = permit.checks.load(Ordering::SeqCst);
        let snapshot = owner.snapshot_after_reap(None).await.unwrap();
        assert_eq!(
            permit.checks.load(Ordering::SeqCst) - before,
            2,
            "seven resources share exactly one fresh full authority fence on each side"
        );
        assert_eq!(snapshot.resources().len(), 7);
        assert_eq!(
            snapshot.resources()[0],
            ("index.m3u8".into(), b"manifest".to_vec())
        );
        for index in 0..5 {
            assert_eq!(
                snapshot.resources()[index + 2],
                (format!("s{index:03}.m4s"), vec![index as u8; 65537])
            );
        }
        let attempt = root.join(owner.identity().relative_key());
        let original = attempt.join("s004.m4s");
        let retained = root.join("retained-final-segment");
        std::fs::rename(&original, &retained).unwrap();
        std::fs::write(&original, vec![4u8; 65537]).unwrap();
        assert!(
            owner.snapshot_after_reap(None).await.is_err(),
            "an identical-byte final-segment inode replacement cannot be adopted"
        );
        std::fs::remove_file(&original).unwrap();
        std::fs::rename(&retained, &original).unwrap();
        disposed(&owner).await;
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn private_snapshot_refuses_extra_entries_symlinks_and_resource_bound_overflow() {
        use std::os::unix::fs::symlink;
        let (root, _, owner) = closed_fixture(1).await;
        let attempt = root.join(owner.identity().relative_key());
        std::fs::write(attempt.join("extra"), b"unexpected").unwrap();
        assert!(owner.snapshot_after_reap(None).await.is_err());
        std::fs::remove_file(attempt.join("extra")).unwrap();
        let segment = attempt.join("s000.m4s");
        let retained = root.join("original-segment");
        std::fs::rename(&segment, &retained).unwrap();
        symlink(&retained, &segment).unwrap();
        assert!(owner.snapshot_after_reap(None).await.is_err());
        std::fs::remove_file(&segment).unwrap();
        std::fs::rename(&retained, &segment).unwrap();
        std::fs::write(
            attempt.join("index.m3u8"),
            vec![1; super::super::MANIFEST_BYTES + 1],
        )
        .unwrap();
        assert!(
            owner.snapshot_after_reap(None).await.is_err(),
            "manifest resource bound stays strict within the batch"
        );
        std::fs::write(attempt.join("index.m3u8"), b"manifest").unwrap();
        std::fs::write(&segment, vec![2; FILE_BYTES as usize + 1]).unwrap();
        assert!(
            owner.snapshot_after_reap(None).await.is_err(),
            "4 MiB per-resource bound cannot be exceeded"
        );
        std::fs::write(&segment, b"segment").unwrap();
        disposed(&owner).await;
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn private_snapshot_token_cannot_transfer_between_original_owners() {
        let (first_root, _, first) = closed_fixture(1).await;
        let (second_root, _, second) = closed_fixture(1).await;
        let snapshot = first.snapshot_after_reap(None).await.unwrap();
        assert!(second.require_snapshot(&snapshot).is_err());
        first.require_snapshot(&snapshot).unwrap();
        first.cancel();
        assert!(
            first.require_snapshot(&snapshot).is_err(),
            "a completed batch cannot revive cancellation"
        );
        disposed(&first).await;
        disposed(&second).await;
        std::fs::remove_dir(first_root).unwrap();
        std::fs::remove_dir(second_root).unwrap();
    }

    #[tokio::test]
    async fn private_snapshot_rechecks_earlier_resources_after_final_byte() {
        let (root, _, owner) = closed_fixture(1).await;
        owner.snapshot_after_reap(None).await.unwrap();
        let attempt = root.join(owner.identity().relative_key());
        let mut checkpoints = 0;
        let result = owner
            .owner
            .directory
            .lock()
            .unwrap()
            .snapshot(owner.identity(), || {
                checkpoints += 1;
                // Three resources each have entry/read/EOF/post-read checks. The
                // next checkpoint follows the final segment's complete read.
                if checkpoints == 14 {
                    std::fs::write(attempt.join("index.m3u8"), b"mutation").unwrap();
                }
                owner.readonly_live()
            });
        assert!(
            result.is_err(),
            "same-size edit of the first file is observed after reading the last"
        );
        disposed(&owner).await;
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn private_snapshot_post_authority_failure_never_returns_completed_batch() {
        struct RevokingPermit {
            identity: OutputIdentity,
            checks: AtomicUsize,
            fail_at: AtomicUsize,
        }
        impl OutputPermit for RevokingPermit {
            fn identity(&self) -> OutputIdentity {
                self.identity.clone()
            }
            fn check(&self) -> CaptureFuture<'_, ()> {
                Box::pin(async move {
                    let check = self.checks.fetch_add(1, Ordering::SeqCst) + 1;
                    ensure!(
                        check != self.fail_at.load(Ordering::SeqCst),
                        "unit_authority_revoked"
                    );
                    Ok(())
                })
            }
            fn check_write(&self) -> CaptureFuture<'_, ()> {
                self.check()
            }
        }
        let root =
            std::env::temp_dir().join(format!("child-snapshot-revoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let permit = Arc::new(RevokingPermit {
            identity: OutputIdentity::new(
                uuid::Uuid::new_v4().to_string(),
                1,
                uuid::Uuid::new_v4().to_string(),
            )
            .unwrap(),
            checks: AtomicUsize::new(0),
            fail_at: AtomicUsize::new(usize::MAX),
        });
        let owner = ChildOutputOwner::prepare_inner(
            permit.clone(),
            InputOwner::NeverStarted,
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap();
        owner.create_in(&root).await.unwrap();
        for name in ["index.m3u8", "init.mp4", "s000.m4s"] {
            owner
                .write_complete(name, b"custody".to_vec())
                .await
                .unwrap();
        }
        owner.inspect_after_reap().await.unwrap();
        permit
            .fail_at
            .store(permit.checks.load(Ordering::SeqCst) + 2, Ordering::SeqCst);
        assert!(
            owner.snapshot_after_reap(None).await.is_err(),
            "post-batch database revocation withholds the token"
        );
        disposed(&owner).await;
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_private_snapshot_keeps_original_blocking_registration_until_completion() {
        let (root, permit, owner) = closed_fixture(1).await;
        // Hold the actual owner separately: aborting only a waiter must not
        // also drop an encoding-phase owner handle and revoke the blocking read.
        let owner = Arc::new(owner);
        let directory = owner.owner.directory.clone();
        let (release, released) = std::sync::mpsc::channel();
        let (entered, mut began) = watch::channel(false);
        let holder = std::thread::spawn(move || {
            let _directory = directory.lock().unwrap();
            entered.send_replace(true);
            released.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        while !*began.borrow_and_update() {
            began.changed().await.unwrap();
        }
        let before = permit.checks.load(Ordering::SeqCst);
        let retained = owner.clone();
        let snapshot = tokio::spawn(async move { retained.snapshot_after_reap(None).await });
        // The first authority check completes in the same poll that registers
        // blocking work. It then waits on the held original-directory mutex.
        while permit.checks.load(Ordering::SeqCst) == before {
            tokio::task::yield_now().await;
        }
        snapshot.abort();
        match snapshot.await {
            Err(error) => assert!(error.is_cancelled()),
            Ok(_) => panic!("cancelled snapshot waiter unexpectedly completed"),
        }
        owner.readonly_live().unwrap();
        let drain =
            tokio::time::timeout(Duration::from_millis(25), owner.owner.scope.shutdown()).await;
        let proof_before_completion = owner.control().disposal_proof();
        // Release the real mutex holder even if a later assertion fails, so a
        // regression produces the drain assertion rather than a thread panic.
        release.send(()).unwrap();
        holder.join().unwrap();
        disposed(&owner).await;
        std::fs::remove_dir(root).unwrap();
        assert!(
            drain.is_err(),
            "cancelled batch work remains registered in the SAME original output scope"
        );
        assert!(proof_before_completion.is_none());
    }

    #[tokio::test]
    async fn writes_are_exact_named_bounded_and_disposal_is_real() {
        let (root, permit, owner) = fixture();
        owner.create_in(&root).await.unwrap();
        let attempt = root.join(owner.identity().relative_key());
        assert!(attempt.join(OWNER).is_file());
        assert!(owner.create_in(&root).await.is_err());
        assert!(
            owner
                .write_complete("../escape", b"no".to_vec())
                .await
                .is_err()
        );
        assert!(
            owner
                .write_complete("s005.m4s", b"no".to_vec())
                .await
                .is_err()
        );
        assert!(owner.write_complete("owner", b"no".to_vec()).await.is_err());
        assert!(
            owner
                .write_complete("init.mp4", vec![0; FILE_BYTES as usize + 1])
                .await
                .is_err()
        );
        assert!(!attempt.join("init.mp4").exists());
        owner
            .write_complete("init.mp4", vec![1; FILE_BYTES as usize])
            .await
            .unwrap();
        owner
            .write_complete("index.m3u8", b"#EXTM3U\n".to_vec())
            .await
            .unwrap();
        owner.write_complete("s000.m4s", vec![2; 64]).await.unwrap();
        assert!(owner.write_complete("s000.m4s", vec![3]).await.is_err());
        let files = owner.inspect_after_reap().await.unwrap();
        assert_eq!(files.len(), 3);
        assert!(owner.write_complete("s001.m4s", vec![3]).await.is_err());
        let proof = disposed(&owner).await;
        assert_eq!(proof.identity(), owner.identity());
        let original: Arc<dyn OutputPermit> = permit.clone();
        proof.require_original_permit(&original).unwrap();
        let imitation: Arc<dyn OutputPermit> = Arc::new(Permit {
            identity: permit.identity.clone(),
            checks: AtomicUsize::new(0),
        });
        assert!(proof.require_original_permit(&imitation).is_err());
        assert_eq!(
            proof.process_disposition(),
            ProcessDisposition::NeverStarted
        );
        assert!(proof.directory_inode() > 0);
        assert!(!attempt.exists());
        assert!(!root.join(owner.identity().job_id()).exists());
        assert!(permit.checks.load(Ordering::SeqCst) >= 5);
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn aggregate_and_eight_file_bounds_are_prewrite_and_include_marker() {
        let (root, _, owner) = fixture();
        owner.create_in(&root).await.unwrap();
        for name in [
            "init.mp4",
            "index.m3u8",
            "index.m3u8.tmp",
            "s000.m4s",
            "s000.m4s.tmp",
            "s001.m4s",
            "s001.m4s.tmp",
        ] {
            owner
                .write_complete(name, vec![7; FILE_BYTES as usize])
                .await
                .unwrap();
        }
        let remaining = TOTAL_BYTES - 7 * FILE_BYTES - owner.identity().marker().len() as u64;
        assert!(
            owner
                .write_complete("s002.m4s", vec![8; remaining as usize + 1])
                .await
                .is_err()
        );
        let attempt = root.join(owner.identity().relative_key());
        assert!(
            !attempt.join("s002.m4s").exists(),
            "+1 is rejected before file creation"
        );
        owner
            .write_complete("s002.m4s", vec![8; remaining as usize])
            .await
            .unwrap();
        assert!(owner.write_complete("s002.m4s.tmp", vec![9]).await.is_err());
        assert!(
            !attempt.join("s002.m4s.tmp").exists(),
            "ninth payload is never created"
        );
        let disk: u64 = std::fs::read_dir(&attempt)
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert_eq!(disk, TOTAL_BYTES);
        disposed(&owner).await;
        assert!(!attempt.exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn existing_parent_and_symlink_are_never_adopted() {
        use std::os::unix::fs::symlink;
        let (root, _, owner) = fixture();
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"external").unwrap();
        let parent = root.join(owner.identity().job_id());
        symlink(&outside, &parent).unwrap();
        assert!(owner.create_in(&root).await.is_err());
        assert!(owner.close_and_dispose().await.is_err());
        assert!(owner.control().disposal_proof().is_none());
        assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"external");
        std::fs::remove_file(parent).unwrap();
        assert!(
            owner.create_in(&root).await.is_err(),
            "same attempt cannot retry elsewhere"
        );
        std::fs::remove_file(outside.join("keep")).unwrap();
        std::fs::remove_dir(outside).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn replacement_and_unexpected_entries_keep_marker_and_withhold_proof() {
        let (root, _, owner) = fixture();
        owner.create_in(&root).await.unwrap();
        owner
            .write_complete("index.m3u8", b"#EXTM3U\n".to_vec())
            .await
            .unwrap();
        let original = root.join(owner.identity().relative_key());
        let moved = root.join(owner.identity().job_id()).join("moved");
        std::fs::rename(&original, &moved).unwrap();
        std::fs::create_dir(&original).unwrap();
        assert!(owner.close_and_dispose().await.is_err());
        assert!(owner.control().disposal_proof().is_none());
        assert!(moved.join(OWNER).exists());
        assert!(moved.join("index.m3u8").exists());
        std::fs::remove_dir(original).unwrap();
        std::fs::rename(&moved, root.join(owner.identity().relative_key())).unwrap();
        std::fs::write(
            root.join(owner.identity().relative_key()).join("unrelated"),
            b"keep",
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        assert!(owner.control().disposal_proof().is_none());
        assert!(
            root.join(owner.identity().relative_key())
                .join(OWNER)
                .exists()
        );
        std::fs::remove_file(root.join(owner.identity().relative_key()).join("unrelated")).unwrap();
        // Wait for this SAME independent owner's retry, never a reconstructed
        // owner or second scope. The earlier unknown result isn't a receipt.
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if owner.control().disposal_proof().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(!root.join(owner.identity().relative_key()).exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn cancelled_blocking_writer_remains_owned_until_actual_handle_closure() {
        let (root, _, owner) = fixture();
        owner.create_in(&root).await.unwrap();
        let (release, released) = std::sync::mpsc::channel();
        let (entered, mut began) = watch::channel(false);
        let original = owner.owner.clone();
        let scope = original.scope.clone();
        let writer = tokio::spawn(async move {
            scope
                .run(crate::child_process::blocking(move || {
                    let mut directory = original.directory.lock().unwrap();
                    let descriptor = directory.directory.as_ref().unwrap();
                    let mut file = open_at(
                        descriptor,
                        "s000.m4s",
                        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                    )
                    .unwrap();
                    directory.names.insert("s000.m4s".into());
                    drop(directory);
                    entered.send_replace(true);
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    file.write_all(b"late owned writer").unwrap();
                    file.sync_all().unwrap();
                    drop(file);
                }))
                .await
        });
        while !*began.borrow_and_update() {
            began.changed().await.unwrap();
        }
        writer.abort();
        assert!(writer.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(25), owner.close_and_dispose())
                .await
                .is_err()
        );
        assert!(
            root.join(owner.identity().relative_key())
                .join("s000.m4s")
                .exists()
        );
        assert!(owner.control().disposal_proof().is_none());
        release.send(()).unwrap();
        let proof = disposed(&owner).await;
        assert_eq!(proof.identity(), owner.identity());
        assert!(!root.join(owner.identity().relative_key()).exists());
        std::fs::remove_dir(root).unwrap();
    }
}
