//! Live transport uses a dedicated closed API/CDN policy, not the VOD policy.
//! Every request checks/pins the entire public DNS answer and refuses redirects.
//! Only the two fixed APIs receive the exact viewer's optional ordinary cookie.
use super::*;
use crate::platform::bilibili::live::{self, Request, Response};
const LIVE_TIMEOUT: Duration = Duration::from_secs(20);
impl live::Transport for PlatformHttp {
    fn get_live<'a>(
        &'a self,
        request: Request,
        deadline: Instant,
    ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            request.validate()?;
            let deadline = bounded_deadline(deadline, LIVE_TIMEOUT)?;
            let headers = live_api_headers(&request)?;
            let client = pinned_client(request.url(), &SystemResolver, deadline).await?;
            let response = client
                .request(Method::GET)
                .headers(headers)
                .timeout(remaining(deadline)?)
                .send()
                .await
                .map_err(http_error)?;
            read_bounded(response, live::MAX_API_BYTES, deadline, false).await
        })
    }
}
fn live_media_headers() -> HeaderMap {
    HeaderMap::from_iter([
        (header::USER_AGENT, HeaderValue::from_static(USER_AGENT)),
        (
            header::REFERER,
            HeaderValue::from_static("https://live.bilibili.com/"),
        ),
        (
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        ),
    ])
}
fn live_api_headers(request: &Request) -> Result<HeaderMap> {
    request.validate()?;
    let mut headers = live_media_headers();
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(cookie) = request.cookie() {
        let checked = bilibili::Cookie::from_header(cookie.expose_for_storage())?;
        let mut value = HeaderValue::from_str(checked.expose_for_storage())
            .map_err(|_| bilibili::Error::Restricted("live_cookie_denied"))?;
        value.set_sensitive(true);
        headers.insert(header::COOKIE, value);
    }
    Ok(headers)
}
impl PlatformHttp {
    /// Server-owned signed playlist only. Full bounded body, no credentials,
    /// caller headers, redirects, retry, DVR recording or Worker involvement.
    pub async fn live_playlist(&self, target: &str, deadline: Instant) -> Result<Response> {
        let url = live::validate_playlist_url(target)?;
        let deadline = live_media_deadline(&url, deadline)?;
        let client = pinned_client(&url, &SystemResolver, deadline).await?;
        let response = client
            .request(Method::GET)
            .headers(live_media_headers())
            .timeout(remaining(deadline)?)
            .send()
            .await
            .map_err(http_error)?;
        read_bounded(response, live::MAX_PLAYLIST_BYTES, deadline, true).await
    }
    /// One segment from the previously admitted broadcast/sequence inventory.
    /// Full bytes are bounded and must be clear, structurally framed MPEG-TS.
    pub async fn live_segment(&self, target: &str, deadline: Instant) -> Result<Response> {
        let url = live::validate_segment_url(target)?;
        let deadline = live_media_deadline(&url, deadline)?;
        let client = pinned_client(&url, &SystemResolver, deadline).await?;
        let response = client
            .request(Method::GET)
            .headers(live_media_headers())
            .timeout(remaining(deadline)?)
            .send()
            .await
            .map_err(http_error)?;
        let response = read_bounded(response, live::MAX_SEGMENT_BYTES, deadline, true).await?;
        live::validate_clear_ts(&response.body)?;
        Ok(response)
    }
}
fn live_media_deadline(url: &Url, deadline: Instant) -> Result<Instant> {
    let deadline = bounded_deadline(deadline, LIVE_TIMEOUT)?;
    Ok(
        if let Some(remaining) = live::media_remaining_seconds(url)? {
            deadline.min(Instant::now() + Duration::from_secs(remaining))
        } else {
            deadline
        },
    )
}
async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
    deadline: Instant,
    media: bool,
) -> Result<Response> {
    check_response_headers(response.headers())?;
    validate_media_encoding(response.headers())?;
    if response.status().is_redirection() {
        return Err(bilibili::Error::Restricted("platform_redirect_denied"));
    }
    for name in [header::CONTENT_LENGTH, header::CONTENT_TYPE] {
        if response.headers().get_all(name).iter().count() > 1 {
            return Err(bilibili::Error::InvalidResponse("live_response_framing"));
        }
    }
    if response.headers().contains_key(header::CONTENT_RANGE) {
        return Err(bilibili::Error::InvalidResponse("live_response_framing"));
    }
    let length = response.content_length();
    if length.is_some_and(|n| n > limit as u64) {
        return Err(bilibili::Error::TooLarge);
    }
    let status = response.status().as_u16();
    if media && status != 200 {
        return Err(bilibili::Error::Status(status));
    }
    if status != 200 {
        return Ok(Response {
            status,
            body: Vec::new(),
        });
    }
    let mut body = Vec::new();
    while let Some(chunk) = tokio::time::timeout_at(deadline, response.chunk())
        .await
        .map_err(|_| bilibili::Error::Deadline)?
        .map_err(http_error)?
    {
        append_bounded(&mut body, &chunk, limit)?;
    }
    if body.is_empty() || length.is_some_and(|n| n != body.len() as u64) {
        return Err(bilibili::Error::InvalidResponse("live_response_framing"));
    }
    // All upstream headers, including Set-Cookie, Location and authentication,
    // are deliberately discarded. No upstream validator enters browser output.
    Ok(Response { status, body })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_credentials_are_confined_to_exact_apis() {
        let cookie = bilibili::Cookie::from_header("SESSDATA=synthetic; DedeUserID=42").unwrap();
        let room = live::parse_resource("https://live.bilibili.com/123").unwrap();
        let request = live::metadata_request(&room, Some(&cookie)).unwrap();
        let headers = live_api_headers(&request).unwrap();
        assert_eq!(request.url().host_str(), Some("api.live.bilibili.com"));
        assert!(headers.get(header::COOKIE).unwrap().is_sensitive());
        assert!(!headers.contains_key(header::AUTHORIZATION));
        assert!(!format!("{request:?}").contains("synthetic"));
        let media = live_media_headers();
        assert!(!media.contains_key(header::COOKIE));
        assert!(!media.contains_key(header::AUTHORIZATION));
    }
}
