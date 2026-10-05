//! Release only the independent child OUTPUT reservation after real disposal.
//!
//! The original directory owner has already drained the original managed input
//! process, its own output scope and removed its exact owned directory before
//! minting the opaque proof consumed here. Rows, paths, expiry, an execution
//! receipt and a missing Worker registry cannot manufacture that proof.
//! This does no filesystem work and never releases the input-capture reservation.
use anyhow::{Result, ensure};
use media_core::static_hls::{
    CaptureFuture, ProcessDisposition,
    child_output_owner::{ChildOutputDisposalProof, OutputPermit},
};
use serde_json::Value;
use sqlx::{Connection, Postgres, Row, Transaction};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::{sync::OwnedMutexGuard, time::Instant};
use uuid::Uuid;

use crate::{
    static_hls_child_jobs::ChildJobExecution,
    static_hls_child_output::{
        ChildOutputReservation, ChildOutputReservationIdentity, ChildOutputWritePermit,
        OUTPUT_RESERVATION_BYTES,
    },
};

const OBSERVATION_TIME: Duration = Duration::from_millis(750);

#[derive(Debug, Eq, PartialEq)]
pub enum CleanupAcknowledgment {
    /// Exact disposal and removal of the 32 MiB reservation were committed.
    Released,
    /// Keep this SAME operation, original permit and opaque proof. Observing
    /// again serializes with the uncertain transaction, using the SAME token.
    CommitUnknown,
}

#[derive(Eq, PartialEq)]
enum State {
    Prepared,
    CommitUnknown,
    Released,
}

/// Install this non-Clone, nonserializable operation in the original Worker's
/// retained registry before awaiting `acknowledge`. A dropped/cancelled waiter
/// cannot replace it with a new cleanup token or a database-reconstructed owner.
/// The original permit issues only one cleanup operation, even with equal IDs.
pub struct ChildOutputCleanup {
    operation: Uuid,
    permit: Arc<ChildOutputWritePermit>,
    proof: Arc<ChildOutputDisposalProof>,
    state: State,
}

// Hold the same original lock pair through the final synchronous acknowledgment.
// Field drop order releases reservation BEFORE execution, matching lock order.
struct CompletedCleanup {
    reservation: OwnedMutexGuard<ChildOutputReservation>,
    _execution: OwnedMutexGuard<ChildJobExecution>,
}

impl ChildOutputCleanup {
    /// Consumes handles to the actual positive proof and the actual admitted
    /// permit. Equal identity metadata on another Arc is expressly insufficient.
    /// This accepts stopped/expired original owners solely for cleanup, without
    /// granting write, publication, renewal or serving authority.
    pub fn prepare(
        permit: Arc<ChildOutputWritePermit>,
        proof: Arc<ChildOutputDisposalProof>,
    ) -> Result<Self> {
        require_original(&permit, &proof)?;
        let operation = Uuid::new_v4();
        // The flag lives on the original permit, not this waiter. Cancellation
        // or unknown COMMIT therefore cannot mint a replacement operation.
        permit.register_cleanup_operation(operation)?;
        Ok(Self {
            operation,
            permit,
            proof,
            state: State::Prepared,
        })
    }

    pub fn must_retain(&self) -> bool {
        self.state != State::Released
    }

