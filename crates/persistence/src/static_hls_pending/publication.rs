//! Original-owner parent publication. Network/hash work precedes these locks.
use super::*;
use media_core::static_hls::{CaptureEvidence, PublicationLease};
use sha2::{Digest, Sha256};

/// COMMIT was sent, so retry requires observing the same original row first.
#[derive(Debug)]
pub struct PublicationCommitUncertain;
impl std::fmt::Display for PublicationCommitUncertain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("static_hls_publication_commit_uncertain")
    }
}
impl std::error::Error for PublicationCommitUncertain {}

/// A prepared, encrypted immutable reply, retaining its actual graph witness.
/// This is an internal storage boundary, not the public playback response DTO.
pub struct ParentPublication {
    witness: PublicationLease,
    root: RootGraphStatement,
    resource: serde_json::Value,
    response: String,
    token_hash: String,
}
impl ParentPublication {
    pub fn prepare(
        input: &FrozenInput,
        witness: PublicationLease,
        seal_descriptor: impl FnOnce(&[u8]) -> Result<String>,
        seal_reply: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<Self> {
        ensure!(
            input.kind() == OperationKind::Parent,
            "static_hls_parent_input_required"
        );
        let identity = input.identity_statement();
        ensure!(
            witness.identity().capture_id == identity.operation_id,
            "static_hls_original_verified_owner_required"
        );
        let evidence = witness.live_evidence()?;
        let root = graph_from_evidence(input, evidence)?;
        root.require_parent_input(input)?;
        let timeline = serde_json::to_value(&evidence.timeline)?;
        let descriptor = serde_json::to_vec(&json!({
            "kind":"http","transport":"hls","delivery_mode":"direct",
            "session_id":identity.session_id,"input_sha256":identity.input_sha256,
            "timeline_origin_ms":timeline["source_origin_ms"]
        }))?;
        let encrypted = seal_descriptor(&descriptor)?;
        ensure!(
            !encrypted.is_empty() && encrypted.len() <= 65_536,
            "static_hls_publication_descriptor_bounds"
        );
        let resource = json!({
            "encrypted":encrypted,"source_policy_revision":identity.source_policy_revision,
            "account_policy_generation":null,
            "auth_context":{"version":1,"user_id":identity.user_id,"room_id":identity.room_id,
                "membership_epoch":identity.auth_membership_epoch,"login_hash":identity.auth_login_hash},
            "static_hls_input":{"input_version":1,"reader_version":2,"recipe_version":1,
                "source_id":identity.source_id,"media_source_generation":identity.media_source_generation,
                "input_sha256":identity.input_sha256,"worker_instance":identity.worker_instance,
                "root_hard_expires_at_ms":input.root_deadline_ms()}
        });
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let token_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
        let response = seal_reply(&serde_json::to_vec(&json!({
            "version":1,"session_id":identity.session_id,"delivery_token":token,
            "static_hls_capture_id":identity.operation_id,"input_sha256":identity.input_sha256,
            "root_digest":root.root_digest(),"root_hard_expires_at_ms":input.root_deadline_ms(),
            "timeline_origin_ms":timeline["source_origin_ms"],"delivery_mode":"direct"
        }))?)?;
        ensure!(
            !response.is_empty() && response.len() <= 262_144,
            "static_hls_publication_reply_bounds"
        );
        witness.live_evidence()?;
        Ok(Self {
            witness,
            root,
            resource,
            response,
            token_hash,
        })
    }
}

pub(super) fn graph_from_evidence(
    input: &FrozenInput,
    evidence: &CaptureEvidence,
) -> Result<RootGraphStatement> {
    let evidence = serde_json::to_value(evidence)?;
    RootGraphStatement::parse_private_plaintext(&serde_json::to_vec(&json!({
        "graph_version":1,"parent_input_sha256":input.input_sha256(),
        "inventory":evidence["inventory"],"closure":evidence["closure"],"timeline":evidence["timeline"]
    }))?)
    .map_err(Into::into)
}

impl PersistedPendingCapturePermit {
    /// Revocation retains the immutable owner/input and all cleanup obligations.
    pub async fn cancel_parent(&self, status: i16, code: &str) -> Result<()> {
        cancel_input(&self.pool, &self.permit.input, status, code).await
    }

