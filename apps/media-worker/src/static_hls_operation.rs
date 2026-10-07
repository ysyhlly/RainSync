//! Private operation owner. No public parent/child offer or release by status.
#[cfg(all(test, target_os = "linux"))]
mod native_tests;
#[cfg(all(test, target_os = "linux"))]
mod plan_tests;
#[cfg(all(test, target_os = "linux"))]
mod prepare_tests;
#[cfg(all(test, target_os = "linux"))]
mod read_tests;
use super::App;
use aes_gcm::aead::Aead;
use anyhow::{Context, Result, ensure};
use axum::{
    body::Bytes,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::{
    CaptureControl, CaptureOptions, CapturePermit, DisposalState, VerifiedCapture,
    contracts::{
        input::{OperationKind, SelectedAudioStatement},
        operation::*,
    },
};
use persistence::static_hls_pending::{
    self as pending, Admission, LoadedOperation, PersistedPendingCapturePermit,
};
use providers::{SourceConfig, static_hls::RegisteredSource};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Default)]
pub(super) struct Registry(Arc<Owners>);
#[derive(Default)]
struct Owners {
    accepting: AtomicBool,
    entries: Mutex<HashMap<Uuid, Arc<Entry>>>,
    retired_controls: Mutex<HashMap<Uuid, RetiredControl>>,
}
struct RetiredControl {
    input_sha256: String,
    root_until_ms: u64,
    control: CaptureControl,
}
struct Entry {
    cancelled: AtomicBool,
    admitted: AtomicBool,
    admission_attempted: AtomicBool,
    input_sha256: String,
    owner: OnceLock<Arc<PersistedPendingCapturePermit>>,
    control: OnceLock<CaptureControl>,
    state: Mutex<EntryState>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    publication: Mutex<PublicationState>,
    publication_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
enum PublicationState {
    Dormant,
    Working,
    Uncertain,
    Committed,
}
enum EntryState {
    Capture,
    Unknown,
    Verified {
        snapshot: Arc<VerifiedCapture>,
        owner: Arc<PersistedPendingCapturePermit>,
        root: String,
        at: u64,
        audio: SelectedAudioStatement,
    },
    Refused {
        admitted: bool,
        reason: Reason,
    },
}
struct Activation {
    registry: Registry,
    admission_fresh: bool,
}
impl persistence::static_hls::ActivationCheck for Activation {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async {
            ensure!(
                self.admission_fresh && self.registry.0.accepting.load(Ordering::SeqCst),
                "static_hls_worker_closing"
            );
            Ok(())
        })
    }
}
impl Registry {
    /// Obtain the actual retained parent owner around a child claim. This
    /// handle does not claim the parent or authorize a child; it only lets the
    /// child coordinator await that same owner's positive disposal after the
    /// durable claim stops parent delivery. Never reconstruct it from a UUID.
    pub(super) async fn parent_control_for_child(
        &self,
        input: &media_core::static_hls::contracts::input::FrozenInput,
    ) -> Result<CaptureControl> {
        use media_core::static_hls::contracts::input::OperationKind;
        ensure!(
            input.kind() == OperationKind::Parent,
            "static_hls_parent_required"
        );
        let identity = input.identity_statement();
        ensure!(
            Uuid::parse_str(&identity.worker_instance)? == *super::static_hls_contract::INSTANCE,
            "static_hls_worker_changed"
        );
        let operation = Uuid::parse_str(&identity.operation_id)?;
        let entry = self.0.entries.lock().await.get(&operation).cloned();
        if let Some(entry) = entry {
            ensure!(
                entry.input_sha256 == input.input_sha256(),
                "static_hls_input_changed"
            );
            return entry
                .control
                .get()
                .cloned()
                .context("static_hls_local_owner_missing");
        }
        let retired = self.0.retired_controls.lock().await;
        let retained = retired
            .get(&operation)
            .context("static_hls_local_owner_missing")?;
        ensure!(
            retained.input_sha256 == input.input_sha256()
                && retained.root_until_ms == input.root_deadline_ms(),
            "static_hls_input_changed"
        );
        Ok(retained.control.clone())
    }