    /// Capture the absolute observation deadline synchronously at invocation.
    /// Both original mutexes, pool/BEGIN, ordered SQL and COMMIT spend the SAME
    /// 750 ms. In particular a delayed first poll cannot restart this budget.
    /// A cancellation or ANY error retains the same opaque proof and operation.
    pub fn acknowledge(&mut self) -> CaptureFuture<'_, CleanupAcknowledgment> {
        let until = Instant::now() + OBSERVATION_TIME;
        if self.state != State::Released {
            // No await before revoking a definite local outcome.
            self.state = State::CommitUnknown;
        }
        Box::pin(async move {
            if self.state == State::Released {
                ensure!(
                    Instant::now() < until,
                    "static_hls_child_output_cleanup_timeout"
                );
                return Ok(CleanupAcknowledgment::Released);
            }
            let completed = complete_observation_before(until, self.observe()).await?;
            let Some(mut completed) = completed else {
                return Ok(CleanupAcknowledgment::CommitUnknown);
            };
            // This is after positively acknowledged COMMIT AND the strict
            // absolute-deadline check, while holding the SAME original locks.
            completed.reservation.mark_disposed();
            self.state = State::Released;
            Ok(CleanupAcknowledgment::Released)
        })
    }

    async fn observe(&self) -> Result<Option<CompletedCleanup>> {
        require_original(&self.permit, &self.proof)?;
        let (pool, original_execution, original_reservation) = self.permit.original_parts();
        // Existing original-object lock order, never reservation -> execution.
        let execution = Arc::clone(original_execution).lock_owned().await;
        let reservation = Arc::clone(original_reservation).lock_owned().await;
        let claim = execution.claim();
        reservation.require_claim(claim)?;
        reservation.require_input_owner(execution.input_lease()?)?;
        let identity = reservation.retained_identity();
        ensure!(
            self.proof.identity().job_id() == identity.job.to_string()
                && self.proof.identity().owner_id() == identity.owner.to_string()
                && self.proof.identity().attempt() == identity.attempt
                && self.proof.identity().relative_key() == identity.relative_dir,
            "static_hls_child_output_disposal_identity_required"
        );
        // This path intentionally never calls claim.check_local, check_current,
        // input.check_live_for or a current-authority prefix. The positive real
        // disposal owner can finish after every original live fence expires.
        let mut connection = pool.acquire().await?;
        // A timed-out/cancelled BEGIN, statement or COMMIT must not return an
        // unresolved physical connection to the pool. Next observation locks
        // the same budget row to serialize with this exact prior transaction.
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        claim.configure_cleanup(&mut tx).await?;
        sqlx::query(
            "SELECT set_config('rainsync.static_hls_child_output_disposal_operation',$1,true)",
        )
        .bind(self.operation.to_string())
        .execute(&mut *tx)
        .await?;

        // Cleanup lock order: budget -> exact job -> output -> cache ->
        // reservation. No authority/source prefix is acquired after this row.
        sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
        let stored: Option<Value> = sqlx::query_scalar(
            "SELECT spec FROM media_jobs WHERE id=$1 AND session_id=$1 AND logical_queue='static_hls_v1' AND attempt=$3 AND static_hls_child_output_disposal_owner_allowed(id,$2,$3) FOR UPDATE",
        )
        .bind(identity.job)
        .bind(identity.owner)
        .bind(identity.attempt)
        .fetch_optional(&mut *tx)
        .await?;
        ensure!(
            stored
                == Some(serde_json::from_slice::<Value>(
                    &claim.spec().private_storage_plaintext()?
                )?),
            "static_hls_child_output_original_cleanup_claim_required"
        );

        // The retained receipt outlives output/reservation rows. Only this
        // original operation/proof can use it to reconcile a lost COMMIT reply.
        let receipt = sqlx::query(
            "SELECT id,job_id,attempt,owner_id,execution_id,capture_id,input_sha256,root_digest,relative_dir,process_disposition,directory_device::text AS directory_device,directory_inode::text AS directory_inode,disposed_at IS NOT NULL AND isfinite(disposed_at) AS disposed FROM static_hls_child_output_disposals WHERE job_id=$1 ORDER BY attempt FOR UPDATE",
        )
        .bind(identity.job)
        .fetch_all(&mut *tx)
        .await?;
        if !receipt.is_empty() {
            ensure!(
                receipt.len() == 1,
                "static_hls_child_output_disposal_receipt_conflict"
            );
            require_receipt(&receipt[0], self.operation, &identity, &self.proof)?;
            require_absent(&mut tx, identity.job).await?;
            require_original(&self.permit, &self.proof)?;
            if tx.commit().await.is_err() {
                return Ok(None);
            }
            return Ok(Some(CompletedCleanup {
                reservation,
                _execution: execution,
            }));
        }

        let outputs = sqlx::query(
            "SELECT job_id,attempt,owner_id,relative_dir,status,validation_version FROM media_outputs WHERE job_id=$1 ORDER BY attempt FOR UPDATE",
        )
        .bind(identity.job)
        .fetch_all(&mut *tx)
        .await?;
        ensure!(
            outputs.len() == 1,
            "static_hls_child_output_cleanup_output_required"
        );
        let output = &outputs[0];
        let status: String = output.try_get("status")?;
        let version: i32 = output.try_get("validation_version")?;
        ensure!(
            output.try_get::<Uuid, _>("job_id")? == identity.job
                && output.try_get::<i64, _>("attempt")? == identity.attempt
                && output.try_get::<Option<Uuid>, _>("owner_id")? == Some(identity.owner)
                && output.try_get::<String, _>("relative_dir")? == identity.relative_dir
                && ((matches!(status.as_str(), "writing" | "failed") && version == 0)
                    || (status == "published" && version == 4)),
            "static_hls_child_output_original_cleanup_output_required"
        );
        let cache = sqlx::query(
            "SELECT cache_key FROM cache_entries WHERE id=$1 OR cache_key=$1::text ORDER BY cache_key FOR UPDATE",
        )
        .bind(identity.job)
        .fetch_all(&mut *tx)
        .await?;
        // Child resources live in the dedicated complete-publication evidence,
        // not generic cache entries. Unexpected generic artifacts stay closed;
        // a disposal receipt must not become a general-purpose eviction token.
        ensure!(
            cache.is_empty(),
            "static_hls_child_output_cleanup_cache_conflict"
        );
        // Public child readers remain closed in this slice. Refuse even an
        // expired/unscoped lease; lease expiry is not an output drain witness.
        let readers: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=$1)")
                .bind(identity.job)
                .fetch_one(&mut *tx)
                .await?;
        ensure!(!readers, "static_hls_child_output_cleanup_readers_present");
        let held = sqlx::query(
            "SELECT owner_id,attempt,bytes,purpose FROM cache_write_reservations WHERE job_id=$1 FOR UPDATE",
        )
        .bind(identity.job)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_cleanup_reservation_required"))?;
        ensure!(
            held.try_get::<Uuid, _>("owner_id")? == identity.owner
                && held.try_get::<i64, _>("attempt")? == identity.attempt
                && held.try_get::<i64, _>("bytes")? == i64::try_from(OUTPUT_RESERVATION_BYTES)?
                && held.try_get::<String, _>("purpose")? == "static_hls_child_output",
            "static_hls_child_output_original_cleanup_reservation_required"
        );

        let inserted = sqlx::query(
            "INSERT INTO static_hls_child_output_disposals(id,job_id,attempt,owner_id,execution_id,capture_id,input_sha256,root_digest,relative_dir,process_disposition,directory_device,directory_inode,disposed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::numeric,$12::text::numeric,clock_timestamp())",
        )
        .bind(self.operation)
        .bind(identity.job)
        .bind(identity.attempt)
        .bind(identity.owner)
        .bind(identity.execution)
        .bind(identity.capture)
        .bind(identity.input_sha256)
        .bind(identity.root_digest)
        .bind(identity.relative_dir)
        .bind(disposition(&self.proof))
        .bind(self.proof.directory_device().to_string())
        .bind(self.proof.directory_inode().to_string())
        .execute(&mut *tx)
        .await?
        .rows_affected();
        ensure!(
            inserted == 1,
            "static_hls_child_output_disposal_receipt_unconfirmed"
        );
        // Delete only the exact child output. File rows cascade from this exact
        // attempt; immutable publication evidence remains historical.
        let removed = sqlx::query(
            "DELETE FROM media_outputs WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND relative_dir=$4",
        )
        .bind(identity.job)
        .bind(identity.attempt)
        .bind(identity.owner)
        .bind(identity.relative_dir)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        ensure!(
            removed == 1,
            "static_hls_child_output_cleanup_output_unconfirmed"
        );
        let released = sqlx::query(
            "DELETE FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$2 AND attempt=$3 AND bytes=33554432 AND purpose='static_hls_child_output'",
        )
        .bind(identity.job)
        .bind(identity.owner)
        .bind(identity.attempt)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        ensure!(
            released == 1,
            "static_hls_child_output_cleanup_release_unconfirmed"
        );
        // This mutation invalidates disk-admission observations exactly once.
        // Receipt-only recovery above never increments the revision again.
        let revised = sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
            .execute(&mut *tx)
            .await?
            .rows_affected();
        ensure!(
            revised == 1,
            "static_hls_child_output_cleanup_budget_unconfirmed"
        );
        require_absent(&mut tx, identity.job).await?;
        require_original(&self.permit, &self.proof)?;
        if tx.commit().await.is_err() {
            return Ok(None);
        }
        Ok(Some(CompletedCleanup {
            reservation,
            _execution: execution,
        }))
    }
}

