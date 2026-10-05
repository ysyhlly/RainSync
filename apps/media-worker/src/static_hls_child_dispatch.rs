//! Private same-startup child operation dispatch, independently closed by default.
//!
//! A signed operation/challenge authenticates the caller, not an encoder or a
//! local owner. Only the opaque installed original-owner executor can enable
//! this dispatcher; selecting it is not media qualification. Query/cancel can
//! still observe or revoke an already retained original child. Neither SQL nor
//! a UUID can replace missing local custody, and a queue receipt is never ready
//! output. Publication work/unknown receipts survive the HTTP waiter's loss.
#![allow(dead_code)]

use super::{
    App,
    static_hls_child_encoder::InstalledRuntime,
    static_hls_child_registry::{self as child, HeldChildCapture, Status},
    static_hls_operation::Registry as ParentRegistry,
};
use aes_gcm::aead::Aead;
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, OperationKind},
    operation::{Action, OperationResult, PendingStage, Reason},
    worker::WorkerStatement,
};
use persistence::{
    static_hls_activation::{
        CHILD_RUNTIME_PROFILE, CHILD_RUNTIME_VERSION, ChildRuntimeContract, WorkerContract,
    },
    static_hls_child_claim::PreparedChildInput,
    static_hls_child_publication::{self as publication, ChildPublication, Publication},
    static_hls_pending::{self as pending, CatalogSnapshot, LoadedOperation},
};
use serde::Deserialize;
use sqlx::{Connection, Row};
use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

const MAX_PUBLICATIONS: usize = 4096;
const CLAIM_READ_TIME: Duration = Duration::from_millis(750);
const RECEIPT_RECHECK: Duration = Duration::from_millis(100);

#[derive(Clone, Default)]
pub(super) struct Registry(Arc<Owners>);

#[derive(Default)]
struct Owners {
    // A real in-process original-owner registry, bound to this App startup,
    // database, cipher and cache. Wire/configuration cannot construct it.
    runtime: Option<InstalledRuntime>,
    accepting: AtomicBool,
    publications: Mutex<HashMap<Uuid, Arc<PublicationEntry>>>,
}

struct PublicationEntry {
    // Keep original receipt/custody even if every App/HTTP waiter disappears.
    // Entries are bounded and are never pruned on an unknown acknowledgement.
    _registry_keepalive: Arc<Owners>,
    held: HeldChildCapture,
    cancelled: AtomicBool,
    state: Mutex<PublicationState>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    // Install the exact generated reply BEFORE the publication COMMIT await.
    // It may be used only for exact same-owner SQL observation, never retrying
    // publication with another token or treating an unknown result as success.
    original_reply: OnceLock<String>,
    // Registration, never a media/output proof. The actual encoder registry
    // retains every original attempt and refuses duplicate execution.
    encoder_started: OnceLock<()>,
    encoder_registration: Mutex<()>,
}

#[derive(Clone, Copy)]
enum PublicationState {
    Working,
    Committed,
    Full,
    Stale,
    Unknown,
}

impl Registry {
    /// Selection is an activation request only. The opaque capability retains
    /// the actual compiled encoder registry; it proves no request's media,
    /// capture custody, recipe, job authority or validated output.
    pub(super) fn installed(runtime: InstalledRuntime) -> Result<Self> {
        ensure!(
            runtime.accepting(),
            "static_hls_child_execution_unavailable"
        );
        ensure!(
            (1..=10000).contains(&runtime.queue_limit()),
            "invalid_queue_limit"
        );
        Ok(Self(Arc::new(Owners {
            runtime: Some(runtime),
            ..Owners::default()
        })))
    }

    /// Only the authenticated shared-cache/DB probe may expose this closed
    /// declaration. It remains compatibility, not a capture or output witness.
    /// The compiled dedicated child GET/HEAD route reads only PublishedChildOutput
    /// retained by this SAME encoder registry; there is no separately installed
    /// reader, filesystem adoption or generic route capability behind child_read.
    /// Main opens child custody before this dispatcher and closes us first.
    pub(super) fn child_contract(
        &self,
        app: &App,
        worker: &WorkerContract,
    ) -> Result<Option<ChildRuntimeContract>> {
        let Some(runtime) = self.0.runtime.as_ref() else {
            return Ok(None);
        };
        if !self.mutation_enabled() {
            return Ok(None);
        }
        ensure!(
            runtime.matches_app(app),
            "static_hls_child_runtime_binding_changed"
        );
        ensure!(
            worker.instance == *super::static_hls_contract::INSTANCE
                && worker.database == runtime.database(),
            "static_hls_child_runtime_binding_changed"
        );
        let contract = ChildRuntimeContract {
            version: CHILD_RUNTIME_VERSION,
            reader_version: 2,
            recipe_version: 1,
            input_version: 1,
            graph_version: 1,
            output_version: 1,
            profile: CHILD_RUNTIME_PROFILE.into(),
            instance: worker.instance,
            database: runtime.database(),
            challenge: worker.challenge,
            cache_identity: worker.cache_identity.clone(),
            tasks: ["child_encode".into(), "child_read".into()],
        };
        contract.require_binding(worker)?;
        Ok(self.mutation_enabled().then_some(contract))
    }

