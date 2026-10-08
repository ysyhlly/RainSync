//! Original-owner child output admission, with an independent write reservation.
//!
//! This is accounting and a fenced `media_outputs` writing identity only. It
//! cannot be reconstructed from database rows, converted to a generic Claim,
//! used as a filesystem owner, or published. The Worker must separately create
//! and retain the actual output-directory owner before any physical write.
//! Failed, cancelled and uncertain admissions retain their reserved bytes. No
//! release API exists until a real output owner supplies positive cleanup proof;
//! an input/encoder execution receipt does not prove output-directory disposal.
use anyhow::{Result, ensure};
use media_core::static_hls::{
    CaptureFuture, EncoderInputLease,
    child_output_owner::{OutputIdentity, OutputPermit},
};
use serde_json::Value;
use sqlx::{Connection, PgPool, Postgres, Transaction};
use std::{
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};
use uuid::Uuid;

use crate::static_hls_child_jobs::{ChildJobClaim, ChildJobExecution};

pub const OUTPUT_RESERVATION_BYTES: u64 = 32 * 1024 * 1024;
const PERMIT_CHECK_TIME: Duration = Duration::from_millis(750);

#[derive(Debug, Eq, PartialEq)]
pub enum Admission {
    Reserved,
    /// The disk observation predates another reservation mutation. Take a new
    /// cache_budget snapshot and measure disk again before retrying this owner.
    Changed,
    Full,
    /// An existing reservation/output cannot be adopted, even by equal IDs.
    Stale,
    /// Keep this original object. It grants no physical write rights and must
    /// not be retried or replaced with a database-reconstructed owner.
    CommitUnknown,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Failure {
    Recorded,
    /// A positively acknowledged transaction found neither admission row.
    NotAdmitted,
    CommitUnknown,
}

#[derive(Eq, PartialEq)]
enum State {
    Prepared,
    InFlight,
    Writing,
    Publishing,
    Published,
    Disposed,
    CommitUnknown,
    Failed,
    NotAdmitted,
}

/// Install this exact non-Clone, nonserializable identity in the execution
/// registry BEFORE awaiting admission. Dropping/cancelling its waiter does not
/// prove that COMMIT failed or that any actual output writer was drained.
pub struct ChildOutputReservation {
    job: Uuid,
    owner: Uuid,
    attempt: i64,
    execution: Uuid,
    capture: Uuid,
    input_sha256: String,
    root_digest: String,
    spec: Value,
    input_owner: Arc<EncoderInputLease>,
    relative_dir: String,
    state: State,
}

/// The actual directory owner's retained authority adapter. It holds the SAME
/// original execution and reservation objects, never a database projection.
/// Its read-only metadata is not a file owner or disposal proof. The Worker
/// retains these objects independently of an outer HTTP/prepare waiter.
///
/// Lock order is always execution -> reservation. Neither object may retain
/// its output-directory owner, which would create a custody ownership cycle.
pub struct ChildOutputWritePermit {
    pool: PgPool,
    execution: Arc<Mutex<ChildJobExecution>>,
    reservation: Arc<Mutex<ChildOutputReservation>>,
    identity: OutputIdentity,
    root_until: Instant,
    original_input: Arc<EncoderInputLease>,
    cleanup_operation: OnceLock<Uuid>,
    publication_operation: OnceLock<Uuid>,
}

impl ChildOutputWritePermit {
    pub(crate) fn register_publication_operation(&self, id: Uuid) -> Result<()> {
        ensure!(
            self.publication_operation.set(id).is_ok(),
            "static_hls_child_original_publication_operation_required"
        );
        Ok(())
    }
    pub(crate) fn register_cleanup_operation(&self, id: Uuid) -> Result<()> {
        ensure!(
            self.cleanup_operation.set(id).is_ok(),
            "static_hls_child_original_cleanup_operation_required"
        );
        Ok(())
    }
    pub(crate) fn original_parts(
        &self,
    ) -> (
        &PgPool,
        &Arc<Mutex<ChildJobExecution>>,
        &Arc<Mutex<ChildOutputReservation>>,
    ) {
        (&self.pool, &self.execution, &self.reservation)
    }
    /// Mint only AFTER positively confirmed output admission. A cancelled or
    /// unknown admission cannot mint this adapter, even if its rows now exist.
    pub async fn prepare(
        pool: &PgPool,
        execution: Arc<Mutex<ChildJobExecution>>,
        reservation: Arc<Mutex<ChildOutputReservation>>,
    ) -> Result<Arc<Self>> {
        let (identity, root_until, original_input) = {
            let execution = execution.lock().await;
            let mut reservation = reservation.lock().await;
            reservation
                .check_writing(pool, execution.claim(), execution.input_lease()?)
                .await?;
            (
                OutputIdentity::new(
                    reservation.job.to_string(),
                    reservation.attempt,
                    reservation.owner.to_string(),
                )?,
                execution.claim().publication_root_until(),
                execution.input_lease_handle()?,
            )
        };
        Ok(Arc::new(Self {
            pool: pool.clone(),
            execution,
            reservation,
            identity,
            root_until,
            original_input,
            cleanup_operation: OnceLock::new(),
            publication_operation: OnceLock::new(),
        }))
    }