fn require_original(
    permit: &Arc<ChildOutputWritePermit>,
    proof: &ChildOutputDisposalProof,
) -> Result<()> {
    let original: Arc<dyn OutputPermit> = permit.clone();
    proof.require_original_permit(&original)?;
    ensure!(
        proof.identity() == &permit.identity(),
        "static_hls_child_output_disposal_identity_required"
    );
    Ok(())
}

fn disposition(proof: &ChildOutputDisposalProof) -> &'static str {
    match proof.process_disposition() {
        ProcessDisposition::NeverStarted => "never_started",
        ProcessDisposition::Reaped => "reaped",
    }
}

fn require_receipt(
    row: &sqlx::postgres::PgRow,
    operation: Uuid,
    identity: &ChildOutputReservationIdentity<'_>,
    proof: &ChildOutputDisposalProof,
) -> Result<()> {
    ensure!(
        row.try_get::<Uuid, _>("id")? == operation
            && row.try_get::<Uuid, _>("job_id")? == identity.job
            && row.try_get::<i64, _>("attempt")? == identity.attempt
            && row.try_get::<Uuid, _>("owner_id")? == identity.owner
            && row.try_get::<Uuid, _>("execution_id")? == identity.execution
            && row.try_get::<Uuid, _>("capture_id")? == identity.capture
            && row.try_get::<String, _>("input_sha256")? == identity.input_sha256
            && row.try_get::<String, _>("root_digest")? == identity.root_digest
            && row.try_get::<String, _>("relative_dir")? == identity.relative_dir
            && row.try_get::<String, _>("process_disposition")? == disposition(proof)
            && row.try_get::<String, _>("directory_device")?
                == proof.directory_device().to_string()
            && row.try_get::<String, _>("directory_inode")? == proof.directory_inode().to_string()
            && row.try_get::<bool, _>("disposed")?,
        "static_hls_child_output_original_disposal_receipt_required"
    );
    Ok(())
}

