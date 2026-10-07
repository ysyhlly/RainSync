//! Private Stage A capture ownership. No Server or Worker production path calls
//! admission while the activation contract remains disabled. Scheduling state,
//! lease expiry and cancellation never release storage or process responsibility.
use anyhow::{Result, ensure};
use sqlx::{PgPool, Row};
use std::time::Duration;
use uuid::Uuid;

pub const CAPTURE_BYTES: u64 = 128 * 1024 * 1024;
const AUTHORITY_QUERY_TIMEOUT: Duration = Duration::from_millis(750);

/// Minted by this process's successful admission only. Not serializable and
/// deliberately not reconstructible from retained UUIDs after a restart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturePermit {
    id: Uuid,
    owner: Uuid,
    session: Uuid,
}
impl CapturePermit {
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn owner(&self) -> Uuid {
        self.owner
    }
    pub fn session(&self) -> Uuid {
        self.session
    }
    pub fn relative_key(&self) -> String {
        format!("static-hls/{}", self.id)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Acquired(CapturePermit),
    Changed,
    Full,
    Stale,
}

/// Caller supplies a positively measured headroom and the existing budget
/// revision captured before that measurement. No network or filesystem work is
/// performed while any transaction lock is held. Unresolved owners count even
/// after their deadline or cancellation, with two globally and one per user.
/// Stage A conservatively couples CPU admission to retained snapshot storage:
/// finishing capture does not return a slot before complete snapshot disposal.
pub async fn admit(
    pool: &PgPool,
    session: Uuid,
    owner: Uuid,
    revision: i64,
    headroom: u64,
) -> Result<Admission> {
    let mut tx = pool.begin().await?;
    let room: Option<Uuid> =
        sqlx::query_scalar("SELECT room_id FROM playback_sessions WHERE id=$1")
            .bind(session)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let Some(room) = room else {
        return Ok(Admission::Stale);
    };
    crate::room_lifecycle::lock_active(&mut tx, room).await?;
    sqlx::query("SELECT room_id FROM room_snapshots WHERE room_id=$1 FOR UPDATE")
        .bind(room)
        .fetch_optional(&mut *tx)
        .await?;
    if !crate::source_account_policy::lock_session(&mut tx, session).await? {
        return Ok(Admission::Stale);
    }
    let parent=sqlx::query("SELECT p.user_id,p.resource,r.owner_epoch FROM playback_sessions p JOIN playback_requests r ON r.session_id=p.id WHERE p.id=$1 AND p.static_hls_capture_id IS NULL AND NOT (p.resource ? 'static_hls_capture_id') AND static_hls_parent_authority_allowed(p.id) FOR SHARE OF p,r")
        .bind(session).fetch_optional(&mut *tx).await?;
    let Some(parent) = parent else {
        return Ok(Admission::Stale);
    };
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    if current != revision {
        return Ok(Admission::Changed);
    }
    let user: Uuid = parent.get("user_id");
    let capacity: bool = sqlx::query_scalar("SELECT (SELECT count(*) FROM static_hls_captures WHERE disposed_at IS NULL)<2 AND NOT EXISTS(SELECT 1 FROM static_hls_captures WHERE user_id=$1 AND disposed_at IS NULL)")
        .bind(user).fetch_one(&mut *tx).await?;
    let held: String =
        sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
            .fetch_one(&mut *tx)
            .await?;
    if !capacity || held.parse::<u128>()? + u128::from(CAPTURE_BYTES) > u128::from(headroom) {
        return Ok(Admission::Full);
    }
    let permit = CapturePermit {
        id: Uuid::new_v4(),
        owner,
        session,
    };
    let inserted=sqlx::query("INSERT INTO static_hls_captures(id,session_id,user_id,owner_id,resource_authority,request_owner_epoch,expires_at) SELECT $1,p.id,$2,$3,$4,$5,LEAST(p.expires_at,clock_timestamp()+interval '30 minutes') FROM playback_sessions p WHERE p.id=$6 AND static_hls_parent_authority_allowed(p.id)")
        .bind(permit.id).bind(user).bind(owner).bind(parent.get::<serde_json::Value,_>("resource"))
        .bind(parent.get::<Uuid,_>("owner_epoch")).bind(session).execute(&mut *tx).await?.rows_affected();
    if inserted != 1 {
        return Ok(Admission::Stale);
    }
    sqlx::query("INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES($1,$2,0,$3,'static_hls_capture')")
        .bind(permit.id).bind(owner).bind(CAPTURE_BYTES as i64).execute(&mut *tx).await?;
    sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Admission::Acquired(permit))
}

