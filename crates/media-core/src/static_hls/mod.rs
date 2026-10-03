//! Stage A only: authorized, bounded capture and a runtime-owned immutable
//! snapshot. This module never issues a playback grant or public fallback offer.
//! The permit must come from durable admission; test permits are not DB proof.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::{oneshot, watch};

#[cfg(all(test, target_os = "linux"))]
mod child_timeline_fixture;
pub mod contracts;
mod owned_directory;
mod scanner;
mod storage_budget;
pub mod timeline;
#[cfg(all(test, target_os = "linux"))]
mod waiter_tests;

pub const MANIFEST_BYTES: usize = 256 * 1024;
pub const INIT_BYTES: usize = 2 * 1024 * 1024;
pub const RESOURCE_BYTES: usize = 32 * 1024 * 1024;
pub const TOTAL_BYTES: usize = 128 * 1024 * 1024;
pub const CAPTURE_TIME: Duration = Duration::from_secs(35);
/// Caller observation budgets, measured at the public method invocation.
/// These do not abort the independent cleanup owner or establish disposal.
pub const CAPTURE_WAITER_TIME: Duration = Duration::from_secs(40);
pub const DISPOSAL_WAITER_TIME: Duration = Duration::from_secs(10);
pub const DISPOSAL_ACK_TIMEOUT: Duration = Duration::from_secs(5);
pub const RETENTION_TIME: Duration = Duration::from_secs(30 * 60);
pub type CaptureFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CaptureOwnerIdentity {
    pub capture_id: String,
    pub owner_id: String,
    pub relative_key: String,
}
impl CaptureOwnerIdentity {
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
            uuid(&self.capture_id)
                && uuid(&self.owner_id)
                && self.relative_key == format!("static-hls/{}", self.capture_id),
            "static_hls_owner_identity"
        );
        Ok(())
    }
}

/// No public constructor: only the owner can manufacture a positive receipt,
/// after all resource handles and process/blocking scopes have drained.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessDisposition {
    NeverStarted,
    Reaped,
}
#[derive(Clone, Debug)]
pub struct DisposalProof {
    identity: CaptureOwnerIdentity,
    streams_closed: bool,
    process_drained: bool,
    process_disposition: ProcessDisposition,
    files_removed: bool,
}
impl DisposalProof {
    pub fn identity(&self) -> &CaptureOwnerIdentity {
        &self.identity
    }
    pub fn streams_closed(&self) -> bool {
        self.streams_closed
    }
    pub fn process_reaped(&self) -> bool {
        self.process_drained && self.process_disposition == ProcessDisposition::Reaped
    }
    pub fn process_drained(&self) -> bool {
        self.process_drained
    }
    pub fn process_disposition(&self) -> ProcessDisposition {
        self.process_disposition
    }
    pub fn files_removed(&self) -> bool {
        self.files_removed
    }
    pub fn all_positive(&self) -> bool {
        self.streams_closed && self.process_drained && self.files_removed
    }
}

/// Implementations bind an already acquired durable reservation, current exact
/// login/source/epoch authority, and activation on every check. Neither lease
/// expiry nor dropping this value is permission to release its reservation.
pub trait CapturePermit: Send + Sync {
    fn identity(&self) -> CaptureOwnerIdentity;
    fn check(&self) -> CaptureFuture<'_, ()>;
    fn acknowledge_disposal(&self, proof: DisposalProof) -> CaptureFuture<'_, ()>;
}

