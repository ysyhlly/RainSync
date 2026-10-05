//! Off-only private operation statements. No RPC endpoint, owner registry,
//! admission, replay store, capture, publication or disposal proof exists here.
//! The caller must load trusted input/identity and positively observe the fresh
//! cache challenge on both sides. Equality of caller-supplied statements cannot
//! establish those facts, consume a nonce or prevent replay within its lifetime.
//! A later consumer also needs trustworthy same-login DB/actual Worker/cache
//! observations and one-use challenge state; no success here is a live permit.
use super::input::{FrozenInput, IdentityStatement, OperationKind, SelectedAudioStatement};
use super::*;
use serde::{Deserialize, Serialize};

pub const RPC_VERSION: u8 = 1;
pub const RPC_LIFETIME_MS: u64 = 6_000;
pub const MAX_REQUEST_PLAINTEXT_BYTES: usize = 3_044;
pub const MAX_REQUEST_CIPHERTEXT_BYTES: usize = 4_096;
pub const MAX_RESPONSE_PLAINTEXT_BYTES: usize = 6_116;
pub const MAX_RESPONSE_CIPHERTEXT_BYTES: usize = 8_192;
pub const MAX_CHILD_QUEUED_REPLY_CIPHERTEXT_BYTES: usize = 2_048;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Create,
    Publish,
    PublishChild,
    Query,
    Cancel,
}
impl Action {
    fn request_purpose(self) -> &'static str {
        match self {
            Self::Create => "rainsync-static-hls-create-request-v1",
            Self::Publish => "rainsync-static-hls-parent-publication-request-v1",
            Self::PublishChild => "rainsync-static-hls-child-publication-request-v1",
            Self::Query => "rainsync-static-hls-query-request-v1",
            Self::Cancel => "rainsync-static-hls-cancel-request-v1",
        }
    }
    fn response_purpose(self) -> &'static str {
        match self {
            Self::Create => "rainsync-static-hls-create-response-v1",
            Self::Publish => "rainsync-static-hls-parent-publication-response-v1",
            Self::PublishChild => "rainsync-static-hls-child-publication-response-v1",
            Self::Query => "rainsync-static-hls-query-response-v1",
            Self::Cancel => "rainsync-static-hls-cancel-response-v1",
        }
    }
    fn from_request_purpose(purpose: &str) -> Result<Self> {
        [
            Self::Create,
            Self::Publish,
            Self::PublishChild,
            Self::Query,
            Self::Cancel,
        ]
        .into_iter()
        .find(|action| action.request_purpose() == purpose)
        .ok_or(ContractError::Version)
    }
    fn from_response_purpose(purpose: &str) -> Result<Self> {
        [
            Self::Create,
            Self::Publish,
            Self::PublishChild,
            Self::Query,
            Self::Cancel,
        ]
        .into_iter()
        .find(|action| action.response_purpose() == purpose)
        .ok_or(ContractError::Version)
    }
    fn require_operation_kind(self, kind: OperationKind) -> Result<()> {
        require(
            match self {
                Self::Publish => kind == OperationKind::Parent,
                Self::PublishChild => kind == OperationKind::Child,
                Self::Create | Self::Query | Self::Cancel => true,
            },
            ContractError::Facts,
        )
    }
}

// Unit-enum derives can accept object aliases. These enums accept strings only.
macro_rules! string_enum {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
        pub enum $name { $(#[serde(rename = $wire)] $variant),+ }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
                match String::deserialize(deserializer)?.as_str() {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(serde::de::Error::custom("unsupported operation code")),
                }
            }
        }
    };
}
string_enum!(PendingStage { Capture => "capture", Verify => "verify", Publish => "publish", Drain => "drain" });
string_enum!(Reason {
    UnsupportedInput => "unsupported_input", SourceChanged => "source_changed",
    AuthorityRevoked => "authority_revoked", Deadline => "deadline", Capacity => "capacity",
    UnsupportedVersion => "unsupported_version", WorkerMismatch => "worker_mismatch",
    LocalOwnerMissing => "local_owner_missing", OperationConflict => "operation_conflict",
    Cancelled => "cancelled", Unavailable => "unavailable"
});