    pub(super) fn open(&self) {
        self.0.accepting.store(true, Ordering::SeqCst);
    }

    pub(super) async fn close(&self) {
        self.0.accepting.store(false, Ordering::SeqCst);
        let entries: Vec<_> = self.0.publications.lock().await.values().cloned().collect();
        for entry in entries {
            entry.cancelled.store(true, Ordering::SeqCst);
            if let Ok(control) = entry.held.capture().control() {
                // Revoke only the actual original child owner. A pending SQL
                // publisher must observe its same witness's stop before its
                // final synchronous COMMIT fence, independently of shutdown
                // ordering in the App coordinator.
                control.cancel();
            }
            // Seal registration. Do not abort an uncertain SQL publication or
            // drop its original child owner; the child registry drains owners.
            let _registration = entry.task.lock().await;
            let _encoder_registration = entry.encoder_registration.lock().await;
            if let Some(runtime) = self.0.runtime.as_ref() {
                let _ = runtime.cancel(entry.held.input());
            }
        }
    }

    pub(super) async fn drain(&self) {
        let entries: Vec<_> = self.0.publications.lock().await.values().cloned().collect();
        for entry in entries {
            if let Some(task) = entry.task.lock().await.take()
                && task.await.is_err()
            {
                *entry.state.lock().await = PublicationState::Unknown;
            }
        }
    }

    /// Called only after the existing authenticated, consumed one-use cache/DB
    /// challenge boundary. Child publication has its own closed wire purpose.
    pub(super) async fn dispatch(
        &self,
        parents: &ParentRegistry,
        children: &child::Registry,
        app: &App,
        loaded: &LoadedOperation,
        action: Action,
        rpc_until: u64,
    ) -> Result<OperationResult> {
        require_child(loaded)?;
        if let Some(runtime) = self.0.runtime.as_ref() {
            ensure!(
                runtime.matches_app(app),
                "static_hls_child_runtime_binding_changed"
            );
        }
        match action {
            Action::Create | Action::PublishChild if !self.mutation_enabled() => {
                // This must precede lineage IO, parent-control lookup/cancel,
                // token generation, admission or publication registration.
                // A disabled dispatcher also cannot assert non-admission of
                // an operation another retained owner may already hold.
                Ok(unknown(
                    loaded.current_identity.operation_id.clone(),
                    Reason::UnsupportedInput,
                ))
            }
            Action::Create => {
                require_pending(loaded, rpc_until)?;
                let observed_status = children.query(&loaded.input).await?;
                if observed_status != Status::LocalOwnerMissing {
                    return self.observe(app, children, loaded, observed_status).await;
                }
                let lineage = load_claimed_lineage(app, loaded).await?;
                let observed = self.worker_statement(&loaded.input)?;
                let control = parents.parent_control_for_child(&lineage.parent).await?;
                // A stopped/positively disposed actual parent is permitted.
                // Missing retained control remains missing, never SQL-adopted.
                require_pending(loaded, rpc_until)?;
                ensure!(self.mutation_enabled(), "static_hls_child_dispatch_closed");
                control.cancel();
                let status = children
                    .create_owned(
                        app,
                        child::Create {
                            prepared: &lineage.prepared,
                            parent: lineage.parent,
                            root: lineage.root,
                            parent_control: control,
                            observed: Some(&observed),
                            accept_until_ms: rpc_until,
                        },
                    )
                    .await?;
                self.observe(app, children, loaded, status).await
            }
            Action::Query => {
                let status = children.query(&loaded.input).await?;
                // Only the original uncertain admission token can recover.
                // This does not re-admit or install a renewed work deadline.
                let status = if matches!(status, Status::CommitUnknown) {
                    children.recover_original(app, &loaded.input).await?
                } else {
                    status
                };
                self.observe(app, children, loaded, status).await
            }
            Action::Cancel => {
                if let Some(entry) = self.publication_entry(&loaded.input).await? {
                    entry.cancelled.store(true, Ordering::SeqCst);
                    let _registration = entry.encoder_registration.lock().await;
                    if let Some(runtime) = self.0.runtime.as_ref() {
                        runtime.cancel(&loaded.input)?;
                    }
                } else if let Some(runtime) = self.0.runtime.as_ref() {
                    runtime.cancel(&loaded.input)?;
                }
                let status = children.cancel(app, &loaded.input).await?;
                self.observe(app, children, loaded, status).await
            }
            Action::PublishChild => {
                if self.publication_entry(&loaded.input).await?.is_some() {
                    let status = children.query(&loaded.input).await?;
                    return self.observe(app, children, loaded, status).await;
                }
                require_pending(loaded, rpc_until)?;
                let status = children.query(&loaded.input).await?;
                if !matches!(status, Status::Verified { .. }) {
                    return self.observe(app, children, loaded, status).await;
                }
                let held = children.original_capture(&loaded.input).await?;
                held.input().require_same_frozen_input(&loaded.input)?;
                held.check().await?;
                require_pending(loaded, rpc_until)?;
                let observed = self.worker_statement(held.input())?;
                self.start_publication(app, children, held, observed, rpc_until)
                    .await?;
                // Completion is observed on a fresh subsequent operation. An
                // earlier pending authority sample cannot claim a queue grant.
                Ok(OperationResult::Pending {
                    capture_id: loaded.current_identity.operation_id.clone(),
                    stage: PendingStage::Publish,
                })
            }
            Action::Publish => Ok(unknown(
                loaded.current_identity.operation_id.clone(),
                Reason::UnsupportedInput,
            )),
        }
    }

