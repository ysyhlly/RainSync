//! Sensitive closed input, with an explicit private-storage serializer only.
//! Parsing a statement does not authenticate its source or mint any authority.
use super::*;
use http::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use url::Url;

#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Parent,
    Child,
}
impl<'de> Deserialize<'de> for OperationKind {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "parent" => Ok(Self::Parent),
            "child" => Ok(Self::Child),
            _ => Err(serde::de::Error::custom("unsupported operation kind")),
        }
    }
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum AudioIntent {
    Default {},
    Stream { index: u32 },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum AudioIntentWire {
    Default {},
    Stream { index: u32 },
}
impl<'de> Deserialize<'de> for AudioIntent {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let Object(value) = Object::<AudioIntentWire>::deserialize(deserializer)?;
        Ok(match value {
            AudioIntentWire::Default {} => Self::Default {},
            AudioIntentWire::Stream { index } => Self::Stream { index },
        })
    }
}

/// Scanner-selection statement, not scanner evidence or a capture receipt.
#[derive(Clone, Copy, Debug, Serialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SelectedAudioStatement {
    None {},
    Single { stream_index: u32 },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum SelectedAudioWire {
    None {},
    Single { stream_index: u32 },
}
impl<'de> Deserialize<'de> for SelectedAudioStatement {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let Object(value) = Object::<SelectedAudioWire>::deserialize(deserializer)?;
        Ok(match value {
            SelectedAudioWire::None {} => Self::None {},
            SelectedAudioWire::Single { stream_index } => Self::Single { stream_index },
        })
    }
}

