//! Closed public child intent and construction from retained private parent data.
//! This module does not authenticate a caller, claim a root, stop a parent, mint
//! an owner permit, or enable a route. The ordered storage transaction does that.
//! Existing keys must replay their original input/ciphertext before `freeze_new`.
use crate::{Error, Result, err};
use axum::http::StatusCode;
use media_core::static_hls::contracts::{
    MAX_SAFE_INTEGER, PREPARATION_LIFETIME_MS,
    graph::RootGraphStatement,
    input::{FrozenInput, OperationKind},
};
use serde::{
    Deserialize, Serialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use serde_json::{Value, value::RawValue};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, marker::PhantomData};
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 65_536; // Existing Server full-request ceiling.
const MAX_LOOKUP_BYTES: usize = 4_096;
const FIELDS: &[&str] = &[
    "static_hls_fallback_version",
    "static_hls_fallback",
    "upstream_profile_report",
    "http_file_fallback_version",
    "http_file_fallback",
    "viewer_id",
    "plan_generation",
    "idempotency_key",
    "room_id",
    "media_generation",
    "mode",
    "position_ms",
    "audio_index",
    "capabilities",
    "observation_version",
    "candidate_report",
    "playback_metrics_version",
    "playback_metrics",
    "playback_metrics_supported_versions",
];

fn invalid() -> Error {
    err(StatusCode::BAD_REQUEST, "invalid_static_hls_child_request")
}
fn mismatch() -> Error {
    err(StatusCode::CONFLICT, "static_hls_child_parent_mismatch")
}

/// Only the two eligible decoder classifications. Failure is intent, not proof
/// of source identity, a closed process, or permission to create work.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum DecodeFailure {
    NativeDecode { code: u8 },
    HlsMediaDecode {},
}

// Derive structs otherwise accept positional-array aliases. Every new object
// crosses this map-only boundary while retaining derive's duplicate checks.
#[derive(Serialize)]
#[serde(transparent)]
struct Object<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct MapOnly<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for MapOnly<T> {
            type Value = Object<T>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a closed object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(Object)
            }
        }
        deserializer.deserialize_map(MapOnly(PhantomData))
    }
}

#[derive(Serialize)]
#[serde(transparent)]
struct Nullable<T>(Option<T>);
fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Nullable<T>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Nullable)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Lookup {
    parent_session_id: String,
    failure: Object<DecodeFailure>,
    #[serde(deserialize_with = "required_nullable")]
    final_observation: Nullable<Object<protocol::PlaybackObservation>>,
}

/// Keep raw values until the lookup's encoded byte ceiling is established. The
/// outer object is closed and rejects duplicate keys before legacy DTO parsing.
struct RawRequest(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for RawRequest {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct RequestVisitor;
        impl<'de> Visitor<'de> for RequestVisitor {
            type Value = RawRequest;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a closed child request object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut fields = BTreeMap::new();
                while let Some(name) = map.next_key::<String>()? {
                    if !FIELDS.contains(&name.as_str()) || fields.contains_key(&name) {
                        return Err(serde::de::Error::custom("invalid child request field"));
                    }
                    let raw = map.next_value::<Box<RawValue>>()?;
                    if name == "static_hls_fallback" && raw.get().len() > MAX_LOOKUP_BYTES {
                        return Err(serde::de::Error::custom("child lookup byte bound"));
                    }
                    fields.insert(name, raw);
                }
                Ok(RawRequest(fields))
            }
        }
        deserializer.deserialize_map(RequestVisitor)
    }
}

// The supported transport snapshot is the same conservative boolean-only
// static-HLS snapshot as the parent route. Concrete reports are not admitted.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capabilities {
    progressive_h264_aac: bool,
    native_hls: bool,
    mse_h264_aac: bool,
    #[serde(default)]
    report: Option<()>,
}

/// Normalized public data only. Do not pass `body()` to ordinary reservation:
/// its legacy hash omits the child lookup and cannot identify this operation.
pub(crate) struct ChildRequest {
    body: protocol::PlaybackRequest,
    lookup: Object<Lookup>,
    parent_session_id: Uuid,
    request_sha256: String,
}