/// Transport is purpose-separated to avoid a media-core/providers dependency
/// cycle. Production callers use providers::static_hls::RegisteredSource.
pub trait CaptureTransport: Send + Sync {
    fn get<'a>(&'a self, target: &'a str) -> CaptureFuture<'a, Box<dyn CaptureBody>>;
}
pub trait CaptureBody: Send {
    fn facts(&self) -> ResponseFacts;
    fn chunk(&mut self) -> CaptureFuture<'_, Option<Vec<u8>>>;
}
/// Private source URLs never appear in Debug/Serialize, logs, or local manifests.
pub struct ResponseFacts {
    pub status: u16,
    pub final_url: String,
    pub strong_etag: Option<String>,
    pub content_length: Option<u64>,
    pub identity_encoding: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct ResourceIdentity {
    pub original_target_sha256: String,
    pub final_target_sha256: String,
    pub strong_etag: String,
    pub bytes: usize,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaptureEvidence {
    pub version: u32,
    pub inventory: Vec<ResourceIdentity>,
    pub closure: timeline::ClosureIdentity,
    pub timeline: timeline::TimelineProof,
    pub source_facts: serde_json::Value,
    pub decoder: scanner::DecoderEvidence,
    pub actual_bytes: usize,
    pub elapsed_ms: u64,
}

pub struct CaptureOptions {
    /// Existing cache root; this module creates static-hls/{durable capture ID}
    /// exactly once. Existing attempt directories are refused, never reused.
    pub cache_root: PathBuf,
    pub manifest_url: String,
    pub selected_audio: Option<u32>,
    /// Full-body independent recapture comparison. A 304 is never accepted here.
    pub expected_inventory: Option<Vec<ResourceIdentity>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisposalState {
    Pending,
    Disposed,
    Unresolved,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WaiterOperation {
    Capture,
    Disposal,
}
/// A missed caller deadline, distinct from eventual background disposal.
/// The state is the real observation at timeout; it is never a disposal proof.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WaiterTimeout {
    pub operation: WaiterOperation,
    pub disposal_state: DisposalState,
    pub last_capture_failure: Option<String>,
}
impl std::fmt::Display for WaiterTimeout {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "static_hls_{:?}_waiter_deadline:{:?}",
            self.operation, self.disposal_state
        )
    }
}
impl std::error::Error for WaiterTimeout {}
#[derive(Clone, Default)]
struct CaptureDiagnostic {
    ready: bool,
    failure: Option<String>,
}
pub struct CaptureHandle {
    receiver: Option<oneshot::Receiver<Result<CaptureEvidence>>>,
    stop: Option<watch::Sender<bool>>,
    disposed: watch::Receiver<DisposalState>,
    diagnostic: watch::Receiver<CaptureDiagnostic>,
}
impl CaptureHandle {
    pub fn cancel(&self) {
        if let Some(stop) = &self.stop {
            stop.send_replace(true);
        }
    }
    pub fn disposal_state(&self) -> DisposalState {
        self.disposed.borrow().clone()
    }
    pub fn wait(self) -> impl Future<Output = Result<VerifiedCapture>> {
        self.wait_with_budget(CAPTURE_WAITER_TIME)
    }
    /// A caller may shorten, never extend, the 40-second observation budget.
    /// It starts at method invocation, even if the returned future is polled
    /// later. Timeout drops only the waiter; Drop requests cancellation, while
    /// the independent owner still drains.
    pub fn wait_with_budget(
        self,
        budget: Duration,
    ) -> impl Future<Output = Result<VerifiedCapture>> {
        let valid = validate_waiter_budget(budget, CAPTURE_WAITER_TIME);
        let until = valid
            .as_ref()
            .ok()
            .map(|_| tokio::time::Instant::now() + budget);
        async move {
            valid?;
            self.wait_until(until.expect("validated waiter deadline"))
                .await
        }
    }
    async fn wait_until(mut self, until: tokio::time::Instant) -> Result<VerifiedCapture> {
        if tokio::time::Instant::now() >= until {
            return Err(waiter_timeout(
                WaiterOperation::Capture,
                &self.disposed,
                &self.diagnostic,
            ));
        }
        let receiver = self.receiver.take().expect("single capture receiver");
        let received = observe_until(receiver, until).await;
        let evidence = match received {
            Some(received) => {
                received.map_err(|_| anyhow::anyhow!("static_hls_owner_unresolved"))??
            }
            None => {
                return Err(waiter_timeout(
                    WaiterOperation::Capture,
                    &self.disposed,
                    &self.diagnostic,
                ));
            }
        };
        // An already queued result is not fresh ownership. Recheck both the
        // caller clock and retirement after receiving, before constructing.
        if tokio::time::Instant::now() >= until {
            return Err(waiter_timeout(
                WaiterOperation::Capture,
                &self.disposed,
                &self.diagnostic,
            ));
        }
        // Failures queued before retirement keep their original reason. Only
        // a successful result must establish live snapshot ownership here.
        ensure!(
            *self.disposed.borrow() == DisposalState::Pending,
            "static_hls_capture_retired"
        );
        ensure!(
            self.disposed.has_changed().is_ok() && self.diagnostic.has_changed().is_ok(),
            "static_hls_owner_unresolved"
        );
        ensure!(self.diagnostic.borrow().ready, "static_hls_capture_retired");
        Ok(VerifiedCapture {
            evidence,
            stop: self.stop.take(),
            disposed: self.disposed.clone(),
            diagnostic: self.diagnostic.clone(),
        })
    }
}
impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.cancel();
    }
}
/// The media files remain sealed and inaccessible through the public API.
/// Dropping or disposing this handle asks the independent owner to drain and
/// delete, then acknowledge disposal. It cannot release an uncertain owner.
pub struct VerifiedCapture {
    pub evidence: CaptureEvidence,
    stop: Option<watch::Sender<bool>>,
    disposed: watch::Receiver<DisposalState>,
    diagnostic: watch::Receiver<CaptureDiagnostic>,
}
impl VerifiedCapture {
    pub fn dispose(self) -> impl Future<Output = Result<()>> {
        self.dispose_with_budget(DISPOSAL_WAITER_TIME)
    }
    /// The ten-second caller budget starts at method invocation; disposal is
    /// requested immediately. The cleanup owner has no fabricated OS-IO
    /// completion deadline and may genuinely finish after the caller left.
    pub fn dispose_with_budget(mut self, budget: Duration) -> impl Future<Output = Result<()>> {
        let valid = validate_waiter_budget(budget, DISPOSAL_WAITER_TIME);
        let until = valid
            .as_ref()
            .ok()
            .map(|_| tokio::time::Instant::now() + budget);
        if valid.is_ok()
            && let Some(stop) = self.stop.take()
        {
            stop.send_replace(true);
        }
        async move {
            valid?;
            wait_disposed_until(
                &mut self.disposed,
                &self.diagnostic,
                until.expect("validated waiter deadline"),
            )
            .await
        }
    }
    pub fn disposal_state(&self) -> DisposalState {
        self.disposed.borrow().clone()
    }
}
impl Drop for VerifiedCapture {
    fn drop(&mut self) {
        if let Some(stop) = &self.stop {
            stop.send_replace(true);
        }
    }
}
async fn wait_disposed(state: &mut watch::Receiver<DisposalState>) -> Result<()> {
    loop {
        match &*state.borrow_and_update() {
            DisposalState::Disposed => return Ok(()),
            DisposalState::Unresolved => anyhow::bail!("static_hls_disposal_unresolved"),
            DisposalState::Pending => (),
        }
        state
            .changed()
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_disposal_unresolved"))?;
    }
}
fn validate_waiter_budget(budget: Duration, maximum: Duration) -> Result<()> {
    ensure!(
        !budget.is_zero() && budget <= maximum,
        "static_hls_waiter_budget"
    );
    Ok(())
}
/// Timer first plus an explicit after-completion clock check prevents a ready
/// future from turning a missed caller deadline into successful observation.
async fn observe_until<T>(work: impl Future<Output = T>, until: tokio::time::Instant) -> Option<T> {
    if tokio::time::Instant::now() >= until {
        return None;
    }
    tokio::pin!(work);
    let result = tokio::select! {
        biased;
        _ = tokio::time::sleep_until(until) => return None,
        result = &mut work => result,
    };
    (tokio::time::Instant::now() < until).then_some(result)
}
fn waiter_timeout(
    operation: WaiterOperation,
    state: &watch::Receiver<DisposalState>,
    diagnostic: &watch::Receiver<CaptureDiagnostic>,
) -> anyhow::Error {
    WaiterTimeout {
        operation,
        disposal_state: state.borrow().clone(),
        last_capture_failure: diagnostic.borrow().failure.clone(),
    }
    .into()
}
async fn wait_disposed_until(
    state: &mut watch::Receiver<DisposalState>,
    diagnostic: &watch::Receiver<CaptureDiagnostic>,
    until: tokio::time::Instant,
) -> Result<()> {
    match observe_until(wait_disposed(state), until).await {
        Some(result) => result,
        None => Err(waiter_timeout(WaiterOperation::Disposal, state, diagnostic)),
    }
}

