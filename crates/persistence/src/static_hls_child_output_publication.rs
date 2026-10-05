//! Atomic publication of the original fully validated child output.
//!
//! A statement, file hash, decoder JSON, version number or database row cannot
//! construct this operation or receipt. The opaque validator witness continuously
//! owns the original output directory; COMMIT uncertainty retains that same
//! witness and write permit. Positive database publication, retention promotion
//! and public read authority are three distinct transitions.
use anyhow::{Result, ensure};
use media_core::static_hls::{
    CaptureFuture, DisposalState,
    child_output_owner::{OutputIdentity, OutputPermit, PublishedOutputPermit},
    child_output_validation::{PublishedChildOutput, ValidatedChildOutput},
    contracts::graph::RootGraphStatement,
    contracts::input::{FrozenInput, IdentityStatement},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Postgres, Transaction};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

use crate::static_hls_child_output::ChildOutputWritePermit;

const COMMIT_TIME: Duration = Duration::from_millis(750);

#[derive(Debug, Eq, PartialEq)]
pub enum Publication {
    /// The real COMMIT and SAME original owner's receipt promotion both passed.
    Published,
    /// Keep this original operation and owner. This is neither rollback nor
    /// permission to adopt a row, remint a proof, resume writes or serve bytes.
    CommitUnknown,
}

#[derive(Eq, PartialEq)]
enum State {
    Prepared,
    InFlight,
    CommitUnknown,
    Published,
}

/// Install BEFORE awaiting commit. No Clone/serialization/ID constructor.
/// An abandoned caller never transfers the independent physical owner.
pub struct PreparedChildOutputPublication {
    original: Arc<ChildOutputWritePermit>,
    original_dyn: Arc<dyn OutputPermit>,
    proof: Option<ValidatedChildOutput>,
    receipt: Option<Arc<ChildOutputPublicationReceipt>>,
    published: Option<Arc<PublishedChildOutput>>,
    state: State,
}

impl PreparedChildOutputPublication {
    pub fn prepare(
        original: Arc<ChildOutputWritePermit>,
        proof: ValidatedChildOutput,
    ) -> Result<Self> {
        let original_dyn: Arc<dyn OutputPermit> = original.clone();
        proof.require_original_permit(&original_dyn)?;
        ensure!(
            proof.identity() == &original.identity(),
            "static_hls_child_output_original_validation_required"
        );
        proof.check_local()?;
        ensure!(
            original.root_deadline().is_some(),
            "static_hls_child_output_original_root_deadline_required"
        );
        // Never replace an uncertain original operation, even with another
        // witness of this same directory and identical declared hashes.
        original.register_publication_operation(Uuid::new_v4())?;
        Ok(Self {
            original,
            original_dyn,
            proof: Some(proof),
            receipt: None,
            published: None,
            state: State::Prepared,
        })
    }