/// A confirmed None is a revoked fence. An error is unknown authority, which
/// must stop I/O without claiming cleanup. Subtract the complete SQL round trip
/// before using this database-clock remainder as a monotonic local deadline.
pub async fn authority_remaining(
    pool: &PgPool,
    permit: &CapturePermit,
) -> Result<Option<Duration>> {
    let remaining = tokio::time::timeout(AUTHORITY_QUERY_TIMEOUT, async {
        let mut connection=pool.acquire().await?;
        // A cancelled bounded authority read cannot return a still-running
        // physical connection to the pool as fresh positive evidence.
        connection.close_on_drop();
        let remaining: Option<f64> = sqlx::query_scalar("SELECT extract(epoch FROM LEAST(c.expires_at,p.expires_at)-clock_timestamp())::float8 FROM static_hls_captures c JOIN playback_sessions p ON p.id=c.session_id WHERE c.id=$1 AND c.owner_id=$2 AND c.session_id=$3 AND c.publication_phase='stage_a' AND static_hls_reader_supported() AND static_hls_capture_authority_allowed(c.id)")
        .bind(permit.id).bind(permit.owner).bind(permit.session).fetch_optional(&mut *connection).await?;
        Ok::<_,anyhow::Error>(remaining)
    }).await.map_err(|_|anyhow::anyhow!("static_hls_authority_unknown"))??;
    authority_duration(remaining)
}

// Finite nonpositive DB remainders are confirmed expiry. Only malformed
// clock observations stay unknown; Duration rejects negative seconds itself.
pub(crate) fn authority_duration(remaining: Option<f64>) -> Result<Option<Duration>> {
    remaining
        .map(|seconds| {
            ensure!(seconds.is_finite(), "static_hls_authority_unknown");
            Ok(if seconds <= 0.0 {
                Duration::ZERO
            } else {
                Duration::try_from_secs_f64(seconds)?
            })
        })
        .transpose()
}

#[cfg(test)]
mod authority_duration_tests {
    #[test]
    fn past_expiry_is_confirmed_zero_and_invalid_observation_is_unknown() {
        for seconds in [-10.0, -0.001, 0.0] {
            assert_eq!(
                super::authority_duration(Some(seconds)).unwrap(),
                Some(std::time::Duration::ZERO)
            );
        }
        assert_eq!(super::authority_duration(None).unwrap(), None);
        assert_eq!(
            super::authority_duration(Some(1.5)).unwrap(),
            Some(std::time::Duration::from_millis(1500))
        );
        for seconds in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                super::authority_duration(Some(seconds))
                    .unwrap_err()
                    .to_string(),
                "static_hls_authority_unknown"
            );
        }
    }
}

/// The inventory is source-produced, encrypted and bounded. The scanner's byte
/// and timeline proof is required by the caller; it is never a browser claim.
pub async fn prove_verified(
    pool: &PgPool,
    permit: &CapturePermit,
    inventory_encrypted: &str,
) -> Result<bool> {
    ensure!(
        !inventory_encrypted.is_empty() && inventory_encrypted.len() <= 256 * 1024,
        "static_hls_inventory_bounds"
    );
    Ok(sqlx::query("UPDATE static_hls_captures SET state='verified',inventory_encrypted=$4 WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='stage_a' AND state IN ('capturing','verified') AND (inventory_encrypted IS NULL OR inventory_encrypted=$4) AND static_hls_capture_authority_allowed(id)")
        .bind(permit.id).bind(permit.owner).bind(permit.session).bind(inventory_encrypted).execute(pool).await?.rows_affected() == 1)
}

pub async fn cancel(pool: &PgPool, permit: &CapturePermit) -> Result<()> {
    sqlx::query("UPDATE static_hls_captures SET state='cancelled' WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='stage_a' AND state IN ('capturing','verified')")
        .bind(permit.id).bind(permit.owner).bind(permit.session).execute(pool).await?;
    Ok(())
}