/// Starts one non-abortable owner task. Cancellation of a public waiter cannot
/// cancel file/process reaping or manufacture a disposal receipt. Upstream reads
/// are sequential (one in flight), below the permitted maximum of two.
pub fn start_capture(
    permit: Arc<dyn CapturePermit>,
    transport: Arc<dyn CaptureTransport>,
    options: CaptureOptions,
) -> Result<CaptureHandle> {
    let identity = permit.identity();
    identity.validate()?;
    let (stop, mut stopped) = watch::channel(false);
    let (send, receive) = oneshot::channel();
    let (disposed, disposal) = watch::channel(DisposalState::Pending);
    let (diagnostic, diagnostics) = watch::channel(CaptureDiagnostic::default());
    tokio::spawn(async move {
        let scope = crate::child_process::Scope::new();
        let began = tokio::time::Instant::now();
        let mut directory = None;
        let completed_directory = Arc::new(std::sync::Mutex::new(None));
        let mut attempt_started = false;
        let mut process_started = false;
        let result = scope
            .run(async {
                let work = async {
                    permit.check().await?;
                    attempt_started = true;
                    let root = options.cache_root.clone();
                    let identity = identity.clone();
                    let created = completed_directory.clone();
                    crate::child_process::blocking(move || {
                        let dir = owned_directory::OwnedDirectory::create(&root, &identity)?;
                        *created.lock().expect("capture directory slot") = Some(dir);
                        Ok::<_, anyhow::Error>(())
                    })
                    .await??;
                    directory = completed_directory
                        .lock()
                        .expect("capture directory slot")
                        .take();
                    capture_inner(
                        permit.as_ref(),
                        transport.as_ref(),
                        &options,
                        directory.as_mut().unwrap(),
                        began,
                        &mut process_started,
                    )
                    .await
                };
                guard_work(work, permit.as_ref(), &mut stopped, began + CAPTURE_TIME).await
            })
            .await;
        if let Err(error) = &result {
            diagnostic.send_modify(|current| current.failure = Some(error.to_string()));
        }
        let mut send = Some(send);
        let mut result = Some(result);
        // No caller-visible verified result until all decoder + blocking writer
        // work has completed. Successful capture has only read-only descriptors.
        let mut drained = scope.shutdown().await.is_ok();
        if directory.is_none() {
            directory = completed_directory
                .lock()
                .expect("capture directory slot")
                .take();
        }
        if result.as_ref().unwrap().is_ok() && drained {
            // Drain is an async boundary. Authority, cancellation and the full
            // wall clock must still be valid immediately before publication.
            if let Err(error) = guard_work(
                permit.check(),
                permit.as_ref(),
                &mut stopped,
                began + CAPTURE_TIME,
            )
            .await
            {
                diagnostic.send_modify(|current| current.failure = Some(error.to_string()));
                result = Some(Err(error));
            }
        }
        let successful = result.as_ref().unwrap().is_ok() && drained;
        if successful {
            diagnostic.send_modify(|current| current.ready = true);
            let delivered = send.take().unwrap().send(result.take().unwrap()).is_ok();
            if delivered {
                // Hard retention cap measured from capture start, never renewed.
                let until = began + RETENTION_TIME;
                let _ = guard_work(
                    std::future::pending::<Result<()>>(),
                    permit.as_ref(),
                    &mut stopped,
                    until,
                )
                .await;
            }
        }
        diagnostic.send_modify(|current| current.ready = false);
        // Scope shutdown is idempotent. Failure is deliberately unresolved.
        drained &= scope.shutdown().await.is_ok();
        let removed = match directory.take() {
            Some(mut dir) if drained => crate::child_process::blocking(move || dir.remove_owned())
                .await
                .is_ok_and(|result| result.is_ok()),
            None => !attempt_started,
            _ => false,
        };
        let proof = DisposalProof {
            identity,
            streams_closed: drained,
            process_drained: drained,
            process_disposition: if process_started {
                ProcessDisposition::Reaped
            } else {
                ProcessDisposition::NeverStarted
            },
            files_removed: removed,
        };
        let acknowledged = proof.all_positive()
            && tokio::time::timeout(DISPOSAL_ACK_TIMEOUT, permit.acknowledge_disposal(proof))
                .await
                .is_ok_and(|result| result.is_ok());
        disposed.send_replace(if acknowledged {
            DisposalState::Disposed
        } else {
            DisposalState::Unresolved
        });
        if !successful {
            let error = if acknowledged {
                result
                    .take()
                    .unwrap()
                    .err()
                    .unwrap_or_else(|| anyhow::anyhow!("static_hls_capture_failed"))
            } else {
                anyhow::anyhow!("static_hls_owner_unresolved")
            };
            let _ = send.take().unwrap().send(Err(error));
        }
    });
    Ok(CaptureHandle {
        receiver: Some(receive),
        stop: Some(stop),
        disposed: disposal,
        diagnostic: diagnostics,
    })
}

