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
    let range = match media_core::byte_range(
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        size,
    ) {
        Ok(range) => range,
        Err(_) => {
            return Ok(Response::builder()
                .status(416)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
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
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "7");
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
