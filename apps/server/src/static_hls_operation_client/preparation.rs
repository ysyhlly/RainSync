//! Initial preparation coordinator. Its caller owns the existing Server
//! preparation lifetime; dropping the public HTTP waiter does not drop it.
//! Public negotiation, native completion and child activation are separate.
#![allow(dead_code)]

use super::{Action, Client, FrozenInput, LoadedOperation, OperationResponse};
use anyhow::{Context, Result, ensure};
use media_core::static_hls::contracts::{input::OperationKind, operation::OperationResult};
use std::{future::Future, time::Duration};
use tokio::time::Instant;

/// An observation of qualification ending is not a native grant or disposal
/// proof. Native completion must separately lock the original live request and
/// consume its exact original custody/receipt before publishing any result.
pub(crate) enum ParentPreparation {
    Published { plan: serde_json::Value },
    QualificationEnded { observation: Box<OperationResponse> },
}

impl Client {
    /// Called only by the original owned preparation task after freeze.
    /// The caller must retain that task independently of its HTTP waiter.
    pub(crate) async fn prepare_owned_parent(
        &self,
        input: &FrozenInput,
        cancelled: impl Future<Output = ()> + Send,
    ) -> Result<ParentPreparation> {
        ensure!(
            input.kind() == OperationKind::Parent,
            "static_hls_parent_input_required"
        );
        let began = Instant::now();
        let loaded = self.load(input).await?;
        // A completed request has a distinct replay path. This coordinator
        // cannot acquire a new preparation lifetime for an old published plan.
        ensure!(
            loaded.publication_pending,
            "static_hls_original_preparation_required"
        );
        let result = async {
            ensure!(
                loaded.current_authority_live,
                "static_hls_preparation_authority_revoked"
            );
            let until = preparation_deadline(began, &loaded, Instant::now())?;
            tokio::pin!(cancelled);
            tokio::select! {
                biased;
                _ = &mut cancelled => Err(anyhow::anyhow!("static_hls_preparation_cancelled")),
                _ = tokio::time::sleep_until(until) => Err(anyhow::anyhow!("static_hls_preparation_expired")),
                result = self.drive_original_parent(input) => result,
            }
        }
        .await;
        if let Err(error) = &result {
            // Revocation of the exact request is independent of receipt loss.
            // It never releases custody, capacity, files or the original owner.
            let cancelled = error.to_string() == "static_hls_preparation_cancelled";
            let code = if cancelled {
                "playback_request_cancelled"
            } else {
                "playback_request_interrupted"
            };
            tokio::time::timeout(
                Duration::from_millis(750),
                loaded.cancel(&self.db, if cancelled { 410 } else { 503 }, code),
            )
            .await
            .context("static_hls_preparation_cancellation_unknown")??;
            // The request fence already prevents late admission/publication.
            // A lost Cancel receipt does not become a positive disposal claim.
            let _ = self.call(input, Action::Cancel).await;
        }
        result
    }

    async fn drive_original_parent(&self, input: &FrozenInput) -> Result<ParentPreparation> {
        // Exactly one creation attempt. A lost creation receipt is followed by
        // an observation of this same operation, never a newly frozen request.
        let mut reply = match self.call(input, Action::Create).await {
            Ok(reply) => reply,
            Err(_) => self.call(input, Action::Query).await?,
        };
        loop {
            let next = match reply.result() {
                OperationResult::ChildQueued { .. } => {
                    anyhow::bail!("static_hls_unexpected_child_response");
                }
                OperationResult::Published { .. } => {
                    let plan = super::super::static_hls_parent_plan::from_original_receipt(
                        &self.db, &self.key, input, &reply,
                    )
                    .await?;
                    let plan = serde_json::to_value(plan)?;
                    return Ok(ParentPreparation::Published { plan });
                }
                OperationResult::Disposed { .. }
                | OperationResult::Refused {
                    capture_id: None, ..
                } => {
                    return Ok(ParentPreparation::QualificationEnded {
                        observation: Box::new(reply),
                    });
                }
                OperationResult::Verified { .. } => {
                    // Verified is the original owner's definite idle publication
                    // state. Retry that same owner after a pre-COMMIT failure;
                    // Working remains Pending and uncertain COMMIT remains Unknown.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    Action::Publish
                }
                OperationResult::Pending { .. }
                | OperationResult::Refused {
                    capture_id: Some(_),
                    ..
                } => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    Action::Query
                }
                OperationResult::Unknown { .. } | OperationResult::CancelRequested { .. } => {
                    anyhow::bail!("static_hls_preparation_unknown");
                }
            };
            reply = match self.call(input, next).await {
                Ok(reply) => reply,
                // Publication may have committed. Observe the original ledger
                // and owner; do not issue a second publication after uncertainty.
                Err(_) if next == Action::Publish => self.call(input, Action::Query).await?,
                Err(error) => return Err(error),
            };
        }
    }
}

pub(super) fn preparation_deadline(
    began: Instant,
    loaded: &LoadedOperation,
    completed: Instant,
) -> Result<Instant> {
    let expires = loaded
        .input
        .preparation_deadline_ms()
        .min(loaded.pending_lease_expires_at_ms)
        .min(loaded.input.root_deadline_ms());
    deadline_after_observation(began, expires, loaded.observed_at_ms, completed)
}

fn deadline_after_observation(
    began: Instant,
    expires_at_ms: u64,
    observed_at_ms: u64,
    completed: Instant,
) -> Result<Instant> {
    let remaining = Duration::from_millis(expires_at_ms.saturating_sub(observed_at_ms))
        .checked_sub(completed.saturating_duration_since(began))
        .filter(|remaining| !remaining.is_zero())
        .context("static_hls_preparation_expired")?;
    completed
        .checked_add(remaining)
        .context("static_hls_preparation_clock_overflow")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charges_the_entire_database_round_trip() {
        let began = Instant::now();
        let completed = began + Duration::from_millis(300);
        let until = deadline_after_observation(began, 10_000, 9_000, completed).unwrap();
        assert_eq!(until, began + Duration::from_secs(1));
        assert_eq!(until - completed, Duration::from_millis(700));
    }

    #[test]
    fn exhausted_or_elapsed_observation_cannot_restart_preparation() {
        let began = Instant::now();
        for (expires, observed, elapsed) in [
            (100, 100, 0),
            (99, 100, 0),
            (200, 100, 100),
            (200, 100, 101),
        ] {
            assert!(
                deadline_after_observation(
                    began,
                    expires,
                    observed,
                    began + Duration::from_millis(elapsed),
                )
                .is_err()
            );
        }
    }

    #[test]
    fn later_observation_does_not_extend_the_original_fence() {
        let began = Instant::now();
        let original = deadline_after_observation(began, 10_000, 9_000, began).unwrap();
        let later = began + Duration::from_millis(400);
        let repeated =
            deadline_after_observation(later, 10_000, 9_400, later + Duration::from_millis(100))
                .unwrap();
        assert_eq!(repeated, original);
    }
}
