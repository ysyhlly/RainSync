//! The original attempt's post-execution drain, receipt and budget tail.
//!
//! This view borrows the existing resources so their construction and drop order
//! remain with run_next_job. It does not mint a lease, deadline, owner or budget.
//! The inherited unconfirmed-scope branch still skips ACK/release and returns;
//! retaining that obligation beyond the attempt is a separate behavioral issue.
use crate::{child_process::Scope, output_decode::Gate, readiness};
use sqlx::PgPool;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub(crate) struct OriginalAttempt<'a> {
    scope: &'a Scope,
    decoder: &'a Gate,
    reservation: Option<(Uuid, Uuid, i64)>,
    writer_stopped: &'a mut bool,
}

impl<'a> OriginalAttempt<'a> {
    /// Bind only values captured by the current attempt. The tuple identifies
    /// its existing receipt/reservation; it is not a new lease or disposal proof.
    pub(crate) fn from_parts(
        scope: &'a Scope,
        decoder: &'a Gate,
        reservation: Option<(Uuid, Uuid, i64)>,
        writer_stopped: &'a mut bool,
    ) -> Self {
        Self {
            scope,
            decoder,
            reservation,
            writer_stopped,
        }
    }

    /// Keep the original order and outcomes, including retrying receipt SQL
    /// through shutdown and leaving an unconfirmed drain without a positive ACK.
    pub(crate) async fn settle(self, db: &PgPool, readiness: &readiness::Runtime) {
        let settlement_started = Instant::now();
        if self.reservation.is_some() {
            readiness.receipt_pending(true);
        }
        if self.decoder.stop().await.is_err() {
            readiness.drain_failed();
            tracing::error!("first segment decoder could not be reaped");
            // Keep the gate alive and retry cleanup before accepting more work.
            while self.decoder.stop().await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        if self.scope.shutdown().await.is_err() {
            readiness.drain_failed();
            *self.writer_stopped = false;
            tracing::error!("media execution resource drain unconfirmed");
        }
        if *self.writer_stopped
            && let Some((id, owner, attempt)) = self.reservation
        {
            // Both encoder and decoder have positive OS-tree reaping evidence.
            // Persist the receipt independently of job cancellation/lease state.
            // Retain ownership through transient DB failures (also on shutdown).
            let acknowledgement_started = Instant::now();
            let mut failed_calls = 0_u64;
            loop {
                let call = tokio::time::timeout(
                    Duration::from_secs(3),
                    persistence::media_executions::acknowledge_job(db, id, attempt, owner),
                )
                .await;
                let failure_class = match call {
                    Ok(Ok(())) => {
                        if failed_calls > 0 {
                            tracing::info!(
                                job_id = %id,
                                owner_id = %owner,
                                attempt,
                                failed_calls,
                                acknowledgement_elapsed_ms = acknowledgement_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                                "media execution acknowledgement call recovered"
                            );
                        }
                        break;
                    }
                    Ok(Err(_)) => "db_error",
                    Err(_) => "timeout",
                };
                failed_calls = failed_calls.saturating_add(1);
                tracing::warn!(
                    job_id = %id,
                    owner_id = %owner,
                    attempt,
                    failed_calls,
                    failure_class,
                    acknowledgement_elapsed_ms = acknowledgement_started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                    "media execution drain acknowledgement retry"
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            // Completion/error/exit all release only after the child is reaped.
            // On database failure, the next budget snapshot uses this receipt.
            let release_call = tokio::time::timeout(
                Duration::from_secs(3),
                persistence::cache_budget::release(db, id, owner, attempt),
            )
            .await;
            let release_call_outcome = match release_call {
                Ok(Ok(())) => "ok",
                Ok(Err(_)) => "db_error",
                Err(_) => "timeout",
            };
            tracing::debug!(
                job_id = %id,
                owner_id = %owner,
                attempt,
                release_call_outcome,
                "media cache reservation release call completed"
            );
        }
        if *self.writer_stopped {
            readiness.receipt_pending(false);
        }
        tracing::debug!(
            writer_stopped = *self.writer_stopped,
            settlement_elapsed_ms = settlement_started
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
            "media original attempt settlement call completed"
        );
    }
}