    fn bounded_check(&self, writing: bool) -> CaptureFuture<'_, ()> {
        // Capture one ABSOLUTE deadline at invocation, before this returned
        // future can wait for its first poll. Mutex/pool waits, SQL round trips,
        // COMMIT and final local checks all spend this same fixed budget.
        let until = Instant::now() + PERMIT_CHECK_TIME;
        Box::pin(async move {
            complete_check_before(until, async {
                let execution = self.execution.lock().await;
                let mut reservation = self.reservation.lock().await;
                let result = if writing {
                    reservation
                        .check_writing(&self.pool, execution.claim(), execution.input_lease()?)
                        .await
                } else {
                    reservation
                        .check_current(&self.pool, execution.claim(), execution.input_lease()?)
                        .await
                };
                // A ready-but-late SQL reply never restores authority. This
                // synchronous check runs while holding the original object.
                if result.is_err() || Instant::now() >= until {
                    reservation.state = State::CommitUnknown;
                }
                ensure!(
                    Instant::now() < until,
                    "static_hls_child_output_authority_timeout"
                );
                result
            })
            .await
        })
    }
}

impl OutputPermit for ChildOutputWritePermit {
    fn require_original_input(&self, input: &Arc<EncoderInputLease>) -> Result<()> {
        ensure!(
            Arc::ptr_eq(&self.original_input, input),
            "static_hls_child_output_original_encoder_input_required"
        );
        Ok(())
    }
    fn root_deadline(&self) -> Option<Instant> {
        Some(self.root_until)
    }
    fn identity(&self) -> OutputIdentity {
        self.identity.clone()
    }

    fn check(&self) -> CaptureFuture<'_, ()> {
        self.bounded_check(false)
    }

    fn check_write(&self) -> CaptureFuture<'_, ()> {
        self.bounded_check(true)
    }
}

/// Identity observations only. Actual original permit/claim/input and opaque
/// file proof remain compulsory; copying this cannot mint any capability.
pub(crate) struct ChildOutputReservationIdentity<'a> {
    pub job: Uuid,
    pub owner: Uuid,
    pub attempt: i64,
    pub execution: Uuid,
    pub capture: Uuid,
    pub input_sha256: &'a str,
    pub root_digest: &'a str,
    pub relative_dir: &'a str,
}

