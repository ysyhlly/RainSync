//! Closed HTTP representation contract for explicitly enabled child delivery.
//!
//! The child recipe produces `index.m3u8`, `init.mp4`, and at most five
//! `sNNN.m4s` files. Those names must never enter the generic `indexN` output
//! reader. This module has no endpoint, registry lookup, path constructor or
//! activation switch. Metadata helpers alone do not authorize a file read.
#![allow(dead_code)]

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, Method, StatusCode, header},
    response::Response,
};
use media_core::static_hls::{
    ReadMethod, ReadRange, ReadResource,
    child_output_owner::OutputIdentity,
    child_output_validation::{ChildOutputReadLease, PublishedChildOutput},
    child_recipe::MAX_OUTPUT_RESOURCE_BYTES,
    contracts::input::{FrozenInput, OperationKind},
};
use std::{io, sync::Arc};
use uuid::Uuid;

const CHUNK_BYTES: usize = 64 * 1024;

type Result<T> = std::result::Result<T, (StatusCode, String)>;

/// Comparison inputs from the caller's authenticated playback boundary. None
/// of these fields constructs, adopts or grants an original output owner.
pub(super) struct ReadDemand<'a> {
    pub(super) input: &'a FrozenInput,
    pub(super) expected_output: &'a OutputIdentity,
    pub(super) authenticated_user: Uuid,
}

/// An exhaustive resource set, rather than a caller-controlled relative path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Resource {
    Manifest,
    Init,
    Segment0,
    Segment1,
    Segment2,
    Segment3,
    Segment4,
}

impl Resource {
    fn parse(name: &str) -> Result<Self> {
        match name {
            "index.m3u8" => Ok(Self::Manifest),
            "init.mp4" => Ok(Self::Init),
            "s000.m4s" => Ok(Self::Segment0),
            "s001.m4s" => Ok(Self::Segment1),
            "s002.m4s" => Ok(Self::Segment2),
            "s003.m4s" => Ok(Self::Segment3),
            "s004.m4s" => Ok(Self::Segment4),
            _ => Err((
                StatusCode::BAD_REQUEST,
                "invalid_static_hls_child_resource".into(),
            )),
        }
    }

    fn content_type(self) -> &'static str {
        match self {
            Self::Manifest => "application/vnd.apple.mpegurl",
            Self::Init => "video/mp4",
            Self::Segment0 | Self::Segment1 | Self::Segment2 | Self::Segment3 | Self::Segment4 => {
                "video/iso.segment"
            }
        }
    }

    fn read_resource(self) -> ReadResource {
        match self {
            Self::Manifest => ReadResource::Manifest,
            Self::Init => ReadResource::Init,
            Self::Segment0 => ReadResource::Segment(0),
            Self::Segment1 => ReadResource::Segment(1),
            Self::Segment2 => ReadResource::Segment(2),
            Self::Segment3 => ReadResource::Segment(3),
            Self::Segment4 => ReadResource::Segment(4),
        }
    }
}

