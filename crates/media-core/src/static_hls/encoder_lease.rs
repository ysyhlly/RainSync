//! A same-original-capture encoder input owner, separate from parent delivery.
//! No path, serialized proof, UUID, or caller-provided ownership flag mints it.
//! Cancellation closes process admission and requests a real process-tree drain;
//! the original reader slot and sealed directory survive an unknown receipt.
use super::{VerifiedCapture, owned_directory::OwnedDirectory, read_lease};
use anyhow::{Result, ensure};
use std::{
    fs::File,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use tokio::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Drain {
    Pending,
    Unknown,
    Complete,
}

/// Nonserializable custody of one original capture's complete verified graph.
/// There is deliberately no public constructor or clone. This does not grant
/// a job claim, an output reservation, or parent playback/publication authority.
/// The caller must also check its exact same-Worker job/recipe/current authority
/// before launch, output writes and output publication.
pub struct EncoderInputLease {
    factory: Arc<read_lease::Factory>,
    descriptor: Arc<Mutex<Option<File>>>,
    scope: crate::child_process::Scope,
    active: Arc<AtomicBool>,
    launched: AtomicBool,
    done: watch::Sender<bool>,
    drained: watch::Receiver<Drain>,
    until: Instant,
}

impl EncoderInputLease {
    pub(super) fn supervise(
        factory: Arc<read_lease::Factory>,
        directory: Arc<OwnedDirectory>,
        descriptor: File,
        guard: read_lease::Guard,
        until: Instant,
    ) -> Self {
        let descriptor = Arc::new(Mutex::new(Some(descriptor)));
        let scope = crate::child_process::Scope::new();
        let active = Arc::new(AtomicBool::new(true));
        let (done, finished) = watch::channel(false);
        let (status, drained) = watch::channel(Drain::Pending);
        let owner = factory.clone();
        let owned_descriptor = descriptor.clone();
        let owned_scope = scope.clone();
        let owned_active = active.clone();
        // No public JoinHandle: dropping/canceling the public waiter cannot
        // abort the custody task or turn an unconfirmed process into a receipt.
        tokio::spawn(async move {
            owner.supervise_encoder(finished, until).await;
            owned_active.store(false, Ordering::SeqCst);
            loop {
                // Scope admission and shutdown serialize. A racing launch is
                // either truly registered or refused before it can exist.
                match owned_scope.shutdown().await {
                    Ok(()) => {
                        owned_descriptor
                            .lock()
                            .expect("capture encoder descriptor")
                            .take();
                        drop(directory);
                        drop(guard);
                        status.send_replace(Drain::Complete);
                        break;
                    }
                    Err(_) => {
                        // Preserve the real descriptor/directory/reader guard.
                        // Repeated errors and elapsed time cannot free custody.
                        status.send_replace(Drain::Unknown);
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        });
        Self {
            factory,
            descriptor,
            scope,
            active,
            launched: AtomicBool::new(false),
            done,
            drained,
            until,
        }
    }

    /// Repeat after the final await before using the bound descriptor. Original
    /// in-process factory identity is required; equal IDs/evidence are not enough.
    pub fn check_live_for(&self, capture: &VerifiedCapture) -> Result<()> {
        ensure!(
            capture
                .readers
                .as_ref()
                .is_some_and(|factory| Arc::ptr_eq(factory, &self.factory)),
            "static_hls_encoder_original_capture_required"
        );
        capture.live_evidence()?;
        ensure!(
            self.active.load(Ordering::SeqCst) && !*self.done.borrow(),
            "static_hls_encoder_input_revoked"
        );
        self.factory.encoder_live(self.until)
    }

    /// Current original permit/authority check, with this already installed
    /// shorten-only fence. It cannot renew the lease or mint a process receipt.
    pub async fn check_for(&self, capture: &VerifiedCapture) -> Result<()> {
        self.check_live_for(capture)?;
        self.factory.encoder_check(self.until).await?;
        self.check_live_for(capture)
    }

    /// Private recipe binding only. No File/raw descriptor ownership escapes;
    /// revoke cannot close/reuse the descriptor while this callback holds it.
    #[cfg(target_os = "linux")]
    pub(super) fn with_directory<T>(
        &self,
        capture: &VerifiedCapture,
        work: impl FnOnce(std::os::fd::BorrowedFd<'_>) -> Result<T>,
    ) -> Result<T> {
        use std::os::fd::AsFd;
        self.check_live_for(capture)?;
        let descriptor = self.descriptor.lock().expect("capture encoder descriptor");
        self.check_live_for(capture)?;
        let descriptor = descriptor
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("static_hls_encoder_input_revoked"))?;
        work(descriptor.as_fd())
    }

    /// Launch at most one encoder through the existing managed process-tree
    /// owner. The descriptor is held through spawn and inherited read-only by
    /// that child. External/unregistered spawn is never a drain proof.
    ///
    /// Construct recipe argv before calling this method: its builder already
    /// holds the descriptor lock, so it must not recursively call a recipe's
    /// lease-bound argv accessor. The builder may install async-signal-safe
    /// limits and stdio, but must not retain or separately spawn the command.
    #[cfg(target_os = "linux")]
    pub async fn spawn(
        &self,
        capture: &VerifiedCapture,
        build: impl FnOnce(std::os::fd::BorrowedFd<'_>) -> Result<tokio::process::Command>,
    ) -> Result<crate::child_process::Child> {
        use std::os::fd::AsRawFd;
        self.check_for(capture).await?;
        ensure!(
            self.launched
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok(),
            "static_hls_encoder_input_already_launched"
        );
        self.scope
            .run(async {
                self.with_directory(capture, |descriptor| {
                    let fd = descriptor.as_raw_fd();
                    let mut command = build(descriptor)?;
                    self.check_live_for(capture)?;
                    // The sole read-only directory dup was minted above stdio
                    // by the original sealed owner. Preserve its other flags.
                    unsafe {
                        command.pre_exec(move || {
                            let flags = libc::fcntl(fd, libc::F_GETFD);
                            if flags < 0
                                || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                            {
                                return Err(std::io::Error::last_os_error());
                            }
                            Ok(())
                        });
                    }
                    crate::child_process::spawn(command)
                        .map_err(|_| anyhow::anyhow!("static_hls_encoder_spawn_failed"))
                })
            })
            .await
    }

    /// The SAME original encoder scope must already have positively closed and
    /// reaped its one real successful process tree. Reader liveness, a caller's
    /// JSON/exit code, cancellation or a drain alone cannot prove completion.
    pub(super) fn require_successful_reap(&self) -> Result<()> {
        ensure!(
            *self.drained.borrow() == Drain::Complete,
            "static_hls_encoder_successful_reap_required"
        );
        self.scope
            .require_successful_single_process_reap()
            .map_err(|_| anyhow::anyhow!("static_hls_encoder_process_success_unproven"))
    }

    /// Requests shutdown only. The independent supervisor retains custody
    /// until its actual scope positively reaps every registered process tree.
    pub fn cancel(&self) {
        self.active.store(false, Ordering::SeqCst);
        self.done.send_replace(true);
    }

    /// Observe the real scope drain. Canceling this waiter leaves that owner
    /// running. An unknown receipt fails closed and retains the input forever
    /// unless the same scope later produces a positive real completion.
    pub async fn close_and_drain(&self) -> Result<()> {
        self.cancel();
        let mut drained = self.drained.clone();
        loop {
            match *drained.borrow_and_update() {
                Drain::Complete => return Ok(()),
                Drain::Unknown => anyhow::bail!("static_hls_encoder_input_owner_unknown"),
                Drain::Pending => (),
            }
            drained
                .changed()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_encoder_input_owner_unknown"))?;
        }
    }
}

impl Drop for EncoderInputLease {
    fn drop(&mut self) {
        // Drop is a stop request, never a statement that FFmpeg has ended.
        self.cancel();
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::static_hls::{
        CaptureBody, CaptureDiagnostic, CaptureEvidence, CaptureFuture, CaptureOwnerIdentity,
        CapturePermit, CaptureTransport, DisposalProof, DisposalState, ProcessDisposition,
        ReadMethod, ReadResource, ResourceIdentity, ResponseFacts, disposal_owner, scanner,
        timeline,
    };
    use sha2::{Digest, Sha256};

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    struct Permit(CaptureOwnerIdentity);
    impl CapturePermit for Permit {
        fn identity(&self) -> CaptureOwnerIdentity {
            self.0.clone()
        }
        fn check(&self) -> CaptureFuture<'_, ()> {
            Box::pin(async { Ok(()) })
        }
        fn acknowledge_disposal(&self, proof: Arc<DisposalProof>) -> CaptureFuture<'_, ()> {
            Box::pin(async move {
                ensure!(proof.all_positive(), "test_actual_drain_required");
                Ok(())
            })
        }
    }

    struct Body {
        url: String,
        etag: String,
        bytes: Option<Vec<u8>>,
        length: usize,
    }
    impl CaptureBody for Body {
        fn facts(&self) -> ResponseFacts {
            ResponseFacts {
                status: 200,
                final_url: self.url.clone(),
                strong_etag: Some(self.etag.clone()),
                content_length: Some(self.length as u64),
                identity_encoding: true,
            }
        }
        fn chunk(&mut self) -> CaptureFuture<'_, Option<Vec<u8>>> {
            Box::pin(async { Ok(self.bytes.take()) })
        }
    }

    struct Transport {
        resources: Vec<(String, Vec<u8>)>,
        requests: Mutex<Vec<usize>>,
        change_last: AtomicBool,
    }
    impl CaptureTransport for Transport {
        fn get<'a>(&'a self, _: &'a str) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
            Box::pin(async { anyhow::bail!("test_conditional_only") })
        }
        fn conditional_get<'a>(
            &'a self,
            target: &'a str,
            identity: &'a ResourceIdentity,
        ) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
            Box::pin(async move {
                let index = self
                    .resources
                    .iter()
                    .position(|(url, _)| url == target)
                    .ok_or_else(|| anyhow::anyhow!("test_unknown_target"))?;
                self.requests.lock().unwrap().push(index);
                let mut bytes = self.resources[index].1.clone();
                if self.change_last.load(Ordering::SeqCst) && index == self.resources.len() - 1 {
                    bytes[0] ^= 1;
                }
                Ok(Box::new(Body {
                    url: target.to_owned(),
                    etag: identity.strong_etag.clone(),
                    length: bytes.len(),
                    bytes: Some(bytes),
                }) as Box<dyn CaptureBody>)
            })
        }
    }

    struct Fixture {
        capture: Arc<VerifiedCapture>,
        factory: Arc<read_lease::Factory>,
        transport: Arc<Transport>,
        root: std::path::PathBuf,
    }

    // These are deliberately nonqualifying bytes and scanner observations.
    // The fixture tests real local custody/drain, never media qualification,
    // durable admission, Worker/job authority, or public FFmpeg acceptance.
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("encoder-owned-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let capture_id = uuid::Uuid::new_v4().to_string();
        let identity = CaptureOwnerIdentity {
            relative_key: format!("static-hls/{capture_id}"),
            capture_id,
            owner_id: uuid::Uuid::new_v4().to_string(),
        };
        let permit = Arc::new(Permit(identity.clone()));
        let local_manifest = b"#EXTM3U\nunit-owned-descriptor-only\n";
        let resources = [
            ("source.bin", b"source manifest bytes".to_vec()),
            ("init.mp4", b"unit init bytes".to_vec()),
            ("s000.m4s", b"unit first segment".to_vec()),
            ("s001.m4s", b"unit last unread segment".to_vec()),
        ];
        let transport = Arc::new(Transport {
            resources: resources
                .iter()
                .enumerate()
                .map(|(index, (_, bytes))| {
                    (
                        format!("https://unit.invalid/resource-{index}"),
                        bytes.clone(),
                    )
                })
                .collect(),
            requests: Mutex::new(vec![]),
            change_last: AtomicBool::new(false),
        });
        let inventory = transport
            .resources
            .iter()
            .enumerate()
            .map(|(index, (target, bytes))| ResourceIdentity {
                projection: None,
                original_target_sha256: hash(target.as_bytes()),
                final_target_sha256: hash(target.as_bytes()),
                strong_etag: format!("\"unit-{index}\""),
                bytes: bytes.len(),
                sha256: hash(bytes),
            })
            .collect::<Vec<_>>();
        let closure = timeline::ClosureIdentity {
            version: 1,
            manifest_sha256: inventory[0].sha256.clone(),
            manifest_bytes: inventory[0].bytes,
            init: timeline::ResourceIdentity {
                bytes: inventory[1].bytes,
                sha256: inventory[1].sha256.clone(),
            },
            segments: inventory[2..]
                .iter()
                .enumerate()
                .map(|(index, resource)| timeline::SegmentIdentity {
                    index,
                    bytes: resource.bytes,
                    sha256: resource.sha256.clone(),
                    track_ids: vec![],
                })
                .collect(),
        };
        let evidence = CaptureEvidence {
            version: 1,
            actual_bytes: inventory.iter().map(|resource| resource.bytes).sum(),
            inventory,
            closure: closure.clone(),
            timeline: timeline::TimelineProof {
                closure,
                scope: "unit-owned-custody-not-media-qualification".into(),
                source_origin_ms: 0,
                duration_ms: 0.0,
                media_sequence: 0,
                tracks: vec![],
            },
            source_facts: serde_json::json!({"accepted":false,"unit_custody_only":true}),
            elapsed_ms: 0,
            decoder: scanner::DecoderEvidence {
                executable_sha256: "never-started".into(),
                argv_sha256: "never-started".into(),
                manifest_sha256: hash(local_manifest),
                stdout_sha256: "never-started".into(),
                stdout_bytes: 0,
                stderr_bytes: 0,
                exit_code: -1,
                process_tree_reaped: false,
                address_space_bytes: 0,
            },
        };
        let mut directory = OwnedDirectory::create(&root, &identity).unwrap();
        for (index, (name, bytes)) in resources.iter().enumerate() {
            directory.write_complete(name, bytes).unwrap();
            directory
                .read_targets
                .push((name.to_string(), transport.resources[index].0.clone()));
        }
        directory
            .write_complete("index.m3u8", local_manifest)
            .unwrap();
        directory.seal().unwrap();
        let (stop, _) = watch::channel(false);
        let factory = read_lease::Factory::new(
            permit.clone(),
            transport.clone(),
            stop.clone(),
            Instant::now() + Duration::from_secs(10),
        );
        factory.install(directory, &evidence);
        let (disposed, disposal) = watch::channel(DisposalState::Pending);
        let acknowledgment =
            disposal_owner::DisposalOwner::register(identity, permit, disposed).unwrap();
        let (_, diagnostic) = watch::channel(CaptureDiagnostic {
            ready: true,
            failure: None,
        });
        Fixture {
            capture: Arc::new(VerifiedCapture {
                evidence,
                stop: Some(stop),
                disposed: disposal,
                diagnostic,
                acknowledgment: Some(acknowledgment),
                readers: Some(factory.clone()),
            }),
            factory,
            transport,
            root,
        }
    }

    impl Fixture {
        async fn cleanup(self, disposition: ProcessDisposition) {
            self.capture.control().unwrap().cancel();
            self.factory.close_and_drain().await;
            self.factory
                .take_directory()
                .unwrap()
                .unwrap()
                .remove_owned()
                .unwrap();
            std::fs::remove_dir(self.root.join("static-hls")).unwrap();
            std::fs::remove_dir(&self.root).unwrap();
            let owner = self.capture.acknowledgment.as_ref().unwrap();
            owner
                .record_proof(DisposalProof {
                    identity: self.capture.control().unwrap().identity().clone(),
                    streams_closed: true,
                    process_drained: true,
                    process_disposition: disposition,
                    files_removed: true,
                })
                .unwrap();
            assert_eq!(owner.acknowledge().await, DisposalState::Disposed);
        }
    }

    #[tokio::test]
    async fn entire_graph_revalidation_and_same_original_factory_are_required() {
        let fixture = fixture();
        let other = super::tests::fixture();
        let lease = fixture
            .capture
            .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(
            *fixture.transport.requests.lock().unwrap(),
            vec![0, 1, 2, 3]
        );
        lease.check_for(&fixture.capture).await.unwrap();
        assert!(lease.check_for(&other.capture).await.is_err());
        lease.close_and_drain().await.unwrap();
        assert!(lease.descriptor.lock().unwrap().is_none());
        drop(lease);
        fixture.cleanup(ProcessDisposition::NeverStarted).await;
        other.cleanup(ProcessDisposition::NeverStarted).await;
    }

    #[tokio::test]
    async fn manifest_eof_releases_actual_reader_before_encoder_input_admission() {
        let fixture = fixture();
        let witness = fixture.capture.prepare_publication().await.unwrap();
        let mut manifest = fixture
            .capture
            .read(
                super::super::ReadResource::Manifest,
                super::super::ReadMethod::Get,
                None,
            )
            .await
            .unwrap();
        while manifest.chunk().await.unwrap().is_some() {}
        // Retain the finished public body and the original witness. EOF must
        // observe the physical reader's drain, making the second slot usable.
        let input = fixture
            .capture
            .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        input.close_and_drain().await.unwrap();
        drop(input);
        drop(manifest);
        drop(witness);
        fixture.cleanup(ProcessDisposition::NeverStarted).await;
    }

    #[tokio::test]
    async fn encoder_leases_share_two_reader_slots_and_cancel_prevents_new_admission() {
        let fixture = fixture();
        let first = fixture
            .capture
            .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        let second = fixture
            .capture
            .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        assert!(
            fixture
                .capture
                .read(ReadResource::Init, ReadMethod::Get, None)
                .await
                .is_err()
        );
        fixture.capture.control().unwrap().cancel();
        assert!(
            fixture
                .capture
                .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
                .await
                .is_err()
        );
        first.close_and_drain().await.unwrap();
        second.close_and_drain().await.unwrap();
        drop((first, second));
        fixture.cleanup(ProcessDisposition::NeverStarted).await;
    }

    #[tokio::test]
    async fn mutation_of_last_unread_segment_revokes_the_original_owner() {
        let fixture = fixture();
        fixture.transport.change_last.store(true, Ordering::SeqCst);
        assert!(
            fixture
                .capture
                .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
                .await
                .is_err()
        );
        assert_eq!(
            *fixture.transport.requests.lock().unwrap(),
            vec![0, 1, 2, 3]
        );
        assert!(fixture.capture.live_evidence().is_err());
        fixture.cleanup(ProcessDisposition::NeverStarted).await;
    }

    #[tokio::test]
    async fn canceled_drain_waiter_keeps_real_blocking_descriptor_and_custody() {
        let fixture = fixture();
        let lease = fixture
            .capture
            .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        let file = lease
            .descriptor
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .try_clone()
            .unwrap();
        let scope = lease.scope.clone();
        let (release, released) = std::sync::mpsc::channel();
        let (entered, mut began) = watch::channel(false);
        let closed = Arc::new(AtomicBool::new(false));
        let finished = closed.clone();
        let reader = tokio::spawn(async move {
            scope
                .run(crate::child_process::blocking(move || {
                    assert!(file.metadata().unwrap().is_dir());
                    entered.send_replace(true);
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    drop(file);
                    finished.store(true, Ordering::SeqCst);
                }))
                .await
        });
        while !*began.borrow_and_update() {
            began.changed().await.unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(25), lease.close_and_drain())
                .await
                .is_err()
        );
        assert!(!closed.load(Ordering::SeqCst));
        assert!(lease.descriptor.lock().unwrap().is_some());
        assert_eq!(*lease.drained.borrow(), Drain::Pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(25), fixture.factory.close_and_drain())
                .await
                .is_err()
        );
        assert!(
            fixture
                .root
                .join(
                    fixture
                        .capture
                        .control()
                        .unwrap()
                        .identity()
                        .relative_key
                        .clone()
                )
                .join("index.m3u8")
                .exists()
        );
        release.send(()).unwrap();
        reader.await.unwrap().unwrap();
        lease.close_and_drain().await.unwrap();
        assert!(closed.load(Ordering::SeqCst));
        assert!(lease.descriptor.lock().unwrap().is_none());
        drop(lease);
        fixture.cleanup(ProcessDisposition::NeverStarted).await;
    }

    #[tokio::test]
    async fn managed_spawn_inherits_owned_input_and_reaps_descendant_before_release() {
        use std::os::fd::AsRawFd;
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;
        let fixture = fixture();
        let lease = fixture
            .capture
            .prepare_encoder_input(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        let mut child = lease
            .spawn(&fixture.capture, |directory| {
                let mut command = tokio::process::Command::new("/bin/sh");
                command
                    .arg("-c")
                    .arg(format!(
                        "cat /proc/self/fd/{}/index.m3u8; sleep 60 & exit 0",
                        directory.as_raw_fd()
                    ))
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                Ok(command)
            })
            .await
            .unwrap();
        assert!(
            lease
                .spawn(&fixture.capture, |_| Ok(tokio::process::Command::new(
                    "/bin/true"
                )))
                .await
                .is_err()
        );
        let mut output = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(2),
            child.stdout.take().unwrap().read_to_end(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(output, b"#EXTM3U\nunit-owned-descriptor-only\n");
        assert!(
            tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        // The process-tree owner's wait, not a lease flag or Drop, observed
        // descendant reap. The lease still retains custody until its own drain.
        assert!(lease.descriptor.lock().unwrap().is_some());
        lease.close_and_drain().await.unwrap();
        assert!(lease.descriptor.lock().unwrap().is_none());
        drop((child, lease));
        fixture.cleanup(ProcessDisposition::Reaped).await;
    }
}