impl ChildOutputReservation {
    pub(crate) fn retained_identity(&self) -> ChildOutputReservationIdentity<'_> {
        ChildOutputReservationIdentity {
            job: self.job,
            owner: self.owner,
            attempt: self.attempt,
            execution: self.execution,
            capture: self.capture,
            input_sha256: &self.input_sha256,
            root_digest: &self.root_digest,
            relative_dir: &self.relative_dir,
        }
    }

    pub(crate) fn begin_publication(
        &mut self,
        claim: &ChildJobClaim,
        input: &EncoderInputLease,
    ) -> Result<()> {
        self.check_current_local(claim, input)?;
        // The opaque output proof has already synchronously handed the SAME
        // directory to bounded in-flight custody before this revokes writing.
        self.state = State::Publishing;
        Ok(())
    }
    pub(crate) fn mark_publication_unknown(&mut self) {
        self.state = State::CommitUnknown;
    }
    pub(crate) fn mark_published(&mut self) {
        self.state = State::Published;
    }
    pub(crate) fn mark_disposed(&mut self) {
        self.state = State::Disposed;
    }

    /// Preparation borrows the real claim AND real same-capture input scope.
    /// UUIDs, serialized spec statements and rows cannot call this constructor.
    /// It allocates no files, reserves no bytes and grants no write authority.
    pub fn prepare(claim: &ChildJobClaim, input: &Arc<EncoderInputLease>) -> Result<Self> {
        claim.check_local()?;
        input.check_live_for(claim.capture())?;
        ensure!(
            claim.attempt() == 1,
            "static_hls_child_output_attempt_required"
        );
        Ok(Self {
            job: claim.job_id(),
            owner: claim.owner_id(),
            attempt: claim.attempt(),
            execution: claim.execution_id(),
            capture: Uuid::parse_str(&claim.input().identity_statement().operation_id)?,
            input_sha256: claim.input().input_sha256().to_owned(),
            root_digest: claim.root_statement().root_digest().to_owned(),
            spec: serde_json::from_slice(&claim.spec().private_storage_plaintext()?)?,
            input_owner: input.clone(),
            relative_dir: format!("{}/{}", claim.job_id(), claim.attempt()),
            state: State::Prepared,
        })
    }

    /// Observation only, never an open directory, path capability or proof that
    /// the original Worker owns files at this name. No IO is done by this module.
    pub fn relative_dir(&self) -> &str {
        &self.relative_dir
    }

    /// A known or possibly committed admission retains accounting obligations.
    /// This flag is not a positive database receipt or a filesystem permission.
    pub fn must_retain(&self) -> bool {
        !matches!(
            self.state,
            State::Prepared | State::NotAdmitted | State::Disposed
        )
    }

    pub(crate) fn require_claim(&self, claim: &ChildJobClaim) -> Result<()> {
        ensure!(
            self.job == claim.job_id()
                && self.owner == claim.owner_id()
                && self.attempt == claim.attempt()
                && self.execution == claim.execution_id()
                && self.capture.to_string() == claim.input().identity_statement().operation_id
                && self.input_sha256 == claim.input().input_sha256()
                && self.root_digest == claim.root_statement().root_digest()
                && self.spec
                    == serde_json::from_slice::<Value>(&claim.spec().private_storage_plaintext()?)?,
            "static_hls_child_original_output_reservation_required"
        );
        Ok(())
    }

    pub(crate) fn require_input_owner(&self, input: &EncoderInputLease) -> Result<()> {
        ensure!(
            std::ptr::eq(self.input_owner.as_ref(), input),
            "static_hls_child_original_encoder_input_required"
        );
        Ok(())
    }

    /// Check the original local input owner immediately before a physical
    /// operation. The Worker also needs its separately held directory owner.
    pub fn check_local(&self, claim: &ChildJobClaim, input: &EncoderInputLease) -> Result<()> {
        self.check_current_local(claim, input)?;
        input.check_live_for(claim.capture())?;
        Ok(())
    }

    fn check_current_local(&self, claim: &ChildJobClaim, input: &EncoderInputLease) -> Result<()> {
        ensure!(
            self.state == State::Writing,
            "static_hls_child_output_not_admitted"
        );
        self.require_claim(claim)?;
        self.require_input_owner(input)?;
        claim.check_local()?;
        Ok(())
    }

    /// `revision` must come from cache_budget::snapshot BEFORE measuring disk;
    /// `headroom` is that external measurement's existing writable headroom.
    /// All reservations, including the independent 128 MiB input capture, count.
    /// No filesystem measurement, process or physical write runs under DB locks.
    pub async fn admit(
        &mut self,
        pool: &PgPool,
        claim: &ChildJobClaim,
        input: &EncoderInputLease,
        revision: i64,
        headroom: u64,
    ) -> Result<Admission> {
        self.require_claim(claim)?;
        self.require_input_owner(input)?;
        if matches!(self.state, State::InFlight | State::CommitUnknown) {
            return Ok(Admission::CommitUnknown);
        }
        ensure!(
            self.state == State::Prepared,
            "static_hls_child_output_already_issued"
        );
        claim.check_local()?;
        input.check_live_for(claim.capture())?;
        // Synchronous BEFORE the first await: a cancelled future leaves this
        // original identity retained and can never restart output admission.
        self.state = State::InFlight;
        let mut tx = pool.begin().await?;
        // Ordered authority/source prefix -> budget -> captures/sessions -> job.
        // The budget query below reenters the SAME already-held singleton row.
        claim.lock_current_attempt(&mut tx).await?;
        let current: i64 =
            sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
                .fetch_one(&mut *tx)
                .await?;
        if current != revision {
            tx.rollback().await?;
            self.state = State::Prepared;
            return Ok(Admission::Changed);
        }
        let occupied: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=$1) OR EXISTS(SELECT 1 FROM media_outputs WHERE job_id=$1)",
        )
        .bind(self.job)
        .fetch_one(&mut *tx)
        .await?;
        if occupied {
            tx.rollback().await?;
            self.state = State::NotAdmitted;
            return Ok(Admission::Stale);
        }
        let held: String =
            sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
                .fetch_one(&mut *tx)
                .await?;
        if !fits_headroom(held.parse()?, headroom) {
            tx.rollback().await?;
            self.state = State::Prepared;
            return Ok(Admission::Full);
        }
        claim.check_local()?;
        input.check_live_for(claim.capture())?;
        let reserved = sqlx::query(
            "INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES($1,$2,$3,33554432,'static_hls_child_output')",
        )
        .bind(self.job)
        .bind(self.owner)
        .bind(self.attempt)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        ensure!(
            reserved == 1,
            "static_hls_child_output_reservation_unconfirmed"
        );
        // validation_version=0 expressly attests NO file/decoder validation.
        // The existing v3 incremental publication helper cannot consume it.
        let output = sqlx::query(
            "INSERT INTO media_outputs(job_id,attempt,owner_id,status,relative_dir,validation_version,created_at,cleanup_after) VALUES($1,$2,$3,'writing',$4,0,clock_timestamp(),clock_timestamp())",
        )
        .bind(self.job)
        .bind(self.attempt)
        .bind(self.owner)
        .bind(&self.relative_dir)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        ensure!(output == 1, "static_hls_child_output_write_unconfirmed");
        sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
            .execute(&mut *tx)
            .await?;
        require_writing_rows(&mut tx, self).await?;
        claim.check_before_commit(&mut tx).await?;
        input.check_live_for(claim.capture())?;
        self.state = State::CommitUnknown;
        if tx.commit().await.is_err() {
            return Ok(Admission::CommitUnknown);
        }
        self.state = State::Writing;
        // A late COMMIT acknowledgment retains the reservation but cannot
        // revive local write rights after the original lease/root deadline.
        self.check_local(claim, input)?;
        Ok(Admission::Reserved)
    }

    /// Recheck the actual claim's complete live ordered fence and the committed
    /// writing rows. This never resumes an unknown admission or adopts a row.
    pub async fn check_writing(
        &mut self,
        pool: &PgPool,
        claim: &ChildJobClaim,
        input: &EncoderInputLease,
    ) -> Result<()> {
        self.check_local(claim, input)?;
        self.check_current(pool, claim, input).await?;
        self.check_local(claim, input)
    }

    /// Exact retained claim/current authority and output accounting, independent
    /// of whether the SAME input scope has already positively reaped. This is
    /// not physical write permission or proof of reap. Only the actual output
    /// owner may use it in its internally enforced post-reap read-only phase;
    /// admission, creation, spawn and every write still require check_writing.
    pub async fn check_current(
        &mut self,
        pool: &PgPool,
        claim: &ChildJobClaim,
        input: &EncoderInputLease,
    ) -> Result<()> {
        self.check_current_local(claim, input)?;
        // Any error/cancelled waiter leaves no further local write permission.
        self.state = State::CommitUnknown;
        let mut connection = pool.acquire().await?;
        // A timeout can interrupt BEGIN, a statement, or COMMIT. Never return
        // that physical connection to the pool with an unconfirmed outcome.
        // Dropping the transaction is not a positive rollback/drain receipt.
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        claim.lock_current_attempt(&mut tx).await?;
        require_writing_rows(&mut tx, self).await?;
        claim.check_before_commit(&mut tx).await?;
        tx.commit().await?;
        self.state = State::Writing;
        self.check_current_local(claim, input)
    }

    /// Terminal bookkeeping by the original reservation/claim after logical
    /// stop or expiry. This revokes write rights BEFORE awaiting and deliberately
    /// keeps every reserved byte. It is not a process/file cleanup receipt.
    pub async fn record_failure(
        &mut self,
        pool: &PgPool,
        claim: &ChildJobClaim,
    ) -> Result<Failure> {
        self.require_claim(claim)?;
        ensure!(
            !matches!(self.state, State::Prepared | State::NotAdmitted),
            "static_hls_child_output_not_issued"
        );
        self.state = State::CommitUnknown;
        let mut tx = pool.begin().await?;
        claim.configure_cleanup(&mut tx).await?;
        // Cleanup takes budget first and NEVER acquires a current-authority
        // prefix afterward. It cannot revive a running/dead scheduling lease.
        sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT id FROM media_jobs WHERE id=$1 FOR UPDATE")
            .bind(self.job)
            .execute(&mut *tx)
            .await?;
        let changed = sqlx::query(
            "UPDATE media_outputs o SET status='failed' WHERE o.job_id=$1 AND o.attempt=$2 AND o.owner_id=$3 AND o.relative_dir=$4 AND o.validation_version=0 AND o.status IN ('writing','failed') AND static_hls_child_output_write_owner_allowed(o.job_id,o.owner_id,o.attempt)",
        )
        .bind(self.job)
        .bind(self.attempt)
        .bind(self.owner)
        .bind(&self.relative_dir)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        let absent: bool = sqlx::query_scalar(
            "SELECT NOT EXISTS(SELECT 1 FROM media_outputs WHERE job_id=$1) AND NOT EXISTS(SELECT 1 FROM cache_write_reservations WHERE job_id=$1)",
        )
        .bind(self.job)
        .fetch_one(&mut *tx)
        .await?;
        ensure!(
            changed == 1 || absent,
            "static_hls_child_output_failure_unconfirmed"
        );
        if tx.commit().await.is_err() {
            return Ok(Failure::CommitUnknown);
        }
        if absent {
            self.state = State::NotAdmitted;
            Ok(Failure::NotAdmitted)
        } else {
            self.state = State::Failed;
            Ok(Failure::Recorded)
        }
    }
}

