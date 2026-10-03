//! Inactive Stage B data contracts. These checks validate statements, never
//! establish live authority, process/file ownership, capture or disposal.
//! No production admission, transport, SQL or RPC caller uses this module.
pub mod graph;
pub mod input;
pub mod phase;

use sha2::{Digest, Sha256};

/// Private map-only serde boundary. Named-struct derives also accept positional
/// arrays; routing every closed object through deserialize_map prevents that
/// alias while preserving streaming duplicate/unknown-field checks.
#[derive(Clone, serde::Serialize, PartialEq)]
#[serde(transparent)]
pub(super) struct Object<T>(pub(super) T);
impl<T> std::ops::Deref for Object<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
impl<T> std::ops::DerefMut for Object<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}
impl<'de, T: serde::Deserialize<'de>> serde::Deserialize<'de> for Object<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct MapOnly<T>(std::marker::PhantomData<T>);
        impl<'de, T: serde::Deserialize<'de>> serde::de::Visitor<'de> for MapOnly<T> {
            type Value = Object<T>;
            fn expecting(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                out.write_str("a closed object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }
        deserializer.deserialize_map(MapOnly(std::marker::PhantomData))
    }
}

pub const INPUT_VERSION: u8 = 1;
pub const GRAPH_VERSION: u8 = 1;
pub const READER_VERSION: u8 = 2;
pub const RECIPE_VERSION: u8 = 1;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_INPUT_PLAINTEXT_BYTES: usize = 49_124;
pub const MAX_INPUT_CIPHERTEXT_BYTES: usize = 65_536;
pub const MAX_ROOT_CIPHERTEXT_BYTES: usize = 262_144;
pub const ROOT_LIFETIME_MS: u64 = 1_800_000;
pub const PREPARATION_LIFETIME_MS: u64 = 45_000;

/// Safe reason codes contain no source, principal, header or credential data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractError {
    Shape,
    Version,
    Identity,
    Bounds,
    Url,
    Headers,
    Policy,
    Deadline,
    Audio,
    Immutable,
    Transition,
    Facts,
    SourceChanged,
}
impl std::fmt::Display for ContractError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Shape => "static_hls_contract_shape",
            Self::Version => "static_hls_contract_version",
            Self::Identity => "static_hls_contract_identity",
            Self::Bounds => "static_hls_contract_bounds",
            Self::Url => "static_hls_contract_url",
            Self::Headers => "static_hls_contract_headers",
            Self::Policy => "static_hls_contract_policy",
            Self::Deadline => "static_hls_contract_deadline",
            Self::Audio => "static_hls_contract_audio",
            Self::Immutable => "static_hls_contract_immutable",
            Self::Transition => "static_hls_contract_transition",
            Self::Facts => "static_hls_contract_facts",
            Self::SourceChanged => "static_hls_contract_source_changed",
        })
    }
}
impl std::error::Error for ContractError {}
pub type Result<T> = std::result::Result<T, ContractError>;

fn require(condition: bool, error: ContractError) -> Result<()> {
    condition.then_some(()).ok_or(error)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value != "00000000-0000-0000-0000-000000000000"
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn digest(domain: &[u8], bytes: &[u8]) -> String {
    let mut sha = Sha256::new();
    sha.update(domain);
    sha.update(bytes);
    format!("{:x}", sha.finalize())
}
fn finite_nonnegative(value: f64) -> bool {
    value.is_finite() && value >= 0.0 && value <= MAX_SAFE_INTEGER as f64
}
fn normalized_zero(value: &mut f64) {
    if *value == 0.0 {
        *value = 0.0;
    }
}

/// Check actual stored bytes before decoding/decrypting. This does not estimate
/// encryption overhead or prove that ciphertext authenticates any input.
pub fn validate_input_ciphertext_size(bytes: &[u8]) -> Result<()> {
    require(
        !bytes.is_empty() && bytes.len() <= MAX_INPUT_CIPHERTEXT_BYTES,
        ContractError::Bounds,
    )
}
pub fn validate_root_ciphertext_size(bytes: &[u8]) -> Result<()> {
    require(
        !bytes.is_empty() && bytes.len() <= MAX_ROOT_CIPHERTEXT_BYTES,
        ContractError::Bounds,
    )
}

#[cfg(test)]
mod tests;