/// Only a proven cleanup owner calls this after closing streams, reaping every
/// child and removing its inode-bound owned directory. Partial/unknown evidence
/// is not accepted. Retried database acknowledgement is safe after real disposal.
pub(crate) async fn acknowledge_disposal(
    pool: &PgPool,
    permit: &CapturePermit,
    streams_closed: bool,
    process_disposition: Option<&str>,
    files_removed: bool,
) -> Result<bool> {
    if !(streams_closed
        && matches!(process_disposition, Some("never_started" | "reaped"))
        && files_removed)
    {
        return Ok(false);
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let changed=sqlx::query("UPDATE static_hls_captures SET state='disposed',streams_closed_at=COALESCE(streams_closed_at,clock_timestamp()),process_closed_at=COALESCE(process_closed_at,clock_timestamp()),process_disposition=COALESCE(process_disposition,$4),files_removed_at=COALESCE(files_removed_at,clock_timestamp()),disposed_at=COALESCE(disposed_at,clock_timestamp()) WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='stage_a'")
        .bind(permit.id).bind(permit.owner).bind(permit.session).bind(process_disposition).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        return Ok(false);
    }
    let removed=sqlx::query("DELETE FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$2 AND attempt=0 AND purpose='static_hls_capture'")
        .bind(permit.id).bind(permit.owner).execute(&mut *tx).await?.rows_affected();
    if removed > 0 {
        sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// The application-owned activation/epoch gate is independent of DB authority.
/// Stage A real runtimes use ClosedActivation; owned fixtures can supply their
/// explicit bounded local epoch check without adding a production enable switch.
pub trait ActivationCheck: Send + Sync {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()>;
}
pub struct ClosedActivation;
impl ActivationCheck for ClosedActivation {
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async { anyhow::bail!("static_hls_admission_disabled") })
    }
}

/// This adapter can only receive the mint-only permit from successful admission.
/// It cannot reconstruct old ownership from UUID rows after a process restart.
pub struct PersistedCapturePermit {
    pool: PgPool,
    permit: CapturePermit,
    activation: std::sync::Arc<dyn ActivationCheck>,
    identity: media_core::static_hls::CaptureOwnerIdentity,
}
impl PersistedCapturePermit {
    pub fn new(
        pool: PgPool,
        permit: CapturePermit,
        activation: std::sync::Arc<dyn ActivationCheck>,
    ) -> Self {
        let identity = media_core::static_hls::CaptureOwnerIdentity {
            capture_id: permit.id.to_string(),
            owner_id: permit.owner.to_string(),
            relative_key: permit.relative_key(),
        };
        Self {
            pool,
            permit,
            activation,
            identity,
        }
    }
}
impl media_core::static_hls::CapturePermit for PersistedCapturePermit {
    fn identity(&self) -> media_core::static_hls::CaptureOwnerIdentity {
        self.identity.clone()
    }
    fn check(&self) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async {
            tokio::time::timeout(AUTHORITY_QUERY_TIMEOUT, self.activation.check())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_activation_unknown"))??;
            let start = std::time::Instant::now();
            let remaining = authority_remaining(&self.pool, &self.permit)
                .await?
                .ok_or_else(|| anyhow::anyhow!("static_hls_capture_authority_revoked"))?;
            // A late DB completion is not allowed to refresh an old activation
            // epoch. Repeat it after SQL and charge the complete elapsed time.
            tokio::time::timeout(AUTHORITY_QUERY_TIMEOUT, self.activation.check())
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_activation_unknown"))??;
            ensure!(
                remaining > start.elapsed(),
                "static_hls_capture_authority_expired"
            );
            Ok(())
        })
    }
    fn acknowledge_disposal(
        &self,
        proof: std::sync::Arc<media_core::static_hls::DisposalProof>,
    ) -> media_core::static_hls::CaptureFuture<'_, ()> {
        Box::pin(async move {
            ensure!(
                proof.identity() == &self.identity && proof.all_positive(),
                "static_hls_disposal_identity_required"
            );
            let disposition = match proof.process_disposition() {
                media_core::static_hls::ProcessDisposition::NeverStarted => "never_started",
                media_core::static_hls::ProcessDisposition::Reaped => "reaped",
            };
            // Cleanup remains authorized after revocation/activation cancellation.
            // A failed DB result leaves responsibility unknown, never released.
            ensure!(
                acknowledge_disposal(
                    &self.pool,
                    &self.permit,
                    proof.streams_closed(),
                    Some(disposition),
                    proof.files_removed()
                )
                .await?,
                "static_hls_disposal_unconfirmed"
            );
            Ok(())
        })
    }
}