    /// Original-owner consumption; public grant authority is a separate gate.
    pub(super) async fn read_original(
        &self,
        input: &media_core::static_hls::contracts::input::FrozenInput,
        resource: media_core::static_hls::ReadResource,
        method: media_core::static_hls::ReadMethod,
        range: Option<media_core::static_hls::ReadRange>,
    ) -> Result<media_core::static_hls::ReadLease> {
        self.original_snapshot(input)
            .await?
            .read(resource, method, range)
            .await
    }

    /// Internal original-owner publication prerequisite; public prepare enforces
    /// its separate publication transaction and grant/compatibility gates.
    #[allow(dead_code)]
    pub(super) async fn publication_original(
        &self,
        input: &media_core::static_hls::contracts::input::FrozenInput,
    ) -> Result<media_core::static_hls::PublicationLease> {
        self.original_snapshot(input)
            .await?
            .prepare_publication()
            .await
    }

    async fn original_snapshot(
        &self,
        input: &media_core::static_hls::contracts::input::FrozenInput,
    ) -> Result<Arc<media_core::static_hls::VerifiedCapture>> {
        ensure!(
            self.0.accepting.load(Ordering::SeqCst),
            "static_hls_worker_closing"
        );
        let identity = input.identity_statement();
        ensure!(
            Uuid::parse_str(&identity.worker_instance)? == *super::static_hls_contract::INSTANCE,
            "static_hls_worker_changed"
        );
        let entry = self
            .0
            .entries
            .lock()
            .await
            .get(&Uuid::parse_str(&identity.operation_id)?)
            .cloned()
            .context("static_hls_local_owner_missing")?;
        ensure!(
            entry.input_sha256 == input.input_sha256() && !entry.cancelled.load(Ordering::SeqCst),
            "static_hls_input_changed"
        );
        let snapshot = match &*entry.state.lock().await {
            EntryState::Verified { snapshot, .. } => snapshot.clone(),
            _ => anyhow::bail!("static_hls_snapshot_unavailable"),
        };
        ensure!(
            self.0.accepting.load(Ordering::SeqCst),
            "static_hls_worker_closing"
        );
        Ok(snapshot)
    }
    pub(super) fn open(&self) {
        self.0.accepting.store(true, Ordering::SeqCst);
    }
    pub(super) async fn close(&self) {
        self.0.accepting.store(false, Ordering::SeqCst);
        for entry in self.0.entries.lock().await.values() {
            entry.cancelled.store(true, Ordering::SeqCst);
            if let Some(control) = entry.control.get() {
                control.cancel();
            }
            // Seal in-flight publication registration before drain snapshots
            // its JoinHandle. A late request observes accepting=false.
            let _registration = entry.publication_task.lock().await;
        }
    }
    pub(super) async fn drain(&self) {
        let entries: Vec<_> = self.0.entries.lock().await.values().cloned().collect();
        for entry in &entries {
            if let Some(task) = entry.task.lock().await.take() {
                let _ = task.await;
            }
            if let Some(task) = entry.publication_task.lock().await.take() {
                let _ = task.await;
            }
        }
        for entry in entries {
            if let Some(control) = entry.control.get() {
                control.cancel();
                loop {
                    match control.disposal_state() {
                        DisposalState::Disposed => break,
                        DisposalState::Unresolved if control.disposal_retry_available() => {
                            let _ = control.retry_disposal().await;
                        }
                        _ => (),
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }
    async fn dispatch(
        &self,
        app: &App,
        loaded: &LoadedOperation,
        action: Action,
        rpc_until: u64,
    ) -> Result<OperationResult> {
        let identity = loaded.input.identity_statement();
        let operation = Uuid::parse_str(&identity.operation_id)?;
        let mut entries = self.0.entries.lock().await;
        if let Some(entry) = entries.get(&operation).cloned() {
            ensure!(
                entry.input_sha256 == loaded.input.input_sha256(),
                "static_hls_operation_conflict"
            );
            drop(entries);
            if action == Action::Cancel {
                entry.cancelled.store(true, Ordering::SeqCst);
                if let Some(control) = entry.control.get() {
                    control.cancel();
                }
                loaded
                    .cancel(&app.db, 410, "static_hls_operation_cancelled")
                    .await?;
                return Ok(OperationResult::CancelRequested {
                    capture_id: operation.to_string(),
                });
            }
            if action == Action::Publish {
                self.start_publication(app, loaded, &entry).await?;
            }
            let result = status(app, &entry, operation).await?;
            if matches!(result, OperationResult::Disposed { .. }) {
                // Release the positively disposed owner's sealed descriptors.
                // Later observations use SQL and never recreate a local owner.
                let mut entries = self.0.entries.lock().await;
                if entries
                    .get(&operation)
                    .is_some_and(|current| Arc::ptr_eq(current, &entry))
                {
                    // Keep only the original opaque disposal observation,
                    // not its sealed snapshot. A child RPC arriving after the
                    // parent drain must not reconstruct an owner from SQL.
                    if let Some(control) = entry.control.get() {
                        let now = now_ms()?;
                        let mut retired = self.0.retired_controls.lock().await;
                        retired.retain(|_, kept| kept.root_until_ms > now);
                        if retired.len() >= 4096 {
                            // No eviction of a live-root handoff: retain the
                            // existing bounded entry instead and fail capacity.
                            return Ok(result);
                        }
                        retired.insert(
                            operation,
                            RetiredControl {
                                input_sha256: entry.input_sha256.clone(),
                                root_until_ms: loaded.input.root_deadline_ms(),
                                control: control.clone(),
                            },
                        );
                    }
                    entries.remove(&operation);
                }
            }
            return Ok(result);
        }
        // SQL observations never adopt a missing in-process original owner.
        let row=sqlx::query("SELECT CASE WHEN streams_closed_at IS NOT NULL AND process_closed_at IS NOT NULL AND files_removed_at IS NOT NULL THEN floor(extract(epoch FROM disposed_at)*1000)::bigint END AS disposed_ms FROM static_hls_captures WHERE id=$1 AND session_id=$2")
            .bind(operation).bind(Uuid::parse_str(&identity.session_id)?).fetch_optional(&app.db).await?;
        if let Some(row) = row {
            let disposed: Option<i64> = row.get("disposed_ms");
            return Ok(disposed.map_or(
                OperationResult::Unknown {
                    capture_id: Some(operation.to_string()),
                    reason: Reason::LocalOwnerMissing,
                },
                |at| OperationResult::Disposed {
                    capture_id: operation.to_string(),
                    disposed_at_ms: at as u64,
                },
            ));
        }
        if action != Action::Create || !self.0.accepting.load(Ordering::SeqCst) {
            return Ok(OperationResult::Unknown {
                capture_id: None,
                reason: Reason::LocalOwnerMissing,
            });
        }
        if loaded.input.kind() != OperationKind::Parent {
            return Ok(OperationResult::Refused {
                capture_id: None,
                reason: Reason::UnsupportedInput,
            });
        }
        ensure!(entries.len() < 4096, "static_hls_operation_capacity");
        let entry = Arc::new(Entry {
            input_sha256: loaded.input.input_sha256().into(),
            cancelled: AtomicBool::new(false),
            admitted: AtomicBool::new(false),
            admission_attempted: AtomicBool::new(false),
            owner: OnceLock::new(),
            control: OnceLock::new(),
            state: Mutex::new(EntryState::Capture),
            task: Mutex::new(None),
            publication: Mutex::new(PublicationState::Dormant),
            publication_task: Mutex::new(None),
        });
        entries.insert(operation, entry.clone());
        let own = entry.clone();
        let app = app.clone();
        let loaded = loaded.clone();
        let registry = self.clone();
        // Retain admission and its actual commit result independently of the
        // HTTP receipt. Cancellation cannot drop a just-committed opaque permit.
        *entry.task.lock().await = Some(tokio::spawn(async move {
            let result = prepare_owned(&app, &loaded, &registry, &own, operation, rpc_until).await;
            *own.state.lock().await = result.unwrap_or_else(|_| {
                if own.admission_attempted.load(Ordering::SeqCst) {
                    // A failed receipt is not evidence that COMMIT did not
                    // happen. Keep the operation and any original permit;
                    // never mint a replacement or report certain non-creation.
                    EntryState::Unknown
                } else {
                    EntryState::Refused {
                        admitted: false,
                        reason: Reason::Unavailable,
                    }
                }
            });
        }));
        Ok(OperationResult::Pending {
            capture_id: operation.to_string(),
            stage: PendingStage::Capture,
        })
    }

    async fn start_publication(
        &self,
        app: &App,
        loaded: &LoadedOperation,
        entry: &Arc<Entry>,
    ) -> Result<()> {
        let mut task = entry.publication_task.lock().await;
        ensure!(
            self.0.accepting.load(Ordering::SeqCst) && !entry.cancelled.load(Ordering::SeqCst),
            "static_hls_worker_closing"
        );
        let (snapshot, owner) = match &*entry.state.lock().await {
            EntryState::Verified {
                snapshot, owner, ..
            } => (snapshot.clone(), owner.clone()),
            _ => return Ok(()),
        };
        let mut publication = entry.publication.lock().await;
        if !matches!(*publication, PublicationState::Dormant) {
            return Ok(());
        }
        ensure!(
            loaded.publication_pending && loaded.current_authority_live,
            "static_hls_publication_authority_revoked"
        );
        owner.check().await?;
        snapshot.live_evidence()?;
        *publication = PublicationState::Working;
        let app = app.clone();
        let input = loaded.input.clone();
        let own = entry.clone();
        // Acceptance is bounded by the RPC window; the actual graph/transaction
        // keeps its original preparation/root budgets and survives waiter loss.
        *task = Some(tokio::spawn(async move {
            let result: Result<bool> = async {
                let witness = snapshot.prepare_publication().await?;
                let prepared = pending::ParentPublication::prepare(
                    &input,
                    witness,
                    |bytes| seal_storage(&app, bytes),
                    |bytes| seal_storage(&app, bytes),
                )?;
                Ok(owner.publish_parent(prepared).await?.is_some())
            }
            .await;
            #[cfg(all(test, target_os = "linux"))]
            if let Some(error) = result
                .as_ref()
                .err()
                .filter(|_| std::env::var("RAINSYNC_OWNED_TEST_RUN_ID").is_ok())
            {
                let _ = std::fs::write(
                    app.cache.join(format!(
                        "publication-failure-{}.json",
                        input.identity_statement().operation_id
                    )),
                    serde_json::to_vec_pretty(
                        &json!({"scope":"owned-fixture-only","error":format!("{error:#}")}),
                    )
                    .unwrap(),
                );
            }
            *own.publication.lock().await = if matches!(result, Ok(true)) {
                PublicationState::Committed
            } else {
                // A lost COMMIT acknowledgment is observed from the original
                // runtime owner. Never start a replacement capture/publication.
                PublicationState::Uncertain
            };
        }));
        Ok(())
    }
}

async fn prepare_owned(
    app: &App,
    loaded: &LoadedOperation,
    registry: &Registry,
    entry: &Entry,
    operation: Uuid,
    rpc_until: u64,
) -> Result<EntryState> {
    let source: Value = serde_json::from_slice(loaded.input.private_storage_plaintext())?;
    let source = &source["source"];
    let headers = source["headers"]
        .as_array()
        .context("source headers")?
        .iter()
        .map(|h| {
            Ok((
                h["name"].as_str().context("header name")?.to_owned(),
                Value::String(h["value"].as_str().context("header value")?.to_owned()),
            ))
        })
        .collect::<Result<serde_json::Map<String, Value>>>()?;
    let config: SourceConfig = serde_json::from_value(
        json!({"url":source["configured_base_url"],"headers":headers,"access_policy":source["access_policy"]}),
    )?;
    let manifest = source["canonical_target"]
        .as_str()
        .context("manifest")?
        .to_owned();
    let selected = source_selected_audio(loaded)?;
    let prepared = loaded.prepared(&app.db).await?;
    let revision = persistence::cache_budget::snapshot(&app.db).await?;
    let cache = app.cache.clone();
    let headroom =
        media_core::child_process::blocking(move || super::cache::reservation_headroom(&cache))
            .await??;
    ensure!(
        now_ms()? < rpc_until && !entry.cancelled.load(Ordering::SeqCst),
        "admission receipt ended"
    );
    entry.admission_attempted.store(true, Ordering::SeqCst);
    let permit =
        match pending::admit(&app.db, &prepared, Uuid::new_v4(), revision, headroom).await? {
            Admission::Acquired(permit) => permit,
            Admission::Changed | Admission::Full => {
                return Ok(EntryState::Refused {
                    admitted: false,
                    reason: Reason::Capacity,
                });
            }
            Admission::Stale => {
                return Ok(EntryState::Refused {
                    admitted: false,
                    reason: Reason::AuthorityRevoked,
                });
            }
        };
    entry.admitted.store(true, Ordering::SeqCst);
    let admission_fresh = now_ms()? < rpc_until && !entry.cancelled.load(Ordering::SeqCst);
    let owner = Arc::new(PersistedPendingCapturePermit::new(
        app.db.clone(),
        permit,
        Arc::new(Activation {
            registry: registry.clone(),
            admission_fresh,
        }),
    ));
    entry
        .owner
        .set(owner.clone())
        .map_err(|_| anyhow::anyhow!("original permit replaced"))?;
    // Even a late actual admission keeps its original permit and produces a
    // NeverStarted proof through the normal owner, rather than asserting drain.
    let handle = media_core::static_hls::start_capture(
        owner.clone(),
        Arc::new(RegisteredSource::new(
            config.clone(),
            config.headers.clone(),
        )),
        CaptureOptions {
            cache_root: app.cache.clone(),
            manifest_url: manifest,
            selected_audio: selected,
            expected_inventory: None,
        },
    )?;
    entry
        .control
        .set(handle.control()?)
        .map_err(|_| anyhow::anyhow!("original control replaced"))?;
    if entry.cancelled.load(Ordering::SeqCst) {
        entry.control.get().unwrap().cancel();
    }
    let captured = handle.wait().await?;
    ensure!(
        owner
            .verify_capture(&captured, |plain| seal_storage(app, plain))
            .await?,
        "verification unconfirmed"
    );
    let row =
        sqlx::query("SELECT root_digest,inventory_encrypted FROM static_hls_captures WHERE id=$1")
            .bind(operation)
            .fetch_one(&app.db)
            .await?;
    let cipher: String = row.get("inventory_encrypted");
    let graph =
        media_core::static_hls::contracts::graph::RootGraphStatement::parse_private_plaintext(
            &open_storage(app, &cipher)?,
        )?;
    let root: String = row.get("root_digest");
    ensure!(root == graph.root_digest(), "root digest mismatch");
    Ok(EntryState::Verified {
        snapshot: Arc::new(captured),
        owner,
        root,
        at: now_ms()?,
        audio: graph.selected_audio_statement(),
    })
}

fn source_selected_audio(loaded: &LoadedOperation) -> Result<Option<u32>> {
    let value: Value = serde_json::from_slice(loaded.input.private_storage_plaintext())?;
    match value["audio_intent"]["kind"].as_str() {
        Some("default") => Ok(None),
        Some("stream") => Ok(Some(u32::try_from(
            value["audio_intent"]["index"]
                .as_u64()
                .context("audio index")?,
        )?)),
        _ => anyhow::bail!("audio intent unsupported"),
    }
}
async fn status(app: &App, entry: &Entry, operation: Uuid) -> Result<OperationResult> {
    if let Some(control) = entry.control.get() {
        if control.disposal_state() == DisposalState::Unresolved
            && control.disposal_retry_available()
        {
            let _ = control.retry_disposal().await;
        }
        if control.disposal_state() == DisposalState::Disposed {
            let at:i64=sqlx::query_scalar("SELECT floor(extract(epoch FROM disposed_at)*1000)::bigint FROM static_hls_captures WHERE id=$1 AND disposed_at IS NOT NULL AND streams_closed_at IS NOT NULL AND process_closed_at IS NOT NULL AND files_removed_at IS NOT NULL")
                .bind(operation).fetch_one(&app.db).await?;
            return Ok(OperationResult::Disposed {
                capture_id: operation.to_string(),
                disposed_at_ms: at as u64,
            });
        }
    }
    let state = entry.state.lock().await;
    Ok(match &*state {
        EntryState::Capture => OperationResult::Pending {
            capture_id: operation.to_string(),
            stage: PendingStage::Capture,
        },
        EntryState::Unknown => OperationResult::Unknown {
            capture_id: Some(operation.to_string()),
            reason: Reason::Unavailable,
        },
        EntryState::Verified {
            snapshot,
            owner,
            root,
            at,
            audio,
        } => {
            if snapshot.live_evidence().is_ok()
                && owner.check().await.is_ok()
                && snapshot.live_evidence().is_ok()
            {
                let publication = entry.publication.lock().await;
                if !matches!(*publication, PublicationState::Dormant) {
                    if let Some(reply) = owner.replay_parent(snapshot).await? {
                        let at: i64 = sqlx::query_scalar("SELECT floor(extract(epoch FROM published_at)*1000)::bigint FROM static_hls_captures WHERE id=$1 AND publication_phase='published_parent'")
                            .bind(operation).fetch_one(&app.db).await?;
                        snapshot.live_evidence()?;
                        OperationResult::Published {
                            capture_id: operation.to_string(),
                            root_digest: root.clone(),
                            published_at_ms: at as u64,
                            selected_audio: *audio,
                            reply_encrypted: reply,
                        }
                    } else if matches!(*publication, PublicationState::Working) {
                        OperationResult::Pending {
                            capture_id: operation.to_string(),
                            stage: PendingStage::Publish,
                        }
                    } else {
                        OperationResult::Unknown {
                            capture_id: Some(operation.to_string()),
                            reason: Reason::Unavailable,
                        }
                    }
                } else {
                    OperationResult::Verified {
                        capture_id: operation.to_string(),
                        root_digest: root.clone(),
                        verified_at_ms: *at,
                        selected_audio: *audio,
                    }
                }
            } else {
                OperationResult::Unknown {
                    capture_id: Some(operation.to_string()),
                    reason: Reason::AuthorityRevoked,
                }
            }
        }
        EntryState::Refused { admitted, reason } => OperationResult::Refused {
            capture_id: admitted.then(|| operation.to_string()),
            reason: *reason,
        },
    })
}
fn now_ms() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
pub(super) fn open_storage(app: &App, text: &str) -> Result<Vec<u8>> {
    ensure!(text.len() <= 262144, "ciphertext bounds");
    let bytes = STANDARD.decode(text)?;
    ensure!(bytes.len() >= 28, "ciphertext bounds");
    app.key
        .decrypt((&bytes[..12]).into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("cipher authentication"))
}
fn seal_storage(app: &App, plain: &[u8]) -> Result<String> {
    let random = Uuid::new_v4();
    let bytes = random.as_bytes();
    let nonce: [u8; 12] = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| bytes[i]);
    let encrypted = app
        .key
        .encrypt((&nonce).into(), plain)
        .map_err(|_| anyhow::anyhow!("cipher authentication"))?;
    Ok(STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
}

pub(super) async fn endpoint(State(app): State<App>, body: Bytes) -> impl IntoResponse {
    let result = tokio::time::timeout(Duration::from_secs(6), call(&app, &body)).await;
    match result {
        Ok(Ok(body)) => (StatusCode::OK, [(header::CACHE_CONTROL, "no-store")], body),
        failure => {
            match failure {
                Ok(Err(error)) => tracing::warn!(error = %error, "static_hls_operation_rejected"),
                Err(_) => tracing::warn!("static_hls_operation_handler_deadline"),
                Ok(Ok(_)) => unreachable!(),
            }
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::CACHE_CONTROL, "no-store")],
                String::new(),
            )
        }
    }
}
async fn call(app: &App, body: &[u8]) -> Result<String> {
    let request = super::static_hls_operation_cipher::authenticate_request(&app.key, body)?;
    let value: Value = serde_json::from_slice(request.private_transport_plaintext())?;
    let b = &value["binding"];
    let uuid = |name: &str| -> Result<Uuid> {
        Ok(Uuid::parse_str(b[name].as_str().context("binding uuid")?)?)
    };
    let rpc = RpcWindow {
        issued_at_ms: b["issued_at_ms"].as_u64().context("issued")?,
        rpc_expires_at_ms: b["rpc_expires_at_ms"].as_u64().context("expiry")?,
    };
    let rpc_until = rpc.rpc_expires_at_ms;
    ensure!(
        rpc.issued_at_ms <= now_ms()? && now_ms()? < rpc.rpc_expires_at_ms,
        "RPC deadline"
    );
    ensure!(
        uuid("worker_instance")? == *super::static_hls_contract::INSTANCE,
        "worker instance mismatch"
    );
    let loaded = pending::load_operation(
        &app.db,
        uuid("operation_id")?,
        uuid("session_id")?,
        |text| open_storage(app, text),
    )
    .await?
    .context("original operation missing")?;
    let challenge = uuid("challenge")?;
    let database = uuid("database")?;
    let mut connection = app.db.acquire().await?;
    connection.close_on_drop();
    let row=sqlx::query("SELECT probe_sha256,floor(extract(epoch FROM probe_until)*1000)::bigint AS until_ms FROM static_hls_database_binding WHERE singleton AND id=$1 AND probe_challenge=$2 AND probe_until>clock_timestamp()")
        .bind(database).bind(challenge).fetch_one(&mut *connection).await?;
    drop(connection);
    let digest: String = row.get("probe_sha256");
    let until: i64 = row.get("until_ms");
    let root = app.cache.clone();
    let observed = media_core::child_process::blocking(move || -> Result<String> {
        use sha2::{Digest, Sha256};
        let bytes = media_core::static_hls_probe::read(&root, &challenge.to_string())?;
        Ok(hex::encode(Sha256::digest(bytes)))
    })
    .await??;
    ensure!(observed == digest, "cache challenge mismatch");
    let expected = ExpectedBinding::from_trusted_input(
        &loaded.input,
        &loaded.current_identity,
        ChallengeObservation {
            challenge: challenge.to_string(),
            cache_challenge_sha256: observed,
            challenge_expires_at_ms: until as u64,
        },
        rpc,
        now_ms()?,
    )?;
    request.validate_expected(
        request.action(),
        &expected,
        now_ms()?,
        call_authority(request.action(), &loaded),
    )?;
    ensure!(
        pending::consume_operation_challenge(&app.db, database, challenge, &digest).await?,
        "operation challenge replay"
    );
    request.validate_expected(
        request.action(),
        &expected,
        now_ms()?,
        call_authority(request.action(), &loaded),
    )?;
    let result = if loaded.input.kind() == OperationKind::Child {
        app.static_hls_child_dispatch
            .dispatch(
                &app.static_hls_operations,
                &app.static_hls_children,
                app,
                &loaded,
                request.action(),
                rpc_until,
            )
            .await?
    } else {
        app.static_hls_operations
            .dispatch(app, &loaded, request.action(), rpc_until)
            .await?
    };
    // A committed child receipt requires a fresh completed authority observation;
    // the pending observation used to authorize dispatch cannot attest COMMIT.
    let response_loaded = if matches!(&result, OperationResult::ChildQueued { .. }) {
        pending::load_operation(
            &app.db,
            uuid("operation_id")?,
            uuid("session_id")?,
            |text| open_storage(app, text),
        )
        .await?
        .context("original child operation missing")?
    } else {
        loaded.clone()
    };
    let response = OperationResponse::for_expected(
        request.action(),
        &expected,
        result,
        now_ms()?,
        call_authority(request.action(), &response_loaded),
    )?;
    let random = Uuid::new_v4();
    let bytes = random.as_bytes();
    let nonce = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13].map(|i| bytes[i]);
    Ok(super::static_hls_operation_cipher::seal_response(
        &app.key,
        nonce,
        &response,
        request.action(),
        &expected,
        now_ms()?,
        call_authority(request.action(), &response_loaded),
    )?)
}

fn call_authority(action: Action, loaded: &LoadedOperation) -> CallAuthority<'_> {
    if matches!(action, Action::Publish | Action::PublishChild)
        || (action == Action::Query && loaded.input.kind() == OperationKind::Child)
    {
        CallAuthority::LivePublication(LivePublicationAuthorityStatement {
            current_identity: &loaded.current_identity,
            current_authority_live: loaded.publication_authority_live,
            observed_at_ms: loaded.observed_at_ms,
            pending: loaded.publication_pending,
            pending_lease_expires_at_ms: loaded.pending_lease_expires_at_ms,
        })
    } else if action == Action::Create {
        CallAuthority::LivePending(LivePendingAuthorityStatement {
            current_identity: &loaded.current_identity,
            current_authority_live: loaded.current_authority_live,
            observed_at_ms: loaded.observed_at_ms,
            pending_lease_expires_at_ms: loaded.pending_lease_expires_at_ms,
        })
    } else {
        CallAuthority::ObservationOnly
    }
}