    /// Starts the single absolute check budget at INVOCATION, before first poll.
    /// This operation cannot repeat a possibly committed database transaction.
    /// A known positive receipt may retry only its SAME local-owner promotion.
    pub fn commit(&mut self) -> impl Future<Output = Result<Publication>> + '_ {
        let until = Instant::now() + COMMIT_TIME;
        async move {
            let result = tokio::time::timeout_at(until, async {
                require_before(until)?;
                if self.receipt.is_none() {
                    if self.state != State::Prepared {
                        return Ok(Publication::CommitUnknown);
                    }
                    self.state = State::InFlight;
                    self.commit_original(until).await?;
                }
                // SQL, core promotion, original mutex waits and any receipt
                // recovery share this SAME invocation's fixed absolute budget.
                let result = self.promote_original().await;
                require_before(until)?;
                Ok::<Publication, anyhow::Error>(result)
            })
            .await;
            match result {
                Ok(Ok(Publication::Published)) if Instant::now() < until => {
                    self.state = State::Published;
                    Ok(Publication::Published)
                }
                _ => {
                    self.state = State::CommitUnknown;
                    Ok(Publication::CommitUnknown)
                }
            }
        }
    }

    pub fn published_output(&self) -> Option<Arc<PublishedChildOutput>> {
        if self.state == State::Published {
            self.published.clone()
        } else {
            None
        }
    }
    pub fn receipt(&self) -> Option<Arc<ChildOutputPublicationReceipt>> {
        self.receipt.clone()
    }

    async fn commit_original(&mut self, until: Instant) -> Result<()> {
        let proof = self.proof.as_ref().ok_or_else(|| {
            anyhow::anyhow!("static_hls_child_output_original_validation_required")
        })?;
        proof.require_original_permit(&self.original_dyn)?;
        // Actual full-resource rehash and custody handoff are OUTSIDE DB locks.
        // Publishing closes all writers/reads but preserves the original owner
        // under its already frozen root cap, including an unknown SQL outcome.
        proof.begin_publication().await?;
        let evidence = proof.evidence_json()?;
        let evidence_plaintext = serde_json::to_string(&evidence)?;
        ensure!(
            evidence_plaintext.len() <= 1024 * 1024,
            "static_hls_child_output_evidence_bound"
        );
        let evidence_sha256 = sha(evidence_plaintext.as_bytes());
        let manifest = std::str::from_utf8(proof.manifest())?;
        let manifest_sha256 = sha(proof.manifest());
        let count = i32::try_from(proof.segment_count())?;
        let resources = Value::Array(
            proof
                .resources()
                .iter()
                .map(|r| json!({"name":r.name,"bytes":r.bytes,"sha256":r.sha256}))
                .collect(),
        );
        let total_bytes = proof.resources().iter().try_fold(0i64, |total, r| {
            total
                .checked_add(i64::try_from(r.bytes)?)
                .ok_or_else(|| anyhow::anyhow!("static_hls_child_output_size_overflow"))
        })?;
        let (pool, execution_owner, reservation_owner) = self.original.original_parts();
        let execution = execution_owner.lock().await;
        let mut reservation = reservation_owner.lock().await;
        let claim = execution.claim();
        ensure!(
            proof.source_identity() == claim.capture().control()?.identity(),
            "static_hls_child_output_original_source_required"
        );
        // The real opaque output witness must attest the exact requested trim,
        // not merely another valid encode of this same capture and permit.
        let original_spec: Value =
            serde_json::from_slice(&claim.spec().private_storage_plaintext()?)?;
        ensure!(
            original_spec["position_ms"].as_f64()
                == Some(proof.decoded_timeline().source_position_ms),
            "static_hls_child_output_original_trim_required"
        );
        reservation.begin_publication(claim, execution.input_lease()?)?;
        // A cancelled/error waiter grants no writing rights. The core Publishing
        // owner does not poll the revoked write authority or dispose mid-COMMIT.
        reservation.mark_publication_unknown();
        require_before(until)?;
        let mut connection = pool.acquire().await?;
        connection.close_on_drop();
        let mut tx = connection.begin().await?;
        claim.lock_current_attempt(&mut tx).await?;
        let identity = reservation.retained_identity();
        let row: Option<Uuid> = sqlx::query_scalar("SELECT o.job_id FROM media_outputs o WHERE o.job_id=$1 AND o.attempt=$2 AND o.owner_id=$3 AND o.relative_dir=$4 AND o.status='writing' AND o.validation_version=0 AND o.visible_manifest IS NULL AND o.ready_segments=0 AND o.manifest_sha256 IS NULL AND o.segment_count IS NULL AND o.published_at IS NULL FOR UPDATE")
            .bind(identity.job).bind(identity.attempt).bind(identity.owner).bind(identity.relative_dir).fetch_optional(&mut *tx).await?;
        ensure!(
            row == Some(identity.job),
            "static_hls_child_output_original_writing_required"
        );
        let bytes: Option<i64> = sqlx::query_scalar("SELECT bytes FROM cache_write_reservations WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND purpose='static_hls_child_output' FOR UPDATE")
            .bind(identity.job).bind(identity.attempt).bind(identity.owner).fetch_optional(&mut *tx).await?;
        ensure!(
            bytes == Some(33554432),
            "static_hls_child_output_original_reservation_required"
        );
        sqlx::query("SELECT set_config('rainsync.static_hls_child_output_publication','full_child_snapshot_v1',true)")
            .execute(&mut *tx).await?;
        claim.check_before_commit(&mut tx).await?;
        proof.check_local()?;
        require_before(until)?;
        let inserted = sqlx::query("INSERT INTO static_hls_child_output_publications(job_id,attempt,owner_id,execution_id,capture_id,input_sha256,root_digest,root_expires_at,relative_dir,validation_kind,validation_version,manifest,manifest_sha256,segment_count,resources,total_bytes,evidence,evidence_plaintext,evidence_sha256,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000),$9,'static_hls_full_child_snapshot_v1',1,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp())")
            .bind(identity.job).bind(identity.attempt).bind(identity.owner).bind(identity.execution).bind(identity.capture)
            .bind(identity.input_sha256).bind(identity.root_digest).bind(i64::try_from(claim.input().root_deadline_ms())?)
            .bind(identity.relative_dir).bind(manifest).bind(&manifest_sha256).bind(count).bind(resources).bind(total_bytes)
            .bind(evidence).bind(&evidence_plaintext).bind(&evidence_sha256).execute(&mut *tx).await?.rows_affected();
        ensure!(
            inserted == 1,
            "static_hls_child_output_evidence_unconfirmed"
        );
        let changed = sqlx::query("UPDATE media_outputs o SET status='published',validation_version=4,visible_manifest=proof.manifest,ready_segments=proof.segment_count,manifest_sha256=proof.manifest_sha256,segment_count=proof.segment_count,published_at=proof.published_at,cleanup_after=proof.root_expires_at FROM static_hls_child_output_publications proof WHERE o.job_id=$1 AND o.attempt=$2 AND o.owner_id=$3 AND proof.job_id=o.job_id AND proof.attempt=o.attempt AND proof.owner_id=o.owner_id AND o.status='writing' AND o.validation_version=0")
            .bind(identity.job).bind(identity.attempt).bind(identity.owner).execute(&mut *tx).await?.rows_affected();
        ensure!(
            changed == 1,
            "static_hls_child_output_publication_unconfirmed"
        );
        // Repeat the running/lease/input/root fence immediately before leaving
        // running. Reaping is asserted ONLY by this real validator witness.
        claim.check_before_commit(&mut tx).await?;
        proof.check_local()?;
        require_before(until)?;
        let succeeded = sqlx::query("UPDATE media_jobs SET status='succeeded',lease_until=NULL,error=NULL,timing_version=NULL,timing_attempt=NULL,queue_entered_at=NULL,run_started_at=NULL WHERE id=$1 AND session_id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND static_hls_child_job_attempt_authority_allowed(id,owner_id,attempt)")
            .bind(identity.job).bind(identity.owner).bind(identity.attempt).execute(&mut *tx).await?.rows_affected();
        ensure!(
            succeeded == 1,
            "static_hls_child_output_success_unconfirmed"
        );
        let reaped = sqlx::query("UPDATE media_executions e SET reaped_at=proof.published_at FROM static_hls_child_output_publications proof WHERE e.id=$1 AND e.job_id=$2 AND e.attempt=$3 AND e.owner_id=$4 AND e.kind='job' AND e.session_id=$2 AND e.reaped_at IS NULL AND proof.execution_id=e.id AND proof.job_id=e.job_id AND proof.attempt=e.attempt AND proof.owner_id=e.owner_id")
            .bind(identity.execution).bind(identity.job).bind(identity.attempt).bind(identity.owner).execute(&mut *tx).await?.rows_affected();
        ensure!(
            reaped == 1,
            "static_hls_child_output_actual_execution_reap_unconfirmed"
        );
        let input_identity = claim.input().identity_statement();
        let input_plaintext = claim.input().private_storage_plaintext().to_vec();
        let root_digest = claim.root_statement().root_digest().to_owned();
        let root_until = claim.publication_root_until();
        // No physical I/O or new authority-prefix lock after this final fence.
        // The unchanged actual local encode lease still bounds successful COMMIT.
        require_evidence(
            &mut tx,
            identity.job,
            identity.attempt,
            identity.owner,
            &evidence_sha256,
        )
        .await?;
        claim.check_published_before_commit(&mut tx).await?;
        proof.check_local()?;
        claim.check_local()?;
        require_before(until)?;
        tx.commit().await?;
        // Positive-but-late COMMIT does not mint a receipt or revive a lease.
        require_before(until)?;
        claim.check_local()?;
        proof.check_local()?;
        reservation.mark_published();
        self.receipt = Some(Arc::new(ChildOutputPublicationReceipt {
            original: self.original.clone(),
            original_dyn: self.original_dyn.clone(),
            identity: proof.identity().clone(),
            input_identity,
            input_plaintext,
            root_digest,
            root_until,
            evidence_sha256,
        }));
        Ok(())
    }

    async fn promote_original(&mut self) -> Publication {
        let Some(receipt) = self.receipt.as_ref() else {
            return Publication::CommitUnknown;
        };
        // A late observed promotion retains the same physical published
        // handle. Reconfirm its actual receipt without reminting a witness.
        if self.published.is_some() {
            return if receipt.check_retention().await.is_ok() {
                Publication::Published
            } else {
                Publication::CommitUnknown
            };
        }
        let Some(proof) = self.proof.as_ref() else {
            return Publication::CommitUnknown;
        };
        let retained: Arc<dyn PublishedOutputPermit> = receipt.clone();
        if proof.confirm_publication(retained).await.is_err() {
            self.state = State::CommitUnknown;
            return Publication::CommitUnknown;
        }
        // This consumes the actual validator witness after SAME-owner promotion.
        let proof = self.proof.take().expect("original publication proof");
        match proof.into_published() {
            Ok(published) => {
                self.published = Some(Arc::new(published));
                self.state = State::Published;
                Publication::Published
            }
            Err(_) => {
                self.state = State::CommitUnknown;
                Publication::CommitUnknown
            }
        }
    }
}