pub(crate) fn parse(bytes: &[u8]) -> Result<ChildRequest> {
    if bytes.is_empty() || bytes.len() > MAX_REQUEST_BYTES {
        return Err(invalid());
    }
    let RawRequest(mut raw): RawRequest = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    let lookup_raw = raw.remove("static_hls_fallback").ok_or_else(invalid)?;
    let mut lookup: Object<Lookup> =
        serde_json::from_str(lookup_raw.get()).map_err(|_| invalid())?;
    let parent_session_id = canonical_uuid(&lookup.0.parent_session_id).ok_or_else(invalid)?;
    if !matches!(
        lookup.0.failure.0,
        DecodeFailure::NativeDecode { code: 3 } | DecodeFailure::HlsMediaDecode {}
    ) {
        return Err(invalid());
    }
    // Refuse incompatible families before parsing their otherwise open DTOs.
    for name in [
        "http_file_fallback_version",
        "http_file_fallback",
        "candidate_report",
        "upstream_profile_report",
    ] {
        if raw.get(name).is_some_and(|value| value.get() != "null") {
            return Err(invalid());
        }
    }
    let caps: Object<Capabilities> =
        serde_json::from_str(raw.get("capabilities").ok_or_else(invalid)?.get())
            .map_err(|_| invalid())?;
    if !(caps.0.native_hls || caps.0.mse_h264_aac) || caps.0.report.is_some() {
        return Err(invalid());
    }
    // Map-only/duplicate checking also applies to the pre-existing metrics DTO.
    if let Some(metrics) = raw.get("playback_metrics")
        && metrics.get() != "null"
    {
        serde_json::from_str::<Object<protocol::PlaybackMetricsIntent>>(metrics.get())
            .map_err(|_| invalid())?;
    }
    let body_bytes = serde_json::to_vec(&raw).map_err(|_| invalid())?;
    let mut body: protocol::PlaybackRequest =
        serde_json::from_slice(&body_bytes).map_err(|_| invalid())?;
    if body.static_hls_fallback_version != Some(1)
        || body.mode.as_deref() != Some("transcode")
        || body
            .plan_generation
            .is_none_or(|generation| generation == 0)
        || body.observation_version.is_some_and(|version| version != 1)
        || !body.position_ms.is_finite()
        || !(0.0..=MAX_SAFE_INTEGER as f64).contains(&body.position_ms)
    {
        return Err(invalid());
    }
    for (name, value) in [
        ("room_id", Some(body.room_id)),
        ("viewer_id", body.viewer_id),
        ("idempotency_key", body.idempotency_key),
    ] {
        let string: String = serde_json::from_str(raw.get(name).ok_or_else(invalid)?.get())
            .map_err(|_| invalid())?;
        if canonical_uuid(&string) != value {
            return Err(invalid());
        }
    }
    // All capability fields were typed above; none can disappear into serde.
    let _ = caps.0.progressive_h264_aac;
    crate::playback_metrics::validate(&body)?;
    normalize_zero(&mut body.position_ms);
    if let Some(sample) = lookup.0.final_observation.0.as_mut() {
        if sample.0.media_generation != body.media_generation {
            return Err(invalid());
        }
        persistence::playback_observations::original_position(&sample.0, 0.0, None)
            .map_err(|reason| err(StatusCode::BAD_REQUEST, reason))?;
        normalize_zero(&mut sample.0.media_time_ms);
    }
    let mut canonical = body.clone();
    canonical.idempotency_key = None;
    // Serialization alone is flattened, never deserialization. Field order is
    // the existing typed PlaybackRequest order followed by the closed lookup.
    #[derive(Serialize)]
    struct Canonical<'a> {
        #[serde(flatten)]
        body: &'a protocol::PlaybackRequest,
        static_hls_fallback: &'a Object<Lookup>,
    }
    let bytes = serde_json::to_vec(&Canonical {
        body: &canonical,
        static_hls_fallback: &lookup,
    })
    .map_err(|_| invalid())?;
    let request_sha256 = format!("{:x}", Sha256::digest(bytes));
    Ok(ChildRequest {
        body,
        lookup,
        parent_session_id,
        request_sha256,
    })
}

