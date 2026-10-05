//! Original-capture read ownership. No serialized record can construct a lease.
use super::*;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const READ_TIME: Duration = Duration::from_secs(30);
const READERS: usize = 2;

#[derive(Clone, Copy)]
pub enum ReadResource {
    Manifest,
    Init,
    Segment(usize),
}
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum ReadMethod {
    Get,
    Head,
}
#[derive(Clone, Copy)]
pub enum ReadRange {
    From(usize),
    Inclusive { first: usize, last: usize },
    Suffix(usize),
}

struct Snapshot {
    directory: Arc<owned_directory::OwnedDirectory>,
    inventory: Vec<ResourceIdentity>,
    local_manifest_sha256: String,
}
struct State {
    closed: bool,
    active: usize,
    snapshot: Option<Snapshot>,
}
pub(super) struct Factory {
    state: Mutex<State>,
    count: watch::Sender<usize>,
    permit: Arc<dyn CapturePermit>,
    transport: Arc<dyn CaptureTransport>,
    stop: watch::Sender<bool>,
    until: tokio::time::Instant,
}
pub(super) struct Guard(Arc<Factory>);
impl Drop for Guard {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().expect("capture read owner");
        state.active -= 1;
        self.0.count.send_replace(state.active);
    }
}
#[derive(Clone)]
struct Spec {
    source_name: String,
    target: String,
    local_name: String,
    expected: ResourceIdentity,
    local_sha256: String,
    maximum: usize,
}
impl Spec {
    fn for_resource(snapshot: &Snapshot, resource: ReadResource) -> Result<Self> {
        let (index, local_name, maximum) = match resource {
            ReadResource::Manifest => (0, "index.m3u8".to_owned(), MANIFEST_BYTES),
            ReadResource::Init => (1, "init.mp4".to_owned(), INIT_BYTES),
            ReadResource::Segment(index) => (
                index
                    .checked_add(2)
                    .ok_or_else(|| anyhow::anyhow!("static_hls_resource_missing"))?,
                format!("s{index:03}.m4s"),
                RESOURCE_BYTES,
            ),
        };
        let expected = snapshot
            .inventory
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("static_hls_resource_missing"))?
            .clone();
        let (source_name, target) = snapshot
            .directory
            .read_targets
            .get(index)
            .ok_or_else(|| anyhow::anyhow!("static_hls_resource_missing"))?;
        ensure!(
            format!("{:x}", Sha256::digest(target.as_bytes())) == expected.original_target_sha256,
            "static_hls_source_target_changed"
        );
        Ok(Self {
            source_name: source_name.clone(),
            target: target.clone(),
            local_name,
            local_sha256: if index == 0 {
                snapshot.local_manifest_sha256.clone()
            } else {
                expected.sha256.clone()
            },
            expected,
            maximum,
        })
    }
}
struct Buffer {
    bytes: Vec<u8>,
    next: usize,
    end: usize,
}

/// A live, original-owner witness of a complete graph revalidation. It cannot
/// be cloned, deserialized or reconstructed from a capture ID or graph digest.
/// Its independent supervisor retains one reader slot until drop/revocation.
pub struct PublicationLease {
    evidence: CaptureEvidence,
    factory: Arc<Factory>,
    active: Arc<AtomicBool>,
    done: watch::Sender<bool>,
    until: tokio::time::Instant,
}
impl PublicationLease {
    pub fn identity(&self) -> CaptureOwnerIdentity {
        self.factory.permit.identity()
    }
    /// A transaction must repeat this synchronous check after its last await
    /// and before COMMIT, as well as repeat its database authority predicate.
    pub fn live_evidence(&self) -> Result<&CaptureEvidence> {
        ensure!(
            self.active.load(Ordering::SeqCst)
                && !*self.factory.stop.borrow()
                && tokio::time::Instant::now() < self.until
                && !self
                    .factory
                    .state
                    .lock()
                    .expect("capture read owner")
                    .closed,
            "static_hls_publication_witness_revoked"
        );
        Ok(&self.evidence)
    }
    pub async fn check(&self) -> Result<()> {
        self.live_evidence()?;
        let mut stopped = self.factory.stop.subscribe();
        guard_work(
            self.factory.permit.check(),
            self.factory.permit.as_ref(),
            &mut stopped,
            self.until,
        )
        .await?;
        self.live_evidence()?;
        Ok(())
    }
}
impl Drop for PublicationLease {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        self.done.send_replace(true);
    }
}

