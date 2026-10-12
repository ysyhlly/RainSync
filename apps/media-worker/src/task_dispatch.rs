//! Pure routing and decoding for the existing playback job contracts.
//!
//! A route is not an execution permit. Ladder entries still run their original
//! closed validators; single-output validation stays inside the cancellable
//! preparation future, before cache/input effects. The original Claim is never
//! rewritten, and none of these types own a lease, deadline, output or receipt.
use crate::{advanced_media, static_hls_child_gate};
use anyhow::Result;
use persistence::{local_hls_ladder, media_jobs::Claim, native_platform_transcode};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Ladder {
    Local,
    AdvancedLocal,
    AdvancedOwned,
    NativePlatform,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Route {
    Ladder(Ladder),
    SingleOutput,
}

impl Route {
    pub(crate) fn from_spec(spec: &Value) -> Self {
        match spec["kind"].as_str() {
            Some(local_hls_ladder::KIND) => Self::Ladder(Ladder::Local),
            Some(local_hls_ladder::ADVANCED_KIND) => Self::Ladder(Ladder::AdvancedLocal),
            Some(local_hls_ladder::OWNED_ADVANCED_KIND) => Self::Ladder(Ladder::AdvancedOwned),
            Some(persistence::native_platform_ladder::KIND) => Self::Ladder(Ladder::NativePlatform),
            _ => Self::SingleOutput,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SingleKind {
    Legacy,
    OwnedHttp,
    AdvancedLocal,
    AdvancedOwnedLocal,
    AdvancedOwnedRemote,
    RemoteAsset,
}

/// Do not derive Debug: these borrowed fields can contain credentials or URLs.
#[derive(Clone, Copy)]
pub(crate) enum Input<'a> {
    NativeTrack(&'a str),
    Ticket(&'a str),
    Local { root: &'a str, resource: &'a str },
}

struct EncoderFields<'a> {
    input: Input<'a>,
    start_seconds: f64,
    transcode: bool,
    negotiated_mode: Option<&'a str>,
    audio_index: Option<u64>,
}

impl<'a> EncoderFields<'a> {
    /// The unversioned legacy wire contract intentionally keeps its historical
    /// missing/null/default behavior. Closed versioned specs have already passed
    /// their own validator. Do not invent a stricter legacy schema in a move.
    fn from_validated(spec: &'a Value) -> Self {
        Self {
            input: match spec["input_ticket"].as_str() {
                Some(ticket) => Input::Ticket(ticket),
                None => Input::Local {
                    root: spec["root"].as_str().unwrap_or(""),
                    resource: spec["resource"].as_str().unwrap_or(""),
                },
            },
            start_seconds: spec["start_seconds"].as_f64().unwrap_or(0.0),
            transcode: spec["transcode"].as_bool().unwrap_or(true),
            negotiated_mode: spec["negotiated_mode"].as_str(),
            // Preserve the existing u32 conversion at the argument boundary,
            // after source checks and directory setup, including error order.
            audio_index: spec["audio_index"].as_u64(),
        }
    }
}

enum Decoded<'a> {
    Encoder(SingleKind, EncoderFields<'a>),
    NativePlatform(Box<native_platform_transcode::Spec>),
}

pub(crate) struct SingleOutput<'a>(Decoded<'a>);

impl std::fmt::Debug for SingleOutput<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.0 {
            Decoded::Encoder(kind, _) => std::fmt::Debug::fmt(kind, out),
            Decoded::NativePlatform(_) => out.write_str("NativePlatform"),
        }
    }
}

#[derive(Debug)]
struct UnsupportedKind;
impl std::fmt::Display for UnsupportedKind {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("media_job_kind_invalid")
    }
}
impl std::error::Error for UnsupportedKind {}