// Field order follows the closed design; this is typed serde JSON, not JCS.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Binding {
    operation_id: String,
    operation_kind: OperationKind,
    session_id: String,
    request_owner_epoch: String,
    request_sha256: String,
    input_sha256: String,
    worker_instance: String,
    database: String,
    challenge: String,
    cache_challenge_sha256: String,
    reader_version: u8,
    recipe_version: u8,
    input_version: u8,
    graph_version: u8,
    issued_at_ms: u64,
    rpc_expires_at_ms: u64,
    root_hard_expires_at_ms: u64,
    prepare_expires_at_ms: u64,
}
impl Binding {
    fn validate(&self) -> Result<()> {
        require(
            (
                self.reader_version,
                self.recipe_version,
                self.input_version,
                self.graph_version,
            ) == (READER_VERSION, RECIPE_VERSION, INPUT_VERSION, GRAPH_VERSION),
            ContractError::Version,
        )?;
        require(
            [
                &self.operation_id,
                &self.session_id,
                &self.request_owner_epoch,
                &self.worker_instance,
                &self.database,
                &self.challenge,
            ]
            .into_iter()
            .all(|value| uuid(value))
                && self.operation_id != self.session_id
                && [
                    &self.request_sha256,
                    &self.input_sha256,
                    &self.cache_challenge_sha256,
                ]
                .into_iter()
                .all(|value| hash(value)),
            ContractError::Identity,
        )?;
        require(
            [
                self.issued_at_ms,
                self.rpc_expires_at_ms,
                self.root_hard_expires_at_ms,
                self.prepare_expires_at_ms,
            ]
            .into_iter()
            .all(|value| value <= MAX_SAFE_INTEGER),
            ContractError::Bounds,
        )?;
        require(
            self.issued_at_ms < self.rpc_expires_at_ms
                && self.rpc_expires_at_ms - self.issued_at_ms <= RPC_LIFETIME_MS
                && self.prepare_expires_at_ms <= self.root_hard_expires_at_ms,
            ContractError::Deadline,
        )
    }
}

/// Trusted per-call cache observation supplied by the later consumer after both
/// sides read the same 64-byte owned probe under the current DB expiry fence.
/// This type performs no I/O, nonce consumption or proof of freshness by itself.
pub struct ChallengeObservation {
    pub challenge: String,
    pub cache_challenge_sha256: String,
    pub challenge_expires_at_ms: u64,
}
pub struct RpcWindow {
    pub issued_at_ms: u64,
    pub rpc_expires_at_ms: u64,
}

