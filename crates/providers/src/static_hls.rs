//! Registered-source Stage A transport. All original and redirect hops use the
//! existing credential-origin, DNS/address-pinning and source-policy gateway.
use crate::{SourceConfig, source_media_request};
use media_core::static_hls::{CaptureBody, CaptureFuture, CaptureTransport, ResponseFacts};
use reqwest::{Method, Response, header};
use std::collections::BTreeMap;

pub struct RegisteredSource {
    config: SourceConfig,
    headers: BTreeMap<String, String>,
}
impl RegisteredSource {
    /// Headers must already belong to this registered source, as in current
    /// controlled-media reads. They are never emitted in Debug or diagnostics.
    pub fn new(config: SourceConfig, headers: BTreeMap<String, String>) -> Self {
        Self { config, headers }
    }
}
impl CaptureTransport for RegisteredSource {
    fn conditional_get<'a>(
        &'a self,
        target: &'a str,
        identity: &'a media_core::static_hls::ResourceIdentity,
    ) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
        Box::pin(async move {
            let response = source_media_request(&self.config, target, Method::GET, &self.headers)
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_source_access_denied"))?
                .header(header::ACCEPT_ENCODING, "identity")
                .conditional_identity(&identity.final_target_sha256, &identity.strong_etag)
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_source_read_failed"))?;
            Ok(Box::new(RegisteredBody {
                response,
                pending: None,
            }) as Box<dyn CaptureBody>)
        })
    }
    fn get<'a>(&'a self, target: &'a str) -> CaptureFuture<'a, Box<dyn CaptureBody>> {
        Box::pin(async move {
            let response = source_media_request(&self.config, target, Method::GET, &self.headers)
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_source_access_denied"))?
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("static_hls_source_read_failed"))?;
            Ok(Box::new(RegisteredBody {
                response,
                pending: None,
            }) as Box<dyn CaptureBody>)
        })
    }
}
struct RegisteredBody {
    response: Response,
    pending: Option<Box<dyn ChunkBuffer>>,
}
trait ChunkBuffer: Send {
    fn take(&mut self) -> Option<Vec<u8>>;
}
struct PendingChunk<T> {
    bytes: T,
    cursor: usize,
}
impl<T: AsRef<[u8]> + Send> ChunkBuffer for PendingChunk<T> {
    fn take(&mut self) -> Option<Vec<u8>> {
        let bytes = self.bytes.as_ref();
        if self.cursor == bytes.len() {
            return None;
        }
        let end = (self.cursor + 65536).min(bytes.len());
        let result = bytes[self.cursor..end].to_vec();
        self.cursor = end;
        Some(result)
    }
}
impl CaptureBody for RegisteredBody {
    fn facts(&self) -> ResponseFacts {
        let headers = self.response.headers();
        let mut etags = headers.get_all(header::ETAG).iter();
        let strong_etag = etags
            .next()
            .and_then(|v| v.to_str().ok())
            .filter(|v| {
                v.len() >= 2
                    && v.len() <= 8192
                    && v.starts_with('"')
                    && v.ends_with('"')
                    && v.as_bytes()[1..v.len() - 1]
                        .iter()
                        .all(|b| *b >= 0x21 && *b != b'"' && *b != 0x7f)
            })
            .map(str::to_owned)
            .filter(|_| etags.next().is_none());
        let identity_encoding = headers
            .get_all(header::CONTENT_ENCODING)
            .iter()
            .all(|v| v.as_bytes().eq_ignore_ascii_case(b"identity"));
        ResponseFacts {
            status: self.response.status().as_u16(),
            final_url: self.response.url().as_str().to_owned(),
            strong_etag,
            content_length: self.response.content_length(),
            identity_encoding,
        }
    }
    fn chunk(&mut self) -> CaptureFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            if let Some(pending) = &mut self.pending
                && let Some(chunk) = pending.take()
            {
                return Ok(Some(chunk));
            }
            self.pending = None;
            loop {
                let bytes = self
                    .response
                    .chunk()
                    .await
                    .map_err(|_| anyhow::anyhow!("static_hls_source_body_failed"))?;
                let Some(bytes) = bytes else {
                    return Ok(None);
                };
                // A transport frame is not an application read size. Preserve
                // its immutable Bytes without copying a whole frame/resource,
                // and deliver <=64KiB hash/write chunks. The backing frame is
                // bounded by the existing32MiB single-resource ceiling; never
                // Response::bytes() or the full128MiB closure in Server RAM.
                anyhow::ensure!(
                    bytes.len() <= media_core::static_hls::RESOURCE_BYTES,
                    "static_hls_source_frame_bound"
                );
                let mut pending = PendingChunk { bytes, cursor: 0 };
                if let Some(chunk) = pending.take() {
                    self.pending = Some(Box::new(pending));
                    return Ok(Some(chunk));
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coalesced_transport_frames_are_bounded_application_chunks() {
        let bytes: Vec<u8> = (0..200000usize).map(|v| (v % 251) as u8).collect();
        let mut frame = PendingChunk {
            bytes: bytes.clone(),
            cursor: 0,
        };
        let mut received = Vec::new();
        while let Some(chunk) = frame.take() {
            assert!(chunk.len() <= 65536);
            received.extend(chunk);
        }
        assert_eq!(received, bytes);
    }
}
