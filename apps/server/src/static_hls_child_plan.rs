//! Playback plans from the exact immutable original child publication receipt.
//!
//! A queued/running plan describes only frozen intent and a real pending job.
//! Published readiness needs the dedicated full-child evidence, positive input
//! disposal and independent current child-output read predicate. This adapter
//! never constructs a local output owner, projects private custody/source data,
//! renews any deadline, or enables public production qualification.
use aes_gcm::{Aes256Gcm, aead::Aead};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::contracts::{
    MAX_SAFE_INTEGER,
    graph::RootGraphStatement,
    input::{FrozenInput, OperationKind, SelectedAudioStatement},
    worker::ChildJobSpec,
};
use persistence::static_hls_child_publication::{ChildAuthorityState, ChildCommittedPlanMetadata};
use serde::{
    Deserialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{marker::PhantomData, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildReply {
    version: u8,
    session_id: String,
    delivery_token: String,
    delivery_mode: String,
    timeline_origin_ms: f64,
    pending_job_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildDescriptor {
    kind: String,
    transport: String,
    delivery_mode: String,
    session_id: String,
    input_sha256: String,
    timeline_origin_ms: f64,
}

// Derived struct decoders otherwise also accept positional arrays. Every
// encrypted object is map-only, with derive checking unknown/duplicate/missing
// fields. Discard serde diagnostics at this private-data boundary.
struct MapOnly<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for MapOnly<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = MapOnly<T>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a closed child publication object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(MapOnly)
            }
        }
        deserializer.deserialize_map(ObjectVisitor(PhantomData))
    }
}

fn open_storage(key: &Aes256Gcm, encrypted: &str, maximum: usize) -> Result<Vec<u8>> {
    ensure!(
        !encrypted.is_empty() && encrypted.len() <= maximum,
        "static_hls_child_cipher_bounds"
    );
    let bytes = STANDARD
        .decode(encrypted)
        .map_err(|_| anyhow::anyhow!("static_hls_child_cipher_shape"))?;
    ensure!(bytes.len() >= 28, "static_hls_child_cipher_bounds");
    key.decrypt((&bytes[..12]).into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("static_hls_child_cipher_authentication"))
}

fn canonical_uuid(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil() && id.to_string() == value)
}
fn lower_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_origin(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_SAFE_INTEGER as f64).contains(&value)
}

fn parse_reply(key: &Aes256Gcm, encrypted: &str) -> Result<ChildReply> {
    let bytes = open_storage(key, encrypted, 2_048)?;
    let MapOnly(reply) = serde_json::from_slice::<MapOnly<ChildReply>>(&bytes)
        .map_err(|_| anyhow::anyhow!("static_hls_child_reply_shape"))?;
    ensure!(
        reply.version == 1
            && canonical_uuid(&reply.session_id).is_some()
            && canonical_uuid(&reply.pending_job_id).is_some()
            && reply.pending_job_id == reply.session_id
            && lower_hash(&reply.delivery_token)
            && reply.delivery_mode == "transcode"
            && valid_origin(reply.timeline_origin_ms),
        "static_hls_child_reply_shape"
    );
    Ok(reply)
}

fn parse_descriptor(key: &Aes256Gcm, encrypted: &str) -> Result<ChildDescriptor> {
    let bytes = open_storage(key, encrypted, 65_536)?;
    let MapOnly(descriptor) = serde_json::from_slice::<MapOnly<ChildDescriptor>>(&bytes)
        .map_err(|_| anyhow::anyhow!("static_hls_child_descriptor_shape"))?;
    ensure!(
        descriptor.kind == "http"
            && descriptor.transport == "hls"
            && descriptor.delivery_mode == "transcode"
            && canonical_uuid(&descriptor.session_id).is_some()
            && lower_hash(&descriptor.input_sha256)
            && valid_origin(descriptor.timeline_origin_ms),
        "static_hls_child_descriptor_shape"
    );
    Ok(descriptor)
}

#[derive(Deserialize)]
struct PurposeProjection {
    position_ms: f64,
    selected_audio: SelectedAudioStatement,
}

fn require_statements(
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    recapture: &RootGraphStatement,
    reply: &ChildReply,
    descriptor: &ChildDescriptor,
) -> Result<PurposeProjection> {
    ensure!(
        child.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
        "static_hls_child_input_required"
    );
    root.require_parent_input(parent)?;
    child.require_child_of(parent, root.root_digest(), root.selected_audio_statement())?;
    root.require_child_recapture(recapture, child)?;
    let spec = ChildJobSpec::from_child_input(child)?;
    let purpose: PurposeProjection = serde_json::from_slice(&spec.private_storage_plaintext()?)
        .map_err(|_| anyhow::anyhow!("static_hls_child_purpose_required"))?;
    let identity = child.identity_statement();
    ensure!(
        reply.session_id == identity.session_id
            && reply.pending_job_id == identity.session_id
            && descriptor.session_id == identity.session_id
            && descriptor.input_sha256 == child.input_sha256()
            && descriptor.timeline_origin_ms == purpose.position_ms
            && reply.timeline_origin_ms == purpose.position_ms
            && purpose.selected_audio == recapture.selected_audio_statement()
            && recapture.source_origin_ms() == 0,
        "static_hls_child_publication_changed"
    );
    Ok(purpose)
}