impl<'a> SingleOutput<'a> {
    pub(crate) fn decode(claim: &'a Claim) -> Result<Self> {
        let spec = &claim.spec;
        // Keep the original validator precedence, including malformed mixed
        // markers. A generic kind error must not mask an existing refusal.
        let kind = if spec["kind"] == native_platform_transcode::KIND {
            return Ok(Self(Decoded::NativePlatform(Box::new(
                native_platform_transcode::validate_spec(spec)?,
            ))));
        } else if spec["kind"] == persistence::owned_http::KIND {
            persistence::owned_http::validate_spec(spec)?;
            SingleKind::OwnedHttp
        } else if advanced_media::admit_claim(spec)? {
            match spec["kind"].as_str() {
                Some("advanced_local_transcode_v1") => SingleKind::AdvancedLocal,
                Some("advanced_owned_local_transcode_v1") => SingleKind::AdvancedOwnedLocal,
                Some("advanced_owned_remote_transcode_v1") => SingleKind::AdvancedOwnedRemote,
                Some(media_core::advanced_media::REMOTE_ASSET_KIND) => SingleKind::RemoteAsset,
                _ => return Err(UnsupportedKind.into()),
            }
        } else {
            static_hls_child_gate::reject_unsupported_claim(claim)?;
            require_legacy_kind(spec)?;
            SingleKind::Legacy
        };
        Ok(Self(Decoded::Encoder(
            kind,
            EncoderFields::from_validated(spec),
        )))
    }

    pub(crate) fn is_native(&self) -> bool {
        matches!(self.0, Decoded::NativePlatform(_))
    }

    pub(crate) fn input(&self) -> Input<'_> {
        match &self.0 {
            Decoded::NativePlatform(spec) => Input::NativeTrack(&spec.tracks[0].key),
            Decoded::Encoder(_, fields) => fields.input,
        }
    }

    pub(crate) fn start_seconds(&self) -> f64 {
        match &self.0 {
            Decoded::NativePlatform(spec) => spec.start_seconds,
            Decoded::Encoder(_, fields) => fields.start_seconds,
        }
    }

    pub(crate) fn transcode(&self) -> bool {
        match &self.0 {
            Decoded::NativePlatform(_) => true,
            Decoded::Encoder(_, fields) => fields.transcode,
        }
    }

    pub(crate) fn negotiated_mode(&self) -> Option<&str> {
        match &self.0 {
            Decoded::NativePlatform(spec) => Some(&spec.negotiated_mode),
            Decoded::Encoder(_, fields) => fields.negotiated_mode,
        }
    }

    pub(crate) fn audio_index(&self) -> Result<Option<u32>> {
        match &self.0 {
            Decoded::NativePlatform(_) => Ok(None),
            Decoded::Encoder(_, fields) => Ok(fields.audio_index.map(u32::try_from).transpose()?),
        }
    }
}