async fn require_absent(tx: &mut Transaction<'_, Postgres>, job: Uuid) -> Result<()> {
    let absent: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id=$1) AND NOT EXISTS(SELECT 1 FROM media_output_files WHERE job_id=$1) AND NOT EXISTS(SELECT 1 FROM cache_entries WHERE id=$1 OR cache_key=$1::text) AND NOT EXISTS(SELECT 1 FROM cache_read_leases WHERE cache_id=$1) AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=$1)",
    )
    .bind(job)
    .fetch_one(&mut **tx)
    .await?;
    ensure!(absent, "static_hls_child_output_cleanup_atomicity_required");
    Ok(())
}

async fn complete_observation_before<T>(
    until: Instant,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    ensure!(
        Instant::now() < until,
        "static_hls_child_output_cleanup_timeout"
    );
    let result = tokio::time::timeout_at(until, work)
        .await
        .map_err(|_| anyhow::anyhow!("static_hls_child_output_cleanup_timeout"))?;
    // timeout_at may poll a ready future before its timer. A late COMMIT reply
    // therefore stays unknown even if its future was already ready when polled.
    ensure!(
        Instant::now() < until,
        "static_hls_child_output_cleanup_timeout"
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn observation_budget_includes_waiting_for_original_execution_lock() {
        let execution = tokio::sync::Mutex::new(());
        let held = execution.lock().await;
        let until = Instant::now() + Duration::from_millis(10);
        assert!(
            complete_observation_before(until, async {
                let _execution = execution.lock().await;
                Ok(())
            })
            .await
            .is_err()
        );
        drop(held);
    }

    #[tokio::test]
    async fn delayed_first_poll_cannot_restart_cleanup_observation_budget() {
        let until = Instant::now() - Duration::from_millis(1);
        assert!(
            complete_observation_before(until, std::future::ready(Ok(())))
                .await
                .is_err()
        );
    }

    #[test]
    fn cleanup_operation_and_actual_disposal_proof_are_not_clone_or_serializable() {
        trait AmbiguousClone<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        trait AmbiguousSerialize<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <ChildOutputCleanup as AmbiguousClone<_>>::check;
        let _ = <ChildOutputCleanup as AmbiguousSerialize<_>>::check;
        let _ = <ChildOutputDisposalProof as AmbiguousClone<_>>::check;
        let _ = <ChildOutputDisposalProof as AmbiguousSerialize<_>>::check;
    }
}
