//! Caller liveness tests with a real controlled blocking file writer. Its gate
//! is deliberate synchronization, not an OS-uninterruptible IO simulation.
//! Admission/reservation counts here are isolated unit witnesses, never DB proof.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Witness {
    held: AtomicBool,
    writer_closed: AtomicBool,
    proofs: AtomicUsize,
    acknowledgments: AtomicUsize,
}
struct BlockingOwner {
    handle: CaptureHandle,
    release: std::sync::mpsc::Sender<()>,
    disposal: watch::Receiver<DisposalState>,
    diagnostic: watch::Receiver<CaptureDiagnostic>,
    witness: Arc<Witness>,
    task: tokio::task::JoinHandle<()>,
}
/// Deliberately nonqualifying data for waiter state-machine tests only. It is
/// never run through a scanner or represented as usable media/admission proof.
fn nonqualifying_evidence() -> CaptureEvidence {
    let closure = serde_json::json!({"version":1,"manifest_sha256":"unit-only","manifest_bytes":0,
        "init":{"bytes":0,"sha256":"unit-only"},"segments":[]});
    let mut timeline = closure.clone();
    timeline["scope"] = "waiter-unit-no-media-qualification".into();
    timeline["source_origin_ms"] = 0.into();
    timeline["duration_ms"] = 0.into();
    timeline["media_sequence"] = 0.into();
    timeline["tracks"] = serde_json::json!([]);
    serde_json::from_value(serde_json::json!({"version":1,"inventory":[],"closure":closure,"timeline":timeline,
        "source_facts":{"accepted":false,"isolated_waiter_test":true},"actual_bytes":0,"elapsed_ms":0,
        "decoder":{"executable_sha256":"never-started","argv_sha256":"never-started",
            "manifest_sha256":"unit-only","stdout_sha256":"never-started","stdout_bytes":0,"stderr_bytes":0,
            "exit_code":-1,"process_tree_reaped":false,"address_space_bytes":0}})).unwrap()
}
async fn blocking_owner() -> BlockingOwner {
    use std::io::Write;
    let root = std::env::temp_dir().join(format!("hls-waiter-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let identity = CaptureOwnerIdentity {
        relative_key: format!("static-hls/{id}"),
        capture_id: id,
        owner_id: uuid::Uuid::new_v4().to_string(),
    };
    let mut directory = owned_directory::OwnedDirectory::create(&root, &identity).unwrap();
    directory.before_write("held.m4s", 10).unwrap();
    let mut file = directory.create_file("held.m4s").unwrap();
    let scope = crate::child_process::Scope::new();
    let (release, released) = std::sync::mpsc::channel();
    let (entered, mut began) = watch::channel(false);
    let (send, receive) = oneshot::channel();
    let (stop, _stopped) = watch::channel(false);
    let (disposed, disposal) = watch::channel(DisposalState::Pending);
    let (diagnostic, diagnostics) = watch::channel(CaptureDiagnostic::default());
    let witness = Arc::new(Witness {
        held: AtomicBool::new(true),
        writer_closed: AtomicBool::new(false),
        proofs: AtomicUsize::new(0),
        acknowledgments: AtomicUsize::new(0),
    });
    let observed = witness.clone();
    let task = tokio::spawn(async move {
        let writer_scope = scope.clone();
        let closed = observed.clone();
        let writer = tokio::spawn(async move {
            writer_scope
                .run(crate::child_process::blocking(move || {
                    entered.send_replace(true);
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    file.write_all(b"held bytes").unwrap();
                    file.sync_all().unwrap();
                    drop(file);
                    closed.writer_closed.store(true, Ordering::SeqCst);
                }))
                .await
        });
        // Registration precedes entry. Wait for the real blocking operation to
        // hold its file, then preserve the known failure while draining forever
        // if necessary. A public waiter does not cancel this cleanup owner.
        while !*began.borrow_and_update() {
            began.changed().await.unwrap();
        }
        diagnostic
            .send_modify(|value| value.failure = Some("known_capture_failure_fixture".into()));
        scope.shutdown().await.unwrap();
        writer.await.unwrap().unwrap();
        assert!(observed.writer_closed.load(Ordering::SeqCst));
        directory.remove_owned().unwrap();
        drop(directory);
        std::fs::remove_dir(root.join("static-hls")).unwrap();
        std::fs::remove_dir(root).unwrap();
        let proof = DisposalProof {
            identity,
            streams_closed: true,
            process_drained: true,
            process_disposition: ProcessDisposition::NeverStarted,
            files_removed: true,
        };
        assert!(proof.all_positive());
        observed.proofs.fetch_add(1, Ordering::SeqCst);
        // Isolated acknowledgment only after the actual drain/deletion proof.
        observed.acknowledgments.fetch_add(1, Ordering::SeqCst);
        observed.held.store(false, Ordering::SeqCst);
        disposed.send_replace(DisposalState::Disposed);
        let _ = send.send(Err(anyhow::anyhow!("known_capture_failure_fixture")));
    });
    let handle = CaptureHandle {
        receiver: Some(receive),
        stop: Some(stop),
        disposed: disposal.clone(),
        diagnostic: diagnostics.clone(),
    };
    // Observe the known failure: that can only be set after the writer entered.
    while diagnostics.borrow().failure.is_none() {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    BlockingOwner {
        handle,
        release,
        disposal,
        diagnostic: diagnostics,
        witness,
        task,
    }
}
fn pending(owner: &BlockingOwner) {
    assert!(!owner.witness.writer_closed.load(Ordering::SeqCst));
    assert!(owner.witness.held.load(Ordering::SeqCst));
    assert_eq!(owner.witness.proofs.load(Ordering::SeqCst), 0);
    assert_eq!(owner.witness.acknowledgments.load(Ordering::SeqCst), 0);
    assert_eq!(*owner.disposal.borrow(), DisposalState::Pending);
}
async fn released(owner: BlockingOwner) {
    owner.release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), owner.task)
        .await
        .unwrap()
        .unwrap();
    assert!(owner.witness.writer_closed.load(Ordering::SeqCst));
    assert!(!owner.witness.held.load(Ordering::SeqCst));
    assert_eq!(owner.witness.proofs.load(Ordering::SeqCst), 1);
    assert_eq!(owner.witness.acknowledgments.load(Ordering::SeqCst), 1);
    assert_eq!(*owner.disposal.borrow(), DisposalState::Disposed);
}

