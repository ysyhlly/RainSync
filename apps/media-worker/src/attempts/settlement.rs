//! The original attempt's post-execution drain, receipt and budget tail.
//!
//! This view borrows the existing resources so their construction and drop order
//! remain with run_next_job. It does not mint a lease, deadline, owner or budget.
//! The inherited unconfirmed-scope branch still skips ACK/release and returns;
//! retaining that obligation beyond the attempt is a separate behavioral issue.
use crate::{child_process::Scope, output_decode::Gate, readiness};
use sqlx::PgPool;
use std::time::Duration;
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
            loop {
                if matches!(
                    tokio::time::timeout(
                        Duration::from_secs(3),
                        persistence::media_executions::acknowledge_job(db, id, attempt, owner)
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    break;
                }
                tracing::warn!("media execution drain acknowledgement retry");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            // Completion/error/exit all release only after the child is reaped.
            // On database failure, the next budget snapshot uses this receipt.
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                persistence::cache_budget::release(db, id, owner, attempt),
            )
            .await;
        }
        if *self.writer_stopped {
            readiness.receipt_pending(false);
        }
    }
}