fn require_metadata(
    input: &FrozenInput,
    root: &RootGraphStatement,
    reply: &ChildReply,
    recorded: &ChildCommittedPlanMetadata,
) -> Result<()> {
    ensure!(
        recorded.root_digest == root.root_digest()
            && Some(recorded.pending_job_id) == canonical_uuid(&reply.pending_job_id)
            && recorded.delivery_token_hash
                == format!("{:x}", Sha256::digest(reply.delivery_token.as_bytes()))
            && recorded.expires_at_ms <= input.root_deadline_ms()
            && recorded.prepare_expires_at_ms == input.preparation_deadline_ms()
            && recorded.published_at_ms <= recorded.observed_at_ms,
        "static_hls_child_publication_changed"
    );
    if let ChildAuthorityState::Published {
        timeline_origin_ms,
        output_published_at_ms,
        ..
    } = &recorded.authority
    {
        ensure!(
            *timeline_origin_ms == reply.timeline_origin_ms
                && *output_published_at_ms >= recorded.published_at_ms
                && *output_published_at_ms <= recorded.observed_at_ms,
            "static_hls_child_complete_evidence_required"
        );
    }
    Ok(())
}

fn require_unchanged(
    recorded: &ChildCommittedPlanMetadata,
    fresh: &ChildCommittedPlanMetadata,
) -> Result<()> {
    ensure!(
        fresh.root_digest == recorded.root_digest
            && fresh.inventory_encrypted == recorded.inventory_encrypted
            && fresh.descriptor_encrypted == recorded.descriptor_encrypted
            && fresh.delivery_token_hash == recorded.delivery_token_hash
            && fresh.pending_job_id == recorded.pending_job_id
            && fresh.published_at_ms == recorded.published_at_ms
            && fresh.expires_at_ms <= recorded.expires_at_ms
            && fresh.prepare_expires_at_ms == recorded.prepare_expires_at_ms
            && fresh.observed_at_ms >= recorded.observed_at_ms,
        "static_hls_child_publication_changed"
    );
    require_progression(&recorded.authority, &fresh.authority)
}

fn require_progression(before: &ChildAuthorityState, after: &ChildAuthorityState) -> Result<()> {
    use ChildAuthorityState::{Published, Queued, Running};
    let valid = match (before, after) {
        (Queued, Queued | Running { .. } | Published { .. }) => true,
        (
            Running {
                owner_id: old_owner,
                execution_id: old_execution,
                ..
            },
            Running {
                owner_id,
                execution_id,
                ..
            }
            | Published {
                owner_id,
                execution_id,
                ..
            },
        ) => old_owner == owner_id && old_execution == execution_id,
        (
            Published {
                owner_id: old_owner,
                execution_id: old_execution,
                evidence_sha256: old_evidence,
                output_published_at_ms: old_published,
                timeline_origin_ms: old_origin,
                duration_ms: old_duration,
                input_disposed: old_disposed,
                ..
            },
            Published {
                owner_id,
                execution_id,
                evidence_sha256,
                output_published_at_ms,
                timeline_origin_ms,
                duration_ms,
                input_disposed,
                ..
            },
        ) => {
            old_owner == owner_id
                && old_execution == execution_id
                && old_evidence == evidence_sha256
                && old_published == output_published_at_ms
                && old_origin == timeline_origin_ms
                && old_duration == duration_ms
                && (!old_disposed || *input_disposed)
        }
        _ => false,
    };
    ensure!(valid, "static_hls_child_publication_changed");
    Ok(())
}

struct Deadlines {
    root: Instant,
    pending: Option<Instant>,
}
fn deadlines(recorded: &ChildCommittedPlanMetadata, began: Instant) -> Result<Deadlines> {
    let remaining = |end: u64| -> Result<Instant> {
        let ms = end
            .checked_sub(recorded.observed_at_ms)
            .filter(|ms| *ms > 0)
            .context("static_hls_child_expired")?;
        began
            .checked_add(Duration::from_millis(ms))
            .context("static_hls_child_expired")
    };
    let pending = match &recorded.authority {
        ChildAuthorityState::Queued => Some(remaining(
            recorded
                .prepare_expires_at_ms
                .min(recorded.pending_lease_expires_at_ms),
        )?),
        ChildAuthorityState::Running {
            lease_expires_at_ms,
            ..
        } => Some(remaining(
            recorded
                .prepare_expires_at_ms
                .min(recorded.pending_lease_expires_at_ms)
                .min(*lease_expires_at_ms),
        )?),
        // A successful output has its original root lifetime, never an encode
        // lease or a freshly restarted preparation budget.
        ChildAuthorityState::Published { .. } => None,
    };
    Ok(Deadlines {
        root: remaining(recorded.expires_at_ms)?,
        pending,
    })
}

fn shortened_fences(first: Deadlines, latest: Deadlines) -> Result<Deadlines> {
    let pending = match latest.pending {
        Some(latest) => Some(
            latest.min(
                first
                    .pending
                    .context("static_hls_child_publication_changed")?,
            ),
        ),
        None => None,
    };
    Ok(Deadlines {
        root: first.root.min(latest.root),
        pending,
    })
}

fn fence_values(fences: &Deadlines, now: Instant) -> Result<(u32, u64)> {
    let root = fences.root.saturating_duration_since(now);
    let pending = fences.pending.map(|end| end.saturating_duration_since(now));
    ensure!(
        root.as_secs() > 0 && pending.is_none_or(|time| time.as_millis() > 0),
        "static_hls_child_expired"
    );
    Ok((
        u32::try_from(root.as_secs())?,
        u64::try_from(pending.map_or(0, |time| time.as_millis()))?,
    ))
}

#[cfg(test)]
fn remaining_fences(first: Deadlines, latest: Deadlines, now: Instant) -> Result<(u32, u64)> {
    fence_values(&shortened_fences(first, latest)?, now)
}

