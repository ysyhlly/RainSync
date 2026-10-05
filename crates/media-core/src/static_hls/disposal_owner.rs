//! Original in-process ownership survives an uncertain database acknowledgment.
//! There is deliberately no lookup/mint API accepting an ownership UUID.
use super::{
    CaptureOwnerIdentity, CapturePermit, DISPOSAL_ACK_TIMEOUT, DisposalProof, DisposalState,
};
use anyhow::{Result, ensure};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{Mutex as AsyncMutex, watch};

type Owners = HashMap<String, Arc<DisposalOwner>>;
static OWNERS: OnceLock<Mutex<Owners>> = OnceLock::new();

fn owners() -> &'static Mutex<Owners> {
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) struct DisposalOwner {
    identity: CaptureOwnerIdentity,
    permit: Arc<dyn CapturePermit>,
    proof: OnceLock<Arc<DisposalProof>>,
    disposed: watch::Sender<DisposalState>,
    serial: AsyncMutex<()>,
}

impl DisposalOwner {
    pub(super) fn register(
        identity: CaptureOwnerIdentity,
        permit: Arc<dyn CapturePermit>,
        disposed: watch::Sender<DisposalState>,
    ) -> Result<Arc<Self>> {
        let mut held = owners().lock().expect("original capture owners");
        // A clone of the original admission permit cannot start a second
        // physical owner and acknowledge the first owner's resources.
        ensure!(
            !held.contains_key(&identity.capture_id),
            "static_hls_owner_already_exists"
        );
        let owner = Arc::new(Self {
            identity,
            permit,
            proof: OnceLock::new(),
            disposed,
            serial: AsyncMutex::new(()),
        });
        held.insert(owner.identity.capture_id.clone(), owner.clone());
        Ok(owner)
    }

    pub(super) fn record_proof(&self, proof: DisposalProof) -> Result<()> {
        ensure!(
            proof.identity() == &self.identity,
            "static_hls_disposal_identity_required"
        );
        ensure!(
            self.proof.set(Arc::new(proof)).is_ok(),
            "static_hls_disposal_proof_already_recorded"
        );
        Ok(())
    }

    pub(super) fn retry_available(&self) -> bool {
        *self.disposed.borrow() == DisposalState::Unresolved
            && self.proof.get().is_some_and(|proof| proof.all_positive())
    }

    pub(super) async fn acknowledge(self: &Arc<Self>) -> DisposalState {
        // The complete observation, including a concurrent retry's queue wait,
        // shares the original fixed acknowledgment budget.
        let result = tokio::time::timeout(DISPOSAL_ACK_TIMEOUT, async {
            let _serial = self.serial.lock().await;
            if *self.disposed.borrow() == DisposalState::Disposed {
                return Ok(());
            }
            let proof = self
                .proof
                .get()
                .ok_or_else(|| anyhow::anyhow!("static_hls_disposal_pending"))?;
            ensure!(proof.all_positive(), "static_hls_disposal_unconfirmed");
            self.permit.acknowledge_disposal(proof.clone()).await?;
            self.disposed.send_replace(DisposalState::Disposed);
            let mut held = owners().lock().expect("original capture owners");
            if held
                .get(&self.identity.capture_id)
                .is_some_and(|owner| Arc::ptr_eq(owner, self))
            {
                held.remove(&self.identity.capture_id);
            }
            Ok::<_, anyhow::Error>(())
        })
        .await;
        if !result.is_ok_and(|result| result.is_ok()) {
            // A delayed/error observation cannot downgrade another original
            // holder's positive confirmation. No failure removes this owner.
            self.disposed.send_if_modified(|state| {
                if *state == DisposalState::Disposed {
                    false
                } else {
                    *state = DisposalState::Unresolved;
                    true
                }
            });
        }
        self.disposed.borrow().clone()
    }

    #[cfg(test)]
    fn retained(self: &Arc<Self>) -> bool {
        owners()
            .lock()
            .unwrap()
            .get(&self.identity.capture_id)
            .is_some_and(|owner| Arc::ptr_eq(owner, self))
    }
}

/// A clone of the original local controller, never reconstructed from storage.
/// Retrying only repeats database acknowledgment of the same opaque proof; it
/// does not extend work authority, start IO, or infer physical closure.
#[derive(Clone)]
pub struct CaptureControl {
    pub(super) stop: watch::Sender<bool>,
    pub(super) disposed: watch::Receiver<DisposalState>,
    pub(super) owner: Arc<DisposalOwner>,
}