async fn complete_check_before(
    until: Instant,
    work: impl Future<Output = Result<()>>,
) -> Result<()> {
    let result = tokio::time::timeout_at(until, work)
        .await
        .map_err(|_| anyhow::anyhow!("static_hls_child_output_authority_timeout"))?;
    // timeout_at may poll a ready future before its timer. A final strict
    // deadline check therefore also rejects success returned at/after expiry.
    ensure!(
        Instant::now() < until,
        "static_hls_child_output_authority_timeout"
    );
    result
}

fn fits_headroom(held: u128, headroom: u64) -> bool {
    held.checked_add(u128::from(OUTPUT_RESERVATION_BYTES))
        .is_some_and(|required| required <= u128::from(headroom))
}

async fn require_writing_rows(
    tx: &mut Transaction<'_, Postgres>,
    reservation: &ChildOutputReservation,
) -> Result<()> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM media_outputs o JOIN cache_write_reservations r ON r.job_id=o.job_id AND r.owner_id=o.owner_id AND r.attempt=o.attempt WHERE o.job_id=$1 AND o.attempt=$2 AND o.owner_id=$3 AND o.relative_dir=$4 AND o.status='writing' AND o.validation_version=0 AND o.visible_manifest IS NULL AND o.ready_segments=0 AND o.manifest_sha256 IS NULL AND o.segment_count IS NULL AND o.published_at IS NULL AND r.purpose='static_hls_child_output' AND r.bytes=33554432 AND static_hls_child_output_write_authority_allowed(o.job_id,o.owner_id,o.attempt))",
    )
    .bind(reservation.job)
    .bind(reservation.attempt)
    .bind(reservation.owner)
    .bind(&reservation.relative_dir)
    .fetch_one(&mut **tx)
    .await?;
    ensure!(allowed, "static_hls_child_output_write_authority_required");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn whole_check_budget_includes_waiting_for_execution_mutex() {
        let execution = Mutex::new(());
        let held = execution.lock().await;
        let until = Instant::now() + Duration::from_millis(10);
        let result = complete_check_before(until, async {
            let _execution = execution.lock().await;
            Ok(())
        })
        .await;
        assert!(result.is_err());
        drop(held);
    }

    #[tokio::test]
    async fn already_ready_success_cannot_bypass_absolute_check_deadline() {
        let until = Instant::now() - Duration::from_millis(1);
        assert!(
            complete_check_before(until, std::future::ready(Ok(())))
                .await
                .is_err()
        );
    }

    #[test]
    fn independent_output_and_input_bytes_both_consume_headroom() {
        let input = 128 * 1024 * 1024;
        assert!(!fits_headroom(input, OUTPUT_RESERVATION_BYTES));
        assert!(!fits_headroom(
            input,
            input as u64 + OUTPUT_RESERVATION_BYTES - 1
        ));
        assert!(fits_headroom(
            input,
            input as u64 + OUTPUT_RESERVATION_BYTES
        ));
        assert!(!fits_headroom(u128::MAX, u64::MAX));
    }

    #[test]
    fn reservation_is_not_clone_or_serializable() {
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
        let _ = <ChildOutputReservation as AmbiguousClone<_>>::check;
        let _ = <ChildOutputReservation as AmbiguousSerialize<_>>::check;
    }

    #[test]
    fn admission_migration_leaves_publication_and_generic_release_closed() {
        let migration = include_str!("../../../migrations/0049_static_hls_child_output_write.sql");
        assert!(migration.contains("static_hls_child_output_reservation_retained"));
        assert!(migration.contains("NEW.validation_version IS DISTINCT FROM 0"));
        assert!(migration.contains("NEW.bytes<>33554432"));
        assert!(
            !migration
                .contains("CREATE OR REPLACE FUNCTION static_hls_child_output_authority_allowed")
        );
        assert!(!migration.contains("DROP TRIGGER static_hls_00_child_output_file_guard"));
        assert!(!migration.contains("DROP TRIGGER static_hls_00_child_cache_guard"));
        assert!(!migration.contains("DROP TRIGGER static_hls_00_child_read_lease_guard"));
        let budget = include_str!("cache_budget.rs");
        assert!(budget.contains("r.purpose='media_job'"));
        assert!(
            budget.contains("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
        );
    }
}