/// Private, nonserializable projection of the original committed child receipt.
/// The historical name is retained for preparation-call compatibility. Its only
/// public projection is an explicit fallible adapter; no ciphertext, inventory,
/// owner, root, source/login or output-proof field is serialized.
#[allow(dead_code)]
pub(crate) struct ChildQueuedPlan {
    session_id: Uuid,
    plan_generation: u32,
    media_id: Uuid,
    media_generation: u32,
    timeline_origin_ms: f64,
    source_duration_ms: f64,
    selected_audio_track: u32,
    delivery_token: String,
    fences: Deadlines,
    authority: ChildAuthorityState,
}

#[allow(dead_code)]
impl ChildQueuedPlan {
    pub(crate) fn session_id(&self) -> Uuid {
        self.session_id
    }
    pub(crate) fn pending_job_id(&self) -> Option<Uuid> {
        matches!(
            self.authority,
            ChildAuthorityState::Queued | ChildAuthorityState::Running { .. }
        )
        .then_some(self.session_id)
    }
    pub(crate) fn plan_generation(&self) -> u32 {
        self.plan_generation
    }
    pub(crate) fn media_id(&self) -> Uuid {
        self.media_id
    }
    pub(crate) fn media_generation(&self) -> u32 {
        self.media_generation
    }
    pub(crate) fn timeline_origin_ms(&self) -> f64 {
        self.timeline_origin_ms
    }
    pub(crate) fn selected_audio_track(&self) -> u32 {
        self.selected_audio_track
    }
    pub(crate) fn expires_in_seconds(&self) -> u32 {
        u32::try_from(
            self.fences
                .root
                .saturating_duration_since(Instant::now())
                .as_secs(),
        )
        .unwrap_or(0)
    }
    pub(crate) fn preparation_remaining_ms(&self) -> u64 {
        self.fences.pending.map_or(0, |end| {
            u64::try_from(end.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(0)
        })
    }

    /// This observes the exact committed child, without minting a new grant.
    /// Full output publication and positive input disposal are independent:
    /// published-but-unreadable stays Preparing, with no synthetic pending job.
    pub(crate) fn into_readiness(
        self,
        relative_position_ms: Option<f64>,
    ) -> Result<protocol::PlaybackReadiness> {
        fence_values(&self.fences, Instant::now())?;
        let position = relative_position_ms.unwrap_or(0.0);
        ensure!(
            valid_origin(position)
                && valid_origin(self.timeline_origin_ms)
                && valid_origin(self.source_duration_ms)
                && self.source_duration_ms > self.timeline_origin_ms
                && position <= self.source_duration_ms - self.timeline_origin_ms,
            "invalid_position"
        );
        use protocol::PreparationStatus::{Preparing, Queued, Ready};
        let pending_job_id = self.pending_job_id();
        let (status, complete, range) = match &self.authority {
            ChildAuthorityState::Queued => (Queued, false, None),
            ChildAuthorityState::Running { .. } => (Preparing, false, None),
            ChildAuthorityState::Published {
                input_disposed,
                public_output_authority,
                ..
            } => {
                let range = self.published_range()?;
                if *input_disposed && *public_output_authority {
                    // A full proof does not make an exclusive-end or later
                    // target playable. Both public intervals share this end.
                    let status = if position < range.end_ms - range.start_ms {
                        Ready
                    } else {
                        Preparing
                    };
                    (status, true, Some(range))
                } else {
                    (Preparing, true, None)
                }
            }
        };
        Ok(protocol::PlaybackReadiness {
            session_id: self.session_id,
            plan_generation: Some(self.plan_generation),
            status,
            complete,
            available_until_ms: Some(range.map_or(0.0, |range| range.end_ms - range.start_ms)),
            seekable_media_ranges_ms: Some(range.into_iter().collect()),
            pending_job_id,
            // Child fallback did not create an observation acceptance grant.
            observation_version: None,
            observation_seq: None,
        })
    }

    fn published_range(&self) -> Result<protocol::PlaybackMediaRange> {
        let ChildAuthorityState::Published {
            timeline_origin_ms,
            duration_ms,
            ..
        } = &self.authority
        else {
            anyhow::bail!("static_hls_child_complete_evidence_required");
        };
        ensure!(
            *timeline_origin_ms == self.timeline_origin_ms
                && valid_origin(*timeline_origin_ms)
                && duration_ms.is_finite()
                && *duration_ms > 0.0
                && valid_origin(timeline_origin_ms + duration_ms)
                && valid_origin(self.source_duration_ms),
            "static_hls_child_complete_evidence_required"
        );
        protocol::PlaybackMediaRange::new(
            *timeline_origin_ms,
            (timeline_origin_ms + duration_ms).min(self.source_duration_ms),
        )
        .context("static_hls_child_complete_evidence_required")
    }

    /// The dedicated URL is always bound to this receipt's authenticated token.
    /// A pending job's requested origin is intent, not measured output. A
    /// succeeded-but-undisposed output or closed read gate yields no public
    /// plan; clearing pending_job_id must never assert false readiness.
    pub(crate) fn into_playback_plan(self) -> Result<protocol::PlaybackPlan> {
        let (expires_in_seconds, _) = fence_values(&self.fences, Instant::now())?;
        let pending_job_id = self.pending_job_id();
        let ranges = match &self.authority {
            ChildAuthorityState::Queued | ChildAuthorityState::Running { .. } => vec![],
            ChildAuthorityState::Published {
                input_disposed,
                public_output_authority,
                ..
            } => {
                ensure!(
                    *input_disposed && *public_output_authority,
                    "static_hls_child_output_not_ready"
                );
                vec![self.published_range()?]
            }
        };
        Ok(protocol::PlaybackPlan {
            distributed_compute: None,
            local_hls_ladder: None,
            advanced_playback: None,
            native_platform: None,
            upstream_profile: None,
            session_id: self.session_id,
            plan_generation: Some(self.plan_generation),
            media_id: self.media_id,
            media_generation: self.media_generation,
            delivery_mode: "transcode".into(),
            transport: "hls".into(),
            playback_url: format!(
                "/media-delivery/{}/static-hls-child/{}/index.m3u8",
                self.session_id, self.delivery_token
            ),
            timeline_origin_ms: self.timeline_origin_ms,
            duration_ms: Some(self.source_duration_ms),
            expires_in_seconds,
            rebuild_on_seek: false,
            audio_tracks: vec![protocol::MediaTrack {
                index: self.selected_audio_track,
                label: "当前音轨".into(),
                language: String::new(),
                url: None,
            }],
            subtitle_tracks: vec![],
            decision_reason: None,
            selected_audio_track: Some(self.selected_audio_track),
            selected_candidate_id: None,
            selected_output: None,
            subtitle_mode: Some(protocol::SubtitleDeliveryMode::None),
            seekable_media_ranges_ms: Some(ranges),
            pending_job_id,
            decoder_fallback_modes: Some(vec![]),
            http_file_fallback_version: None,
            static_hls_fallback_version: None,
            observation_version: None,
            observation_seq: None,
            playback_metrics_version: None,
            playback_metrics: None,
        })
    }
}

/// The caller supplies only the original immutable reply returned after a
/// confirmed child publication COMMIT. Ciphertext, UUIDs and parsed statements
/// grant nothing: two bounded durable reads must confirm that exact completed
/// request/session/capture/root/job and current child authority. Missing gates,
/// unknown COMMIT, stale authorization and unrelated attempts yield no facts.
/// Neither this function nor its result renews a session or preparation budget.
#[allow(dead_code)]
pub(crate) async fn from_committed_publication(
    pool: &PgPool,
    key: &Aes256Gcm,
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    response_encrypted: &str,
) -> Result<ChildQueuedPlan> {
    ensure!(
        child.kind() == OperationKind::Child && parent.kind() == OperationKind::Parent,
        "static_hls_child_input_required"
    );
    let reply = parse_reply(key, response_encrypted)?;
    // Charge the entire acquisition/query/COMMIT round trip from its start.
    let began = Instant::now();
    let recorded = metadata(pool, child, parent, root, response_encrypted).await?;
    require_metadata(child, root, &reply, &recorded)?;
    let first = deadlines(&recorded, began)?;
    let descriptor = parse_descriptor(key, &recorded.descriptor_encrypted)?;
    let recapture = RootGraphStatement::parse_private_plaintext(&open_storage(
        key,
        &recorded.inventory_encrypted,
        262_144,
    )?)?;
    let purpose = require_statements(child, parent, root, &recapture, &reply, &descriptor)?;
    let SelectedAudioStatement::Single { stream_index } = purpose.selected_audio else {
        anyhow::bail!("static_hls_child_audio_required");
    };
    let identity = child.identity_statement();
    let session_id =
        canonical_uuid(&identity.session_id).context("static_hls_child_identity_invalid")?;
    let media_id =
        canonical_uuid(&identity.media_id).context("static_hls_child_identity_invalid")?;
    let plan_generation = u32::try_from(identity.plan_generation)?;
    let media_generation = u32::try_from(identity.media_generation)?;

    // Crypto/parsing holds no SQL locks. Recheck every live gate afterwards,
    // then shorten every local fence instead of restarting any lifetime.
    let checked = Instant::now();
    let fresh = metadata(pool, child, parent, root, response_encrypted).await?;
    require_metadata(child, root, &reply, &fresh)?;
    require_unchanged(&recorded, &fresh)?;
    let latest = deadlines(&fresh, checked)?;
    let fences = shortened_fences(first, latest)?;
    fence_values(&fences, Instant::now())?;
    Ok(ChildQueuedPlan {
        session_id,
        plan_generation,
        media_id,
        media_generation,
        timeline_origin_ms: purpose.position_ms,
        selected_audio_track: stream_index,
        source_duration_ms: root.duration_ms(),
        delivery_token: reply.delivery_token,
        fences,
        authority: fresh.authority,
    })
}

async fn metadata(
    pool: &PgPool,
    child: &FrozenInput,
    parent: &FrozenInput,
    root: &RootGraphStatement,
    ciphertext: &str,
) -> Result<ChildCommittedPlanMetadata> {
    tokio::time::timeout(
        Duration::from_millis(750),
        persistence::static_hls_child_publication::published_child_committed_plan_metadata(
            pool, child, parent, root, ciphertext,
        ),
    )
    .await??
    .context("static_hls_child_expired")
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::KeyInit;
    use serde_json::{Value, json};

    const PARENT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json");
    const ROOT: &[u8] =
        include_bytes!("../../../crates/media-core/src/static_hls/contracts/golden_root_v1.json");

    fn seal(key: &Aes256Gcm, bytes: &[u8]) -> String {
        let nonce = [19u8; 12];
        let encrypted = key.encrypt((&nonce).into(), bytes).unwrap();
        STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat())
    }
    fn statements(position_ms: f64) -> (FrozenInput, FrozenInput, RootGraphStatement) {
        let parent = FrozenInput::parse_private_plaintext(PARENT).unwrap();
        let root = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
        let mut value: Value = serde_json::from_slice(PARENT).unwrap();
        value["kind"] = json!("child");
        value["operation_id"] = json!("00000000-0000-0000-0000-00000000000d");
        value["session_id"] = json!("00000000-0000-0000-0000-00000000000e");
        value["request_owner_epoch"] = json!("00000000-0000-0000-0000-00000000000f");
        value["request_sha256"] = json!("2".repeat(64));
        value["plan_generation"] = json!(2);
        value["prepare_started_at_ms"] = json!(2000);
        value["prepare_expires_at_ms"] = json!(47000);
        value["position_ms"] = json!(position_ms);
        value["root"] = json!({"parent_session_id":parent.identity_statement().session_id,
            "parent_capture_id":parent.identity_statement().operation_id,
            "parent_input_sha256":parent.input_sha256(),"root_digest":root.root_digest(),
            "root_admitted_at_ms":1000,"root_hard_expires_at_ms":1801000,
            "selected_audio":{"kind":"single","stream_index":1}});
        let child =
            FrozenInput::parse_private_plaintext(&serde_json::to_vec(&value).unwrap()).unwrap();
        (parent, child, root)
    }
    fn reply(child: &FrozenInput, origin: f64) -> Value {
        json!({"version":1,"session_id":child.identity_statement().session_id,
            "delivery_token":"a".repeat(64),"delivery_mode":"transcode",
            "timeline_origin_ms":origin,"pending_job_id":child.identity_statement().session_id})
    }
    fn descriptor(child: &FrozenInput, origin: f64) -> Value {
        json!({"kind":"http","transport":"hls","delivery_mode":"transcode",
            "session_id":child.identity_statement().session_id,"input_sha256":child.input_sha256(),
            "timeline_origin_ms":origin})
    }
    fn key() -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&[17u8; 32]).unwrap()
    }
    fn encrypted(key: &Aes256Gcm, value: &Value) -> String {
        seal(key, &serde_json::to_vec(value).unwrap())
    }

    fn recorded(child: &FrozenInput, root: &RootGraphStatement) -> ChildCommittedPlanMetadata {
        ChildCommittedPlanMetadata {
            delivery_token_hash: format!("{:x}", Sha256::digest("a".repeat(64).as_bytes())),
            descriptor_encrypted: "immutable-descriptor-ciphertext".into(),
            inventory_encrypted: "immutable-inventory-ciphertext".into(),
            root_digest: root.root_digest().into(),
            published_at_ms: 2_500,
            expires_at_ms: child.root_deadline_ms(),
            prepare_expires_at_ms: child.preparation_deadline_ms(),
            pending_lease_expires_at_ms: 60_000,
            observed_at_ms: 3_000,
            pending_job_id: canonical_uuid(&child.identity_statement().session_id).unwrap(),
            authority: ChildAuthorityState::Queued,
        }
    }

    #[test]
    fn reply_is_a_closed_authenticated_object_with_no_fallback_or_source_payload() {
        let (_, child, _) = statements(0.0);
        let key = key();
        let value = reply(&child, 0.0);
        assert!(parse_reply(&key, &encrypted(&key, &value)).is_ok());
        for field in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(parse_reply(&key, &encrypted(&key, &missing)).is_err());
        }
        for field in [
            "root",
            "source",
            "login",
            "static_hls_fallback_version",
            "http_file_fallback_version",
        ] {
            let mut unknown = value.clone();
            unknown[field] = json!("https://private.invalid/?credential=secret");
            let error = parse_reply(&key, &encrypted(&key, &unknown)).err().unwrap();
            assert_eq!(error.to_string(), "static_hls_child_reply_shape");
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        let duplicate = format!(
            "{{\"version\":1,{}",
            std::str::from_utf8(&bytes).unwrap().trim_start_matches('{')
        );
        assert!(parse_reply(&key, &seal(&key, duplicate.as_bytes())).is_err());
        let array = Value::Array(value.as_object().unwrap().values().cloned().collect());
        assert!(parse_reply(&key, &encrypted(&key, &array)).is_err());
        assert!(parse_reply(&key, "").is_err());
        assert!(parse_reply(&key, &"x".repeat(2049)).is_err());
        assert!(parse_reply(&key, &STANDARD.encode([0u8; 28])).is_err());
        let wrong = Aes256Gcm::new_from_slice(&[18u8; 32]).unwrap();
        assert!(parse_reply(&wrong, &encrypted(&key, &value)).is_err());
    }

    #[test]
    fn reply_refuses_aliases_foreign_job_invalid_mode_token_and_origin() {
        let (_, child, _) = statements(0.0);
        let key = key();
        for (field, value) in [
            ("version", json!(2)),
            ("session_id", json!(Uuid::nil())),
            ("session_id", json!("0000000000000000000000000000000e")),
            (
                "pending_job_id",
                json!("00000000-0000-0000-0000-00000000000d"),
            ),
            ("delivery_mode", json!("direct")),
            ("delivery_token", json!("A".repeat(64))),
            ("delivery_token", json!("a".repeat(63))),
            ("timeline_origin_ms", json!(-1)),
            ("timeline_origin_ms", json!(MAX_SAFE_INTEGER + 1)),
        ] {
            let mut changed = reply(&child, 0.0);
            changed[field] = value;
            assert!(parse_reply(&key, &encrypted(&key, &changed)).is_err());
        }
    }

    #[test]
    fn fractional_child_origin_is_frozen_purpose_not_the_zero_origin_capture() {
        let (parent, child, root) = statements(13.125);
        let key = key();
        let reply = parse_reply(&key, &encrypted(&key, &reply(&child, 13.125))).unwrap();
        let descriptor =
            parse_descriptor(&key, &encrypted(&key, &descriptor(&child, 13.125))).unwrap();
        let recapture = RootGraphStatement::parse_private_plaintext(ROOT).unwrap();
        let purpose =
            require_statements(&child, &parent, &root, &recapture, &reply, &descriptor).unwrap();
        assert_eq!(purpose.position_ms, 13.125);
        assert_eq!(recapture.source_origin_ms(), 0);
        let mut wrong = descriptor;
        wrong.timeline_origin_ms = 0.0;
        assert!(require_statements(&child, &parent, &root, &recapture, &reply, &wrong).is_err());
        wrong.timeline_origin_ms = 13.125;
        wrong.input_sha256 = parent.input_sha256().into();
        assert!(require_statements(&child, &parent, &root, &recapture, &reply, &wrong).is_err());
    }

    #[test]
    fn descriptor_rejects_extensible_and_positional_job_or_source_aliases() {
        let (_, child, _) = statements(0.0);
        let key = key();
        let value = descriptor(&child, 0.0);
        assert!(parse_descriptor(&key, &encrypted(&key, &value)).is_ok());
        for field in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(parse_descriptor(&key, &encrypted(&key, &missing)).is_err());
        }
        for field in ["job_id", "root_digest", "url", "static_hls_fallback"] {
            let mut unknown = value.clone();
            unknown[field] = json!("private");
            assert!(parse_descriptor(&key, &encrypted(&key, &unknown)).is_err());
        }
        let array = Value::Array(value.as_object().unwrap().values().cloned().collect());
        assert!(parse_descriptor(&key, &encrypted(&key, &array)).is_err());
    }

    #[test]
    fn metadata_requires_real_reply_token_job_root_and_original_preparation_fence() {
        let (_, child, root) = statements(0.0);
        let key = key();
        let reply = parse_reply(&key, &encrypted(&key, &reply(&child, 0.0))).unwrap();
        let original = recorded(&child, &root);
        assert!(require_metadata(&child, &root, &reply, &original).is_ok());
        let mut changed = recorded(&child, &root);
        changed.delivery_token_hash = "b".repeat(64);
        assert!(require_metadata(&child, &root, &reply, &changed).is_err());
        changed = recorded(&child, &root);
        changed.pending_job_id = Uuid::nil();
        assert!(require_metadata(&child, &root, &reply, &changed).is_err());
        changed = recorded(&child, &root);
        changed.root_digest = "c".repeat(64);
        assert!(require_metadata(&child, &root, &reply, &changed).is_err());
        changed = recorded(&child, &root);
        changed.expires_at_ms += 1;
        assert!(require_metadata(&child, &root, &reply, &changed).is_err());
        changed = recorded(&child, &root);
        changed.prepare_expires_at_ms += 1;
        assert!(require_metadata(&child, &root, &reply, &changed).is_err());
        changed = recorded(&child, &root);
        changed.descriptor_encrypted.push('x');
        assert!(require_unchanged(&original, &changed).is_err());
        changed = recorded(&child, &root);
        changed.inventory_encrypted.push('x');
        assert!(require_unchanged(&original, &changed).is_err());
    }

    #[test]
    fn both_round_trips_and_original_lease_limit_queued_facts_without_renewal() {
        let (_, child, root) = statements(0.0);
        let mut original = recorded(&child, &root);
        original.pending_lease_expires_at_ms = 3_600;
        let mut fresh = recorded(&child, &root);
        fresh.observed_at_ms = 3_100;
        fresh.pending_lease_expires_at_ms = 10_000;
        let began = Instant::now();
        let checked = began + Duration::from_millis(200);
        let finished = began + Duration::from_millis(500);
        let (_, preparation_remaining_ms) = remaining_fences(
            deadlines(&original, began).unwrap(),
            deadlines(&fresh, checked).unwrap(),
            finished,
        )
        .unwrap();
        assert_eq!(preparation_remaining_ms, 100);
        assert!(
            remaining_fences(
                deadlines(&original, began).unwrap(),
                deadlines(&fresh, checked).unwrap(),
                began + Duration::from_millis(600),
            )
            .is_err()
        );
        original.observed_at_ms = original.prepare_expires_at_ms;
        assert!(deadlines(&original, began).is_err());
        original.observed_at_ms = original.expires_at_ms;
        assert!(deadlines(&original, began).is_err());
    }

    fn running(owner: Uuid, execution: Uuid, lease: u64) -> ChildAuthorityState {
        ChildAuthorityState::Running {
            owner_id: owner,
            execution_id: execution,
            lease_expires_at_ms: lease,
        }
    }
    fn published(owner: Uuid, execution: Uuid, disposed: bool, read: bool) -> ChildAuthorityState {
        ChildAuthorityState::Published {
            owner_id: owner,
            execution_id: execution,
            evidence_sha256: "b".repeat(64),
            output_published_at_ms: 3_200,
            timeline_origin_ms: 13.0,
            duration_ms: 987.0,
            input_disposed: disposed,
            public_output_authority: read,
        }
    }
    fn wrapper(authority: ChildAuthorityState) -> ChildQueuedPlan {
        let (_, child, root) = statements(13.0);
        ChildQueuedPlan {
            session_id: canonical_uuid(&child.identity_statement().session_id).unwrap(),
            plan_generation: 2,
            media_id: canonical_uuid(&child.identity_statement().media_id).unwrap(),
            media_generation: 1,
            timeline_origin_ms: 13.0,
            source_duration_ms: root.duration_ms(),
            selected_audio_track: 1,
            delivery_token: "a".repeat(64),
            fences: Deadlines {
                root: Instant::now() + Duration::from_secs(30),
                pending: matches!(
                    authority,
                    ChildAuthorityState::Queued | ChildAuthorityState::Running { .. }
                )
                .then(|| Instant::now() + Duration::from_secs(1)),
            },
            authority,
        }
    }

    #[test]
    fn original_receipt_survives_only_forward_execution_without_reownership() {
        let owner = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let queue = ChildAuthorityState::Queued;
        let run = running(owner, execution, 4_000);
        let output = published(owner, execution, false, false);
        assert!(require_progression(&queue, &run).is_ok());
        assert!(require_progression(&queue, &output).is_ok());
        assert!(require_progression(&run, &output).is_ok());
        assert!(require_progression(&run, &queue).is_err());
        assert!(require_progression(&output, &run).is_err());
        assert!(require_progression(&run, &running(Uuid::new_v4(), execution, 5_000)).is_err());
        assert!(require_progression(&run, &published(owner, Uuid::new_v4(), true, true)).is_err());
        let disposed = published(owner, execution, true, true);
        assert!(require_progression(&output, &disposed).is_ok());
        assert!(require_progression(&disposed, &output).is_err());
        let mut changed = published(owner, execution, true, true);
        if let ChildAuthorityState::Published {
            evidence_sha256, ..
        } = &mut changed
        {
            *evidence_sha256 = "c".repeat(64);
        }
        assert!(require_progression(&disposed, &changed).is_err());
    }

    #[test]
    fn successful_output_keeps_original_root_without_restarting_preparation() {
        let (_, child, root) = statements(13.0);
        let mut original = recorded(&child, &root);
        original.pending_lease_expires_at_ms = 3_100;
        let mut fresh = recorded(&child, &root);
        fresh.observed_at_ms = 100_000;
        fresh.authority = published(Uuid::new_v4(), Uuid::new_v4(), true, true);
        let began = Instant::now();
        let later = began + Duration::from_secs(97);
        let (remaining, pending) = remaining_fences(
            deadlines(&original, began).unwrap(),
            deadlines(&fresh, later).unwrap(),
            later,
        )
        .unwrap();
        assert!(remaining > 0);
        assert_eq!(pending, 0);
        fresh.observed_at_ms = fresh.expires_at_ms;
        assert!(deadlines(&fresh, later).is_err());
    }

    #[test]
    fn pending_plan_has_dedicated_receipt_url_without_ready_evidence_or_recursion() {
        for authority in [
            ChildAuthorityState::Queued,
            running(Uuid::new_v4(), Uuid::new_v4(), 4_000),
        ] {
            let plan = wrapper(authority).into_playback_plan().unwrap();
            assert_eq!(plan.pending_job_id, Some(plan.session_id));
            assert_eq!(plan.timeline_origin_ms, 13.0);
            assert_eq!(plan.delivery_mode, "transcode");
            assert_eq!(plan.transport, "hls");
            assert_eq!(
                plan.playback_url,
                format!(
                    "/media-delivery/{}/static-hls-child/{}/index.m3u8",
                    plan.session_id,
                    "a".repeat(64)
                )
            );
            assert_eq!(plan.seekable_media_ranges_ms, Some(vec![]));
            assert!(plan.selected_output.is_none());
            assert!(plan.static_hls_fallback_version.is_none());
            assert!(plan.http_file_fallback_version.is_none());
            assert!(!plan.rebuild_on_seek);
            let public = serde_json::to_value(plan).unwrap();
            for secret in [
                "root_digest",
                "inventory",
                "descriptor_encrypted",
                "source",
                "owner_id",
                "evidence_sha256",
                "auth_login_hash",
                "relative_dir",
            ] {
                assert!(!public.to_string().contains(secret));
            }
        }
    }

    #[test]
    fn published_projection_needs_both_disposal_and_independent_read_authority() {
        let owner = Uuid::new_v4();
        let execution = Uuid::new_v4();
        for (disposed, read) in [(false, false), (false, true), (true, false)] {
            let error = wrapper(published(owner, execution, disposed, read))
                .into_playback_plan()
                .unwrap_err();
            assert_eq!(error.to_string(), "static_hls_child_output_not_ready");
        }
        let plan = wrapper(published(owner, execution, true, true))
            .into_playback_plan()
            .unwrap();
        assert!(plan.pending_job_id.is_none());
        let range = plan.seekable_media_ranges_ms.unwrap()[0];
        assert_eq!(range.start_ms, 13.0);
        assert_eq!(range.end_ms, 1_000.0);
        // CFR duplication/padding can extend the measured output by part of a
        // frame. This never expands the original media's seekable interval.
        let mut padded = wrapper(published(owner, execution, true, true));
        padded.source_duration_ms = 990.0;
        let padded = padded.into_playback_plan().unwrap();
        assert_eq!(padded.seekable_media_ranges_ms.unwrap()[0].end_ms, 990.0);
        let mut expired = wrapper(published(owner, execution, true, true));
        expired.fences.root = Instant::now();
        assert!(expired.into_playback_plan().is_err());
        let mut expired = wrapper(ChildAuthorityState::Queued);
        expired.fences.pending = Some(Instant::now());
        assert!(expired.into_playback_plan().is_err());
    }

    #[test]
    fn pending_plan_polling_reaches_ready_only_after_the_real_child_read_gate() {
        use protocol::PreparationStatus::{Preparing, Queued, Ready};
        let owner = Uuid::new_v4();
        let execution = Uuid::new_v4();
        let initial = wrapper(ChildAuthorityState::Queued)
            .into_playback_plan()
            .unwrap();
        assert_eq!(initial.pending_job_id, Some(initial.session_id));
        for (authority, status, complete, pending) in [
            (ChildAuthorityState::Queued, Queued, false, true),
            (running(owner, execution, 4_000), Preparing, false, true),
            (
                published(owner, execution, false, false),
                Preparing,
                true,
                false,
            ),
            (published(owner, execution, true, true), Ready, true, false),
        ] {
            let readiness = wrapper(authority).into_readiness(Some(0.0)).unwrap();
            // This is the same serialized DTO consumed by the frontend poller.
            let readiness: protocol::PlaybackReadiness =
                serde_json::from_value(serde_json::to_value(readiness).unwrap()).unwrap();
            assert_eq!(readiness.session_id, initial.session_id);
            assert_eq!(readiness.plan_generation, initial.plan_generation);
            assert_eq!(readiness.status, status);
            assert_eq!(readiness.complete, complete);
            assert_eq!(
                readiness.pending_job_id,
                pending.then_some(initial.session_id)
            );
            if status == Ready {
                assert_eq!(readiness.available_until_ms, Some(987.0));
                assert_eq!(
                    readiness.seekable_media_ranges_ms.unwrap()[0].start_ms,
                    13.0
                );
            } else {
                assert_eq!(readiness.available_until_ms, Some(0.0));
                assert_eq!(readiness.seekable_media_ranges_ms, Some(vec![]));
            }
        }
    }

    #[test]
    fn published_readiness_never_substitutes_completion_for_positive_disposal_and_read() {
        use protocol::PreparationStatus::Preparing;
        let owner = Uuid::new_v4();
        let execution = Uuid::new_v4();
        for (disposed, read) in [(false, false), (false, true), (true, false)] {
            let readiness = wrapper(published(owner, execution, disposed, read))
                .into_readiness(None)
                .unwrap();
            assert_eq!(readiness.status, Preparing);
            assert!(readiness.complete);
            assert!(readiness.pending_job_id.is_none());
            assert_eq!(readiness.available_until_ms, Some(0.0));
            assert_eq!(readiness.seekable_media_ranges_ms, Some(vec![]));
        }
    }

    #[test]
    fn readiness_uses_relative_exclusive_end_and_clips_fractional_cfr_padding() {
        use protocol::PreparationStatus::{Preparing, Ready};
        let owner = Uuid::new_v4();
        let execution = Uuid::new_v4();
        assert_eq!(
            wrapper(published(owner, execution, true, true))
                .into_readiness(Some(986.999))
                .unwrap()
                .status,
            Ready
        );
        let end = wrapper(published(owner, execution, true, true))
            .into_readiness(Some(987.0))
            .unwrap();
        assert_eq!(end.status, Preparing);
        assert!(end.complete);
        assert_eq!(end.available_until_ms, Some(987.0));
        let mut padded = wrapper(published(owner, execution, true, true));
        padded.timeline_origin_ms = 13.125;
        padded.source_duration_ms = 999.9375;
        if let ChildAuthorityState::Published {
            timeline_origin_ms, ..
        } = &mut padded.authority
        {
            *timeline_origin_ms = 13.125;
        }
        let padded = padded.into_readiness(Some(986.0)).unwrap();
        assert_eq!(padded.status, Ready);
        assert_eq!(padded.available_until_ms, Some(986.8125));
        let range = padded.seekable_media_ranges_ms.unwrap()[0];
        assert_eq!(range.start_ms, 13.125);
        assert_eq!(range.end_ms, 999.9375);
    }

    #[test]
    fn readiness_rejects_unbounded_targets_and_original_expired_fences() {
        for position in [
            -0.001,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            MAX_SAFE_INTEGER as f64 + 1.0,
            987.001,
        ] {
            let error = wrapper(ChildAuthorityState::Queued)
                .into_readiness(Some(position))
                .unwrap_err();
            assert_eq!(error.to_string(), "invalid_position");
        }
        let mut expired = wrapper(ChildAuthorityState::Queued);
        expired.fences.pending = Some(Instant::now());
        assert_eq!(
            expired.into_readiness(None).unwrap_err().to_string(),
            "static_hls_child_expired"
        );
        let mut expired = wrapper(published(Uuid::new_v4(), Uuid::new_v4(), true, true));
        expired.fences.root = Instant::now();
        assert_eq!(
            expired.into_readiness(None).unwrap_err().to_string(),
            "static_hls_child_expired"
        );
    }

    #[test]
    fn readiness_projection_has_no_token_private_tuple_or_observation_grant() {
        let readiness = wrapper(published(Uuid::new_v4(), Uuid::new_v4(), true, true))
            .into_readiness(None)
            .unwrap();
        assert!(readiness.observation_version.is_none());
        assert!(readiness.observation_seq.is_none());
        let public = serde_json::to_string(&readiness).unwrap();
        for secret in [
            "a".repeat(64),
            "delivery_token".into(),
            "playback_url".into(),
            "root_digest".into(),
            "inventory".into(),
            "cipher".into(),
            "source".into(),
            "owner_id".into(),
            "evidence_sha256".into(),
            "auth_login_hash".into(),
            "relative_dir".into(),
            "observation_".into(),
        ] {
            assert!(
                !public.contains(&secret),
                "leaked readiness field: {secret}"
            );
        }
    }

    #[test]
    fn child_queue_snapshot_cannot_be_cloned_or_serialized_as_a_playback_grant() {
        trait AmbiguousSerialize<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousSerialize<()> for T {}
        impl<T: ?Sized + serde::Serialize> AmbiguousSerialize<u8> for T {}
        let _ = <ChildQueuedPlan as AmbiguousSerialize<_>>::check;
        trait AmbiguousClone<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousClone<()> for T {}
        impl<T: Clone> AmbiguousClone<u8> for T {}
        let _ = <ChildQueuedPlan as AmbiguousClone<_>>::check;
    }
}