/// Read only from the caller's retained original published handle. The demand
/// is comparison data from an already-authenticated playback boundary, never
/// authority and never enough to look up or construct an output owner here.
///
/// The complete frozen-input comparison includes its user, session, exact login
/// and membership/source epochs, parent association and root digest. The opaque
/// original publication permit independently repeats their CURRENT ordered DB
/// predicate, lease and positive original capture disposal before headers and
/// each body chunk. No SQL projection is converted into a filesystem path.
pub(super) async fn response(
    published: Arc<PublishedChildOutput>,
    demand: ReadDemand<'_>,
    resource_name: &str,
    method: &Method,
    headers: &HeaderMap,
) -> Result<Response> {
    let resource = Resource::parse(resource_name)?;
    let request = match Request::parse(method, headers) {
        Err((StatusCode::METHOD_NOT_ALLOWED, message)) => {
            return Response::builder()
                .status(StatusCode::METHOD_NOT_ALLOWED)
                .header(header::ALLOW, "GET, HEAD")
                .header(header::CACHE_CONTROL, "private, no-store")
                .body(Body::from(message))
                .map_err(|_| unavailable());
        }
        result => result?,
    };
    let input = demand.input;
    let identity = input.identity_statement();
    if input.kind() != OperationKind::Child
        || identity.user_id != demand.authenticated_user.to_string()
        || published.identity() != demand.expected_output
        || published.source_identity().capture_id != identity.operation_id
        || published.require_same_frozen_input(input).is_err()
    {
        return Err((StatusCode::UNAUTHORIZED, "invalid_playback_session".into()));
    }
    // Ask the original owner to fully verify and copy only this <=4MiB sealed
    // resource first. Range and If-Range can then refer to its actual strong
    // byte identity; neither a route suffix nor a DB byte count can select it.
    let mut lease = published
        .read(
            resource.read_resource(),
            if request.head {
                ReadMethod::Head
            } else {
                ReadMethod::Get
            },
            None,
        )
        .await
        .map_err(read_error)?;
    let total = lease.total_bytes();
    let etag = lease.strong_etag().to_owned();
    if lease.is_partial() || lease.first_byte() != 0 || lease.content_length() != total {
        return Err(unavailable());
    }
    let selection = select(&request, &etag, total)?;
    if let Selection::Partial { first, last } = selection {
        lease
            .select_range(ReadRange::Inclusive { first, last })
            .map_err(read_error)?;
        if !lease.is_partial()
            || lease.first_byte() != first
            || lease.content_length() != last - first + 1
        {
            return Err(unavailable());
        }
    }
    // This is the final await before constructing response headers, including
    // HEAD and 416. Metadata alone never bypasses the exact current read gate.
    lease.check().await.map_err(read_error)?;
    let body = if request.head || selection == Selection::Unsatisfiable {
        drop(lease);
        Body::empty()
    } else {
        owned_body(published, lease)
    };
    build_response(resource, total, &etag, selection, body)
}

fn owned_body(published: Arc<PublishedChildOutput>, lease: ChildOutputReadLease) -> Body {
    let remaining = lease.content_length();
    // Both opaque values are in the body state. An outer HTTP waiter cannot
    // release the actual reader, original output or scoped work before the
    // body ends/drops; the core's independent owner also retains cancelled work
    // until its real scope has drained. There is no production test adapter.
    Body::from_stream(futures_util::stream::try_unfold(
        (published, lease, remaining),
        |(published, mut lease, remaining)| async move {
            let next = lease.chunk().await.map_err(|_| body_error())?;
            bounded_chunk(next, remaining)
                .map(|next| next.map(|(bytes, remaining)| (bytes, (published, lease, remaining))))
        },
    ))
}

fn bounded_chunk(next: Option<Vec<u8>>, remaining: usize) -> io::Result<Option<(Bytes, usize)>> {
    match next {
        None if remaining == 0 => Ok(None),
        Some(bytes)
            if !bytes.is_empty() && bytes.len() <= CHUNK_BYTES && bytes.len() <= remaining =>
        {
            let remaining = remaining - bytes.len();
            Ok(Some((Bytes::from(bytes), remaining)))
        }
        _ => Err(body_error()),
    }
}

fn body_error() -> io::Error {
    io::Error::other("static_hls_child_read_failed")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Range {
    From(usize),
    Inclusive { first: usize, last: usize },
    Suffix(usize),
}

/// Only the existing static-HLS GET/HEAD and single byte-range behavior.
/// HEAD deliberately ignores Range, including malformed Range, as the parent
/// reader does. Other conditional-request semantics are not implemented.
struct Request {
    head: bool,
    range: Option<Range>,
    if_range: Option<String>,
}

impl Request {
    fn parse(method: &Method, headers: &HeaderMap) -> Result<Self> {
        let head = if method == Method::GET {
            false
        } else if method == Method::HEAD {
            true
        } else {
            return Err((
                StatusCode::METHOD_NOT_ALLOWED,
                "unsupported_static_hls_child_method".into(),
            ));
        };
        for conditional in [
            header::IF_MATCH,
            header::IF_NONE_MATCH,
            header::IF_MODIFIED_SINCE,
            header::IF_UNMODIFIED_SINCE,
        ] {
            if headers.contains_key(conditional) {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "unsupported_static_hls_child_condition".into(),
                ));
            }
        }
        if head {
            return Ok(Self {
                head,
                range: None,
                if_range: None,
            });
        }
        let range = parse_range(headers)?;
        let mut values = headers.get_all(header::IF_RANGE).iter();
        let if_range = match values.next() {
            None => None,
            Some(value) => {
                if values.next().is_some() || value.as_bytes().len() > 128 {
                    return Err(invalid_range());
                }
                Some(value.to_str().map_err(|_| invalid_range())?.to_owned())
            }
        };
        Ok(Self {
            head,
            range,
            if_range,
        })
    }

    fn selected_range(&self, etag: &str) -> Option<Range> {
        self.range
            .filter(|_| self.if_range.as_deref().is_none_or(|value| value == etag))
    }
}