pub struct ReadLease {
    buffer: Arc<Mutex<Option<Buffer>>>,
    done: watch::Sender<bool>,
    drained: watch::Receiver<bool>,
    factory: Arc<Factory>,
    until: tokio::time::Instant,
    total: usize,
    first: usize,
    length: usize,
    ranged: bool,
    etag: String,
}
impl ReadLease {
    pub fn total_bytes(&self) -> usize {
        self.total
    }
    pub fn content_length(&self) -> usize {
        self.length
    }
    pub fn first_byte(&self) -> usize {
        self.first
    }
    pub fn is_partial(&self) -> bool {
        self.ranged
    }
    pub fn strong_etag(&self) -> &str {
        &self.etag
    }
    /// Select only after full revalidation, before consuming any body bytes.
    /// This allows If-Range to compare the actual sealed representation first.
    pub fn select_range(&mut self, range: ReadRange) -> Result<()> {
        ensure!(
            !*self.factory.stop.borrow() && tokio::time::Instant::now() < self.until,
            "static_hls_read_revoked"
        );
        let mut buffer = self.buffer.lock().expect("capture read buffer");
        let buffer = buffer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("static_hls_read_closed"))?;
        ensure!(
            buffer.next == 0 && buffer.end == self.total && !self.ranged,
            "static_hls_range_already_consumed"
        );
        let (first, length, end, ranged) = selection(&buffer.bytes, ReadMethod::Get, Some(range))?;
        buffer.next = first;
        buffer.end = end;
        self.first = first;
        self.length = length;
        self.ranged = ranged;
        Ok(())
    }
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>> {
        let mut stopped = self.factory.stop.subscribe();
        guard_work(
            self.factory.permit.check(),
            self.factory.permit.as_ref(),
            &mut stopped,
            self.until,
        )
        .await?;
        ensure!(
            !*stopped.borrow() && tokio::time::Instant::now() < self.until,
            "static_hls_read_revoked"
        );
        let chunk = {
            let mut owned = self.buffer.lock().expect("capture read buffer");
            let buffer = owned
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("static_hls_read_closed"))?;
            if buffer.next == buffer.end {
                None
            } else {
                let end = buffer.next.saturating_add(65536).min(buffer.end);
                let bytes = buffer.bytes[buffer.next..end].to_vec();
                buffer.next = end;
                Some(bytes)
            }
        };
        if chunk.is_none() {
            self.close_and_drain().await?;
        }
        Ok(chunk)
    }

    /// Closing the body is a request. Completion observes the original task
    /// after its buffer and actual reader guard have been released.
    pub async fn close_and_drain(&self) -> Result<()> {
        self.done.send_replace(true);
        let mut drained = self.drained.clone();
        while !*drained.borrow_and_update() {
            drained
                .changed()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_read_owner_unknown"))?;
        }
        Ok(())
    }
}
impl Drop for ReadLease {
    fn drop(&mut self) {
        self.done.send_replace(true);
    }
}