    fn mutation_enabled(&self) -> bool {
        self.0.accepting.load(Ordering::SeqCst)
            && self
                .0
                .runtime
                .as_ref()
                .is_some_and(InstalledRuntime::accepting)
    }

    fn worker_statement(&self, input: &FrozenInput) -> Result<WorkerStatement> {
        ensure!(
            self.mutation_enabled(),
            "static_hls_child_execution_unavailable"
        );
        self.0
            .runtime
            .as_ref()
            .context("static_hls_child_execution_unavailable")?
            .worker_statement(input)
    }

    async fn start_publication(
        &self,
        app: &App,
        children: &child::Registry,
        held: HeldChildCapture,
        observed: WorkerStatement,
        rpc_until: u64,
    ) -> Result<()> {
        let operation = Uuid::parse_str(&held.input().identity_statement().operation_id)?;
        let mut entries = self.0.publications.lock().await;
        if let Some(entry) = entries.get(&operation) {
            entry.held.input().require_same_frozen_input(held.input())?;
            return Ok(());
        }
        ensure!(self.mutation_enabled(), "static_hls_child_dispatch_closed");
        ensure!(
            entries.len() < MAX_PUBLICATIONS,
            "static_hls_child_publication_capacity"
        );
        ensure!(now_ms()? < rpc_until, "static_hls_child_acceptance_expired");
        let entry = Arc::new(PublicationEntry {
            _registry_keepalive: self.0.clone(),
            held,
            cancelled: AtomicBool::new(false),
            state: Mutex::new(PublicationState::Working),
            task: Mutex::new(None),
            original_reply: OnceLock::new(),
            encoder_started: OnceLock::new(),
            encoder_registration: Mutex::new(()),
        });
        entries.insert(operation, entry.clone());
        // Original retention and registration precede the first publication
        // await. This task is not owned by or aborted with an HTTP waiter.
        let mut registration = entry.task.lock().await;
        let own = entry.clone();
        let registry = self.clone();
        let app = app.clone();
        let children = children.clone();
        *registration = Some(tokio::spawn(async move {
            let began = std::time::Instant::now();
            let outcome = publish_original(&registry, &app, &own, &observed, rpc_until).await;
            if let Err(error) = &outcome {
                tracing::warn!(error = %error, elapsed_ms = began.elapsed().as_millis(), "static_hls_child_publication_unconfirmed");
            }
            if let Ok(Publication::Published { response_encrypted }) = &outcome {
                tracing::info!(
                    reply_matches = own.original_reply.get() == Some(response_encrypted),
                    "static_hls_child_publication_committed"
                );
            }
            let state = match outcome {
                Ok(Publication::Published { response_encrypted })
                    if own.original_reply.get() == Some(&response_encrypted) =>
                {
                    PublicationState::Committed
                }
                Ok(Publication::Full) => PublicationState::Full,
                Ok(Publication::Stale) => PublicationState::Stale,
                _ => PublicationState::Unknown,
            };
            *own.state.lock().await = state;
            if matches!(state, PublicationState::Committed) {
                // The retained publication task owns this hand-off. No HTTP
                // acknowledgement or renewed request deadline can own the job.
                if let Err(error) = registry.start_encoder_once(&app, &children, &own).await {
                    tracing::warn!(error = %error, "static_hls_child_encoder_handoff_unconfirmed");
                    registry.recover_queued_encoder(&app, &children, &own).await;
                }
            } else if matches!(state, PublicationState::Unknown) {
                // Only observe this exact original reply. Never republish or
                // create another token, attempt, capture or preparation budget.
                registry.recover_queued_encoder(&app, &children, &own).await;
            }
        }));
        Ok(())
    }

    async fn start_encoder_once(
        &self,
        app: &App,
        children: &child::Registry,
        entry: &PublicationEntry,
    ) -> Result<()> {
        let _registration = entry.encoder_registration.lock().await;
        if entry.encoder_started.get().is_some() {
            return Ok(());
        }
        require_publication_active(self, entry)?;
        let runtime = self
            .0
            .runtime
            .as_ref()
            .context("static_hls_child_execution_unavailable")?;
        ensure!(
            runtime.matches_app(app),
            "static_hls_child_runtime_binding_changed"
        );
        // This returns the same retained registry entry/snapshot/permit, never
        // adopts a row, path or UUID as local custody.
        let held = children.original_capture(entry.held.input()).await?;
        held.input().require_same_frozen_input(entry.held.input())?;
        let observed = runtime.worker_statement(held.input())?;
        require_publication_active(self, entry)?;
        runtime.start_owned(app, held, observed)?;
        entry
            .encoder_started
            .set(())
            .map_err(|_| anyhow::anyhow!("static_hls_child_encoder_registration_changed"))?;
        Ok(())
    }