fn invalid_range() -> (StatusCode, String) {
    (
        StatusCode::BAD_REQUEST,
        "invalid_static_hls_child_range".into(),
    )
}

fn parse_range(headers: &HeaderMap) -> Result<Option<Range>> {
    super::static_hls_range::parse(headers)
        .map(|range| {
            range.map(|range| match range {
                ReadRange::From(first) => Range::From(first),
                ReadRange::Inclusive { first, last } => Range::Inclusive { first, last },
                ReadRange::Suffix(length) => Range::Suffix(length),
            })
        })
        .map_err(|()| invalid_range())
}

/// Private response metadata, always derived after real owner validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Selection {
    Full,
    Partial { first: usize, last: usize },
    Unsatisfiable,
}

fn select(request: &Request, etag: &str, total: usize) -> Result<Selection> {
    if total == 0 || total as u64 > MAX_OUTPUT_RESOURCE_BYTES || !strong_etag(etag) {
        return Err(unavailable());
    }
    Ok(match request.selected_range(etag) {
        None => Selection::Full,
        Some(Range::From(first)) if first < total => Selection::Partial {
            first,
            last: total - 1,
        },
        Some(Range::Inclusive { first, last }) if first < total => Selection::Partial {
            first,
            last: last.min(total - 1),
        },
        Some(Range::Suffix(length)) if length > 0 => Selection::Partial {
            first: total.saturating_sub(length),
            last: total - 1,
        },
        Some(_) => Selection::Unsatisfiable,
    })
}

// The sealed owner's SHA-256 representation identity, never a stat validator
// or an upstream URL/validator. This also bounds header construction.
fn strong_etag(value: &str) -> bool {
    value
        .strip_prefix("\"sha256-")
        .and_then(|value| value.strip_suffix('"'))
        .is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn build_response(
    resource: Resource,
    total: usize,
    etag: &str,
    selection: Selection,
    body: Body,
) -> Result<Response> {
    if total == 0 || total as u64 > MAX_OUTPUT_RESOURCE_BYTES || !strong_etag(etag) {
        return Err(unavailable());
    }
    let (status, length) = match selection {
        Selection::Full => (StatusCode::OK, total),
        Selection::Partial { first, last } if first <= last && last < total => {
            (StatusCode::PARTIAL_CONTENT, last - first + 1)
        }
        Selection::Partial { .. } => return Err(unavailable()),
        Selection::Unsatisfiable => (StatusCode::RANGE_NOT_SATISFIABLE, 0),
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::CONTENT_LENGTH, length.to_string());
    match selection {
        Selection::Full => {}
        Selection::Partial { first, last } => {
            response = response.header(
                header::CONTENT_RANGE,
                format!("bytes {first}-{last}/{total}"),
            );
        }
        Selection::Unsatisfiable => {
            return response
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .body(Body::empty())
                .map_err(|_| unavailable());
        }
    }
    response
        .header(header::CONTENT_TYPE, resource.content_type())
        .body(body)
        .map_err(|_| unavailable())
}

fn unavailable() -> (StatusCode, String) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "static_hls_child_delivery_unavailable".into(),
    )
}