    /// Commit precedes returning the encrypted reply. An uncertain COMMIT ACK
    /// remains an error; the same original owner can observe its immutable row.
    pub async fn publish_parent(&self, publication: ParentPublication) -> Result<Option<String>> {
        ensure!(
            publication.witness.identity() == self.permit.identity(),
            "static_hls_original_verified_owner_required"
        );
        publication.witness.check().await?;
        publication.root.require_parent_input(&self.permit.input)?;
        let i = self.permit.input.identity_statement();
        let mut tx = self.pool.begin().await?;
        fence(&mut tx).await?;
        sqlx::query("SET LOCAL lock_timeout='750ms'")
            .execute(&mut *tx)
            .await?;
        if !lock_authority(&mut tx, &i, None, false).await?
            || !exact_request(&mut tx, &self.permit.input).await?
        {
            return Ok(None);
        }
        let matched: Option<Uuid> = sqlx::query_scalar("SELECT id FROM static_hls_captures WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_parent' AND state='verified' AND root_digest=$4 AND disposed_at IS NULL AND static_hls_pending_capture_authority_allowed(id) FOR UPDATE")
            .bind(self.permit.capture).bind(self.permit.owner).bind(self.permit.session).bind(publication.root.root_digest())
            .fetch_optional(&mut *tx).await?;
        if matched.is_none() {
            return Ok(None);
        }
        publication.witness.live_evidence()?;
        let resource = publication
            .resource
            .clone()
            .as_object_mut()
            .map(|object| {
                object.insert("static_hls_capture_id".into(), json!(self.permit.capture));
                serde_json::Value::Object(object.clone())
            })
            .ok_or_else(|| anyhow::anyhow!("static_hls_publication_resource_required"))?;
        let inserted = sqlx::query("INSERT INTO playback_sessions(id,user_id,room_id,media_id,generation,delivery_token_hash,resource,expires_at,lifecycle_epoch,viewer_id,plan_generation,static_hls_capture_id) SELECT session_id,user_id,room_id,static_hls_media_id,static_hls_media_generation,$2,$3,static_hls_root_expires_at,lifecycle_epoch,viewer_id,plan_generation,$4 FROM playback_requests WHERE session_id=$1 AND status='pending' AND static_hls_pending_request_authority_allowed(session_id)")
            .bind(self.permit.session).bind(&publication.token_hash).bind(resource).bind(self.permit.capture)
            .execute(&mut *tx).await?.rows_affected();
        ensure!(inserted == 1, "static_hls_parent_publication_unconfirmed");
        let changed = sqlx::query("UPDATE static_hls_captures SET publication_phase='published_parent',published_resource=$4,published_at=clock_timestamp() WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND publication_phase='pending_parent' AND state='verified' AND disposed_at IS NULL AND static_hls_pending_capture_authority_allowed(id)")
            .bind(self.permit.capture).bind(self.permit.owner).bind(self.permit.session).bind(&publication.resource)
            .execute(&mut *tx).await?.rows_affected();
        ensure!(changed == 1, "static_hls_parent_publication_unconfirmed");
        let changed = sqlx::query("UPDATE playback_requests SET status='completed',response_encrypted=$2 WHERE session_id=$1 AND status='pending' AND static_hls_pending_request_authority_allowed(session_id)")
            .bind(self.permit.session).bind(&publication.response).execute(&mut *tx).await?.rows_affected();
        ensure!(changed == 1, "static_hls_parent_publication_unconfirmed");
        publication.witness.live_evidence()?;
        tx.commit()
            .await
            .map_err(|error| anyhow::Error::new(error).context(PublicationCommitUncertain))?;
        publication
            .witness
            .live_evidence()
            .map_err(|error| error.context(PublicationCommitUncertain))?;
        Ok(Some(publication.response))
    }

    /// Replay neither re-encrypts the reply nor revalidates/recaptures the source.
    /// Only the retained original runtime permit can use this internal method.
    pub async fn replay_parent(
        &self,
        capture: &media_core::static_hls::VerifiedCapture,
    ) -> Result<Option<String>> {
        ensure!(
            capture.control()?.identity() == &self.permit.identity(),
            "static_hls_original_verified_owner_required"
        );
        capture.live_evidence()?;
        <Self as media_core::static_hls::CapturePermit>::check(self).await?;
        let mut tx = self.pool.begin().await?;
        fence(&mut tx).await?;
        let row = sqlx::query("SELECT r.* FROM playback_requests r JOIN static_hls_captures c ON c.session_id=r.session_id WHERE c.id=$1 AND c.owner_id=$2 AND c.session_id=$3 AND c.publication_phase='published_parent' AND r.status='completed' AND static_hls_published_parent_authority_allowed(c.id)")
            .bind(self.permit.capture).bind(self.permit.owner).bind(self.permit.session).fetch_optional(&mut *tx).await?;
        let Some(row) = row else { return Ok(None) };
        self.permit
            .input
            .require_identity_statement(&stored_identity(&row))?;
        capture.live_evidence()?;
        Ok(Some(row.get("response_encrypted")))
    }
}
