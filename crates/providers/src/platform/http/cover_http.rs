use super::*;
use crate::platform::bilibili::cover::{CoverResponse, CoverUrl, MAX_COVER_BYTES};

impl bilibili::cover::Transport for PlatformHttp {
    fn get_cover<'a>(
        &'a self,
        target: &'a CoverUrl,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<CoverResponse>> + Send + 'a>> {
        Box::pin(async move {
            let deadline = bounded_deadline(deadline, Duration::from_secs(5))?;
            tokio::time::timeout_at(deadline, async {
                let client = pinned_client(target.url(), &SystemResolver, deadline).await?;
                let mut response = client
                    .request(Method::GET)
                    .headers(media_headers(Provider::Bilibili))
                    .timeout(remaining(deadline)?)
                    .send()
                    .await
                    .map_err(http_error)?;
                check_response_headers(response.headers())?;
                validate_media_encoding(response.headers())?;
                if response.status() != StatusCode::OK {
                    return Err(bilibili::Error::Status(response.status().as_u16()));
                }
                if response
                    .content_length()
                    .is_some_and(|length| length > MAX_COVER_BYTES as u64)
                {
                    return Err(bilibili::Error::TooLarge);
                }
                let values = response
                    .headers()
                    .get_all(header::CONTENT_TYPE)
                    .iter()
                    .collect::<Vec<_>>();
                if values.len() != 1 {
                    return Err(bilibili::Error::InvalidResponse("cover_content_type"));
                }
                let content_type = values[0]
                    .to_str()
                    .map_err(|_| bilibili::Error::InvalidResponse("cover_content_type"))?;
                if !matches!(content_type, "image/jpeg" | "image/png" | "image/webp") {
                    return Err(bilibili::Error::InvalidResponse("cover_content_type"));
                }
                let content_type = content_type.to_owned();
                let mut body = vec![];
                while let Some(chunk) = response.chunk().await.map_err(http_error)? {
                    append_bounded(&mut body, &chunk, MAX_COVER_BYTES)?;
                }
                Ok(CoverResponse { content_type, body })
            })
            .await
            .map_err(|_| bilibili::Error::Deadline)?
        })
    }
}