    async fn recover_queued_encoder(
        &self,
        app: &App,
        children: &child::Registry,
        entry: &PublicationEntry,
    ) {
        let identity = entry.held.input().identity_statement();
        let (Ok(operation), Ok(session)) = (
            Uuid::parse_str(&identity.operation_id),
            Uuid::parse_str(&identity.session_id),
        ) else {
            return;
        };
        loop {
            if require_publication_active(self, entry).is_err()
                || entry.encoder_started.get().is_some()
                || entry.original_reply.get().is_none()
            {
                return;
            }
            let loaded = tokio::time::timeout(
                CLAIM_READ_TIME,
                pending::load_operation(&app.db, operation, session, |cipher| {
                    open_storage(app, cipher, 65536)
                }),
            )
            .await;
            if let Ok(Ok(Some(loaded))) = loaded
                && queued_original(app, &loaded, entry)
                    .await
                    .is_ok_and(|reply| reply.is_some())
            {
                *entry.state.lock().await = PublicationState::Committed;
                if self.start_encoder_once(app, children, entry).await.is_ok() {
                    return;
                }
            }
            tokio::time::sleep_until(
                (Instant::now() + RECEIPT_RECHECK)
                    .min(entry.held.preparation_until())
                    .min(entry.held.root_until()),
            )
            .await;
        }
    }

    async fn publication_entry(
        &self,
        input: &FrozenInput,
    ) -> Result<Option<Arc<PublicationEntry>>> {
        let operation = Uuid::parse_str(&input.identity_statement().operation_id)?;
        let entry = self.0.publications.lock().await.get(&operation).cloned();
        if let Some(entry) = &entry {
            entry.held.input().require_same_frozen_input(input)?;
        }
        Ok(entry)
    }

    async fn observe(
        &self,
        app: &App,
        children: &child::Registry,
        loaded: &LoadedOperation,
        status: Status,
    ) -> Result<OperationResult> {
        let capture = loaded.current_identity.operation_id.clone();
        // A fast encoder may have positively disposed its input before this
        // RPC observes the immutable queue receipt. Resolve that SAME retained
        // publication first; input disposal does not undo successful output.
        if let Some(entry) = self.publication_entry(&loaded.input).await?
            && !entry.cancelled.load(Ordering::SeqCst)
        {
            let publication = reap_publication(&entry).await;
            if matches!(publication, PublicationState::Committed) && loaded.publication_pending {
                // The original retained task confirmed COMMIT after this RPC's
                // pending authority read. Ask for a fresh observation of the
                // same operation; never project that earlier sample as a
                // committed receipt or discard the positive original owner.
                return Ok(OperationResult::Pending {
                    capture_id: capture,
                    stage: PendingStage::Publish,
                });
            }
            if !matches!(
                publication,
                PublicationState::Working | PublicationState::Full | PublicationState::Stale
            ) && let Some(queued) = queued_original(app, loaded, &entry).await?
            {
                // Receipt survives successful input disposal. The registration
                // latch prevents this query from attempting to restart that job.
                let _ = self.start_encoder_once(app, children, &entry).await;
                return Ok(queued);
            }
        }
        match status {
            Status::Disposed => disposed_result(app, &loaded.input).await,
            Status::CancelRequested { .. } => Ok(OperationResult::CancelRequested {
                capture_id: capture,
            }),
            Status::Verified {
                root_digest,
                verified_at_ms,
                selected_audio,
            } => {
                let Some(entry) = self.publication_entry(&loaded.input).await? else {
                    return Ok(OperationResult::Verified {
                        capture_id: capture,
                        root_digest,
                        verified_at_ms,
                        selected_audio,
                    });
                };
                let state = reap_publication(&entry).await;
                if entry.cancelled.load(Ordering::SeqCst) {
                    return Ok(OperationResult::CancelRequested {
                        capture_id: capture,
                    });
                }
                if matches!(state, PublicationState::Full) {
                    // Capture custody still exists. A queue-capacity refusal
                    // must not claim that no capture was admitted.
                    return Ok(unknown(capture, Reason::Capacity));
                }
                if matches!(state, PublicationState::Stale) {
                    return Ok(unknown(capture, Reason::AuthorityRevoked));
                }
                if matches!(state, PublicationState::Working) {
                    return Ok(OperationResult::Pending {
                        capture_id: capture,
                        stage: PendingStage::Publish,
                    });
                }
                // Unknown is not success. Only a new exact immutable tuple
                // observation, with this original held child still live, can
                // positively resolve a previously lost COMMIT acknowledgement.
                match queued_original(app, loaded, &entry).await {
                    Ok(Some(result)) => {
                        let _ = self.start_encoder_once(app, children, &entry).await;
                        Ok(result)
                    }
                    Ok(None) => Ok(unknown(capture, Reason::Unavailable)),
                    Err(error) => {
                        tracing::warn!(error = %error, "static_hls_child_queue_receipt_unconfirmed");
                        Ok(unknown(capture, Reason::Unavailable))
                    }
                }
            }
            other => Ok(project_status(&capture, other)),
        }
    }
}

