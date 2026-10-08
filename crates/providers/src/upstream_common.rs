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
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("upstream_metadata_request_failed"))?;
        ensure!(
            response.status() == reqwest::StatusCode::OK,
            "upstream_metadata_status"
        );
        let (value, _) = read_unique_json(
            response,
            2 * 1024 * 1024,
            JsonErrors {
                too_large: "upstream_metadata_too_large",
                body_failed: "upstream_metadata_body_failed",
                invalid_json: "upstream_metadata_invalid_json",
            },
        )
        .await?;
        Ok(value)
    })
    .await
    .map_err(|_| anyhow::anyhow!("upstream_metadata_timeout"))?
}

#[derive(Clone, Copy)]
struct JsonErrors {
    too_large: &'static str,
    body_failed: &'static str,
    invalid_json: &'static str,
}

// Check both advertised and actual bytes before JSON allocation. Chunked and
// incorrectly advertised responses receive exactly the same byte budget.
async fn read_unique_json(
    mut response: reqwest::Response,
    max_bytes: usize,
    errors: JsonErrors,
) -> Result<(Value, usize)> {
    ensure!(
        response
            .content_length()
            .is_none_or(|n| n <= max_bytes as u64),
        "{}",
        errors.too_large
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!(errors.body_failed))?
    {
        ensure!(
            chunk.len() <= max_bytes.saturating_sub(bytes.len()),
            "{}",
            errors.too_large
        );
        bytes.extend_from_slice(&chunk);
    }
    let mut parser = serde_json::Deserializer::from_slice(&bytes);
    let value = <UniqueValue as serde::Deserialize>::deserialize(&mut parser)
        .map_err(|_| anyhow::anyhow!(errors.invalid_json))?;
    parser
        .end()
        .map_err(|_| anyhow::anyhow!(errors.invalid_json))?;
    Ok((value.0, bytes.len()))
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
    // Audio discovery is an identity proof too. Share the bounded reader with
    // profile preflight so duplicate item/source/track fields cannot become a
    // valid binding through JSON's ordinary last-wins map semantics.
    let metadata = item_metadata(config, item, &headers).await?;
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

// These caps bound the all-or-nothing catalog held in memory. A capped scan
// returns an error, never a partial catalog that could tombstone unseen items.
const LIBRARY_SCAN_LIMITS: ScanLimits = ScanLimits {
    page_bytes: 2 * 1024 * 1024,
    total_bytes: 32 * 1024 * 1024,
    items: 20_000,
    timeout: std::time::Duration::from_secs(120),
};
const LIBRARY_JSON_ERRORS: JsonErrors = JsonErrors {
    too_large: "library_response_too_large",
    body_failed: "library_response_failed",
    invalid_json: "invalid_library_json",
};
#[derive(Clone, Copy)]
struct ScanLimits {
    page_bytes: usize,
    total_bytes: usize,
    items: usize,
    timeout: std::time::Duration,
}

pub async fn list(config: &SourceConfig, headers: BTreeMap<String, String>) -> Result<Vec<Item>> {
    list_with_limits(config, headers, LIBRARY_SCAN_LIMITS).await
}
pub(super) async fn list_guarded<G, F, Fut>(
    config: &SourceConfig,
    headers: BTreeMap<String, String>,
    guard: F,
) -> Result<Vec<Item>>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<G>>,
{
    tokio::time::timeout(
        LIBRARY_SCAN_LIMITS.timeout,
        scan_library(config, headers, LIBRARY_SCAN_LIMITS, guard),
    )
    .await
    .map_err(|_| anyhow::anyhow!("library_scan_timeout"))?
}

async fn list_with_limits(
    config: &SourceConfig,
    headers: BTreeMap<String, String>,
    limits: ScanLimits,
) -> Result<Vec<Item>> {
    tokio::time::timeout(
        limits.timeout,
        scan_library(config, headers, limits, || std::future::ready(Ok(()))),
    )
    .await
    .map_err(|_| anyhow::anyhow!("library_scan_timeout"))?
}

async fn scan_library<G, F, Fut>(
    config: &SourceConfig,
    headers: BTreeMap<String, String>,
    limits: ScanLimits,
    mut guard: F,
) -> Result<Vec<Item>>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<G>>,
{
    ensure!(
        !config.user_id.is_empty() && !config.token.is_empty(),
        "upstream_credentials_required"
    );
    let url = endpoint(config, &["Users", &config.user_id, "Items"])?;
    let mut items = Vec::new();
    let mut identities = HashSet::new();
    let mut expected_total = None;
    let mut scanned_bytes = 0;
    loop {
        let _guard = guard().await?;
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
                ("Fields", "SeriesName,SeasonName"),
                ("Limit", "200"),
                ("StartIndex", start.as_str()),
            ]);
        let remaining = limits.total_bytes - scanned_bytes;
        ensure!(remaining > 0, "library_scan_byte_limit");
        let response = request.send().await?.error_for_status()?;
        let (page, bytes) = read_unique_json(
            response,
            limits.page_bytes.min(remaining),
            LIBRARY_JSON_ERRORS,
        )
        .await?;
        scanned_bytes += bytes;
        let total = page["TotalRecordCount"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("invalid_library_total"))?;
        ensure!(total <= limits.items as u64, "library_scan_item_limit");
        ensure!(
            expected_total.is_none_or(|expected| expected == total),
            "library_changed_during_scan"
        );
        expected_total = Some(total);
        let rows = page["Items"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid_library_response"))?;
        ensure!(rows.len() <= 200, "invalid_library_page_size");
        ensure!(
            rows.len() <= limits.items.saturating_sub(items.len()),
            "library_scan_item_limit"
        );
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
                // Deliberate allowlist: upstream Path, server URLs and credentials
                // never become browser folder names or opaque browse tokens.
                metadata: serde_json::json!({"ImageTags":row["ImageTags"],"BackdropImageTags":row["BackdropImageTags"],
                    "Type":row["Type"],"SeriesId":row["SeriesId"],"SeriesName":row["SeriesName"],
                    "SeasonId":row["SeasonId"],"SeasonName":row["SeasonName"],
                    "ParentIndexNumber":row["ParentIndexNumber"],"IndexNumber":row["IndexNumber"]}),
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

#[cfg(test)]
mod library_limit_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture(
        pages: Vec<String>,
        chunked: bool,
        delay: std::time::Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for body in pages {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0 && request.len() + n <= 8192);
                    request.extend_from_slice(&chunk[..n]);
                }
                tokio::time::sleep(delay).await;
                let reply = if chunked {
                    format!(
                        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
                        body.len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                // Cancellation and pre-body Content-Length rejection may close
                // the owned fixture before its bounded response is written.
                let _ = socket.write_all(reply.as_bytes()).await;
            }
        });
        (origin, server)
    }

    fn config(origin: &str) -> SourceConfig {
        serde_json::from_value(serde_json::json!({
            "url": origin, "user_id":"viewer", "token":"owned-fixture-token",
            "access_policy":{"schema_version":1,"origins":[{"origin":origin,"cidrs":["127.0.0.1/32"]}]}
        })).unwrap()
    }

    #[tokio::test]
    async fn catalog_json_bounds_apply_to_known_length_and_chunked_responses() {
        for chunked in [false, true] {
            for (body, cap, expected) in [
                (r#"{"Items":[],"TotalRecordCount":0}"#, 128, None),
                (
                    r#"{"Items":[],"TotalRecordCount":0}"#,
                    16,
                    Some("library_response_too_large"),
                ),
                (
                    r#"{"Items":[],"TotalRecordCount":0,"TotalRecordCount":0}"#,
                    128,
                    Some("invalid_library_json"),
                ),
                (
                    r#"{"Items":[{"Id":"one","Id":"one"}],"TotalRecordCount":1}"#,
                    128,
                    Some("invalid_library_json"),
                ),
            ] {
                let (origin, server) =
                    fixture(vec![body.into()], chunked, std::time::Duration::ZERO).await;
                let response = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .unwrap()
                    .get(origin)
                    .send()
                    .await
                    .unwrap();
                let result = read_unique_json(response, cap, LIBRARY_JSON_ERRORS).await;
                match expected {
                    Some(error) => assert_eq!(result.unwrap_err().to_string(), error),
                    None => assert_eq!(result.unwrap().1, body.len()),
                }
                server.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn catalog_limits_never_return_a_partial_success() {
        let first = r#"{"Items":[{"Id":"one","Name":"One"}],"TotalRecordCount":2}"#.to_owned();
        let second = r#"{"Items":[{"Id":"two","Name":"Two"}],"TotalRecordCount":2}"#.to_owned();
        let ordinary = ScanLimits {
            page_bytes: 1024,
            total_bytes: 2048,
            items: 2,
            timeout: std::time::Duration::from_secs(2),
        };
        for (pages, limits, expected) in [
            (vec![first.clone(), second.clone()], ordinary, None),
            (
                vec![first.clone()],
                ScanLimits {
                    items: 1,
                    ..ordinary
                },
                Some("library_scan_item_limit"),
            ),
            (
                vec![first.clone(), second.clone()],
                ScanLimits {
                    total_bytes: first.len() + second.len() - 1,
                    ..ordinary
                },
                Some("library_response_too_large"),
            ),
            (
                vec![first.clone(), first.clone()],
                ordinary,
                Some("duplicate_library_item"),
            ),
            (
                vec![first.clone(), r#"{"Items":[],"TotalRecordCount":2}"#.into()],
                ordinary,
                Some("incomplete_library_response"),
            ),
            (
                vec![first.clone(), r#"{"Items":[],"TotalRecordCount":1}"#.into()],
                ordinary,
                Some("library_changed_during_scan"),
            ),
        ] {
            let (origin, server) = fixture(pages, false, std::time::Duration::ZERO).await;
            let result = list_with_limits(&config(&origin), BTreeMap::new(), limits).await;
            match expected {
                Some(error) => assert_eq!(result.unwrap_err().to_string(), error),
                None => assert_eq!(
                    result
                        .unwrap()
                        .iter()
                        .map(|item| item.resource.as_str())
                        .collect::<Vec<_>>(),
                    ["one", "two"]
                ),
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn whole_catalog_deadline_includes_waiting_for_a_page() {
        let (origin, server) = fixture(
            vec![r#"{"Items":[],"TotalRecordCount":0}"#.into()],
            false,
            std::time::Duration::from_millis(100),
        )
        .await;
        let result = list_with_limits(
            &config(&origin),
            BTreeMap::new(),
            ScanLimits {
                timeout: std::time::Duration::from_millis(30),
                ..LIBRARY_SCAN_LIMITS
            },
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "library_scan_timeout");
        server.await.unwrap();
    }
}