impl CaptureControl {
    pub fn cancel(&self) {
        self.stop.send_replace(true);
    }
    pub fn disposal_state(&self) -> DisposalState {
        self.disposed.borrow().clone()
    }
    /// Metadata from the retained original owner; this does not mint ownership.
    pub fn identity(&self) -> &CaptureOwnerIdentity {
        &self.owner.identity
    }
    pub fn disposal_retry_available(&self) -> bool {
        self.owner.retry_available()
    }
    pub async fn retry_disposal(&self) -> Result<DisposalState> {
        if self.disposal_state() == DisposalState::Disposed {
            return Ok(DisposalState::Disposed);
        }
        ensure!(
            self.disposal_retry_available(),
            "static_hls_disposal_retry_unavailable"
        );
        Ok(self.owner.acknowledge().await)
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CaptureFuture, ProcessDisposition};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Permit {
        identity: CaptureOwnerIdentity,
        calls: AtomicUsize,
        fail_once: bool,
        hang_once: bool,
        seen: Mutex<Vec<Arc<DisposalProof>>>,
    }
    impl CapturePermit for Permit {
        fn identity(&self) -> CaptureOwnerIdentity {
            self.identity.clone()
        }
        fn check(&self) -> CaptureFuture<'_, ()> {
            Box::pin(async { anyhow::bail!("fixture revoked") })
        }
        fn acknowledge_disposal(&self, proof: Arc<DisposalProof>) -> CaptureFuture<'_, ()> {
            Box::pin(async move {
                assert!(proof.all_positive());
                self.seen.lock().unwrap().push(proof);
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                if call == 0 && self.hang_once {
                    return std::future::pending().await;
                }
                if call == 0 && self.fail_once {
                    anyhow::bail!("fixture acknowledgment lost");
                }
                tokio::task::yield_now().await;
                Ok(())
            })
        }
    }
    fn fixture(fail_once: bool, hang_once: bool) -> (Arc<Permit>, Arc<DisposalOwner>) {
        let identity = CaptureOwnerIdentity {
            capture_id: uuid::Uuid::new_v4().to_string(),
            owner_id: uuid::Uuid::new_v4().to_string(),
            relative_key: "fixture".into(),
        };
        let permit = Arc::new(Permit {
            identity: identity.clone(),
            calls: AtomicUsize::new(0),
            fail_once,
            hang_once,
            seen: Mutex::new(vec![]),
        });
        let (disposed, _) = watch::channel(DisposalState::Pending);
        let owner = DisposalOwner::register(identity.clone(), permit.clone(), disposed).unwrap();
        // Explicit pure witness only, not a runtime disposal acceptance claim.
        owner
            .record_proof(DisposalProof {
                identity,
                streams_closed: true,
                process_drained: true,
                process_disposition: ProcessDisposition::NeverStarted,
                files_removed: true,
            })
            .unwrap();
        (permit, owner)
    }
    #[tokio::test]
    async fn acknowledgment_error_retains_original_proof_and_permit() {
        let (permit, owner) = fixture(true, false);
        assert_eq!(owner.acknowledge().await, DisposalState::Unresolved);
        assert!(owner.retained());
        assert!(owner.retry_available());
        assert_eq!(owner.acknowledge().await, DisposalState::Disposed);
        assert!(!owner.retained());
        let seen = permit.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(Arc::ptr_eq(&seen[0], &seen[1]));
    }
    #[tokio::test]
    async fn concurrent_retries_do_not_repeat_positive_acknowledgment() {
        let (permit, owner) = fixture(true, false);
        assert_eq!(owner.acknowledge().await, DisposalState::Unresolved);
        let (a, b) = tokio::join!(owner.acknowledge(), owner.acknowledge());
        assert_eq!((a, b), (DisposalState::Disposed, DisposalState::Disposed));
        assert_eq!(permit.calls.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn dropping_callers_does_not_erase_uncertain_original_ownership() {
        let (permit, owner) = fixture(true, false);
        assert_eq!(owner.acknowledge().await, DisposalState::Unresolved);
        let original_reference = Arc::downgrade(&owner);
        drop(owner);
        // This is a weak reference to the original object, never a UUID lookup.
        let original = original_reference
            .upgrade()
            .expect("original owner remains retained");
        assert!(original.retained());
        assert_eq!(original.acknowledge().await, DisposalState::Disposed);
        assert_eq!(permit.calls.load(Ordering::SeqCst), 2);
        drop(original);
        assert!(original_reference.upgrade().is_none());
    }
    #[tokio::test]
    async fn acknowledgment_timeout_keeps_proof_for_explicit_retry() {
        let (permit, owner) = fixture(false, true);
        assert_eq!(owner.acknowledge().await, DisposalState::Unresolved);
        assert!(owner.retained());
        assert_eq!(owner.acknowledge().await, DisposalState::Disposed);
        let seen = permit.seen.lock().unwrap();
        assert!(Arc::ptr_eq(&seen[0], &seen[1]));
    }
    #[tokio::test]
    async fn cloned_admission_cannot_create_a_second_live_owner() {
        let (permit, owner) = fixture(false, false);
        let (sender, _) = watch::channel(DisposalState::Pending);
        assert!(DisposalOwner::register(permit.identity(), permit.clone(), sender).is_err());
        assert_eq!(permit.calls.load(Ordering::SeqCst), 0);
        assert_eq!(owner.acknowledge().await, DisposalState::Disposed);
    }
}