fn canonical_uuid(value: &str) -> Option<Uuid> {
    Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil() && id.to_string() == value)
}
fn normalize_zero(value: &mut f64) {
    if *value == 0.0 {
        *value = 0.0;
    }
}

/// These values come from authenticated Server context and the new ordered
/// claim's DB clock. They must never be deserialized from a public request.
pub(crate) struct NewChild<'a> {
    pub user_id: Uuid,
    pub auth_login_hash: &'a str,
    pub request_owner_epoch: Uuid,
    pub operation_id: Uuid,
    pub session_id: Uuid,
    pub preparation_started_at_ms: u64,
}

impl ChildRequest {
    pub(crate) fn body(&self) -> &protocol::PlaybackRequest {
        &self.body
    }
    pub(crate) fn parent_session_id(&self) -> Uuid {
        self.parent_session_id
    }
    pub(crate) fn idempotency_key(&self) -> Uuid {
        // parse requires a non-nil canonical key.
        self.body.idempotency_key.unwrap()
    }
    pub(crate) fn request_sha256(&self) -> &str {
        &self.request_sha256
    }
    pub(crate) fn decoder_failure(&self) -> DecodeFailure {
        self.lookup.0.failure.0
    }
    pub(crate) fn final_observation(&self) -> Option<&protocol::PlaybackObservation> {
        self.lookup
            .0
            .final_observation
            .0
            .as_ref()
            .map(|value| &value.0)
    }

    /// Construct data for the FIRST claim only, from the locked verified parent
    /// input/root. Root proof is a statement, not an owner permit. Caller must
    /// independently check current login/member/source/viewer and the live marked
    /// parent, then store this input/claim before retiring it. Never call on retry.
    pub(crate) fn freeze_new(
        &self,
        parent: &FrozenInput,
        root: &RootGraphStatement,
        new: NewChild<'_>,
    ) -> Result<FrozenInput> {
        root.require_parent_input(parent).map_err(|_| mismatch())?;
        let identity = parent.identity_statement();
        if identity.user_id != new.user_id.to_string()
            || identity.auth_login_hash != new.auth_login_hash
            || identity.session_id != self.parent_session_id.to_string()
            || identity.room_id != self.body.room_id.to_string()
            || identity.viewer_id != self.body.viewer_id.unwrap().to_string()
            || identity.media_generation != u64::from(self.body.media_generation)
            || identity.plan_generation >= u64::from(self.body.plan_generation.unwrap())
        {
            return Err(mismatch());
        }
        if let Some(sample) = self.final_observation() {
            persistence::playback_observations::original_position(
                sample,
                f64::from(root.source_origin_ms()),
                Some(root.duration_ms()),
            )
            .map_err(|reason| err(StatusCode::BAD_REQUEST, reason))?;
        }
        // Only trusted private canonical plaintext is copied. No public source,
        // root, input hash, deadline or owner field is accepted by parse().
        let mut raw: Value =
            serde_json::from_slice(parent.private_storage_plaintext()).map_err(|_| mismatch())?;
        require_audio_intent(&raw, self.body.audio_index)?;
        let started = new.preparation_started_at_ms;
        let root_admitted = raw["root_admitted_at_ms"].as_u64().ok_or_else(mismatch)?;
        if started < root_admitted || started >= parent.root_deadline_ms() {
            return Err(err(StatusCode::CONFLICT, "static_hls_contract_deadline"));
        }
        let expires = started
            .checked_add(PREPARATION_LIFETIME_MS)
            .ok_or_else(|| err(StatusCode::CONFLICT, "static_hls_contract_deadline"))?
            .min(parent.root_deadline_ms());
        raw["kind"] = Value::from("child");
        raw["operation_id"] = Value::from(new.operation_id.to_string());
        raw["session_id"] = Value::from(new.session_id.to_string());
        raw["request_owner_epoch"] = Value::from(new.request_owner_epoch.to_string());
        raw["request_sha256"] = Value::from(self.request_sha256.clone());
        raw["plan_generation"] = Value::from(self.body.plan_generation.unwrap());
        raw["position_ms"] = Value::from(self.body.position_ms);
        raw["prepare_started_at_ms"] = Value::from(started);
        raw["prepare_expires_at_ms"] = Value::from(expires);
        raw["root"] = serde_json::json!({
            "parent_session_id":identity.session_id,
            "parent_capture_id":identity.operation_id,
            "parent_input_sha256":parent.input_sha256(),
            "root_digest":root.root_digest(),
            "root_admitted_at_ms":root_admitted,
            "root_hard_expires_at_ms":parent.root_deadline_ms(),
            "selected_audio":root.selected_audio_statement(),
        });
        let child = FrozenInput::parse_private_plaintext(
            &serde_json::to_vec(&raw).map_err(|_| mismatch())?,
        )
        .map_err(anyhow::Error::from)?;
        child
            .require_child_of(parent, root.root_digest(), root.selected_audio_statement())
            .map_err(anyhow::Error::from)?;
        Ok(child)
    }

