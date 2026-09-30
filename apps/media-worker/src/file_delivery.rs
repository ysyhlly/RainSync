//! File reads have explicit blocking owners, so a dropped HTTP body cannot
//! acknowledge disposal while a hidden filesystem task still holds the file.
use crate::{Result, cache_read, failure};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use futures_util::Stream;
use media_core::{child_process, file_version};
use std::{
    fs::File,
    io::{self, Read, Seek},
    path::Path,
    sync::Arc,
};

fn changed() -> io::Error {
    io::Error::other("source_changed")
}
fn verify(file: &File, version: Option<&str>) -> io::Result<()> {
    if let Some(version) = version
        && (!file_version::valid_file_version(version)
            || file_version::snapshot_file(file)?.version != version)
    {
        return Err(changed());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Range {
    Full,
    Partial(u64, u64),
    Unsatisfiable,
}

/// Range applies only to GET. Malformed/unsupported ranges are ignored; a
/// syntactically valid range that selects no bytes receives 416 (RFC 9110).
fn select_range(headers: &HeaderMap, head: bool, size: u64) -> Range {
    // stat-v1 detects local changes but is not a strong representation validator.
    // Until the caller supplies a trustworthy ETag/date, If-Range cannot match.
    if head || headers.contains_key(header::IF_RANGE) {
        return Range::Full;
    }
    let mut values = headers.get_all(header::RANGE).iter();
    let Some(value) = values.next().and_then(|v| v.to_str().ok()) else {
        return Range::Full;
    };
    if values.next().is_some() {
        return Range::Full;
    }
    let Some(raw) = value.strip_prefix("bytes=") else {
        return Range::Full;
    };
    let Some((start, end)) = raw.split_once('-') else {
        return Range::Full;
    };
    let number = |value: &str| {
        (!value.is_empty() && value.bytes().all(|v| v.is_ascii_digit()))
            .then(|| value.parse::<u64>().ok())
            .flatten()
    };
    if start.is_empty() {
        let Some(suffix) = number(end) else {
            return Range::Full;
        };
        if suffix == 0 || size == 0 {
            Range::Unsatisfiable
        } else {
            Range::Partial(size.saturating_sub(suffix), size - 1)
        }
    } else {
        let Some(start) = number(start) else {
            return Range::Full;
        };
        let end = if end.is_empty() {
            None
        } else if let Some(end) = number(end) {
            Some(end)
        } else {
            return Range::Full;
        };
        // Reversed bounds are invalid syntax, rather than an unsatisfied range.
        if end.is_some_and(|end| end < start) {
            return Range::Full;
        }
        if start >= size {
            Range::Unsatisfiable
        } else {
            Range::Partial(start, end.unwrap_or(size - 1).min(size - 1))
        }
    }
}
fn stream(
    file: Arc<File>,
    remaining: u64,
    version: Option<String>,
) -> impl Stream<Item = io::Result<Bytes>> + Send {
    futures_util::stream::try_unfold(
        (file, remaining, version),
        |(file, remaining, version)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            let input = file.clone();
            let expected = version.clone();
            let bytes = child_process::blocking(move || -> io::Result<Bytes> {
                verify(&input, expected.as_deref())?;
                let mut bytes = vec![0; remaining.min(65536) as usize];
                let read = (&*input).read(&mut bytes)?;
                if read == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "source_truncated",
                    ));
                }
                verify(&input, expected.as_deref())?;
                bytes.truncate(read);
                Ok(Bytes::from(bytes))
            })
            .await??;
            let remaining = remaining - bytes.len() as u64;
            Ok(Some((bytes, (file, remaining, version))))
        },
    )
}