/// Separate hardening boundary, after the existing marker validators. The
/// legacy SQL predicate treats absent and JSON-null kind alike; retain both.
/// Unsupported strings and other JSON types must not select a generic recipe.
fn require_legacy_kind(spec: &Value) -> Result<()> {
    anyhow::ensure!(
        spec.is_object() && spec.get("kind").is_none_or(Value::is_null),
        UnsupportedKind
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    fn claim(spec: Value) -> Claim {
        Claim {
            id: Uuid::new_v4(),
            owner: Uuid::new_v4(),
            attempt: 7,
            spec,
        }
    }

    fn legacy_preparation_gate(claim: &Claim) -> Result<()> {
        let spec = &claim.spec;
        if spec["kind"] == native_platform_transcode::KIND {
            native_platform_transcode::validate_spec(spec)?;
        } else if spec["kind"] == persistence::owned_http::KIND {
            persistence::owned_http::validate_spec(spec)?;
        } else if !advanced_media::admit_claim(spec)? {
            static_hls_child_gate::reject_unsupported_claim(claim)?;
        }
        Ok(())
    }

    #[test]
    fn every_ladder_kind_routes_to_its_existing_executor_family() {
        for (kind, ladder) in [
            (local_hls_ladder::KIND, Ladder::Local),
            (local_hls_ladder::ADVANCED_KIND, Ladder::AdvancedLocal),
            (local_hls_ladder::OWNED_ADVANCED_KIND, Ladder::AdvancedOwned),
            (
                persistence::native_platform_ladder::KIND,
                Ladder::NativePlatform,
            ),
        ] {
            // Route selection does not claim that this incomplete spec is valid.
            let spec = json!({"kind":kind});
            assert_eq!(Route::from_spec(&spec), Route::Ladder(ladder));
            assert!(if ladder == Ladder::NativePlatform {
                persistence::native_platform_ladder::validate_spec(&spec).is_err()
            } else {
                local_hls_ladder::validate_spec(&spec).is_err()
            });
        }
    }

    #[test]
    fn complete_ladder_specs_keep_their_existing_closed_validators() {
        let version = format!("stat-v1:{}", "a".repeat(64));
        let rendition = json!({"id":"low","width":640,"height":360,
            "video_bitrate":800000,"video_maxrate":1000000,"bandwidth":1410000,
            "average_bandwidth":928000,"avc_codec":"avc1.64001F","audio_bitrate":128000});
        let local = json!({"kind":local_hls_ladder::KIND,"recipe_version":1,
            "root":"/media","resource":"movie.mkv","source_kind":"local","input_ticket":"opaque",
            "start_seconds":5.0,"transcode":true,"audio_index":1,"estimated_output_bytes":1000,
            "negotiated_mode":"transcode","source_version":version,"duration_ms":30000.0,
            "source_generation":1,"plan_generation":1,"renditions":[rendition]});
        let mut advanced = local.clone();
        advanced["kind"] = json!(local_hls_ladder::ADVANCED_KIND);
        advanced["advanced_media"] =
            json!({"schema_version":1,"tone_map_hdr":true,"subtitle_stream_index":null});
        let mut owned = advanced.clone();
        owned["kind"] = json!(local_hls_ladder::OWNED_ADVANCED_KIND);
        owned["advanced_assets"] = json!(assets());
        for (spec, route) in [
            (local, Ladder::Local),
            (advanced, Ladder::AdvancedLocal),
            (owned, Ladder::AdvancedOwned),
        ] {
            local_hls_ladder::validate_spec(&spec).unwrap();
            assert_eq!(Route::from_spec(&spec), Route::Ladder(route));
        }
        let native = json!({"kind":persistence::native_platform_ladder::KIND,"recipe_version":1,
            "source_kind":"native_platform_private","negotiated_mode":"transcode",
            "tracks":[{"key":"progressive","ticket":"a".repeat(64),"total_bytes":99,"strong_etag":"\"representation\""}],
            "output_ticket":"b".repeat(64),"duration_seconds":30.0,"start_seconds":5.0,
            "deadline_ms":1000,"estimated_output_bytes":1000,"source_generation":1,"plan_generation":1,
            "renditions":[rendition]});
        persistence::native_platform_ladder::validate_spec(&native).unwrap();
        assert_eq!(
            Route::from_spec(&native),
            Route::Ladder(Ladder::NativePlatform)
        );
    }

    #[test]
    fn legacy_defaults_and_input_selection_remain_compatible() {
        for spec in [
            json!({}),
            json!({"kind":null}),
            json!({"root":"legacy-root","resource":"input.mp4","transcode":false}),
            json!({"input_ticket":"opaque","source_kind":"http","audio_index":null,"estimated_output_bytes":33554432}),
            json!({"root":null,"resource":9,"start_seconds":"old","transcode":null,"audio_index":-1,"negotiated_mode":false,"extra_legacy_field":1}),
        ] {
            let claim = claim(spec);
            let before = (claim.id, claim.owner, claim.attempt, claim.spec.clone());
            let decoded = SingleOutput::decode(&claim).unwrap();
            assert_eq!(format!("{decoded:?}"), "Legacy");
            assert_eq!(
                decoded.start_seconds(),
                claim.spec["start_seconds"].as_f64().unwrap_or(0.0)
            );
            assert_eq!(
                decoded.transcode(),
                claim.spec["transcode"].as_bool().unwrap_or(true)
            );
            assert_eq!(
                decoded.negotiated_mode(),
                claim.spec["negotiated_mode"].as_str()
            );
            assert_eq!(decoded.audio_index().unwrap(), None);
            match decoded.input() {
                Input::Ticket(ticket) => {
                    assert_eq!(Some(ticket), claim.spec["input_ticket"].as_str())
                }
                Input::Local { root, resource } => {
                    assert_eq!(root, claim.spec["root"].as_str().unwrap_or(""));
                    assert_eq!(resource, claim.spec["resource"].as_str().unwrap_or(""));
                }
                Input::NativeTrack(_) => panic!("legacy task cannot use native ingress"),
            }
            assert_eq!(
                (claim.id, claim.owner, claim.attempt, claim.spec.clone()),
                before
            );
        }
    }

    #[test]
    fn audio_index_overflow_stays_at_the_original_argument_boundary() {
        let claim = claim(json!({"audio_index":u64::from(u32::MAX)+1}));
        let decoded = SingleOutput::decode(&claim).unwrap();
        assert!(decoded.audio_index().is_err());
    }

    #[test]
    fn invalid_explicit_kinds_no_longer_fall_through_as_legacy() {
        for kind in [
            json!("future_recipe_v2"),
            json!(""),
            json!(7),
            json!(true),
            json!([]),
            json!({"private":"fixture-secret"}),
        ] {
            let claim = claim(json!({"kind":kind,"input_ticket":"fixture-secret"}));
            assert!(
                legacy_preparation_gate(&claim).is_ok(),
                "documents the old fallthrough"
            );
            let error = SingleOutput::decode(&claim).unwrap_err();
            assert!(error.is::<UnsupportedKind>());
            assert_eq!(error.to_string(), "media_job_kind_invalid");
            assert!(!format!("{error:?}").contains("fixture-secret"));
        }
        for spec in [json!(null), json!(true), json!([]), json!("fixture-secret")] {
            assert!(
                SingleOutput::decode(&claim(spec))
                    .unwrap_err()
                    .is::<UnsupportedKind>()
            );
        }
    }

    #[test]
    fn malformed_mixed_markers_keep_original_failure_precedence() {
        for spec in [
            json!({"kind":native_platform_transcode::KIND,"advanced_media":{},"reader_version":2}),
            json!({"kind":persistence::owned_http::KIND,"advanced_media":{},"reader_version":2}),
            json!({"kind":"advanced_local_transcode_v1","reader_version":2}),
            json!({"kind":"future_recipe_v2","advanced_media":{},"reader_version":2}),
            json!({"kind":"future_recipe_v2","reader_version":2}),
            json!({"kind":"static_hls_child"}),
            json!({"recipe_version":1}),
        ] {
            let claim = claim(spec);
            let previous = legacy_preparation_gate(&claim).unwrap_err();
            let decoded = SingleOutput::decode(&claim).unwrap_err();
            assert_eq!(decoded.to_string(), previous.to_string());
        }
    }

    fn owned_http() -> Value {
        json!({"kind":persistence::owned_http::KIND,"owned_http_response_version":1,"root":"","resource":"https://private.invalid/source?credential=fixture-secret","source_kind":"http","input_ticket":"fixture-secret","start_seconds":0.0,"transcode":true,"audio_index":null,"estimated_output_bytes":null,"negotiated_mode":null,"source_version":null})
    }

    fn advanced() -> Value {
        json!({"kind":"advanced_local_transcode_v1","recipe_version":1,
            "advanced_media":{"schema_version":1,"tone_map_hdr":false,"subtitle_stream_index":0},
            "source_kind":"local","source_version":format!("stat-v1:{}", "a".repeat(64)),
            "negotiated_mode":"transcode","transcode":true,"root":"/media","resource":"movie.mkv",
            "input_ticket":"fixture-secret","start_seconds":5.0,"audio_index":1,"estimated_output_bytes":1000})
    }

    fn assets() -> media_core::advanced_media::AssetCatalog {
        media_core::advanced_media::AssetCatalog {
            schema_version: 1,
            source_resource: "movie.mkv".into(),
            source_version: format!("stat-v1:{}", "a".repeat(64)),
            subtitles: vec![],
            fonts: vec![],
        }
    }

    #[test]
    fn every_advanced_kind_uses_the_original_closed_contract() {
        let local = advanced();
        let mut owned_local = local.clone();
        owned_local["kind"] = json!("advanced_owned_local_transcode_v1");
        owned_local["advanced_assets"] = json!(assets());
        let mut remote = local.clone();
        remote["kind"] = json!("advanced_owned_remote_transcode_v1");
        remote["source_kind"] = json!("agent");
        remote["root"] = json!("");
        remote["held_input_bytes"] = json!(100);
        remote["remote_duration_seconds"] = json!(10.0);
        let mut remote_http = remote.clone();
        remote_http["source_kind"] = json!("http");
        remote_http["source_version"] = Value::Null;
        let mut remote_asset = remote.clone();
        remote_asset["kind"] = json!(media_core::advanced_media::REMOTE_ASSET_KIND);
        remote_asset["advanced_assets"] = json!(assets());
        remote_asset["advanced_remote_assets"] =
            json!(media_core::advanced_media::RemoteAssetCatalog {
                schema_version: 1,
                source_kind: "agent".into(),
                source_resource: "movie.mkv".into(),
                source_version: format!("stat-v1:{}", "a".repeat(64)),
                catalog: assets(),
                source_http: None,
                http_files: vec![],
            });
        for (spec, expected) in [
            (local, "AdvancedLocal"),
            (owned_local, "AdvancedOwnedLocal"),
            (remote, "AdvancedOwnedRemote"),
            (remote_http, "AdvancedOwnedRemote"),
            (remote_asset, "RemoteAsset"),
        ] {
            let original = claim(spec);
            assert!(legacy_preparation_gate(&original).is_ok());
            let decoded = SingleOutput::decode(&original).unwrap();
            assert_eq!(format!("{decoded:?}"), expected);
            assert!(!decoded.is_native());
            assert_eq!(decoded.start_seconds(), 5.0);
            assert_eq!(decoded.audio_index().unwrap(), Some(1));
            assert!(matches!(decoded.input(), Input::Ticket("fixture-secret")));
            for (key, value) in [
                ("recipe_version", json!(2)),
                ("unrecognized", json!("fixture-secret")),
            ] {
                let mut bad = original.spec.clone();
                bad[key] = value;
                let claim = claim(bad);
                assert_eq!(
                    SingleOutput::decode(&claim).unwrap_err().to_string(),
                    legacy_preparation_gate(&claim).unwrap_err().to_string()
                );
            }
        }
    }

    #[test]
    fn native_spec_keeps_its_original_deadline_and_private_track() {
        let spec = native_platform_transcode::Spec {
            source_webm: None,
            source_video: None,
            kind: native_platform_transcode::KIND.into(),
            recipe_version: 1,
            source_kind: "native_platform_private".into(),
            negotiated_mode: "transcode".into(),
            tracks: vec![native_platform_transcode::Track {
                container: Default::default(),
                key: "progressive".into(),
                ticket: "a".repeat(64),
                total_bytes: 99,
                strong_etag: "\"representation\"".into(),
            }],
            output_ticket: "b".repeat(64),
            duration_seconds: 30.0,
            start_seconds: 5.0,
            // Parsing must not replace an old absolute deadline with now+budget.
            deadline_ms: 1000,
            estimated_output_bytes: 999,
        };
        let original = claim(serde_json::to_value(spec).unwrap());
        let decoded = SingleOutput::decode(&original).unwrap();
        assert!(decoded.is_native());
        assert!(matches!(decoded.input(), Input::NativeTrack("progressive")));
        assert_eq!(format!("{decoded:?}"), "NativePlatform");
        assert_eq!(decoded.start_seconds(), 5.0);
        assert_eq!(decoded.audio_index().unwrap(), None);
        let Decoded::NativePlatform(spec) = &decoded.0 else {
            panic!("native type required")
        };
        assert_eq!(spec.deadline_ms, 1000);
        assert_eq!(serde_json::to_value(spec).unwrap(), original.spec);
        let mut malformed = original.spec.clone();
        malformed["tracks"][0]["url"] = json!("fixture-secret");
        let bad = claim(malformed);
        assert_eq!(
            SingleOutput::decode(&bad).unwrap_err().to_string(),
            legacy_preparation_gate(&bad).unwrap_err().to_string()
        );
    }

    #[test]
    fn closed_owned_http_spec_and_redacted_typed_debug_are_preserved() {
        let original = claim(owned_http());
        let decoded = SingleOutput::decode(&original).unwrap();
        assert_eq!(format!("{decoded:?}"), "OwnedHttp");
        for (field, value) in [
            ("url", json!("fixture-secret")),
            ("audio_index", json!(-1)),
            ("transcode", json!(false)),
        ] {
            let mut malformed = original.spec.clone();
            malformed[field] = value;
            let claim = claim(malformed);
            assert_eq!(
                SingleOutput::decode(&claim).unwrap_err().to_string(),
                "owned_http_job_invalid"
            );
        }
    }
}
