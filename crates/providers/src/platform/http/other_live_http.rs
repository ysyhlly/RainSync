//! Fixed other-live endpoints and public-DNS-pinned clear-media transport.
use super::*;
use crate::platform::other_live::{self, Request, Response};
impl other_live::Transport for PlatformHttp {
    fn get_other_live<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            request.validate()?;
            let deadline = bounded_deadline(deadline, API_TIMEOUT)?;
            let mut headers = other_headers(request.provider());
            headers.insert(
                header::ACCEPT,
                HeaderValue::from_static(
                    if request.endpoint() == other_live::Endpoint::TikTokPage {
                        "text/html"
                    } else {
                        "application/json"
                    },
                ),
            );
            if let Some(credential) = request.credential() {
                let checked = short_video::Credential::parse(
                    credential.platform(),
                    credential.cookie_header(),
                )
                .map_err(|_| bilibili::Error::Restricted("other_live_credential_scope"))?;
                let mut value = HeaderValue::from_str(checked.cookie_header())
                    .map_err(|_| bilibili::Error::Restricted("other_live_credential_scope"))?;
                value.set_sensitive(true);
                headers.insert(header::COOKIE, value);
            }
            let client = pinned_client(request.url(), &SystemResolver, deadline).await?;
            let response = client
                .request(Method::GET)
                .headers(headers)
                .timeout(remaining(deadline)?)
                .send()
                .await
                .map_err(http_error)?;
            other_read(response, other_live::MAX_API_BYTES, deadline).await
        })
    }
}
fn other_headers(p: other_live::Provider) -> HeaderMap {
    HeaderMap::from_iter([
        (header::USER_AGENT, HeaderValue::from_static(USER_AGENT)),
        (header::REFERER, HeaderValue::from_static(p.referer())),
        (
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        ),
    ])
}
impl PlatformHttp {
    pub async fn other_live_playlist(
        &self,
        provider: other_live::Provider,
        target: &str,
        deadline: Instant,
    ) -> Result<Response> {
        other_live::validate_playlist_url(provider, target)?;
        self.other_live_media(provider, target, other_live::MAX_PLAYLIST_BYTES, deadline)
            .await
    }
    pub async fn other_live_segment(
        &self,
        provider: other_live::Provider,
        target: &str,
        deadline: Instant,
    ) -> Result<Response> {
        other_live::validate_segment_url(provider, target)?;
        let r = self
            .other_live_media(provider, target, other_live::MAX_SEGMENT_BYTES, deadline)
            .await?;
        bilibili::live::validate_clear_ts(&r.body)?;
        Ok(r)
    }
    async fn other_live_media(
        &self,
        provider: other_live::Provider,
        target: &str,
        limit: usize,
        deadline: Instant,
    ) -> Result<Response> {
        let url = other_live::validate_media_url(provider, target)?;
        let mut deadline = bounded_deadline(deadline, API_TIMEOUT)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| bilibili::Error::Transport)?
            .as_secs();
        if let Some(expires) = other_live::expiry(&url, now)? {
            deadline = deadline.min(Instant::now() + Duration::from_secs(expires - now));
        }
        let client = pinned_client(&url, &SystemResolver, deadline).await?;
        let r = client
            .request(Method::GET)
            .headers(other_headers(provider))
            .timeout(remaining(deadline)?)
            .send()
            .await
            .map_err(http_error)?;
        if r.status() != StatusCode::OK {
            return Err(bilibili::Error::Status(r.status().as_u16()));
        }
        other_read(r, limit, deadline).await
    }
}
async fn other_read(mut r: reqwest::Response, limit: usize, deadline: Instant) -> Result<Response> {
    check_response_headers(r.headers())?;
    validate_media_encoding(r.headers())?;
    if r.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    if r.headers().contains_key(header::CONTENT_RANGE)
        || [header::CONTENT_LENGTH, header::CONTENT_TYPE]
            .iter()
            .any(|h| r.headers().get_all(h).iter().count() > 1)
    {
        return Err(bilibili::Error::InvalidResponse("other_live_framing"));
    }
    let status = r.status().as_u16();
    if status != 200 {
        return Ok(Response {
            status,
            body: vec![],
        });
    }
    let length = r.content_length();
    if length.is_some_and(|n| n > limit as u64) {
        return Err(bilibili::Error::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = tokio::time::timeout_at(deadline, r.chunk())
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(http_error)?
    {
        append_bounded(&mut body, &chunk, limit)?;
    }
    if length.is_some_and(|n| n != body.len() as u64) || Instant::now() >= deadline {
        return Err(bilibili::Error::InvalidResponse("other_live_framing"));
    }
    Ok(Response { status, body })
}