/// Expected context comes only from trusted frozen input/current observations,
/// never from the peer's envelope. It retains the exact original login through
/// the full identity statement without adding a credential to the wire format.
/// No Debug/serde projection can expose that original login or whole input.
pub struct ExpectedBinding {
    binding: Binding,
    frozen_input: FrozenInput,
    original_identity: IdentityStatement,
    challenge_expires_at_ms: u64,
}
impl ExpectedBinding {
    pub fn from_trusted_input(
        input: &FrozenInput,
        current_identity: &IdentityStatement,
        challenge: ChallengeObservation,
        rpc: RpcWindow,
        now_ms: u64,
    ) -> Result<Self> {
        input.require_identity_statement(current_identity)?;
        require(
            challenge.challenge_expires_at_ms <= MAX_SAFE_INTEGER,
            ContractError::Bounds,
        )?;
        let identity = input.identity_statement();
        let expected = Self {
            frozen_input: input.clone(),
            binding: Binding {
                operation_id: identity.operation_id.clone(),
                operation_kind: input.kind(),
                session_id: identity.session_id.clone(),
                request_owner_epoch: identity.request_owner_epoch.clone(),
                request_sha256: identity.request_sha256.clone(),
                input_sha256: input.input_sha256().into(),
                worker_instance: identity.worker_instance.clone(),
                database: identity.database.clone(),
                challenge: challenge.challenge,
                cache_challenge_sha256: challenge.cache_challenge_sha256,
                reader_version: READER_VERSION,
                recipe_version: RECIPE_VERSION,
                input_version: INPUT_VERSION,
                graph_version: GRAPH_VERSION,
                issued_at_ms: rpc.issued_at_ms,
                rpc_expires_at_ms: rpc.rpc_expires_at_ms,
                root_hard_expires_at_ms: input.root_deadline_ms(),
                prepare_expires_at_ms: input.preparation_deadline_ms(),
            },
            original_identity: identity,
            challenge_expires_at_ms: challenge.challenge_expires_at_ms,
        };
        expected.binding.validate()?;
        expected.require_fresh(now_ms)?;
        Ok(expected)
    }
    /// Charge all challenge/transport/DB/cache time from the call's start and
    /// repeat after every wait. Exact expiry is already too late.
    pub fn require_fresh(&self, now_ms: u64) -> Result<()> {
        require(now_ms <= MAX_SAFE_INTEGER, ContractError::Bounds)?;
        require(
            self.binding.issued_at_ms <= now_ms
                && now_ms < self.binding.rpc_expires_at_ms
                && now_ms < self.challenge_expires_at_ms,
            ContractError::Deadline,
        )
    }
    fn require_call(
        &self,
        action: Action,
        now_ms: u64,
        authority: &CallAuthority<'_>,
    ) -> Result<()> {
        self.require_fresh(now_ms)?;
        action.require_operation_kind(self.binding.operation_kind)?;
        match (action, authority) {
            (Action::Create, CallAuthority::LivePending(statement)) => {
                require(
                    statement.current_identity == &self.original_identity,
                    ContractError::Identity,
                )?;
                require(
                    statement.pending_lease_expires_at_ms <= MAX_SAFE_INTEGER,
                    ContractError::Bounds,
                )?;
                require(
                    statement.current_authority_live
                        && statement.observed_at_ms <= now_ms
                        && now_ms < statement.pending_lease_expires_at_ms
                        && now_ms < self.binding.root_hard_expires_at_ms
                        && now_ms < self.binding.prepare_expires_at_ms,
                    ContractError::Deadline,
                )
            }
            (Action::Create, CallAuthority::ObservationOnly) => Err(ContractError::Facts),
            (Action::Publish | Action::PublishChild, CallAuthority::LivePublication(statement)) => {
                self.require_publication_authority(now_ms, statement)?;
                if action == Action::PublishChild {
                    require(
                        now_ms < self.binding.prepare_expires_at_ms
                            && now_ms < statement.pending_lease_expires_at_ms,
                        ContractError::Deadline,
                    )?;
                }
                Ok(())
            }
            (Action::Publish | Action::PublishChild, _)
            | (Action::Create, CallAuthority::LivePublication(_)) => Err(ContractError::Facts),
            (Action::Query | Action::Cancel, _) => Ok(()),
        }
    }
    fn require_publication_authority(
        &self,
        now_ms: u64,
        statement: &LivePublicationAuthorityStatement<'_>,
    ) -> Result<()> {
        require(
            statement.current_identity == &self.original_identity,
            ContractError::Identity,
        )?;
        require(
            statement.pending_lease_expires_at_ms <= MAX_SAFE_INTEGER,
            ContractError::Bounds,
        )?;
        require(
            statement.current_authority_live
                && statement.observed_at_ms <= now_ms
                && now_ms < self.binding.root_hard_expires_at_ms
                && (!statement.pending
                    || (now_ms < statement.pending_lease_expires_at_ms
                        && now_ms < self.binding.prepare_expires_at_ms)),
            ContractError::Deadline,
        )
    }
}