    /// Validate the original retained child after exact-key/hash/login replay
    /// lookup. No live/deliverable parent or fresh clock is required. This never
    /// rewrites input/ciphertext, renews a deadline or clears a terminal result.
    pub(crate) fn require_frozen_replay(
        &self,
        stored: &FrozenInput,
        user: Uuid,
        login_hash: &str,
    ) -> Result<()> {
        let identity = stored.identity_statement();
        if stored.kind() != OperationKind::Child
            || identity.request_sha256 != self.request_sha256
            || identity.user_id != user.to_string()
            || identity.auth_login_hash != login_hash
            || identity.room_id != self.body.room_id.to_string()
            || identity.viewer_id != self.body.viewer_id.unwrap().to_string()
            || identity.media_generation != u64::from(self.body.media_generation)
            || identity.plan_generation != u64::from(self.body.plan_generation.unwrap())
        {
            return Err(mismatch());
        }
        let raw: Value =
            serde_json::from_slice(stored.private_storage_plaintext()).map_err(|_| mismatch())?;
        if raw["root"]["parent_session_id"].as_str()
            != Some(self.parent_session_id.to_string().as_str())
            || raw["position_ms"].as_f64() != Some(self.body.position_ms)
        {
            return Err(mismatch());
        }
        require_audio_intent(&raw, self.body.audio_index)
    }
}