async fn reap_publication(entry: &PublicationEntry) -> PublicationState {
    let mut registration = entry.task.lock().await;
    if registration
        .as_ref()
        .is_some_and(tokio::task::JoinHandle::is_finished)
        && let Some(task) = registration.take()
        && task.await.is_err()
    {
        *entry.state.lock().await = PublicationState::Unknown;
    }
    *entry.state.lock().await
}

async fn publish_original(
    registry: &Registry,
    app: &App,
    entry: &PublicationEntry,
    observed: &WorkerStatement,
    rpc_until: u64,
) -> Result<Publication> {
    require_publication_active(registry, entry)?;
    ensure!(now_ms()? < rpc_until, "static_hls_child_acceptance_expired");
    entry.held.check().await?;
    let witness = entry.held.capture().prepare_publication().await?;
    require_publication_active(registry, entry)?;
    // The RPC deadline bounds acceptance only. This task was retained and
    // accepted before source work. A slow full-graph revalidation does not undo
    // that acceptance; the SAME original child prepare/root fences still bound
    // this witness, publication and every subsequent authority observation.
    // Uncertain publication never creates a new task, token or attempt.
    let prepared = ChildPublication::prepare(
        entry.held.input(),
        entry.held.parent_input(),
        entry.held.root_statement(),
        &witness,
        Some(observed),
        |plain| seal_storage(app, plain),
        |plain| {
            let encrypted = seal_storage(app, plain)?;
            ensure!(encrypted.len() <= 2048, "static_hls_child_reply_bounds");
            entry
                .original_reply
                .set(encrypted.clone())
                .map_err(|_| anyhow::anyhow!("static_hls_original_child_reply_replaced"))?;
            Ok(encrypted)
        },
    )
    .await?;
    entry.held.check().await?;
    require_publication_active(registry, entry)?;
    let runtime = registry
        .0
        .runtime
        .as_ref()
        .context("static_hls_child_execution_unavailable")?;
    ensure!(
        runtime.matches_app(app),
        "static_hls_child_runtime_binding_changed"
    );
    publication::publish_child(&app.db, prepared, runtime.queue_limit()).await
}

fn require_publication_active(registry: &Registry, entry: &PublicationEntry) -> Result<()> {
    ensure!(
        registry.mutation_enabled() && !entry.cancelled.load(Ordering::SeqCst),
        "static_hls_child_publication_closed"
    );
    require_held_fences(&entry.held)
}

fn require_held_fences(held: &HeldChildCapture) -> Result<()> {
    let now = Instant::now();
    ensure!(
        now < held.preparation_until() && now < held.root_until(),
        "static_hls_child_preparation_expired"
    );
    Ok(())
}

async fn queued_original(
    app: &App,
    loaded: &LoadedOperation,
    entry: &PublicationEntry,
) -> Result<Option<OperationResult>> {
    let Some(reply) = entry.original_reply.get() else {
        return Ok(None);
    };
    // The outer response authority must itself have observed a completed live
    // child. A earlier pending sample cannot be promoted by an internal result.
    if loaded.publication_pending || !loaded.publication_authority_live {
        tracing::info!(
            pending = loaded.publication_pending,
            live = loaded.publication_authority_live,
            "static_hls_child_queue_observation_unavailable"
        );
        return Ok(None);
    }
    entry
        .held
        .input()
        .require_same_frozen_input(&loaded.input)?;
    loaded
        .input
        .require_identity_statement(&loaded.current_identity)?;
    // This is a receipt observation, not an input read. Its complete current
    // committed metadata below survives positive input disposal after success.
    require_held_fences(&entry.held)?;
    let began = Instant::now();
    let Some(metadata) = publication::published_child_queued_plan_metadata(
        &app.db,
        entry.held.input(),
        entry.held.parent_input(),
        entry.held.root_statement(),
        reply,
    )
    .await?
    else {
        return Ok(None);
    };
    let elapsed = u64::try_from(began.elapsed().as_millis())?;
    let child = entry.held.input();
    ensure!(
        metadata.root_digest == entry.held.root_statement().root_digest()
            && metadata.prepare_expires_at_ms == child.preparation_deadline_ms()
            && metadata.expires_at_ms <= child.root_deadline_ms()
            && metadata.pending_job_id == Uuid::parse_str(&loaded.current_identity.session_id)?
            && metadata.published_at_ms < child.preparation_deadline_ms()
            && metadata.published_at_ms < child.root_deadline_ms()
            && metadata.observed_at_ms <= now_ms()?
            && metadata
                .expires_at_ms
                .saturating_sub(metadata.observed_at_ms)
                > elapsed
            && metadata
                .prepare_expires_at_ms
                .saturating_sub(metadata.observed_at_ms)
                > elapsed
            && metadata
                .pending_lease_expires_at_ms
                .saturating_sub(metadata.observed_at_ms)
                > elapsed,
        "static_hls_child_queued_binding_changed"
    );
    let graph = RootGraphStatement::parse_private_plaintext(&open_storage(
        app,
        &metadata.inventory_encrypted,
        262144,
    )?)?;
    entry
        .held
        .root_statement()
        .require_child_recapture(&graph, child)?;
    require_held_fences(&entry.held)?;
    ensure!(
        !entry.cancelled.load(Ordering::SeqCst),
        "static_hls_child_cancelled"
    );
    Ok(Some(OperationResult::ChildQueued {
        capture_id: loaded.current_identity.operation_id.clone(),
        root_digest: metadata.root_digest,
        queued_at_ms: metadata.published_at_ms,
        selected_audio: entry.held.root_statement().selected_audio_statement(),
        reply_encrypted: reply.clone(),
    }))
}