/// Caller-supplied live pending observations, not a minted authorization permit.
/// A later consumer must recheck current live authority after every wait and
/// before any work; constructing this statement cannot create work authority.
pub struct LivePendingAuthorityStatement<'a> {
    pub current_identity: &'a IdentityStatement,
    pub current_authority_live: bool,
    pub observed_at_ms: u64,
    pub pending_lease_expires_at_ms: u64,
}
pub struct LivePublicationAuthorityStatement<'a> {
    /// The current exact operation identity. A child's stopped parent is never
    /// its current authority, including when querying an already queued reply.
    pub current_identity: &'a IdentityStatement,
    pub current_authority_live: bool,
    pub observed_at_ms: u64,
    /// False for a committed child queue. Such a reply still requires the
    /// original preparation/root/request-lease fences; it has no output grant.
    pub pending: bool,
    /// The original retained request lease, including for a completed child.
    pub pending_lease_expires_at_ms: u64,
}
pub enum CallAuthority<'a> {
    ObservationOnly,
    LivePending(LivePendingAuthorityStatement<'a>),
    LivePublication(LivePublicationAuthorityStatement<'a>),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RequestWire {
    purpose: String,
    rpc_version: u8,
    binding: Object<Binding>,
}
/// A closed parsed statement, still requiring the independent expected context.
pub struct OperationRequest {
    wire: RequestWire,
    action: Action,
    bytes: Vec<u8>,
}
impl OperationRequest {
    pub fn parse_private_plaintext(bytes: &[u8]) -> Result<Self> {
        plaintext_size(bytes, MAX_REQUEST_PLAINTEXT_BYTES)?;
        let Object(wire): Object<RequestWire> =
            serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
        require(wire.rpc_version == RPC_VERSION, ContractError::Version)?;
        let action = Action::from_request_purpose(&wire.purpose)?;
        wire.binding.validate()?;
        action.require_operation_kind(wire.binding.operation_kind)?;
        let bytes = serde_json::to_vec(&wire).map_err(|_| ContractError::Shape)?;
        plaintext_size(&bytes, MAX_REQUEST_PLAINTEXT_BYTES)?;
        Ok(Self {
            wire,
            action,
            bytes,
        })
    }
    pub fn for_expected(
        action: Action,
        expected: &ExpectedBinding,
        now_ms: u64,
        authority: CallAuthority<'_>,
    ) -> Result<Self> {
        expected.require_call(action, now_ms, &authority)?;
        let wire = RequestWire {
            purpose: action.request_purpose().into(),
            rpc_version: RPC_VERSION,
            binding: Object(expected.binding.clone()),
        };
        Self::parse_private_plaintext(&serde_json::to_vec(&wire).map_err(|_| ContractError::Shape)?)
    }
    pub fn validate_expected(
        &self,
        action: Action,
        expected: &ExpectedBinding,
        now_ms: u64,
        authority: CallAuthority<'_>,
    ) -> Result<()> {
        require(self.action == action, ContractError::Version)?;
        require(
            self.wire.binding.0 == expected.binding,
            ContractError::Identity,
        )?;
        expected.require_call(self.action, now_ms, &authority)
    }
    pub fn action(&self) -> Action {
        self.action
    }
    pub fn private_transport_plaintext(&self) -> &[u8] {
        &self.bytes
    }
}

/// A status statement never serializes a local snapshot or disposal proof.
/// `Disposed` must be checked against the already committed positive DB row;
/// it cannot be used to acknowledge disposal. Null capture means no admission
/// was committed for Refused; Unknown makes no such ownership/disposal claim.
#[derive(Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperationResult {
    Pending {
        capture_id: String,
        stage: PendingStage,
    },
    Verified {
        capture_id: String,
        root_digest: String,
        verified_at_ms: u64,
        selected_audio: SelectedAudioStatement,
    },
    Published {
        capture_id: String,
        root_digest: String,
        published_at_ms: u64,
        selected_audio: SelectedAudioStatement,
        reply_encrypted: String,
    },
    /// A committed private queue receipt, not encoding/output readiness or a
    /// public playback grant. Its reply retains the original queued ciphertext.
    ChildQueued {
        capture_id: String,
        root_digest: String,
        queued_at_ms: u64,
        selected_audio: SelectedAudioStatement,
        reply_encrypted: String,
    },
    CancelRequested {
        capture_id: String,
    },
    Refused {
        capture_id: Option<String>,
        reason: Reason,
    },
    Disposed {
        capture_id: String,
        disposed_at_ms: u64,
    },
    Unknown {
        capture_id: Option<String>,
        reason: Reason,
    },
}
// Explicit streaming map dispatch retains duplicates at every flat variant
// field. An internally tagged enum's generic buffering is not the boundary.
impl<'de> Deserialize<'de> for OperationResult {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = OperationResult;
            fn expecting(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                out.write_str("a closed operation result object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                use serde::de::Error;
                let (
                    mut kind,
                    mut capture,
                    mut stage,
                    mut root,
                    mut verified,
                    mut audio,
                    mut reason,
                    mut disposed,
                    mut published,
                    mut reply,
                    mut queued,
                ) = (
                    None, None, None, None, None, None, None, None, None, None, None,
                );
                let mut fields = 0u16;
                while let Some(key) = map.next_key::<String>()? {
                    let bit = match key.as_str() {
                        "kind" => 1,
                        "capture_id" => 2,
                        "stage" => 4,
                        "root_digest" => 8,
                        "verified_at_ms" => 16,
                        "selected_audio" => 32,
                        "reason" => 64,
                        "disposed_at_ms" => 128,
                        "published_at_ms" => 256,
                        "reply_encrypted" => 512,
                        "queued_at_ms" => 1024,
                        _ => return Err(A::Error::custom("unknown result field")),
                    };
                    if fields & bit != 0 {
                        return Err(A::Error::custom("duplicate result field"));
                    }
                    fields |= bit;
                    match bit {
                        1 => kind = Some(map.next_value::<String>()?),
                        2 => capture = Some(map.next_value::<Option<String>>()?),
                        4 => stage = Some(map.next_value::<PendingStage>()?),
                        8 => root = Some(map.next_value::<String>()?),
                        16 => verified = Some(map.next_value::<u64>()?),
                        32 => audio = Some(map.next_value::<SelectedAudioStatement>()?),
                        64 => reason = Some(map.next_value::<Reason>()?),
                        128 => disposed = Some(map.next_value::<u64>()?),
                        256 => published = Some(map.next_value::<u64>()?),
                        512 => reply = Some(map.next_value::<String>()?),
                        1024 => queued = Some(map.next_value::<u64>()?),
                        _ => unreachable!(),
                    }
                }
                let missing = || A::Error::custom("missing or invalid result field");
                let capture = capture.ok_or_else(missing)?;
                match (kind.as_deref(), fields) {
                    (Some("pending"), 7) => Ok(OperationResult::Pending {
                        capture_id: capture.ok_or_else(missing)?,
                        stage: stage.ok_or_else(missing)?,
                    }),
                    (Some("verified"), 59) => Ok(OperationResult::Verified {
                        capture_id: capture.ok_or_else(missing)?,
                        root_digest: root.ok_or_else(missing)?,
                        verified_at_ms: verified.ok_or_else(missing)?,
                        selected_audio: audio.ok_or_else(missing)?,
                    }),
                    (Some("published"), 811) => Ok(OperationResult::Published {
                        capture_id: capture.ok_or_else(missing)?,
                        root_digest: root.ok_or_else(missing)?,
                        published_at_ms: published.ok_or_else(missing)?,
                        selected_audio: audio.ok_or_else(missing)?,
                        reply_encrypted: reply.ok_or_else(missing)?,
                    }),
                    (Some("child_queued"), 1579) => Ok(OperationResult::ChildQueued {
                        capture_id: capture.ok_or_else(missing)?,
                        root_digest: root.ok_or_else(missing)?,
                        queued_at_ms: queued.ok_or_else(missing)?,
                        selected_audio: audio.ok_or_else(missing)?,
                        reply_encrypted: reply.ok_or_else(missing)?,
                    }),
                    (Some("cancel_requested"), 3) => Ok(OperationResult::CancelRequested {
                        capture_id: capture.ok_or_else(missing)?,
                    }),
                    (Some("refused"), 67) => Ok(OperationResult::Refused {
                        capture_id: capture,
                        reason: reason.ok_or_else(missing)?,
                    }),
                    (Some("disposed"), 131) => Ok(OperationResult::Disposed {
                        capture_id: capture.ok_or_else(missing)?,
                        disposed_at_ms: disposed.ok_or_else(missing)?,
                    }),
                    (Some("unknown"), 67) => Ok(OperationResult::Unknown {
                        capture_id: capture,
                        reason: reason.ok_or_else(missing)?,
                    }),
                    _ => Err(A::Error::custom("unsupported result shape")),
                }
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}
impl OperationResult {
    fn capture_id(&self) -> Option<&str> {
        match self {
            Self::Pending { capture_id, .. }
            | Self::Verified { capture_id, .. }
            | Self::Published { capture_id, .. }
            | Self::ChildQueued { capture_id, .. }
            | Self::CancelRequested { capture_id }
            | Self::Disposed { capture_id, .. } => Some(capture_id),
            Self::Refused { capture_id, .. } | Self::Unknown { capture_id, .. } => {
                capture_id.as_deref()
            }
        }
    }
    fn validate(&self) -> Result<()> {
        require(self.capture_id().is_none_or(uuid), ContractError::Identity)?;
        match self {
            Self::Published {
                root_digest,
                published_at_ms,
                reply_encrypted,
                ..
            }
            | Self::ChildQueued {
                root_digest,
                queued_at_ms: published_at_ms,
                reply_encrypted,
                ..
            } => {
                require(hash(root_digest), ContractError::Identity)?;
                require(*published_at_ms <= MAX_SAFE_INTEGER, ContractError::Bounds)?;
                let reply_maximum = if matches!(self, Self::ChildQueued { .. }) {
                    MAX_CHILD_QUEUED_REPLY_CIPHERTEXT_BYTES
                } else {
                    2_048
                };
                require(
                    !reply_encrypted.is_empty()
                        && reply_encrypted.len() <= reply_maximum
                        && reply_encrypted
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte)),
                    ContractError::Bounds,
                )
            }
            Self::Verified {
                root_digest,
                verified_at_ms,
                ..
            } => {
                require(hash(root_digest), ContractError::Identity)?;
                require(*verified_at_ms <= MAX_SAFE_INTEGER, ContractError::Bounds)
            }
            Self::Disposed { disposed_at_ms, .. } => {
                require(*disposed_at_ms <= MAX_SAFE_INTEGER, ContractError::Bounds)
            }
            _ => Ok(()),
        }
    }
    fn require_observation_time(&self, now_ms: u64) -> Result<()> {
        match self {
            Self::Published {
                published_at_ms, ..
            }
            | Self::ChildQueued {
                queued_at_ms: published_at_ms,
                ..
            } => require(*published_at_ms <= now_ms, ContractError::Deadline),
            Self::Verified { verified_at_ms, .. } => {
                require(*verified_at_ms <= now_ms, ContractError::Deadline)
            }
            Self::Disposed { disposed_at_ms, .. } => {
                require(*disposed_at_ms <= now_ms, ContractError::Deadline)
            }
            _ => Ok(()),
        }
    }
    fn require_input_statement(&self, expected: &ExpectedBinding, action: Action) -> Result<()> {
        if matches!(self, Self::Published { .. }) {
            require(
                matches!(action, Action::Publish | Action::Query)
                    && expected.frozen_input.kind() == OperationKind::Parent,
                ContractError::Facts,
            )?;
        }
        if matches!(self, Self::ChildQueued { .. }) {
            require(
                matches!(action, Action::PublishChild | Action::Query)
                    && expected.frozen_input.kind() == OperationKind::Child,
                ContractError::Facts,
            )?;
        }
        // The design's custody key is capture.id = operation_id. A syntactically
        // valid foreign capture cannot be smuggled alongside an exact echo.
        require(
            self.capture_id()
                .is_none_or(|capture| capture == expected.binding.operation_id),
            ContractError::Identity,
        )?;
        if let Self::Verified {
            root_digest,
            selected_audio,
            verified_at_ms,
            ..
        }
        | Self::Published {
            root_digest,
            selected_audio,
            published_at_ms: verified_at_ms,
            ..
        }
        | Self::ChildQueued {
            root_digest,
            selected_audio,
            queued_at_ms: verified_at_ms,
            ..
        } = self
        {
            expected
                .frozen_input
                .require_audio_statement(*selected_audio)?;
            if let Some(root) = expected.frozen_input.child_root() {
                require(
                    *root_digest == root.root_digest && *selected_audio == root.selected_audio,
                    ContractError::SourceChanged,
                )?;
            }
            require(
                *verified_at_ms < expected.binding.prepare_expires_at_ms
                    && *verified_at_ms < expected.binding.root_hard_expires_at_ms,
                ContractError::Deadline,
            )?;
        }
        Ok(())
    }
    fn require_result_authority(
        &self,
        expected: &ExpectedBinding,
        now_ms: u64,
        authority: &CallAuthority<'_>,
    ) -> Result<()> {
        if let Self::ChildQueued { queued_at_ms, .. } = self {
            // A retained response is historical evidence. It can be returned
            // only under this exact child's currently live queue authority,
            // and never after its original preparation interval ends.
            let CallAuthority::LivePublication(statement) = authority else {
                return Err(ContractError::Facts);
            };
            require(!statement.pending, ContractError::Facts)?;
            expected.require_publication_authority(now_ms, statement)?;
            require(
                *queued_at_ms <= statement.observed_at_ms
                    && now_ms < expected.binding.prepare_expires_at_ms
                    && now_ms < statement.pending_lease_expires_at_ms,
                ContractError::Deadline,
            )?;
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResponseWire {
    purpose: String,
    rpc_version: u8,
    binding: Object<Binding>,
    result: OperationResult,
}
pub struct OperationResponse {
    wire: ResponseWire,
    action: Action,
    bytes: Vec<u8>,
}

/// A validated wire statement, never a local snapshot or disposal proof.
pub struct PublishedResultStatement<'a> {
    pub capture_id: &'a str,
    pub root_digest: &'a str,
    pub published_at_ms: u64,
    pub selected_audio: &'a SelectedAudioStatement,
    pub reply_encrypted: &'a str,
}
/// A validated committed queue statement, never proof of playable output.
pub struct ChildQueuedResultStatement<'a> {
    pub capture_id: &'a str,
    pub root_digest: &'a str,
    pub queued_at_ms: u64,
    pub selected_audio: &'a SelectedAudioStatement,
    pub reply_encrypted: &'a str,
}
impl OperationResponse {
    pub fn child_queued_result_statement(&self) -> Option<ChildQueuedResultStatement<'_>> {
        match &self.wire.result {
            OperationResult::ChildQueued {
                capture_id,
                root_digest,
                queued_at_ms,
                selected_audio,
                reply_encrypted,
            } => Some(ChildQueuedResultStatement {
                capture_id,
                root_digest,
                queued_at_ms: *queued_at_ms,
                selected_audio,
                reply_encrypted,
            }),
            _ => None,
        }
    }
    pub fn published_result_statement(&self) -> Option<PublishedResultStatement<'_>> {
        match &self.wire.result {
            OperationResult::Published {
                capture_id,
                root_digest,
                published_at_ms,
                selected_audio,
                reply_encrypted,
            } => Some(PublishedResultStatement {
                capture_id,
                root_digest,
                published_at_ms: *published_at_ms,
                selected_audio,
                reply_encrypted,
            }),
            _ => None,
        }
    }
    pub fn parse_private_plaintext(bytes: &[u8]) -> Result<Self> {
        plaintext_size(bytes, MAX_RESPONSE_PLAINTEXT_BYTES)?;
        let Object(wire): Object<ResponseWire> =
            serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
        require(wire.rpc_version == RPC_VERSION, ContractError::Version)?;
        let action = Action::from_response_purpose(&wire.purpose)?;
        wire.binding.validate()?;
        action.require_operation_kind(wire.binding.operation_kind)?;
        wire.result.validate()?;
        let bytes = serde_json::to_vec(&wire).map_err(|_| ContractError::Shape)?;
        plaintext_size(&bytes, MAX_RESPONSE_PLAINTEXT_BYTES)?;
        Ok(Self {
            wire,
            action,
            bytes,
        })
    }
    /// Construction echoes only independently expected fields. It does not
    /// authenticate result facts or create a local owner or disposal receipt.
    pub fn for_expected(
        action: Action,
        expected: &ExpectedBinding,
        result: OperationResult,
        now_ms: u64,
        authority: CallAuthority<'_>,
    ) -> Result<Self> {
        expected.require_call(action, now_ms, &authority)?;
        result.validate()?;
        result.require_input_statement(expected, action)?;
        result.require_result_authority(expected, now_ms, &authority)?;
        result.require_observation_time(now_ms)?;
        let wire = ResponseWire {
            purpose: action.response_purpose().into(),
            rpc_version: RPC_VERSION,
            binding: Object(expected.binding.clone()),
            result,
        };
        Self::parse_private_plaintext(&serde_json::to_vec(&wire).map_err(|_| ContractError::Shape)?)
    }
    /// Validate purpose AND full echo against the trusted per-call expectation,
    /// not a copy of untrusted response/request data. Recheck after every wait.
    pub fn validate_expected(
        &self,
        action: Action,
        expected: &ExpectedBinding,
        now_ms: u64,
        authority: CallAuthority<'_>,
    ) -> Result<()> {
        require(self.action == action, ContractError::Version)?;
        require(
            self.wire.binding.0 == expected.binding,
            ContractError::Identity,
        )?;
        expected.require_call(action, now_ms, &authority)?;
        if matches!(self.wire.result, OperationResult::Published { .. }) {
            require(
                matches!(action, Action::Publish | Action::Query)
                    && expected.frozen_input.kind() == OperationKind::Parent,
                ContractError::Facts,
            )?;
        }
        self.wire.result.require_input_statement(expected, action)?;
        self.wire
            .result
            .require_result_authority(expected, now_ms, &authority)?;
        self.wire.result.require_observation_time(now_ms)
    }
    pub fn result(&self) -> &OperationResult {
        &self.wire.result
    }
    pub fn private_transport_plaintext(&self) -> &[u8] {
        &self.bytes
    }
}

fn plaintext_size(bytes: &[u8], maximum: usize) -> Result<()> {
    require(
        !bytes.is_empty() && bytes.len() <= maximum,
        ContractError::Bounds,
    )
}
pub fn validate_request_ciphertext_size(bytes: &[u8]) -> Result<()> {
    plaintext_size(bytes, MAX_REQUEST_CIPHERTEXT_BYTES)
}
pub fn validate_response_ciphertext_size(bytes: &[u8]) -> Result<()> {
    plaintext_size(bytes, MAX_RESPONSE_CIPHERTEXT_BYTES)
}

#[cfg(test)]
mod tests;