impl Factory {
    pub(super) fn new(
        permit: Arc<dyn CapturePermit>,
        transport: Arc<dyn CaptureTransport>,
        stop: watch::Sender<bool>,
        until: tokio::time::Instant,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                closed: true,
                active: 0,
                snapshot: None,
            }),
            count: watch::channel(0).0,
            permit,
            transport,
            stop,
            until,
        })
    }
    pub(super) fn install(
        &self,
        directory: owned_directory::OwnedDirectory,
        evidence: &CaptureEvidence,
    ) {
        let mut state = self.state.lock().expect("capture read owner");
        assert!(state.snapshot.is_none());
        state.snapshot = Some(Snapshot {
            directory: Arc::new(directory),
            inventory: evidence.inventory.clone(),
            local_manifest_sha256: evidence.decoder.manifest_sha256.clone(),
        });
        state.closed = false;
    }
    pub(super) async fn close_and_drain(&self) {
        self.state.lock().expect("capture read owner").closed = true;
        // Closing admission also stops already admitted input/process owners.
        // Their guards still drain independently; this flag is no receipt.
        self.stop.send_replace(true);
        let mut count = self.count.subscribe();
        while *count.borrow_and_update() != 0 {
            if count.changed().await.is_err() {
                return;
            }
        }
    }
    pub(super) fn take_directory(&self) -> Result<Option<owned_directory::OwnedDirectory>> {
        let mut state = self.state.lock().expect("capture read owner");
        assert!(state.closed && state.active == 0);
        if let Some(snapshot) = &state.snapshot {
            ensure!(
                Arc::strong_count(&snapshot.directory) == 1,
                "static_hls_read_owner_unknown"
            );
        }
        Ok(state
            .snapshot
            .take()
            .map(|v| Arc::try_unwrap(v.directory).unwrap_or_else(|_| unreachable!())))
    }
    fn admit(self: &Arc<Self>, resource: ReadResource) -> Result<(Guard, Spec)> {
        let mut state = self.state.lock().expect("capture read owner");
        ensure!(
            !state.closed && !*self.stop.borrow() && tokio::time::Instant::now() < self.until,
            "static_hls_read_closed"
        );
        ensure!(state.active < READERS, "static_hls_read_busy");
        let snapshot = state
            .snapshot
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("static_hls_local_owner_missing"))?;
        let spec = Spec::for_resource(snapshot, resource)?;
        state.active += 1;
        self.count.send_replace(state.active);
        Ok((Guard(self.clone()), spec))
    }

    pub(super) fn encoder_live(&self, until: tokio::time::Instant) -> Result<()> {
        ensure!(
            !*self.stop.borrow()
                && tokio::time::Instant::now() < until.min(self.until)
                && !self.state.lock().expect("capture read owner").closed,
            "static_hls_encoder_input_revoked"
        );
        Ok(())
    }

    pub(super) async fn encoder_check(&self, until: tokio::time::Instant) -> Result<()> {
        self.encoder_live(until)?;
        let mut stopped = self.stop.subscribe();
        guard_work(
            self.permit.check(),
            self.permit.as_ref(),
            &mut stopped,
            until.min(self.until),
        )
        .await?;
        self.encoder_live(until)
    }

    pub(super) async fn supervise_encoder(
        &self,
        mut finished: watch::Receiver<bool>,
        until: tokio::time::Instant,
    ) {
        let mut stopped = self.stop.subscribe();
        let wait = async {
            while !*finished.borrow_and_update() {
                if finished.changed().await.is_err() {
                    break;
                }
            }
            Ok(())
        };
        let _ = guard_work(
            wait,
            self.permit.as_ref(),
            &mut stopped,
            until.min(self.until),
        )
        .await;
    }

    /// The only encoder-input mint path: this original factory revalidates
    /// every captured resource, then lends its still-owned sealed descriptor.
    /// The deadline is shorten-only; neither graph verification nor process
    /// launch can restart the caller's original encode/preparation/root fence.
    pub(super) async fn prepare_encoder_input(
        self: &Arc<Self>,
        until: tokio::time::Instant,
    ) -> Result<super::encoder_lease::EncoderInputLease> {
        let until = until.min(self.until);
        self.encoder_live(until)?;
        let (guard, manifest) = self.admit(ReadResource::Manifest)?;
        let (specs, directory) = {
            let state = self.state.lock().expect("capture read owner");
            let snapshot = state
                .snapshot
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("static_hls_local_owner_missing"))?;
            let mut specs = vec![manifest];
            specs.push(Spec::for_resource(snapshot, ReadResource::Init)?);
            for index in 2..snapshot.inventory.len() {
                specs.push(Spec::for_resource(
                    snapshot,
                    ReadResource::Segment(index - 2),
                )?);
            }
            (specs, snapshot.directory.clone())
        };
        let factory = self.clone();
        let prepare_until = (tokio::time::Instant::now() + READ_TIME).min(until);
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let scope = crate::child_process::Scope::new();
            let mut stopped = factory.stop.subscribe();
            let result = scope
                .run(guard_work(
                    async {
                        for spec in specs {
                            // Full upstream identity/hash and exact retained
                            // bytes, including the last never-served segment.
                            drop(factory.materialize(&spec).await?);
                        }
                        #[cfg(target_os = "linux")]
                        let fd = directory.decoder_fd_scoped().await?;
                        #[cfg(not(target_os = "linux"))]
                        let fd = std::future::ready(Err::<std::fs::File, _>(anyhow::anyhow!(
                            "static_hls_linux_required"
                        )))
                        .await?;
                        Ok(fd)
                    },
                    factory.permit.as_ref(),
                    &mut stopped,
                    prepare_until,
                ))
                .await;
            // An abandoned waiter does not cancel an admitted descriptor read
            // or hash. Keep the original directory/reader slot until its real
            // scope drains; an unknown receipt never becomes positive by age.
            while scope.shutdown().await.is_err() {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            let result = match result {
                Ok(fd) => match factory.encoder_check(prepare_until).await {
                    Ok(()) => Ok(fd),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            match result {
                Ok(fd) => {
                    let lease = super::encoder_lease::EncoderInputLease::supervise(
                        factory, directory, fd, guard, until,
                    );
                    // Failed delivery drops only the public waiter. The lease's
                    // independent supervisor still owns the real drain.
                    let _ = send.send(Ok(lease));
                }
                Err(error) => {
                    let _ = send.send(Err(error));
                    drop(directory);
                    drop(guard);
                }
            }
        });
        tokio::time::timeout_at(prepare_until, receive)
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_encoder_input_owner_unknown"))?
            .map_err(|_| anyhow::anyhow!("static_hls_encoder_input_owner_unknown"))?
    }

    pub(super) async fn prepare_publication(
        self: &Arc<Self>,
        evidence: CaptureEvidence,
    ) -> Result<PublicationLease> {
        let (guard, manifest) = self.admit(ReadResource::Manifest)?;
        let specs = {
            let state = self.state.lock().expect("capture read owner");
            let snapshot = state
                .snapshot
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("static_hls_local_owner_missing"))?;
            let mut specs = vec![manifest];
            specs.push(Spec::for_resource(snapshot, ReadResource::Init)?);
            for index in 2..snapshot.inventory.len() {
                specs.push(Spec::for_resource(
                    snapshot,
                    ReadResource::Segment(index - 2),
                )?);
            }
            specs
        };
        let factory = self.clone();
        // One budget covers the entire graph; individual resources do not
        // restart it. The original root/authority can end it sooner.
        let until = (tokio::time::Instant::now() + READ_TIME).min(self.until);
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let scope = crate::child_process::Scope::new();
            let mut stopped = factory.stop.subscribe();
            let result = scope
                .run(guard_work(
                    async {
                        for spec in specs {
                            // Keep at most one resource buffer, and verify the
                            // full remote and retained local bytes each time.
                            drop(factory.materialize(&spec).await?);
                        }
                        Ok(())
                    },
                    factory.permit.as_ref(),
                    &mut stopped,
                    until,
                ))
                .await;
            while scope.shutdown().await.is_err() {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            let result = match result {
                Ok(()) => {
                    guard_work(
                        factory.permit.check(),
                        factory.permit.as_ref(),
                        &mut stopped,
                        until,
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            match result {
                Err(error) => {
                    let _ = send.send(Err(error));
                }
                Ok(()) => {
                    let active = Arc::new(AtomicBool::new(true));
                    let (done, mut finished) = watch::channel(false);
                    let lease = PublicationLease {
                        evidence,
                        factory: factory.clone(),
                        active: active.clone(),
                        done,
                        until,
                    };
                    if send.send(Ok(lease)).is_ok() {
                        let wait = async {
                            while !*finished.borrow_and_update() {
                                if finished.changed().await.is_err() {
                                    break;
                                }
                            }
                            Ok(())
                        };
                        let _ =
                            guard_work(wait, factory.permit.as_ref(), &mut stopped, until).await;
                    }
                    active.store(false, Ordering::SeqCst);
                }
            }
            drop(guard);
        });
        tokio::time::timeout_at(until, receive)
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_publication_owner_unknown"))?
            .map_err(|_| anyhow::anyhow!("static_hls_publication_owner_unknown"))?
    }

    pub(super) async fn read(
        self: &Arc<Self>,
        resource: ReadResource,
        method: ReadMethod,
        range: Option<ReadRange>,
    ) -> Result<ReadLease> {
        let (guard, spec) = self.admit(resource)?;
        let factory = self.clone();
        let until = (tokio::time::Instant::now() + READ_TIME).min(self.until);
        let (send, receive) = oneshot::channel();
        let (drain, drained) = watch::channel(false);
        tokio::spawn(async move {
            let scope = crate::child_process::Scope::new();
            let mut stopped = factory.stop.subscribe();
            let result = scope
                .run(guard_work(
                    factory.materialize(&spec),
                    factory.permit.as_ref(),
                    &mut stopped,
                    until,
                ))
                .await;
            // Cancellation can leave a descriptor read/hash running. An error
            // or timeout never substitutes for the original scope's drain.
            while scope.shutdown().await.is_err() {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            let result = match result {
                Ok(bytes) => match guard_work(
                    factory.permit.check(),
                    factory.permit.as_ref(),
                    &mut stopped,
                    until,
                )
                .await
                {
                    Ok(()) => Ok(bytes),
                    Err(error) => Err(error),
                },
                Err(error) => Err(error),
            };
            match result {
                Err(error) => {
                    let _ = send.send(Err(error));
                }
                Ok(bytes) => {
                    let prepared = selection(&bytes, method, range);
                    match prepared {
                        Err(error) => {
                            let _ = send.send(Err(error));
                        }
                        Ok((first, length, end, ranged)) => {
                            let total = bytes.len();
                            let etag = format!("\"sha256-{}\"", spec.local_sha256);
                            let buffer = Arc::new(Mutex::new(Some(Buffer {
                                bytes,
                                next: first,
                                end,
                            })));
                            let (done, mut finished) = watch::channel(false);
                            let lease = ReadLease {
                                buffer: buffer.clone(),
                                done,
                                drained,
                                factory: factory.clone(),
                                until,
                                total,
                                first,
                                length,
                                ranged,
                                etag,
                            };
                            if send.send(Ok(lease)).is_ok() {
                                let wait = async {
                                    while !*finished.borrow_and_update() {
                                        if finished.changed().await.is_err() {
                                            break;
                                        }
                                    }
                                    Ok(())
                                };
                                let _ =
                                    guard_work(wait, factory.permit.as_ref(), &mut stopped, until)
                                        .await;
                            }
                            // Revocation frees the owned buffer even when a
                            // downstream body remains alive and is never polled.
                            buffer.lock().expect("capture read buffer").take();
                        }
                    }
                }
            }
            drop(guard);
            drain.send_replace(true);
        });
        tokio::time::timeout_at(until, receive)
            .await
            .map_err(|_| anyhow::anyhow!("static_hls_read_owner_unknown"))?
            .map_err(|_| anyhow::anyhow!("static_hls_read_owner_unknown"))?
    }
    async fn local(
        self: &Arc<Self>,
        name: String,
        maximum: usize,
        sha256: String,
    ) -> Result<Vec<u8>> {
        let directory = self
            .state
            .lock()
            .expect("capture read owner")
            .snapshot
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("static_hls_local_owner_missing"))?
            .directory
            .clone();
        crate::child_process::blocking(move || {
            let bytes = directory.read_sealed(&name, maximum)?;
            ensure!(
                format!("{:x}", Sha256::digest(&bytes)) == sha256,
                "static_hls_snapshot_changed"
            );
            Ok(bytes)
        })
        .await?
    }
    async fn materialize(self: &Arc<Self>, spec: &Spec) -> Result<Vec<u8>> {
        self.permit.check().await?;
        let mut body = self
            .transport
            .conditional_get(&spec.target, &spec.expected)
            .await?;
        self.permit.check().await?;
        let facts = body.facts();
        let mut changed = facts.status == 412
            || !facts.identity_encoding
            || facts.strong_etag.as_deref() != Some(&spec.expected.strong_etag)
            || format!("{:x}", Sha256::digest(facts.final_url.as_bytes()))
                != spec.expected.final_target_sha256;
        if changed {
            self.stop.send_replace(true);
            anyhow::bail!("static_hls_source_changed");
        }
        ensure!(
            facts.status == 200 || facts.status == 304,
            "static_hls_source_read_failed"
        );
        if facts.status == 304 {
            let retained = async {
                ensure!(
                    body.chunk().await?.is_none(),
                    "static_hls_invalid_not_modified"
                );
                // A 304 only selects exact bytes that this original snapshot
                // still holds; it is not an empty response-body digest proof.
                self.local(
                    spec.source_name.clone(),
                    spec.maximum,
                    spec.expected.sha256.clone(),
                )
                .await
            }
            .await;
            if let Err(error) = retained {
                // In particular, a missing/changed retained source manifest
                // must revoke the original owner, not just this one read.
                self.stop.send_replace(true);
                return Err(error);
            }
        } else {
            let mut sha = Sha256::new();
            let mut selected_sha = Sha256::new();
            let mut selected_bytes = 0usize;
            let mut bytes = 0usize;
            let expected_bytes = spec
                .expected
                .projection
                .as_ref()
                .map_or(spec.expected.bytes, |p| p.representation_bytes);
            while let Some(chunk) = body.chunk().await? {
                self.permit.check().await?;
                bytes = bytes
                    .checked_add(chunk.len())
                    .ok_or_else(|| anyhow::anyhow!("static_hls_resource_bound"))?;
                ensure!(chunk.len() <= 65536, "static_hls_source_chunk_bound");
                if bytes > expected_bytes
                    || bytes
                        > if spec.expected.projection.is_some() {
                            RESOURCE_BYTES
                        } else {
                            spec.maximum
                        }
                {
                    self.stop.send_replace(true);
                    anyhow::bail!("static_hls_source_changed");
                }
                sha.update(&chunk);
                if let Some(range) = &spec.expected.projection {
                    let chunk_start = bytes - chunk.len();
                    let end = range
                        .offset
                        .checked_add(spec.expected.bytes)
                        .ok_or_else(|| anyhow::anyhow!("static_hls_source_changed"))?;
                    let start = range.offset.max(chunk_start).min(bytes) - chunk_start;
                    let end = end.min(bytes).max(chunk_start) - chunk_start;
                    selected_sha.update(&chunk[start..end]);
                    selected_bytes += end - start;
                }
            }
            let expected_sha = spec
                .expected
                .projection
                .as_ref()
                .map_or(&spec.expected.sha256, |p| &p.representation_sha256);
            changed = bytes != expected_bytes
                || facts.content_length.is_some_and(|v| v != bytes as u64)
                || format!("{:x}", sha.finalize()) != *expected_sha
                || spec.expected.projection.is_some()
                    && (selected_bytes != spec.expected.bytes
                        || format!("{:x}", selected_sha.finalize()) != spec.expected.sha256);
            if changed {
                self.stop.send_replace(true);
                anyhow::bail!("static_hls_source_changed");
            }
        }
        drop(body);
        self.permit.check().await?;
        let local = self
            .local(
                spec.local_name.clone(),
                spec.maximum,
                spec.local_sha256.clone(),
            )
            .await;
        let local = match local {
            Ok(local) => local,
            Err(error) => {
                self.stop.send_replace(true);
                return Err(error);
            }
        };
        ensure!(!*self.stop.borrow(), "static_hls_read_revoked");
        Ok(local)
    }
}

fn selection(
    bytes: &[u8],
    method: ReadMethod,
    range: Option<ReadRange>,
) -> Result<(usize, usize, usize, bool)> {
    let total = bytes.len();
    ensure!(total > 0, "static_hls_resource_empty");
    if method == ReadMethod::Head {
        return Ok((0, total, 0, false));
    }
    let (first, end, ranged) = match range {
        None => (0, total, false),
        Some(ReadRange::From(first)) => (first, total, true),
        Some(ReadRange::Inclusive { first, last }) => {
            ensure!(first <= last, "static_hls_range_unsatisfiable");
            (first, last.saturating_add(1).min(total), true)
        }
        Some(ReadRange::Suffix(length)) => {
            ensure!(length > 0, "static_hls_range_unsatisfiable");
            (total.saturating_sub(length), total, true)
        }
    };
    ensure!(
        first < total && first < end,
        "static_hls_range_unsatisfiable"
    );
    Ok((first, end - first, end, ranged))
}