fn require_audio_intent(input: &Value, audio_index: Option<u32>) -> Result<()> {
    let expected = audio_index.map_or_else(
        || serde_json::json!({"kind":"default"}),
        |index| serde_json::json!({"kind":"stream","index":index}),
    );
    if input["audio_intent"] != expected {
        return Err(err(StatusCode::CONFLICT, "static_hls_contract_audio"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(number: u32) -> Uuid {
        Uuid::from_u128(u128::from(number))
    }
    fn checked<T>(result: Result<T>) -> T {
        match result {
            Ok(value) => value,
            Err(_) => panic!("child request fixture failed"),
        }
    }
    fn request() -> Value {
        serde_json::json!({
            "static_hls_fallback_version":1,
            "static_hls_fallback":{
                "parent_session_id":id(2),
                "failure":{"kind":"native_decode","code":3},
                "final_observation":null,
            },
            "idempotency_key":id(12),"room_id":id(5),"media_generation":0,
            "viewer_id":id(8),"plan_generation":2,"mode":"transcode",
            "position_ms":13.0,
            "capabilities":{
                "progressive_h264_aac":true,"native_hls":true,"mse_h264_aac":false,
            },
        })
    }
    fn parse_value(value: &Value) -> Result<ChildRequest> {
        parse(&serde_json::to_vec(value).unwrap())
    }
    fn parent_and_root() -> (FrozenInput, RootGraphStatement) {
        (
            FrozenInput::parse_private_plaintext(include_bytes!(
                "../../../crates/media-core/src/static_hls/contracts/golden_input_v1.json"
            ))
            .unwrap(),
            RootGraphStatement::parse_private_plaintext(include_bytes!(
                "../../../crates/media-core/src/static_hls/contracts/golden_root_v1.json"
            ))
            .unwrap(),
        )
    }
    fn new_child(started: u64) -> NewChild<'static> {
        NewChild {
            user_id: id(4),
            auth_login_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            request_owner_epoch: id(3),
            operation_id: id(101),
            session_id: id(102),
            preparation_started_at_ms: started,
        }
    }
    fn sample() -> Value {
        serde_json::json!({
            "media_generation":0,"seq":1,"event":"buffering","media_time_ms":13.0,
            "paused":false,"seeking":false,"buffering":true,"playback_rate":1.0,
            "has_played":false,
        })
    }

    #[test]
    fn only_current_decoder_intent_and_hls_output_are_accepted() {
        let valid = request();
        let parsed = checked(parse_value(&valid));
        assert_eq!(parsed.parent_session_id(), id(2));
        assert_eq!(parsed.idempotency_key(), id(12));
        assert!(parsed.final_observation().is_none());
        for failure in [
            serde_json::json!({"kind":"native_decode","code":4}),
            serde_json::json!({"kind":"native_decode","code":2}),
            serde_json::json!({"kind":"network"}),
            serde_json::json!({"kind":"http","status":401}),
            serde_json::json!({"kind":"timeout"}),
            serde_json::json!({"kind":"hls_media_decode","network":true}),
        ] {
            let mut bad = valid.clone();
            bad["static_hls_fallback"]["failure"] = failure;
            assert!(parse_value(&bad).is_err());
        }
        let mut fatal = valid.clone();
        fatal["static_hls_fallback"]["failure"] = serde_json::json!({"kind":"hls_media_decode"});
        assert!(parse_value(&fatal).is_ok());
        let mut no_output = valid;
        no_output["capabilities"]["native_hls"] = Value::from(false);
        assert!(parse_value(&no_output).is_err());
        no_output["capabilities"]["mse_h264_aac"] = Value::from(true);
        assert!(parse_value(&no_output).is_ok());
    }

    #[test]
    fn rejects_missing_required_values_wrong_types_and_mixed_families() {
        let valid = request();
        for name in [
            "static_hls_fallback_version",
            "static_hls_fallback",
            "idempotency_key",
            "room_id",
            "viewer_id",
            "plan_generation",
            "mode",
            "capabilities",
        ] {
            let mut bad = valid.clone();
            bad.as_object_mut().unwrap().remove(name);
            assert!(parse_value(&bad).is_err(), "{name}");
        }
        for (name, value) in [
            ("static_hls_fallback_version", Value::from(2)),
            ("static_hls_fallback_version", serde_json::json!(1.0)),
            ("plan_generation", Value::from(0)),
            ("plan_generation", serde_json::json!(2.0)),
            ("mode", Value::from("auto")),
            ("position_ms", Value::from(-1)),
            ("position_ms", Value::from(MAX_SAFE_INTEGER + 1)),
            ("observation_version", Value::from(2)),
            ("http_file_fallback_version", Value::from(1)),
            (
                "http_file_fallback",
                serde_json::json!({"parent_session_id":id(2)}),
            ),
            ("candidate_report", serde_json::json!({})),
            ("upstream_profile_report", serde_json::json!({})),
        ] {
            let mut bad = valid.clone();
            bad[name] = value;
            assert!(parse_value(&bad).is_err(), "{name}");
        }
        let mut missing_nullable = valid;
        missing_nullable["static_hls_fallback"]
            .as_object_mut()
            .unwrap()
            .remove("final_observation");
        assert!(parse_value(&missing_nullable).is_err());
    }

    #[test]
    fn forbids_public_root_input_owner_and_noncanonical_identifiers() {
        for name in [
            "root",
            "capture_id",
            "source",
            "url",
            "root_digest",
            "input_sha256",
            "request_owner_epoch",
            "worker_instance",
            "auth_login_hash",
            "root_hard_expires_at_ms",
        ] {
            for nested in [false, true] {
                let mut bad = request();
                let target = if nested {
                    &mut bad["static_hls_fallback"]
                } else {
                    &mut bad
                };
                target[name] = Value::from("untrusted");
                assert!(parse_value(&bad).is_err(), "{name}");
            }
        }
        for value in [
            id(0).to_string(),
            id(8).simple().to_string(),
            "00000000-0000-0000-0000-00000000000A".into(),
        ] {
            let mut bad = request();
            bad["viewer_id"] = Value::from(value.clone());
            assert!(parse_value(&bad).is_err());
            bad = request();
            bad["static_hls_fallback"]["parent_session_id"] = Value::from(value);
            assert!(parse_value(&bad).is_err());
        }
    }

    #[test]
    fn rejects_duplicates_object_array_aliases_and_encoded_lookup_overflow() {
        let valid = serde_json::to_string(&request()).unwrap();
        for duplicate in [
            valid.replacen("\"mode\":\"transcode\"", "\"mode\":\"transcode\",\"mode\":\"transcode\"", 1),
            valid.replacen("\"parent_session_id\":", "\"parent_session_id\":\"00000000-0000-0000-0000-000000000002\",\"parent_session_id\":", 1),
            valid.replacen("\"code\":3", "\"code\":3,\"code\":3", 1),
            valid.replacen("\"kind\":\"native_decode\"", "\"kind\":\"native_decode\",\"kind\":\"native_decode\"", 1),
            valid.replacen("\"native_hls\":true", "\"native_hls\":true,\"native_hls\":true", 1),
        ] {
            assert!(parse(duplicate.as_bytes()).is_err());
        }
        for name in ["static_hls_fallback", "capabilities", "playback_metrics"] {
            let mut bad = request();
            bad[name] = serde_json::json!([]);
            assert!(parse_value(&bad).is_err());
        }
        let mut bad = request();
        bad["static_hls_fallback"]["failure"] = serde_json::json!([]);
        assert!(parse_value(&bad).is_err());
        bad = request();
        bad["static_hls_fallback"]["final_observation"] = serde_json::json!([]);
        assert!(parse_value(&bad).is_err());
        // Whitespace counts toward the raw subtree bound, before typed parsing.
        let lookup_len = serde_json::to_string(&request()["static_hls_fallback"])
            .unwrap()
            .len();
        let exact_bound = valid.replacen(
            "\"failure\":",
            &format!("\"failure\":{}", " ".repeat(MAX_LOOKUP_BYTES - lookup_len)),
            1,
        );
        assert!(parse(exact_bound.as_bytes()).is_ok());
        let oversized = valid.replacen(
            "\"failure\":",
            &format!("\"failure\":{}", " ".repeat(MAX_LOOKUP_BYTES)),
            1,
        );
        assert!(parse(oversized.as_bytes()).is_err());
        assert!(parse(&vec![b' '; MAX_REQUEST_BYTES + 1]).is_err());
    }

    #[test]
    fn final_observation_is_closed_validated_and_never_authorizes_the_child() {
        let mut valid = request();
        valid["static_hls_fallback"]["final_observation"] = sample();
        assert!(parse_value(&valid).is_ok());
        for (name, value) in [
            ("seq", Value::from(0)),
            ("seq", Value::from(MAX_SAFE_INTEGER + 1)),
            ("media_generation", Value::from(1)),
            ("media_time_ms", Value::from(-1)),
            ("playback_rate", Value::from(0)),
            ("root_digest", Value::from("untrusted")),
        ] {
            let mut bad = valid.clone();
            bad["static_hls_fallback"]["final_observation"][name] = value;
            assert!(parse_value(&bad).is_err(), "{name}");
        }
        let (parent, root) = parent_and_root();
        let mut excessive = valid;
        excessive["static_hls_fallback"]["final_observation"]["media_time_ms"] = Value::from(2_001);
        let parsed = checked(parse_value(&excessive));
        assert!(
            parsed
                .freeze_new(&parent, &root, new_child(100_000))
                .is_err()
        );
    }

    #[test]
    fn canonical_hash_includes_lookup_and_normalizes_numeric_zero_and_retry_key() {
        let mut first = request();
        first["position_ms"] = Value::from(-0.0);
        let mut retry = first.clone();
        retry["position_ms"] = Value::from(0);
        retry["idempotency_key"] = serde_json::json!(id(13));
        let first = checked(parse_value(&first));
        let retry = checked(parse_value(&retry));
        assert_eq!(first.request_sha256(), retry.request_sha256());
        assert_eq!(first.body().position_ms.to_bits(), 0.0_f64.to_bits());
        let mut changed = request();
        changed["position_ms"] = Value::from(0);
        changed["static_hls_fallback"]["parent_session_id"] = serde_json::json!(id(20));
        assert_ne!(
            first.request_sha256(),
            checked(parse_value(&changed)).request_sha256()
        );
        changed = request();
        changed["position_ms"] = Value::from(0);
        changed["static_hls_fallback"]["failure"] = serde_json::json!({"kind":"hls_media_decode"});
        assert_ne!(
            first.request_sha256(),
            checked(parse_value(&changed)).request_sha256()
        );
        changed["static_hls_fallback"]["final_observation"] = sample();
        assert_ne!(
            first.request_sha256(),
            checked(parse_value(&changed)).request_sha256()
        );
    }

    #[test]
    fn new_child_copies_exact_private_source_root_audio_and_original_root_deadline() {
        let parsed = checked(parse_value(&request()));
        let (parent, root) = parent_and_root();
        let child = checked(parsed.freeze_new(&parent, &root, new_child(100_000)));
        assert_eq!(child.kind(), OperationKind::Child);
        assert_eq!(child.root_deadline_ms(), parent.root_deadline_ms());
        assert_eq!(child.preparation_deadline_ms(), 145_000);
        let parent_raw: Value = serde_json::from_slice(parent.private_storage_plaintext()).unwrap();
        let child_raw: Value = serde_json::from_slice(child.private_storage_plaintext()).unwrap();
        assert_eq!(child_raw["source"], parent_raw["source"]);
        assert_eq!(child_raw["audio_intent"], parent_raw["audio_intent"]);
        assert_eq!(
            child_raw["root_admitted_at_ms"],
            parent_raw["root_admitted_at_ms"]
        );
        assert_eq!(
            child_raw["root"]["parent_input_sha256"],
            parent.input_sha256()
        );
        assert_eq!(child_raw["root"]["root_digest"], root.root_digest());
        assert_eq!(
            child_raw["root"]["selected_audio"],
            serde_json::json!({"kind":"single","stream_index":1})
        );
        checked(parsed.require_frozen_replay(&child, id(4), new_child(0).auth_login_hash));
        // A retry validates the stored input without another clock sample or
        // live parent and cannot issue a longer preparation/root lifetime.
        assert_eq!(child.preparation_deadline_ms(), 145_000);
        assert!(
            parsed
                .require_frozen_replay(&parent, id(4), new_child(0).auth_login_hash)
                .is_err()
        );
        assert!(
            parsed
                .require_frozen_replay(
                    &child,
                    id(4),
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                )
                .is_err()
        );
        let near_end =
            checked(parsed.freeze_new(&parent, &root, new_child(parent.root_deadline_ms() - 1)));
        assert_eq!(
            near_end.preparation_deadline_ms(),
            parent.root_deadline_ms()
        );
        for started in [0, parent.root_deadline_ms(), MAX_SAFE_INTEGER] {
            assert!(
                parsed
                    .freeze_new(&parent, &root, new_child(started))
                    .is_err()
            );
        }
    }

    #[test]
    fn cannot_change_parent_principal_viewer_generation_or_audio_intent() {
        let (parent, root) = parent_and_root();
        let valid = request();
        for (name, value) in [
            ("room_id", serde_json::json!(id(50))),
            ("viewer_id", serde_json::json!(id(80))),
            ("media_generation", Value::from(1)),
            ("plan_generation", Value::from(1)),
            ("audio_index", Value::from(1)),
        ] {
            let mut bad = valid.clone();
            bad[name] = value;
            let parsed = checked(parse_value(&bad));
            assert!(
                parsed
                    .freeze_new(&parent, &root, new_child(100_000))
                    .is_err(),
                "{name}"
            );
        }
        let parsed = checked(parse_value(&valid));
        let mut other_login = new_child(100_000);
        other_login.auth_login_hash =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        assert!(parsed.freeze_new(&parent, &root, other_login).is_err());
        let mut other_user = new_child(100_000);
        other_user.user_id = id(40);
        assert!(parsed.freeze_new(&parent, &root, other_user).is_err());
        let mut reused_owner = new_child(100_000);
        reused_owner.operation_id = id(1);
        assert!(parsed.freeze_new(&parent, &root, reused_owner).is_err());
        let child = checked(parsed.freeze_new(&parent, &root, new_child(100_000)));
        assert!(
            parsed
                .freeze_new(&child, &root, new_child(150_000))
                .is_err()
        );
    }
}
