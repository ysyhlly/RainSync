//! Private adapter helpers. The public dispatch remains owned by the integrator.
use super::{Item, PlaybackOptions, SourceConfig, playback_request, validate_url};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub fn playback_body(config: &SourceConfig, options: &PlaybackOptions) -> Result<Value> {
    ensure!(
        !config.user_id.is_empty() && !config.token.is_empty(),
        "upstream_credentials_required"
    );
    // Do not let Rust's saturating float-to-integer cast turn invalid positions
    // into a different valid request. Leave room for rounding at the i64 limit.
    let ticks = options.position_ms * 10_000.0;
    ensure!(
        ticks.is_finite() && ticks >= 0.0 && ticks < i64::MAX as f64,
        "invalid_upstream_position"
    );
    ensure!(
        options
            .audio_index
            .is_none_or(|index| index <= i32::MAX as u32),
        "invalid_upstream_audio_index"
    );
    ensure!(
        options.progressive || options.hls,
        "upstream_transport_required"
    );
    ensure!(
        options.audio_index.is_none()
            || options
                .media_source_id
                .as_deref()
                .is_some_and(valid_source_id),
        "upstream_audio_source_required"
    );
    Ok(playback_request(config, options))
}

pub(super) fn valid_source_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

/// Read-only item discovery. It neither calls PlaybackInfo nor opens a stream.
/// Transport/parser errors are reduced to bounded names before crossing the
/// adapter boundary, since reqwest errors can otherwise contain signed URLs.
pub(super) async fn item_metadata(
    config: &SourceConfig,
    item: &str,
    headers: &BTreeMap<String, String>,
) -> Result<Value> {
    ensure!(
        valid_source_id(item) && valid_source_id(&config.user_id) && !config.token.is_empty(),
        "upstream_metadata_identity_invalid"
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let url = endpoint(config, &["Users", &config.user_id, "Items", item])
            .map_err(|_| anyhow::anyhow!("upstream_metadata_endpoint_invalid"))?;
        let request = super::source_request(config, url.as_str(), reqwest::Method::GET, headers)
            .await
            .map_err(|error| {
                if let Some(error) = error.downcast_ref::<super::access_policy::AccessError>() {
                    anyhow::anyhow!(*error)
                } else {
                    anyhow::anyhow!("upstream_metadata_request_failed")
                }
            })?;
        let mut response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("upstream_metadata_request_failed"))?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "upstream_metadata_status"
        );
        const MAX_BYTES: usize = 2 * 1024 * 1024;
        ensure!(
            response
                .content_length()
                .is_none_or(|n| n <= MAX_BYTES as u64),
            "upstream_metadata_too_large"
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("upstream_metadata_body_failed"))?
        {
            ensure!(
                chunk.len() <= MAX_BYTES.saturating_sub(bytes.len()),
                "upstream_metadata_too_large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let mut parser = serde_json::Deserializer::from_slice(&bytes);
        let value = <UniqueValue as serde::Deserialize>::deserialize(&mut parser)
            .map_err(|_| anyhow::anyhow!("upstream_metadata_invalid_json"))?;
        parser
            .end()
            .map_err(|_| anyhow::anyhow!("upstream_metadata_invalid_json"))?;
        Ok(value.0)
    })
    .await
    .map_err(|_| anyhow::anyhow!("upstream_metadata_timeout"))?
}

/// A duplicate identity/constraint is ambiguous even when both values agree.
/// Value's ordinary map parser uses last-wins semantics, which is unsuitable
/// for metadata used as a proof. Apply the same rule at every nested object.
struct UniqueValue(Value);

impl<'de> serde::Deserialize<'de> for UniqueValue {
    fn deserialize<D: serde::Deserializer<'de>>(parser: D) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> serde::de::Visitor<'de> for UniqueVisitor {
            type Value = UniqueValue;
            fn expecting(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                output.write_str("JSON with unique object fields")
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                value: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Bool(value)))
            }
            fn visit_i64<E: serde::de::Error>(
                self,
                value: i64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_u64<E: serde::de::Error>(
                self,
                value: u64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_f64<E: serde::de::Error>(
                self,
                value: f64,
            ) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|value| UniqueValue(Value::Number(value)))
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                value: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(value.into()))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueValue>()? {
                    values.push(value.0);
                }
                Ok(UniqueValue(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut object: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = object.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate JSON field"));
                    }
                    let value = object.next_value::<UniqueValue>()?;
                    values.insert(key, value.0);
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        parser.deserialize_any(UniqueVisitor)
    }
}

pub async fn audio_source(
    config: &SourceConfig,
    item: &str,
    audio_index: u32,
    headers: BTreeMap<String, String>,
) -> Result<String> {
    ensure!(
        valid_source_id(item) && valid_source_id(&config.user_id) && !config.token.is_empty(),
        "missing_id"
    );
    ensure!(
        audio_index <= i32::MAX as u32,
        "invalid_upstream_audio_index"
    );
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let url = endpoint(config, &["Users", &config.user_id, "Items", item])?;
        let mut response =
            super::source_request(config, url.as_str(), reqwest::Method::GET, &headers)
                .await?
                .send()
                .await?
                .error_for_status()?;
        ensure!(response.status().is_success(), "upstream_metadata_status");
        const MAX_BYTES: usize = 2 * 1024 * 1024;
        ensure!(
            response
                .content_length()
                .is_none_or(|n| n <= MAX_BYTES as u64),
            "upstream_metadata_too_large"
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= MAX_BYTES,
                "upstream_metadata_too_large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let metadata: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            metadata["Id"].as_str() == Some(item),
            "upstream_item_mismatch"
        );
        let sources = metadata["MediaSources"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("no_media_source"))?;
        // PlaybackInfo can reorder alternate versions. Until source identity is
        // explicit in the public track-selection contract, never guess a version.
        ensure!(sources.len() == 1, "ambiguous_media_source");
        let source = &sources[0];
        let id = source["Id"]
            .as_str()
            .filter(|id| valid_source_id(id))
            .ok_or_else(|| anyhow::anyhow!("no_media_source"))?;
        let tracks = source["MediaStreams"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid_audio_track"))?;
        ensure!(
            tracks
                .iter()
                .filter(|track| track["Type"] == "Audio"
                    && track["Index"].as_u64() == Some(u64::from(audio_index)))
                .count()
                == 1,
            "invalid_audio_track"
        );
        Ok(id.to_owned())
    })
    .await
    .map_err(|_| anyhow::anyhow!("upstream_metadata_timeout"))?
}