// A wrapper rather than an Option field makes omission different from null.
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(transparent)]
struct RequiredNullable<T>(Option<T>);
fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<RequiredNullable<T>, D::Error> {
    Option::<T>::deserialize(deserializer).map(RequiredNullable)
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Header {
    name: String,
    value: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Redirects {
    max_hops: u8,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Origin {
    origin: String,
    cidrs: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct AccessPolicy {
    schema_version: u8,
    origins: Vec<Object<Origin>>,
    #[serde(deserialize_with = "required_nullable")]
    redirects: RequiredNullable<Object<Redirects>>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct Source {
    kind: String,
    pub(super) source_id: String,
    pub(super) source_policy_revision: u64,
    pub(super) media_source_generation: u64,
    configured_base_url: String,
    canonical_target: String,
    headers: Vec<Object<Header>>,
    #[serde(deserialize_with = "required_nullable")]
    access_policy: RequiredNullable<Object<AccessPolicy>>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct ChildRoot {
    pub(super) parent_session_id: String,
    pub(super) parent_capture_id: String,
    pub(super) parent_input_sha256: String,
    pub(super) root_digest: String,
    root_admitted_at_ms: u64,
    root_hard_expires_at_ms: u64,
    pub(super) selected_audio: SelectedAudioStatement,
}

// The serialized declaration order is the v1 byte contract. Do not flatten an
// open DTO or round-trip through serde_json::Value when computing this hash.
macro_rules! input_shape {
    ($name:ident $(, $extra:ident: $ty:ty)*) => {
        #[derive(Clone, Deserialize, Serialize, PartialEq)]
        #[serde(deny_unknown_fields)]
        pub(super) struct $name {
            input_version: u8,
            graph_version: u8,
            reader_version: u8,
            recipe_version: u8,
            kind: OperationKind,
            operation_id: String,
            session_id: String,
            request_owner_epoch: String,
            request_sha256: String,
            user_id: String,
            room_id: String,
            auth_login_hash: String,
            auth_membership_epoch: String,
            lifecycle_epoch: u64,
            media_id: String,
            media_generation: u64,
            viewer_id: String,
            plan_generation: u64,
            worker_instance: String,
            database: String,
            root_admitted_at_ms: u64,
            root_hard_expires_at_ms: u64,
            prepare_started_at_ms: u64,
            prepare_expires_at_ms: u64,
            position_ms: f64,
            audio_intent: AudioIntent,
            source: Object<Source>,
            $( $extra: $ty, )*
        }
    }
}
input_shape!(ParentInput);
input_shape!(ChildInput, root: Object<ChildRoot>);

#[derive(Clone)]
enum Input {
    Parent(ParentInput),
    Child(ChildInput),
}

/// Validated immutable data only. Deliberately has no Debug, Serialize,
/// Deserialize, public fields or whole-input diagnostic projection.
#[derive(Clone)]
pub struct FrozenInput {
    input: Input,
    bytes: Vec<u8>,
    sha256: String,
}

/// Identity comparison statement. These are caller-supplied facts, not an
/// authenticated principal, database observation or actual Worker owner.
/// No Debug/Serialize path includes its exact login hash.
#[derive(Clone, PartialEq, Eq)]
pub struct IdentityStatement {
    pub operation_id: String,
    pub session_id: String,
    pub request_owner_epoch: String,
    pub request_sha256: String,
    pub input_sha256: String,
    pub user_id: String,
    pub room_id: String,
    pub auth_login_hash: String,
    pub auth_membership_epoch: String,
    pub lifecycle_epoch: u64,
    pub media_id: String,
    pub media_generation: u64,
    pub viewer_id: String,
    pub plan_generation: u64,
    pub worker_instance: String,
    pub database: String,
    pub source_id: String,
    pub source_policy_revision: u64,
    pub media_source_generation: u64,
}

/// Closed safe diagnostic projection; it cannot serialize private input.
#[derive(Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostic {
    reason: ContractErrorCode,
    operation_id: String,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractErrorCode {
    InvalidStatement,
    RefusedTransition,
}

impl FrozenInput {
    pub fn diagnostic(&self, reason: ContractErrorCode) -> Diagnostic {
        Diagnostic {
            reason,
            operation_id: self.identity_statement().operation_id,
        }
    }
    /// Bound decrypted plaintext BEFORE parsing; serde errors are discarded so
    /// offending signed URLs, credentials and login hashes cannot be formatted.
    pub fn parse_private_plaintext(bytes: &[u8]) -> Result<Self> {
        require(
            !bytes.is_empty() && bytes.len() <= MAX_INPUT_PLAINTEXT_BYTES,
            ContractError::Bounds,
        )?;
        #[derive(Deserialize)]
        struct KindOnly {
            kind: OperationKind,
        }
        let kind: Object<KindOnly> =
            serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
        let input = match kind.kind {
            OperationKind::Parent => {
                let mut raw: Object<ParentInput> =
                    serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
                validate_parent(&mut raw)?;
                Input::Parent(raw.0)
            }
            OperationKind::Child => {
                let mut raw: Object<ChildInput> =
                    serde_json::from_slice(bytes).map_err(|_| ContractError::Shape)?;
                validate_child(&mut raw)?;
                Input::Child(raw.0)
            }
        };
        let bytes = match &input {
            Input::Parent(raw) => serde_json::to_vec(raw),
            Input::Child(raw) => serde_json::to_vec(raw),
        }
        .map_err(|_| ContractError::Shape)?;
        require(
            bytes.len() <= MAX_INPUT_PLAINTEXT_BYTES,
            ContractError::Bounds,
        )?;
        let sha256 = digest(b"rainsync-static-hls-input-v1\0", &bytes);
        Ok(Self {
            input,
            bytes,
            sha256,
        })
    }

    /// Sensitive bytes for encrypted private storage only; never log these or
    /// return them in a public response. This is not general DTO serialization.
    pub fn private_storage_plaintext(&self) -> &[u8] {
        &self.bytes
    }
    pub fn input_sha256(&self) -> &str {
        &self.sha256
    }
    pub fn kind(&self) -> OperationKind {
        match &self.input {
            Input::Parent(_) => OperationKind::Parent,
            Input::Child(_) => OperationKind::Child,
        }
    }
    pub fn identity_statement(&self) -> IdentityStatement {
        macro_rules! identity {
            ($raw:ident) => {
                IdentityStatement {
                    operation_id: $raw.operation_id.clone(),
                    session_id: $raw.session_id.clone(),
                    request_owner_epoch: $raw.request_owner_epoch.clone(),
                    request_sha256: $raw.request_sha256.clone(),
                    input_sha256: self.sha256.clone(),
                    user_id: $raw.user_id.clone(),
                    room_id: $raw.room_id.clone(),
                    auth_login_hash: $raw.auth_login_hash.clone(),
                    auth_membership_epoch: $raw.auth_membership_epoch.clone(),
                    lifecycle_epoch: $raw.lifecycle_epoch,
                    media_id: $raw.media_id.clone(),
                    media_generation: $raw.media_generation,
                    viewer_id: $raw.viewer_id.clone(),
                    plan_generation: $raw.plan_generation,
                    worker_instance: $raw.worker_instance.clone(),
                    database: $raw.database.clone(),
                    source_id: $raw.source.source_id.clone(),
                    source_policy_revision: $raw.source.source_policy_revision,
                    media_source_generation: $raw.source.media_source_generation,
                }
            };
        }
        match &self.input {
            Input::Parent(raw) => identity!(raw),
            Input::Child(raw) => identity!(raw),
        }
    }
    pub fn require_identity_statement(&self, observed: &IdentityStatement) -> Result<()> {
        require(
            &self.identity_statement() == observed,
            ContractError::Identity,
        )
    }
    pub fn root_deadline_ms(&self) -> u64 {
        match &self.input {
            Input::Parent(v) => v.root_hard_expires_at_ms,
            Input::Child(v) => v.root_hard_expires_at_ms,
        }
    }
    pub fn preparation_deadline_ms(&self) -> u64 {
        match &self.input {
            Input::Parent(v) => v.prepare_expires_at_ms,
            Input::Child(v) => v.prepare_expires_at_ms,
        }
    }
    pub(super) fn position_ms(&self) -> f64 {
        match &self.input {
            Input::Parent(v) => v.position_ms,
            Input::Child(v) => v.position_ms,
        }
    }
    pub fn require_same_frozen_input(&self, next: &Self) -> Result<()> {
        require(
            self.bytes == next.bytes && self.sha256 == next.sha256,
            ContractError::Immutable,
        )
    }
    /// Exact private-storage replay statement. Equal plaintext/hash is not
    /// permission to replace the stored ciphertext with a fresh nonce. This
    /// checks immutable bytes, not whether they decrypt/authenticate this input.
    pub fn require_same_private_storage_statement(
        &self,
        next: &Self,
        stored_ciphertext: &[u8],
        next_ciphertext: &[u8],
    ) -> Result<()> {
        self.require_same_frozen_input(next)?;
        validate_input_ciphertext_size(stored_ciphertext)?;
        validate_input_ciphertext_size(next_ciphertext)?;
        require(
            stored_ciphertext == next_ciphertext,
            ContractError::Immutable,
        )
    }
    /// Credential scoping statement only. A source gateway must independently
    /// authorize every target/address. The selected target is never the base.
    pub fn configured_credentials_match_origin(&self, target: &str) -> Result<bool> {
        let selected = canonical_url(target)?;
        let base = canonical_url(&self.source().configured_base_url)?;
        Ok(selected.origin() == base.origin())
    }
    pub fn target_sha256(&self) -> String {
        digest(b"", self.source().canonical_target.as_bytes())
    }
    pub fn require_audio_statement(&self, selected: SelectedAudioStatement) -> Result<()> {
        match (self.audio_intent(), selected) {
            (AudioIntent::Default {}, _) => Ok(()),
            (AudioIntent::Stream { index }, SelectedAudioStatement::Single { stream_index })
                if *index == stream_index =>
            {
                Ok(())
            }
            _ => Err(ContractError::Audio),
        }
    }
    pub(super) fn child_root(&self) -> Option<&ChildRoot> {
        match &self.input {
            Input::Parent(_) => None,
            Input::Child(v) => Some(&v.root),
        }
    }
    fn source(&self) -> &Source {
        match &self.input {
            Input::Parent(v) => &v.source,
            Input::Child(v) => &v.source,
        }
    }
    fn audio_intent(&self) -> &AudioIntent {
        match &self.input {
            Input::Parent(v) => &v.audio_intent,
            Input::Child(v) => &v.audio_intent,
        }
    }
    /// Parent and child statements retain independent input hashes. This proves
    /// only equality of frozen fields and references, never a one-shot SQL claim.
    pub fn require_child_of(
        &self,
        parent: &Self,
        root_digest: &str,
        selected: SelectedAudioStatement,
    ) -> Result<()> {
        let (Input::Child(child), Input::Parent(parent_raw)) = (&self.input, &parent.input) else {
            return Err(ContractError::Identity);
        };
        require(hash(root_digest), ContractError::Identity)?;
        require(
            child.root.parent_session_id == parent_raw.session_id
                && child.root.parent_capture_id == parent_raw.operation_id
                && child.root.parent_input_sha256 == parent.sha256
                && child.root.root_digest == root_digest
                && child.root.selected_audio == selected
                && child.source == parent_raw.source
                && child.audio_intent == parent_raw.audio_intent
                && child.root_admitted_at_ms == parent_raw.root_admitted_at_ms
                && child.root_hard_expires_at_ms == parent_raw.root_hard_expires_at_ms
                && child.plan_generation > parent_raw.plan_generation
                && child.operation_id != parent_raw.operation_id
                && child.session_id != parent_raw.session_id
                && child.operation_id != parent_raw.session_id
                && child.session_id != parent_raw.operation_id
                && child.user_id == parent_raw.user_id
                && child.room_id == parent_raw.room_id
                && child.auth_login_hash == parent_raw.auth_login_hash
                && child.auth_membership_epoch == parent_raw.auth_membership_epoch
                && child.lifecycle_epoch == parent_raw.lifecycle_epoch
                && child.media_id == parent_raw.media_id
                && child.media_generation == parent_raw.media_generation
                && child.viewer_id == parent_raw.viewer_id
                && child.worker_instance == parent_raw.worker_instance
                && child.database == parent_raw.database,
            ContractError::Identity,
        )?;
        self.require_audio_statement(selected)?;
        require(
            matches!(selected, SelectedAudioStatement::Single { .. }),
            ContractError::Audio,
        )
    }
}

fn canonical_url(value: &str) -> Result<Url> {
    require(
        !value.is_empty()
            && value.len() <= 16_384
            && value.trim() == value
            && !value.bytes().any(|b| b.is_ascii_control() || b == b'\\'),
        ContractError::Url,
    )?;
    let url = Url::parse(value).map_err(|_| ContractError::Url)?;
    require(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && !url.host_str().is_some_and(|host| host.contains('*'))
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.port_or_known_default().is_some_and(|port| port != 0)
            && url.as_str() == value,
        ContractError::Url,
    )?;
    Ok(url)
}

fn canonical_cidr(value: &str) -> Result<String> {
    let (_, prefix) = value.split_once('/').ok_or(ContractError::Policy)?;
    require(
        !prefix.is_empty()
            && prefix.bytes().all(|b| b.is_ascii_digit())
            && (prefix.len() == 1 || !prefix.starts_with('0')),
        ContractError::Policy,
    )?;
    let net: ipnet::IpNet = value.parse().map_err(|_| ContractError::Policy)?;
    require(net.addr() == net.network(), ContractError::Policy)?;
    if let ipnet::IpNet::V6(net) = net
        && let Some(v4) = net.addr().to_ipv4_mapped()
    {
        let prefix = net
            .prefix_len()
            .checked_sub(96)
            .ok_or(ContractError::Policy)?;
        return Ok(format!("{v4}/{prefix}"));
    }
    Ok(net.to_string())
}

fn validate_source(source: &Source) -> Result<()> {
    require(source.kind == "http", ContractError::Shape)?;
    require(uuid(&source.source_id), ContractError::Identity)?;
    require(
        source.source_policy_revision > 0
            && source.source_policy_revision <= MAX_SAFE_INTEGER
            && source.media_source_generation > 0
            && source.media_source_generation <= MAX_SAFE_INTEGER,
        ContractError::Bounds,
    )?;
    let base = canonical_url(&source.configured_base_url)?;
    let selected = canonical_url(&source.canonical_target)?;
    require(source.headers.len() <= 32, ContractError::Headers)?;
    let mut previous = "";
    let mut aggregate = 0usize;
    for header in &source.headers {
        require(
            !header.name.is_empty()
                && header.name.len() <= 128
                && header.value.len() <= 4096
                && header.name == header.name.to_ascii_lowercase()
                && previous < header.name.as_str()
                && !matches!(
                    header.name.as_str(),
                    "host"
                        | "connection"
                        | "proxy-authorization"
                        | "proxy-connection"
                        | "transfer-encoding"
                        | "content-length"
                        | "upgrade"
                        | "te"
                        | "trailer"
                        | "keep-alive"
                ),
            ContractError::Headers,
        )?;
        HeaderName::from_bytes(header.name.as_bytes()).map_err(|_| ContractError::Headers)?;
        HeaderValue::from_str(&header.value).map_err(|_| ContractError::Headers)?;
        aggregate += header.name.len() + header.value.len();
        previous = &header.name;
    }
    require(aggregate <= 16_384, ContractError::Headers)?;
    match &source.access_policy.0 {
        None => require(base.origin() == selected.origin(), ContractError::Policy),
        Some(policy) => {
            require(policy.schema_version == 1, ContractError::Version)?;
            require(
                !policy.origins.is_empty()
                    && policy.origins.len() <= 16
                    && policy
                        .redirects
                        .0
                        .as_ref()
                        .is_none_or(|r| (1..=5).contains(&r.max_hops)),
                ContractError::Policy,
            )?;
            let mut origins = BTreeSet::new();
            for rule in &policy.origins {
                // Existing policy origins omit the URL path's trailing slash.
                let url = canonical_url(&format!("{}/", rule.origin))?;
                require(
                    url.origin().ascii_serialization() == rule.origin
                        && !rule.origin.contains('%')
                        && !rule.cidrs.is_empty()
                        && rule.cidrs.len() <= 64
                        && origins.insert(rule.origin.as_str()),
                    ContractError::Policy,
                )?;
                let mut cidrs = BTreeSet::new();
                for cidr in &rule.cidrs {
                    require(cidrs.insert(canonical_cidr(cidr)?), ContractError::Policy)?;
                }
            }
            require(
                origins.contains(base.origin().ascii_serialization().as_str())
                    && origins.contains(selected.origin().ascii_serialization().as_str()),
                ContractError::Policy,
            )
        }
    }
}

macro_rules! validate_common {
    ($raw:ident) => {{
        require(
            (
                $raw.input_version,
                $raw.graph_version,
                $raw.reader_version,
                $raw.recipe_version,
            ) == (INPUT_VERSION, GRAPH_VERSION, READER_VERSION, RECIPE_VERSION),
            ContractError::Version,
        )?;
        require(
            [
                &$raw.operation_id,
                &$raw.session_id,
                &$raw.request_owner_epoch,
                &$raw.user_id,
                &$raw.room_id,
                &$raw.auth_membership_epoch,
                &$raw.media_id,
                &$raw.viewer_id,
                &$raw.worker_instance,
                &$raw.database,
            ]
            .into_iter()
            .all(|v| uuid(v))
                && $raw.operation_id != $raw.session_id
                && hash(&$raw.request_sha256)
                && hash(&$raw.auth_login_hash),
            ContractError::Identity,
        )?;
        require(
            [
                $raw.lifecycle_epoch,
                $raw.media_generation,
                $raw.plan_generation,
                $raw.root_admitted_at_ms,
                $raw.root_hard_expires_at_ms,
                $raw.prepare_started_at_ms,
                $raw.prepare_expires_at_ms,
            ]
            .into_iter()
            .all(|v| v <= MAX_SAFE_INTEGER)
                && $raw.plan_generation > 0
                && finite_nonnegative($raw.position_ms),
            ContractError::Bounds,
        )?;
        require(
            $raw.root_admitted_at_ms < $raw.root_hard_expires_at_ms
                && $raw.root_hard_expires_at_ms - $raw.root_admitted_at_ms <= ROOT_LIFETIME_MS
                && $raw.prepare_started_at_ms >= $raw.root_admitted_at_ms
                && $raw.prepare_started_at_ms < $raw.prepare_expires_at_ms
                && $raw.prepare_expires_at_ms - $raw.prepare_started_at_ms
                    <= PREPARATION_LIFETIME_MS
                && $raw.prepare_expires_at_ms <= $raw.root_hard_expires_at_ms,
            ContractError::Deadline,
        )?;
        normalized_zero(&mut $raw.position_ms);
        validate_source(&$raw.source)?;
    }};
}
fn validate_parent(raw: &mut ParentInput) -> Result<()> {
    validate_common!(raw);
    require(raw.kind == OperationKind::Parent, ContractError::Shape)
}
fn validate_child(raw: &mut ChildInput) -> Result<()> {
    validate_common!(raw);
    require(raw.kind == OperationKind::Child, ContractError::Shape)?;
    let root = &raw.root;
    require(
        uuid(&root.parent_session_id)
            && uuid(&root.parent_capture_id)
            && root.parent_session_id != root.parent_capture_id
            && root.parent_session_id != raw.session_id
            && root.parent_session_id != raw.operation_id
            && root.parent_capture_id != raw.operation_id
            && root.parent_capture_id != raw.session_id
            && hash(&root.parent_input_sha256)
            && hash(&root.root_digest),
        ContractError::Identity,
    )?;
    require(
        root.root_admitted_at_ms == raw.root_admitted_at_ms
            && root.root_hard_expires_at_ms == raw.root_hard_expires_at_ms,
        ContractError::Deadline,
    )?;
    require(
        matches!(root.selected_audio, SelectedAudioStatement::Single { .. }),
        ContractError::Audio,
    )
}