fn require_child(loaded: &LoadedOperation) -> Result<()> {
    ensure!(
        loaded.input.kind() == OperationKind::Child,
        "static_hls_child_input_required"
    );
    loaded
        .input
        .require_identity_statement(&loaded.current_identity)?;
    ensure!(
        Uuid::parse_str(&loaded.current_identity.worker_instance)?
            == *super::static_hls_contract::INSTANCE,
        "static_hls_worker_changed"
    );
    Ok(())
}

fn require_pending(loaded: &LoadedOperation, rpc_until: u64) -> Result<()> {
    let now = now_ms()?;
    ensure!(
        loaded.publication_pending
            && loaded.current_authority_live
            && loaded.observed_at_ms <= now
            && now < loaded.pending_lease_expires_at_ms
            && now < loaded.input.preparation_deadline_ms()
            && now < loaded.input.root_deadline_ms()
            && now < rpc_until,
        "static_hls_child_authority_revoked"
    );
    Ok(())
}

struct ClaimedLineage {
    prepared: PreparedChildInput,
    parent: FrozenInput,
    root: Arc<RootGraphStatement>,
}

#[derive(Deserialize)]
struct InputProjection {
    root: RootProjection,
}
#[derive(Deserialize)]
struct RootProjection {
    parent_capture_id: Uuid,
    parent_session_id: Uuid,
    parent_input_sha256: String,
    root_digest: String,
}

async fn load_claimed_lineage(app: &App, loaded: &LoadedOperation) -> Result<ClaimedLineage> {
    let projection: InputProjection =
        serde_json::from_slice(loaded.input.private_storage_plaintext())?;
    let i = &loaded.current_identity;
    let until = Instant::now() + CLAIM_READ_TIME;
    let row = tokio::time::timeout_at(until, async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        sqlx::query("SELECT set_config('rainsync.static_hls_reader','2',true),set_config('rainsync.static_hls_pending_recipe','1',true)")
            .execute(&mut *tx).await?;
        sqlx::query("SET LOCAL statement_timeout='750ms'").execute(&mut *tx).await?;
        let row = sqlx::query(CLAIMED_LINEAGE)
            .bind(Uuid::parse_str(&i.session_id)?)
            .bind(Uuid::parse_str(&i.operation_id)?)
            .bind(loaded.input.input_sha256())
            .bind(projection.root.parent_capture_id)
            .bind(Uuid::parse_str(&i.worker_instance)?)
            .bind(Uuid::parse_str(&i.database)?)
            .bind(Uuid::parse_str(&i.user_id)?)
            .bind(&i.auth_login_hash)
            .bind(projection.root.parent_session_id)
            .bind(&projection.root.parent_input_sha256)
            .bind(&projection.root.root_digest)
            .fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok::<_, anyhow::Error>(row)
    })
    .await.context("static_hls_child_lineage_unknown")??;
    ensure!(Instant::now() < until, "static_hls_child_lineage_unknown");
    let child_cipher: String = row.try_get("child_input_encrypted")?;
    let from_storage =
        FrozenInput::parse_private_plaintext(&open_storage(app, &child_cipher, 65536)?)?;
    loaded.input.require_same_frozen_input(&from_storage)?;
    // Reuse the existing loader's complete immutable identity/clock checks;
    // the failed/stopped parent supplies historical lineage, never live grant.
    let parent = pending::load_operation(
        &app.db,
        projection.root.parent_capture_id,
        projection.root.parent_session_id,
        |cipher| open_storage(app, cipher, 65536),
    )
    .await?
    .context("static_hls_child_parent_missing")?
    .input;
    ensure!(
        parent.kind() == OperationKind::Parent
            && parent.input_sha256() == projection.root.parent_input_sha256,
        "static_hls_child_parent_changed"
    );
    let graph_cipher: String = row.try_get("inventory_encrypted")?;
    let root = Arc::new(RootGraphStatement::parse_private_plaintext(&open_storage(
        app,
        &graph_cipher,
        262144,
    )?)?);
    ensure!(
        root.root_digest() == projection.root.root_digest,
        "static_hls_child_root_changed"
    );
    root.require_parent_input(&parent)?;
    loaded
        .input
        .require_child_of(&parent, root.root_digest(), root.selected_audio_statement())?;
    let prepared = PreparedChildInput::seal(
        loaded.input.clone(),
        parent.clone(),
        &root,
        CatalogSnapshot::from_row(&row),
        |_| Ok(child_cipher),
    )?;
    Ok(ClaimedLineage {
        prepared,
        parent,
        root,
    })
}