fn read_error(error: anyhow::Error) -> (StatusCode, String) {
    match error.to_string().as_str() {
        "static_hls_child_output_read_busy" => (
            StatusCode::TOO_MANY_REQUESTS,
            "static_hls_child_output_read_busy".into(),
        ),
        "static_hls_child_output_resource_missing" => (
            StatusCode::NOT_FOUND,
            "static_hls_child_output_resource_missing".into(),
        ),
        _ => unavailable(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn etag() -> String {
        format!("\"sha256-{}\"", "a".repeat(64))
    }

    fn request(value: Option<&str>, head: bool) -> Request {
        let mut headers = HeaderMap::new();
        if let Some(value) = value {
            headers.insert(header::RANGE, value.parse().unwrap());
        }
        Request::parse(if head { &Method::HEAD } else { &Method::GET }, &headers).unwrap()
    }

    #[test]
    fn resources_are_exactly_the_closed_recipe_names() {
        for (name, expected) in [
            ("index.m3u8", Resource::Manifest),
            ("init.mp4", Resource::Init),
            ("s000.m4s", Resource::Segment0),
            ("s001.m4s", Resource::Segment1),
            ("s002.m4s", Resource::Segment2),
            ("s003.m4s", Resource::Segment3),
            ("s004.m4s", Resource::Segment4),
        ] {
            assert_eq!(Resource::parse(name).unwrap(), expected);
        }
        for name in [
            "",
            "index0.m3u8",
            "index1.m3u8",
            "index.m3u8.tmp",
            "s000.m4s.tmp",
            "s005.m4s",
            "s064.m4s",
            "s999.m4s",
            "s0.m4s",
            "s0000.m4s",
            "S000.m4s",
            "init.MP4",
            "segment.mp4",
            "key",
            "/index.m3u8",
            "./index.m3u8",
            "../init.mp4",
            "child/index.m3u8",
            "init.mp4/",
            "index.m3u8?token=secret",
            "index.m3u8#part",
            "index%2em3u8",
            "%2e%2e/init.mp4",
            "https://private.invalid/index.m3u8",
            "file:///init.mp4",
            "\\init.mp4",
            "init.mp4\0",
            "init.mp4\n",
            "ｓ000.m4s",
            "💥000.m4s",
        ] {
            assert_eq!(
                Resource::parse(name).unwrap_err().0,
                StatusCode::BAD_REQUEST,
                "{name:?}"
            );
        }
        for (resource, expected_index) in [
            (Resource::Segment0, 0),
            (Resource::Segment1, 1),
            (Resource::Segment2, 2),
            (Resource::Segment3, 3),
            (Resource::Segment4, 4),
        ] {
            let ReadResource::Segment(index) = resource.read_resource() else {
                panic!("closed child segment mapped to another resource");
            };
            assert_eq!(index, expected_index);
        }
    }

    #[test]
    fn body_chunks_are_bounded_and_require_exact_eof() {
        // Test only byte-accounting after the concrete lease's authority check;
        // these values are not a synthetic publication permit or owner.
        let (bytes, remaining) = bounded_chunk(Some(vec![7; CHUNK_BYTES]), CHUNK_BYTES + 1)
            .unwrap()
            .unwrap();
        assert_eq!(bytes.len(), CHUNK_BYTES);
        assert_eq!(remaining, 1);
        let (bytes, remaining) = bounded_chunk(Some(vec![8]), remaining).unwrap().unwrap();
        assert_eq!(bytes.as_ref(), [8]);
        assert_eq!(remaining, 0);
        assert!(bounded_chunk(None, remaining).unwrap().is_none());
        for (next, remaining) in [
            (None, 1),
            (Some(vec![]), 1),
            (Some(vec![0; CHUNK_BYTES + 1]), CHUNK_BYTES + 1),
            (Some(vec![0; 2]), 1),
            (Some(vec![0]), 0),
        ] {
            assert_eq!(
                bounded_chunk(next, remaining).unwrap_err().to_string(),
                "static_hls_child_read_failed"
            );
        }
    }

    #[test]
    fn private_authority_failures_are_sanitized() {
        for diagnostic in [
            "https://private.invalid/secret?token=hidden",
            "private_login_hash_or_root_digest",
            "static_hls_child_output_reader_unavailable",
            "static_hls_child_output_changed_after_publication",
        ] {
            assert_eq!(
                read_error(anyhow::anyhow!(diagnostic.to_owned())),
                unavailable()
            );
        }
        assert_eq!(
            read_error(anyhow::anyhow!("static_hls_child_output_resource_missing")).0,
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn only_get_head_and_existing_condition_behavior_are_supported() {
        for method in [
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ] {
            assert_eq!(
                Request::parse(&method, &HeaderMap::new()).err().unwrap().0,
                StatusCode::METHOD_NOT_ALLOWED
            );
        }
        for name in [
            header::IF_MATCH,
            header::IF_NONE_MATCH,
            header::IF_MODIFIED_SINCE,
            header::IF_UNMODIFIED_SINCE,
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(name, "unsupported".parse().unwrap());
            for method in [Method::GET, Method::HEAD] {
                assert_eq!(
                    Request::parse(&method, &headers).err().unwrap().0,
                    StatusCode::BAD_REQUEST
                );
            }
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "malformed".parse().unwrap());
        headers.append(header::RANGE, "bytes=0-3".parse().unwrap());
        headers.insert(header::IF_RANGE, "stale".parse().unwrap());
        assert!(Request::parse(&Method::GET, &headers).is_err());
        let head = Request::parse(&Method::HEAD, &headers).unwrap();
        assert!(head.head);
        assert_eq!(select(&head, &etag(), 20).unwrap(), Selection::Full);
    }

    #[test]
    fn malformed_duplicate_multipart_and_oversized_ranges_fail_closed() {
        for value in [
            "bytes=",
            "bytes=-",
            "bytes=9-3",
            "bytes=0-2,4-8",
            "bytes=+1-2",
            "bytes=--5",
            "bytes=1-18446744073709551616",
            "items=0-2",
            "bytes =0-2",
            "bytes=0 -2",
            "bytes=0- 2",
            "Bytes=0-2",
            "bytes=０-2",
        ] {
            let mut headers = HeaderMap::new();
            // A non-ASCII HeaderValue is rejected by the parser too.
            headers.insert(
                header::RANGE,
                axum::http::HeaderValue::from_bytes(value.as_bytes()).unwrap(),
            );
            assert_eq!(
                Request::parse(&Method::GET, &headers).err().unwrap(),
                invalid_range(),
                "{value}"
            );
        }
        for name in [header::RANGE, header::IF_RANGE] {
            let mut headers = HeaderMap::new();
            headers.insert(name.clone(), "bytes=0-3".parse().unwrap());
            headers.append(name.clone(), "bytes=3-9".parse().unwrap());
            assert_eq!(
                Request::parse(&Method::GET, &headers).err().unwrap(),
                invalid_range()
            );
            headers.remove(name.clone());
            headers.insert(name, "x".repeat(129).parse().unwrap());
            assert_eq!(
                Request::parse(&Method::GET, &headers).err().unwrap(),
                invalid_range()
            );
        }
    }

    #[test]
    fn range_raw_header_limit_is_checked_before_trimming() {
        let value = format!("bytes={}-1", "0".repeat(120));
        assert_eq!(value.len(), 128);
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, value.parse().unwrap());
        assert_eq!(
            Request::parse(&Method::GET, &headers).unwrap().range,
            Some(Range::Inclusive { first: 0, last: 1 })
        );
        headers.insert(header::RANGE, format!("{value} ").parse().unwrap());
        assert_eq!(
            Request::parse(&Method::GET, &headers).err().unwrap(),
            invalid_range()
        );
        assert!(
            Request::parse(&Method::HEAD, &headers)
                .unwrap()
                .range
                .is_none()
        );
    }

    #[test]
    fn single_ranges_are_bounded_and_unsatisfied_ranges_are_distinct() {
        for (value, expected) in [
            ("bytes=0-", Selection::Partial { first: 0, last: 19 }),
            ("bytes=3-9", Selection::Partial { first: 3, last: 9 }),
            (
                "bytes=19-99",
                Selection::Partial {
                    first: 19,
                    last: 19,
                },
            ),
            (
                "bytes=-5",
                Selection::Partial {
                    first: 15,
                    last: 19,
                },
            ),
            ("bytes=-500", Selection::Partial { first: 0, last: 19 }),
            ("bytes=20-", Selection::Unsatisfiable),
            ("bytes=-0", Selection::Unsatisfiable),
        ] {
            assert_eq!(
                select(&request(Some(value), false), &etag(), 20).unwrap(),
                expected,
                "{value}"
            );
            assert_eq!(
                select(&request(Some(value), true), &etag(), 20).unwrap(),
                Selection::Full
            );
        }
        let request = request(None, false);
        assert_eq!(
            select(&request, &etag(), MAX_OUTPUT_RESOURCE_BYTES as usize).unwrap(),
            Selection::Full
        );
        assert!(select(&request, &etag(), MAX_OUTPUT_RESOURCE_BYTES as usize + 1).is_err());
        assert!(select(&request, &etag(), 0).is_err());
    }

    #[test]
    fn if_range_matches_only_the_exact_owned_strong_validator() {
        let current = etag();
        for (value, expected) in [
            (current.as_str(), Selection::Partial { first: 3, last: 9 }),
            ("\"old\"", Selection::Full),
            ("W/\"stat-v1\"", Selection::Full),
            ("Wed, 30 Sep 2026 08:00:00 GMT", Selection::Full),
            ("invalid", Selection::Full),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, "bytes=3-9".parse().unwrap());
            headers.insert(header::IF_RANGE, value.parse().unwrap());
            assert_eq!(
                select(
                    &Request::parse(&Method::GET, &headers).unwrap(),
                    &current,
                    20
                )
                .unwrap(),
                expected
            );
        }
        for value in [
            "",
            "\"stat-v1\"",
            "W/\"sha256-a\"",
            "\"sha256-abc\"",
            "https://private.invalid",
        ] {
            assert!(select(&request(None, false), value, 20).is_err());
        }
    }

    #[tokio::test]
    async fn http_metadata_and_bodies_keep_the_existing_full_range_head_contract() {
        let etag = etag();
        // Synthetic bytes here test HTTP formatting only, not read authority.
        let full = build_response(
            Resource::Manifest,
            3,
            &etag,
            Selection::Full,
            Body::from("abc"),
        )
        .unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(
            full.headers()[header::CONTENT_TYPE],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(full.headers()[header::CONTENT_LENGTH], "3");
        assert_eq!(full.headers()[header::CACHE_CONTROL], "private, no-store");
        assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(full.headers()[header::ETAG], etag.as_str());
        assert!(!full.headers().contains_key(header::CONTENT_RANGE));
        assert_eq!(
            axum::body::to_bytes(full.into_body(), 3).await.unwrap(),
            axum::body::Bytes::from_static(b"abc")
        );
        let ranged = build_response(
            Resource::Segment0,
            20,
            &etag,
            Selection::Partial { first: 3, last: 9 },
            Body::from(vec![7; 7]),
        )
        .unwrap();
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.headers()[header::CONTENT_TYPE], "video/iso.segment");
        assert_eq!(ranged.headers()[header::CONTENT_RANGE], "bytes 3-9/20");
        assert_eq!(ranged.headers()[header::CONTENT_LENGTH], "7");
        assert_eq!(
            axum::body::to_bytes(ranged.into_body(), 7)
                .await
                .unwrap()
                .len(),
            7
        );
        let head =
            build_response(Resource::Init, 20, &etag, Selection::Full, Body::empty()).unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "20");
        assert!(
            axum::body::to_bytes(head.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
        let unsatisfied = build_response(
            Resource::Init,
            20,
            &etag,
            Selection::Unsatisfiable,
            Body::from("must not escape"),
        )
        .unwrap();
        assert_eq!(unsatisfied.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfied.headers()[header::CONTENT_RANGE], "bytes */20");
        assert_eq!(unsatisfied.headers()[header::CONTENT_LENGTH], "0");
        assert!(
            axum::body::to_bytes(unsatisfied.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn invalid_representation_metadata_cannot_construct_a_response() {
        for total in [0, MAX_OUTPUT_RESOURCE_BYTES as usize + 1] {
            assert!(
                build_response(
                    Resource::Init,
                    total,
                    &etag(),
                    Selection::Full,
                    Body::empty()
                )
                .is_err()
            );
        }
        for selection in [
            Selection::Partial { first: 10, last: 9 },
            Selection::Partial { first: 0, last: 20 },
            Selection::Partial {
                first: usize::MAX,
                last: usize::MAX,
            },
        ] {
            assert!(build_response(Resource::Init, 20, &etag(), selection, Body::empty()).is_err());
        }
        assert!(
            build_response(
                Resource::Init,
                20,
                "\"bad\"",
                Selection::Full,
                Body::empty()
            )
            .is_err()
        );
    }
}