fn endpoint(config: &SourceConfig, parts: &[&str]) -> Result<reqwest::Url> {
    let mut url = validate_url(&config.url)?;
    // Source URLs describe a base endpoint, not a signed media resource.
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("invalid_upstream_base"))?
        .pop_if_empty()
        .extend(parts.iter().copied());
    Ok(url)
}

pub(super) fn profile_item_route(config: &SourceConfig, item: &str) -> Result<reqwest::Url> {
    endpoint(config, &["Videos", item, "master.m3u8"])
        .map_err(|_| anyhow::anyhow!("upstream_profile_route_invalid"))
}

pub async fn plan(
    config: &SourceConfig,
    item: &str,
    body: Value,
    headers: BTreeMap<String, String>,
) -> Result<Value> {
    ensure!(!item.is_empty(), "missing_id");
    let url = endpoint(config, &["Items", item, "PlaybackInfo"])?;
    let request = super::source_request(config, url.as_str(), reqwest::Method::POST, &headers)
        .await?
        .timeout(std::time::Duration::from_secs(30))
        .json(&body);
    // Preserve the complete response, including SID on a rejected route. The
    // reservation owner must checkpoint it before applying plan validation.
    Ok(request.send().await?.error_for_status()?.json().await?)
}

pub async fn list(config: &SourceConfig, headers: BTreeMap<String, String>) -> Result<Vec<Item>> {
    ensure!(
        !config.user_id.is_empty() && !config.token.is_empty(),
        "upstream_credentials_required"
    );
    let url = endpoint(config, &["Users", &config.user_id, "Items"])?;
    let mut items = Vec::new();
    let mut identities = HashSet::new();
    let mut expected_total = None;
    loop {
        let start = items.len().to_string();
        let request = super::source_request(config, url.as_str(), reqwest::Method::GET, &headers)
            .await?
            .timeout(std::time::Duration::from_secs(30))
            .query(&[
                ("Recursive", "true"),
                ("IncludeItemTypes", "Movie,Episode,Video,MusicVideo"),
                ("SortBy", "SortName"),
                ("SortOrder", "Ascending"),
                ("EnableTotalRecordCount", "true"),
                ("Limit", "200"),
                ("StartIndex", start.as_str()),
            ]);
        let page: Value = request.send().await?.error_for_status()?.json().await?;
        let total = page["TotalRecordCount"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("invalid_library_total"))?;
        ensure!(
            expected_total.is_none_or(|expected| expected == total),
            "library_changed_during_scan"
        );
        expected_total = Some(total);
        let rows = page["Items"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid_library_response"))?;
        ensure!(rows.len() <= 200, "invalid_library_page_size");
        for row in rows {
            let id = row["Id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| anyhow::anyhow!("missing_id"))?;
            // A stable total does not prove completeness when page boundaries
            // drift. Returning duplicated identities could tombstone omitted
            // records during a successful scan; fail the entire scan instead.
            ensure!(identities.insert(id.to_owned()), "duplicate_library_item");
            let duration_ms = match row.get("RunTimeTicks") {
                None | Some(Value::Null) => None,
                Some(ticks) => {
                    let ticks = ticks
                        .as_f64()
                        .filter(|ticks| ticks.is_finite() && *ticks >= 0.0)
                        .ok_or_else(|| anyhow::anyhow!("invalid_library_duration"))?;
                    Some(ticks / 10_000.0)
                }
            };
            items.push(Item {
                title: row["Name"].as_str().unwrap_or("Untitled").into(),
                resource: id.into(),
                duration_ms,
                metadata: serde_json::json!({"ImageTags":row["ImageTags"],"BackdropImageTags":row["BackdropImageTags"]}),
            });
        }
        ensure!(items.len() as u64 <= total, "invalid_library_total");
        if items.len() as u64 == total {
            return Ok(items);
        }
        ensure!(!rows.is_empty(), "incomplete_library_response");
    }
}

#[cfg(test)]
mod metadata_json_tests {
    use super::UniqueValue;

    #[test]
    fn comparable_metadata_does_not_use_last_wins_json_fields() {
        for text in [
            r#"{"Id":"item","Id":"other"}"#,
            r#"{"Id":"item","Id":"item"}"#,
            r#"{"MediaSources":[{"Id":"source","Id":"source"}]}"#,
            r#"{"MediaStreams":[{"Index":1,"Index":2}]}"#,
            r#"{"Id":"item","\u0049d":"other"}"#,
        ] {
            assert!(serde_json::from_str::<UniqueValue>(text).is_err());
        }
        let value: UniqueValue = serde_json::from_str(
            r#"{"Id":"item","MediaSources":[{"Id":"source","RunTimeTicks":900000000}],"Rate":29.97003,"Optional":null,"Flag":false}"#,
        ).unwrap();
        assert_eq!(value.0["Id"], "item");
        assert_eq!(value.0["Rate"], 29.97003);
    }
}