// Observe the durable one-shot claim before canceling the actual retained
// parent. Positive parent disposal is intentionally left to child admission.
const CLAIMED_LINEAGE: &str = r#"
SELECT r.static_hls_input_encrypted AS child_input_encrypted,c.inventory_encrypted,
 m.id AS media_id,m.source_id,m.resource,m.source_version,m.preview_generation,
 s.kind,s.config_encrypted,s.access_policy_revision
FROM playback_requests r JOIN static_hls_captures c ON c.id=r.static_hls_parent_capture_id
 JOIN playback_requests original ON original.session_id=c.session_id
 JOIN playback_sessions retired ON retired.id=c.session_id
 JOIN static_hls_database_binding db ON db.singleton
 JOIN media_items m ON m.id=r.static_hls_media_id AND m.source_id=r.static_hls_source_id
 JOIN sources s ON s.id=m.source_id
WHERE r.session_id=$1 AND r.static_hls_operation_id=$2 AND r.static_hls_input_sha256=$3
 AND r.static_hls_parent_capture_id=$4 AND r.static_hls_worker_instance=$5
 AND r.static_hls_database_id=$6 AND db.id=$6 AND r.user_id=$7 AND r.auth_login_hash=$8
 AND r.static_hls_input_version=1 AND r.status='pending' AND r.response_encrypted IS NULL
 AND r.http_file_context_encrypted IS NULL AND r.http_file_parent IS NULL
 AND static_hls_pending_request_authority_allowed(r.session_id)
 AND c.id=$4 AND c.session_id=$9 AND c.input_sha256=$10 AND c.root_digest=$11
 AND c.user_id=r.user_id AND c.worker_instance=$5 AND c.database_id=$6
 AND c.reader_version=2 AND c.recipe_version=1 AND c.publication_phase='published_parent'
 AND c.state IN ('verified','cancelled','disposed') AND c.inventory_encrypted IS NOT NULL
 AND c.expires_at=r.static_hls_root_expires_at
 AND original.static_hls_input_version=1 AND original.static_hls_parent_capture_id IS NULL
 AND original.static_hls_operation_id=c.id AND original.static_hls_input_sha256=c.input_sha256
 AND original.owner_epoch=c.request_owner_epoch AND original.status='failed'
 AND original.response_encrypted IS NULL AND original.error_status=409
 AND original.error_code='static_hls_parent_claimed'
 AND original.http_file_context_encrypted IS NULL AND original.http_file_parent IS NULL
 AND retired.stopped AND retired.static_hls_capture_id=c.id
 AND ROW(r.user_id,r.room_id,r.lifecycle_epoch,r.auth_login_hash,r.auth_membership_epoch,
         r.viewer_id,r.static_hls_media_id,r.static_hls_media_generation,r.static_hls_source_id,
         r.static_hls_source_revision,r.static_hls_source_generation,r.static_hls_worker_instance,r.static_hls_database_id)
     IS NOT DISTINCT FROM
     ROW(original.user_id,original.room_id,original.lifecycle_epoch,original.auth_login_hash,
         original.auth_membership_epoch,original.viewer_id,original.static_hls_media_id,
         original.static_hls_media_generation,original.static_hls_source_id,original.static_hls_source_revision,
         original.static_hls_source_generation,original.static_hls_worker_instance,original.static_hls_database_id)
 AND r.plan_generation>original.plan_generation
 AND m.available AND s.kind='http' AND s.access_policy_revision=r.static_hls_source_revision
 AND m.preview_generation=r.static_hls_source_generation
"#;

async fn disposed_result(app: &App, input: &FrozenInput) -> Result<OperationResult> {
    let identity = input.identity_statement();
    let at: Option<i64> = sqlx::query_scalar(
        "SELECT floor(extract(epoch FROM disposed_at)*1000)::bigint FROM static_hls_captures WHERE id=$1 AND session_id=$2 AND input_sha256=$3 AND worker_instance=$4 AND database_id=$5 AND publication_phase IN ('pending_child','published_child') AND state='disposed' AND disposed_at IS NOT NULL AND streams_closed_at IS NOT NULL AND process_closed_at IS NOT NULL AND files_removed_at IS NOT NULL AND process_disposition IN ('never_started','reaped')",
    )
    .bind(Uuid::parse_str(&identity.operation_id)?)
    .bind(Uuid::parse_str(&identity.session_id)?)
    .bind(input.input_sha256())
    .bind(Uuid::parse_str(&identity.worker_instance)?)
    .bind(Uuid::parse_str(&identity.database)?)
    .fetch_optional(&app.db).await?;
    match at {
        Some(at) if u64::try_from(at).is_ok_and(|at| at <= now_ms().unwrap_or(0)) => {
            Ok(OperationResult::Disposed {
                capture_id: identity.operation_id,
                disposed_at_ms: u64::try_from(at)?,
            })
        }
        _ => Ok(unknown(identity.operation_id, Reason::Unavailable)),
    }
}