pub async fn response(
    path: &Path,
    headers: &HeaderMap,
    head: bool,
    reader: Option<cache_read::ReadGuard>,
    checked_file: Option<File>,
    version: Option<String>,
) -> Result<Response> {
    let path_owned = path.to_path_buf();
    let file = match checked_file {
        Some(file) => file,
        None => child_process::blocking(move || File::open(path_owned))
            .await
            .map_err(failure)?
            .map_err(failure)?,
    };
    let file = Arc::new(file);
    let input = file.clone();
    let expected = version.clone();
    let size = child_process::blocking(move || -> io::Result<u64> {
        verify(&input, expected.as_deref())?;
        Ok(input.metadata()?.len())
    })
    .await
    .map_err(failure)?
    .map_err(|error| {
        if error.to_string() == "source_changed" {
            (StatusCode::CONFLICT, "source_changed".into())
        } else {
            failure(error)
        }
    })?;
    let range = match select_range(headers, head, size) {
        Range::Full => None,
        Range::Partial(start, end) => Some((start, end)),
        Range::Unsatisfiable => {
            return Ok(Response::builder()
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::CONTENT_LENGTH, 0)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CACHE_CONTROL, "private, no-store")
                .body(Body::empty())
                .unwrap());
        }
    };
    let (start, length) = range.map(|(a, b)| (a, b - a + 1)).unwrap_or((0, size));
    let input = file.clone();
    child_process::blocking(move || (&*input).seek(io::SeekFrom::Start(start)))
        .await
        .map_err(failure)?
        .map_err(failure)?;
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "m3u8" => "application/vnd.apple.mpegurl",
        "m4s" => "video/iso.segment",
        "vtt" => "text/vtt",
        "webm" => "video/webm",
        _ => "video/mp4",
    };
    let mut response = Response::builder()
        .status(if range.is_some() { 206 } else { 200 })
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, no-store");
    if let Some((a, b)) = range {
        response = response.header(header::CONTENT_RANGE, format!("bytes {a}-{b}/{size}"));
    }
    response
        .body(if head {
            Body::empty()
        } else {
            let source = stream(file, length, version);
            match reader {
                Some(reader) => reader.body(source),
                None => Body::from_stream(source),
            }
        })
        .map_err(failure)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    #[test]
    fn single_ranges_distinguish_ignored_headers_from_unsatisfied_ranges() {
        for (value, expected) in [
            ("bytes=0-", Range::Partial(0, 19)),
            ("bytes=3-9", Range::Partial(3, 9)),
            ("bytes=19-99", Range::Partial(19, 19)),
            ("bytes=-5", Range::Partial(15, 19)),
            ("bytes=-500", Range::Partial(0, 19)),
            ("bytes=20-", Range::Unsatisfiable),
            ("bytes=-0", Range::Unsatisfiable),
            ("bytes=9-3", Range::Full),
            ("bytes=0-2,4-8", Range::Full),
            ("bytes=+1-2", Range::Full),
            ("bytes=--5", Range::Full),
            ("bytes=1-18446744073709551616", Range::Full),
            ("bytes=-", Range::Full),
            ("items=0-2", Range::Full),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::RANGE, value.parse().unwrap());
            assert_eq!(select_range(&headers, false, 20), expected, "{value}");
            assert_eq!(select_range(&headers, true, 20), Range::Full);
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=0-".parse().unwrap());
        assert_eq!(select_range(&headers, false, 0), Range::Unsatisfiable);
        headers.append(header::RANGE, "bytes=1-2".parse().unwrap());
        assert_eq!(select_range(&headers, false, 20), Range::Full);
    }

    #[test]
    fn if_range_never_treats_a_stat_identity_as_a_strong_validator() {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=3-9".parse().unwrap());
        for value in [
            "\"old\"",
            "W/\"stat-v1\"",
            "Wed, 30 Sep 2026 08:00:00 GMT",
            "invalid",
        ] {
            headers.insert(header::IF_RANGE, value.parse().unwrap());
            assert_eq!(select_range(&headers, false, 20), Range::Full);
        }
    }

    #[tokio::test]
    async fn unsatisfied_and_empty_file_responses_have_consistent_metadata() {
        let root = std::env::temp_dir().join(format!("rainsync-ranges-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("movie.mp4");
        std::fs::write(&path, [1, 2, 3]).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=3-".parse().unwrap());
        let result = response(&path, &headers, false, None, None, None)
            .await
            .unwrap();
        assert_eq!(result.status(), 416);
        assert_eq!(result.headers()[header::CONTENT_RANGE], "bytes */3");
        assert_eq!(result.headers()[header::CONTENT_LENGTH], "0");
        assert!(
            axum::body::to_bytes(result.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
        std::fs::write(&path, []).unwrap();
        let result = response(&path, &HeaderMap::new(), false, None, None, None)
            .await
            .unwrap();
        assert_eq!(result.status(), 200);
        assert_eq!(result.headers()[header::CONTENT_LENGTH], "0");
        assert!(
            axum::body::to_bytes(result.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
        headers.insert(header::RANGE, "bytes=0-".parse().unwrap());
        let result = response(&path, &headers, false, None, None, None)
            .await
            .unwrap();
        assert_eq!(result.status(), 416);
        assert_eq!(result.headers()[header::CONTENT_RANGE], "bytes */0");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn versioned_handle_supports_range_head_and_rejects_in_place_changes() {
        let root = std::env::temp_dir().join(format!("rainsync-delivery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("movie.mp4");
        std::fs::write(&path, vec![7; 131072]).unwrap();
        let version = file_version::snapshot_file(&File::open(&path).unwrap())
            .unwrap()
            .version;
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=3-9".parse().unwrap());
        let ranged = response(&path, &headers, false, None, None, Some(version.clone()))
            .await
            .unwrap();
        assert_eq!(ranged.status(), 206);
        assert_eq!(
            axum::body::to_bytes(ranged.into_body(), 20).await.unwrap(),
            Bytes::from(vec![7; 7])
        );
        let head = response(&path, &headers, true, None, None, Some(version.clone()))
            .await
            .unwrap();
        assert_eq!(head.status(), 200);
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "131072");
        assert!(
            axum::body::to_bytes(head.into_body(), 0)
                .await
                .unwrap()
                .is_empty()
        );
        let body = response(
            &path,
            &HeaderMap::new(),
            false,
            None,
            None,
            Some(version.clone()),
        )
        .await
        .unwrap()
        .into_body();
        let mut bytes = body.into_data_stream();
        assert_eq!(bytes.next().await.unwrap().unwrap().len(), 65536);
        std::fs::write(&path, vec![9; 131072]).unwrap();
        assert!(bytes.next().await.unwrap().is_err());
        assert_eq!(
            response(&path, &HeaderMap::new(), false, None, None, Some(version))
                .await
                .unwrap_err()
                .0,
            StatusCode::CONFLICT
        );
        drop(bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
}