/// A nonserializable receipt minted ONLY by positive actual COMMIT, permanently
/// bound to the original write-permit Arc. Observational statements cannot mint
/// it, and possession alone does not authorize reading before input disposal.
pub struct ChildOutputPublicationReceipt {
    original: Arc<ChildOutputWritePermit>,
    original_dyn: Arc<dyn OutputPermit>,
    identity: OutputIdentity,
    input_identity: IdentityStatement,
    input_plaintext: Vec<u8>,
    root_digest: String,
    root_until: Instant,
    evidence_sha256: String,
}

impl ChildOutputPublicationReceipt {
    pub fn require_read_statement(
        &self,
        input: &FrozenInput,
        root: &RootGraphStatement,
        expected: &OutputIdentity,
    ) -> Result<()> {
        self.require_same_frozen_input(input)?;
        ensure!(
            expected == &self.identity && root.root_digest() == self.root_digest,
            "static_hls_child_output_original_read_statement_required"
        );
        Ok(())
    }
    fn bounded_check(&self, read: bool) -> CaptureFuture<'_, ()> {
        let until = (Instant::now() + COMMIT_TIME).min(self.root_until);
        Box::pin(async move {
            let result = tokio::time::timeout_at(until, async {
                require_before(until)?;
                let (pool, execution_owner, reservation_owner) = self.original.original_parts();
                let execution = execution_owner.lock().await;
                let reservation = reservation_owner.lock().await;
                let claim = execution.claim();
                reservation.require_claim(claim)?;
                ensure!(
                    claim.input().private_storage_plaintext() == self.input_plaintext
                        && claim.input().identity_statement() == self.input_identity
                        && claim.root_statement().root_digest() == self.root_digest,
                    "static_hls_child_output_original_published_claim_required"
                );
                if read {
                    require_actual_input_disposed(claim)?;
                }
                let mut connection = pool.acquire().await?;
                connection.close_on_drop();
                let mut tx = connection.begin().await?;
                if read {
                    sqlx::query("SELECT set_config('rainsync.static_hls_child_reader','original_published_child_v1',true)")
                        .execute(&mut *tx).await?;
                }
                claim.lock_published_current(&mut tx).await?;
                require_evidence(
                    &mut tx,
                    claim.job_id(),
                    claim.attempt(),
                    claim.owner_id(),
                    &self.evidence_sha256,
                )
                .await?;
                if read {
                    let disposed: bool =
                        sqlx::query_scalar("SELECT static_hls_child_output_authority_allowed($1)")
                            .bind(claim.job_id())
                            .fetch_one(&mut *tx)
                            .await?;
                    ensure!(
                        disposed,
                        "static_hls_child_output_actual_input_disposal_required"
                    );
                }
                claim.check_retention_before_commit(&mut tx).await?;
                require_before(until)?;
                if read {
                    require_actual_input_disposed(claim)?;
                }
                tx.commit().await?;
                require_before(until)?;
                claim.check_retention_local()?;
                if read {
                    require_actual_input_disposed(claim)?;
                }
                Ok(())
            })
            .await
            .map_err(|_| {
                anyhow::anyhow!("static_hls_child_output_publication_authority_timeout")
            })?;
            require_before(until)?;
            result
        })
    }
}