fn project_status(capture: &str, status: Status) -> OperationResult {
    match status {
        Status::WaitingParent { .. } => OperationResult::Pending {
            capture_id: capture.into(),
            stage: PendingStage::Drain,
        },
        Status::Capturing => OperationResult::Pending {
            capture_id: capture.into(),
            stage: PendingStage::Capture,
        },
        Status::CommitUnknown | Status::Recovering => unknown(capture.into(), Reason::Unavailable),
        Status::LocalOwnerMissing => unknown(capture.into(), Reason::LocalOwnerMissing),
        Status::CancelRequested { .. } | Status::Refused(child::Refusal::Cancelled) => {
            OperationResult::CancelRequested {
                capture_id: capture.into(),
            }
        }
        Status::Refused(child::Refusal::Capacity | child::Refusal::AdmissionChanged) => {
            OperationResult::Refused {
                capture_id: None,
                reason: Reason::Capacity,
            }
        }
        Status::Refused(child::Refusal::AdmissionNotCommitted) => OperationResult::Refused {
            capture_id: None,
            reason: Reason::Unavailable,
        },
        Status::Refused(child::Refusal::PreparationExpired) => {
            unknown(capture.into(), Reason::Deadline)
        }
        Status::Refused(child::Refusal::AuthorityRevoked) => {
            unknown(capture.into(), Reason::AuthorityRevoked)
        }
        Status::Refused(child::Refusal::RetainedCustody) => {
            unknown(capture.into(), Reason::LocalOwnerMissing)
        }
        Status::Refused(child::Refusal::CaptureUnconfirmed | child::Refusal::Unavailable)
        | Status::Disposed
        | Status::Verified { .. } => unknown(capture.into(), Reason::Unavailable),
    }
}

fn unknown(capture: String, reason: Reason) -> OperationResult {
    OperationResult::Unknown {
        capture_id: Some(capture),
        reason,
    }
}

fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}

fn open_storage(app: &App, cipher: &str, maximum: usize) -> Result<Vec<u8>> {
    ensure!(
        !cipher.is_empty() && cipher.len() <= maximum,
        "static_hls_child_cipher_bounds"
    );
    let bytes = STANDARD.decode(cipher)?;
    ensure!(bytes.len() >= 28, "static_hls_child_cipher_bounds");
    app.key
        .decrypt((&bytes[..12]).into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("static_hls_child_cipher_authentication"))
}

fn seal_storage(app: &App, plain: &[u8]) -> Result<String> {
    let random = Uuid::new_v4();
    let bytes = random.as_bytes();
    let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| bytes[i]);
    let encrypted = app
        .key
        .encrypt((&nonce).into(), plain)
        .map_err(|_| anyhow::anyhow!("static_hls_child_cipher_authentication"))?;
    Ok(STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_core::static_hls::DisposalState;

    #[test]
    fn ordinary_open_does_not_advertise_or_enable_child_execution() {
        let registry = Registry::default();
        registry.open();
        assert!(!registry.mutation_enabled());
        assert!(registry.0.runtime.is_none());
        let input = FrozenInput::parse_private_plaintext(include_bytes!(
            "../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json",
        ))
        .unwrap();
        assert!(registry.worker_statement(&input).is_err());
    }

    #[test]
    fn unknown_custody_and_elapsed_drain_do_not_become_success_or_disposal() {
        for status in [
            Status::CommitUnknown,
            Status::Recovering,
            Status::LocalOwnerMissing,
            Status::Refused(child::Refusal::CaptureUnconfirmed),
            Status::Refused(child::Refusal::RetainedCustody),
            Status::Refused(child::Refusal::PreparationExpired),
        ] {
            assert!(matches!(
                project_status("capture", status),
                OperationResult::Unknown {
                    capture_id: Some(_),
                    ..
                }
            ));
        }
        assert!(matches!(
            project_status(
                "capture",
                Status::WaitingParent {
                    disposal: DisposalState::Unresolved
                }
            ),
            OperationResult::Pending {
                stage: PendingStage::Drain,
                ..
            }
        ));
        assert!(matches!(
            project_status(
                "capture",
                Status::CancelRequested {
                    parent_disposal: DisposalState::Disposed,
                    child_disposal: Some(DisposalState::Unresolved),
                    admission_unknown: true,
                }
            ),
            OperationResult::CancelRequested { .. }
        ));
    }
}
