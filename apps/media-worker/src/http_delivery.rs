//! Validate upstream range metadata without synthesizing partial responses.
use anyhow::{Result, ensure};
use axum::http::{HeaderMap, StatusCode, header};

pub const SNIFF_BYTES: usize = 1024;
/// HLS must be handled even when upstream metadata or extensions are misleading.
/// XML (including DASH/SMIL/ASX), concat/PLS and SDP are not supported proxy
/// manifests. Reject their text signatures before handing them to a decoder.
pub fn hls_prefix(prefix: &[u8]) -> Result<bool> {
    ensure!(
        !prefix.starts_with(&[0xff, 0xfe])
            && !prefix.starts_with(&[0xfe, 0xff])
            && !prefix.starts_with(&[0, 0, 0xfe, 0xff]),
        "unsupported_preview_manifest"
    );
    let prefix = prefix.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(prefix);
    let offset = prefix
        .iter()
        .position(|v| !v.is_ascii_whitespace())
        .unwrap_or(prefix.len());
    ensure!(offset < prefix.len(), "unsupported_preview_manifest");
    let prefix = &prefix[offset..];
    ensure!(
        !prefix.starts_with(b"<")
            && !prefix.starts_with(b"ffconcat version ")
            && !prefix.starts_with(b"[playlist]")
            && !prefix.starts_with(b"v=0"),
        "unsupported_preview_manifest"
    );
    Ok(prefix.starts_with(b"#EXTM3U"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum ContentRange {
    Partial {
        start: u64,
        end: u64,
        total: Option<u64>,
    },
    Unsatisfied {
        total: u64,
    },
}
impl ContentRange {
    pub fn parse(value: &str) -> Result<Self> {
        let invalid = || anyhow::anyhow!("invalid_upstream_content_range");
        let raw = value.strip_prefix("bytes ").ok_or_else(invalid)?;
        let (bounds, total) = raw.split_once('/').ok_or_else(invalid)?;
        let number = |text: &str| -> Result<u64> {
            ensure!(
                !text.is_empty() && text.bytes().all(|v| v.is_ascii_digit()),
                "invalid_upstream_content_range"
            );
            text.parse().map_err(|_| invalid())
        };
        if bounds == "*" {
            return Ok(Self::Unsatisfied {
                total: number(total)?,
            });
        }
        let (start, end) = bounds.split_once('-').ok_or_else(invalid)?;
        let (start, end) = (number(start)?, number(end)?);
        let total = if total == "*" {
            None
        } else {
            Some(number(total)?)
        };
        ensure!(
            start <= end && total.is_none_or(|total| end < total),
            "invalid_upstream_content_range"
        );
        ensure!(
            end.checked_sub(start)
                .and_then(|v| v.checked_add(1))
                .is_some(),
            "invalid_upstream_content_range"
        );
        Ok(Self::Partial { start, end, total })
    }
    pub fn total(&self) -> Option<u64> {
        match self {
            Self::Partial { total, .. } => *total,
            Self::Unsatisfied { total } => Some(*total),
        }
    }
}

pub fn validate_range_response(
    status: StatusCode,
    headers: &HeaderMap,
) -> Result<Option<ContentRange>> {
    if !matches!(
        status,
        StatusCode::PARTIAL_CONTENT | StatusCode::RANGE_NOT_SATISFIABLE
    ) {
        return Ok(None);
    }
    let mut values = headers.get_all(header::CONTENT_RANGE).iter();
    let value = values
        .next()
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| anyhow::anyhow!("invalid_upstream_content_range"))?;
    ensure!(values.next().is_none(), "invalid_upstream_content_range");
    let parsed = ContentRange::parse(value)?;
    match (&parsed, status) {
        (ContentRange::Partial { start, end, .. }, StatusCode::PARTIAL_CONTENT) => {
            if let Some(length) = headers.get(header::CONTENT_LENGTH) {
                let length = length.to_str()?.parse::<u64>()?;
                ensure!(length == end - start + 1, "invalid_upstream_range_length");
            }
        }
        (ContentRange::Unsatisfied { .. }, StatusCode::RANGE_NOT_SATISFIABLE) => {}
        _ => anyhow::bail!("invalid_upstream_content_range"),
    }
    Ok(Some(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_hls_and_rejects_unsupported_text_manifests_with_generic_metadata() {
        assert!(hls_prefix(b"#EXTM3U\n").unwrap());
        assert!(hls_prefix(b" \r\n#EXTM3U\n").unwrap());
        for prefix in [
            b"\r\n<?xml version=\"1.0\"?><MPD".as_slice(),
            b"<MPD>",
            b"<!-- comment --><MPD>",
            b"<asx>",
            b"ffconcat version 1.0",
            b"[playlist]\n",
            b"v=0\r\n",
            &[0xff, 0xfe, b'<', 0],
        ] {
            assert!(hls_prefix(prefix).is_err());
        }
        assert!(!hls_prefix(b"\0\0\0\x18ftypisom").unwrap());
        assert!(!hls_prefix(b"\x89PNG\r\n\x1a\n").unwrap());
        assert!(hls_prefix(&vec![b' '; SNIFF_BYTES]).is_err());
        assert!(hls_prefix(b"").is_err());
        assert!(
            hls_prefix(b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><MPD><!--\xe9--></MPD>")
                .is_err()
        );
    }

    #[test]
    fn rejects_invalid_metadata_instead_of_claiming_partial_success() {
        for value in ["bytes 0-2/3", "bytes 2-2/*"] {
            assert!(ContentRange::parse(value).is_ok());
        }
        for value in [
            "bytes 3-2/4",
            "bytes 0-3/3",
            "bytes -1-2/3",
            "bytes 0-2/0",
            "items 0-2/3",
            "bytes 0-18446744073709551615/*",
            "bytes */*",
            "bytes 0-2/+3",
            "bytes 0-2/18446744073709551616",
        ] {
            assert!(ContentRange::parse(value).is_err(), "{value}");
        }
        let mut headers = HeaderMap::new();
        assert!(validate_range_response(StatusCode::PARTIAL_CONTENT, &headers).is_err());
        headers.insert(header::CONTENT_RANGE, "bytes 0-2/10".parse().unwrap());
        headers.insert(header::CONTENT_LENGTH, "3".parse().unwrap());
        assert_eq!(
            validate_range_response(StatusCode::PARTIAL_CONTENT, &headers)
                .unwrap()
                .unwrap()
                .total(),
            Some(10)
        );
        headers.insert(header::CONTENT_LENGTH, "10".parse().unwrap());
        assert!(validate_range_response(StatusCode::PARTIAL_CONTENT, &headers).is_err());
        assert!(validate_range_response(StatusCode::RANGE_NOT_SATISFIABLE, &headers).is_err());
        headers.insert(header::CONTENT_RANGE, "bytes */10".parse().unwrap());
        assert!(validate_range_response(StatusCode::RANGE_NOT_SATISFIABLE, &headers).is_ok());
        assert!(validate_range_response(StatusCode::PARTIAL_CONTENT, &headers).is_err());
        assert!(
            validate_range_response(StatusCode::OK, &headers)
                .unwrap()
                .is_none()
        );
    }
}