#[tokio::test]
async fn capture_waiter_returns_pending_without_dropping_the_real_cleanup_owner() {
    let mut owner = blocking_owner().await;
    let replacement = CaptureHandle {
        receiver: None,
        stop: None,
        disposed: owner.disposal.clone(),
        diagnostic: owner.diagnostic.clone(),
    };
    let handle = std::mem::replace(&mut owner.handle, replacement);
    let began = tokio::time::Instant::now();
    let error = handle
        .wait_with_budget(Duration::from_millis(25))
        .await
        .err()
        .unwrap();
    let timeout = error.downcast_ref::<WaiterTimeout>().unwrap();
    assert_eq!(timeout.operation, WaiterOperation::Capture);
    assert_eq!(timeout.disposal_state, DisposalState::Pending);
    assert_eq!(
        timeout.last_capture_failure.as_deref(),
        Some("known_capture_failure_fixture")
    );
    assert!(began.elapsed() < Duration::from_secs(1));
    pending(&owner);
    released(owner).await;
}

#[tokio::test]
async fn disposal_waiter_returns_pending_and_later_real_disposal_is_distinct() {
    let owner = blocking_owner().await;
    let disposal = owner.disposal.clone();
    // Only the caller disposal wrapper is under test, with nonqualifying data.
    let capture = VerifiedCapture {
        evidence: nonqualifying_evidence(),
        stop: None,
        disposed: disposal.clone(),
        diagnostic: owner.diagnostic.clone(),
    };
    let error = capture
        .dispose_with_budget(Duration::from_millis(25))
        .await
        .unwrap_err();
    let timeout = error.downcast_ref::<WaiterTimeout>().unwrap().clone();
    assert_eq!(timeout.operation, WaiterOperation::Disposal);
    assert_eq!(timeout.disposal_state, DisposalState::Pending);
    pending(&owner);
    released(owner).await;
    assert_eq!(*disposal.borrow(), DisposalState::Disposed);
    // Caller deadline failure is immutable; later actual cleanup is a separate
    // observation and cannot retrospectively turn that call into success.
    assert_eq!(timeout.disposal_state, DisposalState::Pending);
}