async fn guard_work<T>(
    work: impl Future<Output = Result<T>>,
    permit: &dyn CapturePermit,
    stopped: &mut watch::Receiver<bool>,
    until: tokio::time::Instant,
) -> Result<T> {
    tokio::pin!(work);
    loop {
        ensure!(!*stopped.borrow(), "static_hls_canceled");
        tokio::select! {
            biased;
            _ = stopped.changed() => anyhow::bail!("static_hls_canceled"),
            _ = tokio::time::sleep_until(until) => anyhow::bail!("static_hls_deadline"),
            result = &mut work => return result,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                tokio::select! {
                    _ = stopped.changed() => anyhow::bail!("static_hls_canceled"),
                    _ = tokio::time::sleep_until(until) => anyhow::bail!("static_hls_deadline"),
                    checked = permit.check() => checked?,
                }
            }
        }
    }
}

async fn capture_inner(
    permit: &dyn CapturePermit,
    transport: &dyn CaptureTransport,
    options: &CaptureOptions,
    dir: &mut owned_directory::OwnedDirectory,
    began: tokio::time::Instant,
    process_started: &mut bool,
) -> Result<CaptureEvidence> {
    use sha2::{Digest, Sha256};
    let mut total = 0;
    let mut inventory = Vec::new();
    let manifest = capture_resource(
        permit,
        transport,
        dir,
        &options.manifest_url,
        "source.bin",
        MANIFEST_BYTES,
        &mut total,
    )
    .await?;
    inventory.push(manifest);
    compare_inventory_prefix(options, &inventory)?;
    let text = String::from_utf8(dir.read_scoped("source.bin", MANIFEST_BYTES).await?)
        .map_err(|_| anyhow::anyhow!("static_hls_manifest_utf8"))?;
    let playlist = timeline::parse_playlist(&text)?;
    let mut local = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:32\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n",
        playlist.sequence
    );
    for (index, segment) in playlist.segments.iter().enumerate() {
        local.push_str(&format!(
            "#EXTINF:{:.6},\ns{index:03}.m4s\n",
            segment.duration
        ));
    }
    local.push_str("#EXT-X-ENDLIST\n");
    dir.reserve_local_manifest(local.len())?;
    // Relative references resolve against the actual final manifest identity,
    // never the original URL that redirected to a different directory.
    let base = dir
        .manifest_final_url
        .take()
        .expect("captured manifest final identity");
    let base = url::Url::parse(&base).map_err(|_| anyhow::anyhow!("static_hls_source_url"))?;
    let init_target = target(&base, &playlist.map)?;
    inventory.push(
        capture_resource(
            permit,
            transport,
            dir,
            &init_target,
            "init.mp4",
            INIT_BYTES,
            &mut total,
        )
        .await?,
    );
    compare_inventory_prefix(options, &inventory)?;
    let mut structure =
        timeline::Structure::new(&text, &dir.read_scoped("init.mp4", INIT_BYTES).await?)?;
    for (index, segment) in playlist.segments.iter().enumerate() {
        let name = format!("s{index:03}.m4s");
        let address = target(&base, &segment.uri)?;
        inventory.push(
            capture_resource(
                permit,
                transport,
                dir,
                &address,
                &name,
                RESOURCE_BYTES,
                &mut total,
            )
            .await?,
        );
        compare_inventory_prefix(options, &inventory)?;
        // One bounded media resource in Server RAM, never the full closure.
        structure.ingest_fragment(&dir.read_scoped(&name, RESOURCE_BYTES).await?, index)?;
        permit.check().await?;
    }
    if let Some(expected) = &options.expected_inventory {
        ensure!(expected == &inventory, "static_hls_source_changed");
    }
    dir.write_complete_scoped("index.m3u8", local.as_bytes().to_vec())
        .await?;
    dir.seal_scoped().await?;
    permit.check().await?;
    let (probe, decoder) = scanner::decode(dir, process_started).await?;
    permit.check().await?;
    let timeline = structure.inspect_probe(&probe)?;
    let source_facts = scanner::qualify_source(&probe, options.selected_audio)?;
    permit.check().await?;
    // Hash of the actual rewritten manifest is execution provenance only, not
    // the original closure identity used for remote demand revalidation.
    ensure!(
        decoder.manifest_sha256 == format!("{:x}", Sha256::digest(local.as_bytes())),
        "static_hls_local_manifest_identity"
    );
    Ok(CaptureEvidence {
        version: 1,
        inventory,
        closure: structure.byte_identity()?,
        timeline,
        source_facts,
        decoder,
        actual_bytes: total,
        elapsed_ms: began.elapsed().as_millis() as u64,
    })
}
fn target(base: &url::Url, reference: &str) -> Result<String> {
    ensure!(
        reference.len() <= 16384 && !reference.contains('\\'),
        "static_hls_resource_url"
    );
    let url = base
        .join(reference)
        .map_err(|_| anyhow::anyhow!("static_hls_resource_url"))?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "static_hls_resource_url"
    );
    Ok(url.into())
}
async fn capture_resource(
    permit: &dyn CapturePermit,
    transport: &dyn CaptureTransport,
    dir: &mut owned_directory::OwnedDirectory,
    target: &str,
    name: &str,
    maximum: usize,
    total: &mut usize,
) -> Result<ResourceIdentity> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    permit.check().await?;
    let original =
        url::Url::parse(target).map_err(|_| anyhow::anyhow!("static_hls_resource_url"))?;
    ensure!(
        matches!(original.scheme(), "http" | "https")
            && original.username().is_empty()
            && original.password().is_none()
            && original.fragment().is_none(),
        "static_hls_resource_url"
    );
    let mut body = transport.get(original.as_str()).await?;
    permit.check().await?;
    let facts = body.facts();
    ensure!(
        facts.status == 200 && facts.identity_encoding,
        "static_hls_response_representation"
    );
    let etag = facts
        .strong_etag
        .ok_or_else(|| anyhow::anyhow!("static_hls_strong_etag_required"))?;
    ensure!(
        etag.len() >= 2
            && etag.len() <= 8192
            && etag.starts_with('"')
            && etag.ends_with('"')
            && !etag.bytes().any(|v| v.is_ascii_control()),
        "static_hls_strong_etag_required"
    );
    if let Some(len) = facts.content_length {
        ensure!(
            len > 0 && len <= maximum as u64 && len <= (TOTAL_BYTES - *total) as u64,
            "static_hls_resource_bound"
        );
    }
    let mut file = dir.create_file_scoped(name).await?;
    let mut hash = Sha256::new();
    let mut bytes = 0usize;
    loop {
        permit.check().await?;
        let Some(chunk) = body.chunk().await? else {
            break;
        };
        permit.check().await?;
        bytes = bytes
            .checked_add(chunk.len())
            .ok_or_else(|| anyhow::anyhow!("static_hls_resource_bound"))?;
        *total = total
            .checked_add(chunk.len())
            .ok_or_else(|| anyhow::anyhow!("static_hls_total_bound"))?;
        ensure!(
            bytes <= maximum && *total <= TOTAL_BYTES,
            "static_hls_resource_bound"
        );
        ensure!(chunk.len() <= 65536, "static_hls_source_chunk_bound");
        dir.before_write(name, chunk.len())?;
        hash.update(&chunk);
        file = crate::child_process::blocking(move || -> std::io::Result<std::fs::File> {
            file.write_all(&chunk)?;
            Ok(file)
        })
        .await??;
    }
    drop(body);
    ensure!(
        bytes > 0 && facts.content_length.is_none_or(|len| len == bytes as u64),
        "static_hls_truncated_resource"
    );
    crate::child_process::blocking(move || {
        file.sync_all()?;
        drop(file);
        Ok::<_, std::io::Error>(())
    })
    .await??;
    dir.seal_file_scoped(name).await?;
    permit.check().await?;
    if name == "source.bin" {
        dir.manifest_final_url = Some(facts.final_url.clone());
    }
    Ok(ResourceIdentity {
        original_target_sha256: format!("{:x}", Sha256::digest(original.as_str().as_bytes())),
        final_target_sha256: format!("{:x}", Sha256::digest(facts.final_url.as_bytes())),
        strong_etag: etag,
        bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}

fn compare_inventory_prefix(options: &CaptureOptions, current: &[ResourceIdentity]) -> Result<()> {
    for (index, resource) in current.iter().enumerate() {
        ensure!(
            current[..index]
                .iter()
                .all(
                    |other| other.original_target_sha256 != resource.original_target_sha256
                        && other.final_target_sha256 != resource.final_target_sha256
                ),
            "static_hls_duplicate_resource_identity"
        );
    }
    if let Some(expected) = &options.expected_inventory {
        ensure!(
            expected.len() >= current.len() && &expected[..current.len()] == current,
            "static_hls_source_changed"
        );
    }
    Ok(())
}