impl PublishedOutputPermit for ChildOutputPublicationReceipt {
    fn identity(&self) -> OutputIdentity {
        self.identity.clone()
    }
    fn original_write_permit(&self) -> &Arc<dyn OutputPermit> {
        &self.original_dyn
    }
    fn root_deadline(&self) -> Instant {
        self.root_until
    }
    fn require_same_frozen_input(&self, input: &FrozenInput) -> Result<()> {
        ensure!(
            input.private_storage_plaintext() == self.input_plaintext
                && input.identity_statement() == self.input_identity,
            "static_hls_child_output_original_read_input_required"
        );
        Ok(())
    }
    fn check_retention(&self) -> CaptureFuture<'_, ()> {
        self.bounded_check(false)
    }
    fn check_read(&self) -> CaptureFuture<'_, ()> {
        self.bounded_check(true)
    }
}

fn require_actual_input_disposed(
    claim: &crate::static_hls_child_jobs::ChildJobClaim,
) -> Result<()> {
    ensure!(
        claim.capture().control()?.disposal_state() == DisposalState::Disposed,
        "static_hls_child_output_actual_input_disposal_required"
    );
    Ok(())
}
fn require_before(until: Instant) -> Result<()> {
    ensure!(
        Instant::now() < until,
        "static_hls_child_output_publication_authority_timeout"
    );
    Ok(())
}
fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
async fn require_evidence(
    tx: &mut Transaction<'_, Postgres>,
    job: Uuid,
    attempt: i64,
    owner: Uuid,
    hash: &str,
) -> Result<()> {
    let exact: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM static_hls_child_output_publications proof WHERE proof.job_id=$1 AND proof.attempt=$2 AND proof.owner_id=$3 AND proof.evidence_sha256=$4 AND proof.validation_kind='static_hls_full_child_snapshot_v1' AND proof.validation_version=1 AND static_hls_child_output_publication_matches(proof.job_id))")
        .bind(job).bind(attempt).bind(owner).bind(hash).fetch_one(&mut **tx).await?;
    ensure!(
        exact,
        "static_hls_child_output_original_complete_evidence_required"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_child_publication_is_semantically_separate_from_v3() {
        let migration =
            include_str!("../../../migrations/0050_static_hls_child_output_publication.sql");
        assert!(migration.contains("static_hls_full_child_snapshot_v1"));
        assert!(migration.contains("o.validation_version=4"));
        assert!(migration.contains("s'||lpad(n::text,3,'0')||'.m4s'"));
        assert!(
            migration
                .contains("CREATE OR REPLACE FUNCTION static_hls_child_output_authority_allowed")
        );
        assert!(migration.contains("AND static_hls_child_output_input_disposed($1)"));
        assert!(migration.contains("AND static_hls_child_grant_authority_allowed($1)"));
        assert!(migration.contains("SELECT static_hls_child_output_reader_supported()"));
        assert!(migration.contains("rainsync.static_hls_child_reader"));
        assert!(!migration.contains("DROP TRIGGER static_hls_00_child_read_lease_guard"));
    }
    #[test]
    fn receipt_and_operation_cannot_be_cloned_or_serialized() {
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
        let _ = <PreparedChildOutputPublication as AmbiguousClone<_>>::check;
        let _ = <ChildOutputPublicationReceipt as AmbiguousClone<_>>::check;
        let _ = <PreparedChildOutputPublication as AmbiguousSerialize<_>>::check;
        let _ = <ChildOutputPublicationReceipt as AmbiguousSerialize<_>>::check;
    }
    #[test]
    fn publication_deadline_includes_same_owner_promotion_and_late_receipt_recovery() {
        let source = include_str!("static_hls_child_output_publication.rs");
        let commit = &source[source.find("pub fn commit(&mut self)").unwrap()
            ..source.find("pub fn published_output(&self)").unwrap()];
        let anchor = commit
            .find("let until = Instant::now() + COMMIT_TIME")
            .unwrap();
        let first_poll = commit.find("async move").unwrap();
        let timeout = commit.find("timeout_at(until, async").unwrap();
        let promotion = commit.find("self.promote_original().await").unwrap();
        let final_clock = commit.find("Instant::now() < until").unwrap();
        assert!(
            anchor < first_poll
                && first_poll < timeout
                && timeout < promotion
                && promotion < final_clock
        );
        assert!(!commit.contains("self.state == State::Published"));
        assert!(!commit.contains("tx.rollback"));
    }

    #[test]
    fn final_publication_fence_is_after_evidence_and_before_commit_without_physical_io() {
        let source = include_str!("static_hls_child_output_publication.rs");
        let commit = &source[source.find("async fn commit_original(").unwrap()
            ..source.find("async fn promote_original(").unwrap()];
        let evidence = commit.rfind("require_evidence(").unwrap();
        let fence = commit
            .rfind("claim.check_published_before_commit(")
            .unwrap();
        let db_commit = commit.rfind("tx.commit().await?").unwrap();
        assert!(evidence < fence && fence < db_commit);
        let final_section = &commit[fence..db_commit];
        assert!(!final_section.contains(".check().await"));
        assert!(!final_section.contains("snapshot("));
        assert!(final_section.contains("claim.check_local()?"));
        assert!(final_section.contains("require_before(until)?"));
    }

    #[test]
    fn ready_reply_never_bypasses_expired_absolute_deadline() {
        assert!(require_before(Instant::now() - Duration::from_millis(1)).is_err());
    }
}