#[tokio::test]
async fn expired_deadline_does_not_poll_an_already_ready_result() {
    let polled = AtomicBool::new(false);
    let value = observe_until(
        async {
            polled.store(true, Ordering::SeqCst);
            17
        },
        tokio::time::Instant::now() - Duration::from_millis(1),
    )
    .await;
    assert!(value.is_none());
    assert!(!polled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn completion_after_deadline_is_reported_with_its_real_terminal_state() {
    let (state, observed) = watch::channel(DisposalState::Pending);
    let (_, diagnostic) = watch::channel(CaptureDiagnostic::default());
    let until = tokio::time::Instant::now() + Duration::from_millis(1);
    let completed = observe_until(
        async {
            // Deliberately overrun one poll to exercise the after-completion check.
            std::thread::sleep(Duration::from_millis(5));
            state.send_replace(DisposalState::Disposed);
        },
        until,
    )
    .await;
    assert!(completed.is_none());
    let error = waiter_timeout(WaiterOperation::Disposal, &observed, &diagnostic);
    assert_eq!(
        error
            .downcast_ref::<WaiterTimeout>()
            .unwrap()
            .disposal_state,
        DisposalState::Disposed
    );
}

#[tokio::test]
async fn late_disposed_or_unresolved_capture_cannot_create_a_verified_handle() {
    for terminal in [DisposalState::Disposed, DisposalState::Unresolved] {
        let (send, receiver) = oneshot::channel();
        let _ = send.send(Ok(nonqualifying_evidence()));
        let (stop, _) = watch::channel(false);
        let (_, disposed) = watch::channel(terminal);
        let (_, diagnostic) = watch::channel(CaptureDiagnostic {
            ready: true,
            failure: None,
        });
        let handle = CaptureHandle {
            receiver: Some(receiver),
            stop: Some(stop),
            disposed,
            diagnostic,
        };
        assert_eq!(
            handle.wait().await.err().unwrap().to_string(),
            "static_hls_capture_retired"
        );
    }
}

#[tokio::test]
async fn queued_success_after_retirement_or_owner_loss_is_not_verified() {
    for owner_alive in [true, false] {
        let (send, receiver) = oneshot::channel();
        send.send(Ok(nonqualifying_evidence())).unwrap();
        let (state, disposed) = watch::channel(DisposalState::Pending);
        let (diagnostic_owner, diagnostic) = watch::channel(CaptureDiagnostic {
            ready: !owner_alive,
            failure: None,
        });
        let keep_owners = if owner_alive {
            Some((state, diagnostic_owner))
        } else {
            drop(state);
            drop(diagnostic_owner);
            None
        };
        let handle = CaptureHandle {
            receiver: Some(receiver),
            stop: None,
            disposed,
            diagnostic,
        };
        let error = handle
            .wait_with_budget(Duration::from_millis(25))
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            if owner_alive {
                "static_hls_capture_retired"
            } else {
                "static_hls_owner_unresolved"
            }
        );
        drop(keep_owners);
    }
}

#[tokio::test]
async fn capture_budget_starts_at_call_even_for_a_queued_success() {
    let (send, receiver) = oneshot::channel();
    send.send(Ok(nonqualifying_evidence())).unwrap();
    let (_state, disposed) = watch::channel(DisposalState::Pending);
    let (_diagnostic_owner, diagnostic) = watch::channel(CaptureDiagnostic {
        ready: true,
        failure: None,
    });
    let handle = CaptureHandle {
        receiver: Some(receiver),
        stop: None,
        disposed,
        diagnostic,
    };
    let future = handle.wait_with_budget(Duration::from_millis(25));
    tokio::time::sleep(Duration::from_millis(35)).await;
    let error = future.await.err().unwrap();
    assert_eq!(
        error.downcast_ref::<WaiterTimeout>().unwrap().operation,
        WaiterOperation::Capture
    );
}

#[tokio::test]
async fn disposal_after_the_call_deadline_does_not_rewrite_caller_success() {
    let owner = blocking_owner().await;
    let witness = owner.witness.clone();
    let capture = VerifiedCapture {
        evidence: nonqualifying_evidence(),
        stop: None,
        disposed: owner.disposal.clone(),
        diagnostic: owner.diagnostic.clone(),
    };
    let future = capture.dispose_with_budget(Duration::from_millis(25));
    tokio::time::sleep(Duration::from_millis(35)).await;
    pending(&owner);
    released(owner).await;
    // Actual cleanup+isolated acknowledgment happened only after the deadline
    // and writer release. The caller still receives a missed-deadline result.
    let error = future.await.unwrap_err();
    let timeout = error.downcast_ref::<WaiterTimeout>().unwrap();
    assert_eq!(timeout.operation, WaiterOperation::Disposal);
    assert_eq!(timeout.disposal_state, DisposalState::Disposed);
    assert_eq!(witness.acknowledgments.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn queued_failure_keeps_its_reason_after_disposal_or_unresolved_retirement() {
    for terminal in [DisposalState::Disposed, DisposalState::Unresolved] {
        for close_owners in [true, false] {
            let (send, receiver) = oneshot::channel();
            send.send(Err(anyhow::anyhow!("static_hls_source_changed")))
                .unwrap();
            let (state, disposed) = watch::channel(terminal.clone());
            let (diagnostic_owner, diagnostic) = watch::channel(CaptureDiagnostic {
                ready: false,
                failure: Some("static_hls_source_changed".into()),
            });
            let keep_owners = if close_owners {
                drop(state);
                drop(diagnostic_owner);
                None
            } else {
                Some((state, diagnostic_owner))
            };
            let handle = CaptureHandle {
                receiver: Some(receiver),
                stop: None,
                disposed,
                diagnostic,
            };
            assert_eq!(
                handle.wait().await.err().unwrap().to_string(),
                "static_hls_source_changed"
            );
            drop(keep_owners);
        }
    }
}

#[tokio::test]
async fn expired_queued_failure_is_timeout_with_the_original_failure_observed() {
    let (send, receiver) = oneshot::channel();
    send.send(Err(anyhow::anyhow!("static_hls_source_changed")))
        .unwrap();
    let (state, disposed) = watch::channel(DisposalState::Disposed);
    let (diagnostic_owner, diagnostic) = watch::channel(CaptureDiagnostic {
        ready: false,
        failure: Some("static_hls_source_changed".into()),
    });
    drop(state);
    drop(diagnostic_owner);
    let handle = CaptureHandle {
        receiver: Some(receiver),
        stop: None,
        disposed,
        diagnostic,
    };
    let future = handle.wait_with_budget(Duration::from_millis(25));
    tokio::time::sleep(Duration::from_millis(35)).await;
    let error = future.await.err().unwrap();
    let timeout = error.downcast_ref::<WaiterTimeout>().unwrap();
    assert_eq!(timeout.disposal_state, DisposalState::Disposed);
    assert_eq!(
        timeout.last_capture_failure.as_deref(),
        Some("static_hls_source_changed")
    );
}

#[test]
fn production_waiter_constants_and_shortening_rules_are_explicit() {
    assert_eq!(CAPTURE_TIME, Duration::from_secs(35));
    assert_eq!(CAPTURE_WAITER_TIME, Duration::from_secs(40));
    assert_eq!(DISPOSAL_WAITER_TIME, Duration::from_secs(10));
    assert_eq!(DISPOSAL_ACK_TIMEOUT, Duration::from_secs(5));
    for maximum in [CAPTURE_WAITER_TIME, DISPOSAL_WAITER_TIME] {
        assert!(validate_waiter_budget(Duration::ZERO, maximum).is_err());
        assert!(validate_waiter_budget(maximum + Duration::from_millis(1), maximum).is_err());
        assert!(validate_waiter_budget(maximum, maximum).is_ok());
        assert!(validate_waiter_budget(Duration::from_millis(25), maximum).is_ok());
    }
}
